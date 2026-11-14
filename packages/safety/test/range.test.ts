import { describe, expect, it } from 'vitest';
import type { EffectDsl } from '@rgbprompt/engine';
import { safeRange } from '../src/index.ts';

const meta = { name: 'range', author: 'test', generator: 'human' as const, seed: 7 };
const solid = (rgb: [number, number, number]) => ({ type: 'solid' as const, rgb });

function effect(layer: Record<string, unknown>): EffectDsl {
  return {
    schema: 'lep.effect/1',
    meta: { ...meta },
    layer: [{ id: 'a', component: 'static', surface: { type: 'all' }, color: solid([10, 20, 30]), ...layer }],
  } as EffectDsl;
}

describe('safeRange', () => {
  it('narrows the speed range of a blink so the faster end is excluded', () => {
    const blink = effect({
      component: 'blink',
      color: solid([255, 255, 255]),
      params: { on_ms: 250, off_ms: 250, soft: false },
    });
    const range = safeRange(blink, 'a', 'speed');
    expect(range.control).toBe('speed');
    if (range.control !== 'speed') return;
    expect(range.safe).toBe(true);
    expect(range.min).toBe(0.5);
    expect(range.max).toBeLessThan(2);
    expect(range.max).toBeGreaterThan(1);
  });

  it('returns the full speed range for a static effect', () => {
    const range = safeRange(effect({}), 'a', 'speed');
    expect(range).toEqual({ control: 'speed', min: 0.5, max: 2, safe: true });
  });

  it('reports discrete controls as safe only when the current effect passes', () => {
    expect(safeRange(effect({}), 'a', 'color')).toEqual({ control: 'color', safe: true });
    expect(safeRange(effect({}), 'a', 'area')).toEqual({ control: 'area', safe: true });

    const strobing = effect({
      component: 'blink',
      color: solid([255, 255, 255]),
      params: { on_ms: 60, off_ms: 60, soft: false },
    });
    expect(safeRange(strobing, 'a', 'color')).toEqual({ control: 'color', safe: false });
    expect(safeRange(strobing, 'a', 'area')).toEqual({ control: 'area', safe: false });
  });
});
