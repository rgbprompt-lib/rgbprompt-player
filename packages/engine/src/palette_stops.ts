// Optional bounded knot positions in the component's existing 0..1000 scalar.
import type { ColorSpec, LayerDsl, Rgb } from './types.ts';

const STOP_COMPONENTS = new Set(['fire', 'rainbow_wave', 'spiral']);

export const hasPaletteStops = (layer: { color?: ColorSpec | null }): boolean =>
  !!layer.color && 'stops' in layer.color && layer.color.stops !== undefined;

function isRgb(value: unknown): value is Rgb {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255)
  );
}

export function paletteStopsErrors(layer: LayerDsl): string[] {
  if (!hasPaletteStops(layer)) return [];
  const c = layer.color;
  const p = layer.params ?? {};
  const errors: string[] = [];
  const supported =
    STOP_COMPONENTS.has(layer.component) || (layer.component === 'reactive' && p.color_mode === 'lifecycle');
  if (
    !supported ||
    !c ||
    c.type !== 'ramp' ||
    Object.keys(c).some((key) => !['type', 'colors', 'alphas', 'stops'].includes(key))
  )
    errors.push('stops require a supported custom component ramp');
  if (['rainbow_wave', 'spiral'].includes(layer.component) && p.palette !== 'custom')
    errors.push('stops require palette:custom');
  const colors = c && c.type === 'ramp' ? c.colors : undefined;
  const stops = c && c.type === 'ramp' ? c.stops : undefined;
  if (!Array.isArray(colors) || colors.length < 2 || colors.length > 32 || !colors.every(isRgb))
    errors.push('stops require 2..32 RGB colors');
  if (
    !Array.isArray(stops) ||
    stops.length !== colors?.length ||
    stops.some(
      (value, index) =>
        !Number.isInteger(value) ||
        value < 0 ||
        value > 1000 ||
        (index > 0 && value < (stops[index - 1] as number)),
    )
  )
    errors.push('stops must match colors, integer nondecreasing 0..1000');
  if (layer.component === 'rainbow_wave' && (p.wrap ?? 'seamless') !== 'reset')
    errors.push('explicit wave stops require wrap:reset');
  return errors;
}

export function stopInterval(stops: readonly number[], phase: number): [number, number, number, number] {
  const s = Math.max(0, Math.min(1000, phase));
  let i = 0;
  const first = stops[0] as number;
  if (s < first) return [0, 0, 0, 1];
  while (i + 1 < stops.length && s >= (stops[i + 1] as number)) i++;
  if (i === stops.length - 1) return [i, i, 0, 1];
  return [i, i + 1, s - (stops[i] as number), (stops[i + 1] as number) - (stops[i] as number)];
}

export function rampValues(values: readonly number[], stops: readonly number[], phase: number): number {
  const [i, j, t, span] = stopInterval(stops, phase);
  return Math.floor(
    ((values[i] as number) * (span - t) + (values[j] as number) * t + Math.floor(span / 2)) / span,
  );
}
