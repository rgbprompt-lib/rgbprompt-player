// Minimal KLE (keyboard-layout-editor) parser. Supports the common subset:
// rows as arrays; string = key label; object = {x,y,w,h} offsets for the
// following key only (w/h reset after each key). Returns keys with absolute
// unit coordinates. Geometry format reference: http://www.keyboard-layout-editor.com/
import type { KleBoard, KleKey } from './types.ts';

export function parseKLE(kle: KleBoard): KleKey[] {
  const keys: KleKey[] = [];
  let y = 0;
  for (const row of kle) {
    let x = 0;
    let w = 1;
    let h = 1;
    for (const item of row) {
      if (typeof item === 'string') {
        keys.push({ label: item, x, y, w, h });
        x += w;
        w = 1;
        h = 1;
      } else if (item && typeof item === 'object') {
        if (item.x) x += item.x;
        if (item.y) {
          y += item.y;
          x = 0;
        }
        if (item.w !== undefined) w = item.w;
        if (item.h !== undefined) h = item.h;
      }
    }
    y += 1;
  }
  return keys;
}

export function bounds(keys: readonly KleKey[]): { maxX: number; maxY: number } {
  let maxX = 0;
  let maxY = 0;
  for (const k of keys) {
    maxX = Math.max(maxX, k.x + k.w);
    maxY = Math.max(maxY, k.y + k.h);
  }
  return { maxX, maxY };
}
