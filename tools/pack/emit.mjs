#!/usr/bin/env node
// Emit JavaScript and declarations for the package in the current directory.
// Run from a package script. Declaration specifiers are rewritten from `.ts`
// to `.js` so a consumer can resolve them without the TypeScript sources.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
rmSync(join(root, 'dist'), { recursive: true, force: true });

const tsc = spawnSync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.emit.json'], {
  cwd: root,
  stdio: 'inherit',
});
if (tsc.status !== 0) process.exit(tsc.status ?? 1);

rewriteDeclarations(join(root, 'dist'));

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
