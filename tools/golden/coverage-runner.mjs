// Coverage runner for `golden:coverage`.
//
// Renders the same cases as `golden` verify, with the same inputs and the same
// 20 ms step. Nothing else is rendered: a line only counts as covered when a
// committed vector actually exercises it.
import { buildCorpus } from './corpus.mjs';
import { renderFrames } from './lib.mjs';

for (const entry of buildCorpus()) {
  renderFrames(entry.effect, { inputs: entry.inputs });
}
