// Public types for the flash detector and the real-time limiter.
import type { CONSTANTS } from './constants.ts';

export type FlashKind = 'general' | 'red' | 'many_small';

export type ObjectId =
  'board' | 'block-0' | 'block-1' | 'block-2' | 'block-3' | 'block-4' | 'block-5' | 'block-6' | 'block-7';

export interface FlashViolation {
  object: ObjectId;
  kind: FlashKind;
  windowStartMs: number;
  count: number;
}

export interface FlashReport {
  ok: boolean;
  violations: FlashViolation[];
  maxPerWindow: {
    general: number;
    red: number;
  };
}

export interface FlashTraceTransition {
  frameIndex: number;
  timeMs: number;
  from: number;
  to: number;
  delta: number;
  relativeChange: number;
  direction: 'up' | 'down';
  /** True when this transition belongs to a flash that passed the darker-state rule. */
  counted: boolean;
}

export interface FlashTraceFlash {
  /** Time of the second transition, matching the detector's flash timestamp. */
  timeMs: number;
  first: FlashTraceTransition;
  second: FlashTraceTransition;
  darker: number;
  darkerRelative: number;
}

export interface FlashTraceSeries {
  transitions: FlashTraceTransition[];
  flashes: FlashTraceFlash[];
  maxWindow: { count: number; startMs: number };
}

export interface FlashTraceObject {
  object: ObjectId;
  general: FlashTraceSeries;
  red: FlashTraceSeries;
}

export interface FlashTraceManySmallKey {
  keyIndex: number;
  key: string;
  block: ObjectId;
  flashes: number;
  events: FlashTraceFlash[];
}

export interface FlashTraceManySmall {
  requiredKeys: number;
  maxKeys: number;
  windowStartMs: number;
  violated: boolean;
  /** Keys that exceed the per-key flash limit in the worst many-small window. */
  keys: FlashTraceManySmallKey[];
}

export interface FlashTrace {
  fps: number;
  frameCount: number;
  durationMs: number;
  report: FlashReport;
  objects: FlashTraceObject[];
  manySmall: FlashTraceManySmall;
}

export interface FlashTracedReport extends FlashReport {
  trace: FlashTrace;
}

export interface DetectFlashesOptions {
  trace?: boolean;
}

export interface Limiter {
  step(keysRgb: Uint8Array, dtMs: number): Uint8Array;
}

export type SharedConstants = typeof CONSTANTS;
