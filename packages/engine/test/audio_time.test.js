import test from 'node:test';
import assert from 'node:assert/strict';

import { validate } from '../src/validate.ts';
import { normalize } from '../src/normalize.ts';
import { loadBoard } from '../src/surfaces.ts';
import { Renderer, simulate } from '../src/render.ts';

const board = loadBoard();

function build(layer) {
  const dsl = {
    schema: 'lep.effect/1',
    meta: { name: 'audio time', author: 'test', generator: 'human', seed: 7 },
    layer: [{ id: 'a', surface: { type: 'all' }, ...layer }],
  };
  const report = validate(dsl, { board });
  assert.equal(report.ok, true, `valid: ${report.errors.join('; ')}`);
  return normalize(dsl, board);
}

const AUDIO_COMPONENTS = ['spectrum', 'spectrum_mirror', 'spectrum_sum'];

// Deterministic audio scripts copied from tools/golden/corpus.mjs so the engine
// tests exercise the same streams as the golden vectors.
const AUDIO_SCRIPT = Array.from({ length: 500 }, (_, i) => ({
  tick: i * 20,
  bands: Array.from({ length: 22 }, (_, b) => (i * 7 + b * 13) % 256),
}));

function altBands(i) {
  if (i < 40) return 255;
  if (i < 80) return 0;
  if (i < 120) return 220;
  if (i < 160) return 8;
  if (i < 200) return Math.max(0, 255 - Math.floor(((i - 160) * 255) / 39));
  if (i < 240) return 0;
  return i % 40 < 20 ? 255 : 12;
}

const ALT_AUDIO_SCRIPT = Array.from({ length: 500 }, (_, i) => ({
  tick: i * 20,
  bands: Array.from({ length: 22 }, (_, b) => Math.max(0, Math.min(255, altBands(i) - (b % 3)))),
}));

function frameMap(program, stepMs, audio, durationMs) {
  const frames = simulate(program, {
    ticks: Math.floor(durationMs / stepMs) + 1,
    stepMs,
    keyEvents: [],
    audio,
  });
  const byTick = new Map();
  frames.forEach((frame, index) => byTick.set(index * stepMs, frame));
  return byTick;
}

const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
const lcm = (a, b) => (a * b) / gcd(a, b);

function assertCadenceInvariant(program, audio, durationMs, label) {
  const steps = [1, 7, 10, 20, 33, 40];
  const maps = new Map(steps.map((stepMs) => [stepMs, frameMap(program, stepMs, audio, durationMs)]));
  for (let i = 0; i < steps.length; i++) {
    for (let j = i + 1; j < steps.length; j++) {
      const a = steps[i];
      const b = steps[j];
      const interval = lcm(a, b);
      for (let tick = 0; tick <= durationMs; tick += interval) {
        assert.deepEqual(maps.get(a).get(tick), maps.get(b).get(tick), `${label} ${a}v${b} tick=${tick}`);
      }
    }
  }
}

function light(cell) {
  return Math.max(
    Math.floor((cell.r * cell.l) / 100),
    Math.floor((cell.g * cell.l) / 100),
    Math.floor((cell.b * cell.l) / 100),
  );
}

test('audio primitives are cadence-invariant with both corpus audio scripts', () => {
  for (const component of AUDIO_COMPONENTS) {
    const program = build({ component });
    assertCadenceInvariant(program, AUDIO_SCRIPT, 6600, `${component} main`);
    assertCadenceInvariant(program, ALT_AUDIO_SCRIPT, 6600, `${component} alt`);
  }
});

test('a sample between frames is applied at its own millisecond', () => {
  const program = build({ component: 'spectrum', params: { gain: 255 } });
  const full = new Array(22).fill(255);
  const zero = new Array(22).fill(0);

  const reference = new Renderer(program);
  const referenceFrames = new Map();
  referenceFrames.set(0, reference.step(0, { audio: [{ t: 0, bands: full }] }));
  for (let t = 1; t <= 140; t++) {
    referenceFrames.set(t, reference.step(t, { audio: t === 137 ? [{ t: 137, bands: zero }] : [] }));
  }

  const renderer = new Renderer(program);
  renderer.step(0, { audio: [{ t: 0, bands: full }] });
  renderer.step(120, { audio: [{ t: 137, bands: zero }] });
  assert.equal(renderer._audioStates[0].lastSampleT, 0);
  renderer.step(130, {});
  assert.equal(renderer._audioStates[0].lastSampleT, 0);

  const frame = renderer.step(140, {});
  assert.equal(renderer._audioStates[0].lastSampleT, 137);
  assert.deepEqual(frame, referenceFrames.get(140));
});

test('future samples are buffered and the last sample of a millisecond wins, as on the keyboard', () => {
  const program = build({ component: 'spectrum', params: { gain: 255 } });
  const full = new Array(22).fill(255);
  const zero = new Array(22).fill(0);

  const renderer = new Renderer(program);
  renderer.step(0, { audio: [{ t: 100, bands: full }] });
  assert.equal(renderer._audioStates[0].lastSampleT, -Infinity);
  renderer.step(50, {});
  assert.equal(renderer._audioStates[0].lastSampleT, -Infinity);

  renderer.step(100, {
    audio: [
      { t: 100, bands: full },
      { t: 100, bands: zero },
    ],
  });
  assert.equal(renderer._audioStates[0].lastSampleT, 100);
  assert.deepEqual(renderer._audioStates[0].bands, zero);
});

test('an audio sample older than the advanced timeline is dropped', () => {
  const program = build({ component: 'spectrum', params: { gain: 255 } });
  const full = new Array(22).fill(255);
  const zero = new Array(22).fill(0);
  const renderer = new Renderer(program);

  renderer.step(0, { audio: [{ t: 0, bands: full }] });
  renderer.step(120, {});
  assert.equal(renderer._audioAdvancedTo, 120);

  // 100 is older than the already-advanced audio time (120), so it is dropped.
  renderer.step(140, { audio: [{ t: 100, bands: zero }] });
  assert.equal(renderer._audioStates[0].lastSampleT, 0);
  assert.deepEqual(renderer._audioStates[0].bands, full);
});

test('audio cold start at t=70000 equals continuous rendering', () => {
  const program = build({ component: 'spectrum', params: { gain: 180, dense: true, peak_ms: 300 } });
  const audio = Array.from({ length: 3501 }, (_, i) => ({
    tick: i * 20,
    bands: Array.from({ length: 22 }, (_, b) => (i * 7 + b * 13) % 256),
  }));

  const continuous = new Renderer(program);
  let ai = 0;
  let last;
  for (let t = 0; t <= 70_000; t += 20) {
    const due = [];
    while (ai < audio.length && audio[ai].tick <= t) {
      const sample = audio[ai++];
      due.push({ t: sample.tick, bands: sample.bands });
    }
    last = continuous.step(t, { audio: due });
  }

  const cold = new Renderer(program).step(70_000, {
    audio: audio.map((sample) => ({ t: sample.tick, bands: sample.bands })),
  });
  assert.deepEqual(cold, last);
});

test('aurora cold start at t=70000 equals continuous rendering', () => {
  const program = build({ component: 'aurora', params: { speed: 2 } });
  const events = Array.from({ length: 200 }, (_, i) => ({
    t: 137 + i * 351,
    type: i % 2 === 0 ? 'down' : 'up',
    cell: `2,${3 + (i % 5)}`,
  })).filter((event) => event.t <= 70_000);

  const continuous = new Renderer(program);
  let ei = 0;
  let last;
  for (let t = 0; t <= 70_000; t += 20) {
    const due = [];
    while (ei < events.length && events[ei].t <= t) due.push(events[ei++]);
    last = continuous.step(t, { keys: due });
  }

  const cold = new Renderer(program).step(70_000, { keys: events });
  assert.deepEqual(cold, last);
});

test('silence decays one audio level per millisecond', () => {
  const program = build({ component: 'spectrum', params: { gain: 255 } });
  const full = new Array(22).fill(255);
  const zero = new Array(22).fill(0);
  const renderer = new Renderer(program);

  renderer.step(0, { audio: [{ t: 0, bands: full }] });
  const frames = new Map();
  for (let t = 1; t <= 60; t++) {
    frames.set(t, renderer.step(t, { audio: t === 20 ? [{ t: 20, bands: zero }] : [] }));
  }

  // Thresholds are 75 + 4 * (5 - r), so the top row clears at 24 ms and the
  // bottom row at 44 ms (4 ms and 24 ms after the zero sample).
  assert.ok(light(frames.get(23)[0][0]) > 0, 'top row is lit at 23 ms');
  assert.equal(light(frames.get(24)[0][0]), 0, 'top row clears at 24 ms');
  assert.ok(light(frames.get(43)[5][0]) > 0, 'bottom row is lit at 43 ms');
  assert.equal(light(frames.get(44)[5][0]), 0, 'bottom row clears at 44 ms');
});

test('peak hold then one row per 60 ms', () => {
  const program = build({
    component: 'spectrum',
    params: { gain: 255, dense: true, peak_ms: 300 },
  });
  const full = new Array(22).fill(255);
  const low = new Array(22).fill(1);
  const renderer = new Renderer(program);

  renderer.step(0, { audio: [{ t: 0, bands: full }] });
  const peaks = new Map();
  for (let t = 1; t <= 650; t++) {
    renderer.step(t, { audio: t === 200 ? [{ t: 200, bands: low }] : [] });
    if (t >= 290) peaks.set(t, renderer._audioStates[0].peak[0]);
  }

  assert.equal(peaks.get(299), 6, 'peak is held through peak_ms');
  assert.equal(peaks.get(300), 5, 'first row falls at peak_ms');
  assert.equal(peaks.get(359), 5);
  assert.equal(peaks.get(360), 4);
  assert.equal(peaks.get(420), 3);
  assert.equal(peaks.get(480), 2);
  assert.equal(peaks.get(540), 1);
  assert.equal(peaks.get(600), 0);
});
