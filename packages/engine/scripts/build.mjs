// Build the QuickJS player IIFE from src/entries/player.ts (ADR-0013).
//
// The typed library surface is emitted separately by tools/pack/emit.mjs.
// This file is the only bundled copy: it is the artifact embedded by
// apps/player-core and shipped as @rgbprompt/engine/player-iife.
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');

const playerIife = {
  name: 'player (iife)',
  options: {
    absWorkingDir: root,
    bundle: true,
    logLevel: 'silent',
    legalComments: 'none',
    sourcemap: false,
    entryPoints: [join(root, 'src', 'entries', 'player.ts')],
    outfile: join(dist, 'player', 'engine.iife.js'),
    format: 'iife',
    globalName: 'RGBPromptEngine',
    platform: 'neutral',
    target: 'es2020',
    minify: true,
    drop: ['debugger', 'console'],
  },
};

async function run() {
  const outfile = playerIife.options.outfile;
  mkdirSync(dirname(outfile), { recursive: true });
  const result = await build({ ...playerIife.options, metafile: true });
  // esbuild metafile keys always use '/'. path.relative uses '\\' on Windows.
  const output = result.metafile.outputs[metafileKey(root, outfile)];
  if (!output) throw new Error(`build: missing metafile output for ${playerIife.name}`);
  const contents = readFileSync(outfile);
  const gzip = gzipSync(contents).length;
  console.log(`engine build: ${metafileKey(dist, outfile)} ${contents.length} B (${gzip} B gzip)`);
}

function metafileKey(from, to) {
  return relative(from, to).split('\\').join('/');
}

await run();
