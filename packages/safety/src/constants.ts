// Shared numeric contract. Swift and Rust builds read the same JSON file.
//
// Fixed-point thresholds are derived once here so every runtime uses the same
// integers. The luminance scale is 0..65535; a change of 0.10 is therefore
// 6553.5 units and is rounded up, so exactly 0.10 crosses the threshold.
import raw from '../constants.json' with { type: 'json' };

export const CONSTANTS = raw as unknown as {
  readonly window_ms: number;
  readonly max_transitions: number;
  readonly flash_amplitude: number;
  readonly dark_threshold: number;
  readonly red_ratio: number;
  readonly red_amplitude: number;
  readonly block_rows: number;
  readonly block_cols: number;
  readonly small_flash_key_fraction: number;
  readonly luminance_max: number;
  readonly luminance_weights: readonly [number, number, number];
  readonly luminance_weight_denominator: number;
  readonly srgb_table_scale: number;
  readonly geometry_unit_scale: number;
};

export const LUMINANCE_MAX = CONSTANTS.luminance_max;
export const LUMINANCE_WEIGHTS = CONSTANTS.luminance_weights;
export const LUMINANCE_WEIGHT_DENOMINATOR = CONSTANTS.luminance_weight_denominator;

export const WINDOW_MS = CONSTANTS.window_ms;
export const MAX_TRANSITIONS = CONSTANTS.max_transitions;
export const MAX_FLASHES_PER_WINDOW = Math.floor(MAX_TRANSITIONS / 2);
export const BLOCK_ROWS = CONSTANTS.block_rows;
export const BLOCK_COLS = CONSTANTS.block_cols;
export const BLOCK_COUNT = BLOCK_ROWS * BLOCK_COLS;
export const OBJECT_COUNT = 1 + BLOCK_COUNT;

// A transition amplitude is >= threshold when delta * 10 >= 65535.
export const FLASH_AMPLITUDE_FIXED = Math.ceil(CONSTANTS.flash_amplitude * LUMINANCE_MAX);
// The darker state must be strictly below 0.80 * 65535 = 52428.8.
export const DARK_THRESHOLD_FIXED = Math.ceil(CONSTANTS.dark_threshold * LUMINANCE_MAX);
// Red share uses the same 0..65535 fixed scale; 0.20 * 65535 = 13107.
export const RED_AMPLITUDE_FIXED = Math.ceil(CONSTANTS.red_amplitude * LUMINANCE_MAX);
export const GEOMETRY_UNIT_SCALE = CONSTANTS.geometry_unit_scale;
export const SMALL_FLASH_KEY_FRACTION = CONSTANTS.small_flash_key_fraction;
export const RED_RATIO = CONSTANTS.red_ratio;
