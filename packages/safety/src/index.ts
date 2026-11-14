export { detectFlashes } from './detector.ts';
export { createLimiter } from './limiter.ts';
export { CONSTANTS } from './constants.ts';
export {
  SAFE_RANGE_DURATION_MS,
  SAFE_RANGE_FPS,
  SAFE_RANGE_FRAMES,
  SAFE_RANGE_MAX,
  SAFE_RANGE_MIN,
  SAFE_RANGE_STEP_MS,
  SAFE_RANGE_TOLERANCE,
  safeRange,
} from './range.ts';
export type { DiscreteSafeRange, SafeRangeControl, SafeRangeResult, SpeedSafeRange } from './range.ts';
export {
  AUDIO_BAND_COUNT,
  AUDIO_BPM,
  INPUT_SCRIPT_SEED,
  TYPING_HOLD_MS,
  TYPING_KEYS_PER_SECOND,
  buildAudioScript,
  buildInputScript,
  buildTypingScript,
} from './input-scripts.ts';
export type { AudioScriptEvent, InputScript, InputScriptOptions, KeyScriptEvent } from './input-scripts.ts';
export {
  KEY_AREAS,
  KEY_BLOCKS,
  KEY_CENTRES_QUARTER,
  KEY_COUNT,
  KEY_NAMES,
  OBJECT_AREAS,
  OBJECT_IDS,
  OBJECT_KEY_INDICES,
} from './geometry.ts';
export { LINEAR_TO_SRGB, SRGB_TO_LINEAR, luminanceFromSrgb } from './luminance.ts';
export type {
  DetectFlashesOptions,
  FlashKind,
  FlashReport,
  FlashTrace,
  FlashTraceFlash,
  FlashTraceManySmall,
  FlashTraceManySmallKey,
  FlashTraceObject,
  FlashTraceSeries,
  FlashTraceTransition,
  FlashTracedReport,
  FlashViolation,
  Limiter,
  ObjectId,
  SharedConstants,
} from './types.ts';
