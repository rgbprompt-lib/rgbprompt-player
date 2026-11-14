import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rampColor,
  Renderer,
  normalize,
  validate,
  encode,
  decode,
  ALPHA_PKG_VERSION,
  COMPOSABLE_PKG_VERSION,
  peekPackageVersion,
} from '../src/index.ts';
import { featurePackageVersion, encodeLayer, decodeLayer, compileParams } from '../src/codec.ts';

const compileParamsCount = (layer) => compileParams(layer).length;
import { rampValues, stopInterval, paletteStopsErrors } from '../src/palette_stops.ts';
import { rampAlpha, paletteAlphaErrors } from '../src/palette_alpha.ts';
import { PlaybackState, playbackErrors, hasPlayback } from '../src/playback.ts';

test('stopInterval and rampValues match the upstream integer knots', () => {
  const stops = [0, 250, 1000];
  assert.deepEqual(stopInterval(stops, 0), [0, 1, 0, 250]);
  assert.deepEqual(stopInterval(stops, 250), [1, 2, 0, 750]);
  assert.deepEqual(stopInterval(stops, 1000), [2, 2, 0, 1]);
  assert.equal(rampValues([0, 100, 200], stops, 125), 50);
  assert.deepEqual(
    rampColor(
      [
        [0, 0, 0],
        [100, 0, 0],
        [200, 0, 0],
      ],
      125,
      stops,
    ),
    [50, 0, 0],
  );
  // No stops: existing linear ramp must stay unchanged.
  assert.deepEqual(
    rampColor(
      [
        [0, 0, 0],
        [200, 0, 0],
      ],
      500,
    ),
    [100, 0, 0],
  );
});

test('rampAlpha interpolates coverage and respects stops', () => {
  assert.equal(rampAlpha([0, 255], 0), 0);
  assert.equal(rampAlpha([0, 255], 1000), 255);
  assert.equal(rampAlpha([0, 255], 500), 128);
  assert.equal(rampAlpha([0, 255], 250, false, [0, 1000]), 64);
});

test('playback auto cycle produces a local clock and then goes idle', () => {
  const state = new PlaybackState();
  const config = {
    start: 'auto',
    stop: 'natural',
    retrigger: 'restart',
    duration_ms: 100,
    cycles: 1,
    pause_ms: 0,
    inputMask: new Array(22).fill(0),
  };
  assert.equal(state.step(0, config), 0);
  assert.equal(state.step(40, config), 40);
  assert.equal(state.step(100, config), null);
  assert.equal(state.step(140, config), null);
});

test('stops and alphas validate supported fire ramps and reject add-blend coverage', () => {
  const fire = {
    id: 'flame',
    component: 'fire',
    surface: { type: 'all' },
    blend: 'replace',
    color: {
      type: 'ramp',
      colors: [
        [255, 0, 0],
        [255, 180, 0],
      ],
      stops: [0, 1000],
      alphas: [0, 255],
    },
    params: {},
  };
  assert.deepEqual(paletteStopsErrors(fire), []);
  assert.deepEqual(paletteAlphaErrors(fire), []);
  assert.equal(
    featurePackageVersion(normalize({ schema: 'lep.effect/1', meta: { seed: 1 }, layer: [fire] }).layers[0]),
    9,
  );
  const add = { ...fire, blend: 'add' };
  assert.ok(paletteAlphaErrors(add).length > 0);
});

test('shared playback is kept by normalize and hides the layer when the clock is idle', () => {
  const layer = {
    id: 'pulse',
    component: 'breath',
    surface: { type: 'all' },
    color: { type: 'solid', rgb: [0, 180, 255] },
    params: { period_ms: 2000, min_level: 20 },
    playback: { start: 'auto', duration_ms: 50, cycles: 1, pause_ms: 0 },
  };
  const dsl = {
    schema: 'lep.effect/1',
    meta: { seed: 1, name: 'p', author: 'test', generator: 'human' },
    layer: [layer],
  };
  const report = validate(dsl);
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  const program = normalize(dsl);
  assert.equal(hasPlayback(program.layers[0]), true);
  assert.deepEqual(program.layers[0].playback.inputMask, new Array(22).fill(0));
  const renderer = new Renderer(program);
  const lit = renderer.step(0, {});
  const idle = renderer.step(80, {});
  const litKeys = lit.flat().filter((cell) => cell.l > 0 || cell.r || cell.g || cell.b).length;
  const idleKeys = idle.flat().filter((cell) => cell.l > 0 || cell.r || cell.g || cell.b).length;
  assert.ok(litKeys > 0);
  assert.equal(idleKeys, 0);
  assert.equal(featurePackageVersion(program.layers[0]), 11);
});

test('playback is mutually exclusive with audio_onset in hasPlayback', () => {
  assert.equal(hasPlayback({ playback: { start: 'audio_onset', source: 'bass' } }), false);
  assert.equal(playbackErrors({ id: 'x', component: 'static', surface: { type: 'all' } }).length, 0);
});

void ALPHA_PKG_VERSION;

function fireRamp(extra = {}) {
  return {
    schema: 'lep.effect/1',
    meta: { seed: 1, name: 'codec', author: 'test', generator: 'human' },
    layer: [
      {
        id: 'flame',
        component: 'fire',
        surface: { type: 'all' },
        blend: 'replace',
        color: {
          type: 'ramp',
          colors: [
            [0, 0, 0],
            [255, 80, 0],
            [255, 220, 40],
          ],
          ...extra,
        },
        params: { step_ms: 40, cooling: 40, sparking: 50, spread: 40, direction: 'up' },
      },
    ],
  };
}

test('encode/decode keeps color.stops, color.alphas and shared playback', () => {
  const dsl = fireRamp({ stops: [0, 400, 1000], alphas: [0, 160, 255] });
  dsl.layer.push({
    id: 'pulse',
    component: 'static',
    surface: { type: 'all' },
    color: { type: 'solid', rgb: [0, 180, 255] },
    playback: {
      start: 'auto',
      stop: 'natural',
      retrigger: 'restart',
      duration_ms: 800,
      cycles: 2,
      pause_ms: 40,
    },
  });
  const report = validate(dsl);
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  const program = normalize(dsl);
  const bytes = encode(program);
  assert.equal(peekPackageVersion(bytes), COMPOSABLE_PKG_VERSION);
  const layers = decode(bytes).program.layers;
  const flame = layers[0];
  const pulse = layers[1];
  assert.deepEqual(flame.color.stops, [0, 400, 1000]);
  assert.deepEqual(flame.color.alphas, [0, 160, 255]);
  assert.equal(flame.color.type, 'ramp');
  assert.equal(pulse.playback.start, 'auto');
  assert.equal(pulse.playback.duration_ms, 800);
  assert.equal(pulse.playback.cycles, 2);
  assert.equal(pulse.playback.pause_ms, 40);
  assert.equal(pulse.playback.inputMask.length, 22);
  // Layer-level encode/decode must agree without the file CRC wrapper.
  const fireBytes = encodeLayer(program.layers[0], COMPOSABLE_PKG_VERSION);
  const fireRound = decodeLayer(fireBytes, 0, COMPOSABLE_PKG_VERSION).layer;
  assert.deepEqual(fireRound.color.stops, [0, 400, 1000]);
  assert.deepEqual(fireRound.color.alphas, [0, 160, 255]);
  const pulseBytes = encodeLayer(program.layers[1], COMPOSABLE_PKG_VERSION);
  const pulseRound = decodeLayer(pulseBytes, 0, COMPOSABLE_PKG_VERSION).layer;
  assert.equal(pulseRound.playback.duration_ms, 800);
});

// ---- review fixes (2026-11-12) -------------------------------------------

test('review fix: playback layers keep their easing through encode/decode', async () => {
  const { programToDsl } = await import('../src/roundtrip.ts');
  for (const easing of ['linear', 'pulse', 'sine', { bezier: [0.4, 0, 0.2, 1] }]) {
    const dsl = {
      schema: 'lep.effect/1',
      meta: { seed: 1, name: 'ease', author: 'test', generator: 'human' },
      layer: [
        {
          id: 'pulse',
          component: 'breath',
          surface: { type: 'all' },
          color: { type: 'solid', rgb: [0, 180, 255] },
          params: { period_ms: 1600, min_level: 10 },
          time: { type: 'static', easing },
          playback: { start: 'auto', duration_ms: 900, cycles: 0, pause_ms: 300 },
        },
      ],
    };
    const report = validate(dsl);
    assert.equal(report.ok, true, JSON.stringify(report.errors));
    const program = normalize(dsl);
    const bytes = encode(program);
    const decoded = decode(bytes).program.layers[0];
    if (typeof easing === 'string') assert.equal(decoded.time.easing, easing);
    else assert.deepEqual(decoded.time.easing, { lut: program.layers[0].lut });
    assert.deepEqual(decoded.lut, program.layers[0].lut);
    // DSL -> .lep -> DSL is valid and decodes to the same layers again.
    const back = programToDsl(decode(bytes).program, decode(bytes).meta);
    const backReport = validate(back);
    assert.equal(backReport.ok, true, JSON.stringify(backReport.errors));
    assert.deepEqual(decode(encode(normalize(back))).program.layers, decode(bytes).program.layers);
  }
});

test('review fix: selected_press playback round-trips through programToDsl', async () => {
  const { programToDsl } = await import('../src/roundtrip.ts');
  const dsl = {
    schema: 'lep.effect/1',
    meta: { seed: 1, name: 'sel', author: 'test', generator: 'human' },
    layer: [
      {
        id: 'bar',
        component: 'scroll',
        surface: { type: 'all' },
        color: { type: 'solid', rgb: [255, 0, 80] },
        params: { period_ms: 900, width: 3 },
        playback: {
          start: 'selected_press',
          stop: 'key_press',
          retrigger: 'ignore',
          duration_ms: 600,
          cycles: 0,
          pause_ms: 100,
          input: { type: 'rows', rows: [3] },
        },
      },
    ],
  };
  const bytes = encode(normalize(dsl));
  const back = programToDsl(decode(bytes).program, decode(bytes).meta);
  const report = validate(back);
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.equal(back.layer[0].playback.inputMask, undefined);
  assert.deepEqual(decode(encode(normalize(back))).program.layers, decode(bytes).program.layers);
});

test('review fix: packageVersionForProgram matches encode on the golden corpus', async () => {
  const { buildCorpus } = await import('../../../tools/golden/corpus.mjs');
  const { packageVersionForProgram } = await import('../src/lep.ts');
  for (const testCase of buildCorpus()) {
    const program = normalize(testCase.effect);
    const bytes = encode(program);
    assert.equal(packageVersionForProgram(program), peekPackageVersion(bytes), testCase.id);
  }
});

// ---- review fix 2 (2026-11-12): stops / alphas on wave, spiral, lifecycle ----

const rf2Ramp = (extra = {}) => ({
  type: 'ramp',
  colors: [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
  ],
  ...extra,
});
const rf2Doc = (component, params, color, extra = {}) => ({
  schema: 'lep.effect/1',
  meta: { name: 'rf2', author: 'test', generator: 'human', seed: 1 },
  layer: [
    {
      id: 'a',
      surface: { type: 'all' },
      component,
      ...(params ? { params } : {}),
      ...(color ? { color } : {}),
      ...extra,
    },
  ],
});

test('review fix 2: validate accepts custom-palette ramps with stops/alphas like upstream lepc', () => {
  const ok = {
    wave_ramp: rf2Doc('rainbow_wave', { palette: 'custom' }, rf2Ramp()),
    wave_alphas: rf2Doc('rainbow_wave', { palette: 'custom' }, rf2Ramp({ alphas: [0, 128, 255] })),
    wave_stops_alphas: rf2Doc(
      'rainbow_wave',
      { palette: 'custom', wrap: 'reset' },
      rf2Ramp({ stops: [0, 300, 1000], alphas: [0, 128, 255] }),
    ),
    spiral_ramp: rf2Doc('spiral', { palette: 'custom' }, rf2Ramp()),
    spiral_stops_alphas: rf2Doc(
      'spiral',
      { palette: 'custom' },
      rf2Ramp({ stops: [0, 300, 1000], alphas: [40, 255, 40] }),
    ),
    reactive_lifecycle: rf2Doc(
      'reactive',
      { color_mode: 'lifecycle', palette: 'custom' },
      rf2Ramp({ stops: [0, 250, 1000], alphas: [255, 170, 0] }),
      { trigger: { type: 'key_press' } },
    ),
  };
  for (const [name, doc] of Object.entries(ok)) {
    const report = validate(doc);
    assert.equal(report.ok, true, `${name}: ${JSON.stringify(report.errors)}`);
  }
});

test('review fix 2: validate rejects the same wave/spiral ramps upstream lepc rejects', () => {
  const bad = {
    wave_ramp_without_custom: rf2Doc('rainbow_wave', {}, rf2Ramp()),
    wave_custom_without_ramp: rf2Doc('rainbow_wave', { palette: 'custom' }),
    wave_custom_solid: rf2Doc('rainbow_wave', { palette: 'custom' }, { type: 'solid', rgb: [1, 2, 3] }),
    wave_ramp_axis_field: rf2Doc('rainbow_wave', { palette: 'custom' }, rf2Ramp({ axis: 'x' })),
    wave_stops_seamless: rf2Doc('rainbow_wave', { palette: 'custom' }, rf2Ramp({ stops: [0, 500, 1000] })),
    wave_stops_key_trigger: rf2Doc(
      'rainbow_wave',
      { palette: 'custom', wrap: 'reset' },
      rf2Ramp({ stops: [0, 500, 1000] }),
      { trigger: { type: 'key_press' } },
    ),
    wave_stops_eased: rf2Doc(
      'rainbow_wave',
      { palette: 'custom', wrap: 'reset' },
      rf2Ramp({ stops: [0, 500, 1000] }),
      { time: { type: 'static', easing: 'linear' } },
    ),
    wave_alphas_add_blend: rf2Doc('rainbow_wave', { palette: 'custom' }, rf2Ramp({ alphas: [0, 1, 2] }), {
      blend: 'add',
    }),
    spiral_ramp_without_custom: rf2Doc('spiral', {}, rf2Ramp()),
    spiral_custom_without_ramp: rf2Doc('spiral', { palette: 'custom' }),
    spiral_stops_decreasing: rf2Doc('spiral', { palette: 'custom' }, rf2Ramp({ stops: [0, 900, 100] })),
    spiral_one_colour: rf2Doc('spiral', { palette: 'custom' }, { type: 'ramp', colors: [[1, 2, 3]] }),
  };
  for (const [name, doc] of Object.entries(bad)) {
    assert.equal(validate(doc).ok, false, name);
  }
});

test('review fix 2: a custom spiral is extended (10 params) like upstream, so the firmware loads it', () => {
  const program = normalize(rf2Doc('spiral', { palette: 'custom' }, rf2Ramp({ alphas: [255, 0, 255] })));
  const layer = program.layers[0];
  assert.equal(compileParamsCount(layer), 10);
  const back = decode(encode(program)).program.layers[0];
  assert.deepEqual(back.color.alphas, [255, 0, 255]);
  assert.equal(back.params.palette, 'custom');
});

test('review fix 2: reactive lifecycle carries no easing LUT on the wire (upstream layout)', () => {
  const doc = rf2Doc(
    'reactive',
    { color_mode: 'lifecycle', palette: 'custom', duration_ms: 1400 },
    rf2Ramp({ stops: [0, 250, 1000], alphas: [255, 170, 0] }),
    { trigger: { type: 'key_press' } },
  );
  const program = normalize(doc);
  assert.equal(program.layers[0].lut, null);
  const layerBytes = encodeLayer(program.layers[0], COMPOSABLE_PKG_VERSION);
  const { layer } = decodeLayer(layerBytes, 0, COMPOSABLE_PKG_VERSION);
  assert.equal(layer.lut, null);
  assert.deepEqual(layer.color.stops, [0, 250, 1000]);
  assert.deepEqual(layer.color.alphas, [255, 170, 0]);
  // name(1+1) + 3 + mask 22 + colour 6+4 + time 1+4 + 3 + 2 + params 1+4*2 + custom 1+9 + alphas 3 + stops 6
  assert.equal(layerBytes.length, 2 + 3 + 22 + 10 + 5 + 3 + 2 + 9 + 10 + 3 + 6);
});
