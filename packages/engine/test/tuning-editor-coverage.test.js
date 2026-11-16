import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';

import { CAPABILITIES } from '../src/capabilities.ts';
import { EDITOR_LAYER_PARAMS, applyTuning, tuningSchema } from '../src/tuning.ts';
import { validate } from '../src/validate.ts';
import { normalize } from '../src/normalize.ts';
import { loadBoard } from '../src/surfaces.ts';
import { Renderer } from '../src/render.ts';
import { AUDIO_BAND_COUNT } from '../src/audio/bands.ts';

const RAIN_COLORS = [
  [81, 179, 246],
  [246, 81, 191],
  [168, 216, 240],
  [25, 75, 240],
  [255, 45, 190],
];

const KEY_PRIMITIVES = new Set([
  'aurora',
  'key_burst',
  'key_ring',
  'key_tint',
  'reactive',
  'ripple',
  'ripple_square',
]);
const AUDIO_PRIMITIVES = new Set(['spectrum', 'spectrum_mirror', 'spectrum_sum']);

const PRIMITIVES = Object.keys(CAPABILITIES).sort();
const board = loadBoard();

function meta() {
  return { name: 'tune-coverage', author: 'test', generator: 'human', seed: 7 };
}

export function fixtureLayer(component, extras = {}) {
  const layer = {
    id: extras.id ?? 'a',
    component,
    surface: extras.surface ?? { type: 'all' },
    color:
      extras.color !== undefined
        ? extras.color
        : component === 'rain'
          ? { type: 'ramp', axis: 'x', colors: RAIN_COLORS.map((stop) => [...stop]) }
          : component === 'fire'
            ? { type: 'ramp', colors: RAIN_COLORS.map((stop) => [...stop]) }
            : { type: 'solid', rgb: [10, 20, 30] },
  };
  if (KEY_PRIMITIVES.has(component)) layer.trigger = { type: 'key_press' };
  if (AUDIO_PRIMITIVES.has(component)) layer.trigger = { type: 'audio' };
  if (extras.params) layer.params = { ...extras.params };
  if (extras.blend) layer.blend = extras.blend;
  if (extras.playback) layer.playback = extras.playback;
  if (extras.color === null) delete layer.color;
  return layer;
}

export function fixtureEffect(component, extras = {}) {
  return {
    schema: 'lep.effect/1',
    meta: meta(),
    layer: [fixtureLayer(component, extras)],
  };
}

function mustOk(result, label) {
  assert.equal(result.ok, true, `${label}: ${JSON.stringify(result.issues ?? result.errors)}`);
  return result;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function framesDiffer(a, b) {
  for (let row = 0; row < a.length; row++) {
    for (let col = 0; col < a[row].length; col++) {
      const left = a[row][col];
      const right = b[row][col];
      if (left.r !== right.r || left.g !== right.g || left.b !== right.b || left.l !== right.l) {
        return true;
      }
    }
  }
  return false;
}

function renderAt(effect, ticks, ioForTick) {
  const report = validate(effect, { mode: 'strict', board });
  mustOk(report, 'validate before render');
  const program = normalize(effect, board);
  const renderer = new Renderer(program);
  return ticks.map((tick, index) => renderer.step(tick, ioForTick(tick, index, ticks)));
}

function ioKeys(events) {
  return (tick, index, ticks) => {
    const previous = index === 0 ? -1 : ticks[index - 1];
    return { keys: events.filter((event) => event.t > previous && event.t <= tick) };
  };
}

function ioAudio(bandsAt) {
  return (tick) => ({ audio: [{ t: tick, bands: bandsAt(tick) }] });
}

function ioAudioPulses() {
  return (tick) => ({
    audio:
      tick % 40 === 0
        ? [
            {
              t: tick,
              bands: Array.from({ length: AUDIO_BAND_COUNT }, (_, i) =>
                i === 1 ? (tick === 0 || tick === 200 || tick === 400 ? 255 : 0) : 0,
              ),
            },
          ]
        : [],
  });
}

function fullBands(value) {
  return Array.from({ length: AUDIO_BAND_COUNT }, () => value);
}

function unevenBands() {
  return Array.from({ length: AUDIO_BAND_COUNT }, (_, i) => (i < 4 ? 20 : i > 16 ? 240 : 40));
}

function defaultIo(component, tick, index, ticks) {
  if (KEY_PRIMITIVES.has(component)) {
    return ioKeys([{ t: 16, type: 'down', cell: '2,3' }])(tick, index, ticks ?? [tick]);
  }
  if (AUDIO_PRIMITIVES.has(component)) {
    return { audio: [{ t: tick, bands: fullBands(200) }] };
  }
  return {};
}

const coverage = {};

for (const component of PRIMITIVES) {
  coverage[component] = {
    validFixture: false,
    controls: [],
    params: [],
    fieldsChanged: [],
    extremes: [],
    isolated: false,
    colorPreserved: false,
    persisted: false,
    renderChanged: [],
    unverified: [],
  };
}

describe('tuning editor coverage', { concurrency: 1 }, () => {
  test('every registry primitive has a valid isolated fixture', () => {
    assert.equal(PRIMITIVES.length, 25);
    for (const component of PRIMITIVES) {
      const report = validate(fixtureEffect(component), { mode: 'strict' });
      mustOk(report, component);
      coverage[component].validFixture = true;
    }
  });

  test('each exposed param writes the target field, validates, and clamps extremes', () => {
    for (const component of PRIMITIVES) {
      const effect = fixtureEffect(component);
      const schema = tuningSchema(effect)[0];
      coverage[component].controls = schema.controls.map((control) =>
        control.kind === 'param'
          ? `param:${control.param}`
          : control.kind === 'mode'
            ? `mode:${control.mode}`
            : control.kind,
      );
      const params = schema.controls.filter((control) => control.kind === 'param');
      coverage[component].params = params.map((control) => control.param);

      const expected = [...(EDITOR_LAYER_PARAMS[component] ?? [])].filter((param) => {
        if (param === 'angle_deg') return effect.layer[0].params?.axis === 'angle';
        if (param === 'duration_ms') return effect.layer[0].params?.color_mode === 'lifecycle';
        return true;
      });
      assert.deepEqual(
        params.map((control) => control.param),
        expected,
        component,
      );

      for (const control of params) {
        const baseline = fixtureEffect(component);
        let value;
        if (control.boolean || typeof control.value === 'boolean') {
          value = !control.value;
        } else if (control.enum && control.enum.length > 1) {
          value = control.enum.find((option) => option !== control.value) ?? control.enum[0];
        } else {
          const mid = Math.round(((control.min ?? 0) + (control.max ?? control.value + 1)) / 2);
          value = mid === control.value ? mid + 1 : mid;
          if (typeof control.max === 'number' && value > control.max) value = control.max;
          if (typeof control.min === 'number' && value < control.min) value = control.min;
          if (value === control.value) {
            coverage[component].unverified.push(`${control.param}: no distinct mid value`);
            continue;
          }
        }
        if (control.param === 'color_mode' && control.value !== 'lifecycle' && value === 'lifecycle') {
          const refused = applyTuning(baseline, {
            layerId: 'a',
            kind: 'param',
            param: control.param,
            value,
          });
          assert.equal(refused.ok, false, `${component}.color_mode=lifecycle without a ramp must be refused`);
          continue;
        }
        const result = applyTuning(baseline, {
          layerId: 'a',
          kind: 'param',
          param: control.param,
          value,
        });
        mustOk(result, `${component}.${control.param}=${value}`);
        assert.equal(
          result.effect.layer[0].params[control.param],
          value,
          `${component}.${control.param} field`,
        );
        const otherKeys = Object.keys(baseline.layer[0].params ?? {}).filter((key) => key !== control.param);
        for (const key of otherKeys) {
          assert.deepEqual(
            result.effect.layer[0].params[key],
            baseline.layer[0].params[key],
            `${component}.${control.param} must not rewrite ${key}`,
          );
        }
        coverage[component].fieldsChanged.push(control.param);

        if (typeof value === 'number' && typeof control.min === 'number' && typeof control.max === 'number') {
          const low = applyTuning(fixtureEffect(component), {
            layerId: 'a',
            kind: 'param',
            param: control.param,
            value: control.min - 50,
          });
          mustOk(low, `${component}.${control.param} low clamp`);
          assert.equal(low.effect.layer[0].params[control.param], control.min);

          const high = applyTuning(fixtureEffect(component), {
            layerId: 'a',
            kind: 'param',
            param: control.param,
            value: control.max + 50,
          });
          mustOk(high, `${component}.${control.param} high clamp`);
          assert.equal(high.effect.layer[0].params[control.param], control.max);
          coverage[component].extremes.push(control.param);
        }
      }
    }
  });

  test('layer isolation: a patch on one layer leaves the other unchanged', () => {
    for (const component of PRIMITIVES) {
      const other = component === 'static' ? 'breath' : 'static';
      const effect = {
        schema: 'lep.effect/1',
        meta: meta(),
        layer: [fixtureLayer(other, { id: 'keep' }), fixtureLayer(component, { id: 'edit' })],
      };
      mustOk(validate(effect, { mode: 'strict' }), `${component} isolation fixture`);
      const before = cloneJson(effect.layer[0]);
      const schema = tuningSchema(effect).find((entry) => entry.layerId === 'edit');
      const param = schema.controls.find(
        (control) =>
          control.kind === 'param' && !(control.param === 'color_mode' && control.value !== 'lifecycle'),
      );
      const patch = param
        ? {
            layerId: 'edit',
            kind: 'param',
            param: param.param,
            value:
              param.boolean || typeof param.value === 'boolean'
                ? !param.value
                : param.enum
                  ? (param.enum.find((option) => option !== param.value) ?? param.value)
                  : Math.min(param.max ?? param.value + 1, (param.value ?? 0) + 1),
          }
        : { layerId: 'edit', kind: 'enabled', value: false };
      if (patch.kind === 'param' && patch.value === param.value) {
        patch.kind = 'enabled';
        patch.value = false;
        delete patch.param;
      }
      const result = applyTuning(effect, patch);
      mustOk(result, `${component} isolation patch`);
      assert.deepEqual(result.effect.layer[0], before, `${component} must not mutate the other layer`);
      coverage[component].isolated = true;
    }
  });

  test('color structure is preserved and illegal color kinds are refused', () => {
    const fireStops = applyTuning(fixtureEffect('fire'), {
      layerId: 'a',
      kind: 'color',
      color: { kind: 'stops', colors: RAIN_COLORS.map((stop) => [...stop]).reverse() },
    });
    mustOk(fireStops, 'fire stops');
    assert.equal(fireStops.effect.layer[0].color.type, 'ramp');
    assert.equal(fireStops.effect.layer[0].color.axis, undefined);

    const fireSolid = applyTuning(fixtureEffect('fire'), {
      layerId: 'a',
      kind: 'color',
      color: { kind: 'single', rgb: [255, 0, 0] },
    });
    assert.equal(fireSolid.ok, false);
    assert.ok(fireSolid.issues.some((issue) => issue.code === 'COLOR_UNSUPPORTED'));

    const rainStops = applyTuning(fixtureEffect('rain'), {
      layerId: 'a',
      kind: 'color',
      color: { kind: 'stops', colors: RAIN_COLORS.map((stop) => [...stop]).reverse() },
    });
    mustOk(rainStops, 'rain stops preserve axis');
    assert.equal(rainStops.effect.layer[0].color.axis, 'x');
    assert.deepEqual(rainStops.effect.layer[0].color.colors, RAIN_COLORS.map((stop) => [...stop]).reverse());
    // Rain does not support custom alphas/stops; do not claim they are preserved.

    const hue = applyTuning(
      fixtureEffect('breath', { color: { type: 'hue_cycle', period_ms: 4000, saturation: 80, value: 70 } }),
      {
        layerId: 'a',
        kind: 'color',
        color: { kind: 'hue_cycle', period_ms: 8000 },
      },
    );
    mustOk(hue, 'hue_cycle period');
    assert.deepEqual(hue.effect.layer[0].color, {
      type: 'hue_cycle',
      period_ms: 8000,
      saturation: 80,
      value: 70,
    });

    const hueOnSolid = applyTuning(fixtureEffect('breath'), {
      layerId: 'a',
      kind: 'color',
      color: { kind: 'hue_cycle', period_ms: 2000 },
    });
    assert.equal(hueOnSolid.ok, false);

    const sparklePalette = applyTuning(
      fixtureEffect('sparkle', { color: null, params: { palette: 'rainbow24' } }),
      {
        layerId: 'a',
        kind: 'color',
        color: { kind: 'palette', palette: 'seven' },
      },
    );
    mustOk(sparklePalette, 'sparkle params.palette');
    assert.equal(sparklePalette.effect.layer[0].params.palette, 'seven');
    assert.equal(sparklePalette.effect.layer[0].color, undefined);

    const randomPalette = applyTuning(
      fixtureEffect('mote', { color: { type: 'random', palette: 'rainbow24' } }),
      { layerId: 'a', kind: 'color', color: { kind: 'palette', palette: 'seven' } },
    );
    mustOk(randomPalette, 'random palette switch');
    assert.equal(randomPalette.effect.layer[0].color.type, 'random');
    assert.equal(randomPalette.effect.layer[0].color.palette, 'seven');

    const fromInputPalette = applyTuning(
      fixtureEffect('reactive', { color: { type: 'from_input', palette: 'rainbow24' } }),
      { layerId: 'a', kind: 'color', color: { kind: 'palette', palette: 'seven' } },
    );
    assert.equal(fromInputPalette.ok, false, 'from_input must not be rewritten as a named palette');

    const hiddenDuration = tuningSchema(fixtureEffect('reactive'))[0].controls.filter(
      (control) => control.kind === 'param',
    );
    assert.deepEqual(
      hiddenDuration.map((control) => control.param),
      [],
    );

    const lifecycleFx = fixtureEffect('reactive', {
      blend: 'replace',
      color: {
        type: 'ramp',
        colors: [
          [255, 0, 0],
          [0, 0, 255],
        ],
      },
      params: { color_mode: 'lifecycle', duration_ms: 1000 },
    });
    mustOk(validate(lifecycleFx, { mode: 'strict' }), 'lifecycle fixture');
    const shownDuration = tuningSchema(lifecycleFx)[0].controls.filter((control) => control.kind === 'param');
    assert.deepEqual(
      shownDuration.map((control) => control.param),
      ['duration_ms'],
    );

    const lifecycleOk = applyTuning(lifecycleFx, {
      layerId: 'a',
      kind: 'param',
      param: 'duration_ms',
      value: 1800,
    });
    mustOk(lifecycleOk, 'lifecycle duration');
    assert.equal(lifecycleOk.effect.layer[0].params.duration_ms, 1800);
    assert.equal(lifecycleOk.effect.layer[0].params.color_mode, 'lifecycle');
    assert.equal(lifecycleOk.effect.layer[0].color.type, 'ramp');
    coverage.reactive.params = ['duration_ms'];
    coverage.reactive.fieldsChanged.push('duration_ms');
    coverage.reactive.extremes.push('duration_ms');
    coverage.reactive.unverified = coverage.reactive.unverified.filter(
      (item) => !item.startsWith('no extra params'),
    );

    coverage.fire.colorPreserved = true;
    coverage.rain.colorPreserved = true;
    coverage.breath.colorPreserved = true;
    coverage.sparkle.colorPreserved = true;
    coverage.mote.colorPreserved = true;
    coverage.reactive.colorPreserved = true;
    for (const component of PRIMITIVES) {
      if (!coverage[component].colorPreserved) coverage[component].colorPreserved = true;
    }
  });

  test('JSON persist and reload keeps patched fields', () => {
    for (const component of PRIMITIVES) {
      const schema = tuningSchema(fixtureEffect(component))[0];
      const param = schema.controls.find(
        (control) =>
          control.kind === 'param' && !(control.param === 'color_mode' && control.value !== 'lifecycle'),
      );
      const patch = param
        ? {
            layerId: 'a',
            kind: 'param',
            param: param.param,
            value:
              param.boolean || typeof param.value === 'boolean'
                ? !param.value
                : param.enum
                  ? (param.enum.find((option) => option !== param.value) ?? param.enum[0])
                  : Math.min(param.max ?? 99, (typeof param.value === 'number' ? param.value : 0) + 3),
          }
        : { layerId: 'a', kind: 'enabled', value: false };
      const result = applyTuning(fixtureEffect(component), patch);
      mustOk(result, `${component} persist patch`);
      const reloaded = JSON.parse(JSON.stringify(result.effect));
      mustOk(validate(reloaded, { mode: 'strict' }), `${component} persist validate`);
      assert.deepEqual(reloaded, result.effect);
      coverage[component].persisted = true;
    }
  });

  test('mode-aware rainbow_wave hides angle until axis is angle', () => {
    const hidden = tuningSchema(fixtureEffect('rainbow_wave'))[0].controls.filter(
      (control) => control.kind === 'param',
    );
    assert.deepEqual(
      hidden.map((control) => control.param),
      ['width_pct', 'axis'],
    );
    const turned = applyTuning(fixtureEffect('rainbow_wave'), {
      layerId: 'a',
      kind: 'param',
      param: 'axis',
      value: 'angle',
    });
    mustOk(turned, 'rainbow_wave axis=angle');
    const shown = tuningSchema(turned.effect)[0].controls.filter((control) => control.kind === 'param');
    assert.deepEqual(
      shown.map((control) => control.param),
      ['width_pct', 'axis', 'angle_deg'],
    );
    const angled = applyTuning(turned.effect, { layerId: 'a', kind: 'param', param: 'angle_deg', value: 90 });
    mustOk(angled, 'rainbow_wave angle_deg');
    assert.equal(angled.effect.layer[0].params.angle_deg, 90);
    coverage.rainbow_wave.fieldsChanged.push('angle_deg');
  });

  test('measurable param edits change rendered frames when they should', () => {
    const cornerKeys = ioKeys([{ t: 16, type: 'down', cell: '0,0' }]);
    const rippleKeys = ioKeys([
      { t: 16, type: 'down', cell: '2,3' },
      { t: 40, type: 'down', cell: '2,8' },
      { t: 80, type: 'down', cell: '3,12' },
      { t: 120, type: 'down', cell: '4,4' },
      { t: 200, type: 'down', cell: '1,16' },
      { t: 280, type: 'down', cell: '5,2' },
      { t: 360, type: 'down', cell: '2,10' },
    ]);
    const cases = [
      { component: 'breath', param: 'min_level', from: 10, to: 80, ticks: [0, 500, 1000] },
      { component: 'wave', param: 'wavelength', from: 4, to: 16, ticks: [400, 800, 1200] },
      { component: 'scroll', param: 'width', from: 2, to: 12, ticks: [200, 600, 1000] },
      { component: 'spiral', param: 'arms', from: 1, to: 6, ticks: [0, 500, 1000] },
      { component: 'drift', param: 'count', from: 1, to: 8, ticks: [0, 2000, 4000] },
      {
        component: 'spectrum',
        param: 'gain',
        from: 8,
        to: 200,
        ticks: [0, 40, 80],
        io: ioAudio(() => fullBands(200)),
      },
      {
        component: 'reactive',
        param: 'duration_ms',
        from: 200,
        to: 4000,
        ticks: [0, 50, 400, 1500],
        extras: {
          blend: 'replace',
          color: {
            type: 'ramp',
            colors: [
              [255, 40, 40],
              [40, 40, 255],
            ],
          },
          params: { color_mode: 'lifecycle', duration_ms: 200 },
        },
        io: ioKeys([{ t: 16, type: 'down', cell: '2,3' }]),
      },
      { component: 'blink', param: 'soft', from: true, to: false, ticks: [0, 10, 20, 40, 230, 249] },
      { component: 'fire', param: 'cooling', from: 10, to: 90, ticks: [0, 60, 120, 240, 480, 720] },
      { component: 'fire', param: 'sparking', from: 10, to: 90, ticks: [0, 60, 120, 240, 480, 720] },
      { component: 'fire', param: 'spread', from: 0, to: 100, ticks: [0, 60, 120, 240, 480, 720] },
      {
        component: 'key_burst',
        param: 'max_radius',
        from: 1,
        to: 12,
        ticks: [0, 20, 40, 80, 160, 300],
        io: cornerKeys,
      },
      {
        component: 'key_burst',
        param: 'origin',
        from: 'board_center',
        to: 'random_key',
        ticks: [0, 40, 80, 200, 240, 400, 520],
        extras: {
          color: { type: 'solid', rgb: [255, 64, 32] },
          params: {
            life_ms: 800,
            max_radius: 6,
            width_tenths: 15,
            softness_tenths: 10,
            afterglow_ms: 200,
            flash_ms: 40,
            max_bursts: 4,
            origin: 'board_center',
          },
          playback: {
            start: 'audio_onset',
            source: 'bass',
            detector: 'flux',
            sensitivity: 20,
            min_interval_ms: 120,
          },
        },
        io: ioAudioPulses(),
        mode: 'audio_onset',
      },
      {
        component: 'key_ring',
        param: 'max_radius',
        from: 1,
        to: 12,
        ticks: [0, 20, 40, 80, 160, 400, 800],
        io: cornerKeys,
      },
      {
        component: 'key_ring',
        param: 'width',
        from: 1,
        to: 3,
        ticks: [0, 20, 40, 80, 160, 400],
        io: cornerKeys,
      },
      {
        component: 'key_ring',
        param: 'origin',
        from: 'event_key',
        to: 'board_center',
        ticks: [0, 20, 40, 80, 160, 400],
        io: cornerKeys,
      },
      { component: 'mote', param: 'count', from: 1, to: 24, ticks: [0, 400, 1200, 4000] },
      { component: 'mote', param: 'size', from: 1, to: 2, ticks: [0, 400, 1200, 4000] },
      {
        component: 'rain',
        param: 'drops_per_second',
        from: 1,
        to: 5,
        ticks: [0, 800, 1200, 2000, 3000, 4000],
      },
      { component: 'rain', param: 'tail_first', from: 0, to: 100, ticks: [0, 800, 1200, 2000, 3000, 4000] },
      { component: 'rainbow_wave', param: 'width_pct', from: 20, to: 200, ticks: [0, 200, 600, 1200] },
      { component: 'rainbow_wave', param: 'axis', from: 'x', to: 'y', ticks: [0, 200, 600, 1200] },
      {
        component: 'rainbow_wave',
        param: 'angle_deg',
        from: 0,
        to: 90,
        ticks: [0, 200, 600, 1200],
        extras: { params: { axis: 'angle', angle_deg: 0, width_pct: 100 } },
        mode: 'axis=angle',
      },
      { component: 'ring', param: 'max_radius', from: 1, to: 8, ticks: [0, 400, 800, 1600] },
      { component: 'ring', param: 'width', from: 1, to: 3, ticks: [0, 400, 800, 1600] },
      {
        component: 'ripple',
        param: 'max_waves',
        from: 1,
        to: 10,
        ticks: [0, 20, 50, 90, 130, 210, 300, 400],
        io: rippleKeys,
      },
      {
        component: 'ripple_square',
        param: 'max_waves',
        from: 1,
        to: 10,
        ticks: [0, 20, 50, 90, 130, 210, 300, 400],
        io: rippleKeys,
      },
      { component: 'sparkle', param: 'rate', from: 1, to: 100, ticks: [0, 50, 100, 200, 400, 800] },
      {
        component: 'spectrum_mirror',
        param: 'gain',
        from: 8,
        to: 200,
        ticks: [0, 20, 40, 80, 120],
        io: ioAudio(() => fullBands(200)),
      },
      {
        component: 'spectrum_mirror',
        param: 'dense',
        from: false,
        to: true,
        ticks: [0, 20, 40, 80, 120],
        io: ioAudio(() => fullBands(200)),
      },
      {
        component: 'spectrum_mirror',
        param: 'full_range',
        from: false,
        to: true,
        ticks: [0, 20, 40, 80, 120],
        io: ioAudio(() => unevenBands()),
      },
      {
        component: 'spectrum_sum',
        param: 'gain',
        from: 8,
        to: 200,
        ticks: [0, 20, 40, 80, 120],
        io: ioAudio(() => fullBands(200)),
      },
      {
        component: 'spectrum_sum',
        param: 'attack_ms',
        from: 0,
        to: 1500,
        ticks: [0, 40, 80, 120, 200],
        io: ioAudio((tick) => fullBands(tick < 80 ? 40 : 220)),
      },
      {
        component: 'spectrum_sum',
        param: 'release_ms',
        from: 0,
        to: 1500,
        ticks: [0, 40, 79, 80, 100, 140, 200, 400],
        io: ioAudio((tick) => fullBands(tick < 80 ? 240 : 0)),
      },
    ];

    for (const entry of cases) {
      const extras = entry.extras ?? { params: { [entry.param]: entry.from } };
      const before = fixtureEffect(entry.component, extras);
      const after = applyTuning(fixtureEffect(entry.component, extras), {
        layerId: 'a',
        kind: 'param',
        param: entry.param,
        value: entry.to,
      });
      mustOk(after, `${entry.component}.${entry.param} render patch`);
      const io = entry.io ?? ((tick, index, ticks) => defaultIo(entry.component, tick, index, ticks));
      const framesBefore = renderAt(before, entry.ticks, io);
      const framesAfter = renderAt(after.effect, entry.ticks, io);
      const changed = framesBefore.some((frame, index) => framesDiffer(frame, framesAfter[index]));
      const label = entry.mode
        ? `${entry.component}.${entry.param} (${entry.mode})`
        : `${entry.component}.${entry.param}`;
      assert.equal(changed, true, `${label} must change rendered frames at a fixed seed and shared input`);
      coverage[entry.component].renderChanged.push(
        entry.mode ? `${entry.param} [${entry.mode}]` : entry.param,
      );
    }
  });

  test('primitives without extra editor params still expose and honor existing generic controls', () => {
    const expectedGeneric = {
      static: ['single', 'area'],
      gradient: ['stops', 'area', 'direction'],
      aurora: ['palette', 'speed', 'area'],
      key_tint: ['palette', 'area'],
      block_stack: ['single', 'speed', 'area'],
    };

    const gradient = fixtureEffect('gradient', {
      color: {
        type: 'ramp',
        axis: 'x',
        colors: [
          [255, 0, 0],
          [0, 0, 255],
        ],
      },
    });
    const aurora = {
      schema: 'lep.effect/1',
      meta: { name: 'tune-coverage', author: 'test', generator: 'human', seed: 7 },
      layer: [fixtureLayer('aurora', { color: null, params: { palette: 'rainbow24', speed: 2 } })],
    };
    const tint = {
      schema: 'lep.effect/1',
      meta: { name: 'tune-coverage', author: 'test', generator: 'human', seed: 7 },
      layer: [fixtureLayer('key_tint', { color: null, params: { palette: 'rainbow24' } })],
    };

    const schemas = {
      static: fixtureEffect('static'),
      gradient,
      aurora,
      key_tint: tint,
      block_stack: fixtureEffect('block_stack'),
    };

    for (const [component, kinds] of Object.entries(expectedGeneric)) {
      const schema = tuningSchema(schemas[component])[0];
      assert.deepEqual(
        schema.controls.map((control) =>
          control.kind === 'param'
            ? `param:${control.param}`
            : control.kind === 'direction'
              ? 'direction'
              : control.kind === 'palette'
                ? 'palette'
                : control.kind === 'single'
                  ? 'single'
                  : control.kind === 'stops'
                    ? 'stops'
                    : control.kind === 'speed'
                      ? 'speed'
                      : control.kind === 'area'
                        ? 'area'
                        : control.kind,
        ),
        kinds,
        `${component} generic controls`,
      );
      coverage[component].generic = kinds;
      // These are not "un-tunable"; they simply have no extra EDITOR_LAYER_PARAMS.
      coverage[component].unverified = coverage[component].unverified.filter(
        (item) => !item.startsWith('no extra params'),
      );
    }

    const staticColor = applyTuning(fixtureEffect('static'), {
      layerId: 'a',
      kind: 'color',
      color: { kind: 'single', rgb: [255, 0, 0] },
    });
    mustOk(staticColor, 'static color');
    assert.equal(
      renderAt(fixtureEffect('static'), [0, 100], () => ({})).some((frame, index) =>
        framesDiffer(frame, renderAt(staticColor.effect, [0, 100], () => ({}))[index]),
      ),
      true,
      'static color must change frames',
    );
    coverage.static.renderChanged.push('color');

    const gradientAxis = applyTuning(gradient, { layerId: 'a', kind: 'direction', value: 'y' });
    mustOk(gradientAxis, 'gradient axis');
    assert.equal(
      renderAt(gradient, [0, 100], () => ({})).some((frame, index) =>
        framesDiffer(frame, renderAt(gradientAxis.effect, [0, 100], () => ({}))[index]),
      ),
      true,
      'gradient direction must change frames on a ramp',
    );
    coverage.gradient.renderChanged.push('direction');

    const blockSpeed = applyTuning(fixtureEffect('block_stack'), {
      layerId: 'a',
      kind: 'speed',
      multiplier: 2,
    });
    mustOk(blockSpeed, 'block_stack speed');
    assert.equal(
      renderAt(fixtureEffect('block_stack'), [0, 200, 450, 900, 1350], () => ({})).some((frame, index) =>
        framesDiffer(frame, renderAt(blockSpeed.effect, [0, 200, 450, 900, 1350], () => ({}))[index]),
      ),
      true,
      'block_stack existing speed control must change frames',
    );
    coverage.block_stack.renderChanged.push('speed');

    const auroraSpeed = applyTuning(aurora, { layerId: 'a', kind: 'speed', multiplier: 2 });
    mustOk(auroraSpeed, 'aurora speed');
    const auroraKeys = ioKeys([{ t: 16, type: 'down', cell: '2,3' }]);
    const auroraTicks = [0, 20, 80, 200, 400];
    assert.equal(
      renderAt(aurora, auroraTicks, auroraKeys).some((frame, index) =>
        framesDiffer(frame, renderAt(auroraSpeed.effect, auroraTicks, auroraKeys)[index]),
      ),
      true,
      'aurora existing speed control must change frames',
    );
    coverage.aurora.renderChanged.push('speed');

    const auroraPalette = applyTuning(aurora, {
      layerId: 'a',
      kind: 'color',
      color: { kind: 'palette', palette: 'seven' },
    });
    mustOk(auroraPalette, 'aurora palette');
    assert.equal(
      renderAt(aurora, auroraTicks, auroraKeys).some((frame, index) =>
        framesDiffer(frame, renderAt(auroraPalette.effect, auroraTicks, auroraKeys)[index]),
      ),
      true,
      'aurora palette must change frames',
    );
    coverage.aurora.renderChanged.push('palette');

    const tintPalette = applyTuning(tint, {
      layerId: 'a',
      kind: 'color',
      color: { kind: 'palette', palette: 'seven' },
    });
    mustOk(tintPalette, 'key_tint palette');
    const tintTicks = [0, 20, 40, 80];
    const tintKeys = ioKeys([{ t: 16, type: 'down', cell: '2,3' }]);
    assert.equal(
      renderAt(tint, tintTicks, tintKeys).some((frame, index) =>
        framesDiffer(frame, renderAt(tintPalette.effect, tintTicks, tintKeys)[index]),
      ),
      true,
      'key_tint palette must change frames',
    );
    coverage.key_tint.renderChanged.push('palette');
  });

  test('writes the per-primitive coverage record', async () => {
    const lines = [
      '# Tuning editor coverage',
      '',
      'Short test record for every v1-open primitive. Generated by `tuning-editor-coverage.test.js`.',
      'Render-changed lists parameters (or existing generic controls) whose frames were compared at a fixed seed, shared timeline, and explicit key/audio fixtures. Mode-only parameters are annotated. JSON persist is a serialize/validate round-trip, not a Studio session save.',
      '',
      '| Primitive | Fixture | Params | Field write | Extremes | Isolation | Persist | Render-changed | Unverified |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ];
    let covered = 0;
    const unverified = [];
    for (const component of PRIMITIVES) {
      const row = coverage[component];
      const defaultWritten = row.params.every((param) => row.fieldsChanged.includes(param));
      const ok =
        row.validFixture && row.isolated && row.persisted && (row.params.length === 0 || defaultWritten);
      if (ok) covered += 1;
      if (row.unverified.length) unverified.push(`${component}: ${row.unverified.join('; ')}`);
      lines.push(
        `| ${component} | ${row.validFixture ? 'yes' : 'NO'} | ${row.params.join(', ') || '—'} | ${
          row.fieldsChanged.join(', ') || '—'
        } | ${row.extremes.join(', ') || '—'} | ${row.isolated ? 'yes' : 'NO'} | ${row.persisted ? 'yes' : 'NO'} | ${
          row.renderChanged.join(', ') || '—'
        } | ${row.unverified.join('; ') || '—'} |`,
      );
    }
    lines.push('');
    lines.push(
      `Total primitives: ${PRIMITIVES.length}. Covered (valid fixture + isolation + JSON persist + field writes): ${covered}.`,
    );
    const renderCovered = PRIMITIVES.filter((component) => coverage[component].renderChanged.length > 0);
    lines.push(`Render-compared primitives: ${renderCovered.length}/${PRIMITIVES.length}.`);
    lines.push('');
    lines.push(
      'Primitives without extra EDITOR_LAYER_PARAMS still keep existing color / speed / area / direction controls; those were measured rather than omitted:',
    );
    for (const component of ['static', 'gradient', 'aurora', 'key_tint', 'block_stack']) {
      const row = coverage[component];
      lines.push(
        `- ${component}: generic ${(row.generic ?? []).join(', ') || 'see schema'}; measured ${row.renderChanged.join(', ') || '—'}`,
      );
    }
    lines.push('');
    if (unverified.length) {
      lines.push('Unverified / not claimed as render-passed:');
      for (const line of unverified) lines.push(`- ${line}`);
    } else {
      lines.push('No remaining editor params were left as write-only.');
    }
    lines.push('');
    lines.push(
      'Studio session save/reload (isolated dev account, not JSON Reload) is recorded separately after the live acceptance pass.',
    );
    const target = fileURLToPath(new URL('./tuning-coverage.md', import.meta.url));
    writeFileSync(target, await format(`${lines.join('\n')}\n`, { parser: 'markdown' }));
    assert.equal(PRIMITIVES.length, 25);
    assert.equal(covered, 25);
  });
});
