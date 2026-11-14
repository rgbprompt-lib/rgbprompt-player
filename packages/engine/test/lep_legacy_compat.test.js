import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

import { buildCorpus } from '../../../tools/golden/corpus.mjs';
import { normalize } from '../src/normalize.ts';
import { encode, decode } from '../src/lep.ts';
import { featurePackageVersion } from '../src/codec.ts';
import { primitiveContract } from '../src/execution.ts';
import { encode as legacyEncode, decode as legacyDecode } from './fixtures/legacy-lep/lep.js';

// As of engine 0.6.0 every new encode is package 12+ with the composable
// execution flag and profile, so bytes always differ from the pre-composable
// legacy fixture encoder. The test below records that, instead of an allowlist
// of identical files.

// Layers that use a feature ported from the upstream toolchain: the legacy
// encoder predates them, so their bytes always differ and it cannot write fire.
const usesPortedFeature = (program) => program.layers.some((layer) => featurePackageVersion(layer) > 0);

// composable-v1 reads the trigger argument as the input scope of a selectable key
// layer (0 = every key, the legacy behaviour) and as nothing elsewhere.
function composableTriggers(decoded) {
  for (const layer of decoded.program.layers) {
    const { type } = layer.trigger;
    const lifecycle = layer.component === 'reactive' && layer.params?.color_mode === 'lifecycle';
    layer.trigger =
      primitiveContract(layer.component)?.inputScope === 'selectable' && !lifecycle
        ? { type, scope: 'all' }
        : { type };
  }
  return decoded;
}

test('legacy v2 bytes decode as the legacy decoder did, with composable triggers', () => {
  for (const entry of buildCorpus()) {
    const program = normalize(entry.effect);
    if (usesPortedFeature(program)) continue;
    const legacyBytes = legacyEncode(program);
    assert.deepEqual(decode(legacyBytes), composableTriggers(legacyDecode(legacyBytes)), entry.id);
  }
});

test('new encodes differ from the pre-composable legacy encoder', () => {
  for (const entry of buildCorpus()) {
    const program = normalize(entry.effect);
    if (usesPortedFeature(program)) continue;
    const bytes = encode(program);
    assert.equal(
      Buffer.from(bytes).equals(legacyEncode(program)),
      false,
      `${entry.id}: expected package-12 composable bytes to differ from the legacy encoder`,
    );
    assert.ok(bytes[4] >= 12 || bytes[4] === 14 || bytes[4] === 15, `${entry.id}: pkg ${bytes[4]}`);
    assert.equal(bytes[11] & 2, 2, `${entry.id}: execution flag`);
  }
});
