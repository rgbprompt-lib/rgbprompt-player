// Performance bench for @rgbprompt/safety (FLASH-SAFETY.md §4.2):
//   limiter <= 0.05 ms per frame, detector <= 10 ms for 250 frames.
//
// Run from packages/safety:
//   node scripts/bench.mjs
import { createLimiter, detectFlashes, KEY_COUNT } from '../src/index.ts';

const FRAMES = 250;
const STEP_MS = 40;
const LIMITER_BUDGET_MS = 0.05;
const DETECTOR_BUDGET_MS = 10;
const FRAME_BYTES = KEY_COUNT * 3;

function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeFrames() {
  const random = seeded(0x62656e63);
  const frames = [];
  for (let index = 0; index < FRAMES; index++) {
    const frame = new Uint8Array(FRAME_BYTES);
    for (let channel = 0; channel < FRAME_BYTES; channel++) {
      frame[channel] = Math.floor(random() * 256);
    }
    frames.push(frame);
  }
  return frames;
}

function elapsedMs(start) {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

const frames = makeFrames();

// Warm up so the measurement is not dominated by first-call JIT work.
{
  const limiter = createLimiter();
  for (let index = 0; index < 50; index++) limiter.step(frames[index], STEP_MS);
  detectFlashes(frames.slice(0, 50), 25);
}

const limiter = createLimiter();
const limiterStart = process.hrtime.bigint();
for (const frame of frames) limiter.step(frame, STEP_MS);
const limiterMs = elapsedMs(limiterStart);
const perFrameMs = limiterMs / FRAMES;

const detectorStart = process.hrtime.bigint();
const report = detectFlashes(frames, 25);
const detectorMs = elapsedMs(detectorStart);

const limiterOk = perFrameMs <= LIMITER_BUDGET_MS;
const detectorOk = detectorMs <= DETECTOR_BUDGET_MS;

console.log(
  `limiter: ${limiterMs.toFixed(3)} ms / ${FRAMES} frames, ` +
    `${perFrameMs.toFixed(4)} ms/frame (budget ${LIMITER_BUDGET_MS}, ` +
    `${limiterOk ? 'pass' : 'fail'})`,
);
console.log(
  `detector: ${detectorMs.toFixed(3)} ms / ${FRAMES} frames ` +
    `(budget ${DETECTOR_BUDGET_MS}, ${detectorOk ? 'pass' : 'fail'}; ` +
    `max general ${report.maxPerWindow.general}, red ${report.maxPerWindow.red})`,
);

if (!limiterOk || !detectorOk) process.exitCode = 1;
