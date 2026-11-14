// Typed access to the layout data files. The JSON files are authoritative and
// byte-identical to the copies that used to live in packages/engine/data/boards.
import ansi104CellsJson from '../data/ansi104.cells.json' with { type: 'json' };
import ansi104KleJson from '../data/ansi104.kle.json' with { type: 'json' };
import ansi104RegionsV1Json from '../data/ansi104.regions-v1.json' with { type: 'json' };
import ansi104RegionsV2Json from '../data/ansi104.regions-v2.json' with { type: 'json' };
import genericJson from '../data/generic.json' with { type: 'json' };
import k60KleJson from '../data/k60.kle.json' with { type: 'json' };
import k65KleJson from '../data/k65.kle.json' with { type: 'json' };
import k75KleJson from '../data/k75.kle.json' with { type: 'json' };
import tkl87KleJson from '../data/tkl87.kle.json' with { type: 'json' };

import type { Board, KleBoard } from './types.ts';

// JSON imports infer number[] for cells; the data files are authoritative and
// every entry is a two-element tuple.
export const ANSI104_CELL: Readonly<Record<string, readonly [number, number]>> =
  ansi104CellsJson as unknown as Record<string, readonly [number, number]>;

export const ANSI104_KLE: KleBoard = ansi104KleJson as KleBoard;
export const TKL87_KLE: KleBoard = tkl87KleJson as KleBoard;
export const K75_KLE: KleBoard = k75KleJson as KleBoard;
export const K65_KLE: KleBoard = k65KleJson as KleBoard;
export const K60_KLE: KleBoard = k60KleJson as KleBoard;

export const GENERIC_BOARD: Board = genericJson as unknown as Board;
export const ANSI104_REGIONS_V1: Board = ansi104RegionsV1Json as unknown as Board;
export const ANSI104_REGIONS_V2: Board = ansi104RegionsV2Json as unknown as Board;
