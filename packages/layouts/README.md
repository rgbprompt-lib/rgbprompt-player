# @rgbprompt/layouts

Layout data and key-name mapping for RGBPrompt (ENGINE.md §4). The dependency direction is
`engine -> layouts`: this package never imports `@rgbprompt/engine`; the engine imports its board
tables and re-exports its keyboard helpers. Version `0.6.0` is the packed package.
See [docs/adr/0001-reusable-engine-package.md](../../docs/adr/0001-reusable-engine-package.md).

## Data (`data/`)

The JSON files are authoritative and byte-identical to the copies that used to live in
`packages/engine/data/boards`:

- `ansi104.cells.json` — semantic key name -> logical cell `[row, col]` for the 104 reference keys.
- `*.kle.json` — KLE geometry for `ansi104`, `tkl87`, `k75`, `k65` and `k60`.
- `ansi104.regions-v1.json`, `ansi104.regions-v2.json`, `generic.json` — region tables consumed by
  engine surface expansion.

`src/data.ts` imports the JSON and exposes typed constants (`ANSI104_CELL`, `GENERIC_BOARD`,
`ANSI104_REGIONS_V1`, `ANSI104_REGIONS_V2`, plus the KLE tables used internally).

## API

### Reference layout

- `ANSI104_KEYS: readonly string[]` — the 104 key names in **insertion order of
  `ansi104.cells.json`** (`ESC` first, `KP_PERIOD` last).
- `ANSI104_CELL: Readonly<Record<string, readonly [number, number]>>` — key -> logical cell.
- `frameToKeyRgb(frame): Uint8Array` — 104 x 3 bytes in `ANSI104_KEYS` order from a 6 x 22 frame
  of `{ r, g, b, l }` cells. The frame is a structural type, so this package does not import the
  engine. Brightness is `floor(channel * level / 100)`, which is exactly the engine preview path
  (`levelToPhysical(level, 20)` then `/ 200`):
  `levelToPhysical(l, 20) = floor(l * 20 * 200 / (20 * 100)) = 2 * l`, and
  `floor(c * 2l / 200) = floor(c * l / 100)`.

### Regions (TUN-04)

- `REGION_LABELS: readonly { id, labelKey }[]` — the eight user-facing regions in ENGINE.md §4.3
  order: `all`, `alphas`, `numbers`, `f_row`, `arrows`, `numpad`, `left_half`, `right_half`.
  `labelKey` is an i18n key (`tuning.region.<id>`), never display text.

### Physical layout mapping (HW-02)

- `type LayoutId = 'tkl87' | 'k75' | 'k65' | 'k60'`
- `listLayouts(): LayoutId[]`
- `layoutMap(fromKeysRgb, to): Uint8Array` — maps ansi104 key RGB (104 x 3) to a target layout
  **by key name**. Input must be exactly 312 bytes. Keys absent from the target are dropped. A key
  that exists only on the target takes the colour of the nearest ansi104 key, where distance is
  Euclidean in KLE key units between key centres `(x + w / 2, y + h / 2)`; ties keep the earlier
  `ANSI104_KEYS` entry.

ISO / JIS layouts and per-device OpenRGB LED maps are out of scope for this package in M0 (§4.4,
`deviceMap` is a Player M6 concern).

### Keyboard geometry

`parseKLE`, `bounds`, `loadKeyboard`, `listKeyboards`, `listKeyboardMeta`, `allKeyboards` and
`semanticKeyName` moved here from the engine; the engine re-exports them for compatibility.

## i18n strings for region labels

`REGION_LABELS[].labelKey` returns a stable key, never display text. Locale
catalogs are not part of this repository and are not required to build the Player.

## Tests

```bash
corepack pnpm --filter @rgbprompt/layouts test
```
