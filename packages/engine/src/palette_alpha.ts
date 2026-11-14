import { rampValues } from './palette_stops.ts';
import type { LayerDsl } from './types.ts';

// Optional coverage on the same scalar as a custom RGB palette.
export const RGBA_COLOR_TYPE = 7;

const ALPHA_COMPONENTS = new Set(['fire', 'rainbow_wave', 'spiral']);

export function paletteAlphaErrors(layer: LayerDsl): string[] {
  const c = layer.color;
  if (!c || c.type !== 'ramp' || c.alphas === undefined) return [];
  const p = layer.params ?? {};
  const supported =
    ALPHA_COMPONENTS.has(layer.component) || (layer.component === 'reactive' && p.color_mode === 'lifecycle');
  if (
    !supported ||
    Object.keys(c).some((key) => !['type', 'colors', 'alphas', 'stops'].includes(key)) ||
    (['rainbow_wave', 'spiral'].includes(layer.component) && p.palette !== 'custom') ||
    (layer.blend ?? 'replace') !== 'replace'
  )
    return [
      'color.alphas supports fire/custom rainbow_wave/custom spiral/reactive lifecycle ramps with replace blend only',
    ];
  if (
    !Array.isArray(c.colors) ||
    c.colors.length < 2 ||
    c.colors.length > 32 ||
    !c.colors.every(
      (rgb) =>
        Array.isArray(rgb) &&
        rgb.length === 3 &&
        rgb.every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255),
    ) ||
    !Array.isArray(c.alphas) ||
    c.alphas.length !== c.colors.length ||
    !c.alphas.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
  )
    return ['color.alphas must match 2..32 RGB colors, with integer coverage values 0..255'];
  return [];
}

export function rampAlpha(
  values: readonly number[] | undefined,
  phase: number,
  wrap = false,
  stops?: readonly number[],
): number {
  if (!values) return 255;
  if (stops) return rampValues(values, stops, phase);
  const n = values.length + (wrap ? 1 : 0);
  const pos = Math.max(0, Math.min(1000, phase)) * (n - 1);
  let i = Math.floor(pos / 1000);
  let t = pos - i * 1000;
  if (i >= n - 1) {
    i = n - 2;
    t = 1000;
  }
  return Math.floor(
    ((values[i % values.length] as number) * (1000 - t) +
      (values[(i + 1) % values.length] as number) * t +
      500) /
      1000,
  );
}
