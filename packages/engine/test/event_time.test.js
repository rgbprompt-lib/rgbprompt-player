import test from 'node:test';
import assert from 'node:assert/strict';

import { validate } from '../src/validate.ts';
import { normalize } from '../src/normalize.ts';
import { loadBoard } from '../src/surfaces.ts';
import { Renderer, simulate } from '../src/render.ts';
import { hash32 } from '../src/rng.ts';

const board = loadBoard();

function build(layer) {
  const dsl = {
    schema: 'lep.effect/1',
    meta: { name: 'event time', author: 'test', generator: 'human', seed: 7 },
    layer: [{ id: 'a', surface: { type: 'all' }, ...layer }],
  };
  const report = validate(dsl, { board });
  assert.equal(report.ok, true, `valid: ${report.errors.join('; ')}`);
  return normalize(dsl, board);
}

// Copied from tools/golden/corpus.mjs so the engine tests exercise the same
// input scripts as the golden vectors.
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

const DENSE_TYPING_SCRIPT = [
  { tick: 37, type: 'down', cell: '2,3' },
  { tick: 37, type: 'down', cell: '2,5' },
  { tick: 37, type: 'down', cell: '3,7' },
  { tick: 97, type: 'up', cell: '2,3' },
  { tick: 97, type: 'up', cell: '2,5' },
  { tick: 97, type: 'up', cell: '3,7' },
  { tick: 101, type: 'down', cell: '3,2' },
  { tick: 104, type: 'down', cell: '3,3' },
  { tick: 108, type: 'down', cell: '3,4' },
  { tick: 113, type: 'up', cell: '3,2' },
  { tick: 119, type: 'up', cell: '3,3' },
  { tick: 126, type: 'up', cell: '3,4' },
  { tick: 151, type: 'down', cell: '2,3' },
  { tick: 151, type: 'down', cell: '3,2' },
  { tick: 151, type: 'down', cell: '3,3' },
  { tick: 151, type: 'down', cell: '3,4' },
  { tick: 151, type: 'down', cell: '2,5' },
  { tick: 151, type: 'down', cell: '4,5' },
  { tick: 239, type: 'up', cell: '2,3' },
  { tick: 239, type: 'up', cell: '3,2' },
  { tick: 239, type: 'up', cell: '3,3' },
  { tick: 239, type: 'up', cell: '3,4' },
  { tick: 239, type: 'up', cell: '2,5' },
  { tick: 239, type: 'up', cell: '4,5' },
  { tick: 325, type: 'down', cell: '2,6' },
  { tick: 345, type: 'down', cell: '3,7' },
  { tick: 385, type: 'up', cell: '2,6' },
  { tick: 395, type: 'up', cell: '3,7' },
  { tick: 401, type: 'down', cell: '2,6' },
  { tick: 407, type: 'up', cell: '2,6' },
  { tick: 501, type: 'down', cell: '3,7' },
  { tick: 501, type: 'up', cell: '3,7' },
  { tick: 501, type: 'down', cell: '2,5' },
  { tick: 501, type: 'up', cell: '2,5' },
];

function frameMap(program, stepMs, keyEvents, durationMs) {
  const frames = simulate(program, {
    ticks: Math.floor(durationMs / stepMs) + 1,
    stepMs,
    keyEvents,
  });
  const byTick = new Map();
  frames.forEach((frame, index) => byTick.set(index * stepMs, frame));
  return byTick;
}

const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
const lcm = (a, b) => (a * b) / gcd(a, b);

function assertCadenceInvariant(program, keyEvents, durationMs, label) {
  const steps = [1, 7, 10, 20, 33, 40];
  const maps = new Map(steps.map((stepMs) => [stepMs, frameMap(program, stepMs, keyEvents, durationMs)]));
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

test('event-time primitives are cadence-invariant with the corpus typing script', () => {
  for (const component of ['reactive', 'ripple', 'ripple_square', 'aurora']) {
    const program = build({ component });
    assertCadenceInvariant(program, TYPING_SCRIPT, 6600, component);
  }
});

test('event-time primitives are cadence-invariant with the dense typing script', () => {
  for (const component of ['reactive', 'ripple', 'ripple_square', 'aurora']) {
    const program = build({ component });
    assertCadenceInvariant(program, DENSE_TYPING_SCRIPT, 2400, `${component} dense`);
  }
});

test('aurora is cadence-invariant at every speed interval, including 15 ms', () => {
  for (let speed = 0; speed < 5; speed++) {
    const program = build({ component: 'aurora', params: { speed } });
    assertCadenceInvariant(program, TYPING_SCRIPT, 2400, `aurora speed=${speed}`);
  }
});

test('a press between two frames is applied at its own timestamp', () => {
  const reactive = new Renderer(build({ component: 'reactive' }));
  reactive.step(120, { keys: [] });
  const reactiveFrame = reactive.step(140, { keys: [{ t: 137, type: 'down', cell: '2,3' }] });
  assert.equal(reactive.reactiveByLayer[0].get('2,3').born, 137);
  assert.ok(reactiveFrame[2][3].l > 0);

  const ripple = new Renderer(build({ component: 'ripple' }));
  ripple.step(120, { keys: [] });
  ripple.step(140, { keys: [{ t: 137, type: 'down', cell: '2,3' }] });
  assert.equal(ripple.rippleSlotsByLayer[0][0].born, 137);

  const aurora = new Renderer(build({ component: 'aurora' }));
  aurora.step(120, { keys: [] });
  const auroraFrame = aurora.step(140, { keys: [{ t: 137, type: 'down', cell: '2,3' }] });
  // event 137 is applied before boundary 140: the centre has already faded to
  // 90 and the wave-1 fronts are lit. Composable replace stores premultiplied
  // RGB at l=100, so compare effective light.
  const front = light(auroraFrame[2][2]);
  assert.equal(light(auroraFrame[2][3]), Math.floor((front * 90) / 100));
  assert.equal(light(auroraFrame[2][2]), front);
  assert.equal(light(auroraFrame[2][4]), front);
  assert.ok(front > 0);
});

test('a ripple dot retires at a boundary even when no frame lands on it', () => {
  const program = build({ component: 'ripple', params: { speed: 2, max_waves: 1 } });
  const renderer = new Renderer(program);
  renderer.step(0, { keys: [{ t: 0, type: 'down', cell: '2,10' }] });
  assert.ok(renderer.rippleSlotsByLayer[0][0]);
  renderer.step(1100, {});
  assert.ok(renderer.rippleSlotsByLayer[0][0]);
  const frame = renderer.step(1300, {});
  assert.equal(renderer.rippleSlotsByLayer[0][0], null);
  assert.ok(frame.every((row) => row.every((cell) => cell.l === 0)));
});

test('hash32 is stable', () => {
  assert.equal(hash32(7, 0x12345678, 2, 3, 137), 1507231882);
  assert.equal(hash32(1, 2, 3), 170535705);
  assert.equal(hash32(0xffffffff, 0x9e3779b9, 22, 5), 1583708316);
});

test('random colour is fixed per cell, varies across cells and never uses the shared RNG', () => {
  const program = build({
    component: 'gradient',
    color: { type: 'random', palette: 'seven' },
  });
  const renderer = new Renderer(program);
  const state = renderer.rng.s;
  const first = renderer.step(0, {});
  const later = renderer.step(137, {});
  const muchLater = renderer.step(1000, {});
  assert.equal(renderer.rng.s, state);
  assert.deepEqual(later, first);
  assert.deepEqual(muchLater, first);

  const colours = new Set();
  for (const row of first) for (const cell of row) colours.add(`${cell.r},${cell.g},${cell.b}`);
  assert.ok(colours.size > 1, 'different cells can get different palette entries');
});
