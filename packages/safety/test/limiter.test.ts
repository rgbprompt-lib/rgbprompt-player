import { describe, expect, it } from 'vitest';
import { createLimiter, detectFlashes } from '../src/index.ts';
import { makeFrame, pulseFrames, smoothThreeHzFrames } from './helpers.ts';

const FPS = 25;
const STEP_MS = 1000 / FPS;

function runLimiter(frames: readonly Uint8Array[], stepMs = STEP_MS): Uint8Array[] {
  const limiter = createLimiter();
  const out: Uint8Array[] = [];
  for (const frame of frames) out.push(Uint8Array.from(limiter.step(frame, stepMs)));
  return out;
}

function expectUnchanged(input: readonly Uint8Array[], output: readonly Uint8Array[]): void {
  expect(output).toHaveLength(input.length);
  for (let index = 0; index < input.length; index++) {
    expect(Array.from(output[index] as Uint8Array)).toEqual(Array.from(input[index] as Uint8Array));
  }
}

// The output stage is a pass-through: effects render exactly as the engine
// computes them (WYSIWYG), with no flash-rate, slew or hold limit.
describe('createLimiter (pass-through output stage)', () => {
  it('passes a 10 Hz full-brightness strobe through unchanged', () => {
    const input = pulseFrames(10, 10, FPS, [255, 255, 255], [0, 0, 0]);
    const output = runLimiter(input);
    expectUnchanged(input, output);
    expect(detectFlashes(output, FPS).maxPerWindow.general).toBeGreaterThan(3);
  });

  it('lets a 4 Hz full-board flash reach full dark between hits', () => {
    // 60 fps, 125 ms white / 125 ms black, the shape of a fast beat flash.
    const fps = 60;
    const input = pulseFrames(4, 5, fps, [255, 255, 255], [0, 0, 0]);
    const output = runLimiter(input, 1000 / fps);
    expectUnchanged(input, output);

    // After the first second (where a limiter would have built up history),
    // every gap between hits is fully black and every hit is fully white.
    let darkFrames = 0;
    let brightFrames = 0;
    for (let index = fps; index < output.length; index++) {
      const frame = output[index] as Uint8Array;
      if (frame.every((value) => value === 0)) darkFrames++;
      else if (frame.every((value) => value === 255)) brightFrames++;
      else throw new Error(`frame ${index} is neither full white nor full black`);
    }
    expect(darkFrames).toBeGreaterThan(0);
    expect(brightFrames).toBeGreaterThan(0);
    expect(detectFlashes(output, fps).maxPerWindow.general).toBe(4);
  });

  it('leaves the smooth 3 Hz sample byte-for-byte unchanged', () => {
    const input = smoothThreeHzFrames(10, FPS);
    expectUnchanged(input, runLimiter(input));
  });

  it('follows a step change immediately, with no slew', () => {
    const limiter = createLimiter();
    limiter.step(makeFrame([0, 0, 0]), STEP_MS);
    const white = makeFrame([255, 255, 255]);
    expect(Array.from(limiter.step(white, STEP_MS))).toEqual(Array.from(white));
  });

  it('rejects buffers that are not one ansi104 key frame', () => {
    const limiter = createLimiter();
    expect(() => limiter.step(new Uint8Array(3), STEP_MS)).toThrow(/expected 312/);
  });
});
