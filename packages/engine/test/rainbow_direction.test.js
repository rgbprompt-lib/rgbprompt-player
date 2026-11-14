import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/normalize.ts';
import { Renderer } from '../src/render.ts';
import { encode, decode } from '../src/lep.ts';
import { programToDsl } from '../src/roundtrip.ts';
import { validate } from '../src/validate.ts';

function effect(axis, direction, motion = 'physical-v1') {
  return {
    schema: 'lep.effect/1',
    meta: {
      name: 'direction',
      author: 'test',
      generator: 'human',
      seed: 1,
      ...(motion === undefined ? {} : { motion_profile: motion }),
    },
    layer: [
      {
        id: 'r',
        component: 'rainbow_wave',
        surface: { type: 'all' },
        params: { axis, direction, period_ms: axis === 'x' ? 22000 : 6000 },
      },
    ],
  };
}

test('rainbow physical directions move toward the intended neighbouring key', () => {
  for (const axis of ['x', 'y'])
    for (const direction of ['forward', 'reverse']) {
      const dsl = effect(axis, direction);
      const render = new Renderer(normalize(dsl));
      const before = render.step(0, {}),
        after = render.step(1000, {});
      const at = (frame, pos) => (axis === 'x' ? frame[2][pos] : frame[pos][5]);
      const initial = at(before, 2),
        target = at(after, direction === 'forward' ? 3 : 1);
      for (const channel of ['r', 'g', 'b'])
        assert.ok(Math.abs(initial[channel] - target[channel]) <= 2, `${axis} ${direction} ${channel}`);
    }
});

test('legacy behavior is preserved and physical profile survives binary round trip', () => {
  const legacy = effect('x', 'forward', 'legacy'),
    modern = effect('x', 'forward');
  assert.equal(normalize(legacy).layers[0].params.direction, 'forward');
  assert.equal(normalize(modern).layers[0].params.direction, 'reverse');
  delete modern.layer[0].params.direction;
  modern.layer[0].time = { type: 'static', direction: 'reverse' };
  assert.equal(normalize(modern).layers[0].params.direction, 'forward');
  modern.layer[0].params.direction = 'forward';
  delete modern.layer[0].time;
  const decoded = decode(encode(normalize(modern)));
  const imported = programToDsl(decoded.program, decoded.meta);
  assert.equal(imported.meta.motion_profile, 'physical-v1');
  assert.equal(imported.layer[0].params.direction, 'forward');
  assert.deepEqual(encode(normalize(imported)), encode(normalize(modern)));
  assert.equal(validate(effect('x', 'forward', 'unknown')).ok, false);
});
