import { describe, expect, it } from 'vitest';
import * as player from '../src/entries/player.ts';

const EXPECTED = [
  'CONSTANTS',
  'KEY_CELLS',
  'KEY_CENTRES_QUARTER',
  'KEY_COUNT',
  'KEY_NAMES',
  'createLimiter',
  'frameToKeyRgb',
];

describe('player entry', () => {
  it('exports exactly the limiter and its input contract', () => {
    expect(Object.keys(player).sort()).toEqual(EXPECTED);
  });

  it('exposes 104 key names and centres in KEY_NAMES order', () => {
    expect(player.KEY_COUNT).toBe(104);
    expect(player.KEY_NAMES).toHaveLength(104);
    expect(player.KEY_CELLS).toHaveLength(104);
    expect(player.KEY_CELLS[0]).toBe('0,0');
    expect(player.KEY_CENTRES_QUARTER).toHaveLength(104);
  });
});
