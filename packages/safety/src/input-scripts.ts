// Deterministic synthetic input scripts for offline sampling (FLASH-SAFETY §4.2).
//
// The scripts are plain `{ tick, ... }` records so both @rgbprompt/engine and
// the safety vectors can consume them. They never depend on wall-clock time.
import { ANSI104_CELL, ANSI104_KEYS } from '@rgbprompt/layouts';

export const TYPING_KEYS_PER_SECOND = 8;
export const TYPING_HOLD_MS = 80;
export const AUDIO_BPM = 128;
export const AUDIO_BAND_COUNT = 22;
export const INPUT_SCRIPT_SEED = 0x74797065;

export interface KeyScriptEvent {
  tick: number;
  type: 'down' | 'up';
  cell: string;
}

export interface AudioScriptEvent {
  tick: number;
  bands: number[];
}

export interface InputScript {
  keyEvents: KeyScriptEvent[];
  audioEvents: AudioScriptEvent[];
}

export interface InputScriptOptions {
  durationMs: number;
  typing: boolean;
  audio: boolean;
  seed?: number;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), 1 | value);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const KEY_CELLS: readonly string[] = Object.freeze(
  ANSI104_KEYS.map((name) => {
    const cell = ANSI104_CELL[name];
    return cell ? `${cell[0]},${cell[1]}` : '';
  }).filter((cell) => cell.length > 0),
);

export function buildTypingScript(durationMs: number, seed: number = INPUT_SCRIPT_SEED): KeyScriptEvent[] {
  if (!(durationMs > 0)) return [];
  const random = mulberry32(seed);
  const events: KeyScriptEvent[] = [];
  const releaseAt = new Map<string, number>();

  for (let index = 0; ; index++) {
    const tick = Math.floor((index * 1000) / TYPING_KEYS_PER_SECOND);
    if (tick >= durationMs) break;

    let cell = '';
    for (let attempt = 0; attempt < KEY_CELLS.length; attempt++) {
      const candidate = KEY_CELLS[Math.floor(random() * KEY_CELLS.length)] as string;
      const release = releaseAt.get(candidate);
      if (release === undefined || release <= tick) {
        cell = candidate;
        break;
      }
    }
    if (!cell) continue;

    releaseAt.set(cell, tick + TYPING_HOLD_MS);
    events.push({ tick, type: 'down', cell });
    events.push({ tick: tick + TYPING_HOLD_MS, type: 'up', cell });
  }

  // Keep the natural time order; the engine sorts defensively anyway.
  events.sort((a, b) => a.tick - b.tick || (a.type === b.type ? 0 : a.type === 'down' ? -1 : 1));
  return events;
}

export function buildAudioScript(durationMs: number, bpm: number = AUDIO_BPM): AudioScriptEvent[] {
  if (!(durationMs > 0)) return [];
  const beatMs = 60_000 / bpm;
  const events: AudioScriptEvent[] = [];
  const bands = Array.from({ length: AUDIO_BAND_COUNT }, (_unused, band) => {
    if (band < 4) return 255;
    if (band < 8) return 180;
    return 30;
  });

  for (let index = 0; ; index++) {
    const tick = Math.round(index * beatMs);
    if (tick >= durationMs) break;
    events.push({ tick, bands: [...bands] });
  }
  return events;
}

export function buildInputScript(options: InputScriptOptions): InputScript {
  const seed = options.seed ?? INPUT_SCRIPT_SEED;
  return {
    keyEvents: options.typing ? buildTypingScript(options.durationMs, seed) : [],
    audioEvents: options.audio ? buildAudioScript(options.durationMs) : [],
  };
}
