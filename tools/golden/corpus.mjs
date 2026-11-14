// Deterministic golden corpus for the reference engine.
//
// Cases are rebuilt from this file on every run; no randomness is used here.
// Variant values stay inside the ranges declared by
// packages/engine/data/schemas/primitive-registry.json.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { componentNames, getComponent, EXECUTION_CONTRACT } from '@rgbprompt/engine';

const REPO_ROOT = new URL('../../', import.meta.url);
const EXAMPLES_DIR = new URL('packages/engine/data/examples/', REPO_ROOT);

const SEED = 7;
const OPEN_BUT_EXCLUDED = new Set(['frame_sequence', 'layer_event']);

// Components that only produce output when the caller supplies key events.
export const KEY_COMPONENTS = new Set([
  'key_ring',
  'key_burst',
  'reactive',
  'ripple',
  'ripple_square',
  'aurora',
  'key_tint',
]);

// Components that only produce output when the caller supplies audio bands.
export const AUDIO_COMPONENTS = new Set(['spectrum', 'spectrum_mirror', 'spectrum_sum']);

// Eight down/up pairs on eight distinct cells. Timestamps deliberately do not
// align with 20/33/40 ms steps (docs/specs/ENGINE.md §5.2).
const TYPING_SCRIPT = [
  { tick: 137, type: 'down', cell: '2,3' },
  { tick: 263, type: 'up', cell: '2,3' },
  { tick: 611, type: 'down', cell: '3,2' },
  { tick: 907, type: 'up', cell: '3,2' },
  { tick: 1171, type: 'down', cell: '3,3' },
  { tick: 1439, type: 'up', cell: '3,3' },
  { tick: 1873, type: 'down', cell: '3,4' },
  { tick: 2111, type: 'up', cell: '3,4' },
  { tick: 2687, type: 'down', cell: '2,5' },
  { tick: 2953, type: 'up', cell: '2,5' },
  { tick: 3517, type: 'down', cell: '4,5' },
  { tick: 3847, type: 'up', cell: '4,5' },
  { tick: 4639, type: 'down', cell: '2,6' },
  { tick: 4981, type: 'up', cell: '2,6' },
  { tick: 5821, type: 'down', cell: '3,7' },
  { tick: 6113, type: 'up', cell: '3,7' },
];

// Dense typing script for the input-timeline cases: chords at the same
// millisecond, presses a few ms apart, more simultaneous presses than
// key_burst's default four slots, a pair that shares a 40 ms frame but not a
// 20 ms frame, a down+up inside one 20 ms frame, and same-time down/up pairs.
const DENSE_TYPING_SCRIPT = [
  { tick: 37, type: 'down', cell: '2,3' },
  { tick: 37, type: 'down', cell: '2,5' },
  { tick: 37, type: 'down', cell: '3,7' },
  { tick: 97, type: 'up', cell: '2,3' },
  { tick: 97, type: 'up', cell: '2,5' },
  { tick: 97, type: 'up', cell: '3,7' },
  { tick: 101, type: 'down', cell: '3,2' },
  { tick: 104, type: 'down', cell: '3,3' },
  { tick: 108, type: 'down', cell: '3,4' },
  { tick: 113, type: 'up', cell: '3,2' },
  { tick: 119, type: 'up', cell: '3,3' },
  { tick: 126, type: 'up', cell: '3,4' },
  { tick: 151, type: 'down', cell: '2,3' },
  { tick: 151, type: 'down', cell: '3,2' },
  { tick: 151, type: 'down', cell: '3,3' },
  { tick: 151, type: 'down', cell: '3,4' },
  { tick: 151, type: 'down', cell: '2,5' },
  { tick: 151, type: 'down', cell: '4,5' },
  { tick: 239, type: 'up', cell: '2,3' },
  { tick: 239, type: 'up', cell: '3,2' },
  { tick: 239, type: 'up', cell: '3,3' },
  { tick: 239, type: 'up', cell: '3,4' },
  { tick: 239, type: 'up', cell: '2,5' },
  { tick: 239, type: 'up', cell: '4,5' },
  { tick: 325, type: 'down', cell: '2,6' },
  { tick: 345, type: 'down', cell: '3,7' },
  { tick: 385, type: 'up', cell: '2,6' },
  { tick: 395, type: 'up', cell: '3,7' },
  { tick: 401, type: 'down', cell: '2,6' },
  { tick: 407, type: 'up', cell: '2,6' },
  { tick: 501, type: 'down', cell: '3,7' },
  { tick: 501, type: 'up', cell: '3,7' },
  { tick: 501, type: 'down', cell: '2,5' },
  { tick: 501, type: 'up', cell: '2,5' },
];

// 22 bands every 20 ms for 10 s. The pattern is deterministic and exercises
// both low and high bands; low bands also cross the spectrum beat threshold.
const AUDIO_SCRIPT = Array.from({ length: 500 }, (_, i) => ({
  tick: i * 20,
  bands: Array.from({ length: 22 }, (_, b) => (i * 7 + b * 13) % 256),
}));

// A second deterministic script for the audio effects: loud bursts, an 800 ms
// all-zero silence, an abrupt loud-to-low drop held for 800 ms, a gradual
// decline, another silence, then alternating bursts. The first script never
// goes quiet or drops, so it cannot exercise the silence/decay/peak-fall paths.
function altBands(i) {
  if (i < 40) return 255;
  if (i < 80) return 0;
  if (i < 120) return 220;
  if (i < 160) return 8;
  if (i < 200) return Math.max(0, 255 - Math.floor(((i - 160) * 255) / 39));
  if (i < 240) return 0;
  return i % 40 < 20 ? 255 : 12;
}

const ALT_AUDIO_SCRIPT = Array.from({ length: 500 }, (_, i) => ({
  tick: i * 20,
  bands: Array.from({ length: 22 }, (_, b) => Math.max(0, Math.min(255, altBands(i) - (b % 3)))),
}));

const DEFAULT_GRADIENT_COLOR = {
  type: 'ramp',
  axis: 'x',
  colors: [
    [255, 0, 0],
    [0, 0, 255],
  ],
};

const RAIN_COLOR = {
  type: 'ramp',
  axis: 'x',
  colors: [
    [81, 179, 246],
    [246, 81, 191],
    [168, 216, 240],
    [25, 75, 240],
    [255, 45, 190],
  ],
};

const solid = (rgb) => ({ type: 'solid', rgb });
const ramp = (colors, axis = 'x') => ({ type: 'ramp', colors, axis });

// Two documented variants per open primitive. `id` values are the stable case
// suffixes; layer overrides are merged over the default layer.
const VARIANTS = {
  static: [
    {
      id: 'alphas-blue',
      note: 'regions surface (alphas) and a deep blue solid color',
      layer: { surface: { type: 'regions', regions: ['alphas'] }, color: solid([0, 40, 160]) },
    },
    {
      id: 'quad-green',
      note: 'cells surface (2x2 corner block) and a green solid color',
      layer: {
        surface: { type: 'cells', cells: ['0,0', '0,1', '1,0', '1,1'] },
        color: solid([0, 220, 40]),
      },
    },
  ],
  gradient: [
    {
      id: 'axis-y',
      note: 'a two-color ramp on the y axis',
      layer: {
        color: ramp(
          [
            [255, 0, 0],
            [0, 0, 255],
          ],
          'y',
        ),
      },
    },
    {
      id: 'radial',
      note: 'a three-color ramp on the radial axis',
      layer: {
        color: ramp(
          [
            [0, 0, 0],
            [0, 255, 128],
            [255, 255, 255],
          ],
          'radial',
        ),
      },
    },
  ],
  breath: [
    {
      id: 'fast-shallow',
      note: 'period_ms=1200, min_level=30',
      layer: { params: { period_ms: 1200, min_level: 30 } },
    },
    {
      id: 'slow-deep',
      note: 'period_ms=5000, min_level=0',
      layer: { params: { period_ms: 5000, min_level: 0 } },
    },
  ],
  blink: [
    {
      id: 'even-soft',
      note: 'on_ms=500, off_ms=500, soft=true (default easing)',
      layer: { params: { on_ms: 500, off_ms: 500, soft: true } },
    },
    {
      id: 'short-hard',
      note: 'on_ms=120, off_ms=880, soft=false',
      layer: { params: { on_ms: 120, off_ms: 880, soft: false } },
    },
  ],
  rainbow_wave: [
    {
      id: 'reverse-fast',
      note: 'period_ms=1500, direction=reverse',
      layer: { params: { period_ms: 1500, direction: 'reverse' } },
    },
    {
      id: 'axis-y-seven',
      note: 'period_ms=5000, axis=y, palette=seven',
      layer: { params: { period_ms: 5000, axis: 'y', palette: 'seven' } },
    },
  ],
  wave: [
    {
      id: 'short-reverse',
      note: 'period_ms=1200, wavelength=4, direction=reverse',
      layer: { params: { period_ms: 1200, wavelength: 4, direction: 'reverse' } },
    },
    {
      id: 'tall-slow',
      note: 'period_ms=4000, axis=y, wavelength=16',
      layer: { params: { period_ms: 4000, axis: 'y', wavelength: 16 } },
    },
  ],
  scroll: [
    {
      id: 'wide-reverse',
      note: 'period_ms=900, width=6, direction=reverse',
      layer: { params: { period_ms: 900, width: 6, direction: 'reverse' } },
    },
    {
      id: 'vertical-thin',
      note: 'period_ms=2500, axis=y, width=3',
      layer: { params: { period_ms: 2500, axis: 'y', width: 3 } },
    },
  ],
  sparkle: [
    {
      id: 'dense-long',
      note: 'rate=30, decay_ms=800',
      layer: { params: { rate: 30, decay_ms: 800 } },
    },
    {
      id: 'sparse-short-seven',
      note: 'rate=4, decay_ms=200, palette=seven',
      layer: { params: { rate: 4, decay_ms: 200, palette: 'seven' } },
    },
  ],
  drift: [
    {
      id: 'vertical-large',
      note: 'period_ms=9000, count=8, size=3, motion=vertical, wobble=2',
      layer: { params: { period_ms: 9000, count: 8, size: 3, motion: 'vertical', wobble: 2 } },
    },
    {
      id: 'both-reverse-small',
      note: 'period_ms=30000, count=3, size=1, motion=both, wobble=0, direction=reverse',
      layer: {
        params: {
          period_ms: 30000,
          count: 3,
          size: 1,
          motion: 'both',
          wobble: 0,
          direction: 'reverse',
        },
      },
    },
  ],
  ring: [
    {
      id: 'fast-wide-reverse',
      note: 'period_ms=700, life_ms=2000, max_radius=6, width=2, direction=reverse',
      layer: {
        params: { period_ms: 700, life_ms: 2000, max_radius: 6, width: 2, direction: 'reverse' },
      },
    },
    {
      id: 'slow-narrow',
      note: 'period_ms=2500, life_ms=8000, max_radius=2, width=3',
      layer: { params: { period_ms: 2500, life_ms: 8000, max_radius: 2, width: 3 } },
    },
  ],
  mote: [
    {
      id: 'many-large-horizontal',
      note: 'period_ms=12000, count=24, size=2, motion=horizontal',
      layer: { params: { period_ms: 12000, count: 24, size: 2, motion: 'horizontal' } },
    },
    {
      id: 'few-small-reverse',
      note: 'period_ms=6000, count=6, size=1, motion=vertical, direction=reverse',
      layer: {
        params: { period_ms: 6000, count: 6, size: 1, motion: 'vertical', direction: 'reverse' },
      },
    },
  ],
  key_ring: [
    {
      id: 'short-wide-reverse',
      note: 'life_ms=600, max_radius=8, width=3, max_waves=2, direction=reverse',
      layer: {
        params: { life_ms: 600, max_radius: 8, width: 3, max_waves: 2, direction: 'reverse' },
      },
    },
    {
      id: 'long-multi-seven',
      note: 'life_ms=2500, max_radius=3, width=1, max_waves=4, palette=seven',
      layer: { params: { life_ms: 2500, max_radius: 3, width: 1, max_waves: 4, palette: 'seven' } },
    },
  ],
  block_stack: [
    {
      id: 'fast-seven',
      note: 'step_ms=150, palette=seven',
      layer: { params: { step_ms: 150, palette: 'seven' } },
    },
    {
      id: 'slow-rainbow',
      note: 'step_ms=900, palette=rainbow24',
      layer: { params: { step_ms: 900, palette: 'rainbow24' } },
    },
  ],
  key_burst: [
    {
      id: 'wide-soft',
      note: 'life_ms=800, max_radius=10, wide soft ring, afterglow 300 ms, flash 40 ms',
      layer: {
        params: {
          life_ms: 800,
          max_radius: 10,
          width_tenths: 25,
          softness_tenths: 30,
          afterglow_ms: 300,
          flash_ms: 40,
          palette: 'rainbow24',
          max_bursts: 8,
        },
      },
    },
    {
      id: 'tiny-hard',
      note: 'life_ms=2000, max_radius=3, thin hard ring, no afterglow, no flash',
      layer: {
        params: {
          life_ms: 2000,
          max_radius: 3,
          width_tenths: 5,
          softness_tenths: 0,
          afterglow_ms: 0,
          flash_ms: 0,
          palette: 'seven',
          max_bursts: 2,
        },
      },
    },
  ],
  fire: [
    {
      id: 'tall-calm',
      note: 'slow steps, strong cooling, few sparks, default colours',
      layer: { params: { step_ms: 120, cooling: 80, sparking: 30, spread: 20 } },
    },
    {
      id: 'sideways-blue',
      note: 'fast flames travelling right with a custom ramp',
      layer: {
        color: {
          type: 'ramp',
          colors: [
            [0, 0, 0],
            [0, 40, 160],
            [60, 160, 255],
            [220, 240, 255],
          ],
        },
        params: { step_ms: 30, cooling: 20, sparking: 90, spread: 80, direction: 'right' },
      },
    },
  ],
  rain: [
    {
      id: 'heavy-fast',
      note: 'fast dense rain with a short shower period',
      layer: {
        color: RAIN_COLOR,
        params: {
          fall_min_ms: 300,
          fall_max_ms: 500,
          drops_per_second: 5,
          shower_period_s: 3,
          shower_extra: 2,
          tail_first: 70,
          tail_second: 20,
          splash_ms: 80,
        },
      },
    },
    {
      id: 'light-slow',
      note: 'slow sparse rain with a long shower period',
      layer: {
        color: RAIN_COLOR,
        params: {
          fall_min_ms: 1200,
          fall_max_ms: 1500,
          drops_per_second: 1,
          shower_period_s: 20,
          shower_extra: 0,
          tail_first: 10,
          tail_second: 5,
          splash_ms: 400,
        },
      },
    },
  ],
  reactive: [
    {
      id: 'slow-seven',
      note: 'speed=0 (slowest), palette=seven',
      layer: { params: { speed: 0, palette: 'seven' } },
    },
    {
      id: 'fast-rainbow',
      note: 'speed=4 (fastest), palette=rainbow24',
      layer: { params: { speed: 4, palette: 'rainbow24' } },
    },
  ],
  ripple: [
    {
      id: 'square-fast',
      note: 'speed=4, max_waves=3, direction=square',
      layer: { params: { speed: 4, max_waves: 3, direction: 'square' } },
    },
    {
      id: 'single-slow',
      note: 'speed=0, max_waves=1, direction=horizontal',
      layer: { params: { speed: 0, max_waves: 1, direction: 'horizontal' } },
    },
  ],
  ripple_square: [
    {
      id: 'fast-two',
      note: 'speed=4, max_waves=2',
      layer: { params: { speed: 4, max_waves: 2 } },
    },
    {
      id: 'slow-five',
      note: 'speed=0, max_waves=5',
      layer: { params: { speed: 0, max_waves: 5 } },
    },
  ],
  aurora: [
    {
      id: 'fast-seven',
      note: 'speed=4, palette=seven',
      layer: { params: { speed: 4, palette: 'seven' } },
    },
    {
      id: 'slow-rainbow',
      note: 'speed=0, palette=rainbow24',
      layer: { params: { speed: 0, palette: 'rainbow24' } },
    },
  ],
  spectrum: [
    {
      id: 'dense-peak-beat',
      note: 'gain=80, peak_ms=500, dense=true, beat=true, palette=seven',
      layer: {
        params: { gain: 80, palette: 'seven', peak_ms: 500, dense: true, beat: true },
      },
    },
    {
      id: 'quiet',
      note: 'gain=10, non-dense, no peak hold, palette=rainbow24',
      layer: { params: { gain: 10, palette: 'rainbow24' } },
    },
  ],
  spectrum_mirror: [
    {
      id: 'loud-seven',
      note: 'gain=120, palette=seven',
      layer: { params: { gain: 120, palette: 'seven' } },
    },
    {
      id: 'silent',
      note: 'gain=0, palette=rainbow24',
      layer: { params: { gain: 0, palette: 'rainbow24' } },
    },
  ],
  spectrum_sum: [
    {
      id: 'loud-seven',
      note: 'gain=200, palette=seven',
      layer: { params: { gain: 200, palette: 'seven' } },
    },
    {
      id: 'quiet',
      note: 'gain=16, palette=rainbow24',
      layer: { params: { gain: 16, palette: 'rainbow24' } },
    },
  ],
  key_tint: [
    {
      id: 'rainbow',
      note: 'palette=rainbow24',
      layer: { params: { palette: 'rainbow24' } },
    },
    {
      id: 'seven',
      note: 'palette=seven',
      layer: { params: { palette: 'seven' } },
    },
  ],
  spiral: [
    {
      id: 'fast-dense-reverse',
      note: 'period_ms=1000, arms=8, twist=0, beam=500, soft_edge=200, direction=reverse',
      layer: {
        params: {
          period_ms: 1000,
          arms: 8,
          twist: 0,
          beam: 500,
          direction: 'reverse',
          soft_edge: 200,
        },
      },
    },
    {
      id: 'slow-single',
      note: 'period_ms=8000, arms=1, twist=2000, beam=100',
      layer: { params: { period_ms: 8000, arms: 1, twist: 2000, beam: 100 } },
    },
  ],
};

// ---- coverage cases (M0-T4b) ----------------------------------------------
// These cases pin renderer branches that the per-primitive defaults and the two
// documented variants do not reach. They are grouped by the engine concern they
// exercise; keep the group comments when adding cases.

// Every time type and field the execution contract allows on each time-reading
// primitive (execution-contract.json); drift only runs on static time.
const TIME_FIELDS = {
  breath: { period_ms: 1700, min_level: 35, phase_ms: 300 },
  blink: { on_ms: 300, off_ms: 700, soft: false, phase_ms: 137 },
  rain: { period_ms: 12000, min_level: 40 },
  drift: { period_ms: 5000, phase_ms: 400 },
};

function timeCoverageCases() {
  const cases = [];
  for (const component of ['breath', 'blink', 'rain', 'drift']) {
    const contract = EXECUTION_CONTRACT.primitives[component];
    const fields = Object.fromEntries(
      Object.entries(TIME_FIELDS[component]).filter(([key]) => contract.timeFields.includes(key)),
    );
    for (const type of contract.timeTypes) {
      const suffix = type.replace(/_/g, '-');
      for (const mode of Object.keys(fields).length ? ['defaults', 'fields'] : ['defaults']) {
        // defaults: omit modifier fields so the renderer hard-coded fallbacks
        // are used; fields: supply non-default values.
        const time = mode === 'fields' ? { type, ...fields } : { type };
        const effect = makeEffect(`${component} time ${type} ${mode}`, makeLayer(component, { time }));
        cases.push({
          id: `cov-time-${component.replace(/_/g, '-')}-${suffix}-${mode}`,
          effect,
          inputs: inputsForEffect(effect),
        });
      }
    }
  }
  return cases;
}

// Every color type resolves on `gradient`, which resolves colour per cell.
function colorCoverageCases() {
  const definitions = [
    [
      'palette-index',
      {
        type: 'palette_index',
        palette: 'custom',
        colors: [
          [10, 20, 30],
          [200, 100, 50],
          [0, 255, 128],
        ],
        index: 1,
      },
    ],
    ['hue-cycle', { type: 'hue_cycle', period_ms: 2500, saturation: 210, value: 180 }],
  ];
  const cases = definitions.map(([suffix, color]) => {
    const effect = makeEffect(`gradient color ${suffix}`, makeLayer('gradient', { color }));
    return { id: `cov-color-${suffix}`, effect, inputs: inputsForEffect(effect) };
  });
  // A random colour source only exists on reactive (one draw per press).
  const random = makeEffect(
    'reactive color random',
    makeLayer('reactive', { color: { type: 'random', palette: 'seven' } }),
  );
  cases.push({ id: 'cov-color-random', effect: random, inputs: inputsForEffect(random) });
  return cases;
}

// Audio-effect paths need bursts, silence and drops. These cases use the
// alternate deterministic script; the silent case supplies no audio at all so
// the `!audio` half of the silence check is exercised too.
function audioCoverageCases() {
  const definitions = [
    ['spectrum-bursts', 'spectrum', { params: { gain: 255, dense: true, beat: true, peak_ms: 300 } }],
    ['spectrum-mirror-drops', 'spectrum_mirror', { params: { gain: 160 } }],
    ['spectrum-sum-gradual', 'spectrum_sum', { params: { gain: 120 } }],
  ];
  const cases = definitions.map(([suffix, component, extra]) => {
    const effect = makeEffect(`${component} ${suffix}`, makeLayer(component, extra));
    return { id: `cov-audio-${suffix}`, effect, inputs: altInputsForEffect(effect) };
  });
  const silent = makeEffect(
    'spectrum no audio',
    makeLayer('spectrum', {
      params: { gain: 64, dense: true, beat: true, peak_ms: 200 },
    }),
  );
  cases.push({
    id: 'cov-audio-spectrum-no-audio',
    effect: silent,
    inputs: { keyEvents: [], audio: [] },
  });
  return cases;
}

// Easing curves are baked into a per-layer LUT by normalize; these cases pin
// every preset plus the bezier and imported-LUT forms.
function easingCoverageCases() {
  const definitions = [
    ['linear', 'linear'],
    ['pulse', 'pulse'],
    ['ease-in', 'ease-in'],
    ['ease-out', 'ease-out'],
    ['ease-in-out', 'ease-in-out'],
    ['bezier', { bezier: [0.42, 0, 0.58, 1] }],
    ['lut-resample', { lut: [0, 250, 1000] }],
    ['lut-lossless', { lut: Array.from({ length: 33 }, (_, i) => Math.round((i * 1000) / 32)) }],
  ];
  return definitions.map(([suffix, easing]) => {
    const effect = makeEffect(
      `breath easing ${suffix}`,
      makeLayer('breath', { time: { type: 'breath', easing } }),
    );
    return { id: `cov-easing-${suffix}`, effect, inputs: inputsForEffect(effect) };
  });
}

// Every surface type accepted by expandSurface, plus invert and the ansi104-v2
// board profile (the examples only use the legacy/generic and v1 boards).
function surfaceCoverageCases() {
  const definitions = [
    ['rows', { type: 'rows', rows: [0, 2, 4] }],
    ['rows-default', { type: 'rows' }],
    ['cols', { type: 'cols', cols: [1, 5, 10] }],
    ['cols-default', { type: 'cols' }],
    ['regions-all', { type: 'regions', regions: ['all'] }],
    ['invert', { type: 'cells', cells: ['0,0', '1,1', '2,2'], invert: true }],
  ];
  const cases = definitions.map(([suffix, surface]) => {
    const effect = makeEffect(
      `static surface ${suffix}`,
      makeLayer('static', { surface, color: solid([12, 34, 56]) }),
    );
    return { id: `cov-surface-${suffix}`, effect, inputs: inputsForEffect(effect) };
  });
  const v2 = makeEffect('static ansi104-v2', makeLayer('static', { color: solid([12, 34, 56]) }));
  v2.meta.region_profile = 'ansi104-v2';
  cases.push({ id: 'cov-region-profile-v2', effect: v2, inputs: inputsForEffect(v2) });
  return cases;
}

// Compositing: every blend plus replace with opacity below 255. The two layers
// guarantee a non-black destination for add/max/mask.
function compositeCoverageCases() {
  const definitions = [
    ['replace-opacity-100', 'replace', 100],
    ['add-opacity-128', 'add', 128],
    ['max-opacity-200', 'max', 200],
    ['mask-opacity-64', 'mask', 64],
  ];
  return definitions.map(([suffix, blend, opacity]) => {
    const effect = {
      schema: 'lep.effect/1',
      meta: { name: `composite ${suffix}`, author: 'golden', generator: 'human', seed: SEED },
      layer: [
        makeLayer('static', { id: 'base', color: solid([30, 60, 90]) }),
        makeLayer('breath', { id: 'top', color: solid([120, 40, 200]), blend, opacity }),
      ],
    };
    return { id: `cov-composite-${suffix}`, effect, inputs: inputsForEffect(effect) };
  });
}

// Solid-color cases for every renderer with a per-layer colour branch. The
// defaults and variants above mostly rely on the omitted-color palette path.
function primitiveColorCoverageCases() {
  const color = solid([60, 120, 200]);
  const definitions = [
    ['blink', 'blink', {}],
    ['wave', 'wave', {}],
    ['scroll', 'scroll', {}],
    ['spiral', 'spiral', { params: { soft_edge: 120 } }],
    ['drift', 'drift', {}],
    ['ring', 'ring', {}],
    ['key-ring', 'key_ring', {}],
    ['key-burst', 'key_burst', {}],
    ['mote', 'mote', {}],
    ['sparkle', 'sparkle', {}],
    ['reactive', 'reactive', {}],
    ['ripple', 'ripple', {}],
  ];
  return definitions.map(([suffix, component, extra]) => {
    const effect = makeEffect(`${component} solid color`, makeLayer(component, { color, ...extra }));
    return { id: `cov-color-primitive-${suffix}`, effect, inputs: inputsForEffect(effect) };
  });
}

// Remaining renderer branches: masked surfaces, saturated compositing, seed 0
// (the renderers treat seed 0 as 1), the fastest block-stack cadence and the
// two spectrum density modes.
function primitiveBranchCoverageCases() {
  const stack = makeEffect(
    'block_stack fastest',
    makeLayer('block_stack', {
      surface: { type: 'cells', cells: ['0,0', '0,1', '1,0', '1,1', '2,2', '3,3'] },
      color: solid([90, 40, 160]),
      params: { step_ms: 50, palette: 'seven' },
    }),
  );
  const ring = makeEffect(
    'ring masked',
    makeLayer('ring', { surface: { type: 'cells', cells: ['0,0', '0,1', '0,2'] } }),
  );
  const spectrumMasked = makeEffect(
    'spectrum masked',
    makeLayer('spectrum', {
      surface: { type: 'cells', cells: ['0,0', '0,1', '1,0', '1,1', '2,2', '3,3'] },
      params: { gain: 64 },
    }),
  );
  const spectrumMaskedPeak = makeEffect(
    'spectrum masked peak',
    makeLayer('spectrum', {
      surface: { type: 'cells', cells: ['0,0', '0,1', '1,0', '1,1', '2,2', '3,3'] },
      params: { gain: 64, dense: true, peak_ms: 200 },
    }),
  );
  const saturated = {
    schema: 'lep.effect/1',
    meta: { name: 'composite add saturated', author: 'golden', generator: 'human', seed: SEED },
    layer: [
      makeLayer('static', { id: 'base', color: solid([200, 200, 200]) }),
      makeLayer('static', { id: 'top', color: solid([200, 200, 200]), blend: 'add' }),
    ],
  };
  const seedZero = makeEffect(
    'drift seed zero',
    makeLayer('drift', { color: solid([40, 200, 120]), params: { period_ms: 4000 } }),
  );
  seedZero.meta.seed = 0;
  const seedZeroRain = makeEffect('rain seed zero', makeLayer('rain', { params: {} }));
  seedZeroRain.meta.seed = 0;
  const seedZeroRing = makeEffect(
    'ring seed zero long',
    makeLayer('ring', {
      params: { period_ms: 200, life_ms: 65535, max_radius: 8, width: 3 },
    }),
  );
  seedZeroRing.meta.seed = 0;
  // Seeds at and above 2^31: the firmwares read the seed as a u32.
  const seedHighMote = makeEffect(
    'mote seed high',
    makeLayer('mote', {
      color: solid([70, 230, 220]),
      params: { period_ms: 26000, count: 8, motion: 'both' },
    }),
  );
  seedHighMote.meta.seed = 4268958413;
  // Parameters ported from the upstream toolchain (ENGINE.md §5.3).
  const ported = [
    [
      'cov-wave-angle',
      makeLayer('rainbow_wave', { params: { axis: 'angle', angle_deg: 35, width_pct: 60 } }),
    ],
    [
      'cov-wave-angle-far',
      makeLayer('rainbow_wave', { params: { axis: 'angle', angle_deg: 250, palette: 'seven' } }),
    ],
    [
      'cov-wave-mirror',
      makeLayer('rainbow_wave', { params: { spatial_direction: 'mirror', width_pct: 150 } }),
    ],
    [
      'cov-wave-mirror-reverse-y',
      makeLayer('rainbow_wave', { params: { axis: 'y', spatial_direction: 'mirror_reverse' } }),
    ],
    [
      'cov-wave-reset-narrow',
      makeLayer('rainbow_wave', { params: { wrap: 'reset', width_pct: 40, spatial_direction: 'reverse' } }),
    ],
    ['cov-wave-uniform', makeLayer('rainbow_wave', { params: { axis: 'uniform', period_ms: 1500 } })],
    // time.phase_ms shifts the rainbow_wave clock (firmware u32 phase clock).
    ['cov-wave-phase', makeLayer('rainbow_wave', { time: { type: 'static', phase_ms: 1700 } })],
    [
      'cov-spiral-off-centre',
      makeLayer('spiral', { params: { center_x: 150, center_y: 900, color_twist: 1600 } }),
    ],
    ['cov-spiral-flat-colour', makeLayer('spiral', { params: { color_twist: 0, arms: 3 } })],
    [
      'cov-reactive-lifecycle',
      makeLayer('reactive', {
        trigger: { type: 'key_press' },
        color: {
          type: 'ramp',
          colors: [
            [255, 255, 255],
            [255, 120, 0],
            [60, 0, 0],
          ],
        },
        params: { color_mode: 'lifecycle', duration_ms: 700 },
      }),
    ],
    [
      'cov-fire-down-masked',
      makeLayer('fire', {
        surface: { type: 'cells', cells: ['1,3', '2,3', '3,3', '1,4', '2,4', '3,4', '2,5'] },
        params: { direction: 'down' },
      }),
    ],
    ['cov-fire-left', makeLayer('fire', { params: { direction: 'left', spread: 0 } })],
    [
      'cov-key-ring-wide',
      makeLayer('key_ring', { params: { max_radius: 16, origin: 'board_center', envelope: 'fade_in_out' } }),
    ],
  ].map(([id, layer]) => {
    const effect = makeEffect(id, layer);
    return { id, effect, inputs: inputsForEffect(effect) };
  });
  return [
    ...ported,
    { id: 'cov-block-stack-fastest', effect: stack, inputs: inputsForEffect(stack) },
    { id: 'cov-ring-masked', effect: ring, inputs: inputsForEffect(ring) },
    { id: 'cov-spectrum-masked', effect: spectrumMasked, inputs: inputsForEffect(spectrumMasked) },
    {
      id: 'cov-spectrum-masked-peak',
      effect: spectrumMaskedPeak,
      inputs: inputsForEffect(spectrumMaskedPeak),
    },
    { id: 'cov-composite-add-saturated', effect: saturated, inputs: inputsForEffect(saturated) },
    { id: 'cov-seed-zero-drift', effect: seedZero, inputs: inputsForEffect(seedZero) },
    { id: 'cov-seed-zero-rain', effect: seedZeroRain, inputs: inputsForEffect(seedZeroRain) },
    { id: 'cov-seed-zero-ring', effect: seedZeroRing, inputs: inputsForEffect(seedZeroRing) },
    { id: 'cov-seed-high-mote', effect: seedHighMote, inputs: inputsForEffect(seedHighMote) },
    ...productOnlyCases(),
  ];
}

// Product-only documents (ADR-0017): the engine renders them and the .lep round trip
// keeps them, but the firmware export rejects them. upstream:device and the C check
// skip them; golden still pins their frames.
function productOnlyCases() {
  const key = { type: 'key_press', scope: 'all' };
  const twoRipples = makeEffect(
    'two ripple layers',
    makeLayer('ripple', { color: solid([255, 40, 0]), trigger: key }),
  );
  twoRipples.layer.push(
    makeLayer('ripple', {
      id: 'b',
      blend: 'add',
      color: solid([0, 80, 255]),
      trigger: key,
      params: { speed: 2 },
    }),
  );
  const twoReactive = makeEffect(
    'two reactive layers',
    makeLayer('reactive', { color: solid([255, 255, 255]), trigger: key }),
  );
  twoReactive.layer.push(
    makeLayer('reactive', {
      id: 'b',
      blend: 'add',
      color: { type: 'random', palette: 'seven' },
      trigger: key,
    }),
  );
  const randomGradient = makeEffect(
    'random gradient',
    makeLayer('gradient', { color: { type: 'random', palette: 'seven' } }),
  );
  const threshold = makeEffect(
    'spectrum threshold',
    makeLayer('spectrum', { trigger: { type: 'audio', threshold: 0.4 } }),
  );
  return [
    ['product-two-ripples', twoRipples],
    ['product-two-reactive', twoReactive],
    ['product-random-gradient', randomGradient],
    ['product-audio-threshold', threshold],
  ].map(([id, effect]) => ({ id, effect, inputs: inputsForEffect(effect) }));
}

// Audio state-machine branches that the two scripted streams do not reach:
// missing bands (silence via an absent window), duplicate timestamps,
// unsorted samples and a dense layer with peak hold disabled.
function audioBranchCoverageCases() {
  const nullBands = [
    { tick: 0, bands: new Array(22).fill(255) },
    { tick: 40, bands: new Array(22).fill(128) },
    { tick: 20, bands: null },
    { tick: 20, bands: new Array(22).fill(0) },
    { tick: 80, bands: null },
    { tick: 120, bands: new Array(22).fill(255) },
    { tick: 160, bands: null },
  ];
  const gapEffect = makeEffect(
    'spectrum null bands',
    makeLayer('spectrum', { params: { gain: 255, dense: true, beat: true, peak_ms: 200 } }),
  );
  const denseNoPeakEffect = makeEffect(
    'spectrum dense no peak',
    makeLayer('spectrum', { params: { gain: 180, dense: true, peak_ms: 0 } }),
  );
  const nonDenseBeatEffect = makeEffect(
    'spectrum non-dense beat',
    makeLayer('spectrum', { params: { gain: 200, beat: true } }),
  );
  return [
    {
      id: 'cov-audio-spectrum-null-bands',
      effect: gapEffect,
      inputs: { keyEvents: [], audio: nullBands },
    },
    {
      id: 'cov-audio-spectrum-dense-no-peak',
      effect: denseNoPeakEffect,
      inputs: { keyEvents: [], audio: ALT_AUDIO_SCRIPT },
    },
    {
      id: 'cov-audio-spectrum-non-dense-beat',
      effect: nonDenseBeatEffect,
      inputs: { keyEvents: [], audio: ALT_AUDIO_SCRIPT },
    },
  ];
}

// Dense key input: chords, presses only a few ms apart, more presses than
// key_burst slots, and a down+up inside one frame. These use DENSE_TYPING_SCRIPT
// instead of the sparse TYPING_SCRIPT attached by inputsForEffect().
function denseKeyCoverageCases() {
  const definitions = [
    ['key-ring', 'key_ring'],
    ['key-burst', 'key_burst'],
    ['key-tint', 'key_tint'],
    ['reactive', 'reactive'],
    ['ripple', 'ripple'],
    ['ripple-square', 'ripple_square'],
    ['aurora', 'aurora'],
  ];
  return definitions.map(([suffix, component]) => {
    const effect = makeEffect(`dense keys ${suffix}`, makeLayer(component));
    return {
      id: `cov-keys-dense-${suffix}`,
      effect,
      inputs: cloneInputs({ keyEvents: DENSE_TYPING_SCRIPT, audio: [] }),
    };
  });
}

// Disabled layers stay in the DSL (so they can be re-enabled) but must not
// affect output. These vectors pin that behaviour without changing any
// existing vector.
function disabledLayerCases() {
  const skipped = {
    schema: 'lep.effect/1',
    meta: { name: 'disabled layer skipped', author: 'golden', generator: 'human', seed: SEED },
    layer: [
      makeLayer('static', { id: 'base', color: solid([20, 120, 200]) }),
      makeLayer('blink', {
        id: 'off',
        color: solid([255, 0, 0]),
        params: { on_ms: 60, off_ms: 60, soft: false },
        enabled: false,
      }),
    ],
  };
  // A disabled layer ahead of the enabled ones: it is not on the wire, so the
  // encoding equals the upstream encoding of the device document.
  const leadingDisabled = {
    schema: 'lep.effect/1',
    meta: { name: 'leading disabled layer', author: 'golden', generator: 'human', seed: SEED },
    layer: [
      makeLayer('static', { id: 'off', color: solid([10, 200, 90]), enabled: false }),
      makeLayer('breath', {
        id: 'on',
        color: solid([200, 60, 20]),
        time: { type: 'breath', period_ms: 1200 },
      }),
      makeLayer('blink', { id: 'off2', color: solid([0, 0, 255]), enabled: false }),
    ],
  };
  return [
    { id: 'cov-disabled-layer-skipped', effect: skipped, inputs: inputsForEffect(skipped) },
    {
      id: 'cov-disabled-leading-layer',
      effect: leadingDisabled,
      inputs: inputsForEffect(leadingDisabled),
    },
  ];
}

// Shared playback (`playback`), `color.stops` and `color.alphas` (engine 0.6.0,
// A-2). Through player-fixtures these also pin player-core parity and the
// `.lep` round trip of the playback extension and colour types 7/8/9.
// Key-started playback begins on the frame where the press is first seen
// (upstream lepc and firmware semantics, ENGINE.md §2), so the key-started
// cases are listed in cadence-exempt.json: they are frame-identical across
// engines at the same cadence, not across cadences.
function playbackPaletteCoverageCases() {
  const ramp3 = [
    [0, 0, 0],
    [255, 80, 0],
    [255, 220, 40],
  ];
  const effect = (name, layers) => ({
    schema: 'lep.effect/1',
    meta: { name, author: 'golden', generator: 'human', seed: SEED },
    layer: layers,
  });
  const none = () => cloneInputs({ keyEvents: [], audio: [] });
  const keys = () => cloneInputs({ keyEvents: TYPING_SCRIPT, audio: [] });
  return [
    {
      id: 'cov-playback-auto-cycles',
      effect: effect('playback auto cycles', [
        makeLayer('rainbow_wave', {
          params: { period_ms: 1500 },
          playback: { start: 'auto', duration_ms: 1200, cycles: 3, pause_ms: 400 },
        }),
      ]),
      inputs: none(),
    },
    {
      id: 'cov-playback-breath-linear-loop',
      effect: effect('playback breath linear loop', [
        makeLayer('breath', {
          color: solid([0, 180, 255]),
          params: { period_ms: 1600, min_level: 10 },
          time: { type: 'static', easing: 'linear', phase_ms: 200 },
          playback: { start: 'auto', duration_ms: 900, cycles: 0, pause_ms: 300 },
        }),
      ]),
      inputs: none(),
    },
    {
      id: 'cov-playback-key-press',
      effect: effect('playback key press', [
        makeLayer('static', { id: 'base', color: solid([4, 8, 40]) }),
        makeLayer('blink', {
          id: 'flash',
          blend: 'add',
          color: solid([255, 255, 255]),
          params: { on_ms: 120, off_ms: 80, soft: true },
          playback: { start: 'key_press', retrigger: 'restart', duration_ms: 700, cycles: 1 },
        }),
      ]),
      inputs: keys(),
    },
    {
      id: 'cov-playback-selected-press',
      effect: effect('playback selected press', [
        makeLayer('scroll', {
          color: solid([255, 0, 80]),
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
        }),
      ]),
      inputs: keys(),
    },
    {
      id: 'cov-palette-stops-fire',
      effect: effect('palette stops fire', [
        makeLayer('fire', {
          color: { type: 'ramp', colors: ramp3, stops: [0, 200, 1000] },
          params: { step_ms: 50, cooling: 35, sparking: 70, spread: 50, direction: 'up' },
        }),
      ]),
      inputs: none(),
    },
    {
      id: 'cov-palette-alphas-fire',
      effect: effect('palette alphas fire', [
        makeLayer('static', { id: 'base', color: solid([0, 40, 160]) }),
        makeLayer('fire', {
          id: 'veil',
          color: { type: 'ramp', colors: ramp3, alphas: [0, 120, 255] },
          params: { step_ms: 60, cooling: 50, sparking: 60, spread: 30, direction: 'right' },
        }),
      ]),
      inputs: none(),
    },
    {
      id: 'cov-palette-stops-alphas-fire',
      effect: effect('palette stops and alphas fire', [
        makeLayer('static', { id: 'base', color: solid([10, 0, 30]) }),
        makeLayer('fire', {
          id: 'flame',
          color: { type: 'ramp', colors: ramp3, stops: [0, 400, 1000], alphas: [0, 160, 255] },
          params: { step_ms: 40, cooling: 40, sparking: 50, spread: 40, direction: 'up' },
        }),
      ]),
      inputs: none(),
    },
    // Review fix 2 (2026-11-12): custom palette ramps with stops / alphas on
    // rainbow_wave, spiral and reactive lifecycle (the spec's full set).
    {
      id: 'cov-palette-custom-wave',
      effect: effect('custom palette wave', [
        makeLayer('rainbow_wave', {
          params: { palette: 'custom', period_ms: 2400 },
          color: {
            type: 'ramp',
            colors: [
              [255, 0, 60],
              [255, 200, 0],
              [0, 200, 255],
              [120, 0, 255],
            ],
          },
        }),
      ]),
      inputs: none(),
    },
    {
      id: 'cov-palette-stops-alphas-wave',
      effect: effect('palette stops and alphas wave', [
        makeLayer('static', { id: 'base', color: solid([0, 0, 40]) }),
        makeLayer('rainbow_wave', {
          id: 'band',
          params: {
            palette: 'custom',
            wrap: 'reset',
            axis: 'angle',
            angle_deg: 30,
            width_pct: 80,
            period_ms: 3000,
          },
          color: {
            type: 'ramp',
            colors: [
              [255, 0, 60],
              [255, 200, 0],
              [0, 200, 255],
              [120, 0, 255],
            ],
            stops: [0, 150, 700, 1000],
            alphas: [255, 90, 200, 0],
          },
        }),
      ]),
      inputs: none(),
    },
    {
      id: 'cov-palette-alphas-spiral',
      effect: effect('palette alphas spiral', [
        makeLayer('static', { id: 'base', color: solid([20, 0, 0]) }),
        makeLayer('spiral', {
          id: 'arms',
          params: { palette: 'custom', period_ms: 4000, arms: 2, twist: 650, beam: 320, soft_edge: 100 },
          color: {
            type: 'ramp',
            colors: [
              [255, 0, 60],
              [255, 200, 0],
              [0, 200, 255],
              [120, 0, 255],
            ],
            alphas: [255, 0, 180, 255],
          },
        }),
      ]),
      inputs: none(),
    },
    {
      id: 'cov-palette-stops-alphas-spiral',
      effect: effect('palette stops and alphas spiral', [
        makeLayer('static', { id: 'base', color: solid([0, 10, 10]) }),
        makeLayer('spiral', {
          id: 'arms',
          params: {
            palette: 'custom',
            period_ms: 5000,
            arms: 3,
            twist: 900,
            beam: 400,
            color_twist: 300,
            center_x: 400,
            center_y: 600,
          },
          color: {
            type: 'ramp',
            colors: [
              [255, 0, 60],
              [255, 200, 0],
              [0, 200, 255],
              [120, 0, 255],
            ],
            stops: [0, 300, 600, 1000],
            alphas: [40, 255, 255, 40],
          },
        }),
      ]),
      inputs: none(),
    },
    {
      id: 'cov-palette-stops-alphas-reactive',
      effect: effect('palette stops and alphas reactive lifecycle', [
        makeLayer('static', { id: 'base', color: solid([5, 5, 20]) }),
        makeLayer('reactive', {
          id: 'afterglow',
          trigger: { type: 'key_press' },
          params: { color_mode: 'lifecycle', duration_ms: 1400, palette: 'custom' },
          color: {
            type: 'ramp',
            colors: [
              [255, 255, 255],
              [40, 160, 255],
              [10, 20, 60],
            ],
            stops: [0, 250, 1000],
            alphas: [255, 170, 0],
          },
        }),
      ]),
      inputs: keys(),
    },
  ];
}

function coverageCases() {
  return [
    ...timeCoverageCases(),
    ...colorCoverageCases(),
    ...audioCoverageCases(),
    ...audioBranchCoverageCases(),
    ...easingCoverageCases(),
    ...surfaceCoverageCases(),
    ...compositeCoverageCases(),
    ...primitiveColorCoverageCases(),
    ...primitiveBranchCoverageCases(),
    ...denseKeyCoverageCases(),
    ...disabledLayerCases(),
    ...playbackPaletteCoverageCases(),
  ];
}

function openPrimitiveNames() {
  return componentNames().filter((name) => {
    if (OPEN_BUT_EXCLUDED.has(name)) return false;
    const component = getComponent(name);
    return !component || component.implemented !== false;
  });
}

function makeLayer(component, overrides = {}) {
  const layer = { id: 'a', component, surface: { type: 'all' }, ...overrides };
  if (component === 'rain' && !layer.color) layer.color = RAIN_COLOR;
  // A colour-required primitive's default case carries the documented default colour.
  if (!('color' in layer) && EXECUTION_CONTRACT.primitives[component]?.colorRequired)
    layer.color = component === 'gradient' ? DEFAULT_GRADIENT_COLOR : solid([255, 255, 255]);
  return layer;
}

function makeEffect(name, layer) {
  return {
    schema: 'lep.effect/1',
    meta: { name, author: 'golden', generator: 'human', seed: SEED },
    layer: [layer],
  };
}

function cloneInputs(inputs) {
  return {
    keyEvents: inputs.keyEvents.map((event) => ({ ...event })),
    audio: inputs.audio.map((frame) => ({ tick: frame.tick, bands: frame.bands.slice() })),
  };
}

// Attach the typing script when a case contains a key-driven primitive and the
// audio band sequence when it contains an audio primitive.
export function inputsForEffect(effect) {
  const components = new Set(effect.layer.map((layer) => layer.component));
  const keyEvents = [...components].some((name) => KEY_COMPONENTS.has(name)) ? TYPING_SCRIPT : [];
  const audio = [...components].some((name) => AUDIO_COMPONENTS.has(name)) ? AUDIO_SCRIPT : [];
  return cloneInputs({ keyEvents, audio });
}

// Attach the alternate audio script (bursts, silence, drops) when the effect
// contains an audio primitive.
function altInputsForEffect(effect) {
  const inputs = inputsForEffect(effect);
  const components = new Set(effect.layer.map((layer) => layer.component));
  if ([...components].some((name) => AUDIO_COMPONENTS.has(name))) {
    inputs.audio = ALT_AUDIO_SCRIPT.map((frame) => ({
      tick: frame.tick,
      bands: frame.bands.slice(),
    }));
  }
  return inputs;
}

function exampleCases() {
  const files = readdirSync(fileURLToPath(EXAMPLES_DIR))
    .filter((file) => file.endsWith('.json'))
    .sort();
  return files.map((file) => {
    const effect = JSON.parse(readFileSync(fileURLToPath(new URL(file, EXAMPLES_DIR)), 'utf8'));
    return {
      id: `example-${file.replace(/\.json$/, '')}`,
      effect,
      inputs: inputsForEffect(effect),
    };
  });
}

function primitiveCases() {
  const cases = [];
  for (const name of openPrimitiveNames()) {
    const defaultEffect = makeEffect(`${name} default`, makeLayer(name));
    cases.push({
      id: `prim-${name.replace(/_/g, '-')}-default`,
      effect: defaultEffect,
      inputs: inputsForEffect(defaultEffect),
    });

    const variants = VARIANTS[name];
    if (!Array.isArray(variants) || variants.length !== 2) {
      throw new Error(`golden corpus: expected exactly two variants for "${name}"`);
    }
    for (const variant of variants) {
      const effect = makeEffect(`${name} ${variant.id}`, makeLayer(name, variant.layer));
      cases.push({
        id: `prim-${name.replace(/_/g, '-')}-${variant.id}`,
        effect,
        inputs: inputsForEffect(effect),
      });
    }
  }
  return cases;
}

export function buildCorpus() {
  return [...exampleCases(), ...primitiveCases(), ...coverageCases()];
}
