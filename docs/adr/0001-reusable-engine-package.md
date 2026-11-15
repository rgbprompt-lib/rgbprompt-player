# ADR 0001: One engine package from this monorepo

## Status

Accepted for the public repository. No registry publish and no GitHub release
is part of this change.

## Decision

`@rgbprompt/layouts`, `@rgbprompt/engine`, and `@rgbprompt/safety` stay packages
in this monorepo. They are the only maintained source of the lighting engine.
A consumer installs fixed `0.6.0` tarballs. It does not check out this
repository beside its own, and it does not depend on the native Player.

The native Player keeps embedding `packages/engine/dist/player/engine.iife.js`
and `packages/safety/dist/player/safety.iife.js`. Those files are also the
`player-iife` exports of the packed packages. `pnpm pack:check` fails if the
bytes in the tarball differ from the files the Rust build embeds.

## What a consumer imports

| Specifier | Runtime | Contains |
| --- | --- | --- |
| `@rgbprompt/layouts` | Node, browser bundler, Worker | Key geometry. No dependency. |
| `@rgbprompt/engine` | same | Validate, normalize, encode, render. Depends on layouts `0.6.0`. Includes generation prompt data. |
| `@rgbprompt/engine/server` | same | The same surface as the package root. |
| `@rgbprompt/engine/web` | same | Render, validate, tuning, product metadata. No encoder and no generation prompt data. |
| `@rgbprompt/engine/player` | same | `.lep` decode, render, audio-band helpers. No encoder. |
| `@rgbprompt/engine/player-iife` | file, not an ESM import | QuickJS IIFE, global `RGBPromptEngine`. Read the file; do not `import` it as a module. |
| `@rgbprompt/safety` | Node, browser bundler, Worker | Output stage. Depends on engine `0.6.0` and layouts `0.6.0`. |
| `@rgbprompt/safety/player` | same | Real-time limiter entry. |
| `@rgbprompt/safety/player-iife` | file, not an ESM import | QuickJS IIFE, global `RGBPromptSafety`. |

Every JavaScript condition (`import`, `browser`, `worker`) points at the same
emitted file. The source uses ECMAScript and JSON modules only. It does not
import the native shells under `apps/`.

Workspace development still resolves the TypeScript sources. `publishConfig`
is what `pnpm pack` writes into the tarball: `dist/*.js`, `dist/*.d.ts`, the
JSON data those files import, `LICENSE`, and `README.md`. Build scripts and
devDependencies are removed from the packed manifest. Dependencies are exact
`0.6.0`, with no range and no `workspace:` protocol.

`@rgbprompt/engine` is MIT. Layouts and safety are Apache-2.0, the same as the
rest of this repository. Each tarball contains its license text.

## Why not a second copy or a third repository

A second TypeScript tree would drift from the Player even if a tarball were
built from it later. Packing the packages that already live here means the
golden corpus, the player IIFE, and the consumer all run the same sources.
The IIFE is a different format for QuickJS, not a second implementation: esbuild
bundles `src/entries/player.ts`, and the typed package is `tsc` output of that
same tree.

## Tradeoffs

- Consumers must build or download the tarball. They cannot `pnpm add` a
  floating `latest`, and this repository does not publish one.
- The packed engine is many small modules plus JSON files, not one minified
  browser bundle. Bundlers and Workers take the ESM. The IIFE exists only for
  QuickJS. The packages are not marked `sideEffects: false`, because that flag
  makes esbuild drop unused exports and changes the IIFE bytes.
- `info` about generation prompts is on `@rgbprompt/engine` and `./server`.
  Browser code that should not ship that data imports `./web` or `./player`.
- Layouts and safety moved from `0.0.0` to `0.6.0` so the three packages share
  one version pin. The engine version was already `0.6.0`. Frame hashes did
  not change.
- `pnpm pack:check` renders all 181 golden cases (90,500 frames) through the
  installed tarball and packs twice to compare content hashes. Those hashes
  are in `tools/pack/integrity.json`. Tar metadata is not part of the pin.

## Publication blocker

Nothing in this change uploads a package. To give a consumer an immutable URL,
a maintainer with permission to create a release on
`rgbprompt-lib/rgbprompt-player` does this on the commit that contains `tools/pack/integrity.json`, after
`pnpm pack:check` passes:

```sh
corepack pnpm pack:check
# tarballs are rebuilt by that command; pack again into a directory to attach:
mkdir -p /tmp/engine-v0.6.0
pnpm --dir packages/layouts pack --pack-destination /tmp/engine-v0.6.0
pnpm --dir packages/engine pack --pack-destination /tmp/engine-v0.6.0
pnpm --dir packages/safety pack --pack-destination /tmp/engine-v0.6.0
```

Create the git tag and GitHub release `engine-v0.6.0` (not a floating name)
and attach:

- `rgbprompt-layouts-0.6.0.tgz`
- `rgbprompt-engine-0.6.0.tgz`
- `rgbprompt-safety-0.6.0.tgz`

The release notes should include the three `contentSha256` values from
`tools/pack/integrity.json`. That needs `contents: write` on this repository.
It does not need a new secret in CI.

An npm alternative is `npm publish --access public` from each package
directory, layouts first, then engine, then safety. That needs an npm token
for the `@rgbprompt` scope, which this repository does not have. Do not add
the token until a maintainer decides to publish.

Until one of those happens, a consumer can install tarballs built from this
commit only by running the pack commands above and checking the content hashes.
That is a local artifact, not a registry version.
