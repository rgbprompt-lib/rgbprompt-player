// The reference layout (ENGINE.md §4.1): 104 named keys, their logical cells,
// and conversion from a logical engine frame to physical key RGB.
import { ANSI104_CELL } from './data.ts';
import type { FrameLike } from './types.ts';

export { ANSI104_CELL };

// Authoritative order: the textual (file) order of ansi104.cells.json. It is
// listed explicitly because JS hoists integer-like object keys ("1".."9", "0")
// ahead of string keys, so Object.keys() would not reproduce the file order.
export const ANSI104_KEYS: readonly string[] = Object.freeze([
  'ESC',
  'F1',
  'F2',
  'F3',
  'F4',
  'F5',
  'F6',
  'F7',
  'F8',
  'F9',
  'F10',
  'F11',
  'F12',
  'PRINTSCREEN',
  'SCROLLLOCK',
  'PAUSE',
  'GRAVE',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '0',
  'MINUS',
  'EQUAL',
  'BACKSPACE',
  'INSERT',
  'HOME',
  'PAGEUP',
  'NUMLOCK',
  'KP_SLASH',
  'KP_ASTERISK',
  'KP_MINUS',
  'TAB',
  'Q',
  'W',
  'E',
  'R',
  'T',
  'Y',
  'U',
  'I',
  'O',
  'P',
  'LBRACKET',
  'RBRACKET',
  'BACKSLASH',
  'DELETE',
  'END',
  'PAGEDOWN',
  'KP_7',
  'KP_8',
  'KP_9',
  'KP_PLUS',
  'CAPSLOCK',
  'A',
  'S',
  'D',
  'F',
  'G',
  'H',
  'J',
  'K',
  'L',
  'SEMICOLON',
  'QUOTE',
  'ENTER',
  'KP_4',
  'KP_5',
  'KP_6',
  'LSHIFT',
  'Z',
  'X',
  'C',
  'V',
  'B',
  'N',
  'M',
  'COMMA',
  'PERIOD',
  'SLASH',
  'RSHIFT',
  'UP',
  'KP_1',
  'KP_2',
  'KP_3',
  'KP_ENTER',
  'LCTRL',
  'LGUI',
  'LALT',
  'SPACE',
  'RALT',
  'RGUI',
  'APPLICATION',
  'RCTRL',
  'LEFT',
  'DOWN',
  'RIGHT',
  'KP_0',
  'KP_PERIOD',
]);

// Convert a 6 x 22 logical frame to 104 x 3 physical key bytes in ANSI104_KEYS
// order. Brightness rule: channel = floor(color * level / 100), which is the
// engine preview path levelToPhysical(level, 20) followed by / 200:
//   levelToPhysical(l, 20) = floor(l * 20 * 200 / (20 * 100)) = 2 * l
//   preview channel        = floor(c * (2 * l) / 200)          = floor(c * l / 100)
export function frameToKeyRgb(frame: FrameLike): Uint8Array {
  const out = new Uint8Array(ANSI104_KEYS.length * 3);
  for (let i = 0; i < ANSI104_KEYS.length; i++) {
    const key = ANSI104_KEYS[i] as string;
    const cell = ANSI104_CELL[key];
    if (!cell) continue;
    const row = frame[cell[0]];
    const px = row ? row[cell[1]] : undefined;
    if (!px) continue;
    const off = i * 3;
    out[off] = Math.floor((px.r * px.l) / 100);
    out[off + 1] = Math.floor((px.g * px.l) / 100);
    out[off + 2] = Math.floor((px.b * px.l) / 100);
  }
  return out;
}
