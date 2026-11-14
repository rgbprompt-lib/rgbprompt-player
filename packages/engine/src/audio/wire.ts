import { audioContract, audioSourceCode, audioSourceName, isImpulse, usesFlux } from './control.ts';
import type { AudioBinding, AudioOnset, AudioModulation, AudioOnsetOptions } from './control.ts';

// Audio segment. bit0 brightness, bit1 motion_rate, bit2 audio_onset (v14);
// bit3 onset detector record, bit4 brightness impulse record (v15).
type Fields = { audio_mod?: AudioModulation; playback?: AudioOnset };
const targets = ['brightness', 'motion_rate'] as const;
const BINDING_SIZE = 9;
const ONSET_SIZE = 5;
const DETECTOR_SIZE = 2;
const IMPULSE_SIZE = 6;
const FLUX_CODE = audioContract.detectors.indexOf('flux');

type OnsetRecord = [number, number, number, number, number, number];
function onsetRecord(config: AudioOnsetOptions): OnsetRecord {
  const d = audioContract.onset,
    flux = usesFlux(config),
    interval = config.min_interval_ms ?? d.min_interval_ms;
  return [
    flux ? FLUX_CODE : 0,
    flux ? (config.sensitivity ?? audioContract.flux.sensitivity) : 0,
    flux ? d.threshold : (config.threshold ?? d.threshold),
    flux ? d.hysteresis : (config.hysteresis ?? d.hysteresis),
    interval & 255,
    interval >> 8,
  ];
}

function decodedOnset(bytes: number[], interval: number): AudioOnsetOptions {
  const [detector, sensitivity, threshold, hysteresis] = bytes as [number, number, number, number];
  const d = audioContract.onset;
  if (detector === FLUX_CODE) {
    if (threshold !== d.threshold || hysteresis !== d.hysteresis) throw new Error('invalid impulse record');
    return { detector: 'flux', sensitivity, min_interval_ms: interval };
  }
  if (detector !== 0 || sensitivity) throw new Error('invalid impulse record');
  return { detector: 'level', threshold, hysteresis, min_interval_ms: interval };
}

export function encodeAudio(fields: Fields): Uint8Array {
  const bright = fields.audio_mod?.brightness,
    motion = fields.audio_mod?.motion_rate;
  const onset = fields.playback;
  const flux = !!onset && usesFlux(onset),
    impulse = isImpulse(bright);
  const flags = (bright ? 1 : 0) | (motion ? 2 : 0) | (onset ? 4 : 0) | (flux ? 8 : 0) | (impulse ? 16 : 0);
  const bytes = new Uint8Array(
    1 +
      (Number(!!bright) + Number(!!motion)) * BINDING_SIZE +
      Number(!!onset) * ONSET_SIZE +
      Number(flux) * DETECTOR_SIZE +
      Number(impulse) * IMPULSE_SIZE,
  );
  const view = new DataView(bytes.buffer);
  bytes[0] = flags;
  let pos = 1;
  for (const value of [bright, motion]) {
    if (!value) continue;
    view.setUint8(pos, audioSourceCode(value.source));
    view.setUint16(pos + 1, value.attack_ms ?? 0, true);
    view.setUint16(pos + 3, value.release_ms ?? 0, true);
    view.setUint16(pos + 5, value.min ?? 0, true);
    view.setUint16(pos + 7, value.max ?? 1000, true);
    pos += BINDING_SIZE;
  }
  if (onset) {
    const record = onsetRecord(onset);
    view.setUint8(pos, audioSourceCode(onset.source));
    view.setUint8(pos + 1, record[2]);
    view.setUint8(pos + 2, record[3]);
    view.setUint16(pos + 3, onset.min_interval_ms ?? audioContract.onset.min_interval_ms, true);
    pos += ONSET_SIZE;
    if (flux) {
      bytes.set(record.slice(0, 2), pos);
      pos += DETECTOR_SIZE;
    }
  }
  if (bright && impulse) bytes.set(onsetRecord(bright), pos);
  return bytes;
}

/** `v15` allows the detector and impulse records (package version 15). */
export function decodeAudio(view: DataView, offset: number, v15 = false): { fields: Fields; offset: number } {
  const flags = view.getUint8(offset++);
  if (!flags || flags & ~(v15 ? 31 : 7) || (flags & 8 && !(flags & 4)) || (flags & 16 && !(flags & 1)))
    throw new Error('invalid audio extension flags');
  const fields: Fields = {};
  const end = view.byteLength - 4;
  targets.forEach((target, i) => {
    if (!(flags & (1 << i))) return;
    if (offset + BINDING_SIZE > end) throw new Error('truncated audio binding');
    const binding: AudioBinding = {
      source: audioSourceName(view.getUint8(offset)),
      attack_ms: view.getUint16(offset + 1, true),
      release_ms: view.getUint16(offset + 3, true),
      min: view.getUint16(offset + 5, true),
      max: view.getUint16(offset + 7, true),
    };
    fields.audio_mod ??= {};
    fields.audio_mod[target] = binding;
    offset += BINDING_SIZE;
  });
  if (flags & 4) {
    if (offset + ONSET_SIZE > end) throw new Error('truncated audio onset');
    fields.playback = {
      start: 'audio_onset',
      source: audioSourceName(view.getUint8(offset)),
      threshold: view.getUint8(offset + 1),
      hysteresis: view.getUint8(offset + 2),
      min_interval_ms: view.getUint16(offset + 3, true),
    };
    offset += ONSET_SIZE;
  }
  if (flags & 8) {
    if (offset + DETECTOR_SIZE > end) throw new Error('truncated onset detector');
    // Reason: flag bit 8 requires bit 4, checked above, so the onset record was read.
    const p = fields.playback as AudioOnset,
      d = audioContract.onset;
    if (view.getUint8(offset) !== FLUX_CODE || p.threshold !== d.threshold || p.hysteresis !== d.hysteresis)
      throw new Error('invalid onset detector record');
    fields.playback = {
      start: 'audio_onset',
      source: p.source,
      detector: 'flux',
      sensitivity: view.getUint8(offset + 1),
      min_interval_ms: p.min_interval_ms ?? d.min_interval_ms,
    };
    offset += DETECTOR_SIZE;
  }
  if (flags & 16) {
    if (offset + IMPULSE_SIZE > end) throw new Error('truncated audio impulse');
    const record = [0, 1, 2, 3].map((i) => view.getUint8(offset + i));
    const onset = decodedOnset(record, view.getUint16(offset + 4, true));
    // Reason: flag bit 16 requires bit 1, checked above, so brightness was read.
    const mod = fields.audio_mod as AudioModulation;
    mod.brightness = { ...(mod.brightness as AudioBinding), trigger: 'onset', ...onset };
    offset += IMPULSE_SIZE;
  }
  return { fields, offset };
}
