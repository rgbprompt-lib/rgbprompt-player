// Shared deterministic timing/math helpers. MUST match the reference engine
// exactly. docs/07.

import type { EasingSpec } from './types.ts';

// integer cosine table: round(1000*cos(2*pi*i/64)), i=0..64
export const COS1000: number[] = [];
for (let i = 0; i <= 64; i++) COS1000.push(Math.round(1000 * Math.cos((2 * Math.PI * i) / 64)));

export function cosAt(s1000: number): number {
  const s = s1000 < 0 ? 0 : s1000 > 1000 ? 1000 : s1000;
  const idx = Math.min(64, Math.round((s * 64) / 1000));
  // s is clamped to 0..1000, so idx is an integer in 0..64 and the table has 65 entries.
  return COS1000[idx] as number;
}
export function tri01(s1000: number): number {
  const s = s1000 < 0 ? 0 : s1000 > 1000 ? 1000 : s1000;
  return s < 500 ? s * 2 : (1000 - s) * 2;
}
export function sine01(s1000: number): number {
  return Math.round((1000 - cosAt(s1000)) / 2);
}
export function pulse01(s1000: number): number {
  const t = tri01(s1000);
  return Math.floor((t * t) / 1000);
}
export function shape01(easing: string, s1000: number): number {
  if (easing === 'linear') return tri01(s1000);
  if (easing === 'pulse') return pulse01(s1000);
  return sine01(s1000);
}

// normalized phase in 0..1000 for a tick and period (ms)
export function phaseS(tick: number, periodMs: number, phaseMs = 0): number {
  const period = periodMs > 0 ? periodMs : 1000;
  const p = (((tick + phaseMs) % period) + period) % period;
  return Math.floor((p * 1000) / period);
}

// ---- easing curves ---------------------------------------------------------
// E: [0,1] -> [0,1], monotonic (CSS-like). Baked to an integer LUT at compile
// time so the engine only does linear interpolation (deterministic, no float).
export const EASE_PRESETS = ['linear', 'sine', 'pulse', 'ease-in', 'ease-out', 'ease-in-out'] as const;

function bezierY(x1: number, y1: number, x2: number, y2: number, x: number): number {
  const cx = (t: number): number => 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t;
  const cy = (t: number): number => 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t;
  let lo = 0,
    hi = 1,
    t = x;
  for (let i = 0; i < 28; i++) {
    const xx = cx(t);
    if (xx < x) lo = t;
    else hi = t;
    t = (lo + hi) / 2;
  }
  return cy(t);
}

export function easeFn(spec: EasingSpec): (p: number) => number {
  if (!spec || spec === 'linear') return (p) => p;
  if (spec === 'sine') return (p) => (1 - Math.cos(Math.PI * p)) / 2;
  if (spec === 'pulse') return (p) => p * p;
  if (spec === 'ease-in') return (p) => p * p * p;
  if (spec === 'ease-out') return (p) => 1 - Math.pow(1 - p, 3);
  if (spec === 'ease-in-out') return (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
  if (spec && typeof spec === 'object' && Array.isArray(spec.bezier)) {
    // The effect schema requires exactly four control values.
    const [x1, y1, x2, y2] = spec.bezier.map(Number) as [number, number, number, number];
    return (p) => bezierY(x1, y1, x2, y2, p);
  }
  if (spec && typeof spec === 'object' && Array.isArray(spec.lut)) {
    return (p) => easeAt(spec.lut, Math.round(p * 1000)) / 1000;
  }
  return (p) => p;
}

// sample E into a fixed-length integer LUT (0..1000). A {lut:[...]} spec is
// resampled (used to import a .lep back losslessly: only the baked curve is
// stored, not the original bezier control points).
export function bakeEasing(spec: EasingSpec, samples = 33): number[] {
  if (spec && typeof spec === 'object' && Array.isArray(spec.lut)) {
    if (spec.lut.length === samples) return spec.lut.slice(); // lossless (imported curve)
    const out = new Array<number>(samples);
    for (let i = 0; i < samples; i++)
      out[i] = Math.max(0, Math.min(1000, easeAt(spec.lut, Math.round((i / (samples - 1)) * 1000))));
    return out;
  }
  const E = easeFn(spec);
  const out = new Array<number>(samples);
  for (let i = 0; i < samples; i++)
    out[i] = Math.max(0, Math.min(1000, Math.round(E(i / (samples - 1)) * 1000)));
  return out;
}

// sample a LUT at s in [0,1000] with linear interpolation
export function easeAt(lut: number[] | null | undefined, s1000: number): number {
  if (!lut || !lut.length) return s1000;
  const n = lut.length - 1;
  const s = s1000 < 0 ? 0 : s1000 > 1000 ? 1000 : s1000;
  const scaled = s * n; // integer
  const i = Math.floor(scaled / 1000);
  // n = length - 1 is always a valid index here.
  if (i >= n) return lut[n] as number;
  const frac = scaled - i * 1000;
  // easing LUTs are monotonic, so the delta is >= 0 and floor == truncation
  // i and i + 1 are both in [0, n] after the clamp above
  const a = lut[i] as number;
  const b = lut[i + 1] as number;
  return a + Math.floor(((b - a) * frac) / 1000);
}

// integer square root (same algorithm as the reference engine)
export function isqrt(v: number): number {
  if (v <= 0) return 0;
  let x = v;
  let y = (x + 1) >> 1;
  while (y < x) {
    x = y;
    y = (x + Math.floor(v / x)) >> 1;
  }
  return x;
}
