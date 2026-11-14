export const AUDIO_BAND_COUNT = 22;
export const AUDIO_FFT_SIZE = 2048;
export const AUDIO_SMOOTHING_TIME_CONSTANT = 0.8;
export const AUDIO_MIN_HZ = 40;
export const AUDIO_MAX_HZ = 16000;

function bandLowHz(sampleRate: number): number {
  const nyquist = sampleRate > 0 ? sampleRate / 2 : AUDIO_MAX_HZ;
  return Math.min(AUDIO_MIN_HZ, nyquist / 2);
}

function bandHighHz(sampleRate: number): number {
  const nyquist = sampleRate > 0 ? sampleRate / 2 : AUDIO_MAX_HZ;
  return Math.min(AUDIO_MAX_HZ, nyquist);
}

export function audioBandEdgesHz(sampleRate: number, fftSize: number = AUDIO_FFT_SIZE): number[] {
  void fftSize;
  const low = bandLowHz(sampleRate);
  const high = Math.max(low * 1.001, bandHighHz(sampleRate));
  const ratio = Math.pow(high / low, 1 / AUDIO_BAND_COUNT);
  const edges = new Array<number>(AUDIO_BAND_COUNT + 1);
  for (let index = 0; index <= AUDIO_BAND_COUNT; index++) edges[index] = low * Math.pow(ratio, index);
  edges[0] = low;
  edges[AUDIO_BAND_COUNT] = high;
  return edges;
}

export function audioBandForFrequency(
  hz: number,
  sampleRate: number,
  fftSize: number = AUDIO_FFT_SIZE,
): number {
  if (!(hz > 0)) return 0;
  const edges = audioBandEdgesHz(sampleRate, fftSize);
  const low = edges[0] as number;
  const high = edges[AUDIO_BAND_COUNT] as number;
  if (hz <= low) return 0;
  if (hz >= high) return AUDIO_BAND_COUNT - 1;
  const ratio = Math.log(hz / low) / Math.log(high / low);
  const band = Math.floor(ratio * AUDIO_BAND_COUNT);
  return Math.max(0, Math.min(AUDIO_BAND_COUNT - 1, band));
}

export function analyzeAudioBands(
  spectrum: Uint8Array,
  sampleRate: number,
  fftSize: number = AUDIO_FFT_SIZE,
): number[] {
  const bands = new Array<number>(AUDIO_BAND_COUNT).fill(0);
  if (spectrum.length === 0 || !(sampleRate > 0) || !(fftSize > 0)) return bands;

  const binCount = Math.min(spectrum.length, fftSize >> 1);
  const binHz = sampleRate / fftSize;
  const edges = audioBandEdgesHz(sampleRate, fftSize);

  for (let band = 0; band < AUDIO_BAND_COUNT; band++) {
    const from = Math.max(0, Math.floor((edges[band] as number) / binHz));
    const to = Math.min(binCount, Math.max(from + 1, Math.ceil((edges[band + 1] as number) / binHz)));
    let peak = 0;
    for (let bin = from; bin < to; bin++) {
      const value = spectrum[bin] as number;
      if (value > peak) peak = value;
    }
    bands[band] = peak;
  }

  return bands;
}
