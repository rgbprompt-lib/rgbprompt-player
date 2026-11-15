# @rgbprompt/golden

Golden frames for `@rgbprompt/engine`. Every later engine change (TypeScript
migration, new primitives, JavaScriptCore / QuickJS bundling) must prove that
rendered frames did not change; this tool is that guard.

## What is guarded

`corpus.mjs` builds the case list deterministically (181 cases). Every case is a
document the product validator (`validate`) accepts. 178 of them are also accepted by
the firmware export (`validateForFirmware`, ADR-0017), so they are valid composable-v1
device documents (`pnpm upstream:device`); the other three (`product-two-ripples`,
`product-two-reactive`, `product-random-gradient`) are product-only: the engine
renders them but the firmware cannot load them. Which colour, time and
trigger types the firmware takes comes from
`packages/engine/data/schemas/execution-contract.json`:

- every effect in `packages/engine/data/examples/`;
- every primitive open in v1 (`frame_sequence` and `layer_event` excluded) with
  default parameters, `surface: all`, seed 7 (`params` omitted; primitives that
  require a colour get the default ramp or a white solid);
- two documented variants per primitive that exercise its main parameters
  (period / speed / direction / palette / region surface). The parameter values
  and the reason for each variant live next to the variant in `corpus.mjs`;
- coverage cases, grouped by the branch they pin:
  - `cov-time-*`: every `time.type` the contract allows on breath, blink, rain and
    drift, once with the time fields omitted and once with non-default values for
    the fields the contract lists;
  - `cov-color-*` and `cov-color-primitive-*`: every colour type a primitive takes
    (`solid`, `palette_index`, `ramp`, `hue_cycle`; `random` on reactive),
    including custom palettes;
  - `cov-palette-*`: custom, stop and alpha ramps on fire, wave, spiral and reactive;
  - `cov-audio-*`: the spectrum, spectrum_mirror and spectrum_sum paths with a
    second deterministic audio script (loud bursts, 800 ms of all-zero bands,
    abrupt loud-to-low drops, a gradual decline) plus one no-audio case and
    three branch cases (missing bands, duplicate/unsorted samples, dense with
    no peak hold, non-dense beat);
  - `cov-easing-*`: every easing preset plus bezier and LUT resampling;
  - `cov-surface-*` and `cov-region-profile-v2`: `all`, `regions` (including the
    `ALL` region), `cells`, `rows`, `cols`, `invert` and the `ansi104-v2` board;
  - `cov-composite-*`: every `blend` (`replace`, `add`, `max`, `mask`) and
    several `opacity` values below 255, including a saturated `add`;
  - `cov-disabled-*`: disabled layers before and after the enabled one (they are
    dropped from the device document);
  - `cov-seed-*`: seed 0 and a seed at or above 2^31 (`cov-seed-high-mote`, read as
    the firmware's u32);
  - `cov-keys-dense-*`, `cov-playback-*`, `cov-wave-*` (including `time.phase_ms` on rainbow_wave), `cov-spiral-*`,
    `cov-reactive-lifecycle`, `cov-fire-*`, `cov-block-stack-*`, `cov-ring-masked`,
    `cov-spectrum-masked*`: the remaining renderer branches;
  - `product-*`: product-layer documents the firmware limits would have rejected
    (two ripple layers, two reactive layers, a random-colour gradient, an audio
    `trigger.threshold`); they pin per-layer key state and the `.lep` round trip.

Each case renders 10 s at 20 ms steps (500 frames). Key-driven cases add a
typing script of eight down/up pairs on different cells; audio cases add a
deterministic 22-band sequence every 20 ms.

Frames are serialized with the engine's canonical `frameToBytes`
(6 × 22 × 4 bytes, row-major `r,g,b,l`). Each vector stores:

- `engine`: the `@rgbprompt/engine` package version;
- `stepMs`: always 20;
- `frames`: frame count;
- `crc32`: one CRC32 per frame;
- `sha256`: SHA-256 over all frame bytes in order.

One case per file under `vectors/<case-id>.json`. Case ids are kebab-case and
stable; renaming one is a deliberate vector change.

## Commands

From the repository root:

```bash
corepack pnpm golden                # verify every case against the committed vectors
corepack pnpm golden:update         # regenerate all vectors
corepack pnpm golden:cadence        # write CADENCE.md
corepack pnpm golden:cadence:strict # write CADENCE.md and fail if a non-exempt case differs
corepack pnpm golden:coverage       # line/branch coverage of render/color/surfaces/timing
corepack pnpm golden:bench          # ms/frame for the heaviest case and an 8-layer worst case
corepack pnpm golden:jsc            # optional macOS spot check: seven cases in JavaScriptCore
corepack pnpm player:iife            # every case through the player IIFE, per-frame CRC32
corepack pnpm pins:check             # sha256 of the public protocol and audio oracle files
```

`golden:coverage` is intentionally **not** part of `check`: it runs Node's
built-in test coverage (`--experimental-test-coverage`) and fails only when the
targets below are missed.

`golden` exits 1 on the first mismatch and prints the case id, the first
differing frame index and its tick. `golden:update` is idempotent: running it
twice must leave `git status --short tools/golden/vectors` empty.

## Updating vectors deliberately

Do not refresh vectors to make a red build green. Treat a frame change as an
engine behaviour change (ENGINE.md §10):

1. confirm the change is intended and covered by the task;
2. bump the `@rgbprompt/engine` package version (minor for a frame change);
3. list every affected primitive in the PR description;
4. run `corepack pnpm golden:update` and review the affected vector diff;
5. update the spec if the change is a behaviour change rather than a bug fix.

The `engine` field in each vector makes a version bump without a vector update
fail verify, so the change cannot be published silently.

## Reading CADENCE.md

`CADENCE.md` is generated and committed. It is report-only: `golden:cadence`
exits 0 unless `--strict` is passed.

Each row is one corpus case. A cell compares frames at common ticks:

- `20v40`: 20 ms and 40 ms steps at multiples of 40 ms (250 frames);
- `20v33`: 20 ms and 33 ms steps at multiples of 660 ms (16 frames).

`ok` means every common tick was byte-identical. `diff k/n` means `k` of `n`
common frames differed. The `no-input` columns render without key or audio
input; the `input` columns use the case's input script. `sparkle` is time-based
and cadence-invariant, so all three `prim-sparkle-*` cases are `ok`.

`cadence-exempt.json` is the strict exemption list. `golden:cadence:strict`
requires **every** corpus case to be `ok` in all four columns unless it is listed
there. New cases are guarded automatically. The list holds only the two
key-started playback cases (`cov-playback-key-press`,
`cov-playback-selected-press`): shared playback starts on the frame where a
press is first seen (upstream lepc and both firmware engines (C and C++) all do this), so at
20 vs 40 ms the start can land one frame apart. Making it start at the key
event time would need the same change in every engine (see ENGINE.md §5.2, known limitation: 26/250 and 6/250 frames differ at 20 vs 40 ms).

## Public pins

`tools/golden/pins.json` records the raw SHA-256 of two source files:

| id                      | path in this repository                                       | also known as                |
| ----------------------- | ------------------------------------------------------------- | ---------------------------- |
| `player-protocol-cases` | `apps/player-core/crates/core/tests/data/protocol-cases.json` | `player-protocol-cases.json` |
| `synthetic-48k-bands`   | `apps/player-core/fixtures/ka/synthetic-48k.bands`            | `synthetic-48k.bands`        |

`pnpm pins:check` (included in `pnpm check`) reads those bytes and exits 1 on a mismatch.
Recomputing the hash needs only this repository:

```bash
sha256sum apps/player-core/crates/core/tests/data/protocol-cases.json
sha256sum apps/player-core/fixtures/ka/synthetic-48k.bands
```

The protocol file is the `rgbprompt://` case table. The bands file is the 48 kHz analyser
oracle (`ka_bands_match_the_shared_fixture`). A website or another checkout can pin the same
hashes. This repository does not clone, export, or diff another tree to do that.

Change a pin only when the behaviour change is intentional, in the same commit as the file,
and say so in the pull request. The duplicate TypeScript engine that may exist outside this
repository is a separate runtime copy. Frame drift of the copy in this repository shows up as
a golden mismatch or a `player:iife` / `player:parity` CRC mismatch. There is no credential
and no second checkout involved.

## Player IIFE parity

`corepack pnpm player:iife` builds nothing itself. Run `pnpm --filter @rgbprompt/engine build`
first (`pnpm player:parity` does both). The script:

1. loads `packages/engine/dist/player/engine.iife.js` in a Node `vm`;
2. requires `decode`, `simulate`, `crc32`, and `frameToBytes`, and rejects a source map URL;
3. encodes every golden case with the TypeScript engine and checks that render against the
   stored sha256 and CRC32 chain;
4. decodes the same `.lep` bytes inside the IIFE, renders every frame, and compares CRC32
   with the stored vector.

It reads no file outside this repository. `pnpm player:parity` then runs the same frames through
the IIFE embedded in QuickJS (`parity golden`) and the safety IIFE (`parity limiter`).

## JavaScriptCore parity (optional macOS spot check)

`corepack pnpm golden:jsc` is not part of `pnpm check` or Linux CI. It builds nothing itself:
run `pnpm --filter @rgbprompt/engine build` first. The script:

1. finds a JSC host (`jsc` on `PATH`, the JavaScriptCore framework helper, or `osascript
-l JavaScript`); when none exists it prints `skipped: no JavaScriptCore` and exits 0;
2. encodes seven golden cases with the full Node engine (time layers, key input, audio input,
   `sparkle`, `rain`, easing, multi-layer blend);
3. decodes the `.lep` in Node and checks the rendered sha256 chain against the stored vector
   (round-trip guard);
4. runs the player IIFE under JSC with the same `.lep` bytes and inputs, compares per-frame CRC32,
   and reports the first differing frame.

The player IIFE needs only standard ECMAScript intrinsics (`Uint8Array`, `DataView`, `Math`,
`JSON`); it does not use `console`, `TextEncoder` or `TextDecoder`.

QuickJS parity is `pnpm player:parity` (`parity golden` and `parity limiter`). Linux CI runs it.
The Windows script `tools/win/build.ps1` runs the same commands.

## Coverage

`corepack pnpm golden:coverage` renders exactly the vector corpus (same cases,
same inputs, same 20 ms step) under Node's built-in coverage for the four engine
modules that M0-T5…T9 will rewrite. It renders no extra scenarios.

Targets: `render.js` lines ≥ 97 and branches ≥ 93; `color.js`, `surfaces.js`
and `timing.js` lines ≥ 90.

Current corpus-only measurement:

| file          | line % | branch % | uncovered lines                               |
| ------------- | ------ | -------- | --------------------------------------------- |
| `render.js`   | 97.70  | 93.05    | 506, 867-870, 1402-1423, 1439-1443, 1446-1447 |
| `color.js`    | 99.18  | 68.89    | 120                                           |
| `surfaces.js` | 94.96  | 73.02    | 24, 34, 62-63, 82-83, 116                     |
| `timing.js`   | 90.43  | 82.81    | 18-19, 21-23, 25-28, 69-70                    |

Justified uncovered lines:

- `render.js` 506, 1402-1423: `frame_sequence`; implemented but not open in v1.
- `render.js` 867-870: `block_stack` full-row clear; no deterministic seed
  0…4999 at the fastest allowed `step_ms` (50) fills a complete row within the
  10 s corpus before the board resets.
- `render.js` 1439-1443: `levelToPhysical` is called by `preview.js`, not by
  any v1 vector render path.
- `render.js` 1446-1447: `grayValue` is not called by any v1 render path.
- `color.js` 117: `resolveColor` default case for an unknown `color.type`;
  `validate` rejects unknown types before rendering.
- `surfaces.js` 24: `boardForEffect` throw for an unknown `region_profile`;
  `validate` rejects it before rendering.
- `surfaces.js` 34: `loadBoard` with an explicit path; the corpus uses the
  generic/v1/v2 board caches.
- `surfaces.js` 62-63: `expandSurface` throw for a surface without a type;
  `validate` rejects it before rendering.
- `surfaces.js` 82-83: `expandSurface` throw for an unknown region name;
  `validate` rejects it before rendering.
- `surfaces.js` 116: `expandSurface` throw for an unknown surface type;
  `validate` rejects it before rendering.
- `timing.js` 18-19, 21-23, 25-28: `sine01`, `pulse01` and `shape01` are
  exported helpers not called by any v1 render path.
- `timing.js` 69-70: `easeFn`'s LUT branch; `bakeEasing` intercepts `{lut}`
  specs before `easeFn` is called.

## Tests

```bash
corepack pnpm --filter @rgbprompt/golden test
```

The tests cover corpus id stability, frame byte length (528) and vector
stability for a static effect.
