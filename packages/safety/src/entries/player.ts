// Player entry: the real-time limiter plus the frame-to-keys step it is
// defined over. The limiter works on 104 keys in KEY_NAMES order, so the
// mapping from the engine's 6 x 22 frame to those keys ships in the same
// bundle (PLAYER.md §9.0.4). Nothing else is exported.
export { createLimiter } from '../limiter.ts';
export { CONSTANTS } from '../constants.ts';
export { KEY_CELLS, KEY_CENTRES_QUARTER, KEY_COUNT, KEY_NAMES } from '../geometry.ts';
export { frameToKeyRgb } from '@rgbprompt/layouts';
