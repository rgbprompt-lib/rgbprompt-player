import { describe, expect, it } from 'vitest';
import {
  CONSTANTS,
  KEY_AREAS,
  KEY_BLOCKS,
  KEY_COUNT,
  OBJECT_AREAS,
  OBJECT_IDS,
  OBJECT_KEY_INDICES,
  luminanceFromSrgb,
} from '../src/index.ts';

describe('fixed-point luminance', () => {
  it('uses integer weights that sum to 65536', () => {
    const weights = CONSTANTS.luminance_weights;
    expect(weights).toEqual([13933, 46871, 4732]);
    expect(weights[0] + weights[1] + weights[2]).toBe(65536);
  });

  it('maps white to full scale and black to zero', () => {
    expect(luminanceFromSrgb(0, 0, 0)).toBe(0);
    expect(luminanceFromSrgb(255, 255, 255)).toBe(65535);
    expect(luminanceFromSrgb(255, 0, 0)).toBe(13932);
    expect(luminanceFromSrgb(0, 255, 0)).toBe(46870);
    expect(luminanceFromSrgb(0, 0, 255)).toBe(4731);
  });
});

describe('ansi104 geometry', () => {
  it('assigns every key to exactly one block with positive integer area', () => {
    expect(KEY_COUNT).toBe(104);
    expect(KEY_AREAS).toHaveLength(KEY_COUNT);
    expect(KEY_BLOCKS).toHaveLength(KEY_COUNT);
    for (const area of KEY_AREAS) {
      expect(Number.isInteger(area)).toBe(true);
      expect(area).toBeGreaterThan(0);
    }
    for (const block of KEY_BLOCKS) {
      expect(block).toBeGreaterThanOrEqual(0);
      expect(block).toBeLessThan(8);
    }
  });

  it('partitions the board into the eight block objects', () => {
    expect(OBJECT_IDS).toEqual([
      'board',
      'block-0',
      'block-1',
      'block-2',
      'block-3',
      'block-4',
      'block-5',
      'block-6',
      'block-7',
    ]);
    expect(OBJECT_KEY_INDICES).toHaveLength(9);
    expect(OBJECT_AREAS).toHaveLength(9);

    const seen = new Set<number>();
    for (let block = 0; block < 8; block++) {
      for (const key of OBJECT_KEY_INDICES[block + 1] as readonly number[]) {
        expect(KEY_BLOCKS[key]).toBe(block);
        seen.add(key);
      }
    }
    expect(seen.size).toBe(KEY_COUNT);
    expect(OBJECT_KEY_INDICES[0]).toHaveLength(KEY_COUNT);
    expect(OBJECT_AREAS[0]).toBe(KEY_AREAS.reduce((total, area) => total + area, 0));
  });
});
