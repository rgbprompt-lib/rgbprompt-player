// Offline flash detector (FLASH-SAFETY.md §2-§4.2).
//
// Input frames are ANSI104_KEYS order, 104 keys x 3 sRGB bytes. Every frame is
// converted to fixed-point linear luminance once; the 9 objects (board plus
// eight blocks) and each key are then checked with the shared transition logic.
import {
  DARK_THRESHOLD_FIXED,
  FLASH_AMPLITUDE_FIXED,
  LUMINANCE_MAX,
  MAX_FLASHES_PER_WINDOW,
  OBJECT_COUNT,
  RED_AMPLITUDE_FIXED,
  SMALL_FLASH_KEY_FRACTION,
  WINDOW_MS,
} from './constants.ts';
import { KEY_AREAS, KEY_BLOCKS, KEY_COUNT, KEY_NAMES, OBJECT_AREAS, OBJECT_IDS } from './geometry.ts';
import { SRGB_TO_LINEAR, isSaturatedRedLinear, luminanceFromLinear } from './luminance.ts';
import type {
  DetectFlashesOptions,
  FlashReport,
  FlashTrace,
  FlashTraceFlash,
  FlashTraceManySmallKey,
  FlashTraceObject,
  FlashTraceSeries,
  FlashTraceTransition,
  FlashTracedReport,
  FlashViolation,
  ObjectId,
} from './types.ts';
import {
  advanceTransition,
  flashesFromTransitions,
  makeTransitionState,
  maxInWindow,
} from './transitions.ts';

function frameTimeMs(index: number, fps: number): number {
  return Math.floor((index * 1000) / fps);
}

function traceFlashes(
  transitions: readonly FlashTraceTransition[],
  darkThresholdFixed: number | null,
): FlashTraceFlash[] {
  const flashes: FlashTraceFlash[] = [];
  const pairCount = Math.floor(transitions.length / 2);
  for (let pair = 0; pair < pairCount; pair++) {
    const first = transitions[pair * 2] as FlashTraceTransition;
    const second = transitions[pair * 2 + 1] as FlashTraceTransition;
    const darker = Math.min(first.from, first.to, second.from, second.to);
    if (darkThresholdFixed !== null && darker >= darkThresholdFixed) continue;
    first.counted = true;
    second.counted = true;
    flashes.push({
      timeMs: second.timeMs,
      first,
      second,
      darker,
      darkerRelative: darker / LUMINANCE_MAX,
    });
  }
  return flashes;
}

function analyzeSeries(
  series: Uint16Array,
  fps: number,
  amplitudeFixed: number,
  darkThresholdFixed: number | null,
  trace: boolean,
): { flashes: number[]; trace: FlashTraceSeries | null } {
  const state = makeTransitionState();
  const times: number[] = [];
  const fromValues: number[] = [];
  const toValues: number[] = [];
  const transitions: FlashTraceTransition[] | null = trace ? [] : null;

  for (let index = 0; index < series.length; index++) {
    const value = series[index] as number;
    if (!advanceTransition(state, value, frameTimeMs(index, fps), amplitudeFixed)) continue;
    times.push(state.eventTimeMs);
    fromValues.push(state.eventFrom);
    toValues.push(state.eventTo);
    if (transitions) {
      transitions.push({
        frameIndex: index,
        timeMs: state.eventTimeMs,
        from: state.eventFrom,
        to: state.eventTo,
        delta: state.eventTo - state.eventFrom,
        relativeChange: Math.abs(state.eventTo - state.eventFrom) / LUMINANCE_MAX,
        direction: state.eventDirection > 0 ? 'up' : 'down',
        counted: false,
      });
    }
  }

  if (!transitions) {
    return {
      flashes: flashesFromTransitions(times, fromValues, toValues, darkThresholdFixed),
      trace: null,
    };
  }

  const flashes = traceFlashes(transitions, darkThresholdFixed);
  return {
    flashes: flashes.map((flash) => flash.timeMs),
    trace: { transitions, flashes, maxWindow: maxInWindow(flashes.map((flash) => flash.timeMs)) },
  };
}

function lowerBound(sorted: readonly number[], target: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((sorted[middle] as number) < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function countInRange(sorted: readonly number[], startMs: number, endMs: number): number {
  return lowerBound(sorted, endMs) - lowerBound(sorted, startMs);
}

export function detectFlashes(
  frames: readonly Uint8Array[],
  fps: number,
  options: { trace: true },
): FlashTracedReport;
export function detectFlashes(
  frames: readonly Uint8Array[],
  fps: number,
  options?: { trace?: false },
): FlashReport;
export function detectFlashes(
  frames: readonly Uint8Array[],
  fps: number,
  options: DetectFlashesOptions = {},
): FlashReport | FlashTracedReport {
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error(`invalid fps: ${String(fps)}`);
  }
  const wantTrace = options.trace === true;
  const emptySeries = (): FlashTraceSeries => ({
    transitions: [],
    flashes: [],
    maxWindow: { count: 0, startMs: 0 },
  });
  if (frames.length === 0) {
    const report: FlashReport = { ok: true, violations: [], maxPerWindow: { general: 0, red: 0 } };
    if (!wantTrace) return report;
    const trace: FlashTrace = {
      fps,
      frameCount: 0,
      durationMs: 0,
      report,
      objects: OBJECT_IDS.map((object) => ({
        object: object as ObjectId,
        general: emptySeries(),
        red: emptySeries(),
      })),
      manySmall: {
        requiredKeys: 0,
        maxKeys: 0,
        windowStartMs: 0,
        violated: false,
        keys: [],
      },
    };
    return { ...report, trace };
  }

  const frameCount = frames.length;
  const keySeries: Uint16Array[] = [];
  for (let key = 0; key < KEY_COUNT; key++) keySeries.push(new Uint16Array(frameCount));
  const objectGeneral: Uint16Array[] = [];
  const objectRed: Uint16Array[] = [];
  for (let object = 0; object < OBJECT_COUNT; object++) {
    objectGeneral.push(new Uint16Array(frameCount));
    objectRed.push(new Uint16Array(frameCount));
  }

  const objectLuminanceSum = new Float64Array(OBJECT_COUNT);
  const objectRedArea = new Float64Array(OBJECT_COUNT);
  const expectedBytes = KEY_COUNT * 3;

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
    const frame = frames[frameIndex] as Uint8Array;
    if (frame.length !== expectedBytes) {
      throw new Error(`frame ${frameIndex} has ${frame.length} bytes; expected ${expectedBytes}`);
    }

    objectLuminanceSum.fill(0);
    objectRedArea.fill(0);

    for (let key = 0; key < KEY_COUNT; key++) {
      const offset = key * 3;
      const r = SRGB_TO_LINEAR[frame[offset] as number] as number;
      const g = SRGB_TO_LINEAR[frame[offset + 1] as number] as number;
      const b = SRGB_TO_LINEAR[frame[offset + 2] as number] as number;
      const y = luminanceFromLinear(r, g, b);
      (keySeries[key] as Uint16Array)[frameIndex] = y;

      const area = KEY_AREAS[key] as number;
      const block = 1 + (KEY_BLOCKS[key] as number);
      const red = isSaturatedRedLinear(r, g, b);
      const redArea = red ? area : 0;

      objectLuminanceSum[0] = (objectLuminanceSum[0] as number) + y * area;
      objectLuminanceSum[block] = (objectLuminanceSum[block] as number) + y * area;
      objectRedArea[0] = (objectRedArea[0] as number) + redArea;
      objectRedArea[block] = (objectRedArea[block] as number) + redArea;
    }

    for (let object = 0; object < OBJECT_COUNT; object++) {
      const totalArea = OBJECT_AREAS[object] as number;
      const luminance = Math.floor((objectLuminanceSum[object] as number) / totalArea);
      const redShare = Math.floor(((objectRedArea[object] as number) * LUMINANCE_MAX) / totalArea);
      (objectGeneral[object] as Uint16Array)[frameIndex] = luminance;
      (objectRed[object] as Uint16Array)[frameIndex] = redShare;
    }
  }

  const violations: FlashViolation[] = [];
  const keyAnalyses: Array<{ flashes: number[]; trace: FlashTraceSeries | null }> = [];
  let maxGeneral = 0;
  let maxRed = 0;

  for (let key = 0; key < KEY_COUNT; key++) {
    keyAnalyses.push(
      analyzeSeries(
        keySeries[key] as Uint16Array,
        fps,
        FLASH_AMPLITUDE_FIXED,
        DARK_THRESHOLD_FIXED,
        wantTrace,
      ),
    );
  }
  const keyFlashes = keyAnalyses.map((analysis) => analysis.flashes);

  const traceObjects: FlashTraceObject[] = [];

  for (let object = 0; object < OBJECT_COUNT; object++) {
    const objectId = OBJECT_IDS[object] as ObjectId;
    const general = analyzeSeries(
      objectGeneral[object] as Uint16Array,
      fps,
      FLASH_AMPLITUDE_FIXED,
      DARK_THRESHOLD_FIXED,
      wantTrace,
    );
    const generalMax = maxInWindow(general.flashes);
    if (generalMax.count > maxGeneral) maxGeneral = generalMax.count;
    if (generalMax.count > MAX_FLASHES_PER_WINDOW) {
      violations.push({
        object: objectId,
        kind: 'general',
        windowStartMs: generalMax.startMs,
        count: generalMax.count,
      });
    }

    const red = analyzeSeries(objectRed[object] as Uint16Array, fps, RED_AMPLITUDE_FIXED, null, wantTrace);
    const redMax = maxInWindow(red.flashes);
    if (redMax.count > maxRed) maxRed = redMax.count;
    if (redMax.count > MAX_FLASHES_PER_WINDOW) {
      violations.push({
        object: objectId,
        kind: 'red',
        windowStartMs: redMax.startMs,
        count: redMax.count,
      });
    }

    if (general.trace && red.trace) {
      traceObjects.push({ object: objectId, general: general.trace, red: red.trace });
    }
  }

  const candidateStarts = new Set<number>();
  for (const flashes of keyFlashes) {
    for (const timeMs of flashes) candidateStarts.add(timeMs);
  }
  const sortedStarts = Array.from(candidateStarts).sort((a, b) => a - b);
  const requiredKeys = Math.ceil(KEY_COUNT * SMALL_FLASH_KEY_FRACTION);
  let manySmallKeys = 0;
  let manySmallStart = 0;
  for (const startMs of sortedStarts) {
    const endMs = startMs + WINDOW_MS;
    let count = 0;
    for (const flashes of keyFlashes) {
      if (countInRange(flashes, startMs, endMs) > MAX_FLASHES_PER_WINDOW) count++;
    }
    if (count > manySmallKeys) {
      manySmallKeys = count;
      manySmallStart = startMs;
    }
  }
  const manySmallViolated = manySmallKeys >= requiredKeys;
  if (manySmallViolated) {
    violations.push({
      object: 'board',
      kind: 'many_small',
      windowStartMs: manySmallStart,
      count: manySmallKeys,
    });
  }

  const report: FlashReport = {
    ok: violations.length === 0,
    violations,
    maxPerWindow: { general: maxGeneral, red: maxRed },
  };
  if (!wantTrace) return report;

  const manySmallDetails: FlashTraceManySmallKey[] = [];
  if (manySmallViolated) {
    const endMs = manySmallStart + WINDOW_MS;
    for (let key = 0; key < KEY_COUNT; key++) {
      const series = keyAnalyses[key]?.trace;
      if (!series) continue;
      const events = series.flashes.filter((flash) => flash.timeMs >= manySmallStart && flash.timeMs < endMs);
      if (events.length <= MAX_FLASHES_PER_WINDOW) continue;
      manySmallDetails.push({
        keyIndex: key,
        key: KEY_NAMES[key] as string,
        block: OBJECT_IDS[1 + (KEY_BLOCKS[key] as number)] as ObjectId,
        flashes: events.length,
        events,
      });
    }
  }

  const trace: FlashTrace = {
    fps,
    frameCount,
    durationMs: frameCount * (1000 / fps),
    report,
    objects: traceObjects,
    manySmall: {
      requiredKeys,
      maxKeys: manySmallKeys,
      windowStartMs: manySmallStart,
      violated: manySmallViolated,
      keys: manySmallDetails,
    },
  };
  return { ...report, trace };
}
