import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audioContract, getLayerInputs, LayerAudio } from '../src/audio/control.ts';
import { normalize } from '../src/normalize.ts';
import { validate } from '../src/validate.ts';
import { encode, decode } from '../src/lep.ts';
import { Renderer } from '../src/render.ts';

const makeEffect = (layer) => ({
  schema: 'lep.effect/1',
  meta: { name: 'Audio', author: 'Test', generator: 'human', seed: 7 },
  layer: layer.map((l, i) => ({ id: 'layer' + i, surface: { type: 'all' }, ...l })),
});
const pulse = (t, index, value) => ({
  t,
  bands: Array.from({ length: 22 }, (_, i) => (i === index ? value : 0)),
});
const ramp = {
  type: 'ramp',
  axis: 'y',
  colors: [
    [255, 0, 0],
    [0, 255, 0],
  ],
};

test('v14 encodes explicit audio binding and spectrum records losslessly', () => {
  const dsl = makeEffect([
    {
      component: 'static',
      color: { type: 'solid', rgb: [255, 0, 0] },
      audio_mod: { brightness: { source: 'bass', release_ms: 200 } },
    },
    {
      component: 'spectrum_mirror',
      params: { dense: true, peak_ms: 300, full_range: true, color_by_height: true },
      color: ramp,
    },
    {
      component: 'key_ring',
      params: { max_waves: 4, max_radius: 16, origin: 'board_center' },
      color: { type: 'ramp', palette: 'rainbow24' },
      playback: { start: 'audio_onset', source: 'bass' },
    },
    {
      component: 'key_burst',
      params: { max_bursts: 4 },
      playback: { start: 'audio_onset', source: 'treble' },
    },
  ]);
  const check = validate(dsl);
  assert.equal(check.ok, true, JSON.stringify(check.errors));
  const program = normalize(dsl);
  const bytes = encode(program),
    decoded = decode(bytes);
  assert.equal(decoded.pkgVersion, audioContract.package_version);
  assert.deepEqual(encode(decoded.program), bytes);
  const a = new Renderer(program),
    b = new Renderer(decoded.program);
  for (let t = 0; t < 520; t += 20) {
    const input = { audio: t % 40 ? [] : [pulse(t, t % 160 < 80 ? 1 : 21, t % 80 === 0 ? 240 : 0)] };
    assert.deepEqual(a.step(t, input), b.step(t, input));
  }
  assert.deepEqual(getLayerInputs(program.layers[2]), { audio: true, key: false });
  assert.deepEqual(getLayerInputs({ ...program.layers[2], playback: undefined }), {
    audio: false,
    key: true,
  });
});

test('timestamps survive batched audio and rearming requires low energy', () => {
  const samples = [
    pulse(0, 1, 0),
    pulse(40, 1, 220),
    pulse(100, 1, 220),
    pulse(140, 1, 0),
    pulse(200, 1, 250),
  ];
  const layer = { component: 'key_ring', playback: { start: 'audio_onset', source: 'bass' } };
  assert.deepEqual(new LayerAudio(layer).step(240, samples).onsets, [40, 200]);
  const clock = {
    component: 'scroll',
    audio_mod: { motion_rate: { source: 'bass', attack_ms: 50, release_ms: 80 } },
  };
  const a = new LayerAudio(clock),
    b = new LayerAudio(clock);
  let phase = 0;
  for (let t = 0; t <= 300; t++)
    phase = a.step(
      t,
      samples.filter((s) => s.t === t),
    ).tick;
  assert.equal(b.step(300, samples).tick, phase);
});

test('audio bursts never paint the centre flash on a key cell such as ESC', () => {
  const program = normalize(
    makeEffect([
      {
        component: 'key_burst',
        color: { type: 'solid', rgb: [255, 0, 0] },
        params: { max_bursts: 2, life_ms: 200, max_radius: 12, width_tenths: 30 },
        playback: { start: 'audio_onset', source: 'bass' },
      },
    ]),
  );
  const r = new Renderer(program);
  let lit = 0;
  for (let t = 0; t < 300; t += 10) {
    const frame = r.step(t, { audio: t <= 10 ? [pulse(t, 1, t === 10 ? 255 : 0)] : [] });
    for (const row of frame)
      for (const cell of row) {
        if (cell.l > 0 && cell.r > 0) lit++;
        assert.ok(cell.l === 0 || cell.g === 0, `white centre flash at ${t} ms`);
      }
  }
  assert.ok(lit > 0, 'the burst itself still renders');
});
