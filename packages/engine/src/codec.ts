import {
  audioContract,
  audioIssues,
  LEGACY_SPECTRUM_COUNT,
  usesExtendedSpectrum,
  usesV15Audio,
} from './audio/control.ts';
import { primitiveContract } from './execution.ts';
import {
  hasPlayback,
  playbackErrors,
  PLAY_START,
  PLAY_STOP,
  PLAY_RETRIGGER,
  PLAYBACK_TIME_FLAG,
} from './playback.ts';
import { hasPaletteStops } from './palette_stops.ts';
import { RGBA_COLOR_TYPE } from './palette_alpha.ts';
import { decodeAudio, encodeAudio } from './audio/wire.ts';
// Compact binary layer encoding shared with the reference interpreter.
// Layout is defined by data/schemas/param-layout.json (single source).
import layoutJson from '../data/schemas/param-layout.json' with { type: 'json' };
import { getComponent } from './registry.ts';
import { EASE_COMPONENTS } from './normalize.ts';
import { bakeEasing } from './timing.ts';
import { DRIFT_BREATH_PERIOD_MS } from './constants.ts';
import { utf8Bytes, utf8Decode } from './rng.ts';
import type {
  ColorSpec,
  DecodedLayer,
  FrameDsl,
  FramePoint,
  LayerParams,
  NormalizedLayer,
  Rgb,
} from './types.ts';

const LUT_SAMPLES = 33;

interface ParamLayout {
  enums: Record<string, Record<string, number>>;
  valueTypes: Record<string, string>;
  componentParams: Record<string, string[]>;
  componentIds: Record<string, number>;
  componentParamValueTypes: Record<string, Record<string, string>>;
  // Parameters appended after the base list when a layer uses them
  // (rainbow_wave 4|7|8, reactive 2|4, spiral 7|10).
  componentParamSuffix: Record<string, string[]>;
}

// Reason: JSON imports infer literal object shapes; the schema file is authoritative.
const layoutData = layoutJson as ParamLayout;

export function layout(): ParamLayout {
  return layoutData;
}

export function enumCode(enumName: string, value: unknown): number {
  // Reason: property access coerces the value to a string, as before.
  return layout().enums[enumName]?.[value as string] ?? 0;
}

export function enumName(enumName: string, code: number): string | null {
  const e = layout().enums[enumName];
  if (!e) return null;
  for (const [k, v] of Object.entries(e)) if (v === code) return k;
  return null;
}

const PAL_NAME = ['rainbow24', 'seven', 'custom'];
const RAMP_COLOR_TYPE = enumCode('colorType', 'ramp');
const NON_RAMP_CUSTOM_COLOR_TYPES = new Set([
  enumCode('colorType', 'palette_index'),
  enumCode('colorType', 'random'),
  enumCode('colorType', 'from_input'),
]);
const STOP_ALPHA_COLOR_TYPES = new Set([RGBA_COLOR_TYPE, 8, 9]);

function hasAlphas(layer: { color?: ColorSpec | null }): boolean {
  return !!layer.color && 'alphas' in layer.color && layer.color.alphas !== undefined;
}

function applyStopAlphaColorType(layer: NormalizedLayer, cf: ColorFields): void {
  if (hasAlphas(layer)) cf.colorType = RGBA_COLOR_TYPE;
  if (hasPaletteStops(layer)) cf.colorType = hasAlphas(layer) ? 9 : 8;
}

// A custom colour block follows the colour fields of a custom-palette ramp (and its
// alpha / stop forms), as upstream lepc writes it. Product documents may also give
// random and from_input colours a custom palette (palette id 2); the firmware export
// layer does not accept those, so firmware-bound bytes never carry that block.
const CUSTOM_PALETTE_COLOR_TYPES = new Set([
  enumCode('colorType', 'random'),
  enumCode('colorType', 'from_input'),
]);

function writesCustomColorBlock(fields: ColorFields): boolean {
  if (STOP_ALPHA_COLOR_TYPES.has(fields.colorType)) return true;
  if (fields.paletteId !== 2) return false;
  return fields.colorType === RAMP_COLOR_TYPE || CUSTOM_PALETTE_COLOR_TYPES.has(fields.colorType);
}

// Renderers that read a param from layer.time when the params blob is silent.
// Every other component reads its params only, so the encoder must not borrow
// a time field for those (drift is the important case: its motion period is
// independent of the breath-fade time.period_ms).
const TIME_PARAM_FALLBACKS: Record<string, Record<string, string>> = {
  breath: { period_ms: 'period_ms', min_level: 'min_level' },
  blink: { on_ms: 'on_ms', off_ms: 'off_ms', soft: 'soft' },
};

function resolveParam(layer: NormalizedLayer, key: string): unknown {
  if (layer.params && layer.params[key] !== undefined) return layer.params[key];
  const t = layer.time as Record<string, unknown> | undefined;
  const timeKey = TIME_PARAM_FALLBACKS[layer.component]?.[key];
  if (t && timeKey !== undefined && t[timeKey] !== undefined) return t[timeKey];
  const spec = getComponent(layer.component)?.params?.[key];
  if (spec && spec.default !== undefined) return spec.default;
  return 0;
}

const audioParamSuffix: Readonly<Record<string, string[]>> = {
  spectrum: ['attack_ms', 'release_ms', 'color_by_height'],
  spectrum_mirror: ['dense', 'peak_ms', 'full_range', 'attack_ms', 'release_ms', 'color_by_height'],
  spectrum_sum: ['attack_ms', 'release_ms'],
  key_ring: ['origin', 'envelope'],
  key_burst: ['origin'],
};
const ringOrigin = ['event_key', 'board_center', 'random_key'];
const ringEnvelope = ['fade_out', 'constant', 'fade_in', 'fade_in_out'];
function paramsFor(component: string, extended: boolean): string[] {
  return [
    ...(layout().componentParams[component] ?? []),
    ...(extended ? (audioParamSuffix[component] ?? layout().componentParamSuffix[component] ?? []) : []),
  ];
}
function wireType(key: string, component?: string | null): string {
  const own = component ? layout().componentParamValueTypes[component]?.[key] : undefined;
  if (own && key !== 'origin') return own;
  return ['full_range', 'color_by_height'].includes(key) ? 'bool' : (layout().valueTypes[key] ?? 'u16');
}

function encodeValue(key: string, value: unknown, component?: string): number {
  if (key === 'origin') return Math.max(0, ringOrigin.indexOf(String(value)));
  if (key === 'envelope') return Math.max(0, ringEnvelope.indexOf(String(value)));
  const vt = wireType(key, component);
  if (vt.startsWith('enum:')) return enumCode(vt.slice(5), value);
  if (vt === 'bool') return value ? 1 : 0;
  return Number(value) || 0;
}

// Ripple's direction has its own wire enum (horizontal 0, square 1), shared
// with the keyboard firmware. Older files wrote square as 2; it still decodes.
const encodeRippleDirection = (value: unknown) => (value === 'square' ? 1 : 0);
const decodeRippleDirection = (value: number) =>
  value === 1 || value === 2 ? 'square' : (enumName('direction', value) ?? 'horizontal');

function extendedKeyRingParams(layer: NormalizedLayer): boolean {
  if (layer.component !== 'key_ring') return false;
  const p = layer.params;
  const colorType = layer.color ? String(layer.color.type) : '';
  return (
    (p.origin ?? 'event_key') !== 'event_key' ||
    (p.envelope !== undefined && p.envelope !== 'fade_out') ||
    Number(p.max_radius ?? 4) > 8 ||
    colorType === 'ramp' ||
    (layer.playback?.start === 'audio_onset' &&
      ((p.origin ?? 'event_key') === 'board_center' ||
        (p.envelope !== undefined && p.envelope !== 'fade_out') ||
        Number(p.max_radius ?? 4) > 8 ||
        colorType === 'ramp'))
  );
}

/** Wave geometry beyond the four legacy parameters (x or y axis, full width, seamless). */
export function waveParamCount(layer: { component: string; params?: LayerParams | null }): 4 | 7 | 8 {
  const p = layer.params ?? {};
  if (layer.component !== 'rainbow_wave') return 4;
  if (p.axis === 'angle') return 8;
  // Upstream: geometry at its defaults (uniform included) stays at four parameters.
  return Number(p.width_pct ?? 100) !== 100 ||
    (p.wrap ?? 'seamless') !== 'seamless' ||
    (p.spatial_direction ?? 'forward') !== 'forward'
    ? 7
    : 4;
}
export const isReactiveLifecycle = (layer: { component: string; params?: LayerParams | null }) =>
  layer.component === 'reactive' && layer.params?.color_mode === 'lifecycle';
// Upstream spiral_color.js: a custom palette (ramp) is extended too, so it carries 10 params.
export const extendedSpiral = (layer: {
  component: string;
  params?: LayerParams | null;
  color?: ColorSpec | null;
}) =>
  layer.component === 'spiral' &&
  (Number(layer.params?.color_twist ?? 500) !== 500 ||
    Number(layer.params?.center_x ?? 500) !== 500 ||
    Number(layer.params?.center_y ?? 500) !== 500 ||
    layer.params?.palette === 'custom' ||
    layer.color?.type === 'ramp');

/**
 * Lowest package version that carries a layer's ported upstream feature, or 0
 * when the layer needs none. The numbers follow the upstream toolchain.
 */
export function featurePackageVersion(layer: NormalizedLayer): number {
  const p = layer.params ?? {};
  if (layer.component === 'key_ring' && extendedKeyRingParams(layer)) return 13;
  if (hasPlayback(layer) || (layer.component === 'rainbow_wave' && p.axis === 'uniform')) return 11;
  if (layer.component === 'rainbow_wave') {
    if (p.spatial_direction === 'mirror' || p.spatial_direction === 'mirror_reverse') return 10;
    if (hasPaletteStops(layer) || p.axis === 'angle') return 9;
    if (waveParamCount(layer) === 7) return 3;
  }
  if (hasPaletteStops(layer)) return 9;
  if (extendedSpiral(layer)) return 7;
  if (isReactiveLifecycle(layer)) return 6;
  if (layer.color && 'alphas' in layer.color && layer.color.alphas !== undefined) return 5;
  if (layer.component === 'fire') return 4;
  return 0;
}

export function compileParams(layer: NormalizedLayer): number[] {
  const p = layer.params;
  // key_burst: optional 9th origin only when random_key (default board_center keeps 8 params / goldens).
  const burstOrigin = layer.component === 'key_burst' && p.origin === 'random_key';
  const values = paramsFor(
    layer.component,
    extendedKeyRingParams(layer) ||
      burstOrigin ||
      usesExtendedSpectrum(layer) ||
      waveParamCount(layer) > 4 ||
      isReactiveLifecycle(layer) ||
      extendedSpiral(layer),
  ).map((k) =>
    layer.component === 'ripple' && k === 'direction'
      ? encodeRippleDirection(resolveParam(layer, k))
      : encodeValue(k, resolveParam(layer, k), layer.component),
  );
  if (layer.component === 'rainbow_wave') return values.slice(0, waveParamCount(layer));
  // Sparkle is always time-based here; the 4th parameter (clock = time) makes
  // the keyboard run the same cadence-independent scheduler.
  if (layer.component === 'sparkle') values.push(SPARKLE_CLOCK_TIME);
  return values;
}
const SPARKLE_CLOCK_TIME = 1;

interface ColorFields {
  colorType: number;
  a: number;
  b: number;
  c: number;
  paletteId: number;
  axis: number;
  from: number;
  to: number;
  customColors: Rgb[] | null;
}

function colorFields(color: ColorSpec | null): ColorFields {
  const out: ColorFields = {
    colorType: 0,
    a: 0,
    b: 0,
    c: 0,
    paletteId: 0,
    axis: 0,
    from: 0,
    to: 0,
    customColors: null,
  };
  if (!color) return out;
  const ct = color.type;
  // Reason: only the optional palette field is read; non-object colours yield undefined as before.
  const palette = (color as { palette?: string }).palette;
  const pal = PAL_NAME.indexOf(palette || 'rainbow24');
  switch (ct) {
    case 'solid':
      out.colorType = enumCode('colorType', 'solid');
      out.a = color.rgb?.[0] ?? 0;
      out.b = color.rgb?.[1] ?? 0;
      out.c = color.rgb?.[2] ?? 0;
      break;
    case 'palette_index':
      out.colorType = enumCode('colorType', 'palette_index');
      out.paletteId = pal < 0 ? 0 : pal;
      out.a = color.index ?? 0;
      if (color.colors && color.colors.length) out.customColors = color.colors;
      break;
    case 'ramp':
      out.colorType = enumCode('colorType', 'ramp');
      out.axis = enumCode('axis', color.axis || 'x');
      out.from = color.from ?? 0;
      out.to = color.to ?? 1000;
      if (color.colors && color.colors.length) {
        out.paletteId = 2;
        out.customColors = color.colors;
      } else {
        out.paletteId = pal < 0 ? 0 : pal;
      }
      break;
    case 'hue_cycle':
      out.colorType = enumCode('colorType', 'hue_cycle');
      out.a = color.saturation ?? 255;
      out.b = color.value ?? 255;
      out.from = color.period_ms ?? 3000;
      break;
    case 'random':
      out.colorType = enumCode('colorType', 'random');
      out.paletteId = pal < 0 ? 0 : pal;
      if (color.colors && color.colors.length) out.customColors = color.colors;
      break;
    case 'from_input':
      out.colorType = enumCode('colorType', 'from_input');
      out.paletteId = pal < 0 ? 0 : pal;
      out.a = enumCode('source', color.source || 'key_press');
      if (color.colors && color.colors.length) out.customColors = color.colors;
      break;
    default:
      break;
  }
  return out;
}

function decodeColor(
  fields: ColorFields,
  customColors: Rgb[] | null,
  extras?: { alphas?: number[]; stops?: number[] },
): ColorSpec | null {
  const t = STOP_ALPHA_COLOR_TYPES.has(fields.colorType) ? 'ramp' : enumName('colorType', fields.colorType);
  switch (t) {
    case 'solid':
      return { type: 'solid', rgb: [fields.a, fields.b, fields.c] };
    case 'palette_index': {
      const spec: Extract<ColorSpec, { type: 'palette_index' }> = {
        type: 'palette_index',
        palette: PAL_NAME[fields.paletteId] || 'rainbow24',
        index: fields.a,
      };
      if (customColors && customColors.length) spec.colors = customColors;
      return spec;
    }
    case 'ramp': {
      const base: Extract<ColorSpec, { type: 'ramp' }> = {
        type: 'ramp',
        axis: enumName('axis', fields.axis) || 'x',
        from: fields.from,
        to: fields.to,
      };
      if (fields.paletteId === 2 && customColors && customColors.length) base.colors = customColors;
      else base.palette = PAL_NAME[fields.paletteId] || 'rainbow24';
      if (extras?.stops) base.stops = extras.stops;
      if (extras?.alphas) base.alphas = extras.alphas;
      return base;
    }
    case 'hue_cycle':
      return { type: 'hue_cycle', saturation: fields.a, value: fields.b, period_ms: fields.from };
    case 'random': {
      const spec: Extract<ColorSpec, { type: 'random' }> = {
        type: 'random',
        palette: PAL_NAME[fields.paletteId] || 'rainbow24',
      };
      if (customColors && customColors.length) spec.colors = customColors;
      return spec;
    }
    case 'from_input': {
      const spec: Extract<ColorSpec, { type: 'from_input' }> = {
        type: 'from_input',
        palette: PAL_NAME[fields.paletteId] || 'rainbow24',
        source: enumName('source', fields.a) || 'key_press',
      };
      if (customColors && customColors.length) spec.colors = customColors;
      return spec;
    }
    default:
      return null;
  }
}

function decodeParams(component: string | null, raw: number[], extended = false): LayerParams {
  const keys = component ? paramsFor(component, extended) : [];
  const obj: LayerParams = {};
  keys.forEach((k, i) => {
    const vt = wireType(k, component);
    let v: unknown = raw[i] ?? 0;
    if (component === 'ripple' && k === 'direction') v = decodeRippleDirection(Number(v));
    else if (k === 'origin') v = ringOrigin[Number(v)] ?? v;
    else if (k === 'envelope') v = ringEnvelope[Number(v)] ?? v;
    else if (vt.startsWith('enum:')) v = enumName(vt.slice(5), Number(v)) ?? v;
    else if (vt === 'bool') v = !!v;
    obj[k] = v;
  });
  return obj;
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  let size = 0;
  for (const part of parts) size += part.length;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function byteView(buf: Uint8Array): DataView {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
}

export function readByte(view: DataView, offset: number): number {
  if (offset < 0 || offset + 1 > view.byteLength) {
    throw new RangeError(
      `The value of "offset" is out of range. It must be >= 0 and <= ${view.byteLength - 1}. Received ${offset}`,
    );
  }
  return view.getUint8(offset);
}

export function readUint16LE(view: DataView, offset: number): number {
  if (offset < 0 || offset + 2 > view.byteLength) {
    throw new RangeError(
      `The value of "offset" is out of range. It must be >= 0 and <= ${view.byteLength - 2}. Received ${offset}`,
    );
  }
  return view.getUint16(offset, true);
}

export function readUint32LE(view: DataView, offset: number): number {
  if (offset < 0 || offset + 4 > view.byteLength) {
    throw new RangeError(
      `The value of "offset" is out of range. It must be >= 0 and <= ${view.byteLength - 4}. Received ${offset}`,
    );
  }
  return view.getUint32(offset, true);
}

// ---- binary layer record ---------------------------------------------------
const FRAME_SEQUENCE_ID = 32;

export interface DecodedLayerResult {
  layer: DecodedLayer;
  offset: number;
}

// v3 adds the `square` direction and a custom-colour block for the non-ramp
// colour types that read `colors`. Files without either stay on v2.
/** v14 audio extension or its v15 superset. */
export const isAudioPackage = (pkgVersion: number) =>
  pkgVersion === audioContract.package_version || pkgVersion === audioContract.extended_package_version;

export function layerRequiresV3(layer: NormalizedLayer): boolean {
  const keys = layout().componentParams[layer.component] || [];
  if (keys.includes('direction') && resolveParam(layer, 'direction') === 'square') return true;
  if (layer.time?.direction === 'square') return true;
  const cf = colorFields(layer.color);
  return cf.customColors !== null && NON_RAMP_CUSTOM_COLOR_TYPES.has(cf.colorType);
}

export function encodeLayer(layer: NormalizedLayer, pkgVersion: number): Uint8Array {
  const params = compileParams(layer);
  const sharedPlayback = hasPlayback(layer);
  const hasAudio = layer.audio_mod !== undefined || layer.playback?.start === 'audio_onset';
  const modern = isAudioPackage(pkgVersion);
  if (modern) {
    const issues = audioIssues(layer);
    if (issues.length) throw new Error(issues.join('; '));
  }
  const cf = colorFields(layer.color);
  applyStopAlphaColorType(layer, cf);
  if (modern && layer.component === 'key_ring' && cf.colorType === RAMP_COLOR_TYPE)
    cf.paletteId = params[3] ?? 0;
  const name = new Uint8Array(utf8Bytes(layer.id || ''));
  const custom = cf.customColors || [];
  const parts: Uint8Array[] = [];

  const head = new Uint8Array(1 + name.length);
  head[0] = name.length;
  head.set(name, 1);
  parts.push(head);
  parts.push(
    new Uint8Array([
      layout().componentIds[layer.component] ?? 0,
      enumCode('blend', layer.blend || 'replace'),
      layer.opacity ?? 255,
    ]),
  );
  parts.push(new Uint8Array(layer.mask.map((x) => x & 0xff)));
  parts.push(new Uint8Array([cf.colorType, cf.a, cf.b, cf.c, cf.paletteId, cf.axis]));
  const ft = new Uint8Array(4);
  const ftView = new DataView(ft.buffer);
  ftView.setUint16(0, cf.from, true);
  ftView.setUint16(2, cf.to, true);
  parts.push(ft);
  parts.push(
    new Uint8Array([
      enumCode('timeType', layer.time?.type || 'static') |
        (sharedPlayback ? PLAYBACK_TIME_FLAG : 0) |
        (hasAudio ? audioContract.time_flag : 0),
    ]),
  );
  const tt = new Uint8Array(4);
  const ttView = new DataView(tt.buffer);
  const timePeriod =
    layer.component === 'drift' && (layer.time?.type || 'static') === 'breath'
      ? (layer.time?.period_ms ?? DRIFT_BREATH_PERIOD_MS)
      : (layer.time?.period_ms ?? 0);
  ttView.setUint16(0, timePeriod, true);
  ttView.setUint16(
    2,
    layer.component === 'rain' ? (layer.time?.min_level ?? 23) : (layer.time?.phase_ms ?? 0),
    true,
  );
  parts.push(tt);
  parts.push(
    new Uint8Array([
      // Playback layers: the easing byte is reserved and must be 0 (upstream lepc and
      // the firmware reject anything else). breath / blink carry their curve in the
      // LUT below, and decodeLayer recovers the easing from it.
      sharedPlayback ? 0 : enumCode('easing', layer.time?.easing || 'sine'),
      enumCode('direction', layer.time?.direction || 'forward'),
      enumCode(
        'trigger',
        modern && LEGACY_SPECTRUM_COUNT[layer.component]
          ? 'audio'
          : modern && ['key_ring', 'key_burst'].includes(layer.component)
            ? 'key_press'
            : layer.trigger?.type || 'always',
      ),
    ]),
  );
  const ta = new Uint8Array(2);
  const taView = new DataView(ta.buffer);
  // composable-v1: the trigger argument is the input scope (1 = the layer's own surface).
  taView.setUint16(0, layer.trigger?.scope === 'surface' ? 1 : 0, true);
  parts.push(ta);
  parts.push(new Uint8Array([params.length]));
  const pb = new Uint8Array(params.length * 2);
  const pbView = new DataView(pb.buffer);
  params.forEach((v, i) => pbView.setUint16(i * 2, v & 0xffff, true));
  parts.push(pb);
  if (sharedPlayback) {
    const p = layer.playback;
    if (!p || p.start === 'audio_onset') throw new Error('shared playback required');
    const ext = new Uint8Array(30);
    const extView = new DataView(ext.buffer);
    ext[0] = PLAY_START[p.start ?? 'auto'];
    ext[1] = PLAY_STOP[p.stop ?? 'natural'];
    ext[2] = PLAY_RETRIGGER[p.retrigger ?? 'restart'];
    ext[3] = p.cycles ?? 1;
    extView.setUint16(4, p.duration_ms ?? 0, true);
    extView.setUint16(6, p.pause_ms ?? 0, true);
    if (!Array.isArray(p.inputMask) || p.inputMask.length !== 22) {
      throw new Error('normalized playback input mask required');
    }
    p.inputMask.forEach((v, i) => {
      ext[8 + i] = v & 0xff;
    });
    parts.push(ext);
  }
  if (hasAudio) {
    const audioFields: {
      audio_mod?: typeof layer.audio_mod;
      playback?: Extract<typeof layer.playback, { start: 'audio_onset' }>;
    } = {};
    if (layer.audio_mod !== undefined) audioFields.audio_mod = layer.audio_mod;
    if (layer.playback?.start === 'audio_onset') audioFields.playback = layer.playback;
    parts.push(encodeAudio(audioFields));
  }

  // Upstream lepc / firmware: a reactive lifecycle layer carries no easing LUT.
  if (EASE_COMPONENTS.has(layer.component) && !isReactiveLifecycle(layer)) {
    const lut = layer.lut || new Array<number>(LUT_SAMPLES).fill(0);
    const lb = new Uint8Array(LUT_SAMPLES * 2);
    const lbView = new DataView(lb.buffer);
    // Reason: the LUT always holds LUT_SAMPLES entries.
    for (let i = 0; i < LUT_SAMPLES; i++) lbView.setUint16(i * 2, (lut[i] as number) | 0, true);
    parts.push(lb);
  }

  const writeCustomBlock = writesCustomColorBlock(cf);
  if (writeCustomBlock) {
    const cb = new Uint8Array(1 + custom.length * 3);
    cb[0] = custom.length;
    custom.forEach((c, i) => {
      cb[1 + i * 3] = c[0];
      cb[2 + i * 3] = c[1];
      cb[3 + i * 3] = c[2];
    });
    parts.push(cb);
    if (cf.colorType === RGBA_COLOR_TYPE || cf.colorType === 9) {
      const alphas = layer.color && 'alphas' in layer.color ? layer.color.alphas : undefined;
      if (!alphas || alphas.length !== custom.length) throw new Error('invalid alpha palette count');
      parts.push(new Uint8Array(alphas.map((v) => v & 0xff)));
    }
    if (hasPaletteStops(layer)) {
      const stops = layer.color && 'stops' in layer.color ? layer.color.stops : undefined;
      if (!stops || stops.length !== custom.length) throw new Error('invalid palette stops count');
      const sb = new Uint8Array(stops.length * 2);
      const sbView = new DataView(sb.buffer);
      stops.forEach((v, i) => sbView.setUint16(i * 2, v & 0xffff, true));
      parts.push(sb);
    }
  }
  if ((layout().componentIds[layer.component] ?? 0) === FRAME_SEQUENCE_ID) {
    const frames = layer.frames || [];
    parts.push(new Uint8Array([frames.length & 0xff]));
    for (const f of frames) {
      const pts = f.points || [];
      const fb = new Uint8Array(4);
      const fbView = new DataView(fb.buffer);
      fbView.setUint16(0, Math.max(1, f.hold || 1) & 0xffff, true);
      fbView.setUint16(2, pts.length & 0xffff, true);
      parts.push(fb);
      for (const p of pts)
        parts.push(
          new Uint8Array([p[0] & 0xff, p[1] & 0xff, p[2] & 0xff, p[3] & 0xff, p[4] & 0xff, p[5] & 0xff]),
        );
    }
  }
  return concatBytes(parts);
}

export function decodeLayer(buf: Uint8Array, offset: number, pkgVersion: number): DecodedLayerResult {
  const view = byteView(buf);
  let o = offset;
  const nameLen = readByte(view, o);
  o += 1;
  const name = utf8Decode(buf.subarray(o, o + nameLen));
  o += nameLen;
  const componentId = readByte(view, o);
  o += 1;
  const blend = enumName('blend', readByte(view, o)) || 'replace';
  o += 1;
  const opacity = readByte(view, o);
  o += 1;
  const mask: number[] = [];
  for (let i = 0; i < 22; i++) mask.push(readByte(view, o++));
  const fields: ColorFields = {
    colorType: 0,
    a: 0,
    b: 0,
    c: 0,
    paletteId: 0,
    axis: 0,
    from: 0,
    to: 0,
    customColors: null,
  };
  fields.colorType = readByte(view, o++);
  fields.a = readByte(view, o++);
  fields.b = readByte(view, o++);
  fields.c = readByte(view, o++);
  fields.paletteId = readByte(view, o++);
  fields.axis = readByte(view, o++);
  fields.from = readUint16LE(view, o);
  o += 2;
  fields.to = readUint16LE(view, o);
  o += 2;
  const rawTime = readByte(view, o++);
  const audioFlag = !!(rawTime & audioContract.time_flag);
  const encodedPlayback = !!(rawTime & PLAYBACK_TIME_FLAG);
  const modern = isAudioPackage(pkgVersion);
  if ((audioFlag && !modern) || (modern && rawTime & ~(audioContract.time_flag | PLAYBACK_TIME_FLAG | 7)))
    throw new Error('unsupported layer time extension');
  const timeType =
    enumName('timeType', rawTime & ~(audioContract.time_flag | PLAYBACK_TIME_FLAG)) || 'static';
  const period = readUint16LE(view, o);
  o += 2;
  const phase = readUint16LE(view, o);
  o += 2;
  const easing = enumName('easing', readByte(view, o)) || 'sine';
  o += 1;
  const direction = enumName('direction', readByte(view, o)) || 'forward';
  o += 1;
  const trigger = enumName('trigger', readByte(view, o)) || 'always';
  o += 1;
  const trigArg = readUint16LE(view, o);
  o += 2;
  const paramCount = readByte(view, o);
  o += 1;
  const paramsRaw: number[] = [];
  for (let i = 0; i < paramCount; i++) {
    paramsRaw.push(readUint16LE(view, o));
    o += 2;
  }
  const componentNameEarly =
    Object.keys(layout().componentIds).find((k) => layout().componentIds[k] === componentId) || null;
  const baseCount = componentNameEarly ? (layout().componentParams[componentNameEarly]?.length ?? 0) : 0;
  const extended = paramCount > baseCount;
  const suffixed = !!componentNameEarly && !!layout().componentParamSuffix[componentNameEarly];
  if (suffixed) {
    const full = paramsFor(componentNameEarly, true).length;
    const allowed = componentNameEarly === 'rainbow_wave' ? [baseCount, 7, 8] : [baseCount, full];
    if (!allowed.includes(paramCount)) throw new Error(`invalid ${componentNameEarly} parameter count`);
  }
  if (componentNameEarly === 'key_ring' && !modern && extended && pkgVersion !== 13)
    throw new Error('unsupported ring extension');
  const params = decodeParams(
    componentNameEarly,
    paramsRaw,
    extended && (modern || suffixed || componentNameEarly === 'key_ring'),
  );
  if (componentNameEarly === 'rainbow_wave' && paramCount < 8) delete params.angle_deg;
  const startNames = Object.keys(PLAY_START);
  const stopNames = Object.keys(PLAY_STOP);
  const retriggerNames = Object.keys(PLAY_RETRIGGER);
  let playback: NormalizedLayer['playback'] | undefined;
  if (encodedPlayback) {
    if (o + 30 > buf.length) throw new Error('truncated playback extension');
    const start = startNames[readByte(view, o)];
    const stop = stopNames[readByte(view, o + 1)];
    const retrigger = retriggerNames[readByte(view, o + 2)];
    const cycles = readByte(view, o + 3);
    if (!start || !stop || !retrigger) throw new Error('invalid playback header');
    playback = {
      start: start as keyof typeof PLAY_START,
      stop: stop as keyof typeof PLAY_STOP,
      retrigger: retrigger as keyof typeof PLAY_RETRIGGER,
      cycles,
      duration_ms: readUint16LE(view, o + 4),
      pause_ms: readUint16LE(view, o + 6),
      inputMask: Array.from(buf.subarray(o + 8, o + 30)),
    };
    o += 30;
    const errors = playbackErrors({
      id: name,
      component: componentNameEarly ?? 'static',
      surface: { type: 'all' },
      params: decodeParams(componentNameEarly ?? 'static', paramsRaw),
      mask,
      cells: [],
      playback,
      time: { type: 'static', ...(phase ? { phase_ms: phase } : {}) },
      trigger: { type: 'always' },
    });
    if (errors.length) throw new Error(errors.join('; '));
  }
  const audio = audioFlag
    ? decodeAudio(view, o, pkgVersion === audioContract.extended_package_version)
    : null;
  if (audio) o = audio.offset;
  const oldCount = componentNameEarly ? LEGACY_SPECTRUM_COUNT[componentNameEarly] : undefined;
  if (oldCount !== undefined && paramCount > oldCount) {
    const keys = paramsFor(componentNameEarly as string, true);
    if (
      !modern ||
      paramCount !== keys.length ||
      keys.some((key, i) => wireType(key) === 'bool' && (paramsRaw[i] ?? 0) > 1)
    )
      throw new Error('invalid extended spectrum params');
  }
  if (modern && componentNameEarly && !oldCount) {
    // key_ring: optional origin+envelope (6|8). key_burst: optional origin (8|9) when random_key.
    const nativeCount =
      paramsFor(componentNameEarly, componentNameEarly === 'key_ring' || componentNameEarly === 'key_burst')
        .length + (componentNameEarly === 'sparkle' ? 1 : 0);
    const suffixCount = layout().componentParamSuffix[componentNameEarly]?.length ?? 0;
    if (
      paramCount > nativeCount + suffixCount ||
      (componentNameEarly === 'key_ring' && paramCount !== 6 && paramCount !== 8) ||
      (componentNameEarly === 'key_burst' && paramCount !== 8 && paramCount !== 9)
    )
      throw new Error('unsupported component parameter layout');
  }
  let lut: number[] | null = null;
  // Upstream: a reactive layer with 4 params is lifecycle and has no LUT.
  const lifecycleLayout = componentNameEarly === 'reactive' && paramCount === 4;
  if (componentNameEarly && EASE_COMPONENTS.has(componentNameEarly) && !lifecycleLayout) {
    lut = [];
    for (let i = 0; i < LUT_SAMPLES; i++) {
      lut.push(readUint16LE(view, o));
      o += 2;
    }
  }
  let customColors: Rgb[] | null = null;
  let customAlphas: number[] | undefined;
  let customStops: number[] | undefined;
  const hasCustomBlock = writesCustomColorBlock(fields);
  if (hasCustomBlock) {
    const n = readByte(view, o);
    o += 1;
    customColors = [];
    for (let i = 0; i < n; i++) {
      customColors.push([readByte(view, o), readByte(view, o + 1), readByte(view, o + 2)]);
      o += 3;
    }
    if (fields.colorType === RGBA_COLOR_TYPE || fields.colorType === 9) {
      customAlphas = [];
      for (let i = 0; i < n; i++) customAlphas.push(readByte(view, o++));
    }
    if (fields.colorType === 8 || fields.colorType === 9) {
      customStops = [];
      for (let i = 0; i < n; i++) {
        customStops.push(readUint16LE(view, o));
        o += 2;
      }
    }
  }
  if (componentNameEarly === 'rain' && (paramCount !== 8 || !customColors || customColors.length !== 5)) {
    throw new Error('rain requires 8 parameters and 5 RGB colors');
  }
  let frames: FrameDsl[] | null = null;
  if (componentId === FRAME_SEQUENCE_ID) {
    const fc = readByte(view, o);
    o += 1;
    frames = [];
    for (let i = 0; i < fc; i++) {
      const hold = readUint16LE(view, o);
      o += 2;
      const pc = readUint16LE(view, o);
      o += 2;
      const points: FramePoint[] = [];
      for (let j = 0; j < pc; j++) {
        points.push([
          readByte(view, o),
          readByte(view, o + 1),
          readByte(view, o + 2),
          readByte(view, o + 3),
          readByte(view, o + 4),
          readByte(view, o + 5),
        ]);
        o += 6;
      }
      frames.push({ hold, points });
    }
  }
  const colorExtras: { alphas?: number[]; stops?: number[] } = {};
  if (customAlphas) colorExtras.alphas = customAlphas;
  if (customStops) colorExtras.stops = customStops;
  const color = decodeColor(fields, customColors, colorExtras);

  if (modern && componentNameEarly) {
    const audioLayer = { component: componentNameEarly, params, color, ...audio?.fields };
    const issues = audioIssues(audioLayer);
    if (pkgVersion !== audioContract.extended_package_version && usesV15Audio(audioLayer))
      throw new Error('layer requires package version 15');
    if (oldCount !== undefined && extended && !usesExtendedSpectrum(audioLayer))
      throw new Error('unused spectrum extension');
    if (
      componentNameEarly === 'key_ring' &&
      extended &&
      (Number(paramsRaw[6] ?? 0) > 2 || Number(paramsRaw[7] ?? 0) > 3)
    )
      throw new Error('unsupported ring extension');
    if (issues.length) throw new Error(issues.join('; '));
  }
  // composable-v1 trigger argument: the input scope of a selectable key layer, else 0.
  const selectable =
    primitiveContract(componentNameEarly)?.inputScope === 'selectable' &&
    !(componentNameEarly === 'reactive' && (params as Record<string, unknown>).color_mode === 'lifecycle');
  if (trigArg > (selectable ? 1 : 0)) throw new Error('invalid trigger argument');
  const decodedTrigger = selectable
    ? { type: trigger, scope: trigArg ? 'surface' : 'all' }
    : { type: trigger };
  // Playback layers write a reserved 0 easing byte; the real curve is the LUT.
  const decodedEasing = encodedPlayback ? easingFromLut(componentNameEarly, lut) : easing;
  return {
    layer: {
      id: name,
      component: componentNameEarly,
      blend,
      opacity,
      mask,
      color,
      ...(playback ? { playback } : {}),
      ...audio?.fields,
      time: {
        type: timeType,
        period_ms: period,
        ...(componentNameEarly === 'rain' ? { min_level: phase } : { phase_ms: phase }),
        ...(decodedEasing !== undefined ? { easing: decodedEasing } : {}),
        direction,
      },
      trigger: decodedTrigger,
      params,
      frames,
      lut,
    },
    offset: o,
  };
}

const EASING_PRESETS = ['sine', 'linear', 'pulse'] as const;

/**
 * Easing of a playback layer, recovered from its baked LUT: a preset name when
 * the LUT is that preset's bake, otherwise the LUT itself. Undefined when the
 * component has no easing curve (the reserved byte carries nothing).
 */
export function easingFromLut(
  component: string | null,
  lut: readonly number[] | null,
): string | { lut: number[] } | undefined {
  if (!component || !EASE_COMPONENTS.has(component) || !lut) return undefined;
  for (const name of EASING_PRESETS) {
    const baked = bakeEasing(name);
    if (baked.length === lut.length && baked.every((v, i) => v === lut[i])) return name;
  }
  return { lut: [...lut] };
}

export { PAL_NAME };
