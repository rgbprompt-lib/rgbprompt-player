// Regenerate the deterministic output-stage/detector vectors in vectors/.
//
// Run from packages/safety:
//   node scripts/gen-vectors.mjs
//
// Each vector is a 10 s, 25 fps sequence of ansi104 key-RGB frames. The script
// writes the raw input frames and records SHA-256 hashes plus detector maxima
// before and after the output stage. The output stage is a pass-through (no
// flash-rate limit, WYSIWYG), so every vector's output equals its input.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { format } from 'prettier';

import { detectFlashes, createLimiter } from '../src/index.ts';
import { ANSI104_KEYS } from '@rgbprompt/layouts';

const FPS = 25;
const STEP_MS = 1000 / FPS;
const SECONDS = 10;
const FRAME_COUNT = SECONDS * FPS;
const KEY_COUNT = ANSI104_KEYS.length;
const FRAME_BYTES = KEY_COUNT * 3;

function makeFrame() {
  return new Uint8Array(FRAME_BYTES);
}

function fill(frame, rgb) {
  for (let key = 0; key < KEY_COUNT; key++) {
    frame[key * 3] = rgb[0];
    frame[key * 3 + 1] = rgb[1];
    frame[key * 3 + 2] = rgb[2];
  }
}

function setKey(frame, key, rgb) {
  frame[key * 3] = rgb[0];
  frame[key * 3 + 1] = rgb[1];
  frame[key * 3 + 2] = rgb[2];
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function frameTime(index) {
  return (index * 1000) / FPS;
}

function beatFrames(bpm) {
  const frames = [];
  const beatMs = 60000 / bpm;
  const pulseMs = Math.min(100, beatMs / 3);
  for (let index = 0; index < FRAME_COUNT; index++) {
    const frame = makeFrame();
    const phase = frameTime(index) % beatMs;
    fill(frame, phase < pulseMs ? [255, 255, 255] : [0, 0, 0]);
    frames.push(frame);
  }
  return frames;
}

function typingFrames() {
  const frames = [];
  const random = mulberry32(0x74797065);
  const active = new Map();
  for (let index = 0; index < FRAME_COUNT; index++) {
    if (index % 2 === 0) {
      const key = Math.floor(random() * KEY_COUNT);
      active.set(key, 2);
    }
    const frame = makeFrame();
    for (const [key, remaining] of active) {
      if (remaining <= 0) {
        active.delete(key);
        continue;
      }
      const intensity = remaining === 2 ? 255 : 120;
      setKey(frame, key, [0, intensity, 255]);
      active.set(key, remaining - 1);
    }
    frames.push(frame);
  }
  return frames;
}

function noiseFrames() {
  const frames = [];
  const random = mulberry32(0x6e6f6973);
  for (let index = 0; index < FRAME_COUNT; index++) {
    const frame = makeFrame();
    for (let key = 0; key < KEY_COUNT; key++) {
      const g = Math.floor(random() * 256);
      const b = Math.floor(random() * 256);
      setKey(frame, key, [0, g, b]);
    }
    frames.push(frame);
  }
  return frames;
}

function reverseFrames() {
  const frames = [];
  for (let index = 0; index < FRAME_COUNT; index++) {
    const t = frameTime(index);
    const gray = Math.round(128 + 64 * Math.cos((2 * Math.PI * 3 * t) / 1000));
    const frame = makeFrame();
    fill(frame, [gray, gray, gray]);
    frames.push(frame);
  }
  return frames;
}

function strobeFrames() {
  const frames = [];
  const periodMs = 100; // 10 Hz
  for (let index = 0; index < FRAME_COUNT; index++) {
    const frame = makeFrame();
    fill(frame, frameTime(index) % periodMs < periodMs / 2 ? [255, 255, 255] : [0, 0, 0]);
    frames.push(frame);
  }
  return frames;
}

function concatFrames(frames) {
  const bytes = new Uint8Array(frames.length * FRAME_BYTES);
  for (let index = 0; index < frames.length; index++) {
    bytes.set(frames[index], index * FRAME_BYTES);
  }
  return bytes;
}

function hashFrames(frames) {
  return createHash('sha256').update(concatFrames(frames)).digest('hex');
}

function runLimiter(frames) {
  const limiter = createLimiter();
  return frames.map((frame) => Uint8Array.from(limiter.step(frame, STEP_MS)));
}

function maxima(frames) {
  const report = detectFlashes(frames, FPS);
  return {
    general: report.maxPerWindow.general,
    red: report.maxPerWindow.red,
  };
}

const definitions = [
  { id: 'beats-128', description: '128 BPM heavy beat', frames: beatFrames(128) },
  { id: 'beats-160', description: '160 BPM heavy beat', frames: beatFrames(160) },
  { id: 'fast-typing', description: 'continuous fast typing', frames: typingFrames() },
  { id: 'noise-seeded', description: 'seeded random noise', frames: noiseFrames() },
  { id: 'reverse-3hz', description: 'smooth 3 Hz pulse', frames: reverseFrames() },
  { id: 'strobe-10hz', description: '10 Hz full-brightness strobe', frames: strobeFrames() },
];

const manifest = {
  fps: FPS,
  step_ms: STEP_MS,
  frame_bytes: FRAME_BYTES,
  vectors: definitions.map((definition) => {
    const input = definition.frames;
    const output = runLimiter(input);
    const file = `${definition.id}.frames.bin`;
    writeFileSync(new URL(`../vectors/${file}`, import.meta.url), concatFrames(input));
    return {
      id: definition.id,
      description: definition.description,
      file,
      frames: input.length,
      input_sha256: hashFrames(input),
      output_sha256: hashFrames(output),
      max_flashes_per_window: {
        before: maxima(input),
        after: maxima(output),
      },
    };
  }),
};

writeFileSync(
  new URL('../vectors/manifest.json', import.meta.url),
  await format(JSON.stringify(manifest), { parser: 'json', printWidth: 110 }),
);

for (const vector of manifest.vectors) {
  console.log(
    `${vector.id}: before ${JSON.stringify(vector.max_flashes_per_window.before)} ` +
      `after ${JSON.stringify(vector.max_flashes_per_window.after)}`,
  );
}
