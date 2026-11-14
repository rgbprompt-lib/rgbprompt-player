import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rainEvents, rainLevel, rainSample, rainLaneCells, rainSplashCells } from '../src/rain_model.ts';

test('intro produces independent, deterministic top-to-bottom rain', () => {
  const events = rainEvents(500, 7);
  assert.deepEqual(events, rainEvents(500, 7));
  assert.ok(new Set(events.map((e) => e.lane)).size >= 15);
  assert.ok(new Set(events.map((e) => e.born)).size >= 10);
  assert.ok(events.every((e) => e.fall >= 380 && e.fall <= 520));
  const single = [{ lane: 0, born: 0, fall: 400, intro: true }];
  assert.ok(rainLevel(4, 4, 120, single) > 0);
  assert.equal(rainLevel(4, 44, 120, single), 0);
  assert.ok(rainLevel(4, 44, 450, single) > 0);
  assert.ok(rainLevel(12, 44, 450, single) > 0);
});

test('drizzle adds five extra drops every seven seconds', () => {
  for (const second of [3, 5, 6, 7, 13]) {
    const end = 1500 + second * 1000 + 999;
    const born = rainEvents(end, 7).filter((e) => !e.intro && e.born >= end - 999 && e.born <= end);
    assert.equal(born.length, second % 7 === 6 ? 8 : 3);
    assert.ok(born.every((e) => e.fall >= 750 && e.fall <= 900));
  }
});

test('intro rain fades away while drizzle continues', () => {
  const intro = { lane: 0, born: 1000, fall: 500, intro: true };
  assert.ok(rainLevel(4, 44, 1600, [intro]) > 0);
  assert.equal(rainLevel(4, 44, 1800, [intro]), 0);
  assert.ok(rainEvents(1800, 7).some((e) => !e.intro));
});

test('renderer restarts the entrance relative to the first frame', async () => {
  const { Renderer } = await import('../src/render.ts');
  const { normalize } = await import('../src/normalize.ts');
  const { readFileSync } = await import('node:fs');
  const effect = JSON.parse(readFileSync(new URL('./c/cases/rain.effect.json', import.meta.url)));
  const a = new Renderer(normalize(effect)),
    b = new Renderer(normalize(effect));
  for (const t of [0, 100, 500, 1500, 3000]) assert.deepEqual(a.step(t, {}), b.step(t + 123456, {}));
});

test('rain rejects unsupported colours, triggers and invalid background values', async () => {
  const { validate } = await import('../src/validate.ts');
  const { readFileSync } = await import('node:fs');
  const effect = JSON.parse(readFileSync(new URL('./c/cases/rain.effect.json', import.meta.url)));
  for (const change of [
    (x) => {
      x.layer[0].params.base_left_r = 256;
    },
    (x) => {
      x.layer[0].params.base_left_r = 1.5;
    },
    (x) => {
      x.layer[0].params.unknown = 1;
    },
    (x) => {
      x.layer[0].trigger = { type: 'key_press' };
    },
    (x) => {
      x.layer[0].color = { type: 'hue_cycle' };
    },
  ]) {
    const invalid = structuredClone(effect);
    change(invalid);
    assert.equal(validate(invalid).ok, false);
  }
});

test('drizzle is pink and successive drops do not use neighboring lanes', () => {
  const drops = [];
  for (let second = 0; second < 20; second++) {
    const end = 1500 + second * 1000 + 999;
    drops.push(...rainEvents(end, 7).filter((e) => !e.intro && e.born >= end - 999));
  }
  assert.ok(drops.every((e) => e.accent));
  for (let i = 1; i < drops.length; i++)
    for (let j = Math.max(0, i - 4); j < i; j++) assert.ok(Math.abs(drops[i].lane - drops[j].lane) > 1);
});

test('a single drizzle uses one key in each row and splashes only on bottom row', () => {
  const lane = 8,
    e = { lane, born: 0, fall: 800, intro: false, accent: true };
  for (let row = 0; row < 5; row++) {
    const col = rainLaneCells[lane][row];
    if (col < 0) continue;
    const y = 4 + row * 8,
      tick = row * 160 + 120;
    const active = [];
    for (let c = 0; c < 22; c++)
      if (rainSample(4 + c * 8, y, tick, [e], row, c).level === 1000) active.push(c);
    assert.deepEqual(active, [col]);
  }
  const row = 5,
    tick = 850,
    active = [];
  for (let c = 0; c < 22; c++) if (rainSample(4 + c * 8, 44, tick, [e], row, c).level > 0) active.push(c);
  assert.deepEqual(
    active,
    [...rainSplashCells[lane]].sort((a, b) => a - b),
  );
});

test('rain parameters change actual event timing, tails and splashes', () => {
  const p = {
    fall_min_ms: 500,
    fall_max_ms: 500,
    drops_per_second: 5,
    shower_period_s: 0,
    shower_extra: 5,
    tail_first: 60,
    tail_second: 20,
    splash_ms: 0,
  };
  const events = rainEvents(10499, 7, p).filter((e) => !e.intro && e.born >= 9500);
  assert.equal(events.length, 5);
  assert.ok(events.every((e) => e.fall === 500 && e.splash === 0));
  const e = { lane: 0, born: 0, fall: 500, intro: false, tail1: 60, tail2: 20, splash: 0 };
  assert.equal(rainSample(4, 4, 220, [e], 0, rainLaneCells[0][0]).level, 600);
  assert.equal(rainSample(4, 4, 320, [e], 0, rainLaneCells[0][0]).level, 200);
  const neighbor = rainSplashCells[0].find((c) => c !== rainLaneCells[0][5]);
  assert.equal(rainSample(4, 44, 550, [e], 5, neighbor).level, 0);
});

test('rain color and brightness survive binary round trip', async () => {
  const { Renderer } = await import('../src/render.ts');
  const { normalize } = await import('../src/normalize.ts');
  const { encode, decode } = await import('../src/lep.ts');
  const { readFileSync } = await import('node:fs');
  const effect = JSON.parse(readFileSync(new URL('./c/cases/rain_custom.effect.json', import.meta.url)));
  const original = normalize(effect),
    restored = decode(encode(original)).program;
  assert.equal(restored.layers[0].time.min_level, 48);
  const a = new Renderer(original),
    b = new Renderer(restored);
  for (const t of [0, 500, 1500, 2000, 4000, 9000]) assert.deepEqual(a.step(t, {}), b.step(t, {}));
});

test('rain rejects reversed speeds and invalid color or brightness', async () => {
  const { validate } = await import('../src/validate.ts');
  const { readFileSync } = await import('node:fs');
  const effect = JSON.parse(readFileSync(new URL('./c/cases/rain.effect.json', import.meta.url)));
  for (const change of [
    (x) => {
      x.layer[0].params = { fall_min_ms: 1000, fall_max_ms: 500 };
    },
    (x) => {
      x.layer[0].color.colors[0][0] = 256;
    },
    (x) => {
      x.layer[0].color.colors.pop();
    },
    (x) => {
      x.layer[0].time = { type: 'breath', min_level: 101 };
    },
    (x) => {
      x.layer[0].time = { type: 'breath', period_ms: 999 };
    },
    (x) => {
      x.layer[0].time = { type: 'breath', phase_ms: 5 };
    },
  ]) {
    const invalid = structuredClone(effect);
    change(invalid);
    assert.equal(validate(invalid).ok, false);
  }
});

test('accepted default rain retains its 15000-frame reference', async () => {
  const { createHash } = await import('node:crypto');
  const { readFileSync } = await import('node:fs');
  const { normalize } = await import('../src/normalize.ts');
  const { goldenVectors } = await import('../src/vectors.ts');
  const effect = JSON.parse(readFileSync(new URL('../data/examples/cyber-rain-night.json', import.meta.url)));
  const hashes = goldenVectors(normalize(effect), { ticks: 15000 }).hashes;
  const digest = createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
  // Re-pinned when the background gradient began spanning the board's own LED
  // width (172 on the generic 104) instead of a fixed 174.
  assert.equal(digest, '87f7199e6c6c56a27ead1e29dbe521b8f44af11c4a3ade2e1475e249aca23a0e');
});
