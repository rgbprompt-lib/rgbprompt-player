import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { validate } from '../src/validate.ts';
import { normalize } from '../src/normalize.ts';
import { Renderer, simulate } from '../src/render.ts';
import { encode, decode } from '../src/lep.ts';
import { programToDsl } from '../src/roundtrip.ts';
import { sparkleIdHash, timeSparkleEvents } from '../src/sparkle_time.ts';

const fixtureUrl = new URL('./fixtures/sparkle_time.effect.json', import.meta.url);
const fresh = () => JSON.parse(readFileSync(fileURLToPath(fixtureUrl), 'utf8'));

const meta = { name: 'timed stars', author: 't', generator: 'human', seed: 11 };

function one(layer = {}) {
  return {
    schema: 'lep.effect/1',
    meta,
    layer: [
      {
        id: 'stars',
        component: 'sparkle',
        surface: { type: 'all' },
        params: { rate: 80, decay_ms: 1200 },
        ...layer,
      },
    ],
  };
}

function build(dsl) {
  const report = validate(dsl);
  assert.equal(report.ok, true, `valid: ${report.errors.join('; ')}`);
  return normalize(dsl);
}

test('time sparkle is identical at common timestamps across frame rates, cold starts, duplicates and rewinds', () => {
  const d = fresh();
  for (const step of [1, 10, 20, 40, 100, 1000]) {
    const r = new Renderer(build(d));
    for (let t = 0; t <= 4000; t += step) {
      const f = r.step(t, {});
      if (t % 1000 === 0) {
        assert.deepEqual(f, new Renderer(build(d)).step(t, {}), `step ${step}, tick ${t}`);
      }
    }
  }
  const r = new Renderer(build(d));
  for (const t of [70000, 1, 1, 65535, 0xffffffff, 0, 0xfffffff0, 80]) {
    assert.deepEqual(r.step(t, {}), new Renderer(build(d)).step(t, {}), `rewind tick ${t}`);
  }
});

test('stable layer IDs isolate random streams, selected cells and reorder; timed layers do not consume legacy RNG', () => {
  const d = fresh();
  const single = structuredClone(d);
  single.layer.pop();
  const a = new Renderer(build(single));
  const b = new Renderer(build(d));
  const reordered = structuredClone(d);
  [reordered.layer[1], reordered.layer[2]] = [reordered.layer[2], reordered.layer[1]];
  const c = new Renderer(build(reordered));

  for (let t = 0; t < 10000; t += 73) {
    const fa = a.step(t, {});
    const fb = b.step(t, {});
    const fc = c.step(t, {});
    for (let r = 0; r < 6; r++) {
      for (let col = 0; col <= 10; col++) assert.deepEqual(fa[r][col], fb[r][col]);
    }
    assert.deepEqual(fb, fc);
  }

  const r = new Renderer(build(one()));
  const state = r.rng.s;
  r.step(70000, {});
  assert.equal(r.rng.s, state);

  const changed = one();
  changed.layer[0].id = 'other';
  assert.notDeepEqual(
    new Renderer(build(one())).step(70000, {}),
    new Renderer(build(changed)).step(70000, {}),
  );

  const narrow = one();
  narrow.layer[0].surface = { type: 'cells', cells: ['2,2'] };
  for (let t = 0; t < 20000; t += 17) {
    const f = new Renderer(build(narrow)).step(t, {});
    for (let row = 0; row < 6; row++) {
      for (let col = 0; col < 22; col++) {
        if (row !== 2 || col !== 2) assert.equal(f[row][col].l, 0);
      }
    }
  }
});

test('16 bounded lanes handle extreme lifetimes and rate is monotone for fixed schedule', () => {
  for (const decay of [1, 500, 65535]) {
    const d = one();
    d.layer[0].params.decay_ms = decay;
    const l = normalize(d).layers[0];
    for (let t = 0; t < 200000; t += 313) {
      const events = timeSparkleEvents(l, t, 11);
      assert.ok(events.length <= 16);
      assert.equal(new Set(events.map((sparkle) => sparkle.lane)).size, events.length);
      for (const sparkle of events) {
        assert.ok(sparkle.age >= 0 && sparkle.age < decay);
        assert.ok(sparkle.level > 0 && sparkle.level <= 100);
        assert.ok(sparkle.index < l.cells.length);
      }
      const low = structuredClone(l);
      low.params.rate = 10;
      const high = structuredClone(l);
      high.params.rate = 90;
      const highLanes = new Set(timeSparkleEvents(high, t, 11).map((sparkle) => sparkle.lane));
      assert.ok(timeSparkleEvents(low, t, 11).every((sparkle) => highLanes.has(sparkle.lane)));
    }
  }
  const empty = normalize(one()).layers[0];
  empty.cells = [];
  assert.equal(timeSparkleEvents(empty, 100000, 11).length, 0);
});

test('sparkleIdHash is the FNV-1a of the layer id', () => {
  assert.equal(sparkleIdHash('hello'), 0x4f9f2cab);
});

test('clock time, clock legacy and omitted clock render identically and normalize away clock', () => {
  const clocks = ['time', 'legacy', undefined];
  const frames = clocks.map((clock) => {
    const params = { rate: 80, decay_ms: 1200 };
    if (clock !== undefined) params.clock = clock;
    const program = build(one({ params }));
    assert.equal('clock' in program.layers[0].params, false);
    const renderer = new Renderer(program);
    return [0, 137, 12345].map((tick) => renderer.step(tick, {}));
  });
  assert.deepEqual(frames[0], frames[1]);
  assert.deepEqual(frames[0], frames[2]);
});

test('invalid sparkle inputs are rejected', () => {
  const invalid = [
    { params: { clock: 'bad' } },
    { params: { rate: 0 } },
    { params: { rate: 101 } },
    { params: { rate: 1.5 } },
    { params: { decay_ms: 65536 } },
    { params: { palette: 'custom' } },
    { params: { unknown: 1 } },
    {
      color: {
        type: 'ramp',
        colors: [
          [0, 0, 0],
          [255, 255, 255],
        ],
      },
    },
    { trigger: { type: 'key_press' } },
  ];
  for (const overrides of invalid) {
    const report = validate(one(overrides));
    assert.equal(report.ok, false, JSON.stringify(overrides));
    assert.ok(report.errors.length > 0, JSON.stringify(overrides));
  }
});

test('DSL -> lep -> DSL -> frames identical for a sparkle effect', () => {
  const dsl = one({
    params: { rate: 80, decay_ms: 1200, palette: 'seven', clock: 'time' },
    color: { type: 'solid', rgb: [255, 180, 40] },
  });
  const program = build(dsl);
  const decoded = decode(encode(program));
  const back = programToDsl(decoded.program, decoded.meta);
  const report = validate(back);
  assert.equal(report.ok, true, report.errors.join('; '));
  const program2 = normalize(back);
  const sim = { ticks: 200, stepMs: 20 };
  assert.deepEqual(simulate(program2, sim), simulate(program, sim));
});
