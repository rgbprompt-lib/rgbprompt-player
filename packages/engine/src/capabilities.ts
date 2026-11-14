// Single source of truth for what each v1-open primitive accepts
// (ENGINE.md §3, §6). `validate.ts`, `sparkle_time.ts` and the generation
// system prompt all read from this table so capabilities cannot drift.

export const COLOR_TYPES = Object.freeze([
  'solid',
  'palette_index',
  'ramp',
  'hue_cycle',
  'random',
  'from_input',
] as const);
export type ColorType = (typeof COLOR_TYPES)[number];
export const COLOR_TYPE_SET: ReadonlySet<string> = new Set(COLOR_TYPES);

export const TIME_TYPES = Object.freeze(['static', 'breath', 'blink', 'phase_scroll', 'ease'] as const);
export type TimeType = (typeof TIME_TYPES)[number];
export const TIME_TYPE_SET: ReadonlySet<string> = new Set(TIME_TYPES);

export const TRIGGER_TYPES = Object.freeze([
  'always',
  'periodic',
  'key_press',
  'key_hold',
  'key_release',
  'audio',
  'state',
] as const);
export type TriggerType = (typeof TRIGGER_TYPES)[number];
export const TRIGGER_TYPE_SET: ReadonlySet<string> = new Set(TRIGGER_TYPES);

export const PALETTE_VALUES = Object.freeze(['rainbow24', 'seven'] as const);

export type ColorDriver = 'color' | 'palette' | 'both';

export interface PrimitiveCapabilities {
  // Validation acceptance. These are the sets `validate` enforces.
  colorTypes: readonly ColorType[];
  timeTypes: readonly TimeType[];
  triggerTypes: readonly TriggerType[];
  // Palette values accepted in `params.palette`; null when the primitive has no
  // palette parameter.
  paletteValues: readonly string[] | null;
  // Which layer field carries the requested colour.
  colorDriver: ColorDriver;
  // True for primitives whose layer.color, when present, must be solid
  // (key_ring / key_burst / block_stack). Sparkle has its own stricter shape
  // and is covered by `sparkleColor`.
  solidColorOnly?: boolean;
  // Exact number of ramp stops required (rain = 5).
  rampStops?: number;
  // RainbowPrompt prompt hint for ramp lengths.
  rampRange?: readonly [number, number];
  // Sparkle accepts an optional solid layer.color and otherwise uses the palette.
  sparkleColor?: boolean;
  // Compact, human-readable phrases rendered in the system prompt.
  promptColor: string;
  promptTime: string;
  promptTrigger: string;
}

const COLOR_DRIVEN: readonly ColorType[] = ['solid', 'palette_index', 'hue_cycle', 'random', 'from_input'];
const WITH_RAMP: readonly ColorType[] = [...COLOR_DRIVEN, 'ramp'];
const SOLID_ONLY: readonly ColorType[] = ['solid'];
const STATIC_TIME: readonly TimeType[] = TIME_TYPES;
const ALWAYS: readonly TriggerType[] = ['always'];
const DEFAULT_TRIGGERS: readonly TriggerType[] = TRIGGER_TYPES;

const COLOR_TYPES_HINT = 'solid|palette_index|hue_cycle|random';

function colorDriven(): PrimitiveCapabilities['promptColor'] {
  return COLOR_TYPES_HINT;
}

function paletteDriven(): PrimitiveCapabilities['promptColor'] {
  return `params.palette=rainbow24|seven; optional layer.color (${COLOR_TYPES_HINT})`;
}

function bothDriven(): PrimitiveCapabilities['promptColor'] {
  return `params.palette=rainbow24|seven and/or layer.color (${COLOR_TYPES_HINT})`;
}

function solidOrPalette(): PrimitiveCapabilities['promptColor'] {
  return 'solid rgb, or omit color and use params.palette=rainbow24|seven';
}

function base(
  overrides: Partial<PrimitiveCapabilities> &
    Pick<PrimitiveCapabilities, 'promptColor' | 'promptTime' | 'promptTrigger'>,
): PrimitiveCapabilities {
  return {
    colorTypes: COLOR_DRIVEN,
    timeTypes: STATIC_TIME,
    triggerTypes: DEFAULT_TRIGGERS,
    paletteValues: null,
    colorDriver: 'color',
    ...overrides,
  };
}

export const CAPABILITIES: Readonly<Record<string, PrimitiveCapabilities>> = Object.freeze({
  static: base({
    colorTypes: COLOR_DRIVEN,
    promptColor: colorDriven(),
    promptTime: 'static or omit',
    promptTrigger: 'always',
  }),
  gradient: base({
    colorTypes: WITH_RAMP,
    rampRange: [2, 32],
    promptColor: 'layer.color ramp with 2..32 RGB stops (or solid/palette/hue/random)',
    promptTime: 'static only; animate it with a separate breath layer using blend=mask',
    promptTrigger: 'always',
  }),
  breath: base({
    colorTypes: COLOR_DRIVEN,
    promptColor: colorDriven(),
    promptTime: 'breath',
    promptTrigger: 'always',
  }),
  blink: base({
    colorTypes: COLOR_DRIVEN,
    promptColor: colorDriven(),
    promptTime: 'blink',
    promptTrigger: 'always',
  }),
  rainbow_wave: base({
    colorTypes: COLOR_DRIVEN,
    paletteValues: PALETTE_VALUES,
    colorDriver: 'palette',
    promptColor: paletteDriven(),
    promptTime: 'static or omit',
    promptTrigger: 'always',
  }),
  wave: base({
    colorTypes: COLOR_DRIVEN,
    promptColor: colorDriven(),
    promptTime: 'static or omit',
    promptTrigger: 'always',
  }),
  scroll: base({
    colorTypes: COLOR_DRIVEN,
    promptColor: colorDriven(),
    promptTime: 'static or omit',
    promptTrigger: 'always',
  }),
  sparkle: base({
    colorTypes: SOLID_ONLY,
    timeTypes: ['static'],
    triggerTypes: ALWAYS,
    paletteValues: PALETTE_VALUES,
    colorDriver: 'palette',
    sparkleColor: true,
    promptColor:
      'params.palette=rainbow24|seven for multicolour; optional layer.color solid rgb for one fixed colour',
    promptTime: 'static or omit',
    promptTrigger: 'always',
  }),
  drift: base({
    colorTypes: COLOR_DRIVEN,
    promptColor: colorDriven(),
    promptTime: 'static or omit',
    promptTrigger: 'always',
  }),
  ring: base({
    colorTypes: COLOR_DRIVEN,
    paletteValues: PALETTE_VALUES,
    colorDriver: 'palette',
    promptColor: paletteDriven(),
    promptTime: 'static or omit',
    promptTrigger: 'always',
  }),
  key_ring: base({
    // A ramp is a custom ring palette (upstream lepc key_ring custom palette).
    colorTypes: [...SOLID_ONLY, 'ramp'],
    rampRange: [2, 32],
    paletteValues: PALETTE_VALUES,
    colorDriver: 'color',
    solidColorOnly: true,
    promptColor: solidOrPalette(),
    promptTime: 'static or omit (the key trigger drives the animation)',
    promptTrigger: 'key_press',
  }),
  mote: base({
    colorTypes: COLOR_DRIVEN,
    paletteValues: PALETTE_VALUES,
    colorDriver: 'both',
    promptColor: bothDriven(),
    promptTime: 'static or omit',
    promptTrigger: 'always',
  }),
  reactive: base({
    colorTypes: COLOR_DRIVEN,
    paletteValues: PALETTE_VALUES,
    colorDriver: 'both',
    promptColor: bothDriven(),
    promptTime: 'static or omit (the key trigger drives the animation)',
    promptTrigger: 'key_press',
  }),
  ripple: base({
    colorTypes: COLOR_DRIVEN,
    promptColor: colorDriven(),
    promptTime: 'static or omit (the key trigger drives the animation)',
    promptTrigger: 'key_press',
  }),
  ripple_square: base({
    colorTypes: COLOR_DRIVEN,
    promptColor: colorDriven(),
    promptTime: 'static or omit (the key trigger drives the animation)',
    promptTrigger: 'key_press',
  }),
  aurora: base({
    colorTypes: COLOR_DRIVEN,
    paletteValues: PALETTE_VALUES,
    colorDriver: 'palette',
    promptColor: paletteDriven(),
    promptTime: 'static or omit (the key trigger drives the animation)',
    promptTrigger: 'key_press',
  }),
  spectrum: base({
    colorTypes: COLOR_DRIVEN,
    paletteValues: PALETTE_VALUES,
    colorDriver: 'palette',
    promptColor: paletteDriven(),
    promptTime: 'static or omit (audio input drives the animation)',
    promptTrigger: 'audio',
  }),
  spectrum_mirror: base({
    colorTypes: COLOR_DRIVEN,
    paletteValues: PALETTE_VALUES,
    colorDriver: 'palette',
    promptColor: paletteDriven(),
    promptTime: 'static or omit (audio input drives the animation)',
    promptTrigger: 'audio',
  }),
  spectrum_sum: base({
    colorTypes: COLOR_DRIVEN,
    paletteValues: PALETTE_VALUES,
    colorDriver: 'palette',
    promptColor: paletteDriven(),
    promptTime: 'static or omit (audio input drives the animation)',
    promptTrigger: 'audio',
  }),
  key_tint: base({
    colorTypes: COLOR_DRIVEN,
    paletteValues: PALETTE_VALUES,
    colorDriver: 'palette',
    promptColor: paletteDriven(),
    promptTime: 'static or omit',
    promptTrigger: 'key_hold',
  }),
  spiral: base({
    colorTypes: COLOR_DRIVEN,
    paletteValues: PALETTE_VALUES,
    colorDriver: 'both',
    promptColor: bothDriven(),
    promptTime: 'static or omit',
    promptTrigger: 'always',
  }),
  block_stack: base({
    colorTypes: SOLID_ONLY,
    paletteValues: PALETTE_VALUES,
    colorDriver: 'both',
    solidColorOnly: true,
    promptColor: solidOrPalette(),
    promptTime: 'static or omit',
    promptTrigger: 'always',
  }),
  key_burst: base({
    colorTypes: SOLID_ONLY,
    triggerTypes: ['always', 'key_press'],
    paletteValues: PALETTE_VALUES,
    colorDriver: 'both',
    solidColorOnly: true,
    promptColor: solidOrPalette(),
    promptTime: 'static or omit (the key trigger drives the animation)',
    promptTrigger: 'always or key_press (scope "surface" only)',
  }),
  fire: base({
    colorTypes: ['ramp'],
    timeTypes: ['static'],
    triggerTypes: ALWAYS,
    paletteValues: null,
    colorDriver: 'color',
    rampRange: [2, 32],
    promptColor: 'omit for flame colours, or a layer.color ramp with 2..32 RGB stops (coldest first)',
    promptTime: 'static or omit (params.step_ms sets the pace)',
    promptTrigger: 'always',
  }),
  rain: base({
    colorTypes: ['ramp'],
    triggerTypes: ALWAYS,
    paletteValues: null,
    colorDriver: 'color',
    rampStops: 5,
    promptColor: 'layer.color ramp with exactly 5 RGB stops',
    promptTime: 'breath (built-in night background)',
    promptTrigger: 'always',
  }),
});

export type PrimitiveCapabilityCatalog = typeof CAPABILITIES;

export function getCapabilities(component: unknown): PrimitiveCapabilities | null {
  if (typeof component !== 'string') return null;
  return CAPABILITIES[component] ?? null;
}

export function allowedColorTypes(component: unknown): readonly ColorType[] {
  return getCapabilities(component)?.colorTypes ?? COLOR_TYPES;
}

export function allowedTimeTypes(component: unknown): readonly TimeType[] {
  return getCapabilities(component)?.timeTypes ?? TIME_TYPES;
}

export function allowedTriggerTypes(component: unknown): readonly TriggerType[] {
  return getCapabilities(component)?.triggerTypes ?? TRIGGER_TYPES;
}

export function formatColorTypes(component: unknown): string {
  return allowedColorTypes(component).join('/');
}

export function formatTimeTypes(component: unknown): string {
  return allowedTimeTypes(component).join('/');
}

export function formatTriggerTypes(component: unknown): string {
  return allowedTriggerTypes(component).join('/');
}

export function acceptsColorType(component: unknown, type: unknown): boolean {
  return typeof type === 'string' && allowedColorTypes(component).includes(type as ColorType);
}

export function acceptsTimeType(component: unknown, type: unknown): boolean {
  return typeof type === 'string' && allowedTimeTypes(component).includes(type as TimeType);
}

export function acceptsTriggerType(component: unknown, type: unknown): boolean {
  return typeof type === 'string' && allowedTriggerTypes(component).includes(type as TriggerType);
}
