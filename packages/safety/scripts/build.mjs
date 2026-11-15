// Build the safety player IIFE consumed by the Rust Player core (PLAYER §9.0.4).
//
// Source consumers keep importing src/ through the package exports; this
// bundle is what the shared Player evaluates inside QuickJS.
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const outfile = join(root, 'dist', 'player', 'safety.iife.js');

async function run() {
  mkdirSync(dirname(outfile), { recursive: true });
  const result = await build({
    absWorkingDir: root,
    entryPoints: [join(root, 'src', 'entries', 'player.ts')],
    outfile,
    bundle: true,
    format: 'iife',
    globalName: 'RGBPromptSafety',
    platform: 'neutral',
    target: 'es2020',
    minify: true,
    drop: ['debugger', 'console'],
    logLevel: 'silent',
    legalComments: 'none',
    sourcemap: false,
    metafile: true,
  });
  // esbuild metafile keys always use '/'. path.relative uses '\\' on Windows.
  const output = result.metafile.outputs[metafileKey(root, outfile)];
  if (!output) throw new Error('build: missing metafile output for player');
  const contents = readFileSync(outfile);
  console.log(
    `safety build: ${metafileKey(join(root, 'dist'), outfile)} ` +
      `${contents.length} B (${gzipSync(contents).length} B gzip)`,
  );
}

function metafileKey(from, to) {
  return relative(from, to).split('\\').join('/');
}

await run();
