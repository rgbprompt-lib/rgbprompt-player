import { describe, expect, it } from 'vitest';

import ansi104RegionsV2 from '../data/ansi104.regions-v2.json';
import k60Kle from '../data/k60.kle.json';
import k65Kle from '../data/k65.kle.json';
import k75Kle from '../data/k75.kle.json';
import tkl87Kle from '../data/tkl87.kle.json';
import {
  ANSI104_CELL,
  ANSI104_KEYS,
  REGION_LABELS,
  frameToKeyRgb,
  layoutMap,
  listLayouts,
  loadKeyboard,
} from '../src/index';
import type { LayoutId, KleBoard } from '../src/index';
import { layoutKeysFromKle } from '../src/keyboard';

type MutableCell = { r: number; g: number; b: number; l: number };

const TARGET_KLE: Record<string, KleBoard> = {
  tkl87: tkl87Kle as KleBoard,
  k75: k75Kle as KleBoard,
  k65: k65Kle as KleBoard,
  k60: k60Kle as KleBoard,
};

function targetKle(id: LayoutId): KleBoard {
  const kle = TARGET_KLE[id];
  if (!kle) throw new Error(`missing KLE data for ${id}`);
  return kle;
}

function emptyFrame(): MutableCell[][] {
  return Array.from({ length: 6 }, () => Array.from({ length: 22 }, () => ({ r: 0, g: 0, b: 0, l: 0 })));
}

function setCell(frame: MutableCell[][], cell: readonly [number, number], value: MutableCell): void {
  const row = frame[cell[0]];
  if (!row) throw new Error(`bad row ${cell[0]}`);
  row[cell[1]] = value;
}

function uniqueInput(): Uint8Array {
  const out = new Uint8Array(ANSI104_KEYS.length * 3);
  for (let i = 0; i < ANSI104_KEYS.length; i++) {
    out[i * 3] = (i * 7 + 1) % 256;
    out[i * 3 + 1] = (i * 13 + 2) % 256;
    out[i * 3 + 2] = (i * 29 + 3) % 256;
  }
  return out;
}

describe('ANSI104_KEYS', () => {
  it('has 104 unique keys in ansi104.cells.json order', () => {
    expect(ANSI104_KEYS).toHaveLength(104);
    expect(new Set(ANSI104_KEYS).size).toBe(104);
    expect(ANSI104_KEYS[0]).toBe('ESC');
    expect(ANSI104_KEYS.at(-1)).toBe('KP_PERIOD');
    expect(new Set(ANSI104_KEYS)).toEqual(new Set(Object.keys(ANSI104_CELL)));
  });

  it('every key exists in the cell map', () => {
    for (const key of ANSI104_KEYS) {
      expect(ANSI104_CELL[key]).toBeDefined();
    }
  });
});

describe('frameToKeyRgb', () => {
  it('uses floor(channel * level / 100) per key', () => {
    const frame = emptyFrame();
    setCell(frame, ANSI104_CELL.ESC ?? [0, 0], { r: 200, g: 101, b: 50, l: 50 });

    const rgb = frameToKeyRgb(frame);
    const i = ANSI104_KEYS.indexOf('ESC');
    expect([rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]]).toEqual([100, 50, 25]);
    expect(rgb).toHaveLength(104 * 3);
  });

  it('is zero everywhere for an empty frame and full scale at level 100', () => {
    expect(Array.from(frameToKeyRgb(emptyFrame()))).toEqual(Array(104 * 3).fill(0));

    const frame = emptyFrame();
    setCell(frame, ANSI104_CELL.SPACE ?? [0, 0], { r: 255, g: 128, b: 0, l: 100 });
    const rgb = frameToKeyRgb(frame);
    const i = ANSI104_KEYS.indexOf('SPACE');
    expect([rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]]).toEqual([255, 128, 0]);
  });
});

describe('REGION_LABELS', () => {
  it('lists the eight TUN-04 regions in table order with i18n keys', () => {
    expect(REGION_LABELS.map((r) => r.id)).toEqual([
      'all',
      'alphas',
      'numbers',
      'f_row',
      'arrows',
      'numpad',
      'left_half',
      'right_half',
    ]);
    for (const region of REGION_LABELS) {
      expect(region.labelKey).toBe(`tuning.region.${region.id}`);
    }
  });

  it('all region ids exist in ansi104.regions-v2', () => {
    for (const region of REGION_LABELS) {
      expect(Object.hasOwn(ansi104RegionsV2.regions, region.id)).toBe(true);
    }
  });
});

describe('layoutMap', () => {
  it('lists the four supported target layouts', () => {
    expect(listLayouts()).toEqual(['tkl87', 'k75', 'k65', 'k60']);
  });

  it('rejects input that is not one ansi104 key buffer', () => {
    expect(() => layoutMap(new Uint8Array(3), 'tkl87')).toThrow(/expected 312 bytes/);
  });

  for (const id of listLayouts()) {
    it(`maps ansi104 colours to ${id} by key name`, () => {
      const input = uniqueInput();
      const ansiIndex = new Map(ANSI104_KEYS.map((name, index) => [name, index]));
      const targetKeys = layoutKeysFromKle(targetKle(id)).map((key) => key.name);
      const output = layoutMap(input, id);

      expect(output).toHaveLength(loadKeyboard(id).keys.length * 3);
      expect(output).toHaveLength(targetKeys.length * 3);

      for (let i = 0; i < targetKeys.length; i++) {
        const name = targetKeys[i] ?? null;
        const actual = [output[i * 3], output[i * 3 + 1], output[i * 3 + 2]];
        const source = name === null ? undefined : ansiIndex.get(name);
        if (source === undefined) {
          expect(actual.some((channel) => channel !== 0)).toBe(true);
        } else {
          expect(actual).toEqual([input[source * 3], input[source * 3 + 1], input[source * 3 + 2]]);
        }
      }
    });
  }

  it('every target key resolves to a key name', () => {
    for (const id of listLayouts()) {
      const names = layoutKeysFromKle(targetKle(id)).map((key) => key.name);
      expect(names.every((name) => name !== null)).toBe(true);
    }
  });
});
