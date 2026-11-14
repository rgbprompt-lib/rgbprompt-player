import { describe, expect, it } from 'vitest';
import { detectFlashes } from '../src/index.ts';
import { makeFrame, pulseFrames, setKey } from './helpers.ts';

const FPS = 25;
const SECONDS = 10;

function kindsAt(report: ReturnType<typeof detectFlashes>): string[] {
  return report.violations.map((violation) => violation.kind);
}

describe('detectFlashes', () => {
  it('passes 2 Hz and 3 Hz square waves and rejects 3.5 Hz and 5 Hz', () => {
    for (const hz of [2, 3]) {
      const report = detectFlashes(pulseFrames(hz, SECONDS, FPS, [255, 255, 255], [0, 0, 0]), FPS);
      expect(report.ok, `${hz} Hz should pass: ${JSON.stringify(report.violations)}`).toBe(true);
      expect(report.maxPerWindow.general).toBeLessThanOrEqual(3);
    }

    for (const hz of [3.5, 5]) {
      const report = detectFlashes(pulseFrames(hz, SECONDS, FPS, [255, 255, 255], [0, 0, 0]), FPS);
      expect(report.ok, `${hz} Hz should violate`).toBe(false);
      expect(report.maxPerWindow.general).toBeGreaterThan(3);
      expect(kindsAt(report)).toContain('general');
    }
  });

  it('counts red flashes separately', () => {
    const violating = detectFlashes(pulseFrames(5, SECONDS, FPS, [255, 0, 0], [0, 0, 0]), FPS);
    expect(violating.maxPerWindow.red).toBeGreaterThan(3);
    expect(violating.violations).toContainEqual(expect.objectContaining({ object: 'board', kind: 'red' }));

    const passing = detectFlashes(pulseFrames(2, SECONDS, FPS, [255, 0, 0], [0, 0, 0]), FPS);
    expect(passing.ok).toBe(true);
  });

  it('reports a full-board small-flash violation when 25% of keys flash fast', () => {
    const frames: Uint8Array[] = [];
    const periodMs = 250; // 4 Hz
    for (let index = 0; index < SECONDS * FPS; index++) {
      const t = (index * 1000) / FPS;
      const frame = makeFrame([0, 0, 0]);
      const on = t % periodMs < periodMs / 2;
      for (let key = 0; key < 30; key++) setKey(frame, key, on ? [255, 255, 255] : [0, 0, 0]);
      frames.push(frame);
    }
    const report = detectFlashes(frames, FPS);
    expect(report.violations).toContainEqual(
      expect.objectContaining({ object: 'board', kind: 'many_small' }),
    );
  });

  it('traces counted transitions only when requested', () => {
    const frames = pulseFrames(5, 2, FPS, [255, 255, 255], [0, 0, 0]);
    const plain = detectFlashes(frames, FPS);
    const traced = detectFlashes(frames, FPS, { trace: true });

    expect('trace' in plain).toBe(false);
    expect(traced.trace.report).toEqual(plain);

    const board = traced.trace.objects.find((object) => object.object === 'board');
    expect(board?.general.flashes.length).toBeGreaterThan(0);
    const flash = board?.general.flashes[0];
    expect(flash).toBeDefined();
    expect(flash?.first.frameIndex).toBeTypeOf('number');
    expect(flash?.second.frameIndex).toBeGreaterThan(flash?.first.frameIndex as number);
    expect(flash?.second.from).toBe(flash?.first.to);
    expect(flash?.second.relativeChange).toBeGreaterThanOrEqual(0.1);
    expect(flash?.first.counted).toBe(true);
    expect(flash?.second.counted).toBe(true);
  });

  it('traces the keys behind a many-small violation', () => {
    const frames: Uint8Array[] = [];
    for (let index = 0; index < 5 * FPS; index++) {
      const t = (index * 1000) / FPS;
      const frame = makeFrame([0, 0, 0]);
      const on = t % 250 < 125;
      for (let key = 0; key < 30; key++) setKey(frame, key, on ? [255, 255, 255] : [0, 0, 0]);
      frames.push(frame);
    }

    const traced = detectFlashes(frames, FPS, { trace: true });
    expect(traced.trace.manySmall.violated).toBe(true);
    expect(traced.trace.manySmall.keys.length).toBeGreaterThanOrEqual(30);
    const first = traced.trace.manySmall.keys[0];
    expect(first?.keyIndex).toBeTypeOf('number');
    expect(first?.block).toMatch(/^block-/);
    expect(first?.events.length).toBeGreaterThan(3);
  });

  it('returns an empty report for a static board and rejects bad input', () => {
    const staticFrames = Array.from({ length: 10 }, () => makeFrame([20, 40, 80]));
    const report = detectFlashes(staticFrames, FPS);
    expect(report).toEqual({ ok: true, violations: [], maxPerWindow: { general: 0, red: 0 } });
    expect(() => detectFlashes(staticFrames, 0)).toThrow(/invalid fps/);
    expect(() => detectFlashes([new Uint8Array(3)], FPS)).toThrow(/expected 312/);
  });
});
