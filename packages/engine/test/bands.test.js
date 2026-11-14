import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUDIO_BAND_COUNT,
  AUDIO_FFT_SIZE,
  AUDIO_SMOOTHING_TIME_CONSTANT,
  analyzeAudioBands,
  audioBandEdgesHz,
  audioBandForFrequency,
} from '../src/audio/bands.ts';

const SAMPLE_RATE = 48000;

function spectrumOfSize(fftSize = AUDIO_FFT_SIZE) {
  return new Uint8Array(fftSize >> 1);
}

test('band constants match the browser analyser contract', () => {
  assert.equal(AUDIO_BAND_COUNT, 22);
  assert.equal(AUDIO_FFT_SIZE, 2048);
  assert.equal(AUDIO_SMOOTHING_TIME_CONSTANT, 0.8);
});

test('silence produces 22 zero bands', () => {
  const bands = analyzeAudioBands(spectrumOfSize(), SAMPLE_RATE, AUDIO_FFT_SIZE);
  assert.equal(bands.length, AUDIO_BAND_COUNT);
  assert.deepEqual(bands, new Array(AUDIO_BAND_COUNT).fill(0));
});

test('band edges are log-spaced from low to high', () => {
  const edges = audioBandEdgesHz(SAMPLE_RATE, AUDIO_FFT_SIZE);
  assert.equal(edges.length, AUDIO_BAND_COUNT + 1);
  assert.equal(edges[0], 40);
  assert.equal(edges[AUDIO_BAND_COUNT], 16000);
  for (let index = 1; index < edges.length; index++) {
    assert.ok(edges[index] > edges[index - 1]);
  }
});

test('a single tone lands in its expected band', () => {
  const binHz = SAMPLE_RATE / AUDIO_FFT_SIZE;
  const toneHz = 1000;
  const spectrum = spectrumOfSize();
  spectrum[Math.round(toneHz / binHz)] = 255;

  const bands = analyzeAudioBands(spectrum, SAMPLE_RATE, AUDIO_FFT_SIZE);
  const expected = audioBandForFrequency(toneHz, SAMPLE_RATE, AUDIO_FFT_SIZE);

  assert.equal(expected, 11);
  assert.equal(bands[expected], 255);
  assert.equal(
    bands.reduce((sum, value) => sum + value, 0),
    255,
  );
});

test('a high tone lands in the rightmost band and a low tone in the leftmost', () => {
  const binHz = SAMPLE_RATE / AUDIO_FFT_SIZE;
  const low = spectrumOfSize();
  low[Math.round(45 / binHz)] = 200;
  const high = spectrumOfSize();
  high[Math.round(15000 / binHz)] = 210;

  assert.equal(analyzeAudioBands(low, SAMPLE_RATE, AUDIO_FFT_SIZE)[0], 200);
  assert.equal(analyzeAudioBands(high, SAMPLE_RATE, AUDIO_FFT_SIZE)[AUDIO_BAND_COUNT - 1], 210);
});

test('full-scale noise saturates every band', () => {
  const spectrum = spectrumOfSize().fill(255);
  const bands = analyzeAudioBands(spectrum, SAMPLE_RATE, AUDIO_FFT_SIZE);
  assert.deepEqual(bands, new Array(AUDIO_BAND_COUNT).fill(255));
});

test('degenerate analyser inputs stay silent instead of throwing', () => {
  assert.deepEqual(analyzeAudioBands(new Uint8Array(0), SAMPLE_RATE, AUDIO_FFT_SIZE), new Array(22).fill(0));
  assert.deepEqual(analyzeAudioBands(spectrumOfSize(), 0, AUDIO_FFT_SIZE), new Array(22).fill(0));
  assert.deepEqual(analyzeAudioBands(spectrumOfSize(), SAMPLE_RATE, 0), new Array(AUDIO_BAND_COUNT).fill(0));
});
