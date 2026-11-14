// Deterministic preview helpers: ASCII art and PPM output. docs/13 §5.
import { LOGIC_ROWS, LOGIC_COLS, MAX_LED_LIGHT_LEVEL } from './constants.ts';
import { levelToPhysical } from './render.ts';
import type { Frame, FrameCell } from './types.ts';

const RAMP = ' .:-=+*#%@';

// Render a logical frame as ASCII (uses lightness only) for terminal inspection.
export function frameToAscii(frame: Frame): string {
  const lines: string[] = [];
  for (let r = 0; r < LOGIC_ROWS; r++) {
    let line = '';
    for (let c = 0; c < LOGIC_COLS; c++) {
      // Reason: r and c are logical grid indices, always inside the frame.
      const l = ((frame[r] as FrameCell[])[c] as FrameCell).l;
      const idx = Math.min(RAMP.length - 1, Math.floor((l * RAMP.length) / 101));
      // Reason: idx is clamped to a valid RAMP index.
      line += l === 0 ? ' ' : (RAMP[Math.max(1, idx)] as string);
    }
    lines.push(line);
  }
  return lines.join('\n');
}

// Write frames as a vertically stacked PPM (P6). brightnessLevel applied.
export function framesToPpm(
  frames: Frame[],
  { scale = 6, brightnessLevel = MAX_LED_LIGHT_LEVEL }: { scale?: number; brightnessLevel?: number } = {},
): Uint8Array {
  const w = LOGIC_COLS * scale;
  const h = LOGIC_ROWS * scale * frames.length;
  const headerText = `P6\n${w} ${h}\n255\n`;
  const header = new Uint8Array(headerText.length);
  for (let i = 0; i < headerText.length; i++) header[i] = headerText.charCodeAt(i);
  const body = new Uint8Array(w * h * 3);
  let off = 0;
  for (const frame of frames) {
    for (let y = 0; y < LOGIC_ROWS * scale; y++) {
      const r = Math.floor(y / scale);
      for (let x = 0; x < w; x++) {
        const c = Math.floor(x / scale);
        // Reason: r and c are derived from the scaled frame dimensions.
        const cell = (frame[r] as FrameCell[])[c] as FrameCell;
        const phys = levelToPhysical(cell.l, brightnessLevel);
        body[off++] = Math.min(255, Math.floor((cell.r * phys) / 200));
        body[off++] = Math.min(255, Math.floor((cell.g * phys) / 200));
        body[off++] = Math.min(255, Math.floor((cell.b * phys) / 200));
      }
    }
  }
  const out = new Uint8Array(header.length + body.length);
  out.set(header, 0);
  out.set(body, header.length);
  return out;
}
