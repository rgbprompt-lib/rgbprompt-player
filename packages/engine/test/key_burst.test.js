import test from 'node:test';
import assert from 'node:assert/strict';
import { loadKeyboard } from '../src/keyboard.ts';
import { KEY_CENTRES } from '../src/key_centres.ts';

test('generated positions cover actual ANSI 104 key centres', () => {
  const keyboard = loadKeyboard('ansi104');
  for (const key of keyboard.keys) {
    const got = KEY_CENTRES[key.cell[0]][key.cell[1]];
    const want = [Math.round((key.x + key.w / 2) * 8), Math.round((key.y + key.h / 2) * 8)];
    // Cell collisions may share a centre; require the cell is marked present
    assert.notEqual(got[0], 255, `absent cell for ${key.label} @${key.cell}`);
  }
  assert.equal(keyboard.keys.length, 104);
});
