import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decode, encode } from '../src/lep.ts';
import { normalize } from '../src/normalize.ts';
import { Renderer } from '../src/render.ts';
import { validate } from '../src/validate.ts';

const meta = { name: 'disabled', author: 'test', generator: 'human', seed: 7 };

function effect(layers) {
  return { schema: 'lep.effect/1', meta: { ...meta }, layer: layers };
}

const solid = (rgb) => ({ type: 'solid', rgb });
const base = { id: 'base', component: 'static', surface: { type: 'all' }, color: solid([20, 120, 200]) };
const off = {
  id: 'off',
  component: 'blink',
  surface: { type: 'all' },
  color: solid([255, 0, 0]),
  params: { on_ms: 60, off_ms: 60, soft: false },
  enabled: false,
};

test('normalize skips disabled layers', () => {
  const report = validate(effect([base, off]));
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  const program = normalize(effect([base, off]));
  assert.deepEqual(
    program.layers.map((layer) => layer.id),
    ['base'],
  );
});

test('encode does not write disabled layers, even in a manually built program', () => {
  const program = normalize(effect([base]));
  program.layers.push({ ...program.layers[0], id: 'off', enabled: false });
  const decoded = decode(encode(program));
  assert.deepEqual(
    decoded.program.layers.map((layer) => layer.id),
    ['base'],
  );
});

test('validate still checks disabled layers', () => {
  const broken = { ...off, params: { on_ms: -1, off_ms: 60, soft: false } };
  const report = validate(effect([base, broken]));
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((entry) => entry.code === 'PARAM_RANGE'));
});

test('a disabled layer does not change rendered frames', () => {
  const withDisabled = normalize(effect([base, off]));
  const without = normalize(effect([base]));
  const left = new Renderer(withDisabled);
  const right = new Renderer(without);
  for (const tick of [0, 40, 400, 800]) {
    assert.deepEqual(left.step(tick, {}), right.step(tick, {}));
  }
});
