// Angled and mirrored wave projection, ported from the upstream reference
// (ENGINE.md §1). Integer only: the coefficients are pre-normalised so the
// result needs no floating point. Index = angle within one quadrant, 0..90.
import { LOGIC_COLS, LOGIC_ROWS } from './constants.ts';

export const WAVE_COEFFICIENTS: readonly (readonly [number, number])[] = [
  [45455, 0],
  [45239, 790],
  [45026, 1572],
  [44814, 2349],
  [44604, 3119],
  [44395, 3884],
  [44188, 4644],
  [43982, 5400],
  [43777, 6152],
  [43572, 6901],
  [43369, 7647],
  [43166, 8391],
  [42964, 9132],
  [42762, 9872],
  [42560, 10612],
  [42359, 11350],
  [42158, 12089],
  [41956, 12827],
  [41754, 13567],
  [41552, 14308],
  [41350, 15050],
  [41147, 15795],
  [40943, 16542],
  [40738, 17292],
  [40533, 18046],
  [40326, 18804],
  [40118, 19567],
  [39909, 20335],
  [39698, 21108],
  [39485, 21887],
  [39271, 22673],
  [39055, 23466],
  [38836, 24268],
  [38615, 25077],
  [38392, 25896],
  [38166, 26724],
  [37937, 27563],
  [37706, 28413],
  [37470, 29275],
  [37232, 30150],
  [36990, 31038],
  [36743, 31941],
  [36493, 32859],
  [36238, 33793],
  [35979, 34744],
  [35714, 35714],
  [35444, 36704],
  [35169, 37714],
  [34887, 38746],
  [34599, 39802],
  [34305, 40883],
  [34003, 41990],
  [33693, 43125],
  [33375, 44291],
  [33049, 45488],
  [32713, 46719],
  [32367, 47987],
  [32011, 49293],
  [31644, 50640],
  [31264, 52032],
  [30872, 53471],
  [30465, 54961],
  [30044, 56505],
  [29607, 58107],
  [29153, 59772],
  [28680, 61505],
  [28188, 63311],
  [27674, 65196],
  [27137, 67166],
  [26574, 69228],
  [25984, 71391],
  [25364, 73664],
  [24712, 76056],
  [24024, 78579],
  [23297, 81245],
  [22526, 84070],
  [21709, 87068],
  [20838, 90260],
  [19909, 93666],
  [18915, 97311],
  [17848, 101223],
  [16699, 105436],
  [15458, 109988],
  [14111, 114926],
  [12644, 120304],
  [11040, 126187],
  [9276, 132654],
  [7327, 139802],
  [5159, 147749],
  [2734, 156641],
  [0, 166667],
];

/**
 * Position of a cell along the wave, in thousandths of one palette cycle.
 * `angle` is 0..359 degrees, `width` is the cycle length in percent of the
 * board, `sign` flips the spatial order and `mirror` folds it about the centre.
 */
export function waveProjection(
  row: number,
  col: number,
  angle: number,
  width = 100,
  sign = 1,
  mirror = false,
): number {
  if (angle % 90 === 0) {
    const horizontal = angle % 180 === 0;
    const pos = horizontal ? col : row;
    const span = horizontal ? LOGIC_COLS : LOGIC_ROWS;
    const direction = angle >= 180 ? -1 : 1;
    const along = mirror ? sign * Math.abs(2 * pos - span) : sign * direction * pos;
    return Math.trunc((along * 100000) / (span * width));
  }
  let q = angle;
  let x = 1;
  let y = 1;
  if (angle > 270) {
    q = 360 - angle;
    y = -1;
  } else if (angle > 180) {
    q = angle - 180;
    x = -1;
    y = -1;
  } else if (angle > 90) {
    q = 180 - angle;
    x = -1;
  }
  // Reason: q is 1..89 here, always inside the table.
  const k = WAVE_COEFFICIENTS[q] as readonly [number, number];
  const projection =
    (col - (mirror ? LOGIC_COLS / 2 : 0)) * k[0] * x + (row - (mirror ? LOGIC_ROWS / 2 : 0)) * k[1] * y;
  return Math.trunc((sign * (mirror ? 2 * Math.abs(projection) : projection) * 100) / (1000 * width));
}
