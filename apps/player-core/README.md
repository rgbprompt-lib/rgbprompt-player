# apps/player-core

Platform-independent Rust core shared by the macOS and Windows Players (ADR-0014, PLAYER §9.0).

| Crate                 | Package                 | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crates/core`         | `rgbprompt-player-core` | `engine_host` (QuickJS runtime, embedded engine + safety IIFEs, decode/render/limit/audio bands/input wanted), `bundle`, `layout` (detection and mapping), `output` (brightness/gamma), `openrgb` (SDK client, `DirectSession`, packet 100), `protocol` (URL parser), `clock`, `token` (redeem/ack), `driver` (manifest, managed OpenRGB install/launch/supervision, external provider), `watcher` (2 s retry timer), `conflict` (vendor process table), `log` (rolling local log), `audio` (PCM ring + FFT), `playback` (25/15 fps loop), `service` (state machine, acks, recovery), `diagnostics`. |
| `crates/ffi`          | `rgbprompt-player`      | C ABI (`rgbp_*`), `cbindgen` header in `include/rgbprompt_player.h`, no-drift test and the C smoke file.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `crates/parity`       | `parity`                | Parity CLI: `parity golden`, `parity limiter`, `parity diagnostics-sample`, `parity openrgb-probe`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `crates/openrgb-stub` | `openrgb-stub`          | Test-only OpenRGB SDK server stub (lib + `openrgb-stub` bin); presets `per-key`, `tkl`, `zones`, `single`, `mouse` with real OpenRGB device kinds, `--controllers a,b`, `--exit-after-ms`, the OpenRGB CLI shape (`--server --server-port N`), `DEVICE_LIST_UPDATED`, add/remove controllers.                                                                                                                                                                                                                                                                                                        |

`crates/core/data/` holds the embedded `device-db.json` (initially empty; real devices are
recorded later), `openrgb-key-names.json` (ANSI104 key → OpenRGB LED names), the driver
manifests `manifests/openrgb-{macos,windows}.json` (Windows: the patched release
`f81fd32-evision.1` with its measured `sha256` / `size_bytes`; macOS still ships
`sha256: null`, so its install fails closed until the real release is measured) and
`vendor-conflicts.json` (PLAYER §8 display names and process patterns).
`crates/core/tests/data/protocol-cases.json` is the URL table shared with `packages/contracts`.

The toolchain is pinned in `rust-toolchain.toml` (Rust 1.96.0). Run cargo commands from this
directory so both the toolchain override and `.cargo/config.toml` (mingw linker) apply.

## Commands

Run from the repository root:

```bash
corepack pnpm player:fixtures          # write apps/player-core/fixtures/golden from the golden corpus
corepack pnpm player:parity            # build engine + safety, fixtures, then `parity golden` and `parity limiter`
corepack pnpm player:check:win         # cross-compile the workspace for x86_64-pc-windows-gnu
corepack pnpm player:header            # regenerate include/rgbprompt_player.h (RGBP_BLESS=1)
corepack pnpm player:smoke             # C ABI smoke test against the OpenRGB stub (macOS clang)
corepack pnpm player:driver:e2e        # NeedsDriver -> install a zipped stub -> Playing -> stop
corepack pnpm player:probe:openrgb     # read-only real-device probe (see below)
corepack pnpm player:diagnostics:check # validate `parity diagnostics-sample` with the contracts schema
```

Run from this directory:

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo run --release -p parity -- golden [--fixtures <dir>] [--case <id>]
cargo run --release -p parity -- limiter [--vectors <dir>]
cargo run -p parity -- diagnostics-sample
cargo run --release -p openrgb-stub -- [--port N] [--preset per-key|tkl|zones|single|mouse] [--controllers a,b] [--protocol N] [--exit-after-ms N]
cargo run --release -p parity -- openrgb-probe [--addr 127.0.0.1:6742] [--out <file>] [--play <file.lep> --seconds N]
```

`openrgb-probe` is the real-device check (Q26). Read-only by default: it handshakes with an
OpenRGB SDK server, prints the protocol version, every controller (kind, `vid:pid` parsed from
`location`, modes, zones, LEDs) and the `layout::detect` result, then writes the full JSON to
`<repo>/tmp/openrgb-probe-<unix_ms>.json` (or `--out`). It never starts or stops OpenRGB. With
`--play <file.lep> --seconds N` (default 5, max 30) it runs the file through the real playback
path on the chosen keyboard and ends with one all-black frame (no mode restore, PLY-20). Connection refused exits 2
with a one-line hint. Do not point it at a server you did not start yourself.

The parity fixtures are generated by Node (encoding stays server-side, ADR-0013) and are not
committed. `parity` only decodes `.lep` through the embedded engine inside QuickJS. The limiter
vectors are committed under `packages/safety/vectors/`.

The `.lep` the Player consumes comes from `POST /player/redeem` as base64 `lep` (ADR-0013).
`minPlayerVersion` is always the current Player version (no older-Player tiering before release).
