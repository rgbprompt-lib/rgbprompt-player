// LEP constant definitions. MUST match docs/03, docs/04, docs/05.
// These are the frozen v1 invariants (see docs/12 §9).

import type { Rgb } from './types.ts';

export const LOGIC_ROWS = 6;
export const LOGIC_COLS = 22;

export const MAX_LAYERS = 8;
export const MAX_PARAMS_PER_LAYER = 9;
export const MAX_PALETTE_COLORS = 32;

export const MAX_LOGIC_LED_LIGHT_LEVEL = 100; // logical light level
export const MAX_LED_LIGHT_LEVEL = 20; // global brightness level
export const MAX_PHYSICAL_LED_LIGHT_LEVEL = 200; // physical brightness
export const MAX_STATUS_LED_LIGHT_LEVEL = 255; // status overlay

// Drift uses its own breath-fade period, independent of the motion period.
export const DRIFT_BREATH_PERIOD_MS = 3200;

// Built-in palettes (docs/04 §3.1). rainbow24 values are the raw 24-bit codes,
// interpreted as 0xBBGGRR.
export const RAINBOW24_U24 = [
  0x0000fe, 0x001ee0, 0x003ec0, 0x005ea0, 0x007e80, 0x00a05e, 0x00c03e, 0x00e01e, 0x00fe00, 0x1ee000,
  0x3ec000, 0x5ea000, 0x7e8000, 0xa05e00, 0xc03e00, 0xe01e00, 0xfe0000, 0xe0001e, 0xc0003e, 0xa0005e,
  0x80007e, 0x5e00a0, 0x3e00c0, 0x1e00e0,
];

export const RAINBOW24: Rgb[] = RAINBOW24_U24.map((v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff]);

export const SEVEN: Rgb[] = [
  [0xff, 0x00, 0x00], // red    (legacy u24 0x0000ff, low byte = R)
  [0x00, 0xff, 0x00], // green  (0x00ff00)
  [0x00, 0x00, 0xff], // blue   (0xff0000)
  [0x80, 0x80, 0x00], // olive  (0x008080)
  [0x80, 0x00, 0x80], // purple (0x800080)
  [0x00, 0x80, 0x80], // cyan   (0x808000)
  [0x55, 0x55, 0x55], // gray   (0x555555)
];

export const NAMED_PALETTES: Record<string, Rgb[]> = {
  rainbow24: RAINBOW24,
  seven: SEVEN,
};

export const NAMED_COLORS: Record<string, Rgb> = {
  black: [0, 0, 0],
  white: [255, 255, 255],
  red: [255, 0, 0],
  green: [0, 255, 0],
  blue: [0, 0, 255],
  cyan: [0, 255, 255],
  magenta: [255, 0, 255],
  yellow: [255, 255, 0],
  orange: [255, 128, 0],
  purple: [128, 0, 255],
};

// uint16 wraparound for ms fields
export const U16_MAX = 65535;
