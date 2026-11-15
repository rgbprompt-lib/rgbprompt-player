#!/usr/bin/env node
// Recompute the raw SHA-256 of each public oracle file and compare it with
// tools/golden/pins.json. This does not read any other repository.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const ROOT = new URL('../../', import.meta.url);
const pins = JSON.parse(readFileSync(new URL('./pins.json', import.meta.url), 'utf8'));

if (pins.schema !== 1 || !Array.isArray(pins.files)) {
  console.error('pins: expected schema 1 and a files array');
  process.exit(1);
}

let failed = false;
for (const entry of pins.files) {
  const url = new URL(entry.path, ROOT);
  let bytes;
  try {
    bytes = readFileSync(url);
  } catch (error) {
    console.error(`pins: ${entry.id}: cannot read ${entry.path}: ${error.message}`);
    failed = true;
    continue;
  }
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== entry.sha256) {
    console.error(`pins: ${entry.id}: ${entry.path}`);
    console.error(`  expected ${entry.sha256}`);
    console.error(`  actual   ${actual}`);
    failed = true;
    continue;
  }
  console.log(`pins: ${entry.id} ${actual}`);
}

if (failed) process.exit(1);
