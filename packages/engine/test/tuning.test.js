import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CAPABILITIES } from '../src/capabilities.ts';
import { describe, nearestColorName } from '../src/describe.ts';
import { applyTuning, tuningSchema } from '../src/tuning.ts';
import { validate } from '../src/validate.ts';

const RAIN_COLORS = [
  [81, 179, 246],
  [246, 81, 191],
  [168, 216, 240],
  [25, 75, 240],
  [255, 45, 190],
];

const meta = { name: 'tuning', author: 'test', generator: 'human', seed: 7 };
const solid = (rgb) => ({ type: 'solid', rgb });

function effect(layer) {
  return {
    schema: 'lep.effect/1',
    meta: { ...meta },
    layer: [{ id: 'a', component: 'static', surface: { type: 'all' }, color: solid([10, 20, 30]), ...layer }],
  };
}

function layerFor(component) {
  const layer = { id: 'a', component, surface: { type: 'all' } };
  if (component === 'rain') {
    layer.color = { type: 'ramp', axis: 'x', colors: RAIN_COLORS.map((stop) => [...stop]) };
  } else if (component === 'fire') {
    layer.color = { type: 'ramp', colors: RAIN_COLORS.map((stop) => [...stop]) };
  } else {
    layer.color = solid([10, 20, 30]);
  }
  return layer;
}

const EXPECTED_KINDS = {
  static: ['single', 'area'],
  gradient: ['single', 'area', 'direction'],
  breath: ['single', 'speed', 'area'],
  blink: ['single', 'speed', 'area'],
  rainbow_wave: ['single', 'speed', 'area', 'direction'],
  wave: ['single', 'speed', 'area', 'direction'],
  scroll: ['single', 'speed', 'area', 'direction'],
  sparkle: ['single', 'speed', 'area'],
  drift: ['single', 'speed', 'area', 'direction'],
  ring: ['single', 'speed', 'area', 'direction'],
  key_ring: ['single', 'speed', 'area', 'direction'],
  mote: ['single', 'speed', 'area', 'direction'],
  reactive: ['single', 'speed', 'area'],
  ripple: ['single', 'speed', 'area', 'direction'],
  ripple_square: ['single', 'speed', 'area'],
  aurora: ['single', 'speed', 'area'],
  spectrum: ['single', 'speed', 'area'],
  spectrum_mirror: ['single', 'area'],
  spectrum_sum: ['single', 'area'],
  key_tint: ['single', 'area'],
  spiral: ['single', 'speed', 'area', 'direction'],
  block_stack: ['single', 'speed', 'area'],
  key_burst: ['single', 'speed', 'area'],
  rain: ['stops', 'speed', 'area'],
  fire: ['stops', 'speed', 'area', 'direction'],
};

test('tuningSchema covers every v1-open primitive with stable control kinds', () => {
  assert.deepEqual(Object.keys(CAPABILITIES).sort(), Object.keys(EXPECTED_KINDS).sort());
  for (const component of Object.keys(EXPECTED_KINDS)) {
    const schema = tuningSchema(effect(layerFor(component)));
    assert.equal(schema.length, 1, component);
    assert.deepEqual(
      schema[0].controls.map((control) => control.kind),
      EXPECTED_KINDS[component],
      component,
    );
  }
});

test('tuningSchema uses a palette control when the layer has no explicit color', () => {
  const schema = tuningSchema(
    effect({
      id: 'a',
      component: 'ring',
      surface: { type: 'all' },
      color: undefined,
      params: { palette: 'seven' },
    }),
  );
  const color = schema[0].controls[0];
  assert.deepEqual(color, { kind: 'palette', palette: 'seven' });
});

test('tuningSchema reports custom areas for cells/rows/cols surfaces', () => {
  const schema = tuningSchema(effect({ surface: { type: 'cells', cells: ['0,0'] } }));
  const area = schema[0].controls.find((control) => control.kind === 'area');
  assert.deepEqual(area, { kind: 'area', regions: [], custom: true });

  const regions = tuningSchema(effect({ surface: { type: 'regions', regions: ['alphas'] } }));
  assert.deepEqual(
    regions[0].controls.find((control) => control.kind === 'area'),
    {
      kind: 'area',
      regions: ['alphas'],
      custom: false,
    },
  );
});

test('describe prefers layer.label and falls back to i18n keys', () => {
  const labeled = describe(effect({ label: { en: 'Deep blue base', 'zh-CN': '深蓝底色' } }), 'zh-CN')[0];
  assert.equal(labeled.labelText, '深蓝底色');
  assert.equal(labeled.labelKey, 'layer.label');

  const generated = describe(effect({ color: solid([0, 40, 160]) }), 'en')[0];
  assert.equal(generated.labelText, undefined);
  assert.equal(generated.labelKey, 'layer.label');
  assert.deepEqual(generated.labelParams, {
    colorKey: 'colorName.deepBlue',
    primitiveName: 'Solid',
  });
  assert.equal(generated.primitive, 'static');
  assert.equal(generated.primitiveName, 'Solid');
  assert.equal(generated.icon, 'static');
  assert.equal(generated.enabled, true);
  assert.equal(generated.requiresInput, null);
});

test('describe localises primitive names and reports disabled/input layers', () => {
  const [zh] = describe(effect({ component: 'ripple', color: solid([0, 40, 160]) }), 'zh-CN');
  assert.equal(zh.primitiveName, '按键波纹');
  assert.equal(zh.labelParams.primitiveName, '按键波纹');
  assert.equal(zh.requiresInput, 'key');
  assert.equal(zh.enabled, true);

  const [off] = describe(effect({ enabled: false }), 'en');
  assert.equal(off.enabled, false);
});

test('nearest colour family maps fixed RGBs', () => {
  assert.equal(nearestColorName([0, 40, 160]), 'deepBlue');
  assert.equal(nearestColorName([150, 210, 255]), 'iceBlue');
  assert.equal(nearestColorName([255, 255, 255]), 'white');
  assert.equal(nearestColorName([255, 110, 30]), 'warmOrange');
  assert.equal(nearestColorName([230, 0, 200]), 'magenta');
  assert.equal(nearestColorName([255, 230, 0]), 'yellow');
});

test('describe uses rainbow/multi for palettes and ramps', () => {
  const palette = describe(effect({ component: 'ring', color: undefined }), 'en')[0];
  assert.equal(palette.labelParams.colorKey, 'colorName.rainbow');
  const ramp = describe(
    effect({
      component: 'gradient',
      color: {
        type: 'ramp',
        axis: 'x',
        colors: [
          [255, 0, 0],
          [0, 0, 255],
        ],
      },
    }),
    'en',
  )[0];
  assert.equal(ramp.labelParams.colorKey, 'colorName.multi');
});

test('applyTuning toggles enabled without mutating the input', () => {
  const original = effect({ enabled: true });
  original.layer.push({ id: 'b', component: 'breath', surface: { type: 'all' }, color: solid([1, 2, 3]) });
  const snapshot = structuredClone(original);
  const result = applyTuning(original, { layerId: 'a', kind: 'enabled', value: false });
  assert.equal(result.ok, true);
  assert.equal(result.effect.layer[0].enabled, false);
  assert.deepEqual(original, snapshot);
  assert.equal(validate(result.effect, { mode: 'strict' }).ok, true);
});

test('applyTuning scales inverse speed params and clamps at registry bounds', () => {
  const blink = effect({
    component: 'blink',
    params: { on_ms: 500, off_ms: 400, soft: false },
  });
  const faster = applyTuning(blink, { layerId: 'a', kind: 'speed', multiplier: 2 });
  assert.equal(faster.ok, true);
  assert.equal(faster.effect.layer[0].params.on_ms, 250);
  assert.equal(faster.effect.layer[0].params.off_ms, 200);

  const clamped = applyTuning(effect({ component: 'reactive', params: { speed: 4 } }), {
    layerId: 'a',
    kind: 'speed',
    multiplier: 2,
  });
  assert.equal(clamped.ok, true);
  assert.equal(clamped.effect.layer[0].params.speed, 4);
});

test('applyTuning rounds speed params to integers', () => {
  const result = applyTuning(effect({ component: 'breath', params: { period_ms: 1001 } }), {
    layerId: 'a',
    kind: 'speed',
    multiplier: 2,
  });
  assert.equal(result.ok, true);
  assert.equal(result.effect.layer[0].params.period_ms, 501);
});

test('applyTuning writes color single, stops and palette patches', () => {
  const single = applyTuning(effect({}), {
    layerId: 'a',
    kind: 'color',
    color: { kind: 'single', rgb: [1, 2, 3] },
  });
  assert.equal(single.ok, true);
  assert.deepEqual(single.effect.layer[0].color, { type: 'solid', rgb: [1, 2, 3] });

  const stops = applyTuning(effect({ component: 'gradient' }), {
    layerId: 'a',
    kind: 'color',
    color: {
      kind: 'stops',
      colors: [
        [255, 0, 0],
        [0, 0, 255],
      ],
    },
  });
  assert.equal(stops.ok, true);
  assert.deepEqual(stops.effect.layer[0].color, {
    type: 'ramp',
    axis: 'x',
    colors: [
      [255, 0, 0],
      [0, 0, 255],
    ],
  });

  const palette = applyTuning(effect({ component: 'ring' }), {
    layerId: 'a',
    kind: 'color',
    color: { kind: 'palette', palette: 'seven' },
  });
  assert.equal(palette.ok, true);
  assert.equal(palette.effect.layer[0].color, undefined);
  assert.equal(palette.effect.layer[0].params.palette, 'seven');
});

test('applyTuning writes area and direction patches', () => {
  const area = applyTuning(effect({ surface: { type: 'cells', cells: ['0,0'] } }), {
    layerId: 'a',
    kind: 'area',
    regions: ['alphas', 'numbers'],
  });
  assert.equal(area.ok, true);
  assert.deepEqual(area.effect.layer[0].surface, {
    type: 'regions',
    regions: ['alphas', 'numbers'],
  });

  const direction = applyTuning(effect({ component: 'wave' }), {
    layerId: 'a',
    kind: 'direction',
    value: 'reverse',
  });
  assert.equal(direction.ok, true);
  assert.equal(direction.effect.layer[0].params.direction, 'reverse');

  const axis = applyTuning(
    effect({
      component: 'gradient',
      color: {
        type: 'ramp',
        axis: 'x',
        colors: [
          [0, 0, 0],
          [255, 255, 255],
        ],
      },
    }),
    { layerId: 'a', kind: 'direction', value: 'y' },
  );
  assert.equal(axis.ok, true);
  assert.equal(axis.effect.layer[0].color.axis, 'y');
  assert.equal(axis.effect.layer[0].params?.axis, undefined);
});

test('applyTuning rejects invalid patches and results', () => {
  const unknownLayer = applyTuning(effect({}), { layerId: 'missing', kind: 'enabled', value: false });
  assert.equal(unknownLayer.ok, false);
  assert.equal(unknownLayer.issues[0].code, 'LAYER_INVALID');

  const badRamp = applyTuning(effect({ component: 'blink' }), {
    layerId: 'a',
    kind: 'color',
    color: {
      kind: 'stops',
      colors: [
        [255, 0, 0],
        [0, 0, 255],
      ],
    },
  });
  assert.equal(badRamp.ok, false);
  assert.ok(badRamp.issues.some((entry) => entry.code === 'COLOR_UNSUPPORTED'));

  const emptyArea = applyTuning(effect({}), { layerId: 'a', kind: 'area', regions: [] });
  assert.equal(emptyArea.ok, false);
  assert.equal(emptyArea.issues[0].code, 'SURFACE_INVALID');

  const badPalette = applyTuning(effect({ component: 'ring' }), {
    layerId: 'a',
    kind: 'color',
    color: { kind: 'palette', palette: 'nope' },
  });
  assert.equal(badPalette.ok, false);
  assert.equal(badPalette.issues[0].code, 'PARAM_TYPE');

  const missingColor = applyTuning(effect({}), { layerId: 'a', kind: 'color', color: undefined });
  assert.equal(missingColor.ok, false);
  assert.equal(missingColor.issues[0].code, 'COLOR_INVALID');
});
