import { DEFAULT_GEOMETRY } from './geometry.ts';
import type { BoardCell, Geometry, RainEvent, RainParams, RainSample } from './types.ts';

// Deterministic rain event schedule. All distances are eighths of a key.
// This module models events only; the renderer must mirror these integer rules.
export function rainHash(seed: number, n: number): number {
  let x = (seed ^ Math.imul(n, 0x9e3779b9)) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

// Seed-rotated shuffle step pattern, separated for any five consecutive drops.
// A board with more lanes repeats it in blocks of 23 (lane + 23k); a board with
// fewer keeps only the lanes it has, so the order stays a permutation.
const LANE_SHUFFLE = [8, 12, 4, 14, 18, 2, 0, 5, 20, 11, 7, 9, 16, 19, 21, 13, 1, 17, 10, 3, 22, 15, 6];
/** Most rain lanes any geometry may derive (also the firmware's table size). */
export const RAIN_MAX_LANES = 24;
/** Lanes are one key apart, in 1/8 key units. */
const LANE_PITCH = 8;
/** A key at least this wide (4u) catches every lane over it, e.g. a space bar. */
const BAR_MIN_WIDTH = 32;
/** Nearest-LED catchment: one key, wider on the bottom row's 1.25u keys. */
const CATCH_ROW = 9,
  CATCH_BOTTOM = 13;

function laneOrder(count: number): number[] {
  const order: number[] = [];
  for (let block = 0; order.length < count; block += LANE_SHUFFLE.length)
    for (const lane of LANE_SHUFFLE) if (lane + block < count) order.push(lane + block);
  return order;
}

// Time is relative to playback start. Intro has 2–3 staggered drops per lane;
// Afterwards three drops per second, with five extra drops every seven seconds.
export function rainEvents(
  tick: number,
  seed = 1,
  params: RainParams = {},
  geometry: RainGeometry = rainGeometry(),
): RainEvent[] {
  const events: RainEvent[] = [];
  const lanes = geometry.count,
    order = geometry.order;
  const rate = params.drops_per_second ?? 3,
    period = params.shower_period_s ?? 7;
  const extra = params.shower_extra ?? 5;
  const fallMin = params.fall_min_ms ?? 750,
    fallMax = params.fall_max_ms ?? 900;
  const tail1 = params.tail_first ?? 40,
    tail2 = params.tail_second ?? 10;
  const splash = params.splash_ms ?? 160;
  if (tick < 1800)
    for (let lane = 0; lane < lanes; lane++) {
      const h = rainHash(seed, lane);
      const delay = h % 451;
      const count = 2 + ((h >>> 9) % 2);
      for (let n = 0; n < count; n++) {
        const hash = rainHash(seed ^ lane, n + 32);
        const born = delay + n * 300;
        const fall = 380 + (hash % 141);
        if (tick >= born && tick - born <= fall + 800) events.push({ lane, born, fall, intro: true });
      }
    }
  if (tick >= 1500) {
    const second = Math.floor((tick - 1500) / 1000);
    for (let sec = Math.max(0, second - 3); sec <= second; sec++) {
      const burst = period > 0 && sec % period === period - 1;
      const amount = rate + (burst ? extra : 0);
      const offsets =
        rate === 3 && burst && extra === 5
          ? [0, 110, 220, 333, 440, 550, 666, 770]
          : Array.from({ length: amount }, (_, i) => Math.floor((i * 1000) / amount));
      for (let i = 0; i < amount; i++) {
        // Reason: i < amount and both offset branches have at least amount entries.
        const born = 1500 + sec * 1000 + (offsets[i] as number);
        const h = rainHash(seed ^ 0x7161696e, sec * (rate + extra > 8 ? 16 : 8) + i);
        const fall = fallMin + ((h >>> 8) % (fallMax - fallMin + 1));
        const life = fall + Math.max(800, Math.floor((fall * 3) / 5) + 120, splash);
        const index = sec * rate + (period ? Math.floor(sec / period) * extra : 0) + i;
        if (tick >= born && tick - born <= life)
          events.push({
            // Reason: index % lanes is always a valid order index.
            lane: ((seed % lanes) + (order[index % lanes] as number)) % lanes,
            born,
            fall,
            intro: false,
            accent: true,
            tail1,
            tail2,
            splash,
          });
      }
    }
  }
  return events;
}

/** Rain lanes derived from a geometry; the same algorithm runs in every engine. */
export interface RainGeometry {
  count: number;
  order: number[];
  /** x of lane 0 (leftmost LED); lane l sits at originX + 8l. */
  originX: number;
  /** Horizontal span of the LEDs, for the background gradient. */
  width: number;
  /** Top LED row y and the drop's fall height to the bottom LED row. */
  minY: number;
  height: number;
  /** Last table row that carries LEDs; drops splash there. */
  bottom: number;
  lanes: number[][];
  splash: number[][];
}
const rainGeometryCache = new WeakMap<Geometry, RainGeometry>();

export function rainGeometry(geometry: Geometry = DEFAULT_GEOMETRY): RainGeometry {
  const cached = rainGeometryCache.get(geometry);
  if (cached) return cached;
  const positions = geometry.ledPositions;
  let minX = 255,
    maxX = 0,
    minY = 255,
    maxY = 0,
    bottom = 0;
  positions.forEach((row, r) =>
    row.forEach(([x, y]) => {
      if (x === 255) return;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      bottom = r;
    }),
  );
  if (minX > maxX) minX = maxX = minY = maxY = 0;
  const count = Math.max(1, Math.min(RAIN_MAX_LANES, Math.ceil((maxX - minX) / LANE_PITCH) + 1));
  // One LED per row and lane: a bar key (space) over the lane, else the nearest
  // LED within the row's catchment; ties keep the first column.
  const lanes = Array.from({ length: count }, (_, lane) =>
    positions.map((row, r) => {
      const laneX = minX + lane * LANE_PITCH;
      for (let c = 0; c < row.length; c++) {
        // Reason: c is below the row length and width rows match LED rows.
        const x = (row[c] as BoardCell)[0],
          w = (geometry.keyWidths[r]?.[c] ?? 0) as number;
        if (x !== 255 && w >= BAR_MIN_WIDTH && 2 * Math.abs(laneX - x) <= w) return c;
      }
      let best = -1,
        dist = r === bottom ? CATCH_BOTTOM : CATCH_ROW;
      row.forEach(([x], c) => {
        const d = Math.abs(x - laneX);
        if (x !== 255 && d < dist) {
          best = c;
          dist = d;
        }
      });
      return best;
    }),
  );
  const splash = lanes.map((rows) => {
    // Reason: bottom is a row of the LED table.
    const row = positions[bottom] as readonly BoardCell[],
      // Reason: every lane has one entry per LED row.
      center = rows[bottom] as number;
    if (center < 0) return [];
    // Reason: center is a valid column in this row.
    const cx = (row[center] as BoardCell)[0];
    let left = -1,
      right = -1;
    row.forEach(([x], col) => {
      if (x === 255) return;
      // Reason: set indices always point at earlier valid columns in this row.
      if (x < cx && (left < 0 || x > (row[left] as BoardCell)[0])) left = col;
      if (x > cx && (right < 0 || x < (row[right] as BoardCell)[0])) right = col;
    });
    return [left, center, right].filter((c) => c >= 0);
  });
  const derived: RainGeometry = {
    count,
    order: laneOrder(count),
    originX: minX,
    width: Math.max(1, maxX - minX),
    minY,
    height: Math.max(1, maxY - minY),
    bottom,
    lanes,
    splash,
  };
  rainGeometryCache.set(geometry, derived);
  return derived;
}
const defaultRain = rainGeometry();
export { defaultRain as rainDefaultGeometry };
const { lanes: laneCellsDefault, splash: splashCellsDefault } = defaultRain;
export { laneCellsDefault as rainLaneCells, splashCellsDefault as rainSplashCells };

const introDecay = [1000, 600, 360, 216, 129, 77, 46, 28, 17];
export function rainSample(
  x: number,
  y: number,
  tick: number,
  events: readonly RainEvent[],
  row: number | null = null,
  col: number | null = null,
  geometry: RainGeometry = rainGeometry(),
): RainSample {
  const laneCells = geometry.lanes,
    splashCells = geometry.splash,
    { originX, minY, height, bottom } = geometry;
  let best = 0,
    accent = false;
  for (const e of events) {
    const splash = e.intro ? 160 : (e.splash ?? 160);
    const dx = Math.abs(x - (originX + e.lane * LANE_PITCH));
    const age = tick - e.born;
    const introFade = e.intro && tick > 1500 ? Math.max(0, Math.floor(((1800 - tick) * 1000) / 300)) : 1000;
    if (
      e.intro
        ? dx <= 4
        : row === null
          ? dx <= 4
          : // Reason: laneCells covers every event lane.
            (laneCells[e.lane] as number[])[row] === col
    ) {
      const arrival = Math.floor((e.fall * Math.max(0, Math.min(height, y - minY))) / height);
      const since = age - arrival;
      if (since >= 0) {
        const step = Math.floor((Math.max(0, since - 120) * 5) / e.fall);
        const intensity =
          since < 120
            ? Math.floor((since * 1000) / 120)
            : ((e.intro ? introDecay : [1000, (e.tail1 ?? 40) * 10, (e.tail2 ?? 10) * 10])[step] ?? 0);
        const value = Math.floor((intensity * introFade) / 1000);
        if (value > best) {
          best = value;
          accent = !!e.accent;
        }
      }
    }
    // Bottom-row neighbours share a brief splash with a 160 ms fade.
    if (
      (e.intro
        ? y >= minY + height - 4 && dx <= 12
        : // Reason: includes(null) is false, so requiring a column is equivalent.
          row === bottom && col !== null && (splashCells[e.lane] as number[]).includes(col)) &&
      age >= e.fall &&
      splash > 0 &&
      age < e.fall + splash
    ) {
      const value = Math.floor((Math.floor(((e.fall + splash - age) * 1000) / splash) * introFade) / 1000);
      if (value > best) {
        best = value;
        accent = !!e.accent;
      }
    }
  }
  return { level: best, accent };
}
export function rainLevel(x: number, y: number, tick: number, events: readonly RainEvent[]): number {
  return rainSample(x, y, tick, events).level;
}
