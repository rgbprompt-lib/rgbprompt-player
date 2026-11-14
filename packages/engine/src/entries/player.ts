// Player entry: .lep decode plus the renderer needed to step frames.
export type * from '../types.ts';
export * from '../constants.ts';
export { Renderer, simulate } from '../render.ts';
export { decode, crc32 } from '../lep.ts';
export { frameToBytes } from '../vectors.ts';
export { getPrimitiveProduct } from '../product.ts';
export {
  AUDIO_BAND_COUNT,
  AUDIO_FFT_SIZE,
  AUDIO_SMOOTHING_TIME_CONSTANT,
  AUDIO_MIN_HZ,
  AUDIO_MAX_HZ,
  analyzeAudioBands,
} from '../audio/bands.ts';

export { audioContract, getLayerInputs } from '../audio/control.ts';
