# Contributing

Thanks for your interest. Issues and pull requests are welcome.

Work in a clone of this repository. Do not export source from another project,
add a sibling checkout, or share `node_modules` across repositories. An editor
or agent is optional; nothing here requires a particular one.

Before a pull request, run:

```sh
corepack enable
corepack prepare pnpm@9.15.4 --activate
pnpm install --frozen-lockfile
pnpm check
pnpm player:parity
cd apps/player-core && cargo test --locked --workspace
```

On macOS also run `pnpm player:mac:test`. A Windows GNU cross-build is
`pnpm player:check:win` (needs `x86_64-w64-mingw32-gcc` and the player bundles).
The same commands run in [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

`cargo fmt --all -- --check` is not a CI gate: the tree still has pre-existing
rustfmt diffs under the pinned 1.96.0 rustfmt. Do not reformat unrelated code
just to turn that check on.

`cargo test` must keep these three tests ignored. They are opt-in probes, not
part of CI:

- `live_download_installs_a_real_archive` (real network download)
- `audio_presets_step_within_budget`
- `audio_presets_survive_real_time_playback`

Engine behaviour is guarded by the golden corpus in `tools/golden` and by
`pnpm player:iife`, which renders every case through the public player IIFE and
compares per-frame CRC32 with the stored vectors. A change that alters rendered
frames needs an explanation and updated golden data.

`pnpm pack:check` (part of `pnpm check`) packs `@rgbprompt/layouts`,
`@rgbprompt/engine`, and `@rgbprompt/safety` at version `0.6.0` and renders the
golden corpus through a clean install of those tarballs. See
[docs/adr/0001-reusable-engine-package.md](docs/adr/0001-reusable-engine-package.md).

`pnpm pins:check` (part of `pnpm check`) hashes two public oracle files. The
paths and expected hashes are in `tools/golden/pins.json`. Update a pin only in
the same commit as an intentional protocol or audio-analyser change. See
[`tools/golden/README.md`](tools/golden/README.md).

Keep the safety limiter conservative: changes that raise brightness, flash rate
or step limits will be reviewed with extra care.

Do not add vendor-specific HID or firmware protocols; lighting goes through OpenRGB.

`pnpm player:diagnostics:check` is not a public CI step. It imports
`packages/contracts`, and that package is not in this repository.

By contributing you agree that your contribution is licensed under the license of the
directory you change (Apache-2.0, or MIT for `packages/engine`).
