// Cost bench for the reference renderer (ENGINE.md §11, budget 0.2 ms/frame).
//
// Renders every corpus case once to find the heaviest one, then a synthetic
// eight-layer worst case, both for 10 s at 20 ms. This script is intentionally
// not part of `pnpm check`.
import { normalize, simulate, validate } from '@rgbprompt/engine';

import { buildCorpus } from './corpus.mjs';

const DURATION_MS = 10_000;
const STEP_MS = 20;
const FRAMES = Math.ceil(DURATION_MS / STEP_MS);
const BUDGET_MS_PER_FRAME = 0.2;

function timeSimulation(program, inputs) {
  const start = process.hrtime.bigint();
  simulate(
    program,
    {
      ticks: FRAMES,
      stepMs: STEP_MS,
      keyEvents: inputs.keyEvents || [],
      audio: inputs.audio || [],
    },
    () => {},
  );
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  return { ms, perFrame: ms / FRAMES };
}

function compile(effect) {
  const report = validate(effect);
  if (!report.ok) {
    const details = report.errors
      .map((issue) => `${issue.path ? `${issue.path}: ` : ''}${issue.message}`)
      .join('; ');
    throw new Error(details);
  }
  return normalize(effect);
}

function heaviestCorpusCase() {
  let heaviest = null;
  for (const entry of buildCorpus()) {
    const program = compile(entry.effect);
    const timing = timeSimulation(program, entry.inputs);
    if (!heaviest || timing.perFrame > heaviest.timing.perFrame) {
      heaviest = { id: entry.id, timing };
    }
  }
  return heaviest;
}

function syntheticEightLayers() {
  const solid = (rgb) => ({ type: 'solid', rgb });
  const layers = [
    { id: 'l0', component: 'static', color: solid([10, 20, 30]) },
    {
      id: 'l1',
      component: 'breath',
      params: { period_ms: 1700, min_level: 20 },
      color: solid([40, 90, 160]),
    },
    {
      id: 'l2',
      component: 'drift',
      params: { period_ms: 9000, count: 8, size: 3, motion: 'vertical', wobble: 2 },
    },
    { id: 'l3', component: 'sparkle', params: { rate: 30, decay_ms: 800 } },
    {
      id: 'l4',
      component: 'ring',
      params: { period_ms: 700, life_ms: 2000, max_radius: 6, width: 2 },
    },
    { id: 'l5', component: 'reactive', params: { speed: 2, palette: 'rainbow24' }, blend: 'add' },
    {
      id: 'l6',
      component: 'spectrum',
      params: { gain: 255, dense: true, peak_ms: 300, beat: true },
      blend: 'add',
    },
    { id: 'l7', component: 'aurora', params: { speed: 2 }, blend: 'max' },
  ].map((layer) => ({ surface: { type: 'all' }, ...layer }));
  const effect = {
    schema: 'lep.effect/1',
    meta: { name: 'worst eight', author: 'bench', generator: 'human', seed: 7 },
    layer: layers,
  };
  const audio = Array.from({ length: FRAMES }, (_, i) => ({
    tick: i * STEP_MS,
    bands: Array.from({ length: 22 }, (_, b) => (i * 7 + b * 13) % 256),
  }));
  const keyEvents = Array.from({ length: 8 }, (_, i) => ({
    tick: 137 + i * 700,
    type: i % 2 ? 'up' : 'down',
    cell: `2,${3 + (i % 5)}`,
  }));
  return { program: compile(effect), inputs: { keyEvents, audio } };
}

function report(label, timing) {
  const status = timing.perFrame <= BUDGET_MS_PER_FRAME ? 'pass' : 'fail';
  console.log(
    `${label}: ${timing.ms.toFixed(2)} ms / ${DURATION_MS} ms, ` +
      `${timing.perFrame.toFixed(4)} ms/frame (budget ${BUDGET_MS_PER_FRAME}, ${status})`,
  );
  return status === 'pass';
}

const heaviest = heaviestCorpusCase();
const synthetic = syntheticEightLayers();
const corpusOk = report(`corpus heaviest (${heaviest.id})`, heaviest.timing);
const syntheticOk = report('synthetic 8 layers', timeSimulation(synthetic.program, synthetic.inputs));
if (!corpusOk || !syntheticOk) process.exitCode = 1;
