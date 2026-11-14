// Golden-vector helpers for cross-checking the reference renderer against an
// independent implementation. docs/16 §2.
import { simulate } from './render.ts';
import { crc32 } from './lep.ts';
import { LOGIC_ROWS, LOGIC_COLS } from './constants.ts';
import type { Frame, FrameCell, Program, SimInput } from './types.ts';

// Serialize a logical frame to a fixed 6*22*4 byte layout: r,g,b,l per cell,
// row-major. Consumers MUST produce byte-identical output for a match.
export function frameToBytes(frame: Frame): Uint8Array {
  const buf = new Uint8Array(LOGIC_ROWS * LOGIC_COLS * 4);
  let o = 0;
  for (let r = 0; r < LOGIC_ROWS; r++) {
    // Reason: frames always have LOGIC_ROWS rows.
    const row = frame[r] as FrameCell[];
    for (let c = 0; c < LOGIC_COLS; c++) {
      // Reason: every row has LOGIC_COLS cells.
      const cell = row[c] as FrameCell;
      buf[o++] = cell.r;
      buf[o++] = cell.g;
      buf[o++] = cell.b;
      buf[o++] = cell.l;
    }
  }
  return buf;
}

export function frameHash(frame: Frame): number {
  return crc32(frameToBytes(frame));
}

export function goldenVectors(
  program: Program,
  sim: SimInput,
): { seed: number; ticks: number; hashes: number[] } {
  const hashes: number[] = [];
  simulate(program, sim, (t, frame) => {
    hashes.push(frameHash(frame));
  });
  return {
    seed: program.seed,
    ticks: sim.ticks ?? 1,
    hashes,
  };
}
