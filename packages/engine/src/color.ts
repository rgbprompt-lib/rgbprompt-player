// Color sources and palettes. docs/04.
import { LOGIC_ROWS, LOGIC_COLS, NAMED_PALETTES } from './constants.ts';
import { hash32 } from './rng.ts';
import { isqrt, phaseS } from './timing.ts';
import { rampValues } from './palette_stops.ts';
import type { ColorContext, ColorSpec, Rgb } from './types.ts';

export function resolvePalette(name: string | undefined, customColors?: Rgb[]): Rgb[] {
  if (name === 'custom') {
    const arr = Array.isArray(customColors) ? customColors : [];
    return arr.length ? arr : [[255, 255, 255]];
  }
  // rainbow24 is always present in NAMED_PALETTES (constants.ts).
  return (name === undefined ? undefined : NAMED_PALETTES[name]) || (NAMED_PALETTES.rainbow24 as Rgb[]);
}

// integer linear interpolation, rounded (docs/04 §6)
export function lerpColor(a: Rgb, b: Rgb, t1000: number): Rgb {
  const inv = 1000 - t1000;
  return [
    Math.round((a[0] * inv + b[0] * t1000) / 1000),
    Math.round((a[1] * inv + b[1] * t1000) / 1000),
    Math.round((a[2] * inv + b[2] * t1000) / 1000),
  ];
}

export function rampColor(colors: Rgb[], s1000: number, stops?: readonly number[]): Rgb {
  if (stops) {
    return [0, 1, 2].map((channel) =>
      rampValues(
        colors.map((color) => color[channel] as number),
        stops,
        s1000,
      ),
    ) as Rgb;
  }
  const n = colors.length;
  if (n === 0) return [0, 0, 0];
  // n === 1 guarantees index 0; slice preserves the three channels.
  if (n === 1) return (colors[0] as Rgb).slice() as Rgb;
  const s = Math.max(0, Math.min(1000, s1000));
  const pos = s * (n - 1);
  let idx = Math.floor(pos / 1000);
  let t = pos - idx * 1000;
  if (idx >= n - 1) {
    idx = n - 2;
    t = 1000;
  }
  // idx is clamped to 0..n-2, so both lookups exist.
  return lerpColor(colors[idx] as Rgb, colors[idx + 1] as Rgb, t);
}

// spatial scalar in [0,1000] for a cell (docs/04 §3.2 axes).
// Integer-only and MUST match the reference axis_value exactly.
export function axisValue(row: number, col: number, axis: string): number {
  if (axis === 'y') return Math.floor((row * 1000 + 2) / (LOGIC_ROWS - 1));
  if (axis === 'radial') {
    const dr2 = 2 * row - (LOGIC_ROWS - 1);
    const dc2 = 2 * col - (LOGIC_COLS - 1);
    const d2 = isqrt(dr2 * dr2 + dc2 * dc2);
    const maxd2 = isqrt((LOGIC_ROWS - 1) * (LOGIC_ROWS - 1) + (LOGIC_COLS - 1) * (LOGIC_COLS - 1));
    return Math.floor((d2 * 1000 + Math.floor(maxd2 / 2)) / maxd2);
  }
  // default 'x'
  return Math.floor((col * 1000 + Math.floor((LOGIC_COLS - 1) / 2)) / (LOGIC_COLS - 1));
}

// HSV (hue 0..359, sat/val 0..255) -> RGB. Integer-only and MUST match
// the reference hsv_to_rgb exactly.
export function hsvToRgb(h: number, s: number, v: number): Rgb {
  h = ((h % 360) + 360) % 360;
  const region = Math.floor(h / 60); // 0..5
  const f = h - region * 60; // 0..59
  const p = Math.floor((v * (255 - s)) / 255);
  const q = Math.floor((v * (255 - Math.floor((s * f) / 60))) / 255);
  const t = Math.floor((v * (255 - Math.floor((s * (60 - f)) / 60))) / 255);
  switch (region) {
    case 0:
      return [v, t, p];
    case 1:
      return [q, v, p];
    case 2:
      return [p, v, t];
    case 3:
      return [p, q, v];
    case 4:
      return [t, p, v];
    default:
      return [v, p, q];
  }
}

// Resolve a color definition for a given cell.
// ctx: { row, col, tick, seed, layerSalt, inputValue (0..1000) }
export function resolveColor(color: ColorSpec | null | undefined, ctx: ColorContext): Rgb {
  if (!color) return [0, 0, 0];
  const type = color.type;
  switch (type) {
    case 'solid':
      // slice preserves the three channels; the fallback literal is an RGB triple.
      return (color.rgb || [0, 0, 0]).slice() as Rgb;
    case 'palette_index': {
      const pal = resolvePalette(color.palette, color.colors);
      const i = Math.max(0, Math.min(pal.length - 1, color.index ?? 0));
      // i is clamped to a valid palette index; slice preserves the three channels.
      return (pal[i] as Rgb).slice() as Rgb;
    }
    case 'ramp': {
      const pal =
        color.colors && color.colors.length ? color.colors : resolvePalette(color.palette, color.colors);
      let s = axisValue(ctx.row, ctx.col, color.axis || 'x');
      const from = color.from ?? 0;
      const to = color.to ?? 1000;
      // remap s (0..1000) into [from,to]
      s = from + Math.round((s * (to - from)) / 1000);
      return rampColor(pal, s, color.stops);
    }
    case 'hue_cycle': {
      const period = color.period_ms ?? 3000;
      const s = phaseS(ctx.tick, period, 0);
      const hue = Math.floor((s * 360) / 1000);
      return hsvToRgb(hue, color.saturation ?? 255, color.value ?? 255);
    }
    case 'random': {
      const pal = resolvePalette(color.palette, color.colors);
      const i = pal.length
        ? hash32(ctx.seed ?? 1, ctx.layerSalt ?? 0, ctx.row | 0, ctx.col | 0) % pal.length
        : 0;
      // i is either 0 or a valid palette index; slice preserves the three channels.
      return (pal[i] as Rgb).slice() as Rgb;
    }
    case 'from_input': {
      const pal = resolvePalette(color.palette, color.colors);
      return rampColor(pal, ctx.inputValue ?? 0);
    }
    default:
      return [0, 0, 0];
  }
}
