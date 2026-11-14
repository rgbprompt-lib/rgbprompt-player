// Portable audio contract. Capture backends supply timestamped byte amplitudes.
import contract from '../../data/schemas/audio-contract.json' with { type: 'json' };
import { getPrimitiveProduct } from '../product.ts';
import type { AudioSample, LayerDsl } from '../types.ts';

export { contract as audioContract };
export type AudioSource = keyof typeof contract.sources;
export type AudioDetector = 'level' | 'flux';
// v15 onset detector options, shared by playback onsets and brightness impulses.
export interface AudioOnsetOptions {
  detector?: AudioDetector;
  sensitivity?: number;
  threshold?: number;
  hysteresis?: number;
  min_interval_ms?: number;
}
export interface AudioBinding extends AudioOnsetOptions {
  source: AudioSource;
  attack_ms?: number;
  release_ms?: number;
  min?: number;
  max?: number;
  /** v15: 'onset' turns brightness into an impulse that jumps to max on an onset and falls at release_ms. */
  trigger?: 'onset';
}
export interface AudioModulation {
  brightness?: AudioBinding;
  motion_rate?: AudioBinding;
}
export interface AudioOnset extends AudioOnsetOptions {
  start: 'audio_onset';
  source: AudioSource;
}
type AudioLayer = Pick<LayerDsl, 'component' | 'audio_mod' | 'playback' | 'params' | 'color'>;
type Dict = Record<string, unknown>;
const sources = Object.keys(contract.sources) as AudioSource[];
const isNumber = (v: unknown, min: number, max: number) =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const obj = (v: unknown): v is Dict => v !== null && typeof v === 'object' && !Array.isArray(v);
const only = (v: Dict, keys: string[]) => Object.keys(v).every((k) => keys.includes(k));
const intValue = (v: Dict, k: string, fallback: number) => (v[k] === undefined ? fallback : v[k]);

export const LEGACY_SPECTRUM_COUNT: Readonly<Record<string, number>> = {
  spectrum: 5,
  spectrum_mirror: 2,
  spectrum_sum: 2,
};
export function usesExtendedSpectrum(layer: AudioLayer): boolean {
  const p = layer.params || {};
  return !!(
    LEGACY_SPECTRUM_COUNT[layer.component] &&
    (p.attack_ms ||
      p.release_ms ||
      p.color_by_height ||
      (layer.component === 'spectrum_mirror' && (p.dense || p.peak_ms || p.full_range)))
  );
}
export function usesAudioContract(layer: AudioLayer): boolean {
  return (
    layer.audio_mod !== undefined || layer.playback?.start === 'audio_onset' || usesExtendedSpectrum(layer)
  );
}
export const usesFlux = (config: AudioOnsetOptions | undefined) => config?.detector === 'flux';
export const isImpulse = (config: AudioBinding | undefined) => config?.trigger === 'onset';
/** v15 key_ring floor: rings shorter than 300 ms need package version 15. */
export const shortKeyRing = (layer: Pick<LayerDsl, 'component' | 'params'>) =>
  layer.component === 'key_ring' && Number(layer.params?.life_ms ?? 1400) < 300;
/** A layer needs package v15 for flux, an impulse, a response above the v14 limit or a short key_ring. */
export function usesV15Audio(layer: AudioLayer): boolean {
  if (layer.playback?.start === 'audio_onset' && usesFlux(layer.playback as AudioOnset)) return true;
  const mod = (layer.audio_mod ?? {}) as AudioModulation;
  return (
    shortKeyRing(layer) ||
    Object.values(mod).some(
      (c) =>
        !!c &&
        (isImpulse(c) ||
          (c.attack_ms ?? 0) > contract.max_response_ms ||
          (c.release_ms ?? 0) > contract.max_response_ms),
    )
  );
}
function onsetOk(config: Dict): boolean {
  const d = contract.onset,
    f = contract.flux,
    detector = config.detector ?? 'level';
  if (!contract.detectors.includes(detector as string)) return false;
  if (!isNumber(intValue(config, 'min_interval_ms', d.min_interval_ms), d.interval_min, d.interval_max))
    return false;
  if (detector === 'flux')
    return (
      config.threshold === undefined &&
      config.hysteresis === undefined &&
      isNumber(intValue(config, 'sensitivity', f.sensitivity), f.sensitivity_min, f.sensitivity_max)
    );
  const threshold = intValue(config, 'threshold', d.threshold);
  return (
    config.sensitivity === undefined &&
    isNumber(threshold, 1, 255) &&
    isNumber(intValue(config, 'hysteresis', d.hysteresis), 1, Number(threshold))
  );
}

export function instanceLimit(layer: AudioLayer): number {
  if (layer.playback?.start !== 'audio_onset') return 0;
  return layer.component === 'key_ring'
    ? Number(layer.params?.max_waves ?? 8)
    : layer.component === 'key_burst'
      ? Number(layer.params?.max_bursts ?? 4)
      : 0;
}

export function getLayerInputs(layer: Pick<LayerDsl, 'component' | 'audio_mod' | 'playback'>): {
  audio: boolean;
  key: boolean;
} {
  const input = getPrimitiveProduct(layer.component)?.requiresInput;
  const onset = layer.playback?.start === 'audio_onset';
  return { audio: input === 'audio' || !!layer.audio_mod || onset, key: input === 'key' && !onset };
}

export function audioIssues(layer: AudioLayer): string[] {
  const problems: string[] = [];
  const mod: unknown = layer.audio_mod;
  if (mod !== undefined) {
    if (!obj(mod) || !only(mod, ['brightness', 'motion_rate']) || Object.keys(mod).length === 0) {
      problems.push('audio_mod must contain brightness or motion_rate');
    } else {
      for (const [target, value] of Object.entries(mod)) {
        const limit = target === 'brightness' ? contract.brightness_max : contract.motion_rate_max;
        const response = contract.extended_response_ms;
        const impulse = target === 'brightness' && obj(value) && value.trigger === 'onset';
        const keys = ['source', 'attack_ms', 'release_ms', 'min', 'max'];
        if (target === 'brightness') keys.push('trigger');
        if (impulse) keys.push('detector', 'sensitivity', 'threshold', 'hysteresis', 'min_interval_ms');
        if (
          !obj(value) ||
          !only(value, keys) ||
          !sources.includes(value.source as AudioSource) ||
          (value.trigger !== undefined && value.trigger !== 'onset') ||
          !isNumber(intValue(value, 'attack_ms', 0), 0, impulse ? 0 : response) ||
          !isNumber(intValue(value, 'release_ms', 0), impulse ? contract.impulse.release_min : 0, response) ||
          (impulse && !onsetOk(value)) ||
          !isNumber(intValue(value, 'min', 0), 0, limit) ||
          !isNumber(intValue(value, 'max', 1000), Number(intValue(value, 'min', 0)), limit)
        ) {
          problems.push('invalid audio_mod.' + target);
        }
        if (
          target === 'motion_rate' &&
          (!contract.motion_components.includes(layer.component) || layer.playback)
        ) {
          problems.push('motion_rate requires a supported clock without playback');
        }
      }
    }
  }
  const onset: unknown = layer.playback;
  if (obj(onset) && onset.start === 'audio_onset') {
    if (
      !Object.hasOwn(contract.instance_components, layer.component) ||
      !only(onset, [
        'start',
        'source',
        'threshold',
        'hysteresis',
        'min_interval_ms',
        'detector',
        'sensitivity',
      ]) ||
      !sources.includes(onset.source as AudioSource) ||
      !onsetOk(onset) ||
      !isNumber(instanceLimit(layer), 1, contract.max_instances)
    )
      problems.push('invalid playback.audio_onset');
  }
  if (layer.component === 'key_ring' && obj(onset) && onset.start === 'audio_onset') {
    const p = layer.params ?? {};
    if (p.origin !== undefined && !['event_key', 'board_center', 'random_key'].includes(String(p.origin)))
      problems.push('invalid ring origin');
    if (
      p.envelope !== undefined &&
      !['fade_out', 'constant', 'fade_in', 'fade_in_out'].includes(String(p.envelope))
    )
      problems.push('invalid ring envelope');
    if (!isNumber(intValue(p, 'max_radius', 4), 1, 22)) problems.push('invalid ring radius');
    if (layer.color?.type === 'ramp') {
      const c = layer.color;
      const palette = p.palette ?? 'rainbow24';
      if (
        (c.axis ?? 'x') !== 'x' ||
        (c.from ?? 0) !== 0 ||
        (c.to ?? 1000) !== 1000 ||
        (c.palette !== undefined && c.palette !== palette) ||
        (palette === 'custom' && (!c.colors || c.colors.length < 2)) ||
        (palette !== 'custom' && c.colors !== undefined)
      )
        problems.push('invalid audio ring palette');
    } else if (p.palette === 'custom') problems.push('custom ring requires angular palette');
  }
  if (LEGACY_SPECTRUM_COUNT[layer.component]) {
    const p = layer.params ?? {};
    for (const key of ['attack_ms', 'release_ms']) {
      if (!isNumber(intValue(p, key, 0), 0, contract.max_response_ms))
        problems.push('invalid spectrum ' + key);
    }
    if (
      p.color_by_height !== undefined &&
      (typeof p.color_by_height !== 'boolean' || layer.component === 'spectrum_sum')
    ) {
      problems.push('invalid color_by_height');
    }
    if (
      p.full_range !== undefined &&
      (typeof p.full_range !== 'boolean' || layer.component !== 'spectrum_mirror')
    ) {
      problems.push('invalid full_range');
    }
    if (layer.component === 'spectrum_mirror' && p.dense !== undefined && typeof p.dense !== 'boolean') {
      problems.push('invalid mirror dense');
    }
    if (usesExtendedSpectrum(layer) && p.peak_ms && (!p.dense || !isNumber(p.peak_ms, 1, 1000))) {
      problems.push('peak_ms requires dense and must be 0..1000');
    }
    if (
      p.color_by_height
        ? layer.color?.type !== 'ramp' || layer.color.axis !== 'y'
        : layer.color?.type === 'ramp'
    ) {
      problems.push('spectrum height color requires color_by_height and a y-axis ramp');
    }
  }
  return problems;
}

const SCALE = 256,
  FULL = 255 * SCALE,
  PHASE_DENOM = FULL * 1000;
function amplitude(sample: AudioSample | undefined, source: AudioSource): number {
  if (!sample) return 0;
  const [from, to] = contract.sources[source] as [number, number];
  let result = 0;
  for (let band = from; band < to; band++) result = Math.max(result, sample.bands[band] ?? 0);
  return result;
}

// Advance an integer linear envelope and return its area over dt. This gives
// identical motion phase whether an interval is rendered as one or many frames.
function advance(value: number, goal: number, dt: number, attack: number, release: number): [number, number] {
  const delta = goal - value;
  const time = delta > 0 ? attack : release;
  if (!time || !delta) return [goal, goal * dt];
  const speed = Math.ceil(FULL / time);
  const count = Math.min(dt, Math.ceil(Math.abs(delta) / speed));
  const slope = Math.sign(delta) * speed;
  const area = count * value + (slope * count * (count - 1)) / 2 + (dt - count) * goal;
  return [value + Math.sign(delta) * Math.min(Math.abs(delta), dt * speed), area];
}

// Onset detection. "level" is the v14 rising threshold with hysteresis. "flux"
// (v15) judges the positive rise of each fixed 40 ms cell maximum over a slow
// follower against an adaptive level when the first sample of a later cell
// arrives, so every host cadence sees the same onsets. Q8 integer, lepc-exact.
export class OnsetDetector {
  private armed = true;
  private last: number | undefined;
  private cell: number | undefined;
  private peak = 0;
  private slow = 0;
  private mean = 0;
  private readonly config: AudioOnsetOptions;
  private readonly source: AudioSource;
  constructor(config: AudioOnsetOptions, source: AudioSource) {
    this.config = config;
    this.source = source;
  }
  reset(): void {
    this.armed = true;
    this.last = this.cell = undefined;
    this.peak = this.slow = this.mean = 0;
  }
  detect(sample: AudioSample): boolean {
    const value = amplitude(sample, this.source),
      t = sample.t >>> 0;
    if (usesFlux(this.config)) {
      const f = contract.flux,
        cell = Math.floor(t / f.grid_ms);
      if (this.cell === undefined || cell === this.cell) {
        this.peak = this.cell === undefined ? value : Math.max(this.peak, value);
        this.cell = cell;
        return false;
      }
      const x = this.peak * 256,
        flux = Math.max(0, x - this.slow);
      this.slow += Math.floor(((x - this.slow) * f.slow_q8) / 256);
      const level = Math.max(
        f.floor * 256,
        Math.floor((this.mean * (this.config.sensitivity ?? f.sensitivity)) / 10),
      );
      this.mean += Math.floor(((flux - this.mean) * f.mean_q8) / 256);
      this.peak = value;
      this.cell = cell;
      if (2 * flux < level) this.armed = true;
      if (flux < level || !this.armed) return false;
    } else {
      const d = contract.onset,
        threshold = this.config.threshold ?? d.threshold;
      if (value <= threshold - (this.config.hysteresis ?? d.hysteresis)) this.armed = true;
      if (value < threshold || !this.armed) return false;
    }
    this.armed = false;
    if (
      this.last !== undefined &&
      t - this.last < (this.config.min_interval_ms ?? contract.onset.min_interval_ms)
    )
      return false;
    this.last = t;
    return true;
  }
}

class Envelope {
  value = 0;
  target = 0;
  set(goal: number, attack: number, release: number): void {
    this.target = goal * SCALE;
    this.value = advance(this.value, this.target, 0, attack, release)[0];
  }
  run(dt: number, attack: number, release: number): number {
    const [end, area] = advance(this.value, this.target, dt, attack, release);
    this.value = end;
    return area;
  }
}

export class LayerAudio {
  private tick: number | undefined;
  private sample: AudioSample | undefined;
  private brightness = new Envelope();
  private motion = new Envelope();
  private spectrum = Array.from({ length: 22 }, () => new Envelope());
  private phase = 0;
  private fraction = 0;
  private readonly detector: OnsetDetector | undefined;
  private readonly impulse: OnsetDetector | undefined;
  private readonly mod: AudioModulation;
  private readonly onset: AudioOnset | undefined;
  private readonly attack: number;
  private readonly release: number;

  constructor(layer: AudioLayer) {
    this.mod = layer.audio_mod ?? {};
    this.onset = layer.playback?.start === 'audio_onset' ? layer.playback : undefined;
    if (this.onset) this.detector = new OnsetDetector(this.onset, this.onset.source);
    const bright = this.mod.brightness;
    if (bright && isImpulse(bright)) this.impulse = new OnsetDetector(bright, bright.source);
    this.attack = Number(layer.params?.attack_ms ?? 0);
    this.release = Number(layer.params?.release_ms ?? 0);
  }

  step(
    end: number,
    samples: AudioSample[],
  ): {
    brightness: number;
    tick: number;
    onsets: number[];
    bands: number[] | undefined;
    raw: number[] | undefined;
  } {
    const onsets: number[] = [];
    for (const sample of samples) {
      this.move(sample.t);
      this.sample = sample;
      const { brightness, motion_rate } = this.mod;
      if (brightness && this.impulse) {
        // v15 impulse: an onset jumps to full, then the level falls at release_ms.
        this.brightness.target = 0;
        if (this.impulse.detect(sample)) this.brightness.value = FULL;
      } else if (brightness)
        this.brightness.set(
          amplitude(sample, brightness.source),
          brightness.attack_ms ?? 0,
          brightness.release_ms ?? 0,
        );
      if (motion_rate)
        this.motion.set(
          amplitude(sample, motion_rate.source),
          motion_rate.attack_ms ?? 0,
          motion_rate.release_ms ?? 0,
        );
      this.spectrum.forEach((env, i) => env.set(sample.bands[i] ?? 0, this.attack, this.release));
      if (this.detector?.detect(sample)) onsets.push(sample.t);
    }
    this.move(end);
    const min = this.mod.brightness?.min ?? 0;
    return {
      brightness: this.mod.brightness
        ? min + Math.floor((((this.mod.brightness.max ?? 1000) - min) * this.brightness.value) / FULL)
        : 1000,
      tick: this.mod.motion_rate ? this.phase : end,
      onsets,
      raw: this.sample?.bands,
      bands: this.sample ? this.spectrum.map((env) => Math.floor(env.value / SCALE)) : undefined,
    };
  }

  private move(end: number): void {
    if (this.tick === undefined) {
      this.tick = end;
      return;
    }
    const start = this.tick;
    const dt = Math.max(0, end - start);
    const validEnd = this.sample ? this.sample.t + contract.timeout_ms : start;
    const active = Math.max(0, Math.min(end, validEnd) - start);
    const brightness = this.mod.brightness;
    const motion = this.mod.motion_rate;
    if (brightness) this.brightness.run(active, brightness.attack_ms ?? 0, brightness.release_ms ?? 0);
    if (motion) {
      const area = this.motion.run(active, motion.attack_ms ?? 0, motion.release_ms ?? 0);
      const min = motion.min ?? 0;
      const base = dt * min;
      const numerator = (base % 1000) * FULL + ((motion.max ?? 1000) - min) * area + this.fraction;
      this.phase = (this.phase + Math.floor(base / 1000) + Math.floor(numerator / PHASE_DENOM)) >>> 0;
      this.fraction = numerator % PHASE_DENOM;
    }
    for (const envelope of this.spectrum) envelope.run(active, this.attack, this.release);
    if (this.sample && end >= validEnd) {
      this.sample = undefined;
      this.brightness = new Envelope();
      this.motion = new Envelope();
      this.spectrum = Array.from({ length: 22 }, () => new Envelope());
      this.detector?.reset();
      this.impulse?.reset();
    }
    this.tick = end;
  }
}

export const audioSourceCode = (source: AudioSource) => sources.indexOf(source);
export const audioSourceName = (code: number): AudioSource => {
  const name = sources[code];
  if (!name) throw new Error('invalid audio source');
  return name;
};
