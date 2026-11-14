import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { validate } from '../src/validate.ts';
import { normalize, cellsToMask, maskToCells } from '../src/normalize.ts';
import { loadBoard } from '../src/surfaces.ts';
import { Renderer, simulate, levelToPhysical, composite, makeFrame } from '../src/render.ts';
import { Rng } from '../src/rng.ts';
import { encode, decode } from '../src/lep.ts';
import { rampColor } from '../src/color.ts';
import { LOGIC_ROWS, LOGIC_COLS } from '../src/constants.ts';

const board = loadBoard();
const exampleUrl = (name) => fileURLToPath(new URL(`../data/examples/${name}`, import.meta.url));
const loadExample = (name) => JSON.parse(readFileSync(exampleUrl(name), 'utf8'));

function build(dsl) {
  const report = validate(dsl, { board });
  assert.equal(report.ok, true, `expected valid: ${report.errors.join('; ')}`);
  return normalize(dsl, board);
}

function light(cell) {
  return Math.max(
    Math.floor((cell.r * cell.l) / 100),
    Math.floor((cell.g * cell.l) / 100),
    Math.floor((cell.b * cell.l) / 100),
  );
}

test('example DSLs validate', () => {
  for (const f of ['red-static.json', 'cyber-breath.json', 'party.json']) {
    const report = validate(loadExample(f), { board });
    assert.equal(report.ok, true, `${f}: ${report.errors.join('; ')}`);
  }
});

test('static red fills all cells', () => {
  const program = build(loadExample('red-static.json'));
  const r = new Renderer(program);
  const frame = r.step(0, {});
  for (let row = 0; row < LOGIC_ROWS; row++) {
    for (let col = 0; col < LOGIC_COLS; col++) {
      assert.deepEqual(frame[row][col], { r: 255, g: 0, b: 0, l: 100 });
    }
  }
});

test('breath sine hits min at t=0 and max at half period', () => {
  const dsl = {
    schema: 'lep.effect/1',
    meta: { name: 'b', author: 't', generator: 'human', seed: 1 },
    layer: [
      {
        id: 'l',
        component: 'breath',
        surface: { type: 'all' },
        time: { type: 'breath', period_ms: 2000, easing: 'sine', min_level: 10 },
      },
    ],
  };
  const program = build(dsl);
  const r = new Renderer(program);
  const f0 = r.step(0, {});
  // Composable replace writes premultiplied RGB at l=100. Default breath colour is white.
  assert.equal(light(f0[0][0]), Math.floor((255 * 10) / 100));
  const f1 = r.step(1000, {});
  assert.equal(light(f1[0][0]), 255);
});

test('gradient ramp endpoints and colour interpolation', () => {
  const dsl = {
    schema: 'lep.effect/1',
    meta: { name: 'g', author: 't', generator: 'human', seed: 1 },
    layer: [
      {
        id: 'l',
        component: 'gradient',
        surface: { type: 'all' },
        color: {
          type: 'ramp',
          colors: [
            [0, 0, 0],
            [255, 255, 255],
          ],
          axis: 'x',
        },
      },
    ],
  };
  const program = build(dsl);
  const r = new Renderer(program);
  const f = r.step(0, {});
  assert.deepEqual([f[0][0].r, f[0][0].g, f[0][0].b], [0, 0, 0]);
  assert.deepEqual([f[0][21].r, f[0][21].g, f[0][21].b], [255, 255, 255]);
  assert.deepEqual(
    rampColor(
      [
        [0, 0, 0],
        [255, 255, 255],
      ],
      500,
    ),
    [128, 128, 128],
  );
});

test('composite add saturates', () => {
  const dst = makeFrame();
  dst[0][0] = { r: 100, g: 10, b: 0, l: 60 };
  const src = makeFrame();
  // mark src touched
  const srcLayer = JSON.parse(JSON.stringify(src));
  srcLayer[0][0] = { r: 200, g: 0, b: 0, l: 100, on: true };
  composite(dst, srcLayer, 'add', 255);
  assert.equal(dst[0][0].r, 255);
  assert.equal(dst[0][0].l, 100);
});

test('rng is deterministic', () => {
  const a = new Rng(42);
  const b = new Rng(42);
  for (let i = 0; i < 100; i++) assert.equal(a.next(), b.next());
});

test('mask <-> cells round trip', () => {
  const cells = [
    [0, 1],
    [3, 5],
    [5, 21],
  ];
  const mask = cellsToMask(cells);
  assert.deepEqual(maskToCells(mask), cells);
});

test('lep encode/decode round trip preserves rendering', () => {
  const program = build(loadExample('cyber-breath.json'));
  const buf = encode(program);
  const { program: decoded } = decode(buf);
  assert.equal(decoded.layers.length, program.layers.length);
  assert.deepEqual(decoded.layers[0].cells, program.layers[0].cells);
  // semantic equivalence: identical rendered frames
  const fA = simulate(program, { ticks: 40 });
  const fB = simulate(decoded, { ticks: 40 });
  assert.deepEqual(fB, fA);
  // re-encode is byte-identical
  assert.deepEqual(encode(decoded), buf);
});

test('lep rejects corrupted crc', () => {
  const program = build(loadExample('red-static.json'));
  const buf = encode(program);
  buf[buf.length - 1] ^= 0xff;
  assert.throws(() => decode(buf), /crc/);
});

test('reactive lights a pressed key then decays', () => {
  const dsl = {
    schema: 'lep.effect/1',
    meta: { name: 'rx', author: 't', generator: 'human', seed: 7 },
    layer: [
      {
        id: 'rx',
        component: 'reactive',
        surface: { type: 'all' },
        trigger: { type: 'key_press' },
        color: { type: 'random', palette: 'rainbow24' },
        blend: 'add',
        params: { speed: 2 },
      },
    ],
  };
  const program = build(dsl);
  const frames = simulate(program, { ticks: 10, keyEvents: [{ tick: 0, type: 'down', cell: '1,2' }] });
  const lit = frames[0][1][2];
  const sum = (c) => c.r + c.g + c.b;
  assert.ok(sum(lit) > 0, 'lit on press');
  // eased envelope: effective light dims over time (colour fades)
  const later = frames[5][1][2];
  assert.ok(sum(later) < sum(lit), `later=${sum(later)} lit=${sum(lit)}`);
});

test('levelToPhysical matches docs formula', () => {
  assert.equal(levelToPhysical(100, 10), 100);
  assert.equal(levelToPhysical(100, 20), 200);
  assert.equal(levelToPhysical(0, 20), 0);
  assert.equal(levelToPhysical(50, 10), 50);
});
