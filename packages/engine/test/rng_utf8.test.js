import test from 'node:test';
import assert from 'node:assert/strict';

import { sparkleIdHash } from '../src/rng.ts';

function referenceHash(id) {
  let h = 0x811c9dc5;
  for (const b of new globalThis.TextEncoder().encode(id || ''))
    h = Math.imul((h ^ b) >>> 0, 0x01000193) >>> 0;
  return h;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('sparkleIdHash UTF-8 encoding matches TextEncoder', () => {
  const cases = ['', 'ascii', '星点é🌟', '\ud800', '\udc00', 'a\ud800b', 'a\udc00b', '\ud83c\udf1f'];
  for (const value of cases) {
    assert.equal(sparkleIdHash(value), referenceHash(value), JSON.stringify(value));
  }
});

test('sparkleIdHash matches TextEncoder for 1000 fixed-seed random strings', () => {
  const random = mulberry32(0x5eed1234);
  for (let i = 0; i < 1000; i++) {
    const length = Math.floor(random() * 41);
    let value = '';
    for (let j = 0; j < length; j++) {
      value += String.fromCharCode(Math.floor(random() * 0x10000));
    }
    assert.equal(sparkleIdHash(value), referenceHash(value), `case ${i}`);
  }
});
