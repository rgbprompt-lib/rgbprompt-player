import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CAPABILITIES,
  COLOR_TYPES,
  TIME_TYPES,
  TRIGGER_TYPES,
  acceptsColorType,
  acceptsTimeType,
  acceptsTriggerType,
} from '../src/capabilities.ts';
import { componentNames } from '../src/registry.ts';
import { CLOSED_COMPONENTS, validate } from '../src/validate.ts';

const meta = { name: 'capability', author: 'test', generator: 'human', seed: 7 };

function effect(layer) {
  return { schema: 'lep.effect/1', meta: { ...meta }, layer: [{ id: 'a', ...layer }] };
}

function baseLayer(component) {
  const layer = { component, surface: { type: 'all' } };
  if (component === 'rain') {
    layer.color = {
      type: 'ramp',
      axis: 'x',
      colors: [
        [10, 20, 30],
        [40, 50, 60],
        [70, 80, 90],
        [100, 110, 120],
        [130, 140, 150],
      ],
    };
  } else if (!['sparkle', 'key_ring', 'key_burst', 'block_stack', 'fire'].includes(component)) {
    layer.color = { type: 'solid', rgb: [10, 20, 30] };
  }
  return layer;
}

function colorSample(type, component) {
  switch (type) {
    case 'solid':
      return { type: 'solid', rgb: [10, 20, 30] };
    case 'palette_index':
      return { type: 'palette_index', palette: 'rainbow24', index: 0 };
    case 'ramp': {
      const stops = component === 'rain' ? 5 : 2;
      return {
        type: 'ramp',
        axis: 'x',
        colors: Array.from({ length: stops }, (_, index) => [index, index + 1, index + 2]),
      };
    }
    case 'hue_cycle':
      return { type: 'hue_cycle', period_ms: 1000, saturation: 255, value: 255 };
    case 'random':
      return { type: 'random', palette: 'seven' };
    case 'from_input':
      return { type: 'from_input', palette: 'rainbow24', source: 'key_press' };
    default:
      throw new Error(`unknown color type ${type}`);
  }
}

test('the capability table covers exactly the v1-open primitives', () => {
  const open = componentNames()
    .filter((name) => !CLOSED_COMPONENTS.includes(name))
    .sort();
  assert.deepEqual(Object.keys(CAPABILITIES).sort(), open);
});

test('every (primitive x color type) matches validate', () => {
  for (const component of Object.keys(CAPABILITIES)) {
    const capability = CAPABILITIES[component];
    for (const type of COLOR_TYPES) {
      const layer = baseLayer(component);
      layer.color = colorSample(type, component);
      const report = validate(effect(layer));
      assert.equal(
        report.ok,
        acceptsColorType(component, type),
        `${component} + color ${type}: ${JSON.stringify(report.errors)}`,
      );
    }
  }
});

test('every (primitive x time type) matches validate', () => {
  for (const component of Object.keys(CAPABILITIES)) {
    for (const type of TIME_TYPES) {
      const layer = baseLayer(component);
      layer.time = { type };
      const report = validate(effect(layer));
      assert.equal(
        report.ok,
        acceptsTimeType(component, type),
        `${component} + time ${type}: ${JSON.stringify(report.errors)}`,
      );
    }
  }
});

test('every (primitive x trigger type) matches validate', () => {
  for (const component of Object.keys(CAPABILITIES)) {
    for (const type of TRIGGER_TYPES) {
      const layer = baseLayer(component);
      layer.trigger = { type };
      const report = validate(effect(layer));
      assert.equal(
        report.ok,
        acceptsTriggerType(component, type),
        `${component} + trigger ${type}: ${JSON.stringify(report.errors)}`,
      );
    }
  }
});

test('every (primitive x color x time x trigger) combination matches validate', () => {
  for (const component of Object.keys(CAPABILITIES)) {
    for (const colorType of COLOR_TYPES) {
      for (const timeType of TIME_TYPES) {
        for (const triggerType of TRIGGER_TYPES) {
          const layer = baseLayer(component);
          layer.color = colorSample(colorType, component);
          layer.time = { type: timeType };
          layer.trigger = { type: triggerType };
          const expected =
            acceptsColorType(component, colorType) &&
            acceptsTimeType(component, timeType) &&
            acceptsTriggerType(component, triggerType);
          const report = validate(effect(layer));
          assert.equal(
            report.ok,
            expected,
            `${component} + ${colorType} + ${timeType} + ${triggerType}: ${JSON.stringify(report.errors)}`,
          );
        }
      }
    }
  }
});

test('ramp-on-wave feedback names the allowed colour types', () => {
  const layer = {
    component: 'wave',
    surface: { type: 'all' },
    color: {
      type: 'ramp',
      axis: 'x',
      colors: [
        [1, 2, 3],
        [4, 5, 6],
      ],
    },
  };
  const report = validate(effect(layer));
  assert.equal(report.ok, false);
  const message = report.errors.find((entry) => entry.code === 'COLOR_UNSUPPORTED')?.message ?? '';
  for (const type of CAPABILITIES.wave.colorTypes) {
    assert.ok(message.includes(type), `${type} missing from ${message}`);
  }
});

test('rain accepts only a five-stop ramp and only the always trigger', () => {
  for (const stops of [4, 5, 6]) {
    const layer = baseLayer('rain');
    layer.color = {
      type: 'ramp',
      axis: 'x',
      colors: Array.from({ length: stops }, () => [1, 2, 3]),
    };
    assert.equal(validate(effect(layer)).ok, stops === 5, `rain stops ${stops}`);
  }
  const layer = baseLayer('rain');
  layer.trigger = { type: 'key_press' };
  assert.equal(validate(effect(layer)).ok, false);
});
