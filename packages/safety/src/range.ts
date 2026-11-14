// Flash-safe control ranges for the manual Tune path (FLASH-SAFETY.md §4.3).
//
// The manual-adjust path pre-truncates controls at the client so the user
// cannot choose a value that violates the offline detector. Sampling follows
// FLASH-SAFETY.md §4.2: 25 fps for 10 s, with the shared input scripts.
import { applyTuning, getLayerInputs, getPrimitiveProduct, normalize, simulate } from '@rgbprompt/engine';
import type { EffectDsl, SimAudioEvent, SimKeyEvent } from '@rgbprompt/engine';
import { frameToKeyRgb } from '@rgbprompt/layouts';
import { detectFlashes } from './detector.ts';
import { buildInputScript } from './input-scripts.ts';

export const SAFE_RANGE_FPS = 25;
export const SAFE_RANGE_STEP_MS = 40;
export const SAFE_RANGE_FRAMES = 250;
export const SAFE_RANGE_DURATION_MS = SAFE_RANGE_STEP_MS * SAFE_RANGE_FRAMES;
export const SAFE_RANGE_MIN = 0.5;
export const SAFE_RANGE_MAX = 2;
// Binary search stops once the bracket is tighter than this multiplier step.
export const SAFE_RANGE_TOLERANCE = 0.05;

export type SafeRangeControl = 'speed' | 'color' | 'area';

export interface SpeedSafeRange {
  control: 'speed';
  min: number;
  max: number;
  safe: boolean;
}

export interface DiscreteSafeRange {
  control: 'color' | 'area';
  safe: boolean;
}

export type SafeRangeResult = SpeedSafeRange | DiscreteSafeRange;

function roundMultiplier(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function renderFrames(effect: EffectDsl, keyEvents: SimKeyEvent[], audio: SimAudioEvent[]): Uint8Array[] {
  const program = normalize(effect);
  const frames = simulate(program, {
    ticks: SAFE_RANGE_FRAMES,
    stepMs: SAFE_RANGE_STEP_MS,
    keyEvents,
    audio,
  });
  return frames.map((frame) => frameToKeyRgb(frame));
}

function inputNeeds(effect: EffectDsl): { typing: boolean; audio: boolean } {
  let typing = false;
  let audio = false;
  for (const layer of effect.layer ?? []) {
    if (layer.enabled === false) continue;
    const inputs = getLayerInputs(layer);
    typing ||= inputs.key;
    audio ||= inputs.audio;
  }
  return { typing, audio };
}

function effectPassesDetection(effect: EffectDsl): boolean {
  const needs = inputNeeds(effect);
  const hasInput = needs.typing || needs.audio;
  if (!detectFlashes(renderFrames(effect, [], []), SAFE_RANGE_FPS).ok) return false;
  if (!hasInput) return true;
  const script = buildInputScript({
    durationMs: SAFE_RANGE_DURATION_MS,
    typing: needs.typing,
    audio: needs.audio,
  });
  return detectFlashes(renderFrames(effect, script.keyEvents, script.audioEvents), SAFE_RANGE_FPS).ok;
}

function findMaxSafe(
  layerId: string,
  effect: EffectDsl,
  cache: Map<number, boolean>,
  lowSafe: number,
  highUnsafe: number,
): number {
  let low = lowSafe;
  let high = highUnsafe;
  while (high - low > SAFE_RANGE_TOLERANCE) {
    const middle = roundMultiplier((low + high) / 2);
    if (middle === low || middle === high) break;
    if (safeAt(layerId, effect, cache, middle)) low = middle;
    else high = middle;
  }
  return roundMultiplier(low);
}

function findMinSafe(
  layerId: string,
  effect: EffectDsl,
  cache: Map<number, boolean>,
  lowUnsafe: number,
  highSafe: number,
): number {
  let low = lowUnsafe;
  let high = highSafe;
  while (high - low > SAFE_RANGE_TOLERANCE) {
    const middle = roundMultiplier((low + high) / 2);
    if (middle === low || middle === high) break;
    if (safeAt(layerId, effect, cache, middle)) high = middle;
    else low = middle;
  }
  return roundMultiplier(high);
}

function safeAt(
  layerId: string,
  effect: EffectDsl,
  cache: Map<number, boolean>,
  multiplier: number,
): boolean {
  const key = roundMultiplier(multiplier);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const applied = applyTuning(effect, { layerId, kind: 'speed', multiplier: key });
  const safe = applied.ok && effectPassesDetection(applied.effect);
  cache.set(key, safe);
  return safe;
}

export function safeRange(effect: EffectDsl, layerId: string, control: SafeRangeControl): SafeRangeResult {
  const layer = (effect.layer ?? []).find((candidate) => candidate.id === layerId);
  if (!layer) throw new Error(`safeRange: unknown layer id "${layerId}"`);

  if (control === 'color' || control === 'area') {
    return { control, safe: effectPassesDetection(effect) };
  }

  const product = getPrimitiveProduct(layer.component);
  if (!product || product.speed.params.length === 0) {
    return { control: 'speed', min: SAFE_RANGE_MIN, max: SAFE_RANGE_MAX, safe: true };
  }

  const cache = new Map<number, boolean>();
  const slow = safeAt(layerId, effect, cache, SAFE_RANGE_MIN);
  const normal = safeAt(layerId, effect, cache, 1);
  const fast = safeAt(layerId, effect, cache, SAFE_RANGE_MAX);

  if (slow && normal && fast) {
    return { control: 'speed', min: SAFE_RANGE_MIN, max: SAFE_RANGE_MAX, safe: true };
  }

  if (normal) {
    const min = slow ? SAFE_RANGE_MIN : findMinSafe(layerId, effect, cache, SAFE_RANGE_MIN, 1);
    const max = fast ? SAFE_RANGE_MAX : findMaxSafe(layerId, effect, cache, 1, SAFE_RANGE_MAX);
    return { control: 'speed', min, max, safe: true };
  }

  if (slow && !fast) {
    const max = findMaxSafe(layerId, effect, cache, SAFE_RANGE_MIN, 1);
    return { control: 'speed', min: SAFE_RANGE_MIN, max, safe: true };
  }

  if (fast && !slow) {
    const min = findMinSafe(layerId, effect, cache, 1, SAFE_RANGE_MAX);
    return { control: 'speed', min, max: SAFE_RANGE_MAX, safe: true };
  }

  if (slow && fast) {
    // Both ends are safe but the current speed is not; report the slow safe
    // interval rather than pretending a contiguous range exists.
    const max = findMaxSafe(layerId, effect, cache, SAFE_RANGE_MIN, 1);
    return { control: 'speed', min: SAFE_RANGE_MIN, max, safe: true };
  }

  // Coarse fallback for an unusual non-monotonic result.
  for (let step = 0; step <= 30; step++) {
    const multiplier = roundMultiplier(SAFE_RANGE_MIN + step * 0.05);
    if (safeAt(layerId, effect, cache, multiplier)) {
      return { control: 'speed', min: multiplier, max: multiplier, safe: true };
    }
  }
  return { control: 'speed', min: 1, max: 1, safe: false };
}
