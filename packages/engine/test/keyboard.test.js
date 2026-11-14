import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseKLE, bounds } from '../src/kle.ts';
import { loadKeyboard, listKeyboards } from '../src/keyboard.ts';
import { LOGIC_ROWS, LOGIC_COLS } from '../src/constants.ts';

const kle = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../layouts/data/tkl87.kle.json', import.meta.url)), 'utf8'),
);

test('KLE parser yields an 87-key TKL', () => {
  const keys = parseKLE(kle);
  assert.equal(keys.length, 87);
  const b = bounds(keys);
  assert.ok(Math.abs(b.maxX - 18.5) < 0.001, `maxX=${b.maxX}`);
  assert.equal(b.maxY, 6);
});

test('KLE parser places Esc, Space and Q at sane coordinates', () => {
  const keys = parseKLE(kle);
  const esc = keys.find((k) => k.label === 'Esc');
  assert.deepEqual([esc.x, esc.y, esc.w], [0, 0, 1]);
  const space = keys.find((k) => k.label === 'Space');
  assert.equal(space.w, 6.25);
  assert.equal(space.y, 5);
  const q = keys.find((k) => k.label === 'Q');
  assert.equal(q.y, 2);
});

test('keyboard profile assigns in-range logical cells', () => {
  const kb = loadKeyboard('tkl87');
  assert.equal(kb.keys.length, 87);
  for (const k of kb.keys) {
    assert.ok(k.cell[0] >= 0 && k.cell[0] < LOGIC_ROWS, `row ${k.cell[0]}`);
    assert.ok(k.cell[1] >= 0 && k.cell[1] < LOGIC_COLS, `col ${k.cell[1]}`);
    assert.ok(typeof k.legendBottom === 'string');
  }
  assert.ok(listKeyboards().includes('tkl87'));
});

test('space key lands in the bottom rows band', () => {
  const kb = loadKeyboard('tkl87');
  const space = kb.keys.find((k) => k.legendBottom === 'Space');
  assert.equal(space.cell[0], 5);
});
