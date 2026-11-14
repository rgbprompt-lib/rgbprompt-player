// Build the engine entries for server, web and player (ADR-0013).
//
// Source consumers keep compiling src/ directly through the package exports;
// these bundles are what ships to browsers and Players.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');

const entry = (name) => join(root, 'src', 'entries', `${name}.ts`);

const common = {
  absWorkingDir: root,
  bundle: true,
  logLevel: 'silent',
  legalComments: 'none',
  sourcemap: false,
};

const targets = [
  {
    name: 'server',
    options: {
      ...common,
      entryPoints: [entry('server')],
      outfile: join(dist, 'server', 'engine.mjs'),
      format: 'esm',
      platform: 'neutral',
      target: 'es2022',
      minify: false,
    },
  },
  {
    name: 'web (esm)',
    options: {
      ...common,
      entryPoints: [entry('web')],
      outfile: join(dist, 'web', 'engine.mjs'),
      format: 'esm',
      platform: 'neutral',
      target: 'es2022',
      minify: true,
      drop: ['debugger'],
    },
  },
  {
    name: 'web (iife)',
    options: {
      ...common,
      entryPoints: [entry('web')],
      outfile: join(dist, 'web', 'engine.iife.js'),
      format: 'iife',
      globalName: 'RGBPromptEngine',
      platform: 'neutral',
      target: 'es2022',
      minify: true,
      drop: ['debugger'],
    },
  },
  {
    name: 'player (esm)',
    options: {
      ...common,
      entryPoints: [entry('player')],
      outfile: join(dist, 'player', 'engine.mjs'),
      format: 'esm',
      platform: 'neutral',
      target: 'es2020',
      minify: true,
      drop: ['debugger', 'console'],
    },
  },
  {
    name: 'player (iife)',
    options: {
      ...common,
      entryPoints: [entry('player')],
      outfile: join(dist, 'player', 'engine.iife.js'),
      format: 'iife',
      globalName: 'RGBPromptEngine',
      platform: 'neutral',
      target: 'es2020',
      minify: true,
      drop: ['debugger', 'console'],
    },
  },
];

async function run() {
  const sizes = {};
  for (const target of targets) {
    mkdirSync(dirname(target.options.outfile), { recursive: true });
    const result = await build({ ...target.options, metafile: true });
    const outfile = target.options.outfile;
    const output = result.metafile.outputs[relative(root, outfile)];
    if (!output) throw new Error(`build: missing metafile output for ${target.name}`);
    const contents = readFileSync(outfile);
    const key = relative(dist, outfile).split('\\').join('/');
    sizes[key] = { raw: contents.length, gzip: gzipSync(contents).length };
  }
  writeFileSync(join(dist, 'sizes.json'), `${JSON.stringify(sizes, null, 2)}\n`);
  for (const [file, size] of Object.entries(sizes)) {
    console.log(`engine build: ${file} ${size.raw} B (${size.gzip} B gzip)`);
  }
}

await run();
