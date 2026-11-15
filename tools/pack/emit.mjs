#!/usr/bin/env node
// Emit JavaScript and declarations for the package in the current directory.
// Run from a package script. Declaration specifiers are rewritten from `.ts`
// to `.js` so a consumer can resolve them without the TypeScript sources.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Launch tsc with node. `spawnSync('pnpm')` on Windows returns ENOENT before
// any compiler output: CreateProcess does not resolve pnpm.cmd.
export function tscLaunch(execPath = process.execPath) {
  const tscJs = fileURLToPath(new URL('../../node_modules/typescript/lib/tsc.js', import.meta.url));
  return { command: execPath, args: [tscJs, '-p', 'tsconfig.emit.json'] };
}

export function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return pathToFileURL(entry).href === import.meta.url;
  }
}

function rewriteDeclarations(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      rewriteDeclarations(path);
      continue;
    }
    if (!name.endsWith('.d.ts')) continue;
    const text = readFileSync(path, 'utf8');
    const next = text.replace(/(from\s+|import\s*\(\s*)(['"])(\.\.?\/[^'"]+?)\.ts\2/g, '$1$2$3.js$2');
    if (next !== text) writeFileSync(path, next);
  }
}

function emit() {
  const root = process.cwd();
  rmSync(join(root, 'dist'), { recursive: true, force: true });
  const launch = tscLaunch();
  const tsc = spawnSync(launch.command, launch.args, { cwd: root, stdio: 'inherit' });
  if (tsc.error) {
    console.error(`emit: failed to start tsc (${tsc.error.code}): ${tsc.error.message}`);
    process.exit(1);
  }
  if (tsc.status !== 0) process.exit(tsc.status ?? 1);
  rewriteDeclarations(join(root, 'dist'));
}

if (invokedDirectly()) emit();
