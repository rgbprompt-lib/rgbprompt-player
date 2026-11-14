// Physical layout mapping (ENGINE.md §4.4): ansi104 key RGB -> target board,
// by key name. Keys absent from the target are dropped; target-only keys take
// the colour of the nearest ansi104 key by key-centre distance.
import { ANSI104_KEYS } from './ansi104.ts';
import { layoutKeysFromKle } from './keyboard.ts';
import { ANSI104_KLE, K60_KLE, K65_KLE, K75_KLE, TKL87_KLE } from './data.ts';
import type { LayoutId, NamedKey } from './types.ts';

const LAYOUT_ORDER = ['tkl87', 'k75', 'k65', 'k60'] as const satisfies readonly LayoutId[];

const LAYOUT_KEYS: Record<LayoutId, readonly NamedKey[]> = {
  tkl87: layoutKeysFromKle(TKL87_KLE),
  k75: layoutKeysFromKle(K75_KLE),
  k65: layoutKeysFromKle(K65_KLE),
  k60: layoutKeysFromKle(K60_KLE),
};

const ANSI104_INDEX = new Map<string, number>(ANSI104_KEYS.map((name, index) => [name, index]));

const ANSI104_CENTRES = new Map<string, { cx: number; cy: number }>();
for (const key of layoutKeysFromKle(ANSI104_KLE)) {
  if (key.name !== null) ANSI104_CENTRES.set(key.name, { cx: key.cx, cy: key.cy });
}

export function listLayouts(): LayoutId[] {
  return [...LAYOUT_ORDER];
}

// Distance is Euclidean in KLE key units between key centres
// (x + w / 2, y + h / 2). Ties keep the earlier ANSI104_KEYS entry.
function nearestAnsi104Index(cx: number, cy: number): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < ANSI104_KEYS.length; i++) {
    const name = ANSI104_KEYS[i] as string;
    const centre = ANSI104_CENTRES.get(name);
    if (!centre) continue;
    const dx = cx - centre.cx;
    const dy = cy - centre.cy;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

export function layoutMap(fromKeysRgb: Uint8Array, to: LayoutId): Uint8Array {
  const expected = ANSI104_KEYS.length * 3;
  if (fromKeysRgb.length !== expected) {
    throw new Error(`layoutMap: expected ${expected} bytes, got ${fromKeysRgb.length}`);
  }
  const target = LAYOUT_KEYS[to];
  const out = new Uint8Array(target.length * 3);
  for (let i = 0; i < target.length; i++) {
    const key = target[i] as NamedKey;
    const byName = key.name === null ? undefined : ANSI104_INDEX.get(key.name);
    const source = byName === undefined ? nearestAnsi104Index(key.cx, key.cy) : byName;
    const src = source * 3;
    const dst = i * 3;
    out[dst] = fromKeysRgb[src] ?? 0;
    out[dst + 1] = fromKeysRgb[src + 1] ?? 0;
    out[dst + 2] = fromKeysRgb[src + 2] ?? 0;
  }
  return out;
}
