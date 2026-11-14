// Bounded heat field for the fire primitive, ported from the upstream
// reference (ENGINE.md §1). The field lives on the bounding box of the layer's
// cells in the logical grid, so it needs no board geometry.
import { LOGIC_COLS, LOGIC_ROWS } from './constants.ts';
import { Rng } from './rng.ts';
import type { Rgb } from './types.ts';

export const FIRE_MAX_CATCHUP = 32;
export const FIRE_COLORS: readonly Rgb[] = [
  [0, 0, 0],
  [180, 0, 0],
  [255, 80, 0],
  [255, 230, 100],
];

export interface FireParams {
  step_ms: number;
  cooling: number;
  sparking: number;
  spread: number;
  direction: string;
}
export const FIRE_DEFAULTS: FireParams = {
  step_ms: 60,
  cooling: 45,
  sparking: 65,
  spread: 50,
  direction: 'up',
};

export class FireState {
  private readonly seed: number;
  private readonly heat = new Uint8Array(LOGIC_ROWS * LOGIC_COLS);
  private slot: number | null = null;
  private rng: Rng | null = null;

  constructor(seed: number, layerKey: number) {
    this.seed = ((seed || 1) ^ Math.imul(layerKey + 1, 0x9e3779b9) ^ 0xf17e1234) >>> 0;
  }

  /** Advance to `tick` and return the heat (0..255) of every logical cell. */
  update(
    tick: number,
    cells: readonly (readonly [number, number])[],
    params: Partial<FireParams> = {},
  ): Uint8Array {
    const p = { ...FIRE_DEFAULTS, ...params };
    const target = Math.floor((tick >>> 0) / p.step_ms);
    if (!cells.length) return this.heat;
    let minR = LOGIC_ROWS;
    let maxR = 0;
    let minC = LOGIC_COLS;
    let maxC = 0;
    for (const [r, c] of cells) {
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
      if (c < minC) minC = c;
      if (c > maxC) maxC = c;
    }
    const vertical = p.direction === 'up' || p.direction === 'down';
    const depth = vertical ? maxR - minR + 1 : maxC - minC + 1;
    const lanes = vertical ? maxC - minC + 1 : maxR - minR + 1;
    const at = (d: number, l: number): number => {
      const r = vertical ? (p.direction === 'up' ? maxR - d : minR + d) : minR + l;
      const c = vertical ? minC + l : p.direction === 'left' ? maxC - d : minC + d;
      return r * LOGIC_COLS + c;
    };
    const heat = this.heat;
    // Reason: every index comes from `at`, which stays inside the grid.
    const h = (i: number): number => heat[i] as number;
    if (this.slot === null || target < this.slot || target - this.slot > FIRE_MAX_CATCHUP) {
      const first = Math.max(0, target - FIRE_MAX_CATCHUP + 1);
      heat.fill(0);
      this.slot = first - 1;
      this.rng = new Rng((this.seed ^ Math.imul(first, 0x85ebca6b)) >>> 0);
    }
    // Reason: the branch above creates the generator before the first step.
    const rng = this.rng as Rng;
    const cooling = Math.floor((p.cooling * 10) / depth);
    const left = Math.floor(p.spread / 2);
    const right = p.spread - left;
    while (this.slot < target) {
      for (let d = 0; d < depth; d++)
        for (let l = 0; l < lanes; l++) {
          const i = at(d, l);
          heat[i] = Math.max(0, h(i) - rng.int(cooling + 1));
        }
      // Cold edge first: all source cells still contain the preceding step.
      for (let d = depth - 1; d >= 1; d--)
        for (let l = 0; l < lanes; l++)
          heat[at(d, l)] = Math.floor(
            ((100 - p.spread) * h(at(d - 1, l)) +
              left * h(at(d - 1, Math.max(0, l - 1))) +
              right * h(at(d - 1, Math.min(lanes - 1, l + 1)))) /
              100,
          );
      for (let l = 0; l < lanes; l++)
        if (rng.int(100) < p.sparking) {
          const i = at(0, l);
          heat[i] = Math.min(255, h(i) + 160 + rng.int(96));
        }
      this.slot++;
    }
    return heat;
  }
}
