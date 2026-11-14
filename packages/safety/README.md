# @rgbprompt/safety

Reference TypeScript implementation of the offline flash detector (`detectFlashes`) and the
pass-through output stage (`createLimiter`). Product decision 2026-11-12: there is no
photosensitivity limit; `detectFlashes` is diagnostic only and `createLimiter` does not alter frames.
The shared Player core runs the same bundle inside QuickJS (ADR-0014).

## Fixed-point luminance

All luminance math is integer so every runtime produces the same result.

- `data/srgb-linear.json` is the contract: 256 values mapping an 8-bit sRGB channel to linear light
  in `0..65535`. Regenerate it with `node scripts/gen-srgb-linear.mjs`. The float formula is
  documented in that script; production code reads the table, never recomputes it.
- `Y = (13933 R + 46871 G + 4732 B) / 65536`, floor division. The weights approximate
  `0.2126 / 0.7152 / 0.0722` and sum to exactly `65536`.
- A key's area is `width × height` in quarter key units (`GEOMETRY_UNIT_SCALE = 4`), so every area is
  a positive integer. Object luminance is the area-weighted average of its keys' `Y`.

## Objects and the block split

The board object is all 104 `ANSI104_KEYS`. The eight block objects come from key centres in
quarter key units: the ANSI 104 geometry is 90 × 24 quarter units, split into four equal columns
(22.5 units wide) and two equal rows (12 units high):

```
column = min(3, floor(cxQ * 4 / 90))
row    = min(1, floor(cyQ * 2 / 24))
block  = row * 4 + column
```

This puts the F/number/Tab rows in the top row and Caps/Shift/bottom in the bottom row. Every key
belongs to exactly one block.

## Detection

`detectFlashes(frames, fps)` accepts frames of 104 × 3 sRGB bytes in `ANSI104_KEYS` order and
returns:

```ts
{
  ok: boolean;
  violations: { object, kind: 'general' | 'red' | 'many_small', windowStartMs, count }[];
  maxPerWindow: { general: number; red: number };
}
```

Transitions are debounced extrema: a transition is recorded when the signal moves at least 0.10
(general) or 0.20 (red share) from the running extreme in the opposite direction. Consecutive
opposing transitions pair into flashes; a general flash also requires the darker state to be strictly
below 0.80. Windows are half-open 1 s intervals. The full-board small-flash rule fires when at least
25% of keys (26 of 104) each flash more than three times in the same window.

`detectFlashes(frames, fps, { trace: true })` additionally returns a `trace` field next to the same
report: the counted transitions per object (frame index, luminance pair, block) and the per-key
events behind a many-small violation. Without the option the return value and work are unchanged;
the benchmark observer uses the trace while the production pipeline keeps calling the plain report.

## Output stage (no limiter)

`createLimiter().step(keysRgb, dtMs)` is a pass-through. Product policy is WYSIWYG: effects render
exactly as the engine computes them, on the web preview and in the Player, with no flash-rate
limit, brightness slew limit or hold clamp. `step` validates the 312-byte frame shape and copies
it into a reused output buffer. The name and signature are kept so the web pipeline and the Player
core (QuickJS) share one call site.

## Vectors

`vectors/manifest.json` plus `vectors/*.frames.bin` hold deterministic 10 s, 25 fps sequences:
128 BPM and 160 BPM heavy beats, continuous fast typing, seeded random noise, the 3 Hz reverse
sample, and a 10 Hz strobe. Regenerate with `node scripts/gen-vectors.mjs`. Each entry stores the
input/output SHA-256 and detector maxima before/after; with the pass-through output stage they
are equal for every vector.

## Player bundle

`corepack pnpm --filter @rgbprompt/safety build` writes `dist/player/safety.iife.js`
(global `RGBPromptSafety`, ES2020, no `console`). It exports exactly `createLimiter`,
`CONSTANTS`, `KEY_NAMES`, `KEY_COUNT`, `KEY_CENTRES_QUARTER` and `frameToKeyRgb`: the
limiter is defined over the 104 keys in `KEY_NAMES` order, so the 6 × 22 → 104 mapping
ships with it instead of being re-implemented in Rust. The shared Player core embeds this
bundle and evaluates it in the same QuickJS context as the engine (PLAYER §9.0.4).

## Commands

```bash
corepack pnpm --filter @rgbprompt/safety build
corepack pnpm --filter @rgbprompt/safety test
corepack pnpm --filter @rgbprompt/safety typecheck
corepack pnpm --filter @rgbprompt/safety bench
corepack pnpm --filter @rgbprompt/safety vectors
```

The engine is used only by `test/engine-examples.test.ts`; `src/` has no runtime dependency on it.
