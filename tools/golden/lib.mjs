// Shared rendering and vector helpers for the golden CLI and its tests.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { crc32, frameToBytes, normalize, simulate, validate } from '@rgbprompt/engine';

export const STEP_MS = 20;
export const DURATION_MS = 10_000;
export const FRAME_BYTES = 6 * 22 * 4;

export const VECTORS_DIR = new URL('./vectors/', import.meta.url);
export const CADENCE_FILE = new URL('./CADENCE.md', import.meta.url);
export const EXEMPT_FILE = new URL('./cadence-exempt.json', import.meta.url);

export function engineVersion() {
  const pkg = JSON.parse(
    readFileSync(new URL('../../packages/engine/package.json', import.meta.url), 'utf8'),
  );
  return pkg.version;
}

export function vectorPath(caseId) {
  return new URL(`${caseId}.json`, VECTORS_DIR);
}

// Prettier (printWidth 110) fills long number arrays greedily, so vectors are
// written in that shape directly. Keeping the generator stable means
// `golden:update` and `format:check` agree without a formatter dependency.
function formatNumberArray(values, printWidth = 110) {
  const indent = '    ';
  const lines = [];
  let line = indent;
  let filled = false;
  values.forEach((value, index) => {
    const suffix = index === values.length - 1 ? '' : ',';
    const separator = filled ? ', ' : '';
    const candidate = `${line}${separator}${value}`;
    if (filled && `${candidate}${suffix}`.length > printWidth) {
      lines.push(`${line},`);
      line = `${indent}${value}`;
      filled = true;
      return;
    }
    line = candidate;
    filled = true;
  });
  if (filled) lines.push(line);
  return lines.join('\n');
}

export function formatVector(vector) {
  const crcLines = formatNumberArray(vector.crc32);
  return [
    '{',
    `  "engine": ${JSON.stringify(vector.engine)},`,
    `  "stepMs": ${vector.stepMs},`,
    `  "frames": ${vector.frames},`,
    '  "crc32": [',
    crcLines,
    '  ],',
    `  "sha256": ${JSON.stringify(vector.sha256)}`,
    '}',
    '',
  ].join('\n');
}

function describeIssues(report) {
  return report.errors.map((issue) => `${issue.path ? `${issue.path}: ` : ''}${issue.message}`).join('; ');
}

// Render one effect for `durationMs`, one frame per `stepMs`. `inputs` uses the
// engine's simulate() input shape.
export function renderProgram(program, { stepMs = STEP_MS, durationMs = DURATION_MS, inputs = {} } = {}) {
  const ticks = Math.ceil(durationMs / stepMs);
  const frames = [];
  simulate(
    program,
    {
      ticks,
      stepMs,
      keyEvents: inputs.keyEvents || [],
      audio: inputs.audio || [],
    },
    (_frameIndex, frame) => {
      frames.push(frameToBytes(frame));
    },
  );
  return frames;
}

export function renderFrames(effect, { stepMs = STEP_MS, durationMs = DURATION_MS, inputs = {} } = {}) {
  const report = validate(effect);
  if (!report.ok) {
    throw new Error(`invalid effect: ${describeIssues(report)}`);
  }
  return renderProgram(normalize(effect), { stepMs, durationMs, inputs });
}

export function framesToVector(frames) {
  const hash = createHash('sha256');
  const crcs = [];
  for (const frame of frames) {
    crcs.push(crc32(frame));
    hash.update(frame);
  }
  return {
    engine: engineVersion(),
    stepMs: STEP_MS,
    frames: frames.length,
    crc32: crcs,
    sha256: hash.digest('hex'),
  };
}

export function vectorFor(effect, inputs) {
  return framesToVector(renderFrames(effect, { inputs }));
}

export function vectorForProgram(program, inputs) {
  return framesToVector(renderProgram(program, { inputs }));
}

export function renderByTick(effect, stepMs, inputs, { durationMs = DURATION_MS } = {}) {
  const frames = renderFrames(effect, { stepMs, durationMs, inputs });
  const byTick = new Map();
  frames.forEach((frame, index) => byTick.set(index * stepMs, frame));
  return byTick;
}

function bytesEqual(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

// Compare two renderings at every common tick that is a multiple of `interval`.
export function compareAtTicks(a, b, interval, { durationMs = DURATION_MS } = {}) {
  let diff = 0;
  let total = 0;
  for (let tick = 0; tick < durationMs; tick += interval) {
    const left = a.get(tick);
    const right = b.get(tick);
    if (!left || !right) continue;
    total++;
    if (!bytesEqual(left, right)) diff++;
  }
  return { diff, total, ok: diff === 0 };
}

function resultLabel(result) {
  return result.ok ? 'ok' : `diff ${result.diff}/${result.total}`;
}

export function cadenceForCase(effect, inputs) {
  const plain20 = renderByTick(effect, 20, {});
  const plain33 = renderByTick(effect, 33, {});
  const plain40 = renderByTick(effect, 40, {});

  const hasInput =
    (inputs.keyEvents && inputs.keyEvents.length > 0) || (inputs.audio && inputs.audio.length > 0);
  const input20 = hasInput ? renderByTick(effect, 20, inputs) : plain20;
  const input33 = hasInput ? renderByTick(effect, 33, inputs) : plain33;
  const input40 = hasInput ? renderByTick(effect, 40, inputs) : plain40;

  return {
    'no-input 20v40': resultLabel(compareAtTicks(plain20, plain40, 40)),
    'no-input 20v33': resultLabel(compareAtTicks(plain20, plain33, 660)),
    'input 20v40': resultLabel(compareAtTicks(input20, input40, 40)),
    'input 20v33': resultLabel(compareAtTicks(input20, input33, 660)),
  };
}

export function firstCrcDifference(expected, actual) {
  const limit = Math.min(expected.length, actual.length);
  for (let index = 0; index < limit; index++) {
    if (expected[index] !== actual[index]) return index;
  }
  if (expected.length !== actual.length) return limit;
  return -1;
}

export function readExemptCases() {
  try {
    const raw = JSON.parse(readFileSync(fileURLToPath(EXEMPT_FILE), 'utf8'));
    if (!Array.isArray(raw)) throw new Error('cadence-exempt.json must contain an array');
    return raw;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
