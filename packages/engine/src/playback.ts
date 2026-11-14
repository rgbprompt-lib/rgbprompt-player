// Shared layer lifecycle. Component simulation uses the returned local clock.
import type { LayerDsl, SurfaceDsl } from './types.ts';

export const PLAYBACK_COMPONENTS = new Set([
  'static',
  'gradient',
  'breath',
  'blink',
  'rainbow_wave',
  'wave',
  'scroll',
  'spiral',
  'sparkle',
]);
export const PLAY_START = { auto: 0, key_press: 1, selected_press: 2 } as const;
export const PLAY_STOP = { natural: 0, key_press: 1, selected_press: 2 } as const;
export const PLAY_RETRIGGER = { restart: 0, ignore: 1 } as const;
export const PLAYBACK_TIME_FLAG = 0x80;

export const hasAudioOnsetPlayback = (layer: { playback?: { start?: string } | null }): boolean =>
  layer.playback?.start === 'audio_onset';

export const hasPlayback = (layer: { playback?: unknown }): boolean =>
  layer.playback !== undefined && !hasAudioOnsetPlayback(layer as { playback?: { start?: string } });

export function playbackErrors(layer: LayerDsl): string[] {
  if (!hasPlayback(layer)) return [];
  const p = layer.playback as Record<string, unknown> | undefined;
  const errors: string[] = [];
  if (!p || typeof p !== 'object' || Array.isArray(p)) return ['playback must be an object'];
  if (
    !PLAYBACK_COMPONENTS.has(layer.component) ||
    (layer.component === 'sparkle' && layer.params?.clock !== 'time')
  )
    errors.push('playback requires a supported stateless component; sparkle requires clock:time');
  if (layer.color && ['random', 'from_input'].includes(layer.color.type))
    errors.push('playback requires deterministic colors');
  const normalized =
    Array.isArray((layer as { mask?: unknown }).mask) && Array.isArray((layer as { cells?: unknown }).cells);
  const allowed = [
    'start',
    'stop',
    'retrigger',
    'duration_ms',
    'cycles',
    'pause_ms',
    'input',
    ...(normalized ? ['inputMask'] : []),
  ];
  for (const key of Object.keys(p)) if (!allowed.includes(key)) errors.push('unknown playback field ' + key);
  if (!Object.hasOwn(PLAY_START, (p.start as string | undefined) ?? 'auto'))
    errors.push('invalid playback.start');
  if (!Object.hasOwn(PLAY_STOP, (p.stop as string | undefined) ?? 'natural'))
    errors.push('invalid playback.stop');
  if (!Object.hasOwn(PLAY_RETRIGGER, (p.retrigger as string | undefined) ?? 'restart'))
    errors.push('invalid playback.retrigger');
  for (const [key, min, max, fallback] of [
    ['duration_ms', 1, 65535, undefined],
    ['cycles', 0, 255, 1],
    ['pause_ms', 0, 65535, 0],
  ] as const) {
    const value = (p[key] as number | undefined) ?? fallback;
    if (!Number.isInteger(value) || (value as number) < min || (value as number) > max)
      errors.push('invalid playback.' + key);
  }
  const selected = p.start === 'selected_press' || p.stop === 'selected_press';
  if (
    p.input !== undefined &&
    (!selected || !p.input || typeof p.input !== 'object' || Array.isArray(p.input))
  )
    errors.push('playback.input requires a selected_press event and a surface');
  const input = (p.input ?? (!normalized ? layer.surface : undefined)) as SurfaceDsl | undefined;
  if (selected && input && typeof input === 'object' && !Array.isArray(input)) {
    const fields = (
      { all: [], cells: ['cells'], regions: ['regions'], rows: ['rows'], cols: ['cols'] } as Record<
        string,
        string[]
      >
    )[input.type];
    if (
      !fields ||
      Object.keys(input).some((key) => !['type', 'invert', ...fields].includes(key)) ||
      (input.invert !== undefined && typeof input.invert !== 'boolean')
    )
      errors.push('invalid playback input surface fields');
  }
  const inputMask = p.inputMask as number[] | undefined;
  if (
    normalized &&
    inputMask !== undefined &&
    (!Array.isArray(inputMask) ||
      inputMask.length !== 22 ||
      inputMask.some((value) => !Number.isInteger(value) || value < 0 || value > 63) ||
      (!selected && inputMask.some(Boolean)) ||
      (selected && !inputMask.some(Boolean)))
  )
    errors.push('invalid playback input mask');
  if (
    layer.time &&
    (layer.time.type !== 'static' ||
      Object.keys(layer.time).some(
        (key) =>
          ![
            'type',
            'phase_ms',
            ...(['breath', 'blink'].includes(layer.component) ? ['easing'] : []),
          ].includes(key),
      ))
  )
    errors.push('playback accepts static component time with supported phase/easing only');
  if (
    layer.time?.phase_ms !== undefined &&
    (!Number.isInteger(layer.time.phase_ms) ||
      layer.time.phase_ms < 0 ||
      layer.time.phase_ms > 65535 ||
      (!['breath', 'blink', 'rainbow_wave'].includes(layer.component) && layer.time.phase_ms !== 0))
  )
    errors.push('unsupported playback component phase');
  if (
    layer.trigger &&
    (layer.trigger.type !== 'always' || Object.keys(layer.trigger).some((key) => key !== 'type'))
  )
    errors.push('playback uses its own start/stop; component trigger must be pure always');
  if (layer.frames !== undefined && layer.frames !== null) errors.push('playback does not accept frames');
  return errors;
}

export class PlaybackState {
  seen = false;
  running = false;
  age = 0;
  last = 0;
  hold(tick: number): void {
    if (this.seen) this.last = tick >>> 0;
  }
  step(
    tick: number,
    config: Record<string, unknown>,
    pressed: ReadonlySet<string> = new Set(),
  ): number | null {
    tick = tick >>> 0;
    const duration = config.duration_ms as number;
    const pause = (config.pause_ms as number | undefined) ?? 0;
    const cycles = (config.cycles as number | undefined) ?? 1;
    const stride = duration + pause;
    const end = cycles ? cycles * stride - pause : 0;
    if (!this.seen || (tick - this.last) >>> 0 > 0x7fffffff) {
      this.seen = true;
      this.running = ((config.start as string | undefined) ?? 'auto') === 'auto';
      this.age = 0;
    } else if (this.running) {
      const delta = (tick - this.last) >>> 0;
      if (cycles) {
        this.age += Math.min(delta, end - this.age);
        if (this.age >= end) this.running = false;
      } else this.age = (this.age + (delta % stride)) % stride;
    }
    this.last = tick;
    let any = false;
    let selected = false;
    const inputMask = config.inputMask as number[] | undefined;
    for (const key of pressed) {
      const parts = key.split(',').map(Number);
      const row = parts[0];
      const col = parts[1];
      if (
        row !== undefined &&
        col !== undefined &&
        Number.isInteger(row) &&
        row >= 0 &&
        row < 6 &&
        Number.isInteger(col) &&
        col >= 0 &&
        col < 22
      ) {
        any = true;
        if ((inputMask?.[col] as number) & (1 << row)) selected = true;
      }
    }
    const event = (mode: unknown) =>
      mode === 'key_press' ? any : mode === 'selected_press' ? selected : false;
    if (this.running && event((config.stop as string | undefined) ?? 'natural')) this.running = false;
    else if (
      event((config.start as string | undefined) ?? 'auto') &&
      (!this.running || ((config.retrigger as string | undefined) ?? 'restart') === 'restart')
    ) {
      this.running = true;
      this.age = 0;
    }
    const local = this.age % stride;
    return this.running && local < duration ? local : null;
  }
}
