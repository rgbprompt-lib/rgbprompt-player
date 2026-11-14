import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

import { LOGIC_ROWS, LOGIC_COLS, MAX_LED_LIGHT_LEVEL } from '../src/constants.ts';
import { makeFrame, levelToPhysical } from '../src/render.ts';
import { framesToPpm } from '../src/preview.ts';

// Round A used Node's Buffer directly. Keep that implementation as the
// byte-for-byte reference for the portable Uint8Array version.
function roundAPpm(frames, { scale = 6, brightnessLevel = MAX_LED_LIGHT_LEVEL } = {}) {
  const w = LOGIC_COLS * scale;
  const h = LOGIC_ROWS * scale * frames.length;
  const header = Buffer.from(`P6\n${w} ${h}\n255\n`, 'ascii');
  const body = Buffer.alloc(w * h * 3);
  let off = 0;
  for (const frame of frames) {
    for (let y = 0; y < LOGIC_ROWS * scale; y++) {
      const r = Math.floor(y / scale);
      for (let x = 0; x < w; x++) {
        const c = Math.floor(x / scale);
        const cell = frame[r][c];
        const phys = levelToPhysical(cell.l, brightnessLevel);
        body[off++] = Math.min(255, Math.floor((cell.r * phys) / 200));
        body[off++] = Math.min(255, Math.floor((cell.g * phys) / 200));
        body[off++] = Math.min(255, Math.floor((cell.b * phys) / 200));
      }
    }
  }
  return Buffer.concat([header, body]);
}

test('framesToPpm matches the round A Buffer output byte for byte', () => {
  const frames = [makeFrame(), makeFrame()];
  for (let f = 0; f < frames.length; f++) {
    for (let r = 0; r < LOGIC_ROWS; r++) {
      for (let c = 0; c < LOGIC_COLS; c++) {
        frames[f][r][c] = {
          r: (f * 31 + r * 17 + c * 7) % 256,
          g: (f * 13 + r * 29 + c * 11) % 256,
          b: (f * 43 + r * 5 + c * 19) % 256,
          l: (f * 23 + r * 37 + c * 3) % 101,
        };
      }
    }
  }

  const options = { scale: 5, brightnessLevel: 12 };
  const actual = framesToPpm(frames, options);
  assert.ok(actual instanceof Uint8Array);
  assert.deepEqual(Buffer.from(actual), roundAPpm(frames, options));
});
