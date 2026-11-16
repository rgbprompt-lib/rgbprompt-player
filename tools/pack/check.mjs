#!/usr/bin/env node
// Pack @rgbprompt/layouts, @rgbprompt/engine, and @rgbprompt/safety, then
// install those tarballs in a clean project and render the golden corpus
// through the packed engine. Workspace aliases are not used for that render.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCorpus } from '../golden/corpus.mjs';
import { vectorPath } from '../golden/lib.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const INTEGRITY = new URL('./integrity.json', import.meta.url);
const PACKAGES = [
  {
    name: '@rgbprompt/layouts',
    dir: 'packages/layouts',
    required: [
      'package/dist/index.js',
      'package/dist/index.d.ts',
      'package/data/ansi104.kle.json',
      'package/LICENSE',
    ],
    dependencies: {},
  },
  {
    name: '@rgbprompt/engine',
    dir: 'packages/engine',
    required: [
      'package/dist/index.js',
      'package/dist/index.d.ts',
      'package/dist/entries/server.js',
      'package/dist/entries/web.js',
      'package/dist/entries/player.js',
      'package/dist/player/engine.iife.js',
      'package/data/primitives.product.json',
      'package/LICENSE',
    ],
    dependencies: { '@rgbprompt/layouts': '0.6.0' },
    iife: 'package/dist/player/engine.iife.js',
    repoIife: 'packages/engine/dist/player/engine.iife.js',
  },
  {
    name: '@rgbprompt/safety',
    dir: 'packages/safety',
    required: [
      'package/dist/index.js',
      'package/dist/index.d.ts',
      'package/dist/entries/player.js',
      'package/dist/player/safety.iife.js',
      'package/constants.json',
      'package/data/srgb-linear.json',
      'package/LICENSE',
    ],
    dependencies: { '@rgbprompt/engine': '0.6.0', '@rgbprompt/layouts': '0.6.0' },
    iife: 'package/dist/player/safety.iife.js',
    repoIife: 'packages/safety/dist/player/safety.iife.js',
  },
];
// Each archive and exact workspace dependency follows its own canonical package version.
for (const pkg of PACKAGES) {
  pkg.version = JSON.parse(readFileSync(join(ROOT, pkg.dir, 'package.json'), 'utf8')).version;
  for (const name of Object.keys(pkg.dependencies)) {
    const dir = name.replace('@rgbprompt/', 'packages/');
    pkg.dependencies[name] = JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8')).version;
  }
}
const PLAYER_CASES = ['example-cyber-breath', 'example-music-spectrum', 'prim-sparkle-default'];
const FORBIDDEN_PATH = /\/workspace|\/Users\/|\\Users\\|file:\/\/|node_modules/;
const SPECIFIER_SOURCE = String.raw`(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]`;

function fail(message) {
  console.error(`pack: ${message}`);
  process.exit(1);
}

function run(command, args, cwd) {
  // Windows CreateProcess does not resolve pnpm.cmd. cmd.exe does.
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32' && command === 'pnpm',
  });
  if (result.error || result.status !== 0) {
    const spawnError = result.error ? `${result.error.code}: ${result.error.message}\n` : '';
    fail(
      `${command} ${args.join(' ')} failed in ${cwd}\n${spawnError}${result.stdout || ''}${result.stderr || ''}`,
    );
  }
  return result.stdout;
}

function listTar(tarball) {
  return run('tar', ['-tzf', tarball], ROOT)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.endsWith('/'));
}

function tarFile(tarball, path) {
  const result = spawnSync('tar', ['-xOf', tarball, path], { cwd: ROOT });
  if (result.error || result.status !== 0) {
    const spawnError = result.error ? `${result.error.code}: ${result.error.message}` : '';
    fail(`tar ${path} failed\n${spawnError}${result.stderr || ''}`);
  }
  return result.stdout;
}

function contentSha256(tarball) {
  const hash = createHash('sha256');
  for (const path of listTar(tarball).sort()) {
    hash.update(path);
    hash.update('\0');
    hash.update(tarFile(tarball, path));
  }
  return hash.digest('hex');
}

function packOne(pkg, destination) {
  run('pnpm', ['pack', '--pack-destination', destination], join(ROOT, pkg.dir));
  const name = pkg.name.replace('@rgbprompt/', 'rgbprompt-');
  return join(destination, `${name}-${pkg.version}.tgz`);
}

function inspect(pkg, tarball) {
  const files = new Set(listTar(tarball));
  for (const path of pkg.required) {
    if (!files.has(path)) fail(`${pkg.name} tarball is missing ${path}`);
  }
  for (const path of files) {
    if (
      /(^|\/)(src|test|scripts|node_modules)\//.test(path) ||
      path.endsWith('.map') ||
      (path.endsWith('.ts') && !path.endsWith('.d.ts'))
    ) {
      fail(`${pkg.name} tarball contains ${path}`);
    }
    const text = tarFile(tarball, path);
    if (path.endsWith('.js') || path.endsWith('.d.ts') || path.endsWith('.json')) {
      const source = text.toString('utf8');
      if (FORBIDDEN_PATH.test(source)) fail(`${pkg.name} ${path} contains a local path`);
      if (path.endsWith('.d.ts') && /from\s+['"][^'"]+\.ts['"]/.test(source)) {
        fail(`${pkg.name} ${path} still imports a .ts path`);
      }
      if (path.endsWith('.js')) {
        for (const match of source.matchAll(new RegExp(SPECIFIER_SOURCE, 'g'))) {
          const spec = match[1];
          if (spec.startsWith('.') || spec.startsWith('@rgbprompt/')) continue;
          fail(`${pkg.name} ${path} imports undeclared ${spec}`);
        }
      }
    }
  }
  const manifest = JSON.parse(tarFile(tarball, 'package/package.json').toString('utf8'));
  if (manifest.version !== pkg.version) fail(`${pkg.name} version is ${manifest.version}`);
  if (manifest.private) fail(`${pkg.name} is still private`);
  if (JSON.stringify(manifest.scripts ?? {}) !== '{}') fail(`${pkg.name} published scripts are not empty`);
  const deps = manifest.dependencies ?? {};
  if (JSON.stringify(deps) !== JSON.stringify(pkg.dependencies)) {
    fail(`${pkg.name} dependencies ${JSON.stringify(deps)}`);
  }
  const serialized = JSON.stringify(manifest);
  if (/workspace:|link:|file:|portal:|\^|\*|latest/.test(serialized)) {
    fail(`${pkg.name} package.json is not an exact pin: ${serialized}`);
  }
  if (pkg.iife) {
    const packed = createHash('sha256').update(tarFile(tarball, pkg.iife)).digest('hex');
    const repo = createHash('sha256')
      .update(readFileSync(join(ROOT, pkg.repoIife)))
      .digest('hex');
    if (packed !== repo) fail(`${pkg.name} IIFE in the tarball does not match the file the Player embeds`);
  }
  return contentSha256(tarball);
}

function installAndRender(tarballs) {
  const dir = join(tmpdir(), `rgbprompt-pack-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir);
  const spec = {
    name: 'rgbprompt-engine-consumer',
    private: true,
    type: 'module',
    dependencies: {},
    pnpm: { overrides: {} },
  };
  for (const [name, tarball] of Object.entries(tarballs)) {
    spec.dependencies[name] = `file:${tarball}`;
    spec.pnpm.overrides[name] = `file:${tarball}`;
  }
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(spec, null, 2)}\n`);
  const corpus = buildCorpus();
  const cases = corpus.map((entry) => {
    const stored = JSON.parse(readFileSync(vectorPath(entry.id), 'utf8'));
    return { id: entry.id, effect: entry.effect, inputs: entry.inputs, sha256: stored.sha256 };
  });
  writeFileSync(join(dir, 'cases.json'), JSON.stringify(cases));
  writeFileSync(join(dir, 'run.mjs'), RUNNER);
  run('pnpm', ['install', '--ignore-workspace', '--ignore-scripts', '--lockfile=false'], dir);
  const output = run('node', ['run.mjs', JSON.stringify(PLAYER_CASES)], dir);
  if (!output.includes(`packed engine: ok (${cases.length} cases)`)) {
    fail(`consumer output was unexpected:\n${output}`);
  }
  console.log(output.trim());
  rmSync(dir, { recursive: true, force: true });
}

const RUNNER = `import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decode, encode, frameToBytes, normalize, simulate, validate } from '@rgbprompt/engine';
import { validate as validateWeb } from '@rgbprompt/engine/web';
import { decode as decodePlayer, frameToBytes as playerBytes, simulate as simulatePlayer } from '@rgbprompt/engine/player';
import { ANSI104_KEYS } from '@rgbprompt/layouts';
import { createLimiter } from '@rgbprompt/safety';

const TICKS = 500;
const STEP_MS = 20;
if (ANSI104_KEYS.length !== 104) throw new Error('layouts key count');
createLimiter().step(new Uint8Array(104 * 3), STEP_MS);

const playerIds = new Set(JSON.parse(process.argv[2]));
const cases = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8'));
for (const entry of cases) {
  if (!validateWeb(entry.effect).ok || !validate(entry.effect).ok) {
    throw new Error(entry.id + ' did not validate');
  }
  const program = normalize(entry.effect);
  const hash = createHash('sha256');
  simulate(program, input(entry), (_index, frame) => hash.update(frameToBytes(frame)));
  if (hash.digest('hex') !== entry.sha256) throw new Error(entry.id + ' frame hash');
  if (playerIds.has(entry.id)) {
    const decoded = decodePlayer(encode(program));
    const playerHash = createHash('sha256');
    simulatePlayer(decoded.program, input(entry), (_index, frame) => playerHash.update(playerBytes(frame)));
    if (playerHash.digest('hex') !== entry.sha256) throw new Error(entry.id + ' player entry');
  }
}
const engineIife = fileURLToPath(import.meta.resolve('@rgbprompt/engine/player-iife'));
const safetyIife = fileURLToPath(import.meta.resolve('@rgbprompt/safety/player-iife'));
console.log('engine iife ' + createHash('sha256').update(readFileSync(engineIife)).digest('hex'));
console.log('safety iife ' + createHash('sha256').update(readFileSync(safetyIife)).digest('hex'));
console.log('packed engine: ok (' + cases.length + ' cases)');

function input(entry) {
  return {
    ticks: TICKS,
    stepMs: STEP_MS,
    keyEvents: entry.inputs.keyEvents || [],
    audio: entry.inputs.audio || [],
  };
}
`;

function main() {
  const first = join(tmpdir(), `rgbprompt-tarballs-a-${process.pid}`);
  const second = join(tmpdir(), `rgbprompt-tarballs-b-${process.pid}`);
  mkdirSync(first);
  mkdirSync(second);
  const pins = {
    schema: 1,
    version: PACKAGES.find((pkg) => pkg.name === '@rgbprompt/engine').version,
    packages: {},
  };
  const tarballs = {};
  for (const pkg of PACKAGES) {
    const a = packOne(pkg, first);
    const b = packOne(pkg, second);
    const hashA = inspect(pkg, a);
    const hashB = contentSha256(b);
    if (hashA !== hashB) fail(`${pkg.name} content hash changed between two packs`);
    pins.packages[pkg.name] = { version: pkg.version, contentSha256: hashA };
    tarballs[pkg.name] = a;
    console.log(`pack: ${pkg.name} ${hashA}`);
  }
  let expected = null;
  try {
    expected = JSON.parse(readFileSync(INTEGRITY, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!expected || JSON.stringify(expected) !== JSON.stringify(pins)) {
    if (process.env.PACK_INTEGRITY_UPDATE === '1') {
      writeFileSync(INTEGRITY, `${JSON.stringify(pins, null, 2)}\n`);
      console.log('pack: wrote tools/pack/integrity.json');
    } else {
      fail(`content hash does not match tools/pack/integrity.json\n${JSON.stringify(pins, null, 2)}`);
    }
  }
  installAndRender(tarballs);
  rmSync(first, { recursive: true, force: true });
  rmSync(second, { recursive: true, force: true });
}

main();
