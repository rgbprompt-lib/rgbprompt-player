// Spiral angle and radius tables for a movable centre, ported from the
// upstream reference (ENGINE.md §1). Integer only. The default centre uses the
// precomputed table; any other centre is computed once and cached.
import { LOGIC_COLS, LOGIC_ROWS } from './constants.ts';
import { SPIRAL_ANG, SPIRAL_RAD } from './spiral_table.ts';
import { isqrt } from './timing.ts';

const ATAN_RATIO: readonly number[] = [
  0, 1, 1, 2, 2, 3, 4, 4, 5, 6, 6, 7, 7, 8, 9, 9, 10, 11, 11, 12, 12, 13, 14, 14, 15, 15, 16, 17, 17, 18, 19,
  19, 20, 20, 21, 22, 22, 23, 23, 24, 25, 25, 26, 26, 27, 28, 28, 29, 29, 30, 31, 31, 32, 32, 33, 34, 34, 35,
  35, 36, 37, 37, 38, 38, 39, 40, 40, 41, 41, 42, 42, 43, 44, 44, 45, 45, 46, 47, 47, 48, 48, 49, 49, 50, 50,
  51, 52, 52, 53, 53, 54, 54, 55, 55, 56, 57, 57, 58, 58, 59, 59, 60, 60, 61, 61, 62, 62, 63, 64, 64, 65, 65,
  66, 66, 67, 67, 68, 68, 69, 69, 70, 70, 71, 71, 72, 72, 73, 73, 74, 74, 75, 75, 76, 76, 77, 77, 78, 78, 79,
  79, 80, 80, 81, 81, 82, 82, 82, 83, 83, 84, 84, 85, 85, 86, 86, 87, 87, 88, 88, 88, 89, 89, 90, 90, 91, 91,
  92, 92, 92, 93, 93, 94, 94, 95, 95, 95, 96, 96, 97, 97, 98, 98, 98, 99, 99, 100, 100, 100, 101, 101, 102,
  102, 102, 103, 103, 104, 104, 104, 105, 105, 106, 106, 106, 107, 107, 107, 108, 108, 109, 109, 109, 110,
  110, 110, 111, 111, 112, 112, 112, 113, 113, 113, 114, 114, 114, 115, 115, 115, 116, 116, 116, 117, 117,
  118, 118, 118, 119, 119, 119, 120, 120, 120, 121, 121, 121, 122, 122, 122, 122, 123, 123, 123, 124, 124,
  124, 125, 125,
];

export interface SpiralGeometry {
  angle: readonly (readonly number[])[];
  radius: readonly (readonly number[])[];
}

interface CachedGeometry extends SpiralGeometry {
  x: number;
  y: number;
}

let cached: CachedGeometry | null = null;

/** Angle and radius (both 0..1000) of every cell around a centre given in thousandths of the board. */
export function spiralGeometry(x = 500, y = 500): SpiralGeometry {
  if (x === 500 && y === 500) return { angle: SPIRAL_ANG, radius: SPIRAL_RAD };
  if (cached && cached.x === x && cached.y === y) return cached;
  const lastCol = LOGIC_COLS - 1;
  const lastRow = LOGIC_ROWS - 1;
  const angle: number[][] = [];
  const radius: number[][] = [];
  const maxX = Math.max(x * lastCol, lastCol * 1000 - x * lastCol);
  const maxY = Math.max(y * lastRow, lastRow * 1000 - y * lastRow);
  const maxRadius = isqrt(maxX * maxX + maxY * maxY);
  for (let r = 0; r < LOGIC_ROWS; r++) {
    const angleRow: number[] = [];
    const radiusRow: number[] = [];
    for (let c = 0; c < LOGIC_COLS; c++) {
      const dx = c * 1000 - x * lastCol;
      const dy = r * 1000 - y * lastRow;
      const ax = Math.abs(dx);
      const ay = Math.abs(dy);
      const hi = Math.max(ax, ay);
      const lo = Math.min(ax, ay);
      // Reason: the ratio index is 0..256, always inside the table.
      let a = hi ? (ATAN_RATIO[Math.floor((lo * 256 + Math.floor(hi / 2)) / hi)] as number) : 0;
      if (ay > ax) a = 250 - a;
      if (dx < 0) a = 500 - a;
      if (dy < 0) a = 1000 - a;
      angleRow.push(a % 1000);
      radiusRow.push(Math.floor((isqrt(dx * dx + dy * dy) * 1000) / maxRadius));
    }
    angle.push(angleRow);
    radius.push(radiusRow);
  }
  cached = { x, y, angle, radius };
  return cached;
}
