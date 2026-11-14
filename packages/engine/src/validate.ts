import { audioContract, audioIssues, instanceLimit } from './audio/control.ts';
import { paletteStopsErrors } from './palette_stops.ts';
import { paletteAlphaErrors } from './palette_alpha.ts';
import { playbackErrors } from './playback.ts';
import type { LayerDsl as AudioLayerDsl } from './types.ts';
// Structural + semantic validation. docs/06 §8, docs/11 §2-3, ENGINE.md §6.
import { expandSurface, boardForEffect } from './surfaces.ts';
import { getComponent, componentNames } from './registry.ts';
import { MAX_LAYERS, MAX_PARAMS_PER_LAYER, MAX_PALETTE_COLORS } from './constants.ts';
import { extensionIssues, maxParamsFor } from './extensions.ts';
import {
  COLOR_TYPE_SET,
  TIME_TYPE_SET,
  TRIGGER_TYPE_SET,
  acceptsTriggerType,
  formatColorTypes,
  formatTimeTypes,
  formatTriggerTypes,
  getCapabilities,
} from './capabilities.ts';
import { sparkleTimeIssues } from './sparkle_time.ts';
import { utf8Bytes } from './rng.ts';
import type {
  Board,
  LayerDsl,
  ValidationBudget,
  ValidationClamp,
  ValidationCode,
  ValidationIssue,
  ValidationMode,
  ValidationReport,
  ValidateOptions,
} from './types.ts';

const BLENDS = new Set(['replace', 'add', 'max', 'mask']);
const GENERATORS = new Set(['human', 'ai']);

// ENGINE.md §3.1: registered primitives that are not open in v1. The registry
// has no availability field, so this is the single source for the check.
export const CLOSED_COMPONENTS = Object.freeze(['frame_sequence', 'layer_event']);
const CLOSED_COMPONENT_NAMES = new Set(CLOSED_COMPONENTS);

// Estimated render cost per cell. Audio analysis is the most expensive,
// key-event and stateful primitives keep per-layer history, everything else
// is stateless.
export const COST_WEIGHTS = Object.freeze({
  stateless: 1,
  keyEventOrStateful: 2,
  audio: 4,
});

const STATEFUL_COMPONENTS = new Set([
  'reactive',
  'ripple',
  'ripple_square',
  'aurora',
  'rain',
  'block_stack',
  'sparkle',
]);

const MAX_DSL_BYTES = 64 * 1024;

function isInt(x: unknown): x is number {
  return Number.isInteger(x);
}
function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}
function issue(path: string, code: ValidationCode, message: string): ValidationIssue {
  return { path, code, message };
}

function costWeight(component: unknown): number {
  const name = typeof component === 'string' ? component : '';
  if (name.startsWith('spectrum')) return COST_WEIGHTS.audio;
  if (name.startsWith('key_') || STATEFUL_COMPONENTS.has(name)) {
    return COST_WEIGHTS.keyEventOrStateful;
  }
  return COST_WEIGHTS.stateless;
}

function dslBytes(value: unknown): number {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? 0 : utf8Bytes(text).length;
  } catch {
    return 0;
  }
}

function deepClone<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => deepClone(item)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      out[key] = deepClone((value as Record<string, unknown>)[key]);
    }
    return out as T;
  }
  return value;
}

function computeBudget(value: unknown, board: Board | null): ValidationBudget {
  const rawLayers = isObjectRecord(value) && Array.isArray(value.layer) ? (value.layer as unknown[]) : [];
  let estCostUnits = 0;
  for (const raw of rawLayers) {
    if (!isObjectRecord(raw)) continue;
    const layer = raw as LayerDsl;
    let cells = 0;
    if (board) {
      try {
        cells = expandSurface(layer.surface, board).length;
      } catch {
        cells = 0;
      }
    }
    estCostUnits += cells * costWeight(layer.component);
  }
  return { layers: rawLayers.length, estCostUnits, bytes: dslBytes(value) };
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

function checkIntegerRange(
  path: string,
  value: unknown,
  min: number,
  max: number,
  mode: ValidationMode,
  clamps: ValidationClamp[],
  errors: ValidationIssue[],
  typeCode: ValidationCode,
  rangeCode: ValidationCode,
  message: string,
  apply: (to: number) => void,
): void {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    errors.push(issue(path, typeCode, message));
    return;
  }
  applyRange(path, value, min, max, mode, clamps, errors, rangeCode, message, apply);
}

export function validate(dsl: unknown, opts: ValidateOptions = {}): ValidationReport {
  const mode: ValidationMode = opts.mode ?? 'strict';
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const clamps: ValidationClamp[] = [];

  let board: Board;
  try {
    board = boardForEffect(dsl, opts.board);
  } catch (e) {
    // Reason: boardForEffect only throws Error instances.
    errors.push(issue('meta.region_profile', 'META_INVALID', e instanceof Error ? e.message : String(e)));
    return {
      ok: false,
      errors,
      warnings,
      clamps,
      budget: computeBudget(dsl, null),
      value: null,
    };
  }

  if (!isObjectRecord(dsl)) {
    errors.push(issue('', 'SCHEMA', 'document is not an object'));
    return {
      ok: false,
      errors,
      warnings,
      clamps,
      budget: computeBudget(dsl, board),
      value: null,
    };
  }
  const working = (mode === 'generate' ? deepClone(dsl) : dsl) as Record<string, unknown>;

  if (working.schema !== 'lep.effect/1') {
    errors.push(issue('schema', 'SCHEMA', `must be "lep.effect/1" (got ${JSON.stringify(working.schema)})`));
  }
  const meta = working.meta;
  if (!isObjectRecord(meta)) {
    errors.push(issue('meta', 'META_INVALID', 'is required'));
  } else {
    if (
      meta.motion_profile !== undefined &&
      !['legacy', 'physical-v1'].includes(meta.motion_profile as string)
    ) {
      errors.push(issue('meta.motion_profile', 'META_INVALID', 'must be legacy or physical-v1'));
    }
    if (meta.execution_profile !== undefined && meta.execution_profile !== 'composable-v1') {
      errors.push(issue('meta.execution_profile', 'META_INVALID', 'must be composable-v1'));
    }
    if (typeof meta.name !== 'string' || meta.name.length < 1 || meta.name.length > 48) {
      errors.push(issue('meta.name', 'META_INVALID', 'must be a string of length 1..48'));
    }
    if (typeof meta.author !== 'string' || meta.author.length < 1 || meta.author.length > 64) {
      errors.push(issue('meta.author', 'META_INVALID', 'must be a string of length 1..64'));
    }
    if (!GENERATORS.has(meta.generator as string)) {
      errors.push(issue('meta.generator', 'META_INVALID', 'must be "human" or "ai"'));
    }
    checkIntegerRange(
      'meta.seed',
      meta.seed,
      0,
      0xffffffff,
      mode,
      clamps,
      errors,
      'META_INVALID',
      'META_INVALID',
      'must be an integer in [0, 4294967295]',
      (to) => {
        meta.seed = to;
      },
    );
  }

  if (!Array.isArray(working.layer)) {
    errors.push(issue('layer', 'SCHEMA', 'must be an array'));
    return {
      ok: false,
      errors,
      warnings,
      clamps,
      budget: computeBudget(working, board),
      value: null,
    };
  }
  const layers = working.layer as unknown[];
  if (layers.length < 1) errors.push(issue('layer', 'LAYER_INVALID', 'must have at least 1 item'));
  if (layers.length > MAX_LAYERS) {
    errors.push(issue('layer', 'BUDGET_LAYERS', `count ${layers.length} exceeds MAX_LAYERS=${MAX_LAYERS}`));
  }

  const names = componentNames();
  const seenIds = new Set<string>();

  layers.forEach((rawLayer, i) => {
    const at = `layer[${i}]`;
    if (!isObjectRecord(rawLayer)) {
      errors.push(issue(at, 'LAYER_INVALID', 'is not an object'));
      return;
    }
    // Reason: gives names to raw fields; every field is still checked below.
    const layer = rawLayer as LayerDsl;
    if (typeof layer.id !== 'string' || layer.id.length < 1 || layer.id.length > 24) {
      errors.push(issue(`${at}.id`, 'LAYER_INVALID', 'must be a string of length 1..24'));
    } else if (seenIds.has(layer.id)) {
      errors.push(issue(`${at}.id`, 'DUPLICATE_LAYER_ID', `"${layer.id}" is duplicated`));
    } else {
      seenIds.add(layer.id);
    }

    const comp = getComponent(layer.component);
    if (!comp) {
      errors.push(
        issue(
          `${at}.component`,
          'COMPONENT_UNKNOWN',
          `must be one of: ${names.join(', ')} (got ${JSON.stringify(layer.component)})`,
        ),
      );
    } else if (CLOSED_COMPONENT_NAMES.has(comp.name)) {
      errors.push(issue(`${at}.component`, 'COMPONENT_NOT_OPEN', `"${comp.name}" is not open in v1`));
    }
    if (layer.component === 'sparkle') {
      errors.push(...sparkleTimeIssues(layer, at, mode, clamps));
    }

    // surface
    try {
      const cells = expandSurface(layer.surface, board);
      if (cells.length === 0) {
        warnings.push(issue(`${at}.surface`, 'SURFACE_EMPTY', 'resolves to 0 cells'));
      }
    } catch (e) {
      // Reason: expandSurface only throws Error instances.
      errors.push(issue(`${at}.surface`, 'SURFACE_INVALID', e instanceof Error ? e.message : String(e)));
    }

    if (layer.blend !== undefined && !BLENDS.has(layer.blend)) {
      errors.push(issue(`${at}.blend`, 'LAYER_INVALID', 'must be one of replace/add/max/mask'));
    }
    if (layer.opacity !== undefined) {
      checkIntegerRange(
        `${at}.opacity`,
        layer.opacity,
        0,
        255,
        mode,
        clamps,
        errors,
        'LAYER_INVALID',
        'LAYER_INVALID',
        'must be 0..255',
        (to) => {
          layer.opacity = to;
        },
      );
    }
    // Reason: raw color input; the checks below validate its actual shape.
    const color = layer.color as
      { type?: unknown; rgb?: unknown; colors?: unknown; [key: string]: unknown } | null | undefined;
    const audioLayer = layer as unknown as AudioLayerDsl;
    for (const problem of audioIssues(audioLayer)) errors.push(issue(at, 'LAYER_INVALID', problem));
    const capability = getCapabilities(layer.component);
    for (const problem of extensionIssues(layer, at)) errors.push(problem);
    if (layer.color !== undefined) {
      if (!color || typeof color !== 'object' || !COLOR_TYPE_SET.has(color.type as string)) {
        errors.push(
          issue(`${at}.color.type`, 'COLOR_INVALID', `must be one of ${formatColorTypes(layer.component)}`),
        );
      } else if (
        color.type === 'ramp' &&
        !(capability?.colorTypes.includes('ramp') ?? false) &&
        !(
          ['spectrum', 'spectrum_mirror'].includes(audioLayer.component) &&
          audioLayer.params?.color_by_height === true
        ) &&
        // extensionIssues reports a reactive ramp outside lifecycle mode, and a
        // rainbow_wave / spiral ramp without params.palette "custom" (upstream lepc).
        !['reactive', 'rainbow_wave', 'spiral'].includes(audioLayer.component)
      ) {
        errors.push(
          issue(
            `${at}.color.type`,
            'COLOR_UNSUPPORTED',
            `=ramp is not supported by ${layer.component}; it supports ${formatColorTypes(layer.component)}`,
          ),
        );
      } else if (color.rgb !== undefined) {
        const rgb = color.rgb;
        if (!Array.isArray(rgb) || rgb.length !== 3) {
          errors.push(issue(`${at}.color.rgb`, 'COLOR_INVALID', 'must be [r,g,b] each 0..255'));
        } else {
          for (let channel = 0; channel < 3; channel++) {
            checkIntegerRange(
              `${at}.color.rgb[${channel}]`,
              rgb[channel],
              0,
              255,
              mode,
              clamps,
              errors,
              'COLOR_INVALID',
              'COLOR_INVALID',
              'must be 0..255',
              (to) => {
                rgb[channel] = to;
              },
            );
          }
        }
      }
      if (Array.isArray(color?.colors) && color.colors.length > MAX_PALETTE_COLORS) {
        errors.push(
          issue(
            `${at}.color.colors`,
            'BUDGET_PALETTE',
            `has ${color.colors.length} colors, exceeds MAX_PALETTE_COLORS=${MAX_PALETTE_COLORS}`,
          ),
        );
      }
    }
    if (
      capability?.solidColorOnly &&
      layer.color &&
      color?.type !== 'solid' &&
      // A key_ring ramp is a custom ring palette (checked by the execution contract).
      !(audioLayer.component === 'key_ring' && color?.type === 'ramp')
    ) {
      errors.push(
        issue(
          `${at}.color`,
          'COLOR_UNSUPPORTED',
          `${layer.component} supports solid color or an omitted color with params.palette`,
        ),
      );
    }
    if (capability?.rampStops !== undefined) {
      if (
        !color ||
        color.type !== 'ramp' ||
        !Array.isArray(color.colors) ||
        color.colors.length !== capability.rampStops
      ) {
        errors.push(
          issue(`${at}.color`, 'COLOR_INVALID', `rain requires ${capability.rampStops} RGB colors`),
        );
      } else {
        (color.colors as unknown[]).forEach((stop, stopIndex) => {
          if (!Array.isArray(stop) || stop.length !== 3) {
            errors.push(
              issue(`${at}.color.colors[${stopIndex}]`, 'COLOR_INVALID', 'must be [r,g,b] each 0..255'),
            );
            return;
          }
          for (let channel = 0; channel < 3; channel++) {
            checkIntegerRange(
              `${at}.color.colors[${stopIndex}][${channel}]`,
              stop[channel],
              0,
              255,
              mode,
              clamps,
              errors,
              'COLOR_INVALID',
              'COLOR_INVALID',
              'must be 0..255',
              (to) => {
                stop[channel] = to;
              },
            );
          }
        });
      }
    }
    for (const message of [...paletteStopsErrors(layer), ...paletteAlphaErrors(layer)]) {
      errors.push(issue(`${at}.color`, 'COLOR_INVALID', message));
    }
    for (const message of playbackErrors(layer)) {
      errors.push(issue(`${at}.playback`, 'LAYER_INVALID', message));
    }
    if (layer.component === 'rain' && layer.time?.min_level !== undefined) {
      checkIntegerRange(
        `${at}.time.min_level`,
        layer.time.min_level,
        0,
        100,
        mode,
        clamps,
        errors,
        'TIME_INVALID',
        'TIME_INVALID',
        'must be 0..100',
        (to) => {
          // Reason: the guard above proves layer.time is present.
          (layer.time as Record<string, unknown>).min_level = to;
        },
      );
    }
    if (layer.component === 'rain' && layer.time?.phase_ms !== undefined) {
      errors.push(issue(`${at}.time.phase_ms`, 'TIME_INVALID', 'is not supported by rain'));
    }
    if (layer.component === 'rain' && layer.time?.period_ms !== undefined) {
      const period = layer.time.period_ms;
      if (typeof period !== 'number' || !Number.isInteger(period)) {
        errors.push(issue(`${at}.time.period_ms`, 'TIME_INVALID', 'must be 1000..30000'));
      } else if (period !== 0) {
        applyRange(
          `${at}.time.period_ms`,
          period,
          1000,
          30000,
          mode,
          clamps,
          errors,
          'TIME_INVALID',
          'must be 1000..30000',
          (to) => {
            (layer.time as Record<string, unknown>).period_ms = to;
          },
        );
      }
    }
    if (layer.time !== undefined) {
      if (!layer.time || typeof layer.time !== 'object' || !TIME_TYPE_SET.has(layer.time.type as string)) {
        errors.push(
          issue(`${at}.time.type`, 'TIME_INVALID', `must be one of ${formatTimeTypes(layer.component)}`),
        );
      }
    }
    if (layer.trigger !== undefined) {
      if (
        !layer.trigger ||
        typeof layer.trigger !== 'object' ||
        !TRIGGER_TYPE_SET.has(layer.trigger.type as string)
      ) {
        errors.push(
          issue(
            `${at}.trigger.type`,
            'TRIGGER_INVALID',
            `must be one of ${formatTriggerTypes(layer.component)}`,
          ),
        );
      } else if (layer.component !== 'sparkle' && !acceptsTriggerType(layer.component, layer.trigger.type)) {
        errors.push(
          issue(
            `${at}.trigger`,
            'TRIGGER_INVALID',
            `${layer.component} supports trigger ${formatTriggerTypes(layer.component)}`,
          ),
        );
      } else if (
        layer.component === 'key_burst' &&
        layer.trigger.scope !== undefined &&
        layer.trigger.scope !== 'surface'
      ) {
        errors.push(
          issue(`${at}.trigger`, 'TRIGGER_INVALID', 'key_burst uses key presses within its surface'),
        );
      }
    }

    // frame_sequence inline frames
    if (layer.frames !== undefined) {
      if (!Array.isArray(layer.frames)) {
        errors.push(issue(`${at}.frames`, 'LAYER_INVALID', 'must be an array'));
      } else {
        for (let frameIndex = 0; frameIndex < layer.frames.length; frameIndex++) {
          const frame = layer.frames[frameIndex];
          if (!isObjectRecord(frame) || !Array.isArray(frame.points)) {
            errors.push(
              issue(`${at}.frames[${frameIndex}]`, 'LAYER_INVALID', 'entries must have a points array'),
            );
            break;
          }
          const points = frame.points as unknown[];
          const bad = points.find(
            (p) => !Array.isArray(p) || p.length !== 6 || !p.every((n) => Number.isInteger(n)),
          );
          if (bad) {
            errors.push(
              issue(
                `${at}.frames[${frameIndex}].points`,
                'LAYER_INVALID',
                'must be [r,c,r,g,b,level] integers',
              ),
            );
            break;
          }
        }
      }
    }

    // params: count + known keys + ranges
    if (layer.params !== undefined) {
      if (!isObjectRecord(layer.params) || Array.isArray(layer.params)) {
        errors.push(issue(`${at}.params`, 'PARAM_TYPE', 'must be an object'));
      } else {
        // Reason: raw params are validated by the checks below.
        const params = layer.params as Record<string, unknown>;
        const keys = Object.keys(params);
        const maxParams = maxParamsFor(String(layer.component), MAX_PARAMS_PER_LAYER);
        if (keys.length > maxParams) {
          errors.push(
            issue(
              `${at}.params`,
              'BUDGET_PARAMS',
              `has ${keys.length} keys, exceeds MAX_PARAMS_PER_LAYER=${maxParams}`,
            ),
          );
        }
        if (comp && comp.name !== 'sparkle') {
          for (const k of keys) {
            const spec = comp.params?.[k];
            if (!spec) {
              const target = ['key_burst', 'rain'].includes(comp.name) ? errors : warnings;
              target.push(issue(`${at}.params.${k}`, 'PARAM_UNKNOWN', `is unknown for ${comp.name}`));
              continue;
            }
            const v = params[k];
            if (Array.isArray(spec.enum) && !spec.enum.includes(v as string)) {
              errors.push(issue(`${at}.params.${k}`, 'PARAM_TYPE', `must be one of ${spec.enum.join('|')}`));
              continue;
            }
            if (comp.name === 'key_burst' && k === 'palette') {
              if (!['rainbow24', 'seven'].includes(v as string)) {
                errors.push(issue(`${at}.params.palette`, 'PARAM_TYPE', 'must be rainbow24 or seven'));
              }
            } else if (comp.name === 'key_burst' && k === 'origin') {
              if (!['event_key', 'board_center', 'random_key'].includes(v as string)) {
                errors.push(
                  issue(`${at}.params.origin`, 'PARAM_TYPE', 'must be event_key|board_center|random_key'),
                );
              }
            } else if (
              (comp.name === 'rain' || (comp.name === 'key_burst' && k !== 'palette' && k !== 'origin')) &&
              !isInt(v)
            ) {
              errors.push(issue(`${at}.params.${k}`, 'PARAM_TYPE', 'must be an integer'));
            }
            if (typeof v === 'number') {
              if (spec.min !== undefined || spec.max !== undefined) {
                const min = spec.min ?? Number.NEGATIVE_INFINITY;
                const max = spec.max ?? Number.POSITIVE_INFINITY;
                const message = v < min ? `${v} is below min ${spec.min}` : `${v} is above max ${spec.max}`;
                applyRange(
                  `${at}.params.${k}`,
                  v,
                  min,
                  max,
                  mode,
                  clamps,
                  errors,
                  'PARAM_RANGE',
                  message,
                  (to) => {
                    params[k] = to;
                  },
                );
              }
            } else {
              // Reason: non-numeric values keep the legacy comparison result.
              if (spec.min !== undefined && (v as number) < spec.min) {
                errors.push(
                  issue(`${at}.params.${k}`, 'PARAM_RANGE', `${String(v)} is below min ${spec.min}`),
                );
              } else if (spec.max !== undefined && (v as number) > spec.max) {
                errors.push(
                  issue(`${at}.params.${k}`, 'PARAM_RANGE', `${String(v)} is above max ${spec.max}`),
                );
              }
            }
          }
        }
        if (
          layer.component === 'rain' &&
          ((params.fall_min_ms as number | undefined) ?? 750) >
            ((params.fall_max_ms as number | undefined) ?? 900)
        ) {
          errors.push(issue(`${at}.params.fall_min_ms`, 'PARAM_CONFLICT', 'must not exceed fall_max_ms'));
        }
      }
    }
  });

  const usedInstances = layers
    .filter(isObjectRecord)
    .filter((layer) => layer.enabled !== false)
    .reduce((sum, layer) => sum + instanceLimit(layer as unknown as AudioLayerDsl), 0);
  if (usedInstances > audioContract.max_instances)
    errors.push(
      issue('layer', 'BUDGET_LAYERS', 'audio instance budget exceeds ' + audioContract.max_instances),
    );
  const budget = computeBudget(working, board);
  if (budget.bytes > MAX_DSL_BYTES) {
    errors.push(issue('budget.bytes', 'BUDGET_BYTES', `exceeds ${MAX_DSL_BYTES} bytes (${budget.bytes})`));
  }

  const ok = errors.length === 0;
  return {
    ok,
    errors,
    warnings,
    clamps,
    budget,
    value: ok ? (mode === 'generate' ? working : dsl) : null,
  };
}
