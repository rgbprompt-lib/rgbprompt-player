import { frameToKeyRgb } from '@rgbprompt/layouts';
import { normalize, simulate } from '@rgbprompt/engine';
import { describe, expect, it } from 'vitest';
import { buildCorpus } from '../../../tools/golden/corpus.mjs';
import { detectFlashes } from '../src/index.ts';

const FPS = 25;
const STEP_MS = 1000 / FPS;
const FRAMES = 250; // 10 s

describe('engine example integration', () => {
  it('runs the golden example-* corpus through the detector', () => {
    const examples = buildCorpus().filter((entry: { id: string }) => entry.id.startsWith('example-'));
    expect(examples.length).toBeGreaterThan(0);

    const results = examples.map(
      (entry: { id: string; effect: unknown; inputs: { keyEvents: unknown[]; audio: unknown[] } }) => {
        const program = normalize(entry.effect as Parameters<typeof normalize>[0]);
        const rendered = simulate(program, {
          ticks: FRAMES,
          stepMs: STEP_MS,
          keyEvents: entry.inputs.keyEvents as Parameters<typeof simulate>[1]['keyEvents'],
          audio: entry.inputs.audio as Parameters<typeof simulate>[1]['audio'],
        });
        const keyFrames = rendered.map((frame) => frameToKeyRgb(frame));
        const report = detectFlashes(keyFrames, FPS);
        return { id: entry.id, report };
      },
    );

    for (const result of results) {
      const violations = result.report.violations
        .map(
          (violation) =>
            `${violation.object}/${violation.kind}@${violation.windowStartMs}ms:${violation.count}`,
        )
        .join(', ');
      console.log(
        `${result.id}: ${result.report.ok ? 'ok' : 'violates'} ` +
          `(general ${result.report.maxPerWindow.general}, ` +
          `red ${result.report.maxPerWindow.red})` +
          (violations ? ` [${violations}]` : ''),
      );
    }

    expect(results).toHaveLength(examples.length);
  });
});
