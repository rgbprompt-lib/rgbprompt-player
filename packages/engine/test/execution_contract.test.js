import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

import { normalize } from '../src/normalize.ts';
import { encode } from '../src/lep.ts';
import { simulate } from '../src/render.ts';
import { validate } from '../src/validate.ts';
import { validateForFirmware } from '../src/firmware.ts';
import { deviceDocument } from '../src/device_doc.ts';
import { EXECUTION_CONTRACT, executionIssues } from '../src/execution.ts';

const meta = { name: 'contract', author: 'test', generator: 'human', seed: 7 };
const effect = (...layer) => ({ schema: 'lep.effect/1', meta: { ...meta }, layer });
const all = { type: 'all' };
const solid = (rgb) => ({ type: 'solid', rgb });
const bytes = (dsl) => Buffer.from(encode(normalize(dsl)));
const lit = (frames) => frames.some((frame) => frame.some((row) => row.some((cell) => cell.l > 0)));
const frames = (dsl, sim) => {
  const out = [];
  simulate(normalize(dsl), { ticks: 120, stepMs: 20, ...sim }, (_, frame) =>
    out.push(structuredClone(frame)),
  );
  return out;
};
const codes = (dsl) => validateForFirmware(dsl).errors?.map((e) => e.code) ?? [];
const productOk = (dsl) => validate(dsl, { mode: 'strict' }).ok;

test('the device document drops disabled layers, enabled and label', () => {
  const authored = effect(
    { id: 'off', component: 'static', surface: all, color: solid([9, 9, 9]), enabled: false },
    { id: 'a', label: 'Base', enabled: true, component: 'breath', surface: all, color: solid([10, 20, 30]) },
  );
  const doc = deviceDocument(authored);
  assert.equal(doc.layer.length, 1);
  assert.equal('enabled' in doc.layer[0], false);
  assert.equal('label' in doc.layer[0], false);
  const plain = effect({ id: 'a', component: 'breath', surface: all, color: solid([10, 20, 30]) });
  assert.ok(bytes(authored).equals(bytes(plain)));
});

test('regions surfaces reach the wire as the cells they name', () => {
  const regions = effect({
    id: 'a',
    component: 'static',
    surface: { type: 'regions', regions: ['wasd'] },
    color: solid([1, 2, 3]),
  });
  const doc = deviceDocument(regions);
  assert.equal(doc.layer[0].surface.type, 'cells');
  assert.equal(doc.meta.region_profile, undefined);
  const cells = effect({
    id: 'a',
    component: 'static',
    surface: doc.layer[0].surface,
    color: solid([1, 2, 3]),
  });
  assert.ok(bytes(regions).equals(bytes(cells)));
});

test('every document the firmware export accepts passes the execution contract', () => {
  const dsl = effect({
    id: 'a',
    component: 'wave',
    surface: all,
    color: solid([0, 90, 255]),
    params: { direction: 'reverse' },
  });
  assert.equal(validateForFirmware(dsl).ok, true);
  assert.deepEqual(executionIssues(deviceDocument(dsl)), []);
  assert.equal(EXECUTION_CONTRACT.profile, 'composable-v1');
});

test('enum aliases that share a wire value are rejected', () => {
  for (const direction of ['horizontal', 'vertical']) {
    const dsl = effect({
      id: 'a',
      component: 'wave',
      surface: all,
      color: solid([0, 90, 255]),
      params: { direction },
    });
    assert.equal(validate(dsl, { mode: 'strict' }).ok, false, direction);
  }
});

test('contract rules the firmware enforces are firmware export errors (ADR-0017)', () => {
  const ramp = (extra = {}) => ({
    type: 'ramp',
    colors: [
      [255, 0, 0],
      [255, 200, 0],
    ],
    ...extra,
  });
  // fire takes a bare ramp: no axis, 2..32 stops
  assert.ok(
    codes(effect({ id: 'a', component: 'fire', surface: all, color: ramp({ axis: 'x' }) })).length > 0,
  );
  assert.ok(
    codes(
      effect({ id: 'a', component: 'fire', surface: all, color: { type: 'ramp', colors: [[255, 0, 0]] } }),
    ).length > 0,
  );
  assert.deepEqual(codes(effect({ id: 'a', component: 'fire', surface: all, color: ramp() })), []);
  // static has no key trigger
  assert.ok(
    codes(
      effect({
        id: 'a',
        component: 'static',
        surface: all,
        color: solid([1, 2, 3]),
        trigger: { type: 'key_press' },
      }),
    ).includes('TRIGGER_INVALID'),
  );
  // random colour is a reactive-only colour
  assert.ok(
    codes(
      effect({ id: 'a', component: 'gradient', surface: all, color: { type: 'random', palette: 'seven' } }),
    ).includes('COLOR_UNSUPPORTED'),
  );
  // at least one layer must stay enabled
  assert.ok(
    codes(effect({ id: 'a', component: 'static', surface: all, color: solid([1, 2, 3]), enabled: false }))
      .length > 0,
  );
});

const ripple = (id, rgb, extra = {}) => ({
  id,
  component: 'ripple',
  surface: all,
  color: solid(rgb),
  trigger: { type: 'key_press', scope: 'all' },
  ...extra,
});

test('firmware-only limits do not bind the product validator (ADR-0017)', () => {
  const twoRipples = effect(ripple('a', [255, 0, 0]), ripple('b', [0, 0, 255]));
  assert.equal(productOk(twoRipples), true);
  assert.ok(codes(twoRipples).length > 0, 'the export still enforces one ripple layer');
  const randomGradient = effect({
    id: 'a',
    component: 'gradient',
    surface: all,
    color: { type: 'random', palette: 'seven' },
  });
  assert.equal(productOk(randomGradient), true);
  assert.ok(codes(randomGradient).includes('COLOR_UNSUPPORTED'));
  const threshold = effect({
    id: 'a',
    component: 'spectrum',
    surface: all,
    trigger: { type: 'audio', threshold: 0.4 },
  });
  assert.equal(productOk(threshold), true);
  const off = effect({ id: 'a', component: 'static', surface: all, color: solid([1, 2, 3]), enabled: false });
  assert.equal(productOk(off), true);
});

test('two ripple layers keep their own key state', () => {
  const press = {
    keyEvents: [
      { tick: 10, type: 'down', cell: '3,5' },
      { tick: 14, type: 'up', cell: '3,5' },
    ],
  };
  const red = effect(ripple('a', [255, 0, 0]));
  const both = effect(ripple('a', [255, 0, 0]), ripple('b', [0, 0, 255], { blend: 'add' }));
  const one = frames(red, press);
  const two = frames(both, press);
  const blueSeen = two.some((f) => f.some((row) => row.some((c) => c.b > 0 && c.l > 0)));
  const redSeen = two.some((f) => f.some((row) => row.some((c) => c.r > 0 && c.l > 0)));
  assert.equal(lit(one), true);
  assert.equal(redSeen && blueSeen, true, 'both ripple layers draw the press');
});

test('a key layer reacts only to keys on its surface unless its scope is all', () => {
  const press = {
    keyEvents: [
      { tick: 10, type: 'down', cell: '3,5' },
      { tick: 14, type: 'up', cell: '3,5' },
    ],
  };
  const layer = (scope) =>
    effect({
      id: 'a',
      component: 'ripple',
      surface: { type: 'cells', cells: ['0,4', '0,5', '0,6', '1,4', '1,5', '1,6'] },
      color: solid([255, 255, 255]),
      trigger: { type: 'key_press', ...(scope ? { scope } : {}) },
    });
  assert.equal(validate(layer(), { mode: 'strict' }).ok, true);
  assert.equal(lit(frames(layer(), press)), false, 'default scope is the surface');
  assert.equal(lit(frames(layer('all'), press)), true, 'scope all reacts to every key');
});

test('key_ring board_center rings start at the board centre whichever key is pressed', () => {
  const ring = effect({
    id: 'a',
    component: 'key_ring',
    surface: all,
    color: solid([0, 255, 0]),
    trigger: { type: 'key_press' },
    params: { origin: 'board_center', max_radius: 16 },
  });
  const at = (cell) =>
    frames(ring, {
      keyEvents: [
        { tick: 5, type: 'down', cell },
        { tick: 8, type: 'up', cell },
      ],
    });
  const left = at('1,1');
  assert.equal(lit(left), true);
  assert.deepEqual(at('4,15'), left);
});

test('mote seeds at or above 2^31 run as the firmware u32 seed', () => {
  const mote = (seed) => ({
    ...effect({ id: 'a', component: 'mote', surface: all, color: solid([255, 120, 0]) }),
    meta: { ...meta, seed },
  });
  const high = frames(mote(4268958413));
  assert.equal(lit(high), true);
  assert.deepEqual(frames(mote(4268958413)), high);
});
