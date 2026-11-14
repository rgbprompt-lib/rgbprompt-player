import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validate } from '../src/validate.ts';
import { normalize } from '../src/normalize.ts';
import { loadBoard } from '../src/surfaces.ts';
import { Renderer, simulate } from '../src/render.ts';
import { axisValue, hsvToRgb } from '../src/color.ts';
import { bakeEasing, easeAt } from '../src/timing.ts';
import { encode, decode } from '../src/lep.ts';
import { programToDsl } from '../src/roundtrip.ts';

const board = loadBoard();
function build(dsl) {
  const report = validate(dsl, { board });
  assert.equal(report.ok, true, `valid: ${report.errors.join('; ')}`);
  return normalize(dsl, board);
}
const wrap = (layer) => ({
  schema: 'lep.effect/1',
  meta: { name: 't', author: 't', generator: 'human', seed: 1 },
  layer: [layer],
});

function light(cell) {
  return Math.max(
    Math.floor((cell.r * cell.l) / 100),
    Math.floor((cell.g * cell.l) / 100),
    Math.floor((cell.b * cell.l) / 100),
  );
}

test('ripple catches up after skipped ticks and limits simultaneous waves', () => {
  const program = build(
    wrap({
      id: 'r',
      component: 'ripple',
      surface: { type: 'all' },
      trigger: { type: 'key_press' },
      params: { speed: 2, max_waves: 1 },
    }),
  );
  const regular = new Renderer(program),
    skipped = new Renderer(program);
  const press = {
    keys: [
      { t: 0, type: 'down', cell: '2,5' },
      { t: 0, type: 'down', cell: '2,9' },
    ],
  };
  regular.step(0, press);
  skipped.step(0, press);
  assert.equal(skipped.rippleSlotsByLayer.flat().filter(Boolean).length, 1);
  for (let t = 1; t <= 499; t++) regular.step(t, {});
  skipped.step(499, {});
  assert.deepEqual(skipped.step(500, {}), regular.step(500, {}));
});

test('key rings originate at pressed keys, expire, and respect surface and capacity', () => {
  const program = build(
    wrap({
      id: 'r',
      component: 'key_ring',
      surface: { type: 'cells', cells: ['2,5', '2,6', '2,7'] },
      trigger: { type: 'key_press' },
      color: { type: 'solid', rgb: [200, 10, 20] },
      params: { life_ms: 300, max_waves: 1 },
    }),
  );
  const renderer = new Renderer(program);
  const frame = renderer.step(0, {
    keys: [
      { t: 0, type: 'down', cell: '0,0' },
      { t: 0, type: 'down', cell: '2,5' },
      { t: 0, type: 'down', cell: '2,7' },
    ],
  });
  assert.equal(frame[2][5].r, 200);
  assert.equal(renderer.keyRings[0].rings.filter(Boolean).length, 1);
  renderer.step(300, {});
  assert.equal(renderer.keyRings[0].rings.filter(Boolean).length, 0);
});

test('falling blocks deposit into a persistent grid and reset with a new renderer', () => {
  const program = build(
    wrap({ id: 'b', component: 'block_stack', surface: { type: 'all' }, params: { step_ms: 50 } }),
  );
  const renderer = new Renderer(program);
  for (let tick = 0; tick <= 500; tick += 50) renderer.step(tick, {});
  assert.ok(renderer.blockStacks[0].grid.flat().some(Boolean));
  const reset = new Renderer(program);
  assert.ok(reset.blockStacks[0].grid.flat().every((x) => x === 0));
});

test('integer HSV matches expected primaries', () => {
  assert.deepEqual(hsvToRgb(0, 255, 255), [255, 0, 0]);
  assert.deepEqual(hsvToRgb(120, 255, 255), [0, 255, 0]);
  assert.deepEqual(hsvToRgb(180, 255, 255), [0, 255, 255]);
  assert.deepEqual(hsvToRgb(240, 255, 255), [0, 0, 255]);
  assert.deepEqual(hsvToRgb(60, 255, 255), [255, 255, 0]);
});

test('hue_cycle rotates hue by period deterministically', () => {
  const program = build(
    wrap({
      id: 'h',
      component: 'static',
      surface: { type: 'all' },
      color: { type: 'hue_cycle', period_ms: 2000, saturation: 255, value: 255 },
    }),
  );
  const r = new Renderer(program);
  const f0 = r.step(0, {});
  assert.deepEqual([f0[0][0].r, f0[0][0].g, f0[0][0].b], [255, 0, 0]);
  const f1 = r.step(1000, {}); // s=500 -> hue 180 -> cyan
  assert.deepEqual([f1[0][0].r, f1[0][0].g, f1[0][0].b], [0, 255, 255]);
});

test('radial axis is integer and monotonic from centre', () => {
  assert.equal(axisValue(0, 0, 'radial'), 1000); // corner is farthest
  const centre = axisValue(3, 10, 'radial');
  const mid = axisValue(2, 5, 'radial');
  assert.ok(centre < mid && mid < 1000, `c=${centre} m=${mid}`);
});

test('radial gradient renders deterministically (fixed endpoints)', () => {
  const program = build(
    wrap({
      id: 'g',
      component: 'gradient',
      surface: { type: 'all' },
      color: {
        type: 'ramp',
        colors: [
          [0, 0, 0],
          [255, 255, 255],
        ],
        axis: 'radial',
      },
    }),
  );
  const f = new Renderer(program).step(0, {});
  assert.deepEqual([f[0][0].r, f[0][0].g, f[0][0].b], [255, 255, 255]); // farthest -> white
});

test('rainbow_wave animates when stepping in real time', () => {
  const program = build(
    wrap({
      id: 'rb',
      component: 'rainbow_wave',
      surface: { type: 'all' },
      params: { period_ms: 4000, axis: 'x', direction: 'forward', palette: 'rainbow24' },
    }),
  );
  const slow = simulate(program, { ticks: 2, stepMs: 1 }); // 1ms apart: negligible change
  const real = simulate(program, { ticks: 2, stepMs: 40 }); // 40ms apart: clearly moves
  assert.deepEqual(slow[0], slow[1]);
  assert.notDeepEqual(real[0], real[1]);
});

test('spiral renders rotating arms and changes over time', () => {
  const program = build(
    wrap({
      id: 'sp',
      component: 'spiral',
      surface: { type: 'all' },
      params: { period_ms: 2000, arms: 2, twist: 1000, beam: 240, palette: 'rainbow24' },
    }),
  );
  const frames = simulate(program, { ticks: 2, stepMs: 300 });
  const lit = frames[0].flat().filter((cell) => cell.l > 0).length;
  assert.ok(lit > 0, `spiral lit ${lit} cells`);
  assert.notDeepEqual(frames[0], frames[1]);
});

test('spiral soft edge fades while retaining hard-edge default', () => {
  const base = {
    id: 'sp',
    component: 'spiral',
    surface: { type: 'all' },
    params: { period_ms: 2000, arms: 4, twist: 1200, beam: 420, palette: 'rainbow24' },
  };
  const hard = new Renderer(build(wrap(base))).step(150, {});
  const soft = new Renderer(build(wrap({ ...base, params: { ...base.params, soft_edge: 120 } }))).step(
    150,
    {},
  );
  const hardCells = hard.flat();
  const softCells = soft.flat();
  let faded = 0;
  let full = 0;
  for (let i = 0; i < hardCells.length; i++) {
    const h = light(hardCells[i]);
    const s = light(softCells[i]);
    if (h > 0 && s === h) full++;
    if (h > 0 && s > 0 && s < h) faded++;
  }
  assert.ok(full > 0, 'soft edge still has core pixels at full intensity');
  assert.ok(faded > 0, 'soft edge fades cells that the hard beam lights fully');
});

test('frame_sequence plays inline frames with hold and loop', () => {
  const program = normalize(
    wrap({
      id: 'fs',
      component: 'frame_sequence',
      surface: { type: 'all' },
      params: { fps: 20, loop: true, speed: 2 },
      frames: [
        { hold: 2, points: [[0, 0, 255, 0, 0, 100]] },
        { hold: 2, points: [[0, 1, 0, 255, 0, 100]] },
      ],
    }),
    board,
  );
  const frames = simulate(program, { ticks: 5 });
  assert.equal(frames[0][0][0].r, 255); // frame 0
  assert.equal(frames[0][0][1].l, 0);
  assert.equal(frames[2][0][1].g, 255); // frame 1
  assert.equal(frames[2][0][0].l, 0);
  assert.equal(frames[4][0][0].r, 255); // looped back to frame 0
});

test('baked easing: endpoints 0..1000 and monotonic', () => {
  const specs = [
    'linear',
    'sine',
    'pulse',
    'ease-in',
    'ease-out',
    'ease-in-out',
    { bezier: [0.42, 0, 0.58, 1] },
  ];
  for (const spec of specs) {
    const lut = bakeEasing(spec);
    assert.equal(lut[0], 0, `${JSON.stringify(spec)} start`);
    assert.equal(lut[lut.length - 1], 1000, `${JSON.stringify(spec)} end`);
    for (let i = 1; i < lut.length; i++)
      assert.ok(lut[i] >= lut[i - 1], `${JSON.stringify(spec)} monotonic at ${i}`);
  }
});

test('easeAt interpolates a LUT', () => {
  const lut = [0, 500, 1000];
  assert.equal(easeAt(lut, 0), 0);
  assert.equal(easeAt(lut, 1000), 1000);
  assert.ok(Math.abs(easeAt(lut, 500) - 500) <= 5);
});

test('breath honours custom bezier easing and survives lep round trip', () => {
  const program = build(
    wrap({
      id: 'b',
      component: 'breath',
      surface: { type: 'all' },
      color: { type: 'solid', rgb: [255, 255, 255] },
      time: { type: 'breath', period_ms: 2000, easing: { bezier: [0.9, 0.1, 0.1, 0.9] } },
    }),
  );
  assert.ok(Array.isArray(program.layers[0].lut) && program.layers[0].lut.length === 33);
  const buf = encode(program);
  const { program: dec } = decode(buf);
  assert.deepEqual(dec.layers[0].lut, program.layers[0].lut);
  const a = simulate(program, { ticks: 40, stepMs: 40 });
  const b = simulate(dec, { ticks: 40, stepMs: 40 });
  assert.deepEqual(b, a);
});

test('import: .lep -> DSL reproduces rendering exactly', () => {
  const dsl = {
    schema: 'lep.effect/1',
    meta: { name: 'RT', author: 't', generator: 'human', seed: 42 },
    layer: [
      {
        id: 'base',
        component: 'gradient',
        surface: { type: 'all' },
        color: {
          type: 'ramp',
          colors: [
            [0, 255, 255],
            [255, 0, 255],
          ],
          axis: 'x',
        },
      },
      {
        id: 'pulse',
        component: 'breath',
        surface: { type: 'all' },
        time: { type: 'breath', period_ms: 2400, easing: { bezier: [0.9, 0.1, 0.1, 0.9] }, min_level: 15 },
        blend: 'mask',
      },
      {
        id: 'rx',
        component: 'reactive',
        surface: { type: 'regions', regions: ['wasd'] },
        trigger: { type: 'key_press' },
        color: { type: 'random', palette: 'rainbow24' },
        blend: 'add',
        params: { speed: 2 },
      },
    ],
  };
  const program = build(dsl);
  const decoded = decode(encode(program));
  const back = programToDsl(decoded.program, decoded.meta);
  const report = validate(back, { board });
  assert.equal(report.ok, true, report.errors.join('; '));
  const program2 = normalize(back, board);
  const sim = { ticks: 40, stepMs: 40, keyEvents: [{ tick: 200, type: 'down', cell: '2,2' }] };
  assert.deepEqual(simulate(program2, sim), simulate(program, sim));
});

test('frame_sequence survives lep round trip', () => {
  const program = normalize(
    wrap({
      id: 'fs',
      component: 'frame_sequence',
      surface: { type: 'all' },
      params: { fps: 20, loop: true, speed: 2 },
      frames: [
        {
          hold: 3,
          points: [
            [1, 2, 10, 20, 30, 100],
            [1, 3, 40, 50, 60, 80],
          ],
        },
        { hold: 1, points: [[2, 2, 70, 80, 90, 100]] },
      ],
    }),
    board,
  );
  const buf = encode(program);
  const { program: dec } = decode(buf);
  assert.deepEqual(dec.layers[0].frames, program.layers[0].frames);
  const a = simulate(program, { ticks: 6 });
  const b = simulate(dec, { ticks: 6 });
  assert.deepEqual(b, a);
});
