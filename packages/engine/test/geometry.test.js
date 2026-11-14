import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKeyboard } from '@rgbprompt/layouts';
import { DEFAULT_GEOMETRY } from '../src/geometry.ts';
import { rainGeometry } from '../src/rain_model.ts';

// The default geometry tables are data derived from the generic 104 KLE file.
test('default LED positions and key widths match the generic 104 layout', () => {
  const positions = Array.from({ length: 6 }, () => Array.from({ length: 22 }, () => [255, 255]));
  const widths = Array.from({ length: 6 }, () => new Array(22).fill(0));
  for (const key of loadKeyboard('ansi104').keys) {
    if (!key.cell) continue;
    const [r, c] = key.cell;
    positions[r][c] = [Math.round((key.x + key.w / 2) * 8), Math.round((key.y + key.h / 2) * 8)];
    widths[r][c] = Math.round(key.w * 8);
  }
  assert.deepEqual(DEFAULT_GEOMETRY.ledPositions, positions);
  assert.deepEqual(DEFAULT_GEOMETRY.keyWidths, widths);
});

test('rain lanes come from the geometry, not from a fixed board', () => {
  const generic = rainGeometry(DEFAULT_GEOMETRY);
  assert.equal(generic.count, 23);
  assert.equal(generic.bottom, 5);
  // The space bar (6.25u) catches every lane over it.
  for (let lane = 0; lane < generic.count; lane++) {
    const x = generic.originX + lane * 8;
    if (x >= 30 && x <= 80) assert.equal(generic.lanes[lane][5], 6);
  }
  // Narrower board: drop the right half; fewer lanes, order stays a permutation.
  const half = {
    ...DEFAULT_GEOMETRY,
    ledPositions: DEFAULT_GEOMETRY.ledPositions.map((row) => row.map((p) => (p[0] > 90 ? [255, 255] : p))),
  };
  const small = rainGeometry(half);
  assert.ok(small.count < generic.count);
  assert.deepEqual(
    [...small.order].sort((a, b) => a - b),
    [...Array(small.count).keys()],
  );
});
