import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audioContract, LayerAudio, OnsetDetector } from '../src/audio/control.ts';
import { normalize } from '../src/normalize.ts';
import { validate } from '../src/validate.ts';
import { encode, decode, crc32 } from '../src/lep.ts';
import { Renderer } from '../src/render.ts';

const effect = (layer) => ({
  schema: 'lep.effect/1',
  meta: { name: 'Audio v15', author: 'Test', generator: 'human', seed: 7 },
  layer: layer.map((l, i) => ({ id: 'layer' + i, surface: { type: 'all' }, ...l })),
});
const pulse = (t, index, value) => ({
  t,
  bands: Array.from({ length: 22 }, (_, i) => (i === index ? value : 0)),
});
const solid = { type: 'solid', rgb: [255, 255, 255] };
const forge = (bytes, version) => {
  const out = Uint8Array.from(bytes);
  const view = new DataView(out.buffer);
  view.setUint16(4, version, true);
  view.setUint32(out.length - 4, crc32(out.subarray(0, out.length - 4)), true);
  return out;
};

test('v15 is selected only for flux, impulses, long responses and short rings; v14 cannot carry them', () => {
  const cases = [
    [
      [
        {
          component: 'static',
          color: solid,
          audio_mod: { brightness: { source: 'bass', release_ms: 2000 } },
        },
      ],
      14,
    ],
    [
      [
        {
          component: 'static',
          color: solid,
          audio_mod: { brightness: { source: 'bass', release_ms: 2001 } },
        },
      ],
      15,
    ],
    [
      [
        {
          component: 'static',
          color: solid,
          audio_mod: { brightness: { source: 'bass', release_ms: 8000 } },
        },
      ],
      15,
    ],
    [
      [
        {
          component: 'key_ring',
          params: { max_waves: 4 },
          playback: { start: 'audio_onset', source: 'bass', detector: 'level' },
        },
      ],
      14,
    ],
    [
      [
        {
          component: 'key_ring',
          params: { max_waves: 4 },
          playback: { start: 'audio_onset', source: 'bass', detector: 'flux', sensitivity: 25 },
        },
      ],
      15,
    ],
    [
      [
        {
          component: 'static',
          color: solid,
          audio_mod: {
            brightness: { source: 'bass', trigger: 'onset', threshold: 90, hysteresis: 30, release_ms: 250 },
          },
        },
      ],
      15,
    ],
    [[{ component: 'key_ring', params: { life_ms: 120 } }], 15],
  ];
  for (const [layers, version] of cases) {
    const dsl = effect(layers);
    assert.equal(validate(dsl).ok, true, JSON.stringify(validate(dsl).errors));
    const bytes = encode(normalize(dsl)),
      decoded = decode(bytes);
    assert.equal(decoded.pkgVersion, version, JSON.stringify(layers));
    assert.deepEqual(encode(decoded.program), bytes);
    if (version === 15) assert.throws(() => decode(forge(bytes, 14)));
  }
  for (const bad of [
    { brightness: { source: 'bass', release_ms: 8001 } },
    { brightness: { source: 'bass', trigger: 'onset', attack_ms: 5, release_ms: 250 } },
    { brightness: { source: 'bass', trigger: 'onset', release_ms: 0 } },
    { brightness: { source: 'bass', trigger: 'onset', detector: 'flux', threshold: 100, release_ms: 250 } },
    { motion_rate: { source: 'bass', trigger: 'onset', release_ms: 250 } },
  ])
    assert.equal(
      validate(effect([{ component: 'rainbow_wave', audio_mod: bad }])).ok,
      false,
      JSON.stringify(bad),
    );
  assert.equal(
    validate(
      effect([
        {
          component: 'key_ring',
          playback: { start: 'audio_onset', source: 'bass', detector: 'flux', sensitivity: 41 },
        },
      ]),
    ).ok,
    false,
  );
});

test('A1 flux onsets are keyed to the 40 ms grid and ignore duplicate in-cell samples', () => {
  const values = [0, 0, 200, 40, 30, 220, 20, 10, 10, 240, 0, 0];
  const onsets = (stepMs) => {
    const d = new OnsetDetector({ detector: 'flux' }, 'bass'),
      out = [];
    for (let t = 0; t < values.length * 40; t += stepMs)
      if (d.detect(pulse(t, 1, values[Math.floor(t / 40)]))) out.push(Math.floor(t / 40));
    return out;
  };
  assert.ok(onsets(40).length >= 2);
  assert.deepEqual(onsets(8), onsets(40));
  assert.deepEqual(onsets(20), onsets(40));
});

test('A3 a full-board brightness impulse reaches full dark within 300 ms', () => {
  const dsl = effect([
    {
      component: 'static',
      color: solid,
      audio_mod: { brightness: { source: 'bass', trigger: 'onset', detector: 'flux', release_ms: 250 } },
    },
  ]);
  const r = new Renderer(normalize(dsl));
  let fired = null,
    dark = null;
  for (let t = 0; t < 1200; t += 10) {
    const frame = r.step(t, { audio: t % 40 ? [] : [pulse(t, 1, t >= 400 && t < 440 ? 255 : 0)] });
    const lit = frame.flat().filter((p) => p.r || p.g || p.b);
    if (fired === null && lit.length) {
      fired = t;
      assert.equal(lit.length, frame.flat().length);
      assert.ok(lit.every((p) => p.r === 255 && p.g === 255 && p.b === 255));
    }
    if (fired !== null && dark === null && !lit.length) dark = t;
  }
  assert.ok(fired !== null && dark !== null && dark - fired <= 300, `dark after ${dark - fired} ms`);
});

test('A4 an 8 s release keeps glowing for seconds while fresh silent samples arrive', () => {
  const audio = new LayerAudio({
    component: 'static',
    audio_mod: { brightness: { source: 'bass', release_ms: 8000 } },
  });
  const samples = [];
  for (let t = 0; t <= 400; t += 40) samples.push(pulse(t, 1, 255));
  assert.equal(audio.step(400, samples).brightness, 1000);
  const at = {};
  for (let t = 440; t <= 9000; t += 40) {
    const b = audio.step(t, [pulse(t, 1, 0)]).brightness;
    if ([2400, 4400, 8400].includes(t)) at[t] = b;
  }
  assert.ok(at[2400] > 600 && at[4400] > 300, JSON.stringify(at));
  assert.equal(at[8400], 0);
  assert.equal(audioContract.extended_response_ms, 8000);
});

test('A2 key bursts flash on every press with no per-second cap', () => {
  const r = new Renderer(
    normalize(
      effect([
        {
          component: 'key_burst',
          color: { type: 'solid', rgb: [255, 0, 0] },
          params: { max_bursts: 8, life_ms: 1500 },
        },
      ]),
    ),
  );
  for (let i = 0; i < 8; i++) r.step(i * 120, { keys: [{ t: i * 120, type: 'down', cell: `2,${2 + i}` }] });
  const bursts = r.keyBursts[0].bursts.filter(Boolean);
  assert.equal(bursts.length, 8);
  assert.ok(bursts.every((b) => b.flash));
});
