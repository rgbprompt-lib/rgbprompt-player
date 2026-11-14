import type { AudioModulation, AudioOnset } from './audio/control.ts';

import type { Rng } from './rng.ts';

export type Rgb = [number, number, number];

export interface ColorContext {
  tick: number;
  row: number;
  col: number;
  seed?: number;
  layerSalt?: number;
  inputValue?: number;
}

export type ColorSpec =
  | { type: 'solid'; rgb?: Rgb }
  | { type: 'palette_index'; palette?: string; colors?: Rgb[]; index?: number }
  | {
      type: 'ramp';
      palette?: string;
      colors?: Rgb[];
      axis?: string;
      from?: number;
      to?: number;
      stops?: number[];
      alphas?: number[];
    }
  | { type: 'hue_cycle'; period_ms?: number; saturation?: number; value?: number }
  | { type: 'random'; palette?: string; colors?: Rgb[] }
  | { type: 'from_input'; palette?: string; colors?: Rgb[]; source?: string };

export interface EasingCurveSpec {
  bezier?: number[];
  lut?: number[];
}

export type EasingSpec = string | EasingCurveSpec | null | undefined;

export type BoardCell = [number, number];

export interface Board {
  board_id: string;
  name: string;
  logical: { rows: number; cols: number };
  regions: Record<string, 'ALL' | BoardCell[]>;
  key_labels?: Record<string, string>;
}

export interface SurfaceDsl {
  type: string;
  regions?: string[];
  cells?: string[];
  rows?: number[];
  cols?: number[];
  invert?: boolean;
}

/** Shared (non-audio) layer lifecycle. Mutually exclusive with audio_onset playback. */
export interface SharedPlayback {
  start?: 'auto' | 'key_press' | 'selected_press';
  stop?: 'natural' | 'key_press' | 'selected_press';
  retrigger?: 'restart' | 'ignore';
  duration_ms?: number;
  cycles?: number;
  pause_ms?: number;
  input?: SurfaceDsl;
  inputMask?: number[];
}

export type LayerPlayback = AudioOnset | SharedPlayback;

export interface TriggerDsl {
  type?: string;
  scope?: string;
  threshold?: number;
  period_ms?: number;
  [key: string]: unknown;
}

export interface LayerTimeDsl {
  type?: string;
  easing?: EasingSpec;
  direction?: string;
  min_level?: number;
  phase_ms?: number;
  period_ms?: number;
  on_ms?: number;
  off_ms?: number;
  soft?: boolean;
  [key: string]: unknown;
}

export type FramePoint = [number, number, number, number, number, number];

export interface FrameDsl {
  points: FramePoint[];
  hold?: number;
}

export interface LayerParams {
  easing?: EasingSpec;
  direction?: string;
  [key: string]: unknown;
}

export interface LayerDsl {
  id: string;
  component: string;
  surface: SurfaceDsl;
  blend?: string;
  opacity?: number;
  color?: ColorSpec | null;
  time?: LayerTimeDsl;
  trigger?: TriggerDsl;
  params?: LayerParams;
  frames?: FrameDsl[] | null;
  audio_mod?: AudioModulation;
  playback?: LayerPlayback;
  [key: string]: unknown;
}

export type ExecutionProfile = 'composable-v1';

export interface EffectMeta {
  seed: number;
  name?: string;
  author?: string;
  generator?: string;
  region_profile?: string;
  motion_profile?: string;
  /** Always composable-v1 in this repo. Missing values are filled by normalize. */
  execution_profile?: ExecutionProfile;
  [key: string]: unknown;
}

export interface EffectDsl {
  schema?: string;
  meta: EffectMeta;
  layer: LayerDsl[];
}

export interface NormalizedLayer {
  id: string;
  component: string;
  blend: string;
  opacity: number;
  enabled?: boolean;
  cells: BoardCell[];
  mask: number[];
  color: ColorSpec | null;
  time: LayerTimeDsl;
  trigger: TriggerDsl;
  params: LayerParams;
  frames: FrameDsl[] | null;
  audio_mod?: AudioModulation;
  playback?: LayerPlayback;
  lut: number[] | null;
}

export interface Program {
  seed: number;
  layers: NormalizedLayer[];
  meta: EffectMeta;
}

export interface DecodedLayer extends Omit<NormalizedLayer, 'component' | 'cells'> {
  component: string | null;
  cells?: BoardCell[];
}

export const VALIDATION_CODES = Object.freeze([
  'SCHEMA',
  'META_INVALID',
  'LAYER_INVALID',
  'DUPLICATE_LAYER_ID',
  'COMPONENT_UNKNOWN',
  'COMPONENT_NOT_OPEN',
  'SURFACE_INVALID',
  'SURFACE_EMPTY',
  'COLOR_INVALID',
  'COLOR_UNSUPPORTED',
  'TIME_INVALID',
  'TRIGGER_INVALID',
  'PARAM_UNKNOWN',
  'PARAM_TYPE',
  'PARAM_RANGE',
  'PARAM_CONFLICT',
  'BUDGET_LAYERS',
  'BUDGET_PARAMS',
  'BUDGET_PALETTE',
  'BUDGET_BYTES',
] as const);

export type ValidationCode = (typeof VALIDATION_CODES)[number];

export type ValidationMode = 'strict' | 'generate';

export interface ValidationIssue {
  path: string;
  code: ValidationCode;
  message: string;
}

export interface ValidationClamp {
  path: string;
  from: number;
  to: number;
}

export interface ValidationBudget {
  layers: number;
  estCostUnits: number;
  bytes: number;
}

export interface ValidationReport {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  clamps: ValidationClamp[];
  budget: ValidationBudget;
  value: unknown | null;
}

export interface ValidateOptions {
  mode?: ValidationMode;
  board?: Board | null;
}

export interface RegistryParamSpec {
  enum?: string[];
  min?: number;
  max?: number;
  default?: unknown;
}

export interface RegistryPrimitive {
  id: number;
  name: string;
  kind: string;
  bakeable: boolean;
  params: Record<string, RegistryParamSpec>;
}

export interface PrimitiveRegistry {
  registry_version: number;
  dsl_version: number;
  note: string;
  primitives: RegistryPrimitive[];
}

export interface RegistryIndex {
  raw: PrimitiveRegistry;
  byName: Map<string, RegistryPrimitive>;
  byId: Map<number, RegistryPrimitive>;
}

export type PrimitiveSpace = 'logical' | 'physical';

export type PrimitiveFlashRisk = 'low' | 'medium' | 'high';

export interface PrimitiveProduct {
  displayName: { en: string; 'zh-CN': string };
  icon: string;
  tags: string[];
  speed: { params: string[]; inverse: boolean };
  direction: string | null;
  colorSlots: string[];
  requiresInput: 'key' | 'audio' | null;
  flashRisk: PrimitiveFlashRisk;
  space: PrimitiveSpace;
}

export type PrimitiveProductCatalog = Readonly<Record<string, PrimitiveProduct>>;

export type SpiralTable = readonly (readonly number[])[];

export type KeyCentreTable = readonly (readonly BoardCell[])[];

export type LedPositionTable = readonly (readonly BoardCell[])[];

export type LayoutPresenceTable = readonly (readonly number[])[];

/** Key width per logical cell in 1/8 key units; 0 where no key sits. */
export type KeyWidthTable = readonly (readonly number[])[];

/** Physical geometry of one keyboard, indexed by logical cell (1/8 key units). */
export interface Geometry {
  keyCentres: KeyCentreTable;
  ledPositions: LedPositionTable;
  present: LayoutPresenceTable;
  keyWidths: KeyWidthTable;
}

export type KleKeyObject = {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  [key: string]: unknown;
};

export type KleItem = string | KleKeyObject;

export type KleBoard = readonly (readonly KleItem[])[];

export interface KleKey {
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  legendTop?: string;
  legendBottom?: string;
  cell?: BoardCell;
}

export interface KeyboardKey extends KleKey {
  legendTop: string;
  legendBottom: string;
  cell: BoardCell;
}

export interface KeyboardModel {
  name: string;
  label: string;
  unit: number;
  maxX: number;
  maxY: number;
  keys: KeyboardKey[];
}

export interface KeyboardMeta {
  id: string;
  label: string;
}

export interface RainParams {
  drops_per_second?: number;
  shower_period_s?: number;
  shower_extra?: number;
  fall_min_ms?: number;
  fall_max_ms?: number;
  tail_first?: number;
  tail_second?: number;
  splash_ms?: number;
}

export interface RainEvent {
  lane: number;
  born: number;
  fall: number;
  intro: boolean;
  accent?: boolean;
  tail1?: number;
  tail2?: number;
  splash?: number;
}

export interface RainSample {
  level: number;
  accent: boolean;
}

export interface FrameCell {
  r: number;
  g: number;
  b: number;
  l: number;
}

export type Frame = FrameCell[][];

export interface LayerCell extends FrameCell {
  on: boolean;
  /** Optional per-cell coverage from color.alphas (0..255). */
  a?: number;
}

export type LayerBuffer = LayerCell[][];

// Timestamped key event accepted by `Renderer.step` (`io.keys`).
export interface KeyEvent {
  t: number;
  type: 'down' | 'up';
  cell: string;
}

// Press/release event handed to the per-layer renderers; legacy inputs omit `type`.
export interface TimedKeyEvent {
  t: number;
  cell: string;
}

export interface AudioSample {
  t: number;
  bands: number[];
}

// The only input form `step` accepts: timestamped events. A missing or empty
// array means "no new input".
export interface StepInput {
  keys?: KeyEvent[];
  audio?: AudioSample[];
}

export interface RenderIo {
  keyDown: Set<string>;
  keyPressed: Set<string>;
  keyReleased: Set<string>;
  keyPressedEvents: TimedKeyEvent[];
  keyReleasedEvents: TimedKeyEvent[];
  keys: TimedKeyEvent[];
  audioOnsets?: number[];
  spectrumBands?: number[] | undefined;
  spectrumRaw?: number[] | undefined;
}

// Known per-layer render params. The index signature inherited from LayerParams
// keeps arbitrary validated JSON readable.
export interface RenderParams extends LayerParams {
  period_ms?: number;
  min_level?: number;
  on_ms?: number;
  off_ms?: number;
  soft?: boolean;
  axis?: string;
  wavelength?: number;
  width?: number;
  arms?: number;
  twist?: number;
  beam?: number;
  soft_edge?: number;
  count?: number;
  size?: number;
  wobble?: number;
  motion?: string;
  life_ms?: number;
  max_radius?: number;
  max_waves?: number;
  width_tenths?: number;
  softness_tenths?: number;
  afterglow_ms?: number;
  flash_ms?: number;
  max_bursts?: number;
  step_ms?: number;
  speed?: number;
  dense?: boolean;
  beat?: boolean;
  peak_ms?: number;
  gain?: number;
  loop?: boolean;
  palette?: string;
  width_pct?: number;
  wrap?: string;
  spatial_direction?: string;
  angle_deg?: number;
  color_twist?: number;
  center_x?: number;
  center_y?: number;
  color_mode?: string;
  duration_ms?: number;
}

export interface RenderContext {
  tick: number;
  rng: Rng;
  seed: number;
  layerSalt: number;
}

export interface ReactiveEntry {
  rgb: Rgb;
  born: number;
}

export interface RippleDot {
  r: number;
  c: number;
  born: number;
  retirement: number;
}

export interface KeyRing {
  r: number;
  c: number;
  born: number;
  seq: number;
}

export interface KeyRingState {
  rings: (KeyRing | null)[];
  sequence: number;
}

export interface KeyBurst {
  r: number;
  c: number;
  born: number;
  seq: number;
  flash: boolean;
}

export interface KeyBurstState {
  bursts: (KeyBurst | null)[];
  sequence: number;
}

export interface BlockPiece {
  shape: number;
  col: number;
  row: number;
}

export interface BlockStackState {
  grid: number[][];
  slot: number | null;
  piece: BlockPiece | null;
  sequence: number;
}

export interface AuroraDot {
  r: number;
  c: number;
  wave: number;
  rgb: Rgb;
}

export interface AuroraCell {
  rgb: Rgb;
  l: number;
}

export interface AuroraState {
  slots: (AuroraDot | null)[];
  cells: (AuroraCell | null)[][];
  boundaryFloor: number;
}

export interface PendingAudioSample {
  t: number;
  bands: number[];
}

export interface AudioState {
  cell: number[][];
  peak: number[];
  peakUntil: number[];
  peakFallUntil: number[];
  beatUntil: number;
  beatLast: number;
  zeroSince: number | null;
  mode: number;
  time: number;
  bands: number[] | null;
  heights: number[];
  silent: boolean;
  lastSampleT: number;
}

export interface SimKeyEvent {
  tick: number;
  type: 'down' | 'up';
  cell: string;
}

export interface SimAudioEvent {
  tick: number;
  bands: number[];
}

export interface SimInput {
  ticks?: number;
  stepMs?: number;
  keyEvents?: SimKeyEvent[];
  audio?: SimAudioEvent[];
}
