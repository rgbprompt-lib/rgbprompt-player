#!/usr/bin/env node
// Render every golden case through the public player IIFE and compare each
// frame's CRC32 with the committed vector. The TypeScript engine must match
// the same vector, so the bundle and the source cannot drift quietly.
//
// Uses only this repository: packages/engine/dist/player/engine.iife.js, the
// golden corpus, and tools/golden/vectors. It does not load a website prompt
// bundle.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { crc32, decode, encode, frameToBytes, normalize, simulate, validate } from '@rgbprompt/engine';

import { buildCorpus } from './corpus.mjs';
import { DURATION_MS, STEP_MS, firstCrcDifference, vectorPath } from './lib.mjs';

const PLAYER_BUNDLE = fileURLToPath(
  new URL('../../packages/engine/dist/player/engine.iife.js', import.meta.url),
);
const TICKS = Math.ceil(DURATION_MS / STEP_MS);
const REQUIRED_EXPORTS = ['decode', 'simulate', 'crc32', 'frameToBytes'];

function fail(message) {
  console.error(`player:iife: ${message}`);
  process.exitCode = 1;
}

function renderNode(program, inputs) {
  const crcs = [];
  const hash = createHash('sha256');
  simulate(
    program,
    {
      ticks: TICKS,
      stepMs: STEP_MS,
      keyEvents: inputs.keyEvents || [],
      audio: inputs.audio || [],
    },
    (_index, frame) => {
      const bytes = frameToBytes(frame);
      crcs.push(crc32(bytes));
      hash.update(bytes);
    },
  );
  return { crcs, sha256: hash.digest('hex') };
}

function loadPlayer(bundle) {
  const context = {
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    TextEncoder: globalThis.TextEncoder,
    TextDecoder: globalThis.TextDecoder,
    Uint8Array: globalThis.Uint8Array,
    Uint16Array: globalThis.Uint16Array,
    Uint32Array: globalThis.Uint32Array,
    Int8Array: globalThis.Int8Array,
    Int16Array: globalThis.Int16Array,
    Int32Array: globalThis.Int32Array,
    Float32Array: globalThis.Float32Array,
    Float64Array: globalThis.Float64Array,
    ArrayBuffer: globalThis.ArrayBuffer,
    DataView: globalThis.DataView,
    Math: globalThis.Math,
    JSON: globalThis.JSON,
    Date: globalThis.Date,
    Map: globalThis.Map,
    Set: globalThis.Set,
    WeakMap: globalThis.WeakMap,
    WeakSet: globalThis.WeakSet,
    Promise: globalThis.Promise,
    Symbol: globalThis.Symbol,
    Object: globalThis.Object,
    Array: globalThis.Array,
    String: globalThis.String,
    Number: globalThis.Number,
    Boolean: globalThis.Boolean,
    Error: globalThis.Error,
    TypeError: globalThis.TypeError,
    RangeError: globalThis.RangeError,
    parseInt: globalThis.parseInt,
    parseFloat: globalThis.parseFloat,
    isNaN: globalThis.isNaN,
    isFinite: globalThis.isFinite,
    undefined,
  };
  context.globalThis = context;
  context.global = context;
  context.self = context;
  vm.createContext(context);
  vm.runInContext(bundle, context, { filename: 'engine.iife.js' });
  const engine = context.RGBPromptEngine;
  if (!engine || typeof engine !== 'object') {
    throw new Error('player IIFE did not set RGBPromptEngine');
  }
  for (const name of REQUIRED_EXPORTS) {
    if (typeof engine[name] !== 'function') {
      throw new Error(`player IIFE is missing ${name}`);
    }
  }
  return context;
}

function renderIife(context, bytes, inputs) {
  context.__bytes = Array.from(bytes);
  context.__inputs = inputs;
  const crcs = vm.runInContext(
    `(function () {
      var E = RGBPromptEngine;
      var decoded = E.decode(new Uint8Array(__bytes));
      var inputs = __inputs;
      var crcs = [];
      E.simulate(
        decoded.program,
        {
          ticks: ${TICKS},
          stepMs: ${STEP_MS},
          keyEvents: inputs.keyEvents || [],
          audio: inputs.audio || [],
        },
        function (_index, frame) {
          crcs.push(E.crc32(E.frameToBytes(frame)));
        },
      );
      return crcs;
    })()`,
    context,
  );
  return Array.from(crcs, (value) => Number(value));
}

function main() {
  if (!existsSync(PLAYER_BUNDLE)) {
    fail(`missing ${PLAYER_BUNDLE}; run \`corepack pnpm --filter @rgbprompt/engine build\` first`);
    return;
  }

  const bundle = readFileSync(PLAYER_BUNDLE, 'utf8');
  if (bundle.includes('sourceMappingURL')) {
    fail('player IIFE contains a source map URL');
    return;
  }

  let context;
  try {
    context = loadPlayer(bundle);
  } catch (error) {
    fail(error.message);
    return;
  }

  const bundleSha256 = createHash('sha256').update(bundle).digest('hex');
  const corpus = buildCorpus();
  let frames = 0;

  for (const entry of corpus) {
    const report = validate(entry.effect);
    if (!report.ok) {
      fail(`${entry.id}: invalid effect`);
      return;
    }

    const stored = JSON.parse(readFileSync(vectorPath(entry.id), 'utf8'));
    const bytes = encode(normalize(entry.effect));
    const decoded = decode(bytes);
    const node = renderNode(decoded.program, entry.inputs);
    if (node.sha256 !== stored.sha256 || firstCrcDifference(stored.crc32 || [], node.crcs) !== -1) {
      fail(`${entry.id}: TypeScript engine does not match the stored golden vector`);
      return;
    }

    let actual;
    try {
      actual = renderIife(context, bytes, entry.inputs);
    } catch (error) {
      fail(`${entry.id}: ${error.message}`);
      return;
    }

    const first = firstCrcDifference(stored.crc32 || [], actual);
    if (first !== -1) {
      fail(
        `${entry.id}: first differing frame ${first} at t=${first * STEP_MS} ms ` +
          `(vector ${stored.crc32?.[first] ?? 'missing'}, iife ${actual[first] ?? 'missing'})`,
      );
      return;
    }
    frames += actual.length;
  }

  console.log(`player:iife: ok (${corpus.length} cases, ${frames} frames, bundle ${bundleSha256})`);
}

main();
