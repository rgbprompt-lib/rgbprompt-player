#!/usr/bin/env node
// Validate the Rust diagnostics sample with the real contracts schema
// (PLAYER §10). Exit 1 when the sample does not parse.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../../', import.meta.url);
const PLAYER_CORE = fileURLToPath(new URL('apps/player-core/', ROOT));
const CONTRACTS = new URL('packages/contracts/src/player.ts', ROOT);
if (!existsSync(CONTRACTS)) {
  console.error(
    'player:diagnostics:check: packages/contracts is not in this repository. ' +
      'Public CI does not run this command. Protocol cases are pinned in tools/golden/pins.json.',
  );
  process.exit(1);
}
const { PlayerDiagnosticsSchema } = await import(CONTRACTS);

let stdout;
try {
  stdout = execFileSync('cargo', ['run', '--quiet', '-p', 'parity', '--', 'diagnostics-sample'], {
    cwd: PLAYER_CORE,
    encoding: 'utf8',
  });
} catch (error) {
  console.error(`player:diagnostics:check: parity diagnostics-sample failed: ${error.message}`);
  process.exit(1);
}

let sample;
try {
  sample = JSON.parse(stdout);
} catch (error) {
  console.error(`player:diagnostics:check: sample is not JSON: ${error.message}`);
  process.exit(1);
}

const parsed = PlayerDiagnosticsSchema.safeParse(sample);
if (!parsed.success) {
  console.error('player:diagnostics:check: sample does not match PlayerDiagnosticsSchema');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

console.log('player:diagnostics:check: ok');
