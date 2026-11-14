// Parameters and the fire primitive ported from the upstream toolchain
// (ENGINE.md §5.3): validation shape, package versions and the .lep round trip.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalize } from '../src/normalize.ts';
import { encode, decode } from '../src/lep.ts';
import { simulate } from '../src/render.ts';
import { validate } from '../src/validate.ts';
import { waveProjection } from '../src/wave_geometry.ts';
import { spiralGeometry } from '../src/spiral_geometry.ts';

const press = { trigger: { type: 'key_press' } };
const lifecycleRamp = {
  type: 'ramp',
  colors: [
    [255, 255, 255],
    [255, 120, 0],
    [60, 0, 0],
  ],
};
const keyEvents = [
  { tick: 100, type: 'down', cell: '2,5' },
  { tick: 180, type: 'up', cell: '2,5' },
];

function makeEffect(layer, meta = {}) {
  return {
    schema: 'lep.effect/1',
    meta: { name: 'ported', author: 'test', generator: 'human', seed: 7, ...meta },
    layer: [{ id: 'a', surface: { type: 'all' }, ...layer }],
  };
}

function roundtrip(layer, sim = {}) {
  const dsl = makeEffect(layer);
  const report = validate(dsl);
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  const program = normalize(dsl);
  const decoded = decode(encode(program));
  const input = { ticks: 120, stepMs: 20, ...sim };
  assert.deepEqual(simulate(decoded.program, input), simulate(program, input));
  return decoded;
}

const codes = (layer) => validate(makeEffect(layer)).errors.map((error) => `${error.path} ${error.code}`);

function composablePackageVersion(version) {
  return version >= 14 ? version : Math.max(version, 12);
}

test('each ported feature picks its package version and survives the round trip', () => {
  const cases = [
    [
      3,
      { component: 'rainbow_wave', params: { width_pct: 40, wrap: 'reset', spatial_direction: 'reverse' } },
    ],
    [9, { component: 'rainbow_wave', params: { axis: 'angle', angle_deg: 35 } }],
    [10, { component: 'rainbow_wave', params: { spatial_direction: 'mirror' } }],
    [11, { component: 'rainbow_wave', params: { axis: 'uniform' } }],
    [7, { component: 'spiral', params: { center_x: 150, center_y: 900, color_twist: 1600 } }],
    [4, { component: 'fire', params: { direction: 'left', cooling: 20 } }],
    [13, { component: 'key_ring', ...press, params: { max_radius: 16, origin: 'board_center' } }],
  ];
  for (const [version, layer] of cases) {
    const decoded = roundtrip(layer, { keyEvents });
    assert.equal(decoded.pkgVersion, composablePackageVersion(version), JSON.stringify(layer));
    for (const [key, value] of Object.entries(layer.params))
      assert.equal(decoded.program.layers[0].params[key], value, `${layer.component}.${key}`);
  }
});

test('defaults keep the earlier encoding', () => {
  for (const component of ['rainbow_wave', 'spiral', 'reactive']) {
    const decoded = roundtrip({ component, ...(component === 'reactive' ? press : {}) }, { keyEvents });
    assert.equal(decoded.pkgVersion, composablePackageVersion(2), component);
  }
});

test('the highest feature version wins and custom ramp colours are kept', () => {
  const dsl = makeEffect({ component: 'fire' });
  dsl.layer.push({
    id: 'b',
    component: 'gradient',
    surface: { type: 'all' },
    blend: 'add',
    color: {
      type: 'ramp',
      axis: 'x',
      colors: [
        [1, 2, 3],
        [4, 5, 6],
      ],
    },
  });
  dsl.layer.push({
    id: 'c',
    component: 'spiral',
    surface: { type: 'all' },
    blend: 'add',
    params: { color_twist: 0 },
  });
  const program = normalize(dsl);
  const decoded = decode(encode(program));
  assert.equal(decoded.pkgVersion, composablePackageVersion(7));
  assert.deepEqual(decoded.program.layers[1].color.colors, [
    [1, 2, 3],
    [4, 5, 6],
  ]);
  const input = { ticks: 60, stepMs: 20 };
  assert.deepEqual(simulate(decoded.program, input), simulate(program, input));
});

test('reactive lifecycle plays the ramp once per press and then goes dark', () => {
  const layer = {
    component: 'reactive',
    ...press,
    color: lifecycleRamp,
    params: { color_mode: 'lifecycle', duration_ms: 600 },
  };
  const decoded = roundtrip(layer, { keyEvents });
  assert.equal(decoded.pkgVersion, composablePackageVersion(6));
  assert.equal(decoded.program.layers[0].params.palette, 'custom');
  const program = normalize(makeEffect(layer));
  const frames = simulate(program, { ticks: 40, stepMs: 20, keyEvents });
  const cellAt = (tick) => frames[tick / 20][2][5];
  assert.deepEqual([cellAt(100).r, cellAt(100).g, cellAt(100).b], [255, 255, 255]);
  assert.deepEqual([cellAt(400).r, cellAt(400).g, cellAt(400).b], [255, 120, 0]);
  assert.equal(cellAt(700).l ?? 0, 0);
  assert.equal(cellAt(80).l ?? 0, 0);
});

test('reactive lifecycle is the same at 20 ms and 40 ms steps', () => {
  const program = normalize(
    makeEffect({
      component: 'reactive',
      ...press,
      color: lifecycleRamp,
      params: { color_mode: 'lifecycle' },
    }),
  );
  const fine = simulate(program, { ticks: 100, stepMs: 20, keyEvents });
  const coarse = simulate(program, { ticks: 50, stepMs: 40, keyEvents });
  coarse.forEach((frame, index) => assert.deepEqual(frame, fine[index * 2], `frame ${index}`));
});

test('fire is the same at 20 ms and 40 ms steps and stays inside its surface', () => {
  const program = normalize(
    makeEffect({ component: 'fire', surface: { type: 'cells', cells: ['1,3', '2,3', '3,3', '2,4'] } }),
  );
  const fine = simulate(program, { ticks: 200, stepMs: 20 });
  const coarse = simulate(program, { ticks: 100, stepMs: 40 });
  coarse.forEach((frame, index) => assert.deepEqual(frame, fine[index * 2], `frame ${index}`));
});

test('validation rejects combinations the wire format cannot carry', () => {
  assert.deepEqual(codes({ component: 'rainbow_wave', params: { angle_deg: 30 } }), [
    'layer[0].params.angle_deg PARAM_CONFLICT',
  ]);
  assert.deepEqual(codes({ component: 'rainbow_wave', params: { axis: 'uniform', width_pct: 50 } }), [
    'layer[0].params.axis PARAM_CONFLICT',
  ]);
  assert.deepEqual(codes({ component: 'rainbow_wave', params: { axis: 'diagonal' } }), [
    'layer[0].params.axis PARAM_TYPE',
  ]);
  assert.deepEqual(codes({ component: 'reactive', ...press, params: { duration_ms: 400 } }), [
    'layer[0].params.duration_ms PARAM_CONFLICT',
  ]);
  assert.deepEqual(codes({ component: 'reactive', ...press, color: lifecycleRamp }), [
    'layer[0].color.type COLOR_UNSUPPORTED',
  ]);
  assert.deepEqual(codes({ component: 'reactive', ...press, params: { color_mode: 'lifecycle' } }), [
    'layer[0].color COLOR_INVALID',
  ]);
  assert.deepEqual(
    codes({ component: 'reactive', color: lifecycleRamp, params: { color_mode: 'lifecycle' } }),
    ['layer[0].trigger.type TRIGGER_INVALID'],
  );
  assert.deepEqual(codes({ component: 'fire', color: { type: 'solid', rgb: [255, 0, 0] } }), [
    'layer[0].color COLOR_INVALID',
  ]);
  assert.deepEqual(codes({ component: 'fire', ...press }), ['layer[0].trigger TRIGGER_INVALID']);
  assert.deepEqual(codes({ component: 'fire', params: { direction: 'north' } }), [
    'layer[0].params.direction PARAM_TYPE',
  ]);
  assert.deepEqual(codes({ component: 'key_ring', ...press, params: { max_radius: 23 } }), [
    'layer[0].params.max_radius PARAM_RANGE',
  ]);
});

test('wave projection and spiral geometry keep their anchor values', () => {
  assert.equal(waveProjection(0, 0, 0), 0);
  assert.equal(waveProjection(0, 11, 0), 500);
  assert.equal(waveProjection(3, 0, 90), 500);
  assert.equal(waveProjection(0, 11, 180), -500);
  assert.equal(waveProjection(0, 11, 0, 100, 1, true), 0);
  assert.equal(waveProjection(0, 0, 0, 100, 1, true), 1000);
  const moved = spiralGeometry(0, 0);
  assert.equal(moved.radius[0][0], 0);
  assert.equal(moved.radius[5][21], 1000);
  assert.deepEqual(spiralGeometry(500, 500).radius[0][0], 1000);
});
