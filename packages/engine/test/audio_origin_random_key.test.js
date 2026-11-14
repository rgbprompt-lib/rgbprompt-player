import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audioContract } from '../src/audio/control.ts';
import { normalize } from '../src/normalize.ts';
import { validate } from '../src/validate.ts';
import { encode, decode } from '../src/lep.ts';
import { Renderer } from '../src/render.ts';
import { compileParams } from '../src/codec.ts';

const makeEffect = (layers) => ({
  schema: 'lep.effect/1',
  meta: {
    name: 'OriginRandom',
    author: 'Test',
    generator: 'human',
    seed: 42,
    execution_profile: 'composable-v1',
  },
  layer: layers.map((l, i) => ({ id: 'L' + i, surface: { type: 'all' }, ...l })),
});

const pulse = (t, index, value) => ({
  t,
  bands: Array.from({ length: 22 }, (_, i) => (i === index ? value : 0)),
});

for (const component of ['key_burst', 'key_ring']) {
  test(`${component} origin=random_key survives encode→decode and renders onsets`, () => {
    const baseParams =
      component === 'key_burst'
        ? {
            life_ms: 800,
            max_radius: 6,
            width_tenths: 15,
            softness_tenths: 10,
            afterglow_ms: 200,
            flash_ms: 40,
            max_bursts: 4,
            origin: 'random_key',
          }
        : {
            life_ms: 600,
            max_radius: 8,
            width: 2,
            max_waves: 4,
            origin: 'random_key',
            envelope: 'fade_out',
          };
    const dsl = makeEffect([
      {
        component,
        color: { type: 'solid', rgb: [255, 64, 32] },
        params: baseParams,
        playback: {
          start: 'audio_onset',
          source: 'bass',
          detector: 'flux',
          sensitivity: 20,
          min_interval_ms: 120,
        },
      },
    ]);
    const check = validate(dsl);
    assert.equal(check.ok, true, JSON.stringify(check.errors));
    const program = normalize(dsl);
    const wire = compileParams(program.layers[0]);
    // random_key appends origin as the extended suffix → 9 for burst, 8 for ring
    assert.equal(wire.length, component === 'key_burst' ? 9 : 8, wire);
    assert.equal(wire[wire.length - (component === 'key_burst' ? 1 : 2)], 2); // origin enum random_key=2
    const bytes = encode(program);
    const decoded = decode(bytes);
    assert.ok(
      decoded.pkgVersion === audioContract.package_version ||
        decoded.pkgVersion === audioContract.extended_package_version,
    );
    const layer = decoded.program.layers[0];
    assert.equal(layer.params.origin, 'random_key');
    assert.equal(
      Object.keys(layer.params).includes('origin'),
      true,
      '9th/extended origin must be present after decode',
    );
    // Round-trip bytes must be stable (Player embeds this decoder).
    assert.deepEqual(encode(decoded.program), bytes);

    const a = new Renderer(program);
    const b = new Renderer(decoded.program);
    let lit = 0;
    for (let t = 0; t < 600; t += 20) {
      const input = {
        audio: t % 40 === 0 ? [pulse(t, 1, t === 0 || t === 200 || t === 400 ? 255 : 0)] : [],
      };
      const fa = a.step(t, input);
      const fb = b.step(t, input);
      assert.deepEqual(fa, fb, `frame mismatch at t=${t}`);
      for (const row of fa) for (const cell of row) if (cell.l > 0) lit++;
    }
    assert.ok(lit > 0, `${component} random_key must paint something`);
  });
}

test('key_burst default (no origin) stays 8-wide so goldens do not grow', () => {
  const dsl = makeEffect([
    {
      component: 'key_burst',
      color: { type: 'solid', rgb: [0, 255, 0] },
      params: { max_bursts: 2, life_ms: 400 },
      playback: { start: 'audio_onset', source: 'mid' },
    },
  ]);
  assert.equal(validate(dsl).ok, true);
  const program = normalize(dsl);
  assert.equal(compileParams(program.layers[0]).length, 8);
  const decoded = decode(encode(program));
  assert.equal(decoded.program.layers[0].params.origin, undefined);
});
