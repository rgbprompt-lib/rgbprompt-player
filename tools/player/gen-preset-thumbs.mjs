#!/usr/bin/env node
// Render one representative frame of every bundled Player preset with the
// shared engine and write the per-key colours (ANSI104_KEYS order, the same
// order as rgbp_preview_frame) to Resources/Presets/thumbnails.json. The panel
// draws its preset swatches from this file, so they match what the keyboard
// shows. Key presets use the safety typing script; sound presets get a
// simulated music signal (kick, bass line, mids and hats over 22 bands).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decode, getLayerInputs, simulate } from '../../packages/engine/src/index.ts';
import { frameToKeyRgb } from '../../packages/layouts/src/ansi104.ts';
import { buildInputScript } from '../../packages/safety/src/input-scripts.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = join(ROOT, 'apps/player-mac/Resources/Presets');
const STEP_MS = 40;
const TICKS = 200; // 8 s
const BANDS = 22;

const manifest = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8'));
const out = { version: 2, order: 'ANSI104_KEYS', presets: {} };

// Deterministic "music": 120 BPM kick, a slow melodic sweep across the mids and
// off-beat hats, with a natural falling spectrum.
function musicScript(ticks) {
  const beatMs = 500;
  const events = [];
  for (let t = 0; t < ticks; t++) {
    const ms = t * STEP_MS;
    const phase = ms % beatMs;
    const kick = Math.exp(-phase / 140);
    const hat = Math.exp(-((ms + beatMs / 2) % beatMs) / 60);
    const bands = [];
    for (let b = 0; b < BANDS; b++) {
      let v = 150 * Math.exp(-b / 10) + 25;
      if (b < 5) v += 105 * kick;
      if (b >= 4 && b < 15) v += 70 * Math.max(0, Math.sin(ms / 420 + b * 0.55));
      if (b >= 15) v += 80 * hat;
      bands.push(Math.max(0, Math.min(255, Math.round(v))));
    }
    events.push({ tick: ms, bands });
  }
  return events;
}

function stats(f) {
  const n = f.length / 3;
  let sum = 0;
  let sumSq = 0;
  for (let k = 0; k < n; k++) {
    const l = (f[k * 3] + f[k * 3 + 1] + f[k * 3 + 2]) / 3;
    sum += l;
    sumSq += l * l;
  }
  const mean = sum / n;
  return { mean, std: Math.sqrt(Math.max(0, sumSq / n - mean * mean)) };
}

for (const preset of manifest.presets) {
  const decoded = decode(new Uint8Array(readFileSync(join(DIR, preset.file))));
  const program = decoded.program ?? decoded;
  let typing = false;
  let audio = false;
  for (const layer of program.layer ?? program.layers ?? []) {
    if (layer.enabled === false) continue;
    const inputs = getLayerInputs(layer);
    typing ||= inputs.key;
    audio ||= inputs.audio;
  }
  const keys = buildInputScript({ durationMs: TICKS * STEP_MS, typing, audio: false });
  const frames = simulate(program, {
    ticks: TICKS,
    stepMs: STEP_MS,
    keyEvents: keys.keyEvents,
    audio: audio ? musicScript(TICKS) : [],
  }).map((frame) => frameToKeyRgb(frame));

  // Skip the first 2 s (fade-in); keep the brightest, most varied frame.
  let bestIndex = frames.length - 1;
  let bestScore = -1;
  for (let i = 50; i < frames.length; i++) {
    const { mean, std } = stats(frames[i]);
    const score = mean * 0.6 + std;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  let rgb = Array.from(frames[bestIndex]);
  let mode = 'frame';
  // Sparse effects (a few sparkles per frame) read as black in one frame:
  // composite the per-key maximum over the whole sampled window instead.
  if (stats(frames[bestIndex]).mean < 30) {
    const from = 50;
    const to = frames.length;
    rgb = rgb.map((_, i) => {
      let max = 0;
      for (let f = from; f < to; f++) max = Math.max(max, frames[f][i]);
      return max;
    });
    mode = 'max-6s';
  }
  out.presets[preset.id] = { needsKeys: typing, needsAudio: audio, rgb };
  const s = stats(Uint8Array.from(rgb));
  console.log(
    `${preset.id}: keys=${typing} audio=${audio} frame=${bestIndex} mode=${mode} mean=${s.mean.toFixed(0)} std=${s.std.toFixed(0)}`,
  );
}

writeFileSync(join(DIR, 'thumbnails.json'), `${JSON.stringify(out)}\n`);
console.log(`wrote ${join(DIR, 'thumbnails.json')}`);
