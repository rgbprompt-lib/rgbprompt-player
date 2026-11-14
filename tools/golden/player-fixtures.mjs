#!/usr/bin/env node
// Generate the Rust Player parity fixtures from the golden corpus.
//
// Each case is encoded on the Node side (ADR-0013) and rendered through the
// decoded program with the full engine, then compared with the stored golden
// vector. Stale fixtures are never written.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { crc32, decode, encode, frameToBytes, normalize, simulate, validate } from '@rgbprompt/engine';

import { buildCorpus } from './corpus.mjs';
import { DURATION_MS, FRAME_BYTES, STEP_MS, engineVersion, firstCrcDifference, vectorPath } from './lib.mjs';

const REPO_ROOT = new URL('../../', import.meta.url);
const PLAYER_BUNDLE = fileURLToPath(new URL('packages/engine/dist/player/engine.iife.js', REPO_ROOT));
const FIXTURES_DIR = new URL('apps/player-core/fixtures/golden/', REPO_ROOT);
const TICKS = Math.ceil(DURATION_MS / STEP_MS);

// Cases whose decoded program is not render-equivalent to the stored golden
// vector. Each entry names the codec defect that causes the drift. The codec
// now round-trips the whole corpus, so this stays empty; a new entry means the
// encoder and renderer have drifted apart again.
const KNOWN_CODEC_DRIFT = new Set([]);

function fail(message) {
  console.error(`player:fixtures: ${message}`);
  process.exitCode = 1;
}

function readStoredVector(caseId) {
  return JSON.parse(readFileSync(vectorPath(caseId), 'utf8'));
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

function main() {
  if (!existsSync(PLAYER_BUNDLE)) {
    fail(`missing ${PLAYER_BUNDLE}; run \`corepack pnpm --filter @rgbprompt/engine build\` first`);
    return;
  }

  const bundle = readFileSync(PLAYER_BUNDLE);
  const bundleSha256 = createHash('sha256').update(bundle).digest('hex');
  const corpus = buildCorpus();
  const prepared = [];
  let driftCount = 0;

  for (const entry of corpus) {
    const report = validate(entry.effect);
    if (!report.ok) {
      fail(`${entry.id}: invalid effect`);
      return;
    }

    const bytes = encode(normalize(entry.effect));
    const decoded = decode(bytes);
    const actual = renderNode(decoded.program, entry.inputs);
    const stored = readStoredVector(entry.id);
    const matchesStored =
      stored.sha256 === actual.sha256 && firstCrcDifference(stored.crc32 || [], actual.crcs) === -1;
    const knownDrift = KNOWN_CODEC_DRIFT.has(entry.id);

    if (knownDrift && matchesStored) {
      fail(
        `${entry.id}: expected codec drift but it now matches the stored vector; ` +
          'remove it from KNOWN_CODEC_DRIFT',
      );
      return;
    }
    if (!knownDrift && !matchesStored) {
      fail(`${entry.id}: decoded render differs from the stored golden vector (unexpected codec drift)`);
      return;
    }
    if (knownDrift) driftCount += 1;

    prepared.push({ entry, bytes, actual, engine: stored.engine });
  }

  if (driftCount !== KNOWN_CODEC_DRIFT.size) {
    fail(
      `KNOWN_CODEC_DRIFT is stale: ${KNOWN_CODEC_DRIFT.size} entries but ${driftCount} drifted cases ` +
        '(the corpus or the codec changed); update the set',
    );
    return;
  }

  rmSync(fileURLToPath(FIXTURES_DIR), { recursive: true, force: true });
  mkdirSync(fileURLToPath(FIXTURES_DIR), { recursive: true });

  for (const { entry, bytes, actual, engine } of prepared) {
    const caseId = entry.id;
    writeFileSync(new URL(`${caseId}.lep`, FIXTURES_DIR), bytes);
    writeFileSync(
      new URL(`${caseId}.inputs.json`, FIXTURES_DIR),
      `${JSON.stringify({ keyEvents: entry.inputs.keyEvents || [], audio: entry.inputs.audio || [] })}\n`,
    );
    writeFileSync(
      new URL(`${caseId}.expected.json`, FIXTURES_DIR),
      `${JSON.stringify({
        engine,
        stepMs: STEP_MS,
        frames: actual.crcs.length,
        crc32: actual.crcs,
        sha256: actual.sha256,
      })}\n`,
    );
  }

  const manifest = {
    schema: 1,
    engineVersion: engineVersion(),
    bundleSha256,
    stepMs: STEP_MS,
    frames: TICKS,
    frameBytes: FRAME_BYTES,
    cases: prepared.map(({ entry }) => entry.id),
  };
  writeFileSync(new URL('manifest.json', FIXTURES_DIR), `${JSON.stringify(manifest, null, 2)}\n`);

  const matched = prepared.length - driftCount;
  console.log(
    `player:fixtures: wrote ${prepared.length} cases ` +
      `(${matched} match stored vectors, ${driftCount} known codec drift) to ${fileURLToPath(FIXTURES_DIR)}`,
  );
}

main();
