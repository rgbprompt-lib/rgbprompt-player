// Debounced extremum tracking used by the offline flash detector.
//
// A transition is recorded when the signal moves at least `amplitudeFixed`
// away from the running extreme in the opposite direction. The running extreme
// keeps moving while the signal continues in the same direction, so a monotonic
// ramp produces at most one transition. Consecutive transitions alternate in
// direction by construction.
import { WINDOW_MS } from './constants.ts';

export interface TransitionState {
  initialized: boolean;
  lastExtremum: number;
  direction: number;
  eventFrom: number;
  eventTo: number;
  eventDirection: number;
  eventTimeMs: number;
}

export function makeTransitionState(): TransitionState {
  return {
    initialized: false,
    lastExtremum: 0,
    direction: 0,
    eventFrom: 0,
    eventTo: 0,
    eventDirection: 0,
    eventTimeMs: 0,
  };
}

export function advanceTransition(
  state: TransitionState,
  value: number,
  timeMs: number,
  amplitudeFixed: number,
): boolean {
  if (!state.initialized) {
    state.initialized = true;
    state.lastExtremum = value;
    return false;
  }

  if (state.direction === 0) {
    if (value >= state.lastExtremum + amplitudeFixed) {
      return record(state, state.lastExtremum, value, 1, timeMs);
    }
    if (value <= state.lastExtremum - amplitudeFixed) {
      return record(state, state.lastExtremum, value, -1, timeMs);
    }
    return false;
  }

  if (state.direction > 0) {
    if (value > state.lastExtremum) {
      state.lastExtremum = value;
      return false;
    }
    if (value <= state.lastExtremum - amplitudeFixed) {
      return record(state, state.lastExtremum, value, -1, timeMs);
    }
    return false;
  }

  if (value < state.lastExtremum) {
    state.lastExtremum = value;
    return false;
  }
  if (value >= state.lastExtremum + amplitudeFixed) {
    return record(state, state.lastExtremum, value, 1, timeMs);
  }
  return false;
}

function record(state: TransitionState, from: number, to: number, direction: number, timeMs: number): true {
  state.eventFrom = from;
  state.eventTo = to;
  state.eventDirection = direction;
  state.eventTimeMs = timeMs;
  state.lastExtremum = to;
  state.direction = direction;
  return true;
}

// Pair consecutive opposing transitions into flashes. Each transition already
// meets the amplitude threshold. `darkThresholdFixed` is null for red flashes,
// which have no darker-state rule.
export function flashesFromTransitions(
  timesMs: readonly number[],
  fromValues: readonly number[],
  toValues: readonly number[],
  darkThresholdFixed: number | null,
): number[] {
  const flashes: number[] = [];
  const pairCount = Math.floor(timesMs.length / 2);
  for (let pair = 0; pair < pairCount; pair++) {
    const first = pair * 2;
    const second = first + 1;
    if (darkThresholdFixed !== null) {
      const darker = Math.min(
        fromValues[first] as number,
        toValues[first] as number,
        fromValues[second] as number,
        toValues[second] as number,
      );
      if (darker >= darkThresholdFixed) continue;
    }
    flashes.push(timesMs[second] as number);
  }
  return flashes;
}

// Maximum number of events in any half-open 1 s window [start, start + 1000).
export function maxInWindow(
  sortedTimesMs: readonly number[],
  windowMs = WINDOW_MS,
): { count: number; startMs: number } {
  let bestCount = 0;
  let bestStart = 0;
  let end = 0;
  for (let startIndex = 0; startIndex < sortedTimesMs.length; startIndex++) {
    const startMs = sortedTimesMs[startIndex] as number;
    const limit = startMs + windowMs;
    while (end < sortedTimesMs.length && (sortedTimesMs[end] as number) < limit) {
      end++;
    }
    const count = end - startIndex;
    if (count > bestCount) {
      bestCount = count;
      bestStart = startMs;
    }
  }
  return { count: bestCount, startMs: bestStart };
}
