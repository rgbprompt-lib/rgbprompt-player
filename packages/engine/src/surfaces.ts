// Surface expansion: DSL surface -> ordered list of logical cells. docs/03 §6.
import { ANSI104_REGIONS_V1, ANSI104_REGIONS_V2, GENERIC_BOARD } from '@rgbprompt/layouts';
import { LOGIC_ROWS, LOGIC_COLS } from './constants.ts';
import type { Board, BoardCell, SurfaceDsl } from './types.ts';

// Reason: layout data types region cells as number[][]; the board tables are
// authoritative and every region cell is a two-element tuple.
const genericBoard = GENERIC_BOARD as unknown as Board;
const ansi104Board = ANSI104_REGIONS_V1 as unknown as Board;
const ansi104v2Board = ANSI104_REGIONS_V2 as unknown as Board;

export function boardForEffect(dsl: unknown, board?: Board | null): Board {
  // Reason: only meta.region_profile is read; non-objects have no meta, as before.
  const profile = (dsl as { meta?: { region_profile?: string } } | null | undefined)?.meta?.region_profile;
  if (profile === undefined || profile === 'legacy') return board || loadBoard();
  if (profile === 'ansi104-v2') {
    return ansi104v2Board;
  }
  if (profile === 'ansi104-v1') {
    return ansi104Board;
  }
  throw new Error(`unknown region_profile "${profile}"`);
}

export function loadBoard(): Board {
  return genericBoard;
}

function allCells(): BoardCell[] {
  const cells: BoardCell[] = [];
  for (let r = 0; r < LOGIC_ROWS; r++) {
    for (let c = 0; c < LOGIC_COLS; c++) cells.push([r, c]);
  }
  return cells;
}

function parseCell(str: string): BoardCell | null {
  const m = /^(\d+),(\d+)$/.exec(str);
  if (!m) return null;
  const r = Number(m[1]);
  const c = Number(m[2]);
  if (r < 0 || r >= LOGIC_ROWS || c < 0 || c >= LOGIC_COLS) return null;
  return [r, c];
}

function inRegion(regionList: BoardCell[], region: BoardCell): boolean {
  return regionList.some(([r, c]) => r === region[0] && c === region[1]);
}

// Expand a surface to a de-duplicated, row-major ordered cell list.
// Throws on invalid surface definitions.
export function expandSurface(surface: SurfaceDsl, board?: Board | null): BoardCell[] {
  if (!surface || typeof surface !== 'object' || !surface.type) {
    throw new Error('surface: missing type');
  }
  const b = board || loadBoard();
  const regions = b.regions || {};
  let cells: BoardCell[] = [];

  switch (surface.type) {
    case 'all':
      cells = allCells();
      break;
    case 'regions': {
      const list = surface.regions || [];
      if (!list.length) throw new Error('surface.regions: empty');
      for (const name of list) {
        const def = regions[name];
        if (def === 'ALL') {
          cells.push(...allCells());
        } else if (Array.isArray(def)) {
          for (const c of def) cells.push([c[0], c[1]]);
        } else {
          throw new Error(`surface.regions: unknown region "${name}"`);
        }
      }
      break;
    }
    case 'cells': {
      const list = surface.cells || [];
      if (!list.length) throw new Error('surface.cells: empty');
      for (const s of list) {
        const c = parseCell(s);
        if (!c) throw new Error(`surface.cells: bad cell "${s}"`);
        cells.push(c);
      }
      break;
    }
    case 'rows': {
      const rs =
        surface.rows && surface.rows.length ? surface.rows : Array.from({ length: LOGIC_ROWS }, (_, i) => i);
      for (const r of rs) {
        if (r < 0 || r >= LOGIC_ROWS) throw new Error(`surface.rows: bad row ${r}`);
        for (let c = 0; c < LOGIC_COLS; c++) cells.push([r, c]);
      }
      break;
    }
    case 'cols': {
      const cs =
        surface.cols && surface.cols.length ? surface.cols : Array.from({ length: LOGIC_COLS }, (_, i) => i);
      for (const c of cs) {
        if (c < 0 || c >= LOGIC_COLS) throw new Error(`surface.cols: bad col ${c}`);
        for (let r = 0; r < LOGIC_ROWS; r++) cells.push([r, c]);
      }
      break;
    }
    default:
      throw new Error(`surface: unknown type "${surface.type}"`);
  }

  // de-dup + row-major order
  const seen = new Set<number>();
  const out: BoardCell[] = [];
  for (const [r, c] of cells) {
    const k = r * LOGIC_COLS + c;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push([r, c]);
  }
  // row-major sort
  out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  if (surface.invert) {
    const inv: BoardCell[] = [];
    for (const [r, c] of allCells()) {
      if (!inRegion(out, [r, c])) inv.push([r, c]);
    }
    return inv;
  }
  return out;
}
