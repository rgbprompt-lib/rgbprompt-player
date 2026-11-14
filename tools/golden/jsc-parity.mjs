#!/usr/bin/env node
// Render selected golden cases through the player IIFE in JavaScriptCore and
// compare every frame with the full Node engine (ADR-0013, ENGINE.md §10).
//
// Not part of `pnpm check`: CI is Linux, where no JavaScriptCore host exists.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { crc32, decode, encode, frameToBytes, normalize, simulate, validate } from '@rgbprompt/engine';

import { buildCorpus } from './corpus.mjs';
import { DURATION_MS, STEP_MS, firstCrcDifference } from './lib.mjs';

const JSC_PATH = '/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc';
const PLAYER_BUNDLE = fileURLToPath(
  new URL('../../packages/engine/dist/player/engine.iife.js', import.meta.url),
);
const TICKS = Math.ceil(DURATION_MS / STEP_MS);

// One case per acceptance area: time layers, key input, audio input, sparkle,
// rain, easing and a multi-layer blend.
const CASE_IDS = [
  'example-cyber-breath',
  'prim-reactive-default',
  'example-music-spectrum',
  'prim-sparkle-default',
  'prim-rain-default',
  'cov-easing-bezier',
  'cov-composite-add-opacity-128',
];

function findHost() {
  const onPath = spawnSync('which', ['jsc'], { encoding: 'utf8' });
  if (onPath.status === 0 && onPath.stdout.trim()) {
    return { command: onPath.stdout.trim(), args: [], label: 'jsc' };
  }
  if (existsSync(JSC_PATH)) return { command: JSC_PATH, args: [], label: 'JavaScriptCore.framework' };
  const osa = spawnSync('osascript', ['-l', 'JavaScript', '-e', '0'], { encoding: 'utf8' });
  if (osa.status === 0) return { command: 'osascript', args: ['-l', 'JavaScript'], label: 'osascript' };
  return null;
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

function runInHost(host, bundle, bytes, inputs) {
  const dir = mkdtempSync(join(tmpdir(), 'rgbprompt-jsc-'));
  const scriptPath = join(dir, 'case.js');
  const script = [
    bundle,
    'var __result = (function () {',
    `  var bytes = new Uint8Array(${JSON.stringify(Array.from(bytes))});`,
    `  var inputs = ${JSON.stringify(inputs)};`,
    '  var E = RGBPromptEngine;',
    '  var decoded = E.decode(bytes);',
    '  var crcs = [];',
    `  E.simulate(decoded.program, { ticks: ${TICKS}, stepMs: ${STEP_MS}, keyEvents: inputs.keyEvents || [], audio: inputs.audio || [] }, function (_index, frame) {`,
    '    crcs.push(E.crc32(E.frameToBytes(frame)));',
    '  });',
    '  return JSON.stringify({ crcs: crcs });',
    '})();',
    "if (typeof print === 'function') { print(__result); }",
    '__result;',
  ].join('\n');
  writeFileSync(scriptPath, script);
  try {
    const result = spawnSync(host.command, [...host.args, scriptPath], {
      encoding: 'utf8',
      timeout: 120_000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error((result.stderr || result.stdout || 'JavaScriptCore failed').trim());
    }
    return JSON.parse(result.stdout.trim());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readStoredVector(caseId) {
  const path = new URL(`./vectors/${caseId}.json`, import.meta.url);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function main() {
  const host = findHost();
  if (!host) {
    console.log('golden:jsc skipped: no JavaScriptCore');
    return;
  }
  if (!existsSync(PLAYER_BUNDLE)) {
    console.error(`golden:jsc: missing ${PLAYER_BUNDLE} (run the engine build first)`);
    process.exitCode = 1;
    return;
  }

  const corpus = new Map(buildCorpus().map((entry) => [entry.id, entry]));
  const bundle = readFileSync(PLAYER_BUNDLE, 'utf8');
  let failures = 0;
  let frames = 0;

  for (const id of CASE_IDS) {
    const entry = corpus.get(id);
    if (!entry) {
      console.error(`golden:jsc: ${id}: missing from the corpus`);
      failures++;
      continue;
    }
    const report = validate(entry.effect);
    if (!report.ok) {
      console.error(`golden:jsc: ${id}: invalid effect`);
      failures++;
      continue;
    }

    const bytes = encode(normalize(entry.effect));
    const decoded = decode(bytes);
    const node = renderNode(decoded.program, entry.inputs);
    const stored = readStoredVector(id);
    if (node.sha256 !== stored.sha256) {
      console.error(`golden:jsc: ${id}: decoded program does not match the stored golden sha256`);
      failures++;
      continue;
    }

    let actual;
    try {
      actual = runInHost(host, bundle, bytes, entry.inputs);
    } catch (error) {
      console.error(`golden:jsc: ${id}: ${error.message}`);
      failures++;
      continue;
    }

    const first = firstCrcDifference(node.crcs, actual.crcs);
    if (first !== -1) {
      console.error(
        `golden:jsc: ${id}: first differing frame ${first} at t=${first * STEP_MS} ms ` +
          `(node ${node.crcs[first] ?? 'missing'}, jsc ${actual.crcs[first] ?? 'missing'})`,
      );
      failures++;
      continue;
    }
    frames += node.crcs.length;
    console.log(`golden:jsc: ${id}: ok (${node.crcs.length} frames via ${host.label})`);
  }

  if (failures > 0) {
    console.error(`golden:jsc: ${failures} case(s) failed`);
    process.exitCode = 1;
    return;
  }
  console.log(`golden:jsc: ok (${CASE_IDS.length} cases, ${frames} frames via ${host.label})`);
}

main();
