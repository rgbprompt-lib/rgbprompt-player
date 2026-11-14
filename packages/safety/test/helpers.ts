import { ANSI104_KEYS } from '@rgbprompt/layouts';

export const KEY_COUNT = ANSI104_KEYS.length;
export const BYTES_PER_FRAME = KEY_COUNT * 3;

export type Rgb = readonly [number, number, number];

export function makeFrame(rgb: Rgb): Uint8Array {
  const frame = new Uint8Array(BYTES_PER_FRAME);
  for (let key = 0; key < KEY_COUNT; key++) {
    frame[key * 3] = rgb[0];
    frame[key * 3 + 1] = rgb[1];
    frame[key * 3 + 2] = rgb[2];
  }
  return frame;
}

export function setKey(frame: Uint8Array, key: number, rgb: Rgb): void {
  frame[key * 3] = rgb[0];
  frame[key * 3 + 1] = rgb[1];
  frame[key * 3 + 2] = rgb[2];
}

// One flash per period: bright for the first half, dark for the second half.
export function pulseFrames(hz: number, seconds: number, fps: number, on: Rgb, off: Rgb): Uint8Array[] {
  const frames: Uint8Array[] = [];
  const frameCount = Math.round(seconds * fps);
  const periodMs = 1000 / hz;
  for (let index = 0; index < frameCount; index++) {
    const t = (index * 1000) / fps;
    frames.push(makeFrame(t % periodMs < periodMs / 2 ? on : off));
  }
  return frames;
}

// Smooth 3 Hz grayscale pulse used as the reverse (must-not-change) sample.
export function smoothThreeHzFrames(seconds: number, fps: number): Uint8Array[] {
  const frames: Uint8Array[] = [];
  const frameCount = Math.round(seconds * fps);
  for (let index = 0; index < frameCount; index++) {
    const t = (index * 1000) / fps;
    const gray = Math.round(128 + 64 * Math.cos((2 * Math.PI * 3 * t) / 1000));
    frames.push(makeFrame([gray, gray, gray]));
  }
  return frames;
}

export function copyFrames(frames: readonly Uint8Array[]): Uint8Array[] {
  return frames.map((frame) => Uint8Array.from(frame));
}
