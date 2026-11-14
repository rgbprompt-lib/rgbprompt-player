// composable-v1 execution contract (port of upstream lepc execution.js, data from
// data/schemas/execution-contract.json). Runs on the device document
// (device_doc.ts), so every document `validate` accepts is one the upstream strict
// validator accepts and the keyboard firmware loads. Audio bindings are checked by
// audio/control.ts.
import { utf8Bytes } from './rng.ts';
import contractJson from '../data/schemas/execution-contract.json' with { type: 'json' };

interface ParamContract {
  type: string;
  values?: string[];
  min?: number;
  max?: number;
}
interface PrimitiveContract {
  trigger: string;
  inputScope: string | null;
  statePool: string | null;
  colorRequired: boolean;
  colorTypes: string[];
  timeTypes: string[];
  timeFields: string[];
  timeFieldRanges: Record<string, [number, number]>;
  params: Record<string, ParamContract>;
}

export const EXECUTION_CONTRACT = contractJson as unknown as {
  upstream_commit: string;
  primitives: Record<string, PrimitiveContract>;
};

export const primitiveContract = (component: unknown): PrimitiveContract | undefined =>
  typeof component === 'string' ? EXECUTION_CONTRACT.primitives[component] : undefined;

export interface ExecutionIssue {
  layer: number | null;
  field: string;
  message: string;
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (v: unknown, min: number, max: number): boolean =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const extra = (value: Json, allowed: readonly string[]): string[] =>
  Object.keys(value).filter((k) => !allowed.includes(k));
const utf8Length = (s: string): number => utf8Bytes(s).length;
const EASING_NAMES = ['linear', 'sine', 'pulse', 'ease-in', 'ease-out', 'ease-in-out'];
const LAYER_FIELDS = [
  'id',
  'component',
  'surface',
  'color',
  'time',
  'trigger',
  'blend',
  'opacity',
  'params',
  'frames',
  'playback',
  'audio_mod',
];
const COLOR_FIELDS: Record<string, string[]> = {
  solid: ['rgb'],
  palette_index: ['palette', 'colors', 'index'],
  hue_cycle: ['period_ms', 'saturation', 'value'],
  ramp: ['palette', 'colors', 'axis', 'from', 'to', 'alphas', 'stops'],
  random: ['palette'],
};

function validEasing(value: unknown): boolean {
  if (typeof value === 'string') return EASING_NAMES.includes(value);
  if (!isRecord(value) || Object.keys(value).length !== 1) return false;
  const { bezier, lut } = value;
  if (Array.isArray(bezier))
    return (
      bezier.length === 4 &&
      bezier.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1)
    );
  return Array.isArray(lut) && lut.length >= 2 && lut.length <= 64 && lut.every((v) => integer(v, 0, 1000));
}

const isRgbList = (colors: unknown, min: number, max: number): boolean =>
  Array.isArray(colors) &&
  colors.length >= min &&
  colors.length <= max &&
  colors.every((rgb) => Array.isArray(rgb) && rgb.length === 3 && rgb.every((v) => integer(v, 0, 255)));

// Port of upstream lepc reactive_lifecycle.js reactiveLifecycleErrors.
function reactiveIssues(layer: Json): string[] {
  const p = isRecord(layer.params) ? layer.params : {};
  const mode = p.color_mode ?? 'fixed';
  const duration = p.duration_ms ?? 1000;
  if (!['fixed', 'lifecycle'].includes(mode as string)) return ['invalid reactive color_mode'];
  if (!integer(duration, 100, 10000)) return ['reactive duration_ms must be an integer 100..10000'];
  const color = isRecord(layer.color) ? layer.color : null;
  if (mode === 'fixed')
    return duration !== 1000
      ? ['duration_ms needs color_mode "lifecycle"']
      : color?.type === 'ramp'
        ? ['a reactive ramp needs color_mode "lifecycle"']
        : [];
  const issues: string[] = [];
  if (
    Object.keys(p).some((k) => !['speed', 'palette', 'color_mode', 'duration_ms'].includes(k)) ||
    (p.speed ?? 2) !== 2 ||
    p.palette !== 'custom'
  )
    issues.push('reactive lifecycle takes duration_ms only (no speed or other controls)');
  if (
    !color ||
    color.type !== 'ramp' ||
    extra(color, ['type', 'colors', 'alphas', 'stops']).length ||
    !isRgbList(color.colors, 2, 32)
  )
    issues.push('reactive lifecycle needs a ramp of 2..32 RGB colors (type, colors, alphas, stops only)');
  const trigger = isRecord(layer.trigger) ? layer.trigger : null;
  if (!trigger || trigger.type !== 'key_press' || extra(trigger, ['type']).length)
    issues.push('reactive lifecycle needs trigger {"type":"key_press"}');
  const time = layer.time;
  if (time !== undefined && (!isRecord(time) || time.type !== 'static' || extra(time, ['type']).length))
    issues.push('reactive lifecycle is linear: no time modulation or easing');
  if ((layer.blend ?? 'replace') !== 'replace') issues.push('reactive lifecycle needs replace blend');
  if (layer.frames !== undefined && layer.frames !== null) issues.push('reactive lifecycle takes no frames');
  return issues;
}

// Port of upstream lepc key_ring.js keyRingErrors.
function keyRingIssues(layer: Json): string[] {
  const issues: string[] = [];
  const p = isRecord(layer.params) ? layer.params : {};
  for (const [key, min, max, fallback] of [
    ['life_ms', 100, 65535, 1400],
    ['width', 1, 3, 1],
    ['max_waves', 1, 8, 8],
  ] as const)
    if (!integer(p[key] ?? fallback, min, max))
      issues.push(`key_ring ${key} must be an integer ${min}..${max}`);
  if (!['forward', 'reverse'].includes((p.direction ?? 'forward') as string))
    issues.push('key_ring direction must be forward|reverse');
  if (!['event_key', 'board_center', 'random_key'].includes((p.origin ?? 'event_key') as string))
    issues.push('key_ring origin must be event_key|board_center|random_key');
  if (!['fade_out', 'constant', 'fade_in', 'fade_in_out'].includes((p.envelope ?? 'fade_out') as string))
    issues.push('key_ring envelope must be fade_out|constant|fade_in|fade_in_out');
  if (!integer(p.max_radius ?? 4, 1, 22)) issues.push('key_ring max_radius must be an integer 1..22');
  const palette = (p.palette ?? 'rainbow24') as string;
  if (!['rainbow24', 'seven', 'custom'].includes(palette))
    issues.push('key_ring palette must be rainbow24|seven|custom');
  const color = isRecord(layer.color) ? layer.color : null;
  if (color?.type === 'ramp') {
    if (
      extra(color, ['type', 'colors', 'palette', 'axis', 'from', 'to']).length ||
      (color.axis ?? 'x') !== 'x' ||
      (color.from ?? 0) !== 0 ||
      (color.to ?? 1000) !== 1000
    )
      issues.push('a key_ring ramp maps around the ring: no axis/from/to, alphas or stops');
    if (color.palette !== undefined && color.palette !== palette)
      issues.push('conflicting key_ring palettes');
    if (palette === 'custom') {
      if (!isRgbList(color.colors, 2, 32)) issues.push('a custom key_ring needs 2..32 RGB colors');
    } else if (color.colors !== undefined) issues.push('key_ring RGB colors need params.palette "custom"');
  } else {
    if (palette === 'custom') issues.push('a custom key_ring palette needs ramp colors');
    if (layer.color != null && color?.type !== 'solid') issues.push('key_ring color must be solid or ramp');
  }
  return issues;
}

/** Contract issues for a device document (see device_doc.ts). */
export function executionIssues(doc: Json): ExecutionIssue[] {
  const issues: ExecutionIssue[] = [];
  const meta = isRecord(doc.meta) ? doc.meta : {};
  for (const [key, max] of [
    ['name', 48],
    ['author', 64],
  ] as const) {
    const v = meta[key];
    if (typeof v !== 'string' || utf8Length(v) < 1 || utf8Length(v) > max)
      issues.push({ layer: null, field: `meta.${key}`, message: `must be 1..${max} UTF-8 bytes` });
  }
  for (const key of extra(doc, ['schema', 'meta', 'layer']))
    issues.push({ layer: null, field: key, message: 'unknown document field' });
  const layers = Array.isArray(doc.layer) ? doc.layer : [];
  if (layers.length < 1)
    issues.push({ layer: null, field: 'layer', message: 'needs at least one enabled layer' });
  const pools = new Set<string>();
  let totalFrames = 0;
  layers.forEach((layer, i) => {
    if (!isRecord(layer)) return;
    const cap = primitiveContract(layer.component);
    if (!cap) return;
    const err = (field: string, message: string) => issues.push({ layer: i, field, message });
    const component = layer.component as string;
    if (typeof layer.id !== 'string' || utf8Length(layer.id) < 1 || utf8Length(layer.id) > 24)
      err('id', 'must be 1..24 UTF-8 bytes');
    for (const key of extra(layer, LAYER_FIELDS)) err(key, 'unknown layer field');
    const params = isRecord(layer.params) ? layer.params : {};
    const lifecycle = component === 'reactive' && params.color_mode === 'lifecycle';
    const pool = lifecycle ? null : cap.statePool;
    if (pool) {
      if (pools.has(pool)) err('component', `only one ${pool} state-pool layer is supported`);
      pools.add(pool);
    }
    if (component === 'reactive') for (const message of reactiveIssues(layer)) err('params', message);
    if (component === 'key_ring') for (const message of keyRingIssues(layer)) err('params', message);
    // Upstream lepc fireErrors: a fire colour is a bare custom ramp.
    if (
      component === 'fire' &&
      layer.color != null &&
      (!isRecord(layer.color) ||
        layer.color.type !== 'ramp' ||
        extra(layer.color, ['type', 'colors', 'alphas', 'stops']).length ||
        !isRgbList(layer.color.colors, 2, 32))
    )
      err('color', 'fire takes a ramp of 2..32 RGB colors only (type, colors, alphas, stops)');
    if (component === 'wave' && params.axis !== undefined && !['x', 'y'].includes(params.axis as string))
      err('params.axis', 'wave runs on axis x or y');
    if (component === 'sparkle' && params.clock !== 'time') err('params.clock', 'sparkle runs on time');
    if (layer.frames != null && component !== 'frame_sequence')
      err('frames', 'frames only apply to frame_sequence');
    if (
      params.palette === 'custom' &&
      !['rainbow_wave', 'spiral', 'key_ring'].includes(component) &&
      !lifecycle
    )
      err('params.palette', `${component} has no custom palette`);
    if (
      component === 'reactive' &&
      isRecord(layer.color) &&
      layer.color.type === 'random' &&
      params.palette !== undefined &&
      layer.color.palette !== undefined &&
      params.palette !== layer.color.palette
    )
      err('params.palette', 'conflicts with color.palette');
    if (component === 'spiral' && Number(params.soft_edge ?? 0) > Math.floor(Number(params.beam ?? 240) / 2))
      err('params.soft_edge', 'must not exceed half the beam');
    for (const [key, value] of Object.entries(params)) {
      const spec = cap.params[key];
      if (!spec) {
        err(`params.${key}`, `is not a ${component} parameter`);
        continue;
      }
      if (spec.type === 'bool') {
        if (typeof value !== 'boolean') err(`params.${key}`, 'must be boolean');
      } else if (spec.values) {
        if (typeof value !== 'string' || !spec.values.includes(value))
          err(`params.${key}`, `must be one of ${spec.values.join('|')}`);
      } else if (!integer(value, spec.min ?? 0, spec.max ?? 65535))
        err(`params.${key}`, `must be an integer ${spec.min}..${spec.max}`);
    }
    const time = layer.time;
    if (time !== undefined) {
      if (!isRecord(time) || !cap.timeTypes.includes(time.type as string))
        err('time.type', `${component} supports time ${cap.timeTypes.join('|')}`);
      else
        for (const [key, value] of Object.entries(time)) {
          if (key === 'type') continue;
          if (!cap.timeFields.includes(key)) {
            err(`time.${key}`, `${component} time has no ${key}`);
            continue;
          }
          if (key === 'easing') {
            if (!validEasing(value)) err('time.easing', 'invalid easing');
          } else if (key === 'soft') {
            if (typeof value !== 'boolean') err('time.soft', 'must be boolean');
          } else {
            const [min, max] = cap.timeFieldRanges[key] ?? [0, 65535];
            if (!integer(value, min, max)) err(`time.${key}`, `must be an integer ${min}..${max}`);
          }
          if (Object.hasOwn(params, key) && params[key] !== value)
            err(`time.${key}`, `conflicts with params.${key}`);
        }
    }
    const trigger = layer.trigger;
    if (trigger !== undefined) {
      if (!isRecord(trigger) || trigger.type !== cap.trigger)
        err('trigger.type', `${component} uses the ${cap.trigger} trigger`);
      else
        for (const [key, value] of Object.entries(trigger)) {
          if (key === 'type') continue;
          if (key === 'scope' && cap.inputScope && !lifecycle) {
            const allowed = ['surface', ...(cap.inputScope === 'selectable' ? ['all'] : [])];
            if (!allowed.includes(value as string)) err('trigger.scope', `must be ${allowed.join('|')}`);
          } else err(`trigger.${key}`, 'unsupported trigger field');
        }
    }
    const color = layer.color;
    if (cap.colorRequired && color == null) err('color', `${component} needs a color`);
    if (color != null) {
      if (!isRecord(color) || !cap.colorTypes.includes(color.type as string)) {
        err(
          'color.type',
          cap.colorTypes.length
            ? `${component} supports color ${cap.colorTypes.join('|')}`
            : `${component} takes no color`,
        );
        return;
      }
      for (const key of extra(color, ['type', ...(COLOR_FIELDS[color.type as string] ?? [])]))
        err(`color.${key}`, 'unknown color field');
      if (
        color.type === 'solid' &&
        !(Array.isArray(color.rgb) && color.rgb.length === 3 && color.rgb.every((v) => integer(v, 0, 255)))
      )
        err('color.rgb', 'must be integer RGB');
      const colors = color.colors;
      if (
        colors !== undefined &&
        !(
          Array.isArray(colors) &&
          colors.length >= 1 &&
          colors.length <= 32 &&
          colors.every(
            (rgb) => Array.isArray(rgb) && rgb.length === 3 && rgb.every((v) => integer(v, 0, 255)),
          )
        )
      )
        err('color.colors', 'must be 1..32 integer RGB');
      if (color.palette !== undefined && !['rainbow24', 'seven', 'custom'].includes(color.palette as string))
        err('color.palette', 'must be rainbow24|seven|custom');
      const count = Array.isArray(colors) ? colors.length : 0;
      if (color.palette === 'custom' && !count) err('color.colors', 'a custom palette needs colors');
      if (color.type === 'palette_index') {
        const size = color.palette === 'custom' ? count : color.palette === 'seven' ? 7 : 24;
        if (!integer(color.index ?? 0, 0, size - 1)) err('color.index', 'out of range');
      }
      if (color.type === 'hue_cycle')
        for (const [key, min, max, fallback] of [
          ['period_ms', 1, 65535, 3000],
          ['saturation', 0, 255, 255],
          ['value', 0, 255, 255],
        ] as const)
          if (!integer(color[key] ?? fallback, min, max)) err(`color.${key}`, `must be ${min}..${max}`);
      if (color.type === 'ramp') {
        if (color.axis !== undefined && !['x', 'y', 'radial'].includes(color.axis as string))
          err('color.axis', 'must be x|y|radial');
        for (const key of ['from', 'to'])
          if (color[key] !== undefined && !integer(color[key], 0, 1000))
            err(`color.${key}`, 'must be 0..1000');
        if (!count && !color.palette) err('color', 'a ramp needs colors or a palette');
      }
    }
    const surface = layer.surface;
    if (isRecord(surface)) {
      const fields = (
        { all: [], cells: ['cells'], regions: ['regions'], rows: ['rows'], cols: ['cols'] } as Record<
          string,
          string[]
        >
      )[surface.type as string];
      if (
        !fields ||
        extra(surface, ['type', 'invert', ...fields]).length ||
        (surface.invert !== undefined && typeof surface.invert !== 'boolean')
      )
        err('surface', 'invalid surface fields');
      for (const [key, max] of [
        ['rows', 5],
        ['cols', 21],
      ] as const) {
        const list = surface[key];
        if (list !== undefined && !(Array.isArray(list) && list.every((v) => integer(v, 0, max))))
          err(`surface.${key}`, `must be integers 0..${max}`);
      }
    }
    if (component === 'frame_sequence') {
      const frames = Array.isArray(layer.frames) ? layer.frames : null;
      totalFrames += frames?.length ?? 0;
      if (!frames || !frames.length || frames.length > 24) err('frames', 'needs 1..24 frames');
      for (const frame of frames ?? []) {
        if (
          !isRecord(frame) ||
          extra(frame, ['hold', 'points']).length ||
          !integer(frame.hold, 1, 65535) ||
          !Array.isArray(frame.points) ||
          frame.points.length > 48
        ) {
          err('frames', 'invalid frame');
          continue;
        }
        const limits = [5, 21, 255, 255, 255, 100];
        for (const p of frame.points)
          if (!Array.isArray(p) || p.length !== 6 || !p.every((v, j) => integer(v, 0, limits[j] as number)))
            err('frames', 'invalid frame point');
      }
      if (params.fps !== undefined || params.speed !== undefined)
        err('params', 'frame timing uses frames[].hold');
    }
  });
  if (totalFrames > 24)
    issues.push({ layer: null, field: 'layer', message: 'shared frame pool exceeds 24 frames' });
  return issues;
}
