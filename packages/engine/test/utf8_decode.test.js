import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

import { utf8Decode } from '../src/rng.ts';
import { buildCorpus } from '../../../tools/golden/corpus.mjs';

function reference(bytes) {
  return Buffer.from(bytes).toString('utf8');
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

test('utf8Decode matches Buffer on valid text', () => {
  const cases = ['', 'ascii', '星点é🌟', 'a\u0000b', 'e\u0301', '𝄞 clef', '日本語のテキスト', 'Ω≈ç√∫˜µ≤≥÷'];
  for (const value of cases) {
    const bytes = new Uint8Array(Buffer.from(value, 'utf8'));
    assert.equal(utf8Decode(bytes), reference(bytes), JSON.stringify(value));
  }
});

test('utf8Decode matches Buffer on the corpus effect names', () => {
  for (const entry of buildCorpus()) {
    const bytes = new Uint8Array(Buffer.from(entry.effect.meta.name, 'utf8'));
    assert.equal(utf8Decode(bytes), reference(bytes), entry.id);
  }
});

test('utf8Decode matches Buffer on malformed byte sequences', () => {
  const targeted = [
    [0x80],
    [0xbf],
    [0xc0, 0x80],
    [0xc1, 0xbf],
    [0xe0, 0x80, 0x80],
    [0xed, 0xa0, 0x80],
    [0xf0, 0x80, 0x80, 0x80],
    [0xf4, 0x90, 0x80, 0x80],
    [0xf5, 0x80, 0x80, 0x80],
    [0xe1, 0x80],
    [0xf1, 0x80, 0x80],
    [0xe1, 0x41],
    [0xf1, 0x41, 0x80, 0x80],
    [0xff],
  ];
  for (const bytes of targeted) {
    const value = new Uint8Array(bytes);
    assert.equal(utf8Decode(value), reference(value), JSON.stringify(bytes));
  }

  const random = mulberry32(0x0f0f0f0f);
  for (let i = 0; i < 5000; i++) {
    const length = Math.floor(random() * 13);
    const bytes = new Uint8Array(length);
    for (let j = 0; j < length; j++) bytes[j] = Math.floor(random() * 256);
    assert.equal(utf8Decode(bytes), reference(bytes), `case ${i}: ${JSON.stringify([...bytes])}`);
  }
});
