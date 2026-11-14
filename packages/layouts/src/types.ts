// Shared layout data types. Kept independent from @rgbprompt/engine so the
// dependency direction stays engine -> layouts (TECHNICAL-DESIGN.md).

export type BoardCell = [number, number];

export type KleKeyObject = {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  [key: string]: unknown;
};

export type KleItem = string | KleKeyObject;

export type KleBoard = readonly (readonly KleItem[])[];

export interface KleKey {
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  legendTop?: string;
  legendBottom?: string;
  cell?: BoardCell;
}

export interface KeyboardKey extends KleKey {
  legendTop: string;
  legendBottom: string;
  cell: BoardCell;
}

export interface KeyboardModel {
  name: string;
  label: string;
  unit: number;
  maxX: number;
  maxY: number;
  keys: KeyboardKey[];
}

export interface KeyboardMeta {
  id: string;
  label: string;
}

export interface Board {
  board_id: string;
  name: string;
  logical: { rows: number; cols: number };
  regions: Record<string, 'ALL' | BoardCell[]>;
  key_labels?: Record<string, string>;
}

// Structural frame input for frameToKeyRgb: the engine's Frame but declared
// locally so this package never imports the engine.
export interface FrameCellLike {
  r: number;
  g: number;
  b: number;
  l: number;
}

export type FrameLike = readonly (readonly FrameCellLike[])[];

// Board layouts we can map ansi104 key colours onto (ENGINE.md §4.4).
export type LayoutId = 'tkl87' | 'k75' | 'k65' | 'k60';

export type RegionId =
  'all' | 'alphas' | 'numbers' | 'f_row' | 'arrows' | 'numpad' | 'left_half' | 'right_half';

export interface RegionLabel {
  id: RegionId;
  labelKey: `tuning.region.${RegionId}`;
}

// A KLE key resolved to its semantic name (ansi104.cells.json key space) and
// its centre in KLE key units (x + w / 2, y + h / 2).
export interface NamedKey {
  name: string | null;
  cx: number;
  cy: number;
}
