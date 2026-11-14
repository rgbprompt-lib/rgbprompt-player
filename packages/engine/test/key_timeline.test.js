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
    meta: { name: 'timeline', author: 'test', generator: 'human', seed: 7 },
    layer: [{ id: 'a', surface: { type: 'all' }, ...layer }],
  };
  const report = validate(dsl, { board });
  assert.equal(report.ok, true, `valid: ${report.errors.join('; ')}`);
  return normalize(dsl, board);
}

const keyRingProgram = () => build({ component: 'key_ring' });
const keyBurstProgram = () => build({ component: 'key_burst' });
const keyTintProgram = () => build({ component: 'key_tint' });

const ringsOf = (renderer) => renderer.keyRings[0].rings.filter(Boolean);
const burstsOf = (renderer) => renderer.keyBursts[0].bursts.filter(Boolean);
const bornTimes = (renderer) =>
  ringsOf(renderer)
    .map((ring) => ring.born)
    .sort((a, b) => a - b);

// Eight down/up pairs, copied from tools/golden/corpus.mjs. The timestamps
// deliberately fall between 20/33/40 ms frames.
const TYPING_SCRIPT = [
  { tick: 137, type: 'down', cell: '2,3' },
  { tick: 263, type: 'up', cell: '2,3' },
  { tick: 611, type: 'down', cell: '3,2' },
  { tick: 907, type: 'up', cell: '3,2' },
  { tick: 1171, type: 'down', cell: '3,3' },
  { tick: 1439, type: 'up', cell: '3,3' },
  { tick: 1873, type: 'down', cell: '3,4' },
  { tick: 2111, type: 'up', cell: '3,4' },
  { tick: 2687, type: 'down', cell: '2,5' },
  { tick: 2953, type: 'up', cell: '2,5' },
  { tick: 3517, type: 'down', cell: '4,5' },
  { tick: 3847, type: 'up', cell: '4,5' },
  { tick: 4639, type: 'down', cell: '2,6' },
  { tick: 4981, type: 'up', cell: '2,6' },
  { tick: 5821, type: 'down', cell: '3,7' },
  { tick: 6113, type: 'up', cell: '3,7' },
];

function light(cell) {
  return Math.max(
    Math.floor((cell.r * cell.l) / 100),
    Math.floor((cell.g * cell.l) / 100),
    Math.floor((cell.b * cell.l) / 100),
  );
}

test('an event between two frames is applied at its own timestamp', () => {
  const renderer = new Renderer(keyRingProgram());
  renderer.step(120, { keys: [] });
  assert.equal(ringsOf(renderer).length, 0);

  renderer.step(140, { keys: [{ t: 137, type: 'down', cell: '2,3' }] });
  const rings = ringsOf(renderer);
  assert.equal(rings.length, 1);
  assert.equal(rings[0].born, 137);
  assert.equal(renderer._down.has('2,3'), true);
});

test('frames without key input do not move the key timeline', () => {
  const renderer = new Renderer(keyRingProgram());
  renderer.step(100, { keys: [{ t: 50, type: 'down', cell: '2,3' }] });
  const lastKeyT = renderer._lastKeyT;
  const lastIds = [...renderer._lastKeyIds].sort();

  renderer.step(200, {});
  renderer.step(300, { keys: [] });

  assert.equal(renderer._lastKeyT, lastKeyT);
  assert.deepEqual([...renderer._lastKeyIds].sort(), lastIds);
});

test('a late event keeps its timestamp and emits exactly one press edge', () => {
  const renderer = new Renderer(keyRingProgram());
  renderer.step(100, { keys: [{ t: 50, type: 'down', cell: '2,3' }] });
  renderer.step(200, {});

  // 150 is older than the previous frame (200) but later than the last applied
  // event (50), so it is applied as an edge with its own timestamp.
  const frame = renderer.step(220, { keys: [{ t: 150, type: 'down', cell: '2,4' }] });
  const rings = ringsOf(renderer).sort((a, b) => a.seq - b.seq);
  assert.deepEqual(
    rings.map((ring) => [ring.r, ring.c, ring.born]),
    [
      [2, 3, 50],
      [2, 4, 150],
    ],
  );
  const late = light(frame[2][4]);
  assert.ok(late > 0 && late < 255, 'the late ring is already partly advanced');

  renderer.step(240, {});
  assert.equal(ringsOf(renderer).length, 2);
});

test('a future event is buffered and applied by the first frame that reaches it', () => {
  const renderer = new Renderer(keyTintProgram());
  const at0 = renderer.step(0, { keys: [{ t: 137, type: 'down', cell: '2,3' }] });
  assert.equal(at0[2][3].l, 0);
  assert.equal(renderer._down.has('2,3'), false);

  const at100 = renderer.step(100, { keys: [] });
  assert.equal(at100[2][3].l, 0);
  assert.equal(renderer._down.has('2,3'), false);

  const at140 = renderer.step(140, { keys: [] });
  assert.ok(at140[2][3].l > 0);
  assert.equal(renderer._down.has('2,3'), true);
});

test('unsorted events are applied in timestamp order', () => {
  const renderer = new Renderer(keyRingProgram());
  renderer.step(200, {
    keys: [
      { t: 160, type: 'down', cell: '2,4' },
      { t: 137, type: 'down', cell: '2,3' },
    ],
  });
  assert.deepEqual(bornTimes(renderer), [137, 160]);
  assert.equal(renderer._down.has('2,3'), true);
  assert.equal(renderer._down.has('2,4'), true);
  assert.equal(renderer._lastKeyT, 160);
});

test('duplicate and old events are ignored', () => {
  const renderer = new Renderer(keyRingProgram());
  renderer.step(100, { keys: [{ t: 50, type: 'down', cell: '2,3' }] });
  assert.deepEqual(bornTimes(renderer), [50]);

  renderer.step(200, {
    keys: [
      { t: 50, type: 'down', cell: '2,3' },
      { t: 150, type: 'down', cell: '2,4' },
    ],
  });
  assert.deepEqual(bornTimes(renderer), [50, 150]);

  renderer.step(300, { keys: [{ t: 150, type: 'down', cell: '2,4' }] });
  assert.deepEqual(bornTimes(renderer), [50, 150]);
  assert.equal(renderer._lastKeyT, 150);
});

test('down and up inside one frame interval produce one press and one release edge', () => {
  const renderer = new Renderer(keyRingProgram());
  renderer.step(100, { keys: [] });
  renderer.step(120, {
    keys: [
      { t: 110, type: 'down', cell: '3,3' },
      { t: 115, type: 'up', cell: '3,3' },
    ],
  });
  const rings = ringsOf(renderer);
  assert.equal(rings.length, 1);
  assert.equal(rings[0].born, 110);
  assert.equal(renderer._down.size, 0);
  assert.equal(renderer._lastKeyT, 115);

  renderer.step(140, { keys: [] });
  assert.equal(ringsOf(renderer).length, 1);
});

function frameMap(program, stepMs, keyEvents, durationMs) {
  const ticks = Math.floor(durationMs / stepMs) + 1;
  const frames = simulate(program, { ticks, stepMs, keyEvents });
  const byTick = new Map();
  frames.forEach((frame, index) => byTick.set(index * stepMs, frame));
  return byTick;
}

test('key_ring, key_burst and key_tint are cadence-invariant at common ticks', () => {
  const steps = [1, 10, 20, 33, 40];
  const durationMs = 6600;
  const commonTicks = [0, 1320, 2640, 3960, 5280, 6600];
  for (const component of ['key_ring', 'key_burst', 'key_tint']) {
    const program = build({ component });
    const reference = frameMap(program, 1, TYPING_SCRIPT, durationMs);
    for (const stepMs of steps) {
      const actual = frameMap(program, stepMs, TYPING_SCRIPT, durationMs);
      for (const tick of commonTicks) {
        assert.deepEqual(actual.get(tick), reference.get(tick), `${component} step=${stepMs} tick=${tick}`);
      }
    }
  }
});

const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
const lcm = (a, b) => (a * b) / gcd(a, b);

function assertCadenceInvariant(program, keyEvents, { durationMs = 2000 } = {}) {
  const steps = [1, 10, 20, 33, 40];
  const maps = new Map(steps.map((stepMs) => [stepMs, frameMap(program, stepMs, keyEvents, durationMs)]));
  for (let i = 0; i < steps.length; i++) {
    for (let j = i + 1; j < steps.length; j++) {
      const a = steps[i];
      const b = steps[j];
      const interval = lcm(a, b);
      for (let tick = 0; tick <= durationMs; tick += interval) {
        assert.deepEqual(
          maps.get(a).get(tick),
          maps.get(b).get(tick),
          `${program.layers[0].component} ${a}v${b} tick=${tick}`,
        );
      }
    }
  }
}

const CHORD_EVENTS = [
  { t: 50, type: 'down', cell: '2,3' },
  { t: 50, type: 'down', cell: '3,8' },
  { t: 200, type: 'up', cell: '2,3' },
  { t: 200, type: 'up', cell: '3,8' },
];

test('two presses at the same timestamp are both applied', () => {
  const ringRenderer = new Renderer(keyRingProgram());
  ringRenderer.step(50, { keys: CHORD_EVENTS });
  assert.equal(ringsOf(ringRenderer).length, 2);

  const burstRenderer = new Renderer(keyBurstProgram());
  burstRenderer.step(50, { keys: CHORD_EVENTS });
  assert.equal(burstsOf(burstRenderer).length, 2);

  const tintRenderer = new Renderer(keyTintProgram());
  const frame = tintRenderer.step(50, { keys: CHORD_EVENTS });
  assert.ok(frame[2][3].l > 0);
  assert.ok(frame[3][8].l > 0);
  assert.equal(tintRenderer._down.size, 2);
});

test('presses 20 ms apart keep their event order across frame groupings', () => {
  const events = [
    { t: 5, type: 'down', cell: '2,10' },
    { t: 25, type: 'down', cell: '2,2' },
    { t: 300, type: 'up', cell: '2,10' },
    { t: 300, type: 'up', cell: '2,2' },
  ];

  const ringRenderer = new Renderer(keyRingProgram());
  ringRenderer.step(40, { keys: events });
  const rings = ringsOf(ringRenderer).sort((a, b) => a.seq - b.seq);
  assert.deepEqual(
    rings.map((ring) => [ring.born, ring.seq]),
    [
      [5, 0],
      [25, 1],
    ],
  );

  const burstRenderer = new Renderer(keyBurstProgram());
  burstRenderer.step(40, { keys: events });
  const bursts = burstsOf(burstRenderer).sort((a, b) => a.seq - b.seq);
  assert.deepEqual(
    bursts.map((burst) => [burst.born, burst.seq]),
    [
      [5, 0],
      [25, 1],
    ],
  );

  const tintRenderer = new Renderer(keyTintProgram());
  const frame = tintRenderer.step(40, { keys: events });
  assert.ok(frame[2][10].l > 0);
  assert.ok(frame[2][2].l > 0);
});

test('chords stay identical across steps 1/10/20/33/40', () => {
  for (const component of ['key_ring', 'key_burst', 'key_tint']) {
    assertCadenceInvariant(build({ component }), CHORD_EVENTS);
  }
});

test('presses 20 ms apart stay identical across steps 1/10/20/33/40', () => {
  const events = [
    { t: 5, type: 'down', cell: '2,10' },
    { t: 25, type: 'down', cell: '2,2' },
    { t: 300, type: 'up', cell: '2,10' },
    { t: 300, type: 'up', cell: '2,2' },
  ];
  for (const component of ['key_ring', 'key_burst', 'key_tint']) {
    assertCadenceInvariant(build({ component }), events);
  }
});

// Like the firmware: a full layer replaces its oldest burst, the lowest slot on
// a tie, so same-millisecond overflow keeps reusing slot 0.
test('key_burst with more presses than slots replaces bursts as the keyboard does', () => {
  const cells = ['2,3', '3,2', '3,3', '3,4', '2,5', '4,5'];
  const events = [
    ...cells.map((cell) => ({ t: 151, type: 'down', cell })),
    ...cells.map((cell) => ({ t: 239, type: 'up', cell })),
  ];
  const program = keyBurstProgram();
  const renderer = new Renderer(program);
  renderer.step(160, { keys: events });
  const seqs = burstsOf(renderer)
    .map((burst) => burst.seq)
    .sort((a, b) => a - b);
  assert.deepEqual(seqs, [1, 2, 3, 5]);
  assertCadenceInvariant(program, events);
});
