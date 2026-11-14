import { LayerAudio, usesAudioContract, usesExtendedSpectrum } from './audio/control.ts';
// Deterministic reference renderer. docs/07.
// This module is the single source of truth for effect semantics: the browser
// editor preview and all consumers MUST mirror it exactly.
import {
  LOGIC_ROWS,
  LOGIC_COLS,
  MAX_LOGIC_LED_LIGHT_LEVEL,
  MAX_LED_LIGHT_LEVEL,
  MAX_PHYSICAL_LED_LIGHT_LEVEL,
  DRIFT_BREATH_PERIOD_MS,
} from './constants.ts';
import { Rng, sparkleIdHash, pickRandomMaskedKey, collectMaskedKeys } from './rng.ts';
import { resolveColor, resolvePalette, rampColor, axisValue } from './color.ts';
import { hasPlayback, PlaybackState } from './playback.ts';
import { rampAlpha } from './palette_alpha.ts';
import { cosAt, phaseS, tri01, easeAt } from './timing.ts';
import { spiralGeometry } from './spiral_geometry.ts';
import { waveProjection } from './wave_geometry.ts';
import { FireState, FIRE_COLORS } from './fire_model.ts';
import { DEFAULT_GEOMETRY, audioBurstCentre } from './geometry.ts';
import { rainEvents, rainGeometry, rainSample, rainHash } from './rain_model.ts';
import { isTimeSparkle, timeSparkleEvents } from './sparkle_time.ts';
import type {
  Geometry,
  AudioSample,
  AudioState,
  AuroraCell,
  AuroraState,
  BlockPiece,
  BlockStackState,
  ColorContext,
  Frame,
  FrameCell,
  FrameDsl,
  KeyBurst,
  KeyBurstState,
  KeyEvent,
  KeyRing,
  KeyRingState,
  LayerBuffer,
  LayerCell,
  NormalizedLayer,
  PendingAudioSample,
  Program,
  ReactiveEntry,
  RenderContext,
  RenderIo,
  RenderParams,
  BoardCell,
  RainParams,
  Rgb,
  RippleDot,
  SimAudioEvent,
  SimInput,
  SimKeyEvent,
  StepInput,
  TimedKeyEvent,
} from './types.ts';

// ---- frame helpers ---------------------------------------------------------
export function makeFrame(): Frame {
  const rows: Frame = [];
  for (let r = 0; r < LOGIC_ROWS; r++) {
    const row: FrameCell[] = [];
    for (let c = 0; c < LOGIC_COLS; c++) row.push({ r: 0, g: 0, b: 0, l: 0 });
    rows.push(row);
  }
  return rows;
}

function layerBuf(): LayerBuffer {
  const rows: LayerBuffer = [];
  for (let r = 0; r < LOGIC_ROWS; r++) {
    const row: LayerCell[] = [];
    for (let c = 0; c < LOGIC_COLS; c++) row.push({ r: 0, g: 0, b: 0, l: 0, on: false });
    rows.push(row);
  }
  return rows;
}

const sat = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

const AUDIO_COMPONENTS = new Set(['spectrum', 'spectrum_mirror', 'spectrum_sum']);

// Audio state advances one millisecond at a time. Catch-up is capped at the
// last 2000 ms before the frame because anything older cannot affect it:
// cells decay at most one level per ms (<= 25 ms to go dark), a peak is held
// for peak_ms (registry maximum 1000 ms) and then falls one row every 60 ms
// (6 * 60 = 360 ms), and silence clears peaks after 250 ms. 1000 + 360 + 250
// = 1610 < 2000. The same cap bounds a cold start at a large t.
const AUDIO_CATCHUP_MS = 2000;

// Aurora replays elapsed interval boundaries. Cap that too: 10 boundaries fade
// any cell from 100 to 0 (-10 per boundary) and a dot needs at most 22
// boundaries to walk its fronts across the 22-column grid, so 32 boundaries
// before t cover every state that can still be visible at t.
const AURORA_CATCHUP_BOUNDARIES = 10 + 22;

// Stable key-event ordering: timestamp, down before up, then cell in the
// keyboard's scan order (column, then row), as the firmware reads its maps.
function compareKeyEvents(a: KeyEvent, b: KeyEvent): number {
  if (a.t !== b.t) return a.t - b.t;
  if (a.type !== b.type) return a.type === 'down' ? -1 : 1;
  // Reason: a cell string is "row,col"; the first two entries are the indices.
  const [ar, ac] = a.cell.split(',').map(Number) as [number, number];
  // Reason: a cell string is "row,col"; the first two entries are the indices.
  const [br, bc] = b.cell.split(',').map(Number) as [number, number];
  if (Number.isFinite(ar) && Number.isFinite(ac) && Number.isFinite(br) && Number.isFinite(bc)) {
    return ac - bc || ar - br;
  }
  return a.cell < b.cell ? -1 : a.cell > b.cell ? 1 : 0;
}

// Composable-v1 is the only execution path in this repo (ENGINE.md §10).
export function composite(dst: Frame, src: LayerBuffer, blend: string, opacity = 255): void {
  for (let r = 0; r < LOGIC_ROWS; r++) {
    for (let c = 0; c < LOGIC_COLS; c++) {
      // Reason: r is a logical row index, always inside the frame.
      const sRow = src[r] as LayerCell[];
      // Reason: r is a logical row index, always inside the frame.
      const dRow = dst[r] as FrameCell[];
      // Reason: c is a logical column index, always inside this row.
      const s = sRow[c] as LayerCell;
      if (!s.on) continue;
      // Reason: c is a logical column index, always inside this row.
      const d = dRow[c] as FrameCell;
      const o = sat(opacity, 0, 255);
      if (blend === 'replace') {
        // When color.alphas is absent, a === o, so existing composable frames stay identical.
        const a = Math.floor(((s.a ?? 255) * o + 127) / 255);
        if (!a) continue;
        const merge = (previous: number, current: number) =>
          Math.floor(
            (Math.floor((previous * d.l) / 100) * (255 - a) + Math.floor((current * s.l) / 100) * a + 127) /
              255,
          );
        dRow[c] = { r: merge(d.r, s.r), g: merge(d.g, s.g), b: merge(d.b, s.b), l: 100 };
        continue;
      }
      const sl = Math.floor((s.l * o) / 255);
      if (blend === 'add' || blend === 'max') {
        // operate on effective intensity I = channel * level / 100 (actual light),
        // so a fading overlay dims instead of holding then snapping.
        const deR = Math.floor((d.r * d.l) / 100),
          deG = Math.floor((d.g * d.l) / 100),
          deB = Math.floor((d.b * d.l) / 100);
        const seR = Math.floor((s.r * sl) / 100),
          seG = Math.floor((s.g * sl) / 100),
          seB = Math.floor((s.b * sl) / 100);
        if (blend === 'add') {
          dRow[c] = {
            r: sat(deR + seR, 0, 255),
            g: sat(deG + seG, 0, 255),
            b: sat(deB + seB, 0, 255),
            l: MAX_LOGIC_LED_LIGHT_LEVEL,
          };
        } else {
          dRow[c] = {
            r: Math.max(deR, seR),
            g: Math.max(deG, seG),
            b: Math.max(deB, seB),
            l: MAX_LOGIC_LED_LIGHT_LEVEL,
          };
        }
      } else if (blend === 'mask') {
        // modulate underlying brightness by src level, keep underlying color
        dRow[c] = {
          r: d.r,
          g: d.g,
          b: d.b,
          l: sat(
            Math.floor((d.l * (255 - o + Math.floor((s.l * o) / 100))) / 255),
            0,
            MAX_LOGIC_LED_LIGHT_LEVEL,
          ),
        };
      }
    }
  }
}

// ---- deterministic component renderers -------------------------------------
function renderStaticLayer(layer: NormalizedLayer, ctx: RenderContext, buf: LayerBuffer): void {
  const rgb = resolveColor(layer.color || { type: 'solid', rgb: [255, 255, 255] }, {
    ...ctx,
    row: 0,
    col: 0,
  });
  for (const [r, c] of layer.cells) {
    // Reason: r and c come from the layer's cell list, always inside the buffer.
    (buf[r] as LayerCell[])[c] = { r: rgb[0], g: rgb[1], b: rgb[2], l: 100, on: true };
  }
}

function renderGradientLayer(layer: NormalizedLayer, ctx: RenderContext, buf: LayerBuffer): void {
  for (const [r, c] of layer.cells) {
    const rgb = resolveColor(layer.color, { ...ctx, row: r, col: c });
    // Reason: r and c come from the layer's cell list, always inside the buffer.
    (buf[r] as LayerCell[])[c] = { r: rgb[0], g: rgb[1], b: rgb[2], l: 100, on: true };
  }
}

function renderBreathLayer(layer: NormalizedLayer, ctx: RenderContext, buf: LayerBuffer): void {
  // Reason: validated layer params; only the typed fields below are read.
  const p = (layer.params || {}) as RenderParams;
  const period = p.period_ms ?? layer.time?.period_ms ?? 2000;
  const minLevel = p.min_level ?? layer.time?.min_level ?? 10;
  const s = phaseS(ctx.tick, period, layer.time?.phase_ms ?? 0);
  // cycle shape = easing(triangle): E(tri(s)) preserves the classic breath when E = sine
  const l = minLevel + Math.floor(((100 - minLevel) * easeAt(layer.lut, tri01(s))) / 1000);
  const baseColor: Rgb = layer.color
    ? resolveColor(layer.color, { ...ctx, row: 0, col: 0 })
    : [255, 255, 255];
  for (const [r, c] of layer.cells) {
    // Reason: r and c come from the layer's cell list, always inside the buffer.
    (buf[r] as LayerCell[])[c] = { r: baseColor[0], g: baseColor[1], b: baseColor[2], l, on: true };
  }
}

function renderBlinkLayer(layer: NormalizedLayer, ctx: RenderContext, buf: LayerBuffer): void {
  // Reason: validated layer params; only the typed fields below are read.
  const p = (layer.params || {}) as RenderParams;
  const on = p.on_ms ?? layer.time?.on_ms ?? 250;
  const off = p.off_ms ?? layer.time?.off_ms ?? 250;
  const soft = p.soft ?? layer.time?.soft ?? true;
  const period = Math.max(1, on + off);
  const phase = (((ctx.tick + (layer.time?.phase_ms ?? 0)) % period) + period) % period;
  let l = 0;
  if (phase < on) {
    l = 100;
    if (soft && on > 0) {
      const a = Math.max(1, Math.floor(on / 5));
      if (phase < a) l = Math.floor((100 * easeAt(layer.lut, Math.floor((phase * 1000) / a))) / 1000);
      else if (phase > on - a)
        l = Math.floor((100 * easeAt(layer.lut, Math.floor(((on - phase) * 1000) / a))) / 1000);
    }
  }
  const baseColor: Rgb = layer.color
    ? resolveColor(layer.color, { ...ctx, row: 0, col: 0 })
    : [255, 255, 255];
  for (const [r, c] of layer.cells) {
    // Reason: r and c come from the layer's cell list, always inside the buffer.
    (buf[r] as LayerCell[])[c] = { r: baseColor[0], g: baseColor[1], b: baseColor[2], l, on: true };
  }
}

function renderRainbowWaveLayer(layer: NormalizedLayer, ctx: RenderContext, buf: LayerBuffer): void {
  // Reason: validated layer params; only the typed fields below are read.
  const p = (layer.params || {}) as RenderParams;
  const period = p.period_ms ?? 3000;
  const axis = p.axis ?? 'x';
  const dir = p.direction === 'reverse' ? -1 : 1;
  // Reason: only some ColorSpec variants carry custom palette stops.
  const pal = resolvePalette(p.palette ?? 'rainbow24', (layer.color as { colors?: Rgb[] } | null)?.colors);
  // Reason: resolvePalette always returns at least one color.
  // `reset` ends on the last colour and jumps back; `seamless` closes the loop.
  const ring = p.wrap === 'reset' ? pal : pal.concat([pal[0] as Rgb]);
  const span = axis === 'y' ? LOGIC_ROWS : LOGIC_COLS;
  // 0..1000; time.phase_ms shifts the clock, as the firmware's u32 phase clock does.
  const base = phaseS((ctx.tick + (layer.time?.phase_ms ?? 0)) >>> 0, period);
  const offset = dir > 0 ? base : 1000 - base;
  const width = p.width_pct ?? 100;
  const sign = p.spatial_direction === 'reverse' || p.spatial_direction === 'mirror_reverse' ? -1 : 1;
  const mirror = p.spatial_direction === 'mirror' || p.spatial_direction === 'mirror_reverse';
  const angle = axis === 'angle' ? (p.angle_deg ?? 0) : axis === 'y' ? 90 : 0;
  for (const [r, c] of layer.cells) {
    const pos = axis === 'y' ? r : c;
    const posFrac =
      axis === 'uniform'
        ? 0
        : axis === 'angle' || mirror
          ? waveProjection(r, c, angle, width, sign, mirror)
          : Math.trunc((sign * pos * 100000) / (span * width));
    const s = (((posFrac + offset) % 1000) + 1000) % 1000;
    const rgb = rampColor(ring, s, layer.color && 'stops' in layer.color ? layer.color.stops : undefined);
    const alphas = layer.color && 'alphas' in layer.color ? layer.color.alphas : undefined;
    // Reason: r and c come from the layer's cell list, always inside the buffer.
    (buf[r] as LayerCell[])[c] = {
      r: rgb[0],
      g: rgb[1],
      b: rgb[2],
      l: 100,
      on: true,
      ...(alphas
        ? {
            a: rampAlpha(
              alphas,
              s,
              p.wrap !== 'reset',
              layer.color && 'stops' in layer.color ? layer.color.stops : undefined,
            ),
          }
        : {}),
    };
  }
}

function renderWaveLayer(layer: NormalizedLayer, ctx: RenderContext, buf: LayerBuffer): void {
  // Reason: validated layer params; only the typed fields below are read.
  const p = (layer.params || {}) as RenderParams;
  const period = p.period_ms ?? 2000;
  const axis = p.axis ?? 'x';
  const wavelength = Math.max(1, p.wavelength ?? 8);
  const dir = p.direction === 'reverse' ? -1 : 1;
  const baseColor: Rgb = layer.color
    ? resolveColor(layer.color, { ...ctx, row: 0, col: 0 })
    : [255, 255, 255];
  const scroll1000 = phaseS(ctx.tick, period) * wavelength * dir;
  const span1000 = wavelength * 1000;
  for (const [r, c] of layer.cells) {
    const pos = axis === 'y' ? r : c;
    const rel1000 = (((pos * 1000 - scroll1000) % span1000) + span1000) % span1000;
    const s = Math.floor(rel1000 / wavelength);
    const l = Math.floor((100 * Math.floor((1000 - cosAt(s)) / 2)) / 1000);
    // Reason: r and c come from the layer's cell list, always inside the buffer.
    (buf[r] as LayerCell[])[c] = { r: baseColor[0], g: baseColor[1], b: baseColor[2], l, on: true };
  }
}

function renderScrollLayer(layer: NormalizedLayer, ctx: RenderContext, buf: LayerBuffer): void {
  // Reason: validated layer params; only the typed fields below are read.
  const p = (layer.params || {}) as RenderParams;
  const period = p.period_ms ?? 1500;
  const axis = p.axis ?? 'x';
  const width = Math.max(1, p.width ?? 4);
  const dir = p.direction === 'reverse' ? -1 : 1;
  const span = axis === 'y' ? LOGIC_ROWS : LOGIC_COLS;
  const baseColor: Rgb = layer.color
    ? resolveColor(layer.color, { ...ctx, row: 0, col: 0 })
    : [255, 255, 255];
  const travel = span + width;
  const head = Math.floor((phaseS(ctx.tick, period) * travel) / 1000);
  const pos = dir > 0 ? head : travel - head;
  for (const [r, c] of layer.cells) {
    const at = axis === 'y' ? r : c;
    const dist = at - (pos - width);
    const l = dist >= 0 && dist < width ? 100 : 0;
    // Reason: r and c come from the layer's cell list, always inside the buffer.
    (buf[r] as LayerCell[])[c] = { r: baseColor[0], g: baseColor[1], b: baseColor[2], l, on: true };
  }
}

function renderSpiralLayer(layer: NormalizedLayer, ctx: RenderContext, buf: LayerBuffer): void {
  // Reason: validated layer params; only the typed fields below are read.
  const p = (layer.params || {}) as RenderParams;
  const period = Math.max(1, p.period_ms ?? 3000);
  const arms = Math.max(1, Math.min(8, p.arms ?? 2));
  const twist = Math.max(0, Math.min(2000, p.twist ?? 1000));
  const beam = Math.max(1, Math.min(1000, p.beam ?? 240));
  const edge = Math.max(0, Math.min(Math.floor(beam / 2), p.soft_edge ?? 0));
  const dir = p.direction === 'reverse' ? -1 : 1;
  const phase = phaseS(ctx.tick, period, 0);
  // Reason: only some ColorSpec variants carry custom palette stops.
  const pal = resolvePalette(p.palette ?? 'rainbow24', (layer.color as { colors?: Rgb[] } | null)?.colors);
  const geometry = spiralGeometry(p.center_x ?? 500, p.center_y ?? 500);
  const colorTwist = p.color_twist ?? 500;
  for (const [r, c] of layer.cells) {
    // Reason: r and c are logical grid indices, always inside the spiral table.
    const a = (geometry.angle[r] as readonly number[])[c] as number;
    // Reason: r and c are logical grid indices, always inside the spiral table.
    const rad = (geometry.radius[r] as readonly number[])[c] as number;
    const s = (((arms * a + Math.floor((twist * rad) / 1000) - dir * phase) % 1000) + 1000) % 1000;
    if (s >= beam) {
      // Reason: r and c come from the layer's cell list, always inside the buffer.
      (buf[r] as LayerCell[])[c] = { r: 0, g: 0, b: 0, l: 0, on: false };
      continue;
    }
    const cs = (((a + Math.floor((colorTwist * rad) / 1000) + dir * phase) % 1000) + 1000) % 1000;
    const rgb =
      layer.color?.type === 'solid'
        ? resolveColor(layer.color, { ...ctx, row: r, col: c })
        : rampColor(pal, cs, layer.color && 'stops' in layer.color ? layer.color.stops : undefined);
    const dist = Math.min(s, beam - s);
    const level = edge > 0 && dist < edge ? Math.floor((dist * 100) / edge) : 100;
    const alphas = layer.color && 'alphas' in layer.color ? layer.color.alphas : undefined;
    // Reason: r and c come from the layer's cell list, always inside the buffer.
    (buf[r] as LayerCell[])[c] = {
      r: rgb[0],
      g: rgb[1],
      b: rgb[2],
      l: level,
      on: true,
      ...(alphas
        ? {
            a: rampAlpha(
              alphas,
              cs,
              false,
              layer.color && 'stops' in layer.color ? layer.color.stops : undefined,
            ),
          }
        : {}),
    };
  }
}

function ringHash(seed: number, n: number): number {
  let x = (seed ^ Math.imul(n, 0x9e3779b9)) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

const BLOCK_SHAPES = [
  [
    [0, 0],
    [0, 1],
    [0, 2],
    [0, 3],
  ],
  [
    [0, 0],
    [0, 1],
    [1, 0],
    [1, 1],
  ],
  [
    [0, 0],
    [0, 1],
    [0, 2],
    [1, 1],
  ],
  [
    [0, 1],
    [0, 2],
    [1, 0],
    [1, 1],
  ],
  [
    [0, 0],
    [0, 1],
    [1, 1],
    [1, 2],
  ],
  [
    [0, 0],
    [1, 0],
    [1, 1],
    [1, 2],
  ],
  [
    [0, 2],
    [1, 0],
    [1, 1],
    [1, 2],
  ],
];

export interface RendererOptions {
  /** Keyboard geometry; the generic 104-key layout when omitted. */
  geometry?: Geometry;
}

// ---- renderer --------------------------------------------------------------
export class Renderer {
  private playbackStates: PlaybackState[] = [];
  declare program: Program;
  declare rng: Rng;
  declare geometry: Geometry;
  declare layerRngs: Rng[];
  // Pressed keys of each fixed-colour reactive layer ("r,c" -> colour and press time).
  declare reactiveByLayer: Map<string, ReactiveEntry>[];
  // Reactive lifecycle mode: press time of every lit key, one map per layer.
  declare lifecycleBorn: Map<string, number>[];
  declare fireStates: (FireState | null)[];
  // Ten fixed slots per ripple layer (the firmware has one pool; several ripple
  // layers are a product feature and each keeps its own).
  declare rippleSlotsByLayer: (RippleDot | null)[][];
  declare keyRings: KeyRingState[];
  declare keyBursts: KeyBurstState[];
  declare blockStacks: BlockStackState[];
  declare auroraStates: AuroraState[];
  declare prevKeyDown: Set<string>;
  declare rainEpoch: (number | null)[];
  declare lastTick: number;
  declare _audioStates: AudioState[];
  private readonly layersAudio: (LayerAudio | null)[];
  private readonly usesBindings: boolean;
  declare _audioPending: PendingAudioSample[];
  declare _audioAdvancedTo: number;
  declare _down: Set<string>;
  declare _futureKeys: KeyEvent[];
  declare _lastKeyT: number;
  declare _lastKeyIds: Set<string>;

  constructor(program: Program, options: RendererOptions = {}) {
    this.program = program;
    this.geometry = options.geometry ?? DEFAULT_GEOMETRY;
    this.rng = new Rng(program.seed || 1);
    this.layerRngs = program.layers.map(
      (layer) => new Rng(((program.seed || 1) ^ sparkleIdHash(layer.id || '')) >>> 0),
    );
    this.reactiveByLayer = program.layers.map(() => new Map<string, ReactiveEntry>());
    this.lifecycleBorn = program.layers.map(() => new Map<string, number>());
    this.fireStates = program.layers.map(() => null);
    this.rippleSlotsByLayer = program.layers.map(() => new Array<RippleDot | null>(10).fill(null));
    this.keyRings = Array.from({ length: 8 }, () => ({ rings: new Array(8).fill(null), sequence: 0 }));
    this.keyBursts = Array.from({ length: 8 }, () => ({
      bursts: new Array(8).fill(null),
      sequence: 0,
    }));
    this.blockStacks = Array.from({ length: 8 }, () => ({
      grid: Array.from({ length: LOGIC_ROWS }, () => new Array(LOGIC_COLS).fill(0)),
      slot: null,
      piece: null,
      sequence: 0,
    }));
    this.auroraStates = Array.from({ length: 8 }, () => ({
      slots: new Array(10).fill(null),
      cells: Array.from({ length: LOGIC_ROWS }, () => new Array(LOGIC_COLS).fill(null)),
      boundaryFloor: -1,
    }));
    this.prevKeyDown = new Set();
    this.rainEpoch = new Array(8).fill(null);
    this.lastTick = 0;
    this._audioStates = [];
    this.layersAudio = program.layers.map((layer) =>
      usesAudioContract(layer) ? new LayerAudio(layer) : null,
    );
    this.usesBindings = this.layersAudio.some(Boolean);
    this._audioPending = [];
    this._audioAdvancedTo = -1;
    this._down = new Set();
    this._futureKeys = [];
    this._lastKeyT = -1;
    this._lastKeyIds = new Set();
  }

  // Timestamped input API:
  //   io.keys:  [{ t, type: 'down'|'up', cell: 'r,c' }] (unsorted, may be future)
  //   io.audio: [{ t, bands }] (unsorted, may be future)
  // A missing or empty array means "no new input": no key event is applied and
  // no audio sample is queued. The audio clock still advances with the frame.
  step(tick: number, io: StepInput): Frame {
    const frame = makeFrame();

    const incoming = (io.keys || []).concat(this._futureKeys);
    this._futureKeys = [];
    const due: KeyEvent[] = [];
    for (const ev of incoming) {
      if (ev.t > tick) this._futureKeys.push(ev);
      else due.push(ev);
    }
    due.sort(compareKeyEvents);
    const keyPressedEvents: TimedKeyEvent[] = [];
    const keyReleasedEvents: TimedKeyEvent[] = [];
    const appliedKeys: TimedKeyEvent[] = [];
    for (const ev of due) {
      if (ev.t < this._lastKeyT) continue;
      if (ev.t > this._lastKeyT) {
        this._lastKeyT = ev.t;
        this._lastKeyIds.clear();
      }
      const id = `${ev.type}|${ev.cell}`;
      if (this._lastKeyIds.has(id)) continue;
      this._lastKeyIds.add(id);
      if (ev.type === 'down') {
        this._down.add(ev.cell);
        keyPressedEvents.push(ev);
      } else {
        this._down.delete(ev.cell);
        keyReleasedEvents.push(ev);
      }
      appliedKeys.push(ev);
    }
    const keyDown = new Set(this._down);
    const keyPressed = new Set(keyPressedEvents.map((ev) => ev.cell));
    const keyReleased = new Set(keyReleasedEvents.map((ev) => ev.cell));

    this._acceptAudio(io.audio);
    const seen = new Set<number>();
    const audioNow = this.usesBindings
      ? this._audioPending
          .filter((sample) => sample.t <= tick)
          .sort((a, b) => a.t - b.t)
          .filter((sample) => {
            if (seen.has(sample.t)) return false;
            seen.add(sample.t);
            return true;
          })
      : [];
    this._advanceAudio(tick);

    this._dispatchPresses(keyPressedEvents);

    const ioView: RenderIo = {
      keyDown,
      keyPressed,
      keyReleased,
      keyPressedEvents,
      keyReleasedEvents,
      keys: appliedKeys,
    };

    for (let li = 0; li < this.program.layers.length; li++) {
      // Reason: li is below layers.length in the loop condition.
      const layer = this.program.layers[li] as NormalizedLayer;
      const buf = layerBuf();
      const audio = this.layersAudio[li]?.step(tick, audioNow);
      let localTick = audio?.tick ?? tick;
      if (hasPlayback(layer)) {
        const state = (this.playbackStates[li] ??= new PlaybackState());
        const playbackTick = state.step(tick, layer.playback as Record<string, unknown>, ioView.keyPressed);
        if (playbackTick === null) continue;
        localTick = playbackTick;
      }
      const layerIo = this._scopedIo(layer, ioView);
      this.renderLayer(
        layer,
        localTick,
        audio
          ? { ...layerIo, audioOnsets: audio.onsets, spectrumBands: audio.bands, spectrumRaw: audio.raw }
          : layerIo,
        buf,
        li,
      );
      if (audio && audio.brightness !== 1000)
        for (const row of buf)
          for (const cell of row) if (cell.on) cell.l = Math.floor((cell.l * audio.brightness) / 1000);
      for (let r = 0; r < LOGIC_ROWS; r++)
        for (let c = 0; c < LOGIC_COLS; c++)
          if (!this._inMask(layer, r, c)) {
            const cell = (buf[r] as LayerCell[])[c];
            if (cell) cell.on = false;
          }
      composite(frame, buf, layer.blend || 'replace', layer.opacity ?? 255);
    }
    this.prevKeyDown = keyDown;
    this.lastTick = tick;
    return frame;
  }

  renderLayer(layer: NormalizedLayer, tick: number, io: RenderIo, buf: LayerBuffer, layerIndex = 0): void {
    const ctx: RenderContext = {
      tick,
      rng: this.layerRngs[layerIndex] ?? this.rng,
      seed: this.program.seed || 1,
      layerSalt: sparkleIdHash(layer.id || ''),
    };
    const comp = layer.component;
    if (usesExtendedSpectrum(layer)) return this.renderSpectrumV14(layer, ctx, io, buf, layerIndex);
    switch (comp) {
      case 'static':
        return renderStaticLayer(layer, ctx, buf);
      case 'gradient':
        return renderGradientLayer(layer, ctx, buf);
      case 'breath':
        return renderBreathLayer(layer, ctx, buf);
      case 'blink':
        return renderBlinkLayer(layer, ctx, buf);
      case 'rainbow_wave':
        return renderRainbowWaveLayer(layer, ctx, buf);
      case 'wave':
        return renderWaveLayer(layer, ctx, buf);
      case 'scroll':
        return renderScrollLayer(layer, ctx, buf);
      case 'drift':
        return this.renderDrift(layer, ctx, buf);
      case 'ring':
        return this.renderRing(layer, ctx, buf);
      case 'key_ring':
        return this.renderKeyRing(layer, ctx, io, buf, layerIndex);
      case 'key_burst':
        return this.renderKeyBurst(layer, ctx, io, buf, layerIndex);
      case 'rain':
        return this.renderRain(layer, ctx, buf, layerIndex);
      case 'block_stack':
        return this.renderBlockStack(layer, ctx, buf, layerIndex);
      case 'mote':
        return this.renderMote(layer, ctx, buf);
      case 'spiral':
        return renderSpiralLayer(layer, ctx, buf);
      case 'sparkle':
        return this.renderSparkle(layer, ctx, buf);
      case 'reactive':
        return this.renderReactive(layer, ctx, io, buf, layerIndex);
      case 'fire':
        return this.renderFire(layer, ctx, buf, layerIndex);
      case 'ripple':
      case 'ripple_square':
        return this.renderRipple(layer, ctx, io, buf, layerIndex);
      case 'aurora':
        return this.renderAurora(layer, ctx, io, buf, layerIndex);
      case 'spectrum':
        return this.renderSpectrum(layer, ctx, io, buf, layerIndex);
      case 'spectrum_mirror':
        return this.renderSpectrumMirror(layer, ctx, io, buf, layerIndex);
      case 'spectrum_sum':
        return this.renderSpectrumSum(layer, ctx, io, buf, layerIndex);
      case 'key_tint':
        return this.renderKeyTint(layer, ctx, io, buf);
      case 'frame_sequence':
        return this.renderFrameSequence(layer, ctx, buf);
      default:
        return; // unknown component -> skip (degradation)
    }
  }

  renderRain(layer: NormalizedLayer, ctx: RenderContext, buf: LayerBuffer, layerIndex: number): void {
    if (this.rainEpoch[layerIndex] === null) this.rainEpoch[layerIndex] = ctx.tick;
    // Reason: the epoch was just initialised for this layer index.
    const tick = (ctx.tick - (this.rainEpoch[layerIndex] as number)) >>> 0;
    // Reason: rain reads only the rain-model params, all validated.
    const p = (layer.params || {}) as RainParams;
    const rain = rainGeometry(this.geometry);
    const events = rainEvents(tick, this.program.seed || 1, p, rain);
    // Reason: rain requires exactly five gradient stops (validate ensures it).
    const [left, right, rgb, nightColor, rainColor] = (layer.color as { colors: Rgb[] }).colors as [
      Rgb,
      Rgb,
      Rgb,
      Rgb,
      Rgb,
    ];
    for (const [r, c] of layer.cells) {
      // Reason: r and c are logical grid indices, always inside the LED table.
      const [x, y] = (this.geometry.ledPositions[r] as readonly BoardCell[])[c] as BoardCell;
      if (x === 255) continue;
      const sample = rainSample(x, y, tick, events, r, c, rain);
      const level = Math.floor(sample.level / 10);
      {
        const pos = Math.max(0, Math.min(rain.width, x - rain.originX));
        let fade = 1000;
        if (tick < 1470) {
          const lane = Math.max(0, Math.min(rain.count - 1, Math.floor((x - rain.originX + 4) / 8)));
          const delay = rainHash(this.program.seed || 1, lane) % 451;
          const fall = 380 + (rainHash((this.program.seed || 1) ^ lane, 32) % 141);
          const arrival =
            delay + Math.floor((fall * Math.max(0, Math.min(rain.height, y - rain.minY))) / rain.height);
          fade = Math.max(0, Math.min(1000, Math.floor(((tick - arrival) * 1000) / 500)));
        }
        const breath =
          84 + Math.floor(((cosAt(phaseS(tick, layer.time?.period_ms || 4000)) + 1000) * 16) / 2000);
        const drizzleMix = Math.max(0, Math.min(1000, Math.floor(((tick - 1500) * 1000) / 300)));
        const drizzleColor: Rgb = sample.accent ? rainColor : [210, 235, 255];
        const nightStart = 1800,
          transition = 1500;
        const nightMix =
          tick <= nightStart
            ? 0
            : tick >= nightStart + transition
              ? 1000
              : Math.floor(((tick - nightStart) * 1000) / transition);
        const night = 100 - Math.floor((nightMix * (100 - (layer.time?.min_level ?? 23))) / 1000);
        // Reason: mapping the three channels of an RGB triple keeps three entries.
        const channels = rgb.map((head, i) => {
          // Reason: i is an RGB channel index 0..2, inside each stop triple.
          const original = Math.floor(
            ((left[i] as number) * (rain.width - pos) + (right[i] as number) * pos) / rain.width,
          );
          // Reason: i is an RGB channel index 0..2, inside each stop triple.
          const base = Math.floor(
            (original * (1000 - nightMix) + (nightColor[i] as number) * nightMix) / 1000,
          );
          const background = Math.floor(
            (Math.floor((Math.floor((base * breath) / 100) * fade) / 1000) * night) / 100,
          );
          const shade = 100 - Math.floor((level * drizzleMix * 30) / 100000);
          const adjusted = Math.floor((background * shade) / 100);
          // Reason: i is an RGB channel index 0..2, inside the drizzle triple.
          const tint = Math.floor(
            (head * (1000 - drizzleMix) + (drizzleColor[i] as number) * drizzleMix) / 1000,
          );
          const alpha = level + Math.floor((level * (100 - level) * drizzleMix * 50) / 10000000);
          return Math.floor((adjusted * (100 - alpha) + tint * alpha) / 100);
        }) as Rgb;
        // Reason: r and c come from the layer's cell list, always inside the buffer.
        (buf[r] as LayerCell[])[c] = { r: channels[0], g: channels[1], b: channels[2], l: 100, on: true };
      }
    }
  }

  _stepFromSpeed(speed?: number): number {
    // speed 0..4 -> larger = faster; interval in ticks
    const table = [20, 15, 5, 3, 1];
    // Reason: the clamped speed index is always 0..4, inside the table.
    return table[Math.max(0, Math.min(4, speed ?? 2))] as number;
  }

  // legacy per-effect interval tables (ms per step, speed level 0..4), mirror
  // of the reference LEP program semantics
  _legacyInterval(table: number[], speed?: number): number {
    // Reason: every interval table has five entries for speeds 0..4.
    return table[Math.max(0, Math.min(4, speed ?? 2))] as number;
  }

  _auroraInterval(speed?: number): number {
    return this._legacyInterval([100, 50, 20, 15, 10], speed);
  }
  _rippleInterval(speed?: number): number {
    return this._legacyInterval([200, 150, 100, 50, 30], speed);
  }
  _rippleSquareInterval(speed?: number): number {
    return this._legacyInterval([120, 90, 70, 50, 30], speed);
  }

  renderDrift(layer: NormalizedLayer, ctx: RenderContext, buf: LayerBuffer): void {
    // Reason: validated layer params; only the typed fields below are read.
    const p = (layer.params || {}) as RenderParams;
    const period = Math.max(1, p.period_ms ?? 18000);
    const count = Math.max(1, Math.min(8, p.count ?? 5));
    const size = Math.max(1, Math.min(3, p.size ?? 2));
    const wobble = Math.max(0, Math.min(2, p.wobble ?? 1));
    const reverse = p.direction === 'reverse';
    const motion = p.motion === 'vertical' ? 1 : p.motion === 'both' ? 2 : 0;
    const seed = this.program.seed || 1;
    const phase = phaseS(ctx.tick, period);
    const spanX = LOGIC_COLS + size * 2;
    const spanY = LOGIC_ROWS + size * 2;
    const wrapRows = motion !== 0;
    let fade = 100;
    const timing = layer.time || {};
    if (timing.type === 'breath') {
      const breathPeriod = Math.max(1, timing.period_ms ?? DRIFT_BREATH_PERIOD_MS);
      const s = phaseS(ctx.tick, breathPeriod, timing.phase_ms ?? 0);
      fade = 45 + Math.floor((55 * Math.floor((1000 - cosAt(s)) / 2)) / 1000);
    }
    for (let i = 0; i < count; i++) {
      let ph = (phase + i * 137) % 1000;
      if (reverse) ph = (1000 - ph) % 1000;
      const fixedCol = (i * 5 + (seed % LOGIC_COLS)) % LOGIC_COLS;
      const fixedRow = (i * 2 + (seed % LOGIC_ROWS)) % LOGIC_ROWS;
      const x1000 = motion === 1 ? fixedCol * 1000 + 500 : ph * spanX;
      let y1000 = motion === 0 ? fixedRow * 1000 + 500 : fixedRow * 1000 + 500 + ph * spanY;
      if (wobble) {
        const wobbleSine = Math.floor((1000 - cosAt((ph + i * 211 + 500) % 1000)) / 2);
        y1000 += (wobbleSine - 500) * wobble * 2;
      }
      const radius = size * 1000;
      const extent = size + 1;
      const centerCol = Math.floor(x1000 / 1000);
      const centerRow = Math.floor(y1000 / 1000);
      for (let rr = centerRow - extent; rr <= centerRow + extent; rr++) {
        if (!wrapRows && (rr < 0 || rr >= LOGIC_ROWS)) continue;
        const row = ((rr % LOGIC_ROWS) + LOGIC_ROWS) % LOGIC_ROWS;
        for (let cc = centerCol - extent; cc <= centerCol + extent; cc++) {
          const col = ((cc % LOGIC_COLS) + LOGIC_COLS) % LOGIC_COLS;
          let dx = col * 1000 + 500 - x1000;
          const spanCols = LOGIC_COLS * 1000;
          dx = ((dx % spanCols) + spanCols) % spanCols;
          if (dx * 2 > spanCols) dx -= spanCols;
          let dy = row * 1000 + 500 - y1000;
          if (wrapRows) {
            const spanRows = LOGIC_ROWS * 1000;
            dy = ((dy % spanRows) + spanRows) % spanRows;
            if (dy * 2 > spanRows) dy -= spanRows;
          }
          const dist = Math.floor(Math.sqrt(dx * dx + dy * dy));
          if (dist >= radius + 1000) continue;
          const level = Math.floor(
            ((dist <= radius ? 100 : Math.floor((100 * (radius + 1000 - dist)) / 1000)) * fade) / 100,
          );
          if (!level || !this._inMask(layer, row, col)) continue;
          const rgb: Rgb = layer.color ? resolveColor(layer.color, { ...ctx, row, col }) : [120, 255, 120];
          // Reason: row and col are wrapped into the logical grid above.
          (buf[row] as LayerCell[])[col] = { r: rgb[0], g: rgb[1], b: rgb[2], l: level, on: true };
        }
      }
    }
  }

  renderRing(layer: NormalizedLayer, ctx: RenderContext, buf: LayerBuffer): void {
    // Reason: validated layer params; only the typed fields below are read.
    const p = (layer.params || {}) as RenderParams;
    const period = Math.max(1, p.period_ms ?? 1600);
    const life = Math.max(1, p.life_ms ?? 4500);
    const maxR = Math.max(1, Math.min(8, p.max_radius ?? 4));
    const width = Math.max(1, Math.min(3, p.width ?? 1));
    const reverse = p.direction === 'reverse';
    // Reason: only some ColorSpec variants carry custom palette stops.
    const pal = resolvePalette(p.palette ?? 'rainbow24', (layer.color as { colors?: Rgb[] } | null)?.colors);
    const seed = this.program.seed || 1;
    const end = Math.floor(ctx.tick / period);
    let start = Math.floor((ctx.tick - life) / period);
    if (start < 0) start = 0;
    if (end - start > 16) start = end - 16;
    for (let n = start; n <= end; n++) {
      const age = ctx.tick - n * period;
      if (age < 0 || age >= life) continue;
      const h = ringHash(seed, n);
      const cr = (h >>> 8) % LOGIC_ROWS;
      const cc = (h >>> 16) % LOGIC_COLS;
      const radius = reverse
        ? Math.floor((maxR * (life - age) * 1000) / life)
        : Math.floor((maxR * age * 1000) / life);
      const fade = Math.max(0, Math.floor((100 * (life - age)) / life));
      if (!fade) continue;
      const edge = width * 1000;
      const rgb: Rgb = layer.color
        ? resolveColor(layer.color, { ...ctx, row: cr, col: cc })
        : // Reason: resolvePalette always returns a non-empty palette.
          (pal[n % pal.length] as Rgb);
      for (const [r, c] of layer.cells) {
        const dr = r - cr;
        const dc = c - cc;
        const dist = Math.floor(Math.sqrt((dr * dr + dc * dc) * 1000000));
        const band = Math.abs(dist - radius);
        if (band >= edge) continue;
        const level = Math.floor((fade * (edge - band)) / edge);
        if (!level) continue;
        if (!this._inMask(layer, r, c)) continue;
        // Reason: r and c come from the layer's cell list, always inside the buffer.
        (buf[r] as LayerCell[])[c] = { r: rgb[0], g: rgb[1], b: rgb[2], l: level, on: true };
      }
    }
  }

  private maskedKeyCandidates(layer: NormalizedLayer): Array<[number, number]> {
    return collectMaskedKeys(
      LOGIC_ROWS,
      LOGIC_COLS,
      (r, c) => ((this.geometry.keyCentres[r] as readonly BoardCell[])[c] as BoardCell)[0] !== 255,
      (r, c) => this._inMask(layer, r, c),
    );
  }

  private pickAudioOrigin(
    layer: NormalizedLayer,
    ctx: RenderContext,
    seq: number,
  ): [number, number] | 'center' {
    const origin = String(
      (layer.params as RenderParams)?.origin ??
        (layer.component === 'key_burst' ? 'board_center' : 'event_key'),
    );
    if (origin === 'random_key') {
      const picked = pickRandomMaskedKey(
        this.program.seed || 1,
        sparkleIdHash(layer.id || ''),
        ctx.tick,
        seq,
        this.maskedKeyCandidates(layer),
      );
      if (picked) return picked;
    }
    return 'center';
  }

  private audioSlot(instances: ({ born: number } | null)[], limit: number): number {
    let oldest = 0;
    for (let i = 0; i < limit; i++) {
      const instance = instances[i];
      if (!instance) return i;
      if (instance.born < (instances[oldest]?.born ?? instance.born)) oldest = i;
    }
    return oldest;
  }

  renderKeyRing(
    layer: NormalizedLayer,
    ctx: RenderContext,
    io: RenderIo,
    buf: LayerBuffer,
    layerIndex: number,
  ): void {
    // Reason: validated layer params; only the typed fields below are read.
    const p = (layer.params || {}) as RenderParams;
    const life = Math.max(1, p.life_ms ?? 1400);
    const audio = layer.playback?.start === 'audio_onset';
    // Upstream lepc extendedKeyRing: the extended controls apply to key presses and
    // audio onsets alike.
    const extended =
      (p.origin ?? 'event_key') !== 'event_key' ||
      layer.color?.type === 'ramp' ||
      Number(p.max_radius ?? 4) > 8 ||
      (p.envelope ?? 'fade_out') !== 'fade_out';
    const maxR = Math.max(1, Math.min(extended ? 22 : 8, p.max_radius ?? 4));
    const edge = Math.max(1, Math.min(3, p.width ?? 1)) * 1000;
    const limit = Math.max(1, Math.min(8, p.max_waves ?? 8));
    // Reason: layerIndex is below the eight per-layer state slots.
    const state = this.keyRings[layerIndex] as KeyRingState;
    if (!audio)
      for (let i = 0; i < 8; i++) {
        // Reason: i is below the eight ring slots.
        const ring = state.rings[i] as KeyRing | null;
        if (ring && ctx.tick - ring.born >= life) state.rings[i] = null;
      }
    const pressed = (io.keyPressedEvents || [])
      // Reason: a cell string is "row,col"; its first two entries are indices.
      .map((ev) => ({ cell: ev.cell.split(',').map(Number) as [number, number], t: ev.t }))
      .filter(
        ({ cell: [r, c] }) =>
          Number.isInteger(r) &&
          Number.isInteger(c) &&
          r >= 0 &&
          r < LOGIC_ROWS &&
          c >= 0 &&
          c < LOGIC_COLS &&
          this._inMask(layer, r, c),
      )
      .map((ev) => ({ r: ev.cell[0], c: ev.cell[1], t: ev.t }))
      .sort((a, b) => a.t - b.t || a.c - b.c || a.r - b.r);
    if (audio) {
      for (const born of io.audioOnsets ?? []) {
        for (let i = 0; i < limit; i++) {
          const ring = state.rings[i];
          if (ring && born - ring.born >= life) state.rings[i] = null;
        }
        const seq = state.sequence++;
        const origin = this.pickAudioOrigin(layer, { ...ctx, tick: born } as RenderContext, seq);
        const [rr, cc] = origin === 'center' ? [2.5, 10.5] : origin;
        state.rings[this.audioSlot(state.rings, limit)] = { r: rr, c: cc, born, seq };
      }
    }
    for (const { r, c, t } of audio ? [] : pressed) {
      // The keyboard retires expired rings in the millisecond of the press.
      for (let k = 0; k < 8; k++) {
        // Reason: k is below the eight ring slots.
        const ring = state.rings[k] as KeyRing | null;
        if (ring && t - ring.born >= life) state.rings[k] = null;
      }
      const i = state.rings.findIndex((ring, index) => index < limit && !ring);
      // board_center: every press starts a ring at the board centre.
      const [rr, cc] = p.origin === 'board_center' ? [2.5, 10.5] : [r, c];
      if (i >= 0) state.rings[i] = { r: rr, c: cc, born: t, seq: state.sequence++ };
    }
    const pal =
      layer.color?.type === 'ramp' && layer.color.colors
        ? layer.color.colors
        : resolvePalette(p.palette ?? 'rainbow24');
    for (const ring of state.rings) {
      if (!ring || ctx.tick - ring.born >= life) continue;
      const age = ctx.tick - ring.born;
      const radius = Math.floor((maxR * (p.direction === 'reverse' ? life - age : age) * 1000) / life);
      const fade =
        extended && p.envelope === 'constant'
          ? 100
          : extended && p.envelope === 'fade_in'
            ? Math.floor((100 * age) / life)
            : extended && p.envelope === 'fade_in_out'
              ? Math.floor((200 * Math.min(age, life - age)) / life)
              : Math.floor((100 * (life - age)) / life);
      const rgb: Rgb =
        layer.color?.type === 'solid'
          ? // Reason: solid colors ignore row/col, so the render ctx suffices.
            resolveColor(layer.color, ctx as unknown as ColorContext)
          : (pal[ring.seq % pal.length] as Rgb);
      for (const [r, c] of layer.cells) {
        const dr = r - ring.r,
          dc = c - ring.c;
        const band = Math.abs(Math.floor(Math.sqrt((dr * dr + dc * dc) * 1000000)) - radius);
        if (band >= edge) continue;
        const level = Math.floor((fade * (edge - band)) / edge);
        const ax = Math.abs(dc),
          ay = Math.abs(dr),
          hi = Math.max(ax, ay),
          lo = Math.min(ax, ay);
        let angle = hi
          ? Math.round((Math.atan(Math.floor((lo * 256 + hi / 2) / hi) / 256) * 500) / Math.PI)
          : 0;
        if (ay > ax) angle = 250 - angle;
        if (dc < 0) angle = 500 - angle;
        if (dr < 0) angle = 1000 - angle;
        angle %= 1000;
        const color =
          extended && layer.color?.type === 'ramp' ? rampColor([...pal, pal[0] ?? rgb], angle) : rgb;
        if (level > 0)
          // Reason: r and c come from the layer's cell list, always inside the buffer.
          (buf[r] as LayerCell[])[c] = { r: color[0], g: color[1], b: color[2], l: level, on: true };
      }
    }
  }

  renderKeyBurst(
    layer: NormalizedLayer,
    ctx: RenderContext,
    io: RenderIo,
    buf: LayerBuffer,
    layerIndex: number,
  ): void {
    // Reason: validated layer params; only the typed fields below are read.
    const p = (layer.params || {}) as RenderParams,
      // Reason: layerIndex is below the eight per-layer state slots.
      state = this.keyBursts[layerIndex] as KeyBurstState;
    const life = p.life_ms ?? 1600,
      maxRadius = (p.max_radius ?? 6) * 1000;
    const width = (p.width_tenths ?? 15) * 100,
      soft = Math.min(width, (p.softness_tenths ?? 10) * 100);
    const trail = p.afterglow_ms ?? 800,
      flashMs = p.flash_ms ?? 80,
      limit = p.max_bursts ?? 4;
    const fromAudio = layer.playback?.start === 'audio_onset';
    if (!fromAudio)
      for (let i = 0; i < 8; i++) {
        // Reason: i is below the eight burst slots.
        const burst = state.bursts[i] as KeyBurst | null;
        if (burst && ctx.tick - burst.born >= life) state.bursts[i] = null;
      }
    // v15 policy (all package versions): every burst flashes; no per-second cap.
    if (fromAudio) {
      for (const born of io.audioOnsets ?? []) {
        for (let i = 0; i < limit; i++) {
          const instance = state.bursts[i];
          if (instance && born - instance.born >= life) state.bursts[i] = null;
        }
        const flash = flashMs > 0;
        const seq = state.sequence++;
        const origin = this.pickAudioOrigin(layer, { ...ctx, tick: born } as RenderContext, seq);
        // board_center: off-grid (-1,-1) keeps the centre flash off every key, matching lepc.
        // random_key: real key so rays and optional centre flash sit on a masked key.
        const [rr, cc] = origin === 'center' ? [-1, -1] : origin;
        state.bursts[this.audioSlot(state.bursts, limit)] = {
          r: rr,
          c: cc,
          born,
          seq,
          flash,
        };
      }
    }
    const pressed = (io.keyPressedEvents || [])
      // Reason: a cell string is "row,col"; its first two entries are indices.
      .map((ev) => ({ cell: ev.cell.split(',').map(Number) as [number, number], t: ev.t }))
      .filter(
        ({ cell: [r, c] }) =>
          Number.isInteger(r) &&
          Number.isInteger(c) &&
          r >= 0 &&
          r < LOGIC_ROWS &&
          c >= 0 &&
          c < LOGIC_COLS &&
          // Reason: r and c are logical grid indices, always inside the table.
          ((this.geometry.keyCentres[r] as readonly BoardCell[])[c] as BoardCell)[0] !== 255 &&
          this._inMask(layer, r, c),
      )
      .map((ev) => ({ r: ev.cell[0], c: ev.cell[1], t: ev.t }))
      .sort((a, b) => a.t - b.t || a.c - b.c || a.r - b.r);
    for (const { r, c, t } of fromAudio ? [] : pressed) {
      // The keyboard retires expired bursts in the millisecond of the press.
      for (let k = 0; k < 8; k++) {
        // Reason: k is below the eight burst slots.
        const burst = state.bursts[k] as KeyBurst | null;
        if (burst && t - burst.born >= life) state.bursts[k] = null;
      }
      let i = state.bursts.findIndex((b, index) => index < limit && !b);
      if (i < 0) {
        // Replace the oldest burst; on a tie the lowest slot, as the firmware does.
        i = 0;
        for (let j = 1; j < limit; j++) {
          // Reason: findIndex failed, so every slot below limit is occupied.
          if ((state.bursts[j] as KeyBurst).born < (state.bursts[i] as KeyBurst).born) i = j;
        }
      }
      const flash = flashMs > 0;
      state.bursts[i] = { r, c, born: t, seq: state.sequence++, flash };
    }
    const pal = resolvePalette(p.palette ?? 'rainbow24');
    for (const burst of state.bursts) {
      if (!burst || ctx.tick - burst.born >= life) continue;
      const age = ctx.tick - burst.born;
      const growth = Math.max(1, life - Math.min(trail, Math.floor(life / 2)));
      const radius = Math.floor((Math.min(age, growth) * maxRadius) / growth);
      const fade = Math.floor((100 * (life - age)) / life);
      // Reason: burst coordinates are valid logical cells in the key table.
      const originMode = String(p.origin ?? 'board_center');
      const [ox, oy] =
        fromAudio && (originMode !== 'random_key' || burst.r < 0 || burst.c < 0 || !Number.isInteger(burst.r))
          ? audioBurstCentre(this.geometry)
          : ((this.geometry.keyCentres[burst.r] as readonly BoardCell[])[burst.c] as BoardCell);
      // Reason: solid colors ignore row/col, so the render ctx suffices.
      const solid =
        layer.color?.type === 'solid' ? resolveColor(layer.color, ctx as unknown as ColorContext) : null;
      for (const [r, c] of layer.cells) {
        // Reason: r and c come from the layer's cell list, inside the key table.
        const [x, y] = (this.geometry.keyCentres[r] as readonly BoardCell[])[c] as BoardCell;
        if (x === 255) continue;
        const dx = x - ox,
          dy = y - oy,
          bound = Math.ceil((radius + width) / 125);
        if (dx * dx + dy * dy > bound * bound) continue;
        const dist = Math.floor(Math.sqrt((dx * dx + dy * dy) * 15625));
        const band = Math.abs(dist - radius);
        let level = 0;
        if (band < width)
          level = soft > 0 && band > width - soft ? Math.floor((fade * (width - band)) / soft) : fade;
        if (trail > 0 && radius >= dist) {
          const crossed = Math.floor((dist * growth) / maxRadius),
            since = age - crossed;
          if (since >= 0 && since < trail) {
            const phase = (age + r * 17 + c * 29 + (burst.seq % 500) * 43) % 500;
            const wave = phase < 250 ? phase : 500 - phase;
            const twinkle = 20 + Math.floor((wave * 80) / 250);
            const envelope = 100 - Math.floor((since * since * 100) / (trail * trail));
            const glow = Math.floor((envelope * twinkle) / 100);
            level = dist + Math.floor(width / 2) < radius ? glow : Math.max(level, glow);
          }
        }
        const ax = Math.abs(dx),
          ay = Math.abs(dy),
          cross = Math.min(ax, ay, Math.abs(ax - ay));
        const ray = Math.max(0, 100 - cross * 25);
        level = Math.floor((level * (25 + Math.floor((ray * 75) / 100))) / 100);
        if (flashMs > 0 && age < flashMs) level = Math.floor((level * age) / flashMs);
        const centreFlash = burst.flash && r === burst.r && c === burst.c && age < flashMs;
        if (centreFlash) level = Math.max(level, Math.floor((100 * (flashMs - age)) / flashMs));
        if (level <= 0) continue;
        const rayIndex =
          ax > ay * 2
            ? dx >= 0
              ? 0
              : 4
            : ay > ax * 2
              ? dy >= 0
                ? 2
                : 6
              : dx >= 0
                ? dy >= 0
                  ? 1
                  : 7
                : dy >= 0
                  ? 3
                  : 5;
        const rgb: Rgb = centreFlash
          ? [255, 255, 255]
          : // Reason: resolvePalette always returns a non-empty palette.
            solid || (pal[(burst.seq * 3 + rayIndex * 3) % pal.length] as Rgb);
        // Reason: r and c come from the layer's cell list, always inside the buffer.
        (buf[r] as LayerCell[])[c] = { r: rgb[0], g: rgb[1], b: rgb[2], l: level, on: true };
      }
    }
  }

  renderBlockStack(layer: NormalizedLayer, ctx: RenderContext, buf: LayerBuffer, layerIndex: number): void {
    // Reason: validated layer params; only the typed fields below are read.
    const p = (layer.params || {}) as RenderParams,
      // Reason: layerIndex is below the eight per-layer state slots.
      state = this.blockStacks[layerIndex] as BlockStackState;
    const slot = Math.floor(ctx.tick / Math.max(1, p.step_ms ?? 450));
    let steps = state.slot === null ? 1 : Math.min(64, Math.max(0, slot - state.slot));
    state.slot = slot;
    const fits = (piece: BlockPiece, row: number): boolean =>
      // Reason: shape is 0..6 by construction, inside the block-shape table.
      (BLOCK_SHAPES[piece.shape] as BoardCell[]).every(([dr, dc]) => {
        const r = row + dr,
          c = piece.col + dc;
        // Reason: r and c are logical grid indices, inside the grid.
        return r >= 0 && r < LOGIC_ROWS && c >= 0 && c < LOGIC_COLS && !(state.grid[r] as number[])[c];
      });
    while (steps-- > 0) {
      if (!state.piece) {
        const hash = ringHash((this.program.seed ^ sparkleIdHash(layer.id || '')) >>> 0, state.sequence++);
        const shape = hash % 7,
          // Reason: shape is 0..6 by construction, inside the block-shape table.
          width = Math.max(...(BLOCK_SHAPES[shape] as BoardCell[]).map(([, c]) => c)) + 1;
        state.piece = { shape, col: (hash >>> 8) % (LOGIC_COLS - width + 1), row: 0 };
        if (!fits(state.piece, 0)) for (const row of state.grid) row.fill(0);
      }
      const piece = state.piece;
      if (fits(piece, piece.row + 1)) piece.row++;
      else {
        // Reason: shape is 0..6 by construction, inside the block-shape table.
        for (const [dr, dc] of BLOCK_SHAPES[piece.shape] as BoardCell[])
          // Reason: the piece is kept inside the grid by `fits` above.
          (state.grid[piece.row + dr] as number[])[piece.col + dc] = piece.shape + 1;
        for (let row = LOGIC_ROWS - 1; row >= 0; row--)
          // Reason: row is a logical row index, inside the grid.
          if ((state.grid[row] as number[]).every(Boolean)) {
            state.grid.splice(row, 1);
            state.grid.unshift(new Array(LOGIC_COLS).fill(0));
            row++;
          }
        state.piece = null;
      }
    }
    const pal = resolvePalette(p.palette ?? 'seven');
    const putCell = (r: number, c: number, shape: number): void => {
      if (!this._inMask(layer, r, c)) return;
      const rgb: Rgb =
        layer.color?.type === 'solid'
          ? // Reason: solid colors ignore row/col, so the render ctx suffices.
            resolveColor(layer.color, ctx as unknown as ColorContext)
          : (pal[shape % pal.length] as Rgb);
      // Reason: r and c are logical grid indices, always inside the buffer.
      (buf[r] as LayerCell[])[c] = { r: rgb[0], g: rgb[1], b: rgb[2], l: 100, on: true };
    };
    for (let r = 0; r < LOGIC_ROWS; r++)
      for (let c = 0; c < LOGIC_COLS; c++)
        // Reason: r and c are logical grid indices, inside the grid.
        if ((state.grid[r] as number[])[c]) putCell(r, c, ((state.grid[r] as number[])[c] as number) - 1);
    if (state.piece)
      // Reason: shape is 0..6 by construction, inside the block-shape table.
      for (const [dr, dc] of BLOCK_SHAPES[state.piece.shape] as BoardCell[])
        putCell(state.piece.row + dr, state.piece.col + dc, state.piece.shape);
  }

  renderMote(layer: NormalizedLayer, ctx: RenderContext, buf: LayerBuffer): void {
    // Reason: validated layer params; only the typed fields below are read.
    const p = (layer.params || {}) as RenderParams;
    const period = Math.max(1, p.period_ms ?? 24000);
    const count = Math.max(1, Math.min(24, p.count ?? 12));
    const size = Math.max(1, Math.min(2, p.size ?? 1));
    const motion = p.motion === 'horizontal' ? 0 : p.motion === 'vertical' ? 1 : 2;
    const reverse = p.direction === 'reverse';
    // Reason: only some ColorSpec variants carry custom palette stops.
    const pal = resolvePalette(p.palette ?? 'rainbow24', (layer.color as { colors?: Rgb[] } | null)?.colors);
    const seed = this.program.seed || 1;
    const phase = phaseS(ctx.tick, period);
    const radius = size * 1000;
    for (let i = 0; i < count; i++) {
      let px = (phase + i * 137 + (seed % 1000)) % 1000;
      // Unsigned shift: the firmwares hold the seed as a u32 (seeds >= 2^31 included).
      let py = (phase + i * 251 + ((seed >>> 8) % 1000)) % 1000;
      if (reverse) {
        px = (1000 - px) % 1000;
        py = (1000 - py) % 1000;
      }
      const fixedRow = (i * 2 + (seed % 3)) % LOGIC_ROWS;
      const fixedCol = (i * 5 + (seed % LOGIC_COLS)) % LOGIC_COLS;
      const x1000 = motion === 1 ? fixedCol * 1000 + 500 : Math.floor((px * (LOGIC_COLS * 1000 - 1)) / 1000);
      const y1000 = motion === 0 ? fixedRow * 1000 + 500 : Math.floor((py * (LOGIC_ROWS * 1000 - 1)) / 1000);
      for (const [r, c] of layer.cells) {
        const dx = c * 1000 + 500 - x1000;
        const dy = r * 1000 + 500 - y1000;
        const dist = Math.floor(Math.sqrt(dx * dx + dy * dy));
        if (dist >= radius + 1000) continue;
        const level = dist <= radius ? 100 : Math.floor((100 * (radius + 1000 - dist)) / 1000);
        if (level <= 0 || !this._inMask(layer, r, c)) continue;
        const rgb: Rgb = layer.color
          ? resolveColor(layer.color, { ...ctx, row: r, col: c })
          : // Reason: resolvePalette always returns a non-empty palette.
            (pal[i % pal.length] as Rgb);
        // Reason: r and c come from the layer's cell list, always inside the buffer.
        (buf[r] as LayerCell[])[c] = { r: rgb[0], g: rgb[1], b: rgb[2], l: level, on: true };
      }
    }
  }

  renderSparkle(layer: NormalizedLayer, ctx: RenderContext, buf: LayerBuffer): void {
    if (!isTimeSparkle(layer)) return;
    // Reason: validated layer params; only the typed fields below are read.
    const palette = resolvePalette((layer.params as RenderParams | undefined)?.palette ?? 'rainbow24');
    for (const e of timeSparkleEvents(layer, ctx.tick, this.program.seed)) {
      // Reason: sparkle events index a cell that already exists in the layer.
      const [r, c] = layer.cells[e.index] as [number, number];
      // Reason: only the solid color variant carries a direct rgb triple; the
      // palette index is always inside the palette.
      const rgb = (layer.color as { rgb?: Rgb } | null)?.rgb ?? (palette[e.colorIndex] as Rgb);
      // Reason: r and c are a sparkle event's cell, always inside the buffer.
      if (e.level > ((buf[r] as LayerCell[])[c] as LayerCell).l) {
        // Reason: r and c are a sparkle event's cell, always inside the buffer.
        (buf[r] as LayerCell[])[c] = { r: rgb[0], g: rgb[1], b: rgb[2], l: e.level, on: true };
      }
    }
  }

  renderFire(layer: NormalizedLayer, ctx: RenderContext, buf: LayerBuffer, layerIndex: number): void {
    const state = (this.fireStates[layerIndex] ??= new FireState(
      this.program.seed,
      (sparkleIdHash(layer.id || '') - 1) >>> 0,
    ));
    const heat = state.update(ctx.tick, layer.cells, layer.params);
    // Reason: only the ramp colour carries custom stops.
    const custom = (layer.color as { colors?: Rgb[] } | null)?.colors;
    const colors = custom && custom.length >= 2 ? custom : (FIRE_COLORS as Rgb[]);
    for (const [r, c] of layer.cells) {
      // Reason: r and c are logical grid indices, always inside the heat field.
      const phase = Math.floor(((heat[r * LOGIC_COLS + c] as number) * 1000) / 255);
      const rgb = rampColor(
        colors,
        phase,
        layer.color && 'stops' in layer.color ? layer.color.stops : undefined,
      );
      const alphas = layer.color && 'alphas' in layer.color ? layer.color.alphas : undefined;
      // Reason: r and c come from the layer's cell list, always inside the buffer.
      (buf[r] as LayerCell[])[c] = {
        r: rgb[0],
        g: rgb[1],
        b: rgb[2],
        l: 100,
        on: true,
        ...(alphas
          ? {
              a: rampAlpha(
                alphas,
                phase,
                false,
                layer.color && 'stops' in layer.color ? layer.color.stops : undefined,
              ),
            }
          : {}),
      };
    }
  }

  // Lifecycle mode: each pressed key plays the colour ramp once over
  // duration_ms, then goes dark. A new press restarts that key.
  renderReactiveLifecycle(
    layer: NormalizedLayer,
    ctx: RenderContext,
    io: RenderIo,
    buf: LayerBuffer,
    layerIndex: number,
  ): void {
    // Reason: validated layer params; only the typed fields below are read.
    const p = (layer.params || {}) as RenderParams;
    const duration = Math.max(1, p.duration_ms ?? 1000);
    // Reason: one map exists per layer.
    const born = this.lifecycleBorn[layerIndex] as Map<string, number>;
    for (const ev of io.keyPressedEvents || []) born.set(ev.cell, ev.t);
    // Reason: only the ramp colour carries custom stops.
    const custom = (layer.color as { colors?: Rgb[] } | null)?.colors;
    const colors: Rgb[] = custom && custom.length ? custom : [[255, 255, 255]];
    const live = new Set<string>();
    for (const [r, c] of layer.cells) {
      const key = `${r},${c}`;
      const t = born.get(key);
      if (t === undefined) continue;
      const age = ctx.tick - t;
      if (age < 0 || age >= duration) continue;
      live.add(key);
      const phase = Math.floor((age * 1000) / duration);
      const rgb = rampColor(
        colors,
        phase,
        layer.color && 'stops' in layer.color ? layer.color.stops : undefined,
      );
      const alphas = layer.color && 'alphas' in layer.color ? layer.color.alphas : undefined;
      // Reason: r and c come from the layer's cell list, always inside the buffer.
      (buf[r] as LayerCell[])[c] = {
        r: rgb[0],
        g: rgb[1],
        b: rgb[2],
        l: 100,
        on: true,
        ...(alphas
          ? {
              a: rampAlpha(
                alphas,
                phase,
                false,
                layer.color && 'stops' in layer.color ? layer.color.stops : undefined,
              ),
            }
          : {}),
      };
    }
    for (const [key, t] of born) if (!live.has(key) && ctx.tick - t >= duration) born.delete(key);
  }

  renderReactive(
    layer: NormalizedLayer,
    ctx: RenderContext,
    io: RenderIo,
    buf: LayerBuffer,
    layerIndex = 0,
  ): void {
    // Reason: validated layer params; only the typed fields below are read.
    const p = (layer.params || {}) as RenderParams;
    if (p.color_mode === 'lifecycle') return this.renderReactiveLifecycle(layer, ctx, io, buf, layerIndex);
    const interval = this._stepFromSpeed(p.speed);
    const duration = interval * 100; // ms to fully fade
    void io; // presses were taken in _dispatchPresses
    // emit: envelope value = 1 - easing(progress)
    // Reason: one map exists per layer.
    const pressed = this.reactiveByLayer[layerIndex] as Map<string, ReactiveEntry>;
    for (const [k, v] of pressed) {
      const prog = Math.min(1000, Math.floor(((ctx.tick - v.born) * 1000) / duration));
      const level = Math.floor((1000 - easeAt(layer.lut, prog)) / 10);
      if (level <= 0) {
        pressed.delete(k);
        continue;
      }
      // Reason: a map key is "row,col"; its first two entries are indices.
      const [r, c] = k.split(',').map(Number) as [number, number];
      // Reason: r and c are logical grid indices, always inside the buffer.
      (buf[r] as LayerCell[])[c] = { r: v.rgb[0], g: v.rgb[1], b: v.rgb[2], l: level, on: true };
    }
  }

  // A ripple dot is active from its birth until the first interval boundary
  // where both fronts have left the grid; the boundary is stored so a dot can
  // retire even when no frame lands on it.
  _rippleDot(r: number, c: number, born: number, interval: number): RippleDot {
    // The firmware draws a dot before advancing it, so a boundary shows from the
    // next millisecond; the slot frees after the boundary where both fronts are out.
    const span = Math.max(c + 1, LOGIC_COLS - c);
    return { r, c, born, retirement: (Math.ceil(born / interval) + span) * interval };
  }

  _rippleRadius(dot: RippleDot, tick: number, interval: number): number {
    if (tick <= dot.born) return 0;
    return Math.max(0, Math.floor((tick - 1) / interval) - Math.floor((dot.born - 1) / interval));
  }

  renderRipple(
    layer: NormalizedLayer,
    ctx: RenderContext,
    io: RenderIo,
    buf: LayerBuffer,
    layerIndex = 0,
  ): void {
    // Reason: one slot array exists per layer.
    const slots = this.rippleSlotsByLayer[layerIndex] as (RippleDot | null)[];
    // Reason: validated layer params; only the typed fields below are read.
    const p = (layer.params || {}) as RenderParams;
    const square = layer.component === 'ripple_square' || p.direction === 'square';
    const speed = p.speed;
    const interval = square ? this._rippleSquareInterval(speed) : this._rippleInterval(speed);
    const pal = resolvePalette('seven');
    const layerColor = layer.color ? resolveColor(layer.color, { ...ctx, row: 0, col: 0 }) : null;
    const maxWaves = Math.max(1, Math.min(slots.length, p.max_waves ?? 10));
    for (const ev of io.keyPressedEvents || []) {
      // Reason: a cell string is "row,col"; its first two entries are indices.
      const [r, c] = ev.cell.split(',').map(Number) as [number, number];
      for (let i = 0; i < maxWaves; i++) {
        const rp = slots[i];
        if (!rp || rp.retirement < ev.t) {
          slots[i] = this._rippleDot(r, c, ev.t, interval);
          break;
        }
      }
    }
    // emit the time-derived ring of every active dot; nothing depends on how
    // many frames happened to render between two boundaries
    for (let i = 0; i < slots.length; i++) {
      const rp = slots[i];
      if (!rp) continue;
      if (ctx.tick > rp.retirement) {
        slots[i] = null;
        continue;
      }
      const dist = this._rippleRadius(rp, ctx.tick, interval);
      // Reason: resolvePalette always returns a non-empty palette.
      const color: Rgb = layerColor || (pal[dist % pal.length] as Rgb);
      const setCol = (col: number): void => {
        if (col < 0 || col >= LOGIC_COLS) return;
        for (let r = 0; r < LOGIC_ROWS; r++) {
          // Reason: r is a logical row and col was range-checked above.
          (buf[r] as LayerCell[])[col] = { r: color[0], g: color[1], b: color[2], l: 100, on: true };
        }
      };
      const setRow = (row: number): void => {
        if (row < 0 || row >= LOGIC_ROWS) return;
        for (let c = 0; c < LOGIC_COLS; c++) {
          // Reason: row was range-checked above and c is a logical column.
          (buf[row] as LayerCell[])[c] = { r: color[0], g: color[1], b: color[2], l: 100, on: true };
        }
      };
      setCol(rp.c - dist);
      setCol(rp.c + dist);
      if (square) {
        setRow(rp.r - dist);
        setRow(rp.r + dist);
      }
    }
  }

  _auroraAdvance(state: AuroraState): void {
    // whole-grid fade -10 per boundary, then each dot paints its full-bright
    // front one column further left/right (mirror of the reference semantics)
    for (let r = 0; r < LOGIC_ROWS; r++) {
      for (let c = 0; c < LOGIC_COLS; c++) {
        // Reason: r and c are logical grid indices, inside the aurora grid.
        const cell = (state.cells[r] as (AuroraCell | null)[])[c] as AuroraCell | null;
        if (cell && cell.l > 0) cell.l = cell.l > 10 ? cell.l - 10 : 0;
      }
    }
    for (let i = 0; i < state.slots.length; i++) {
      const dot = state.slots[i];
      if (!dot) continue;
      const left = dot.c - dot.wave;
      const right = dot.c + dot.wave;
      // Reason: dot.r is a valid logical row and left was range-checked.
      if (left >= 0) (state.cells[dot.r] as (AuroraCell | null)[])[left] = { rgb: dot.rgb, l: 100 };
      // Reason: dot.r is a valid logical row and right was range-checked.
      if (right < LOGIC_COLS) (state.cells[dot.r] as (AuroraCell | null)[])[right] = { rgb: dot.rgb, l: 100 };
      if (left <= 0 && right >= LOGIC_COLS - 1) {
        state.slots[i] = null;
        continue;
      }
      dot.wave += 1;
    }
  }

  _auroraPress(state: AuroraState, rng: Rng, ev: TimedKeyEvent, pal: Rgb[]): void {
    // Reason: a cell string is "row,col"; its first two entries are indices.
    const [r, c] = ev.cell.split(',').map(Number) as [number, number];
    for (let i = 0; i < state.slots.length; i++) {
      if (!state.slots[i]) {
        // Like the firmware, a colour is drawn only when a slot is free.
        // Reason: resolvePalette always returns a non-empty palette.
        const rgb = pal[rng.int(pal.length)] as Rgb;
        state.slots[i] = { r, c, wave: 1, rgb };
        // Reason: r and c are a press cell, inside the aurora grid.
        (state.cells[r] as (AuroraCell | null)[])[c] = { rgb, l: 100 };
        break;
      }
    }
  }

  // Advance every elapsed boundary up to and including t (the firmware advances
  // before it takes that millisecond's presses). Cold starts and long gaps
  // replay at most AURORA_CATCHUP_BOUNDARIES boundaries.
  _auroraAdvanceTo(state: AuroraState, t: number, interval: number): void {
    const targetFloor = Math.floor(t / interval);
    const floorStart = Math.max(state.boundaryFloor + 1, targetFloor - AURORA_CATCHUP_BOUNDARIES + 1);
    for (let floor = floorStart; floor <= targetFloor; floor++) this._auroraAdvance(state);
    state.boundaryFloor = Math.max(state.boundaryFloor, targetFloor);
  }

  // trigger.scope "surface": the layer only sees keys on its own surface (upstream
  // composable-v1 and both firmwares filter key input by the layer mask).
  _inputScope(layer: NormalizedLayer): ((cell: string) => boolean) | null {
    if (layer.trigger?.scope !== 'surface') return null;
    return (cell) => {
      const [r, c] = cell.split(',').map(Number) as [number, number];
      return (
        Number.isInteger(r) &&
        r >= 0 &&
        r < LOGIC_ROWS &&
        Number.isInteger(c) &&
        c >= 0 &&
        c < LOGIC_COLS &&
        this._inMask(layer, r, c)
      );
    };
  }

  _scopedIo(layer: NormalizedLayer, io: RenderIo): RenderIo {
    const inScope = this._inputScope(layer);
    if (!inScope) return io;
    return {
      ...io,
      keyDown: new Set([...(io.keyDown ?? [])].filter(inScope)),
      keyPressed: new Set([...(io.keyPressed ?? [])].filter(inScope)),
      keyPressedEvents: (io.keyPressedEvents ?? []).filter((ev) => inScope(ev.cell)),
    };
  }

  // Fresh presses, in the firmware's order: per press instant, every layer in
  // order, each taking that instant's presses in scan order. This keeps the
  // random colour draws (per-layer RNG, composable-v1)
  // identical to the keyboard at any frame cadence.
  _dispatchPresses(events: TimedKeyEvent[]): void {
    if (!events.length) return;
    for (let start = 0; start < events.length;) {
      // Reason: start is below events.length in the loop condition.
      const t = (events[start] as TimedKeyEvent).t;
      let end = start;
      // Reason: end is below events.length in the loop condition.
      while (end < events.length && (events[end] as TimedKeyEvent).t === t) end++;
      const instant = events.slice(start, end);
      start = end;
      for (let li = 0; li < this.program.layers.length; li++) {
        // Reason: li is below layers.length in the loop condition.
        const layer = this.program.layers[li] as NormalizedLayer;
        // Reason: one RNG exists per layer.
        const rng = this.layerRngs[li] as Rng;
        const inScope = this._inputScope(layer);
        const group = inScope ? instant.filter((ev) => inScope(ev.cell)) : instant;
        // Reason: validated layer params; only the typed fields below are read.
        const p = (layer.params || {}) as RenderParams;
        if (layer.component === 'reactive' && p.color_mode !== 'lifecycle') {
          const pal = resolvePalette(p.palette ?? 'rainbow24');
          const ctx = { tick: t, seed: this.program.seed || 1, layerSalt: 0, row: 0, col: 0 } as ColorContext;
          for (const ev of group) {
            const rgb: Rgb =
              layer.color?.type === 'solid'
                ? resolveColor(layer.color, ctx)
                : // Reason: resolvePalette always returns a non-empty palette.
                  (pal[rng.int(pal.length)] as Rgb);
            // Reason: one map exists per layer.
            (this.reactiveByLayer[li] as Map<string, ReactiveEntry>).set(ev.cell, { rgb, born: ev.t });
          }
        } else if (layer.component === 'aurora') {
          const pal = resolvePalette(p.palette ?? 'rainbow24');
          // Reason: li is below the eight per-layer state slots.
          const state = this.auroraStates[li] as AuroraState;
          this._auroraAdvanceTo(state, t, this._auroraInterval(p.speed));
          for (const ev of group) this._auroraPress(state, rng, ev, pal);
        }
      }
    }
  }

  renderAurora(
    layer: NormalizedLayer,
    ctx: RenderContext,
    io: RenderIo,
    buf: LayerBuffer,
    layerIndex = 0,
  ): void {
    // Reason: validated layer params; only the typed fields below are read.
    const p = layer.params as RenderParams;
    const interval = this._auroraInterval(p.speed);
    const pal = resolvePalette(p.palette ?? 'rainbow24');
    // Reason: layerIndex is below the eight per-layer state slots.
    void io; // presses were taken in _dispatchPresses
    void pal;
    // Reason: layerIndex is below the eight per-layer state slots.
    const state = this.auroraStates[layerIndex] as AuroraState;
    this._auroraAdvanceTo(state, ctx.tick, interval);
    // emit every lit trail cell
    for (let r = 0; r < LOGIC_ROWS; r++) {
      for (let c = 0; c < LOGIC_COLS; c++) {
        // Reason: r and c are logical grid indices, inside the aurora grid.
        const cell = (state.cells[r] as (AuroraCell | null)[])[c] as AuroraCell | null;
        if (cell && cell.l > 0) {
          // Reason: r and c are logical grid indices, always inside the buffer.
          (buf[r] as LayerCell[])[c] = {
            r: cell.rgb[0],
            g: cell.rgb[1],
            b: cell.rgb[2],
            l: cell.l,
            on: true,
          };
        }
      }
    }
  }

  _bands(layer: NormalizedLayer, io: { audio?: number[] }, dense = false): number[] {
    // Reason: validated layer params; only the typed fields below are read.
    const p = (layer.params || {}) as RenderParams;
    const gain = p.gain ?? 32;
    const audio = io.audio;
    const out: number[] = new Array(LOGIC_COLS).fill(0);
    if (audio) {
      for (let c = 0; c < LOGIC_COLS && c < audio.length; c++) {
        // Reason: c is below audio.length in the loop condition.
        out[c] = audio[c] as number;
      }
    }
    return out.map((band) => {
      let h;
      if (dense) {
        const b = Math.min(255, Math.floor((band * gain) / 32));
        h = b < 40 ? 0 : 1 + Math.floor(((b - 40) * 5) / 150);
      } else {
        h = Math.floor((band * LOGIC_ROWS * gain) / (255 * 32));
      }
      return Math.max(0, Math.min(LOGIC_ROWS, h));
    });
  }

  _audioMode(component: string): number {
    if (component === 'spectrum_mirror') return 1;
    if (component === 'spectrum_sum') return 2;
    return 0;
  }

  _audioState(index: number, mode: number): AudioState {
    let st = this._audioStates[index];
    if (!st || st.mode !== mode) {
      st = this._emptyAudioState(mode);
      this._audioStates[index] = st;
    }
    return st;
  }

  _emptyAudioState(mode: number): AudioState {
    return {
      cell: Array.from({ length: LOGIC_ROWS }, () => new Array(LOGIC_COLS).fill(0)),
      peak: new Array(LOGIC_COLS).fill(0),
      peakUntil: new Array(LOGIC_COLS).fill(0),
      peakFallUntil: new Array(LOGIC_COLS).fill(0),
      beatUntil: 0,
      beatLast: 0,
      zeroSince: null,
      mode,
      time: -1,
      bands: null,
      heights: new Array(LOGIC_COLS).fill(0),
      silent: true,
      lastSampleT: -Infinity,
    };
  }

  // --- audio input timeline ---------------------------------------------------
  // Samples may arrive unsorted and ahead of the frame; they stay pending until
  // the internal 1 ms advance reaches their timestamp. Samples at or before the
  // already advanced time cannot change the past and are dropped.
  _acceptAudio(audio: AudioSample[] | undefined): void {
    if (!audio) return;
    for (const sample of audio) this._queueAudioSample(sample.t, sample.bands);
  }

  _queueAudioSample(t: number, bands: number[] | null): void {
    // A sample without bands is a missing packet: the keyboard keeps the last
    // bands it received, so it changes nothing.
    if (!bands || t <= this._audioAdvancedTo) return;
    this._audioPending.push({ t, bands });
  }

  _advanceAudio(end: number): void {
    const target = Math.max(this._audioAdvancedTo, Math.floor(end));
    this._audioPending.sort((a, b) => a.t - b.t);
    for (let li = 0; li < this.program.layers.length; li++) {
      // Reason: li is below layers.length in the loop condition.
      const layer = this.program.layers[li] as NormalizedLayer;
      if (!AUDIO_COMPONENTS.has(layer.component) || usesExtendedSpectrum(layer)) continue;
      this._advanceAudioLayer(layer, li, target);
    }
    this._audioPending = this._audioPending.filter((sample) => sample.t > target);
    this._audioAdvancedTo = target;
  }

  _advanceAudioLayer(layer: NormalizedLayer, index: number, end: number): void {
    // Reason: validated layer params; only the typed fields below are read.
    const p = layer.params as RenderParams;
    const mode = this._audioMode(layer.component);
    const state = this._audioState(index, mode);
    const dense = !!p.dense;
    const peakMs = p.peak_ms ?? 0;
    const beat = !!p.beat;

    // Start at most AUDIO_CATCHUP_MS before end. A sample older than the
    // window still has to seed the held value, so keep the last one before it.
    const from = Math.max(state.time + 1, end - AUDIO_CATCHUP_MS);
    let cursor = -1;
    for (let i = this._audioPending.length - 1; i >= 0; i--) {
      // Reason: i is below the pending length in the loop condition.
      if ((this._audioPending[i] as PendingAudioSample).t <= from - 1) {
        cursor = i;
        break;
      }
    }
    if (cursor < 0) cursor = 0;
    state.time = from - 1;

    for (let b = state.time + 1; b <= end; b++) {
      // Reason: cursor is below the pending length in the loop condition.
      // Like the keyboard's band buffer, the last sample received by this
      // millisecond is the one the effect reads.
      let latest: PendingAudioSample | null = null;
      while (
        cursor < this._audioPending.length &&
        (this._audioPending[cursor] as PendingAudioSample).t <= b
      ) {
        const sample = this._audioPending[cursor++] as PendingAudioSample;
        if (sample.t >= state.lastSampleT) latest = sample;
      }
      if (latest) {
        state.lastSampleT = latest.t;
        state.bands = latest.bands;
        state.heights = this._bands(layer, { audio: latest.bands }, dense);
        state.silent = !latest.bands || !latest.bands.some((v) => v);
      }
      this._applySilence(state, b);
      this._applyAudioMs(state, b, dense, peakMs, beat);
      this._decayAudioLayer(state, layer, b, mode, dense);
      state.time = b;
    }
  }

  // Per-millisecond beat and peak update, read from the held bands exactly as
  // the keyboard does every tick.
  _applyAudioMs(state: AudioState, boundary: number, dense: boolean, peakMs: number, beat: boolean): void {
    const bands = state.bands;
    if (beat) {
      // Reason: the beat detector reads the first three bands (audio has 22).
      const low = bands
        ? Math.floor(((bands[0] as number) + (bands[1] as number) + (bands[2] as number)) / 3)
        : 0;
      if (low > state.beatLast + 18 && low >= 90) state.beatUntil = boundary + 100;
      state.beatLast = low;
    }
    if (dense && peakMs > 0) {
      for (let c = 0; c < LOGIC_COLS; c++) {
        // Reason: c is a logical column, inside the 22-entry arrays.
        const h = state.heights[c] as number,
          peak = state.peak[c] as number;
        if (h > peak) {
          state.peak[c] = h;
          state.peakUntil[c] = boundary + peakMs;
          state.peakFallUntil[c] = boundary + peakMs;
        } else if (
          boundary >= (state.peakUntil[c] as number) &&
          peak > 0 &&
          boundary >= (state.peakFallUntil[c] as number)
        ) {
          state.peak[c] = peak - 1;
          state.peakFallUntil[c] = boundary + 60;
        }
      }
    }
  }

  _applySilence(state: AudioState, boundary: number): void {
    if (!state.silent) {
      state.zeroSince = null;
      return;
    }
    if (state.zeroSince === null) state.zeroSince = boundary;
    else if (boundary - state.zeroSince > 250) {
      state.peak.fill(0);
      state.peakUntil.fill(0);
      state.peakFallUntil.fill(0);
      state.beatUntil = 0;
      state.zeroSince = boundary;
    }
  }

  _inMask(layer: NormalizedLayer, r: number, c: number): boolean {
    // Reason: c is a logical column, so the 22-slot mask always has an entry.
    return !layer.mask || (((layer.mask[c] as number) >> r) & 1) !== 0;
  }

  _colRows(layer: NormalizedLayer, c: number): number[] {
    const rows: number[] = [];
    for (let r = LOGIC_ROWS - 1; r >= 0; r--) {
      // Reason: r and c are logical grid indices inside the presence table.
      if (((this.geometry.present[r] as readonly number[])[c] as number) && this._inMask(layer, r, c))
        rows.push(r);
    }
    return rows;
  }

  _litCount(h: number, n: number): number {
    if (n <= 0 || h <= 0) return 0;
    if (h >= LOGIC_ROWS) return n;
    return Math.floor((h * n + LOGIC_ROWS - 1) / LOGIC_ROWS);
  }

  // Audio cells advance one level per millisecond: a lit cell jumps to 100,
  // otherwise it fades and cuts under 75+4i (columns) / 75+c (width bar).
  _decayCell(
    state: AudioState,
    mode: number,
    r: number,
    c: number,
    lit: boolean,
    decayIndex: number | null = null,
  ): void {
    // Reason: r and c are logical grid indices, inside the audio cell grid.
    let lv = (state.cell[r] as number[])[c] as number;
    if (lit) lv = 100;
    else if (lv) {
      lv--;
      const i = decayIndex ?? LOGIC_ROWS - 1 - r;
      if (lv <= (mode === 2 ? 75 + c : 75 + 4 * i)) lv = 0;
    }
    // Reason: r and c are logical grid indices, inside the audio cell grid.
    (state.cell[r] as number[])[c] = lv;
  }

  _decayAudioLayer(
    state: AudioState,
    layer: NormalizedLayer,
    boundary: number,
    mode: number,
    dense: boolean,
  ): void {
    if (mode === 0) {
      if (!dense) {
        for (let c = 0; c < LOGIC_COLS; c++) {
          for (let k = 0; k < LOGIC_ROWS; k++) {
            const r = LOGIC_ROWS - 1 - k;
            if (!this._inMask(layer, r, c)) {
              // Reason: r and c are logical grid indices, inside the audio grid.
              (state.cell[r] as number[])[c] = 0;
              continue;
            }
            // Reason: c is a logical column, inside the 22-entry heights array.
            this._decayCell(state, 0, r, c, k < (state.heights[c] as number));
          }
        }
      } else {
        for (let c = 0; c < LOGIC_COLS; c++) {
          const rows = this._colRows(layer, c);
          // Reason: c is a logical column, inside the 22-entry heights array.
          const lit = this._litCount(state.heights[c] as number, rows.length);
          for (let i = 0; i < rows.length; i++) {
            // Reason: i is below rows.length in the loop condition.
            this._decayCell(state, 0, rows[i] as number, c, i < lit, i);
          }
        }
      }
      return;
    }

    if (mode === 1) {
      const mid = Math.floor(LOGIC_COLS / 2);
      for (let d = 0; d < mid; d++) {
        // Reason: d is below mid, inside the 22-entry heights array.
        const h = (state.heights[d] as number) || 0;
        for (let k = 0; k < LOGIC_ROWS; k++) {
          const r = LOGIC_ROWS - 1 - k;
          this._decayCell(state, 1, r, mid + d, k < h);
        }
      }
      return;
    }

    const sum = state.heights.reduce((a, b) => a + b, 0);
    const width = Math.min(LOGIC_COLS, Math.floor(sum / LOGIC_ROWS));
    for (let c = 0; c < LOGIC_COLS; c++) {
      for (let r = 0; r < LOGIC_ROWS; r++) this._decayCell(state, 2, r, c, c < width);
    }
  }

  renderSpectrumV14(
    layer: NormalizedLayer,
    ctx: RenderContext,
    input: RenderIo,
    buf: LayerBuffer,
    index: number,
  ): void {
    const p = layer.params as RenderParams;
    const state = this._audioState(index, this._audioMode(layer.component));
    if (!input.spectrumBands) {
      state.peak.fill(0);
      state.beatUntil = 0;
      state.beatLast = 0;
    }
    const bands = input.spectrumBands?.slice() ?? new Array<number>(LOGIC_COLS).fill(0);
    const mirror = layer.component === 'spectrum_mirror';
    const sum = layer.component === 'spectrum_sum';
    const mid = Math.floor(LOGIC_COLS / 2);
    if (mirror && p.full_range)
      for (let i = 0; i < mid; i++) bands[i] = Math.max(bands[2 * i] ?? 0, bands[2 * i + 1] ?? 0);
    const heights = this._bands(layer, { audio: bands }, p.dense);
    const width = Math.floor(heights.reduce((a, b) => a + b, 0) / LOGIC_ROWS);
    const raw = input.spectrumRaw;
    const low = Math.floor(((raw?.[0] ?? 0) + (raw?.[1] ?? 0) + (raw?.[2] ?? 0)) / 3);
    if (p.beat && low >= 90 && low > state.beatLast + 18) state.beatUntil = ctx.tick + 100;
    state.beatLast = low;
    const boost =
      p.beat && ctx.tick < state.beatUntil
        ? 100 + Math.floor((18 * (state.beatUntil - ctx.tick)) / 100)
        : 100;
    const pal = resolvePalette(p.palette ?? 'rainbow24');
    const ramp = layer.color;
    for (let col = 0; col < LOGIC_COLS; col++) {
      const channel = mirror ? (col < mid ? mid - 1 - col : col - mid) : col;
      const h = heights[channel] ?? 0;
      const rows = p.dense ? this._colRows(layer, col) : [5, 4, 3, 2, 1, 0];
      const lit = sum ? (col < width ? rows.length : 0) : this._litCount(h, rows.length);
      const previous = state.peak[col] ?? 0,
        due = state.peakFallUntil[col] ?? 0;
      if (p.peak_ms) {
        if (h >= previous) {
          state.peak[col] = h;
          state.peakFallUntil[col] = ctx.tick + p.peak_ms;
        } else if (previous && ctx.tick >= due) {
          const steps = 1 + Math.floor((ctx.tick - due) / 60);
          state.peak[col] = Math.max(h, previous - steps);
          state.peakFallUntil[col] = due + 60 * steps;
        }
      }
      const marker = p.peak_ms ? this._litCount(state.peak[col] ?? 0, rows.length) : 0;
      const base = rampColor(pal, Math.floor((channel * 1000) / (mirror ? mid : LOGIC_COLS - 1)));
      rows.forEach((row, i) => {
        if (!this._inMask(layer, row, col)) return;
        let color = base;
        if (p.color_by_height && ramp?.type === 'ramp') {
          const from = ramp.from ?? 0,
            to = ramp.to ?? 1000;
          color = rampColor(
            ramp.colors ?? resolvePalette(ramp.palette),
            from + Math.trunc((axisValue(row, col, 'y') * (to - from)) / 1000),
          );
        }
        const peak = marker === i + 1;
        const channelValue = (value: number) =>
          peak ? 255 : Math.min(255, Math.floor((value * boost) / 100));
        (buf[row] as LayerCell[])[col] = {
          r: channelValue(color[0]),
          g: channelValue(color[1]),
          b: channelValue(color[2]),
          l: peak || i < lit ? 100 : 0,
          on: true,
        };
      });
    }
  }

  renderSpectrum(
    layer: NormalizedLayer,
    ctx: RenderContext,
    io: RenderIo,
    buf: LayerBuffer,
    layerIndex = 0,
  ): void {
    // Reason: validated layer params; only the typed fields below are read.
    const p = layer.params as RenderParams;
    const dense = !!p.dense;
    const peakMs = p.peak_ms ?? 0;
    const beat = !!p.beat;
    const state = this._audioState(layerIndex, 0);
    const pal = resolvePalette(p.palette ?? 'rainbow24');
    let boost = 100;
    if (beat && ctx.tick < state.beatUntil) {
      boost = 100 + Math.floor((18 * (state.beatUntil - ctx.tick)) / 100);
    }

    if (!dense) {
      for (let c = 0; c < LOGIC_COLS; c++) {
        const base = rampColor(pal, Math.floor((c * 1000) / (LOGIC_COLS - 1)));
        // Reason: mapping each RGB channel of a three-tuple keeps three entries.
        const rgb = base.map((v) => Math.min(255, Math.floor((v * boost) / 100))) as Rgb;
        for (let k = 0; k < LOGIC_ROWS; k++) {
          const r = LOGIC_ROWS - 1 - k;
          if (!this._inMask(layer, r, c)) continue;
          // Reason: r and c are logical grid indices, inside the audio grid.
          (buf[r] as LayerCell[])[c] = {
            r: rgb[0],
            g: rgb[1],
            b: rgb[2],
            l: (state.cell[r] as number[])[c] as number,
            on: true,
          };
        }
      }
      return;
    }

    for (let c = 0; c < LOGIC_COLS; c++) {
      const base = rampColor(pal, Math.floor((c * 1000) / (LOGIC_COLS - 1)));
      // Reason: mapping each RGB channel of a three-tuple keeps three entries.
      const rgb = base.map((v) => Math.min(255, Math.floor((v * boost) / 100))) as Rgb;
      const rows = this._colRows(layer, c);
      for (let i = 0; i < rows.length; i++) {
        // Reason: i is below rows.length in the loop condition.
        const r = rows[i] as number;
        // Reason: r and c are logical grid indices, inside the audio grid.
        (buf[r] as LayerCell[])[c] = {
          r: rgb[0],
          g: rgb[1],
          b: rgb[2],
          l: (state.cell[r] as number[])[c] as number,
          on: true,
        };
      }
    }

    if (peakMs > 0) {
      for (let c = 0; c < LOGIC_COLS; c++) {
        // Reason: c is a logical column, inside the peak array.
        if (!(state.peak[c] as number)) continue;
        const rows = this._colRows(layer, c);
        // Reason: c is a logical column, inside the peak array.
        const pl = this._litCount(state.peak[c] as number, rows.length);
        if (pl <= 0) continue;
        // Reason: pl is at most rows.length, so pl - 1 is a valid index.
        const r = rows[pl - 1] as number;
        // Reason: r and c are logical grid indices, always inside the buffer.
        (buf[r] as LayerCell[])[c] = { r: 255, g: 255, b: 255, l: 100, on: true };
      }
    }
  }

  renderSpectrumMirror(
    layer: NormalizedLayer,
    ctx: RenderContext,
    io: RenderIo,
    buf: LayerBuffer,
    layerIndex = 0,
  ): void {
    const state = this._audioState(layerIndex, 1);
    // Reason: validated layer params; only the typed fields below are read.
    const pal = resolvePalette((layer.params as RenderParams).palette ?? 'rainbow24');
    const mid = Math.floor(LOGIC_COLS / 2);
    for (let d = 0; d < mid; d++) {
      const rgb = rampColor(pal, Math.floor((d * 1000) / mid));
      for (let k = 0; k < LOGIC_ROWS; k++) {
        const r = LOGIC_ROWS - 1 - k;
        // Reason: r is a row index and mid + d is a logical column.
        const lv = (state.cell[r] as number[])[mid + d] as number;
        // Reason: r is a row index and both columns are logical grid columns.
        (buf[r] as LayerCell[])[mid + d] = { r: rgb[0], g: rgb[1], b: rgb[2], l: lv, on: true };
        // Reason: r is a row index and both columns are logical grid columns.
        (buf[r] as LayerCell[])[mid - d - 1] = { r: rgb[0], g: rgb[1], b: rgb[2], l: lv, on: true };
      }
    }
  }

  renderSpectrumSum(
    layer: NormalizedLayer,
    ctx: RenderContext,
    io: RenderIo,
    buf: LayerBuffer,
    layerIndex = 0,
  ): void {
    const state = this._audioState(layerIndex, 2);
    // Reason: validated layer params; only the typed fields below are read.
    const pal = resolvePalette((layer.params as RenderParams).palette ?? 'rainbow24');
    for (let c = 0; c < LOGIC_COLS; c++) {
      const rgb = rampColor(pal, Math.floor((c * 1000) / (LOGIC_COLS - 1)));
      // Reason: the bottom row and c are logical grid indices.
      const lv = (state.cell[LOGIC_ROWS - 1] as number[])[c] as number;
      for (let r = 0; r < LOGIC_ROWS; r++) {
        // Reason: r and c are logical grid indices, always inside the buffer.
        (buf[r] as LayerCell[])[c] = { r: rgb[0], g: rgb[1], b: rgb[2], l: lv, on: true };
      }
    }
  }

  renderFrameSequence(layer: NormalizedLayer, ctx: RenderContext, buf: LayerBuffer): void {
    const frames = layer.frames || [];
    if (!frames.length) return;
    // Reason: validated layer params; only the typed fields below are read.
    const loop = !(layer.params && (layer.params as RenderParams).loop === false);
    const total = frames.reduce((a, f) => a + Math.max(1, f.hold || 1), 0);
    const t = loop ? ((ctx.tick % total) + total) % total : Math.min(ctx.tick, total - 1);
    let acc = 0;
    // Reason: frames is non-empty (checked above), so the last index exists.
    let frame = frames[frames.length - 1] as FrameDsl;
    for (const f of frames) {
      const h = Math.max(1, f.hold || 1);
      if (t < acc + h) {
        frame = f;
        break;
      }
      acc += h;
    }
    for (const p of frame.points || []) {
      const [r, c, rr, gg, bb, l] = p;
      if (r < 0 || r >= LOGIC_ROWS || c < 0 || c >= LOGIC_COLS) continue;
      // Reason: c is a logical column, so the 22-slot mask always has an entry.
      if (layer.mask && !(((layer.mask[c] as number) >> r) & 1)) continue;
      // Reason: r and c were range-checked immediately above.
      (buf[r] as LayerCell[])[c] = { r: rr, g: gg, b: bb, l, on: true };
    }
  }

  renderKeyTint(layer: NormalizedLayer, ctx: RenderContext, io: RenderIo, buf: LayerBuffer): void {
    // Reason: validated layer params; only the typed fields below are read.
    const pal = resolvePalette(((layer.params || {}) as RenderParams).palette ?? 'seven');
    let i = 0;
    // Colours follow the firmware scan order (column, then row).
    const held = [...(io.keyDown || [])]
      .map((key) => key.split(',').map(Number) as [number, number])
      .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    for (const [r, c] of held) {
      // Reason: resolvePalette always returns a non-empty palette.
      const rgb = pal[i % pal.length] as Rgb;
      i++;
      // Reason: r and c are a pressed key's cell, always inside the buffer.
      (buf[r] as LayerCell[])[c] = { r: rgb[0], g: rgb[1], b: rgb[2], l: 100, on: true };
    }
  }
}

// ---- output conversion (docs/04 §2, docs/07 §8) ----------------------------
export function levelToPhysical(lightLevel: number, brightnessLevel: number): number {
  return Math.floor(
    (lightLevel * brightnessLevel * MAX_PHYSICAL_LED_LIGHT_LEVEL) /
      (MAX_LED_LIGHT_LEVEL * MAX_LOGIC_LED_LIGHT_LEVEL),
  );
}

export function grayValue(channel: number, physicalBrightness: number): number {
  return Math.min(65535, channel * physicalBrightness);
}

// ---- high-level simulation -------------------------------------------------
// sim: { ticks, keyEvents:[{tick, type:'down'|'up', cell:'r,c'}], audio:[{tick,bands:[]}] }
export function simulate(
  program: Program,
  sim: SimInput,
  onFrame?: (frameIndex: number, frame: Frame) => void,
  options: RendererOptions = {},
): Frame[] {
  const ticks = sim.ticks ?? 1;
  const stepMs = sim.stepMs ?? 1; // simulated ms advanced per frame
  const keyEvents = (sim.keyEvents || []).slice().sort((a, b) => a.tick - b.tick);
  const audioEvents = (sim.audio || []).slice().sort((a, b) => a.tick - b.tick);
  const renderer = new Renderer(program, options);

  let ei = 0;
  let ai = 0;
  const frames: Frame[] = [];
  for (let t = 0; t < ticks; t++) {
    const tick = t * stepMs;
    const keys: KeyEvent[] = [];
    // Reason: ei is below keyEvents.length in the loop condition below.
    while (ei < keyEvents.length && (keyEvents[ei] as SimKeyEvent).tick <= tick) {
      const ev = keyEvents[ei++] as SimKeyEvent;
      keys.push({ t: ev.tick, type: ev.type, cell: ev.cell });
    }
    const audio: AudioSample[] = [];
    // Reason: ai is below audioEvents.length in the loop condition below.
    while (ai < audioEvents.length && (audioEvents[ai] as SimAudioEvent).tick <= tick) {
      const sample = audioEvents[ai++] as SimAudioEvent;
      audio.push({ t: sample.tick, bands: sample.bands });
    }
    const io: StepInput = { keys, audio };
    const frame = renderer.step(tick, io);
    frames.push(frame);
    if (onFrame) onFrame(t, frame);
  }
  return frames;
}
