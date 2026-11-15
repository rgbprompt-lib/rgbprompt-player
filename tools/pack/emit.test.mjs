import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import test from 'node:test';

import { tscLaunch } from './emit.mjs';

test('declaration emit starts tsc with node, not pnpm', () => {
  const launch = tscLaunch('/usr/bin/node');
  assert.equal(launch.command, '/usr/bin/node');
  assert.equal(launch.args[1], '-p');
  assert.equal(launch.args[2], 'tsconfig.emit.json');
  assert.match(launch.args[0], /[/\\]typescript[/\\]lib[/\\]tsc\.js$/);
  assert.equal(existsSync(launch.args[0]), true);
  assert.equal(launch.args.includes('pnpm'), false);
  assert.equal(launch.args.includes('exec'), false);
});

test('a missing spawn target exits with no compiler output', () => {
  const result = spawnSync('pnpm-not-installed', ['exec', 'tsc', '-p', 'tsconfig.emit.json'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, null);
  assert.equal(result.error?.code, 'ENOENT');
  assert.equal(result.stdout ?? '', '');
  assert.equal(result.stderr ?? '', '');
});
