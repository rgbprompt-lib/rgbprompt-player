# @rgbprompt/engine

The single implementation of LEP effect semantics for RGBPrompt: validate, normalize, compile,
render, and `.lep` encode/decode. Web, API, and both Players consume this package.

This is a faithful port from the vendor-neutral `lep-editor-pure` prototype. Behaviour is unchanged
except for `sparkle`, which now uses the time-based scheduler from `sparkle_time.ts`
(cadence-invariant, ENGINE.md §5.2; engine 0.1.0), timestamped key events (`io.keys`), which
drive `key_ring`, `key_burst` and `key_tint` from the event time instead of the frame index (engine
0.2.0), and event-time `reactive` / `ripple` / `ripple_square` / `aurora` with a deterministic
hash-based `color.random` that never consumes the shared RNG (engine 0.3.0). The TypeScript
migration happened under the golden guard (ADR-0007).

## TypeScript

The engine is fully TypeScript strict. Node ≥ 22.18 runs `.ts` directly by stripping types, so
workspace consumers keep compiling `src/` through the package exports (`"."`, `"./server"`,
`"./web"`, `"./player"`). Distribution builds are separate: `pnpm --filter @rgbprompt/engine build`
writes `dist/server`, `dist/web` and `dist/player` bundles with esbuild and a `dist/sizes.json`
(ADR-0013).

Modules must use **erasable** TypeScript syntax only: no `enum`, `namespace`, parameter properties,
`import =` or decorators. `packages/engine/tsconfig.json` enforces this with `erasableSyntaxOnly`.

## Renderer input

`Renderer.step(tick, io)` has one input form: timestamped events.

```ts
step(tick: number, io: { keys?: KeyEvent[]; audio?: AudioSample[] }): Frame;
```

`keys` entries are `{ t, type: 'down' | 'up', cell: 'r,c' }`; `audio` entries are `{ t, bands }`.
Both arrays may be unsorted and may contain future timestamps. A missing or empty array means "no
new input": it does not move the key timeline or queue an audio sample. A key event that arrives
late (older than the previous frame but not older than the last applied event) is applied with its
own timestamp, so the resulting edge is already partly advanced. `simulate()` always passes both
arrays, empty when a frame has no input.

## Validation

`validate(dsl, opts?)` returns a structured report (ENGINE.md §6):

```ts
validate(dsl: unknown, opts?: { mode?: 'strict' | 'generate'; board?: Board | null }): ValidationReport
```

The default mode is `strict`, which is what manual versions, publishing and
`.lep` imports use. `generate` additionally clamps out-of-range numbers instead
of rejecting them, records each change in `clamps`, and returns the clamped
document in `value`. The input object is never mutated; in `strict` mode
`value` is the input itself when the report is `ok`, otherwise `null`.

```ts
type ValidationReport = {
  ok: boolean;
  errors: { path: string; code: ValidationCode; message: string }[];
  warnings: { path: string; code: ValidationCode; message: string }[];
  clamps: { path: string; from: number; to: number }[];
  budget: { layers: number; estCostUnits: number; bytes: number };
  value: unknown | null;
};
```

Paths use one DSL format everywhere (`layer[1].params.period_ms`,
`layer[0].color.rgb[2]`, `meta.seed`, `layer`). `code` is one of the frozen
`VALIDATION_CODES` values exported from `src/types.ts`; `message` is short and
actionable because API generation feeds both back to the model. `budget.bytes`
is the UTF-8 length of the DSL JSON (not the `.lep` size), limited to 64 KB;
`estCostUnits` weights each layer's cells by 1 (stateless), 2 (key-event or
stateful) or 4 (audio). Clamps apply only to numeric values of the right type
outside a declared range (registry params, RGB channels, and other numeric
fields with a declared range such as `meta.seed`, `layer.opacity`, and rain
`time` fields).

## Layout

- `src/` — engine core modules: constants, rng, color, timing, surfaces, registry, validate,
  normalize, render, codec, lep, roundtrip, vectors, rain_model, sparkle_time, spiral_table,
  key_centres, led_positions, preview. `kle.ts` and `keyboard.ts` are thin re-export shims for the
  moved implementation in `@rgbprompt/layouts`.
- `data/` — runtime JSON: `schemas/` (effect schema, primitive registry, binary param layout) and
  `examples/` (effect documents used by tests). Board data moved to `packages/layouts/data/`
  (ENGINE.md §4); `surfaces` reads its region tables from `@rgbprompt/layouts` and `loadBoard()`
  returns the generic board.
- `test/` — `node:test` suites for the engine modules.
- `golden/` — reference effects and frames used by the golden tooling.

## Entries and distribution

- `src/entries/server.ts` — full surface plus generation-only data (`primitives.prompt.json`).
- `src/entries/web.ts` — renderer, validate/normalize, describe/tuning, product metadata, audio bands.
  No encoder and no server-only data.
- `src/entries/player.ts` — `.lep` `decode`, renderer stepping helpers, constants and types. No
  encoder and no `normalize`-from-DSL.

`pnpm build` emits ESM and (for web/player) IIFE bundles. Client outputs are minified, have no
source maps or comments, and the player output drops `console`. `tools/bundle-check` guards these
properties in CI.

## Tests

```bash
corepack pnpm --filter @rgbprompt/engine test
corepack pnpm check:bundles   # build + client-bundle checks + player vm test
corepack pnpm golden:jsc      # macOS JavaScriptCore parity for the player bundle
```

## Golden guard

Any behaviour change under `src/` must keep every golden frame hash green. Changing a golden is a
deliberate act: bump `engine_version`, list the affected primitives, and explain why (see
`docs/specs/ENGINE.md` §10).
