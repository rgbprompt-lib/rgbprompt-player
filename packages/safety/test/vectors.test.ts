import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createLimiter, detectFlashes } from '../src/index.ts';

interface VectorEntry {
  id: string;
  description: string;
  file: string;
  frames: number;
  input_sha256: string;
  output_sha256: string;
  max_flashes_per_window: {
    before: { general: number; red: number };
    after: { general: number; red: number };
  };
}

interface Manifest {
  fps: number;
  step_ms: number;
  frame_bytes: number;
  vectors: VectorEntry[];
}

const manifest = JSON.parse(
  readFileSync(new URL('../vectors/manifest.json', import.meta.url), 'utf8'),
) as Manifest;

function readFrames(entry: VectorEntry): Uint8Array[] {
  const bytes = readFileSync(new URL(`../vectors/${entry.file}`, import.meta.url));
  const frames: Uint8Array[] = [];
  for (let index = 0; index < entry.frames; index++) {
    const start = index * manifest.frame_bytes;
    frames.push(Uint8Array.from(bytes.subarray(start, start + manifest.frame_bytes)));
  }
  return frames;
}

function concat(frames: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(frames.length * manifest.frame_bytes);
  for (let index = 0; index < frames.length; index++) {
    bytes.set(frames[index] as Uint8Array, index * manifest.frame_bytes);
  }
  return bytes;
}

function sha256(frames: readonly Uint8Array[]): string {
  return createHash('sha256').update(concat(frames)).digest('hex');
}

function limited(frames: readonly Uint8Array[]): Uint8Array[] {
  const limiter = createLimiter();
  return frames.map((frame) => Uint8Array.from(limiter.step(frame, manifest.step_ms)));
}

describe('safety vectors', () => {
  for (const vector of manifest.vectors) {
    it(`${vector.id}: matches stored hashes and passes through the output stage unchanged`, () => {
      const input = readFrames(vector);
      expect(sha256(input)).toBe(vector.input_sha256);
      expect(detectFlashes(input, manifest.fps)).toMatchObject({
        maxPerWindow: vector.max_flashes_per_window.before,
      });

      const output = limited(input);
      expect(sha256(output)).toBe(vector.output_sha256);
      expect(vector.output_sha256).toBe(vector.input_sha256);
      const report = detectFlashes(output, manifest.fps);
      expect(report.maxPerWindow).toEqual(vector.max_flashes_per_window.after);
      expect(vector.max_flashes_per_window.after).toEqual(vector.max_flashes_per_window.before);
    });
  }

  it('strobe-10hz is unchanged byte-for-byte (no flash-rate limit)', () => {
    const entry = manifest.vectors.find((vector) => vector.id === 'strobe-10hz');
    expect(entry).toBeDefined();
    const input = readFrames(entry as VectorEntry);
    const output = limited(input);
    expect(output).toHaveLength(input.length);
    for (let index = 0; index < input.length; index++) {
      expect(Array.from(output[index] as Uint8Array)).toEqual(Array.from(input[index] as Uint8Array));
    }
  });
});
