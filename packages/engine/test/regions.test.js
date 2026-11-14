import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { boardForEffect, expandSurface, loadBoard } from '../src/surfaces.ts';
import { normalize } from '../src/normalize.ts';
import { encode, decode } from '../src/lep.ts';
import { programToDsl } from '../src/roundtrip.ts';
import { loadKeyboard } from '../src/keyboard.ts';

const keys = JSON.parse(readFileSync(new URL('../../layouts/data/ansi104.cells.json', import.meta.url)));
const profile = boardForEffect({ meta: { region_profile: 'ansi104-v1' } });

function make(region, regionProfile) {
  return {
    schema: 'lep.effect/1',
    meta: {
      name: 'region',
      author: 'test',
      generator: 'human',
      seed: 7,
      ...(regionProfile ? { region_profile: regionProfile } : {}),
    },
    layer: [
      {
        id: 'L0',
        component: 'static',
        surface: { type: 'regions', regions: [region] },
        color: { type: 'solid', color: [255, 0, 0] },
        blend: 'replace',
        opacity: 255,
        params: {},
      },
    ],
  };
}

test('ANSI 104 regions use real keys and partition letters, alphas, and both halves', () => {
  assert.ok(profile.regions.letters.length > 20);
  assert.ok(profile.regions.alphas.length > 20);
  assert.deepEqual(new Set(profile.regions.letters.map(String)), new Set(profile.regions.alphas.map(String)));
  assert.ok(profile.regions.left_half.length > 10);
  assert.ok(profile.regions.right_half.length > 10);
  assert.equal(keys.ESC[0], 0);
});

test('region profiles resolve to cells; the wire carries the cells, not the profile', () => {
  const plain = make('arrows');
  const modern = make('arrows', 'ansi104-v1');
  assert.deepEqual(normalize(plain).layers[0].cells, expandSurface(plain.layer[0].surface, loadBoard()));
  const program = normalize(modern);
  program.meta = { ...(program.meta || {}), ...modern.meta };
  const decoded = decode(encode(program));
  assert.equal(programToDsl(decoded.program, decoded.meta).meta.region_profile, undefined);
  assert.deepEqual(decoded.program.layers[0].cells, program.layers[0].cells);
});

test('region invert works for legacy and ansi104 profiles', () => {
  for (const profileName of [undefined, 'ansi104-v1'])
    for (const invert of [false, true]) {
      const dsl = make('wasd', profileName);
      dsl.layer[0].surface.invert = invert;
      const cells = normalize(dsl).layers[0].cells;
      assert.ok(cells.length > 0);
    }
});

test('ansi104-v2 board loads and keyboard maps 104 keys', () => {
  const v2 = boardForEffect({ meta: { region_profile: 'ansi104-v2' } });
  assert.equal(v2.board_id, 'ansi104-v2');
  const keyboard = loadKeyboard('ansi104');
  assert.equal(keyboard.keys.length, 104);
});
