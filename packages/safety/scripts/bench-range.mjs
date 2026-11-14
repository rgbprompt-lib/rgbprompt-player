// Bench for safeRange (FLASH-SAFETY.md §4.3): target <= 150 ms per call.
// Picks the heaviest corpus effect that has a speed control, then samples 20
// calls and reports P95. Not part of `pnpm check`.
import { getPrimitiveProduct, normalize, simulate } from '@rgbprompt/engine';
import { buildCorpus } from '../../../tools/golden/corpus.mjs';
import { safeRange } from '../src/index.ts';

const FRAMES = 250;
const STEP_MS = 40;
const RUNS = 20;
const BUDGET_MS = 150;

function speedLayerId(effect) {
  for (const layer of effect.layer ?? []) {
    if (layer.enabled === false) continue;
    const product = getPrimitiveProduct(layer.component);
    if (product && product.speed.params.length > 0) return layer.id;
  }
  return null;
}

function simulationMs(entry) {
  const program = normalize(entry.effect);
  const start = process.hrtime.bigint();
  simulate(program, {
    ticks: FRAMES,
    stepMs: STEP_MS,
    keyEvents: entry.inputs.keyEvents ?? [],
    audio: entry.inputs.audio ?? [],
  });
  return Number(process.hrtime.bigint() - start) / 1e6;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[index];
}

let heaviest = null;
for (const entry of buildCorpus()) {
  const layerId = speedLayerId(entry.effect);
  if (!layerId) continue;
  const ms = simulationMs(entry);
  if (!heaviest || ms > heaviest.ms) heaviest = { ...entry, layerId, ms };
}
if (!heaviest) throw new Error('no corpus effect with a speed control');

for (let index = 0; index < 3; index++) safeRange(heaviest.effect, heaviest.layerId, 'speed');

const times = [];
for (let index = 0; index < RUNS; index++) {
  const start = process.hrtime.bigint();
  safeRange(heaviest.effect, heaviest.layerId, 'speed');
  times.push(Number(process.hrtime.bigint() - start) / 1e6);
}

const p95 = percentile(times, 0.95);
const median = percentile(times, 0.5);
console.log(
  `safeRange on ${heaviest.id} (layer ${heaviest.layerId}): ` +
    `P50 ${median.toFixed(1)} ms, P95 ${p95.toFixed(1)} ms ` +
    `(budget ${BUDGET_MS} ms, ${p95 <= BUDGET_MS ? 'pass' : 'fail'})`,
);
if (p95 > BUDGET_MS) process.exitCode = 1;
