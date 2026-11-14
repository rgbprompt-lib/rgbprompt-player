// Keyboard geometry used by the renderer. The generic 104-key layout is the
// default; a connected device or preview target may supply its own tables so
// the same render algorithm runs against that device's physical layout.
import { KEY_CENTRES } from './key_centres.ts';
import { KEY_WIDTHS, LAYOUT_PRESENT, LED_POSITIONS } from './led_positions.ts';
import type { Geometry } from './types.ts';

export const DEFAULT_GEOMETRY: Geometry = {
  keyCentres: KEY_CENTRES,
  ledPositions: LED_POSITIONS,
  present: LAYOUT_PRESENT,
  keyWidths: KEY_WIDTHS,
};

const burstCentres = new WeakMap<Geometry, [number, number]>();

/** Board centre for audio bursts: middle of the key-centre bounding box. */
export function audioBurstCentre(geometry: Geometry): [number, number] {
  let centre = burstCentres.get(geometry);
  if (!centre) {
    const keys = geometry.keyCentres.flat().filter(([x]) => x !== 255);
    const middle = (axis: 0 | 1) =>
      Math.floor((Math.min(...keys.map((key) => key[axis])) + Math.max(...keys.map((key) => key[axis]))) / 2);
    centre = [middle(0), middle(1)];
    burstCentres.set(geometry, centre);
  }
  return centre;
}
