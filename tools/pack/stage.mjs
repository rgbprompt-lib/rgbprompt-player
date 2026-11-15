#!/usr/bin/env node
// Rewrite package.json into the manifest that ships in the tarball.
// tools/pack/restore.mjs puts the workspace manifest back. pnpm runs this
// from prepack, then reads package.json again when it builds the tarball.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const manifestPath = join(root, 'package.json');
const backupPath = join(root, 'package.json.pack-backup');
if (existsSync(backupPath)) {
  console.error('pack: package.json.pack-backup already exists');
  process.exit(1);
}

const original = readFileSync(manifestPath, 'utf8');
const json = JSON.parse(original);
const publish = json.publishConfig ?? {};
const staged = { ...json, ...publish, private: false, scripts: {} };
delete staged.publishConfig;
delete staged.devDependencies;
if (publish.exports) staged.exports = publish.exports;
if (staged.dependencies) {
  for (const [name, spec] of Object.entries(staged.dependencies)) {
    if (!String(spec).startsWith('workspace:')) continue;
    const directory = name.replace('@rgbprompt/', '');
    const dep = JSON.parse(readFileSync(join(root, '..', directory, 'package.json'), 'utf8'));
    staged.dependencies[name] = dep.version;
  }
}

copyFileSync(manifestPath, backupPath);
writeFileSync(manifestPath, `${JSON.stringify(staged, null, 2)}\n`);
void original;
