import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';

import { buildCorpus } from '../corpus.mjs';
import { FRAME_BYTES, compareAtTicks, firstCrcDifference, renderFrames, vectorFor } from '../lib.mjs';

test('corpus builds stable kebab-case ids', () => {
  const corpus = buildCorpus();
  const ids = corpus.map((entry) => entry.id);
  assert.deepEqual(
    ids,
    buildCorpus().map((entry) => entry.id),
  );
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.length >= 70, `expected at least 70 cases, got ${ids.length}`);
  for (const id of ids) {
    assert.match(id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  }
});

test('every case is a valid engine effect', () => {
  for (const entry of buildCorpus()) {
    assert.equal(entry.effect.schema, 'lep.effect/1', entry.id);
    assert.ok(entry.effect.layer.length >= 1, entry.id);
  }
});

test('canonical frame serialization is 528 bytes', () => {
  const entry = buildCorpus().find((item) => item.id === 'example-red-static');
  assert.ok(entry);
  const frames = renderFrames(entry.effect, { durationMs: 20 });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].length, FRAME_BYTES);
  assert.equal(FRAME_BYTES, 6 * 22 * 4);
});

test('sha256 and crc32 vectors are stable for a static effect', () => {
  const entry = buildCorpus().find((item) => item.id === 'example-red-static');
  assert.ok(entry);
  const first = vectorFor(entry.effect, {});
  const second = vectorFor(entry.effect, {});
  assert.deepEqual(first, second);
  assert.equal(first.stepMs, 20);
  assert.equal(first.frames, 500);
  assert.equal(first.crc32.length, 500);
  assert.equal(first.sha256.length, 64);
});

test('compareAtTicks counts differences only at common ticks', () => {
  const a = new Map([
    [0, Buffer.from([1])],
    [40, Buffer.from([2])],
  ]);
  const b = new Map([
    [0, Buffer.from([1])],
    [40, Buffer.from([3])],
  ]);
  assert.deepEqual(compareAtTicks(a, b, 40, { durationMs: 80 }), {
    diff: 1,
    total: 2,
    ok: false,
  });
});

test('firstCrcDifference reports the first mismatch and length changes', () => {
  assert.equal(firstCrcDifference([1, 2, 3], [1, 2, 3]), -1);
  assert.equal(firstCrcDifference([1, 2, 3], [1, 9, 3]), 1);
  assert.equal(firstCrcDifference([1, 2], [1, 2, 3]), 2);
});
