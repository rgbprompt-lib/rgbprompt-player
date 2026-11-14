import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { validate, COST_WEIGHTS } from '../src/validate.ts';
import { VALIDATION_CODES } from '../src/types.ts';
import { MAX_LAYERS, MAX_PARAMS_PER_LAYER } from '../src/constants.ts';
import { buildCorpus } from '../../../tools/golden/corpus.mjs';

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

const meta = { name: 'validation', author: 'test', generator: 'human', seed: 7 };

function effect(layer = {}) {
  return {
    schema: 'lep.effect/1',
    meta: { ...meta },
    layer: [
      {
        id: 'a',
        component: 'static',
        surface: { type: 'all' },
        color: { type: 'solid', rgb: [1, 2, 3] },
        ...layer,
      },
    ],
  };
}

function codes(report) {
  return [...report.errors, ...report.warnings].map((entry) => entry.code);
}

function producersFor(code) {
  switch (code) {
    case 'SCHEMA':
      return () => null;
    case 'META_INVALID':
      return () => {
        const dsl = effect();
        dsl.meta.seed = -1;
        return dsl;
      };
    case 'LAYER_INVALID':
      return () => effect({ id: '' });
    case 'DUPLICATE_LAYER_ID':
      return () => {
        const dsl = effect();
        dsl.layer.push(structuredClone(dsl.layer[0]));
        return dsl;
      };
    case 'COMPONENT_UNKNOWN':
      return () => effect({ component: 'does_not_exist' });
    case 'COMPONENT_NOT_OPEN':
      return () => effect({ component: 'frame_sequence' });
    case 'SURFACE_INVALID':
      return () => effect({ surface: { type: 'does_not_exist' } });
    case 'SURFACE_EMPTY':
      return () => effect({ surface: { type: 'all', invert: true } });
    case 'COLOR_INVALID':
      return () => effect({ color: { type: 'solid', rgb: [300, 0, 0] } });
    case 'COLOR_UNSUPPORTED':
      return () =>
        effect({
          color: {
            type: 'ramp',
            colors: [
              [0, 0, 0],
              [255, 255, 255],
            ],
          },
        });
    case 'TIME_INVALID':
      return () => effect({ time: { type: 'does_not_exist' } });
    case 'TRIGGER_INVALID':
      return () => effect({ trigger: { type: 'does_not_exist' } });
    case 'PARAM_UNKNOWN':
      return () => effect({ component: 'rain', color: RAIN_COLOR, params: { unknown: 1 } });
    case 'PARAM_TYPE':
      return () => effect({ component: 'rain', color: RAIN_COLOR, params: { drops_per_second: 'fast' } });
    case 'PARAM_RANGE':
      return () => effect({ component: 'breath', params: { period_ms: 99 } });
    case 'PARAM_CONFLICT':
      return () =>
        effect({
          component: 'rain',
          color: RAIN_COLOR,
          params: { fall_min_ms: 1000, fall_max_ms: 500 },
        });
    case 'BUDGET_LAYERS':
      return () => {
        const dsl = effect();
        while (dsl.layer.length <= MAX_LAYERS) {
          dsl.layer.push({ ...structuredClone(dsl.layer[0]), id: `layer-${dsl.layer.length}` });
        }
        return dsl;
      };
    case 'BUDGET_PARAMS':
      return () => {
        const params = {};
        for (let i = 0; i <= MAX_PARAMS_PER_LAYER; i++) params[`p${i}`] = 1;
        return effect({ params });
      };
    case 'BUDGET_PALETTE':
      return () =>
        effect({
          component: 'gradient',
          color: {
            type: 'ramp',
            colors: Array.from({ length: 33 }, () => [1, 2, 3]),
          },
        });
    case 'BUDGET_BYTES':
      return () => {
        const dsl = effect();
        dsl.meta.padding = 'x'.repeat(70 * 1024);
        return dsl;
      };
    default:
      throw new Error(`no producer for validation code ${code}`);
  }
}

test('every validation code is produced by at least one input', () => {
  assert.ok(Object.isFrozen(VALIDATION_CODES));
  for (const code of VALIDATION_CODES) {
    const report = validate(producersFor(code)());
    assert.ok(codes(report).includes(code), `expected ${code}, got ${codes(report).join(', ') || 'none'}`);
  }
});

test('strict rejects out-of-range numbers; generate clamps a copy and leaves the input alone', () => {
  const cases = [
    {
      name: 'registry param',
      onlyRange: () => effect({ component: 'breath', params: { period_ms: 99 } }),
      expected: {
        path: 'layer[0].params.period_ms',
        code: 'PARAM_RANGE',
        from: 99,
        to: 100,
        read: (value) => value.layer[0].params.period_ms,
      },
    },
    {
      name: 'solid RGB channel',
      onlyRange: () => effect({ color: { type: 'solid', rgb: [300, 0, 0] } }),
      expected: {
        path: 'layer[0].color.rgb[0]',
        code: 'COLOR_INVALID',
        from: 300,
        to: 255,
        read: (value) => value.layer[0].color.rgb[0],
      },
    },
    {
      name: 'sparkle rate',
      onlyRange: () => effect({ component: 'sparkle', params: { rate: 150 } }),
      expected: {
        path: 'layer[0].params.rate',
        code: 'PARAM_RANGE',
        from: 150,
        to: 100,
        read: (value) => value.layer[0].params.rate,
      },
    },
  ];

  for (const item of cases) {
    const input = item.onlyRange();
    const snapshot = structuredClone(input);

    const strict = validate(input, { mode: 'strict' });
    assert.equal(strict.ok, false, item.name);
    assert.equal(strict.clamps.length, 0, item.name);
    assert.equal(strict.value, null, item.name);
    assert.ok(
      strict.errors.some((entry) => entry.code === item.expected.code && entry.path === item.expected.path),
      `${item.name}: ${JSON.stringify(strict.errors)}`,
    );

    const generated = validate(input, { mode: 'generate' });
    assert.equal(generated.ok, true, `${item.name}: ${JSON.stringify(generated.errors)}`);
    assert.deepEqual(generated.clamps, [
      {
        path: item.expected.path,
        from: item.expected.from,
        to: item.expected.to,
      },
    ]);
    assert.equal(item.expected.read(generated.value), item.expected.to, item.name);
    assert.deepEqual(input, snapshot, `${item.name}: input must not be mutated`);
  }
});

test('components that are not open in v1 are rejected in both modes', () => {
  for (const component of ['frame_sequence', 'layer_event']) {
    for (const mode of ['strict', 'generate']) {
      const report = validate(effect({ component }), { mode });
      assert.equal(report.ok, false, `${component} ${mode}`);
      assert.equal(report.clamps.length, 0, `${component} ${mode}`);
      assert.equal(report.value, null, `${component} ${mode}`);
      assert.ok(
        report.errors.some(
          (entry) => entry.code === 'COMPONENT_NOT_OPEN' && entry.path === 'layer[0].component',
        ),
        `${component} ${mode}: ${JSON.stringify(report.errors)}`,
      );
    }
  }
});

test('wrong type and non-integer values are errors in both modes and never clamp', () => {
  const cases = [
    effect({ component: 'sparkle', params: { rate: 1.5 } }),
    effect({ component: 'rain', color: RAIN_COLOR, params: { drops_per_second: 'fast' } }),
    effect({ color: { type: 'solid', rgb: [1.5, 0, 0] } }),
  ];
  for (const input of cases) {
    const strict = validate(input, { mode: 'strict' });
    const generated = validate(input, { mode: 'generate' });
    assert.equal(strict.ok, false, JSON.stringify(strict.errors));
    assert.equal(generated.ok, false, JSON.stringify(generated.errors));
    assert.equal(strict.clamps.length, 0);
    assert.equal(generated.clamps.length, 0);
    assert.equal(generated.value, null);
  }
});

test('budget reports layers, estimated cost and UTF-8 DSL bytes', () => {
  const examples = {
    'red-static.json': { layers: 1, estCostUnits: 132, bytes: 201 },
    'party.json': { layers: 3, estCostUnits: 924, bytes: 519 },
  };
  for (const [file, expected] of Object.entries(examples)) {
    const dsl = JSON.parse(readFileSync(new URL(`../data/examples/${file}`, import.meta.url), 'utf8'));
    assert.deepEqual(validate(dsl).budget, expected, file);
  }
  assert.deepEqual(COST_WEIGHTS, { stateless: 1, keyEventOrStateful: 2, audio: 4 });
});

test('the DSL byte limit rejects documents above 64 KB in both modes', () => {
  const dsl = effect();
  dsl.meta.padding = 'x'.repeat(70 * 1024);
  for (const mode of ['strict', 'generate']) {
    const report = validate(dsl, { mode });
    assert.equal(report.ok, false, mode);
    assert.ok(report.budget.bytes > 64 * 1024, mode);
    assert.ok(
      report.errors.some((entry) => entry.code === 'BUDGET_BYTES' && entry.path === 'budget.bytes'),
      JSON.stringify(report.errors),
    );
  }
});

test('every example and golden corpus effect validates strictly with no clamps', () => {
  const examplesDir = fileURLToPath(new URL('../data/examples/', import.meta.url));
  const examples = readdirSync(examplesDir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => [file, JSON.parse(readFileSync(`${examplesDir}${file}`, 'utf8'))]);

  for (const [name, dsl] of examples) {
    const report = validate(dsl);
    assert.equal(report.ok, true, `${name}: ${JSON.stringify(report.errors)}`);
    assert.equal(report.errors.length, 0, name);
    assert.equal(report.clamps.length, 0, name);
    assert.equal(report.value, dsl, name);
  }

  for (const entry of buildCorpus()) {
    const report = validate(entry.effect);
    assert.equal(report.ok, true, `${entry.id}: ${JSON.stringify(report.errors)}`);
    assert.equal(report.errors.length, 0, entry.id);
    assert.equal(report.clamps.length, 0, entry.id);
  }
});

test('execution_profile must be composable-v1 when present and may be omitted', () => {
  const missing = effect();
  assert.equal(validate(missing).ok, true);

  const ok = effect();
  ok.meta.execution_profile = 'composable-v1';
  assert.equal(validate(ok).ok, true);

  const bad = effect();
  bad.meta.execution_profile = 'legacy';
  const report = validate(bad);
  assert.equal(report.ok, false);
  assert.equal(
    report.errors.some((e) => e.path === 'meta.execution_profile'),
    true,
  );
});
