// Output stage between the engine and the keys (formerly the real-time flash
// limiter, FLASH-SAFETY.md §5.2).
//
// Product policy: RGBPrompt renders effects exactly as the engine computes
// them (WYSIWYG). There is no flash-rate limit, no brightness slew limit and no
// hold clamp, on the web preview or in the Player. `step` copies its input to
// a stable output buffer and validates the frame shape; nothing else (`dtMs`
// is accepted by the interface and ignored).
//
// The `createLimiter` name and `step(keysRgb, dtMs)` signature are kept so the
// web pipeline and the Player core (QuickJS, ADR-0014) share one call site.
import { KEY_COUNT } from './geometry.ts';
import type { Limiter } from './types.ts';

const CHANNEL_COUNT = KEY_COUNT * 3;

export function createLimiter(): Limiter {
  const output = new Uint8Array(CHANNEL_COUNT);
  return {
    step(keysRgb: Uint8Array): Uint8Array {
      if (keysRgb.length !== CHANNEL_COUNT) {
        throw new Error(`expected ${CHANNEL_COUNT} bytes (${KEY_COUNT} keys), got ${keysRgb.length}`);
      }
      output.set(keysRgb);
      return output;
    },
  };
}
