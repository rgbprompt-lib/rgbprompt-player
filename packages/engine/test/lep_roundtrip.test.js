import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalize } from '../src/normalize.ts';
import { encode, decode, PKG_VERSION } from '../src/lep.ts';
import { simulate } from '../src/render.ts';
import { encode as legacyEncode } from './fixtures/legacy-lep/lep.js';

const SEED = 7;

function makeEffect(layer) {
  return {
    schema: 'lep.effect/1',
    meta: { name: 'round trip', author: 'test', generator: 'human', seed: SEED },
    layer: [{ id: 'a', surface: { type: 'all' }, ...layer }],
  };
}

function versionOf(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(4, true);
}

function roundtrip(dsl, sim = {}) {
  const program = normalize(dsl);
  const bytes = encode(program);
  const decoded = decode(bytes);
  const input = { ticks: 250, stepMs: 20, ...sim };
  assert.deepEqual(simulate(decoded.program, input), simulate(program, input));
  return { program, bytes, decoded };
}

test('square ripple direction survives the .lep round trip', () => {
  const dsl = makeEffect({
    component: 'ripple',
    params: { speed: 4, max_waves: 3, direction: 'square' },
  });
  const { decoded } = roundtrip(dsl, {
    keyEvents: [{ tick: 100, type: 'down', cell: '2,3' }],
  });
  assert.equal(decoded.pkgVersion, 12);
  assert.equal(decoded.program.layers[0].params.direction, 'square');
});

test('drift motion period does not borrow time.period_ms', () => {
  const dsl = makeEffect({
    component: 'drift',
    time: { type: 'static', period_ms: 5000, phase_ms: 400 },
  });
  const { decoded } = roundtrip(dsl);
  assert.equal(decoded.pkgVersion, 12);
  assert.equal(decoded.program.layers[0].params.period_ms, 18000);
  assert.equal(decoded.program.layers[0].time.period_ms, 5000);
});

test('absent drift breath period is encoded with the renderer default', () => {
  const dsl = makeEffect({
    component: 'drift',
    time: { type: 'breath' },
  });
  const { decoded } = roundtrip(dsl);
  assert.equal(decoded.program.layers[0].params.period_ms, 18000);
  assert.equal(decoded.program.layers[0].time.period_ms, 3200);
});

test('an explicit zero drift breath period stays zero', () => {
  const dsl = makeEffect({
    component: 'drift',
    time: { type: 'breath', period_ms: 0 },
  });
  const { decoded } = roundtrip(dsl);
  assert.equal(decoded.program.layers[0].params.period_ms, 18000);
  assert.equal(decoded.program.layers[0].time.period_ms, 0);
});

test('rainbow_wave custom ramp colours survive the .lep round trip', () => {
  const colors = [
    [11, 22, 33],
    [44, 55, 66],
    [77, 88, 99],
  ];
  const dsl = makeEffect({
    component: 'rainbow_wave',
    params: { palette: 'custom' },
    color: { type: 'ramp', colors },
  });
  const { decoded } = roundtrip(dsl);
  assert.equal(decoded.pkgVersion, 12);
  assert.deepEqual(decoded.program.layers[0].color?.colors, colors);
});

test('reactive random colours round-trip by palette, without a custom block', () => {
  const dsl = makeEffect({
    component: 'reactive',
    trigger: { type: 'key_press' },
    color: { type: 'random', palette: 'seven' },
  });
  const { decoded } = roundtrip(dsl, { keyEvents: [{ tick: 20, type: 'down', cell: '2,3' }] });
  assert.equal(decoded.program.layers[0].color?.type, 'random');
  assert.equal(decoded.program.layers[0].color?.colors, undefined);
});

// The keyboard carries no custom colours for palette_index, so the chosen
// custom entry is written as its solid colour: same pixels, every engine.
test('palette_index custom colours reach the .lep as the chosen solid colour', () => {
  const colors = [
    [10, 20, 30],
    [200, 100, 50],
    [0, 255, 128],
  ];
  const dsl = makeEffect({
    component: 'gradient',
    color: { type: 'palette_index', palette: 'custom', colors, index: 1 },
  });
  const { decoded } = roundtrip(dsl);
  assert.equal(decoded.pkgVersion, 12);
  assert.deepEqual(decoded.program.layers[0].color, { type: 'solid', rgb: [200, 100, 50] });
});

test('v3 custom palette blocks stay aligned when a custom layer has no colours', () => {
  const dsl = {
    schema: 'lep.effect/1',
    meta: { name: 'mixed', author: 'test', generator: 'human', seed: SEED },
    layer: [
      {
        id: 'colors',
        component: 'gradient',
        surface: { type: 'all' },
        color: {
          type: 'palette_index',
          palette: 'custom',
          colors: [
            [10, 20, 30],
            [200, 100, 50],
          ],
          index: 1,
        },
      },
      {
        id: 'empty',
        component: 'gradient',
        surface: { type: 'all' },
        color: { type: 'palette_index', palette: 'custom', index: 0 },
        blend: 'add',
      },
    ],
  };
  const { decoded } = roundtrip(dsl);
  // The coloured layer is written as solid (see above); no custom block remains.
  assert.equal(decoded.pkgVersion, 12);
  assert.deepEqual(decoded.program.layers[0].color, { type: 'solid', rgb: [200, 100, 50] });
  assert.deepEqual(decoded.program.layers[1].color, {
    type: 'palette_index',
    palette: 'custom',
    index: 0,
  });
});

test('v2 palette_index custom files still decode as before', () => {
  const dsl = makeEffect({
    component: 'gradient',
    color: { type: 'palette_index', palette: 'custom', index: 1 },
  });
  const legacyBytes = legacyEncode(normalize(dsl));
  assert.equal(versionOf(legacyBytes), 2);
  const decoded = decode(legacyBytes);
  assert.equal(decoded.pkgVersion, 2);
  assert.equal(decoded.meta.execution_profile, 'composable-v1');
  assert.deepEqual(decoded.program.layers[0].color, {
    type: 'palette_index',
    palette: 'custom',
    index: 1,
  });
});

test('an effect without higher feature versions encodes as package 12', () => {
  const dsl = makeEffect({
    component: 'breath',
    color: { type: 'solid', rgb: [10, 200, 90] },
    params: { period_ms: 1500, min_level: 10 },
  });
  const bytes = encode(normalize(dsl));
  assert.equal(PKG_VERSION, 3);
  assert.equal(versionOf(bytes), 12);
});

test('ramp with the custom palette and no colours round-trips on v2', () => {
  const dsl = makeEffect({ component: 'gradient', color: { type: 'ramp', palette: 'custom' } });
  const { bytes } = roundtrip(dsl);
  assert.equal(versionOf(bytes), 12);
});

test('random custom colours survive the .lep round trip', () => {
  const colors = [
    [1, 2, 3],
    [4, 5, 6],
  ];
  const dsl = makeEffect({
    component: 'gradient',
    color: { type: 'random', palette: 'custom', colors },
  });
  const { decoded } = roundtrip(dsl);
  assert.equal(decoded.pkgVersion, 12);
  assert.deepEqual(decoded.program.layers[0].color, {
    type: 'random',
    palette: 'custom',
    colors,
  });
});

test('from_input custom colours survive the .lep round trip', () => {
  const colors = [
    [7, 8, 9],
    [10, 11, 12],
  ];
  const dsl = makeEffect({
    component: 'gradient',
    color: { type: 'from_input', palette: 'custom', colors, source: 'key_press' },
  });
  const { decoded } = roundtrip(dsl);
  assert.equal(decoded.pkgVersion, 12);
  assert.deepEqual(decoded.program.layers[0].color, {
    type: 'from_input',
    palette: 'custom',
    source: 'key_press',
    colors,
  });
});
