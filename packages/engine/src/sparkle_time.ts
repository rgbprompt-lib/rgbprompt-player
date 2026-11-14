// Time-based sparkle scheduler (ENGINE.md §5.2).
// Sparkle is always time-based in this engine: events depend only on the seed,
// the stable layer id and the time bucket, never on the render cadence.
import { sparkleIdHash } from './rng.ts';
import { getCapabilities } from './capabilities.ts';
import type {
  LayerDsl,
  LayerParams,
  NormalizedLayer,
  ValidationClamp,
  ValidationCode,
  ValidationIssue,
  ValidationMode,
} from './types.ts';

export { sparkleIdHash } from './rng.ts';

function issue(path: string, code: ValidationCode, message: string): ValidationIssue {
  return { path, code, message };
}

function applyRange(
  path: string,
  value: number,
  min: number,
  max: number,
  mode: ValidationMode,
  clamps: ValidationClamp[],
  errors: ValidationIssue[],
  rangeCode: ValidationCode,
  message: string,
  apply: (to: number) => void,
): void {
  let to: number | null = null;
  if (value < min) to = min;
  else if (value > max) to = max;
  if (to === null) return;
  if (mode === 'generate') {
    clamps.push({ path, from: value, to });
    apply(to);
  } else {
    errors.push(issue(path, rangeCode, message));
  }
}

function checkIntegerParam(
  path: string,
  value: unknown,
  min: number,
  max: number,
  mode: ValidationMode,
  clamps: ValidationClamp[],
  errors: ValidationIssue[],
  message: string,
  apply: (to: number) => void,
): void {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    errors.push(issue(path, 'PARAM_TYPE', message));
    return;
  }
  applyRange(path, value, min, max, mode, clamps, errors, 'PARAM_RANGE', message, apply);
}

export function isTimeSparkle(layer: { component: string }): boolean {
  return layer.component === 'sparkle';
}

export function sparkleTimeIssues(
  layer: LayerDsl,
  at: string,
  mode: ValidationMode,
  clamps: ValidationClamp[],
): ValidationIssue[] {
  if (layer.component !== 'sparkle') return [];
  const errors: ValidationIssue[] = [];
  const capability = getCapabilities('sparkle');
  const paletteValues = capability?.paletteValues ?? ['rainbow24', 'seven'];
  const params: LayerParams =
    layer.params && typeof layer.params === 'object' && !Array.isArray(layer.params)
      ? // Reason: checked to be a non-array object above.
        (layer.params as LayerParams)
      : {};
  for (const [key, value] of Object.entries(params)) {
    if (key === 'clock') {
      // Reason: params are arbitrary JSON; includes compares exactly as before.
      if (!['time', 'legacy'].includes(value as string)) {
        errors.push(issue(`${at}.params.clock`, 'PARAM_TYPE', 'must be "time" or "legacy"'));
      }
    } else if (key === 'palette') {
      // Reason: params are arbitrary JSON; includes compares exactly as before.
      if (!paletteValues.includes(value as string)) {
        errors.push(
          issue(
            `${at}.params.palette`,
            'PARAM_TYPE',
            `must be one of ${paletteValues.map((name) => `"${name}"`).join(', ')}`,
          ),
        );
      }
    } else if (key === 'rate') {
      checkIntegerParam(
        `${at}.params.rate`,
        value,
        1,
        100,
        mode,
        clamps,
        errors,
        'must be an integer in 1..100',
        (to) => {
          params.rate = to;
        },
      );
    } else if (key === 'decay_ms') {
      checkIntegerParam(
        `${at}.params.decay_ms`,
        value,
        1,
        65535,
        mode,
        clamps,
        errors,
        'must be an integer in 1..65535',
        (to) => {
          params.decay_ms = to;
        },
      );
    } else {
      errors.push(issue(`${at}.params.${key}`, 'PARAM_UNKNOWN', 'is not supported by sparkle'));
    }
  }
  const color = layer.color as { type?: unknown; rgb?: unknown; [key: string]: unknown } | null | undefined;
  if (
    color &&
    (color.type !== 'solid' ||
      Object.keys(color).some((key) => !['type', 'rgb'].includes(key)) ||
      !Array.isArray(color.rgb) ||
      color.rgb.length !== 3)
  ) {
    errors.push(
      issue(`${at}.color`, 'COLOR_INVALID', 'must be omitted or a solid [r,g,b] with integers 0..255'),
    );
  }
  for (const [key, allowed, code] of [
    ['time', capability?.timeTypes ?? ['static'], 'TIME_INVALID'],
    ['trigger', capability?.triggerTypes ?? ['always'], 'TRIGGER_INVALID'],
  ] as const) {
    // Reason: only `time` / `trigger` are read here; raw input is checked below.
    const field = layer[key] as { type?: unknown } | null | undefined;
    if (
      field &&
      (!(allowed as readonly string[]).includes(field.type as string) ||
        Object.keys(field).some((name) => name !== 'type'))
    ) {
      errors.push(issue(`${at}.${key}`, code, `must be omitted or {"type":"${allowed[0]}"}`));
    }
  }
  if (layer.frames !== undefined && layer.frames !== null) {
    errors.push(issue(`${at}.frames`, 'LAYER_INVALID', 'is not accepted by sparkle'));
  }
  return errors;
}

export function sparkleHash(seed: number, salt: number, epoch: number, lane: number, stream: number): number {
  let x = (seed ^ salt ^ Math.imul(epoch + 1, 0x9e3779b9) ^ Math.imul(lane + 1, 0x85ebca6b) ^ stream) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

export interface SparkleEvent {
  lane: number;
  index: number;
  colorIndex: number;
  age: number;
  level: number;
}

export function timeSparkleEvents(layer: NormalizedLayer, tick: number, seed: number): SparkleEvent[] {
  seed = seed >>> 0 || 1;
  const p = layer.params ?? {},
    // Reason: sparkle params are arbitrary JSON; the scheduler does arithmetic on them.
    decay = (p.decay_ms as number | undefined) ?? 500,
    // Reason: sparkle params are arbitrary JSON; the scheduler does arithmetic on them.
    rate = (p.rate as number | undefined) ?? 8,
    period = Math.max(640, Math.floor(((decay + 1) * 16 + 14) / 15)),
    now = tick >>> 0,
    epoch = Math.floor(now / period),
    phase = now % period,
    salt = sparkleIdHash(layer.id),
    count = layer.cells.length,
    paletteSize = p.palette === 'seven' ? 7 : 24,
    events: SparkleEvent[] = [];
  if (!count) return events;
  for (let lane = 0; lane < 16; lane++) {
    const start = Math.floor((lane * period) / 16),
      width = Math.floor(((lane + 1) * period) / 16) - start;
    let e = epoch,
      offset = start + (sparkleHash(seed, salt, e, lane, 0xa341316c) % width),
      age;
    if (offset <= phase) age = phase - offset;
    else {
      if (!e) continue;
      e--;
      offset = start + (sparkleHash(seed, salt, e, lane, 0xa341316c) % width);
      age = phase + period - offset;
    }
    if (age >= decay || sparkleHash(seed, salt, e, lane, 0xc8013ea4) % 100 >= rate) continue;
    const level = Math.floor((100 * (decay - age)) / decay);
    if (!level) continue;
    events.push({
      lane,
      index: sparkleHash(seed, salt, e, lane, 0xad90777d) % count,
      colorIndex: sparkleHash(seed, salt, e, lane, 0x7e95761e) % paletteSize,
      age,
      level,
    });
  }
  return events;
}
