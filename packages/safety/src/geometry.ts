// ANSI 104 key geometry in integer units and the 2 x 4 block split.
//
// Key names follow ANSI104_KEYS from @rgbprompt/layouts. Geometry comes from
// that package's ansi104 KLE table. KLE widths/heights are multiples of 0.25,
// so scaling by GEOMETRY_UNIT_SCALE = 4 makes every width, height, centre and
// area an integer.
//
// Block split: centres are quantised to quarter key units. The board is
// maxXQ = 90 by maxYQ = 24 quarter units. Four equal columns are 22.5 quarter
// units wide and two equal rows are 12 quarter units high, so
//
//   column = min(3, floor(cxQ * 4 / 90))
//   row    = min(1, floor(cyQ * 2 / 24))
//
// The split is top vs bottom at y = 3 KLE units (F/number/Tab rows on top,
// Caps/Shift/bottom rows below) and four equal horizontal quarters. Every key
// belongs to exactly one of the eight blocks; the board object contains all
// 104 keys.
import { ANSI104_CELL, ANSI104_KEYS, loadKeyboard, semanticKeyName } from '@rgbprompt/layouts';
import type { ObjectId } from './types.ts';
import { BLOCK_COLS, BLOCK_COUNT, BLOCK_ROWS, GEOMETRY_UNIT_SCALE, OBJECT_COUNT } from './constants.ts';

export const KEY_COUNT = ANSI104_KEYS.length;

const keyboard = loadKeyboard('ansi104');
const maxXQ = Math.round(keyboard.maxX * GEOMETRY_UNIT_SCALE);
const maxYQ = Math.round(keyboard.maxY * GEOMETRY_UNIT_SCALE);

if (maxXQ <= 0 || maxYQ <= 0) {
  throw new Error('invalid ansi104 geometry bounds');
}

const geometryByName = new Map<string, (typeof keyboard.keys)[number]>();
for (const key of keyboard.keys) {
  const name = semanticKeyName(key);
  if (name === null) continue;
  if (geometryByName.has(name)) throw new Error(`duplicate ansi104 key name: ${name}`);
  geometryByName.set(name, key);
}

const areas: number[] = [];
const blocks: number[] = [];
const centres: [number, number][] = [];

for (const name of ANSI104_KEYS) {
  const key = geometryByName.get(name);
  if (!key) throw new Error(`missing ansi104 geometry for key: ${name}`);

  const widthQ = Math.round(key.w * GEOMETRY_UNIT_SCALE);
  const heightQ = Math.round(key.h * GEOMETRY_UNIT_SCALE);
  if (
    Math.abs(key.w * GEOMETRY_UNIT_SCALE - widthQ) > 1e-9 ||
    Math.abs(key.h * GEOMETRY_UNIT_SCALE - heightQ) > 1e-9
  ) {
    throw new Error(`non-integer geometry for key: ${name}`);
  }

  const cxQ = Math.round((key.x + key.w / 2) * GEOMETRY_UNIT_SCALE);
  const cyQ = Math.round((key.y + key.h / 2) * GEOMETRY_UNIT_SCALE);
  const column = Math.min(BLOCK_COLS - 1, Math.floor((cxQ * BLOCK_COLS) / maxXQ));
  const row = Math.min(BLOCK_ROWS - 1, Math.floor((cyQ * BLOCK_ROWS) / maxYQ));

  areas.push(widthQ * heightQ);
  blocks.push(row * BLOCK_COLS + column);
  centres.push([cxQ, cyQ]);
}

export const KEY_NAMES: readonly string[] = ANSI104_KEYS;

// The logical `${row},${col}` cell the engine's KeyEvent uses, in KEY_NAMES
// order. The Player resolves an ANSI104 key name to one of these strings.
export const KEY_CELLS: readonly string[] = Object.freeze(
  ANSI104_KEYS.map((name) => {
    const cell = ANSI104_CELL[name];
    return cell ? `${cell[0]},${cell[1]}` : '';
  }),
);

export const KEY_AREAS: readonly number[] = Object.freeze(areas);
export const KEY_BLOCKS: readonly number[] = Object.freeze(blocks);
export const KEY_CENTRES_QUARTER: readonly (readonly [number, number])[] = Object.freeze(
  centres.map((centre) => Object.freeze(centre.slice() as [number, number])),
);

export const OBJECT_IDS: readonly ObjectId[] = Object.freeze([
  'board',
  'block-0',
  'block-1',
  'block-2',
  'block-3',
  'block-4',
  'block-5',
  'block-6',
  'block-7',
]);

const blockMembers: number[][] = Array.from({ length: BLOCK_COUNT }, () => []);
for (let keyIndex = 0; keyIndex < KEY_COUNT; keyIndex++) {
  const block = blocks[keyIndex] as number;
  (blockMembers[block] as number[]).push(keyIndex);
}

const allKeys = Array.from({ length: KEY_COUNT }, (_, index) => index);
const objectKeys: number[][] = [allKeys, ...blockMembers];

export const OBJECT_KEY_INDICES: readonly (readonly number[])[] = Object.freeze(
  objectKeys.map((indices) => Object.freeze(indices.slice())),
);

const objectAreas: number[] = objectKeys.map((indices) => {
  let total = 0;
  for (const index of indices) total += areas[index] as number;
  return total;
});

export const OBJECT_AREAS: readonly number[] = Object.freeze(objectAreas);

if (OBJECT_AREAS.length !== OBJECT_COUNT) {
  throw new Error('object area table has the wrong size');
}
