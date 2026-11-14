import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalize } from '../src/normalize.ts';
import {
  COMPOSABLE_PKG_VERSION,
  EXECUTION_FLAG,
  EXECUTION_PROFILE,
  crc32,
  decode,
  encode,
  peekPackageVersion,
} from '../src/lep.ts';

function effect(layer) {
  return {
    schema: 'lep.effect/1',
    meta: { name: 'compat', author: 'test', generator: 'human', seed: 1 },
    layer: [{ id: 'a', surface: { type: 'all' }, ...layer }],
  };
}

test('new non-audio encodes are composable package 12', () => {
  const staticLep = encode(
    normalize(effect({ component: 'static', color: { type: 'solid', rgb: [255, 0, 0] } })),
  );
  assert.equal(peekPackageVersion(staticLep), COMPOSABLE_PKG_VERSION);
  assert.equal(staticLep[11] & EXECUTION_FLAG, EXECUTION_FLAG);
  assert.equal(decode(staticLep).meta.execution_profile, EXECUTION_PROFILE);

  const spiralLep = encode(
    normalize(
      effect({
        component: 'spiral',
        params: { color_twist: 700, center_x: 500, center_y: 500 },
      }),
    ),
  );
  // Feature version 7 is below 12, so the composable container wins.
  assert.equal(peekPackageVersion(spiralLep), COMPOSABLE_PKG_VERSION);
});

test('unknown package version is rejected before CRC', () => {
  const lep = new Uint8Array(44);
  lep.set([0x4c, 0x45, 0x50, 0x31]); // LEP1
  lep[4] = 99;
  assert.throws(() => decode(lep), /incompatible package \(version 99/);
});

test('decode upgrades a flagless pre-12 package to composable-v1', () => {
  const modern = encode(
    normalize(effect({ component: 'static', color: { type: 'solid', rgb: [255, 0, 0] } })),
  );
  const legacy = new Uint8Array(modern);
  const view = new DataView(legacy.buffer);
  view.setUint16(4, 2, true); // historical static package
  legacy[11] = 0x01; // meta flag only, no execution flag
  view.setUint32(legacy.length - 4, crc32(legacy.subarray(0, legacy.length - 4)), true);
  const decoded = decode(legacy);
  assert.equal(decoded.pkgVersion, 2);
  assert.equal(decoded.meta.execution_profile, EXECUTION_PROFILE);
});
