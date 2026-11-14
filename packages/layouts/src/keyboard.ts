// Keyboard geometry + physical-key -> logical-cell mapping for realistic preview.
// Geometry comes from a KLE file (data/*.kle.json); the logical cell is the
// LEP logical matrix coordinate driven for that key's LED.
import { ANSI104_CELL, K60_KLE, K65_KLE, K75_KLE, TKL87_KLE, ANSI104_KLE } from './data.ts';
import { parseKLE, bounds } from './kle.ts';
import { LOGIC_ROWS, LOGIC_COLS } from './constants.ts';
import type {
  BoardCell,
  KeyboardKey,
  KeyboardMeta,
  KeyboardModel,
  KleBoard,
  KleKey,
  NamedKey,
} from './types.ts';

// Reason: `lib: ES2022` has no host globals; console.warn exists in every
// runtime that loads this module (Node, browsers, Player engines).
declare const console: { warn(...data: unknown[]): void };

interface BoardDefinition {
  kle: KleBoard;
  label: string;
  cells?: Record<string, BoardCell>;
}

const BOARD_KLE: Record<string, BoardDefinition> = {
  k60: { kle: K60_KLE, label: '60%' },
  k65: { kle: K65_KLE, label: '65%' },
  k75: { kle: K75_KLE, label: '75%' },
  tkl87: { kle: TKL87_KLE, label: 'TKL 87' },
  ansi104: {
    kle: ANSI104_KLE,
    label: 'ANSI 104',
    cells: ANSI104_CELL as unknown as Record<string, BoardCell>,
  },
};

// Map a KLE key (label + position) onto semantic key names used by cells JSON.
export function semanticKeyName(k: KleKey): string | null {
  const full = String(k.label || '').replace(/\n/g, ' ');
  const bottom = k.legendBottom || k.label;
  const numpad = k.x >= 17.25; // Num Lock column and rightward
  const left = k.x < 10;
  const special: Record<string, string> = {
    Esc: 'ESC',
    Backspace: 'BACKSPACE',
    Tab: 'TAB',
    'Caps Lock': 'CAPSLOCK',
    Shift: left ? 'LSHIFT' : 'RSHIFT',
    Ctrl: left ? 'LCTRL' : 'RCTRL',
    Alt: left ? 'LALT' : 'RALT',
    Win: left ? 'LGUI' : 'RGUI',
    Fn: 'FN',
    Menu: 'APPLICATION',
    Del: 'DELETE',
    Space: 'SPACE',
    PrtSc: 'PRINTSCREEN',
    'Scroll Lock': 'SCROLLLOCK',
    Pause: 'PAUSE',
    Insert: 'INSERT',
    Home: 'HOME',
    PgUp: 'PAGEUP',
    Delete: 'DELETE',
    End: 'END',
    PgDn: 'PAGEDOWN',
    'Num Lock': 'NUMLOCK',
    '↑': 'UP',
    '↓': 'DOWN',
    '←': 'LEFT',
    '→': 'RIGHT',
  };
  if (full === 'Enter' || bottom === 'Enter') return numpad ? 'KP_ENTER' : 'ENTER';
  // Reason: the guard above proves this lookup exists.
  if (special[full]) return special[full] as string;
  if (numpad) {
    // Reason: split always returns at least one element.
    const top = String(k.label || '').split('\n')[0] as string;
    if (bottom === '/' || top === '/') return 'KP_SLASH';
    if (bottom === '*' || top === '*') return 'KP_ASTERISK';
    if (bottom === '-' || top === '-') return 'KP_MINUS';
    if (bottom === '+' || top === '+') return 'KP_PLUS';
    if (bottom === '.' || bottom === 'Del' || top === '.') return 'KP_PERIOD';
    if (/^[0-9]$/.test(top)) return 'KP_' + top;
    if (/^[0-9]$/.test(bottom)) return 'KP_' + bottom;
    return null;
  }
  const sym: Record<string, string> = {
    '`': 'GRAVE',
    1: '1',
    2: '2',
    3: '3',
    4: '4',
    5: '5',
    6: '6',
    7: '7',
    8: '8',
    9: '9',
    0: '0',
    '-': 'MINUS',
    '=': 'EQUAL',
    '[': 'LBRACKET',
    ']': 'RBRACKET',
    '\\': 'BACKSLASH',
    ';': 'SEMICOLON',
    "'": 'QUOTE',
    ',': 'COMMA',
    '.': 'PERIOD',
    '/': 'SLASH',
  };
  // Reason: the guard above proves this lookup exists.
  if (sym[bottom]) return sym[bottom] as string;
  if (/^F([1-9]|1[0-2])$/.test(bottom)) return bottom;
  if (/^[A-Z]$/.test(bottom)) return bottom;
  return null;
}

// KLE keys resolved to semantic names and centres (KLE key units). Used by
// layoutMap for key-name correspondence and nearest-neighbour fallback.
export function layoutKeysFromKle(kle: KleBoard): NamedKey[] {
  const keys = parseKLE(kle);
  for (const k of keys) {
    const parts = k.label.split('\n');
    k.legendTop = parts.length > 1 ? (parts[0] as string) : '';
    k.legendBottom = parts.length > 1 ? (parts[1] as string) : (parts[0] as string);
  }
  return keys.map((k) => ({
    name: semanticKeyName(k),
    cx: k.x + k.w / 2,
    cy: k.y + k.h / 2,
  }));
}

const cache = new Map<string, KeyboardModel>();
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export function loadKeyboard(name = 'tkl87'): KeyboardModel {
  // Reason: the guard above proves the cached value exists.
  if (cache.has(name)) return cache.get(name) as KeyboardModel;
  const def = BOARD_KLE[name];
  if (!def) throw new Error(`unknown keyboard "${name}"`);
  const kle = def.kle;
  // Reason: parseKLE creates the mutable key objects; the fields below are
  // filled in before any caller sees them.
  const keys = parseKLE(kle) as KeyboardKey[];
  const { maxX, maxY } = bounds(keys);
  for (const k of keys) {
    const parts = k.label.split('\n');
    // Reason: the length check above proves the indices exist.
    k.legendTop = parts.length > 1 ? (parts[0] as string) : '';
    k.legendBottom = parts.length > 1 ? (parts[1] as string) : (parts[0] as string);
  }
  if (def.cells) {
    const cells = def.cells;
    const missing: string[] = [];
    for (const k of keys) {
      const nm = semanticKeyName(k);
      // Reason: the guard above proves this lookup exists.
      if (nm && cells[nm]) {
        k.cell = cells[nm] as BoardCell;
      } else {
        missing.push(`${JSON.stringify(k.label)}@${k.x},${k.y}`);
        const row = clamp(Math.round(k.y), 0, LOGIC_ROWS - 1);
        const col = clamp(Math.round(((k.x + k.w / 2) / maxX) * (LOGIC_COLS - 1)), 0, LOGIC_COLS - 1);
        k.cell = [row, col];
      }
    }
    if (missing.length) console.warn(`[${name}] missing cells for: ${missing.join(' | ')}`);
  } else {
    for (const k of keys) {
      const row = clamp(Math.round(k.y), 0, LOGIC_ROWS - 1);
      const col = clamp(Math.round(((k.x + k.w / 2) / maxX) * (LOGIC_COLS - 1)), 0, LOGIC_COLS - 1);
      k.cell = [row, col];
    }
  }
  const kb: KeyboardModel = { name, label: def.label, unit: 1, maxX, maxY, keys };
  cache.set(name, kb);
  return kb;
}

export function listKeyboards(): string[] {
  return Object.keys(BOARD_KLE);
}

export function listKeyboardMeta(): KeyboardMeta[] {
  // Reason: listKeyboards() only yields keys of BOARD_KLE.
  return listKeyboards().map((id) => ({ id, label: (BOARD_KLE[id] as BoardDefinition).label }));
}

export function allKeyboards(): Record<string, KeyboardModel> {
  const out: Record<string, KeyboardModel> = {};
  for (const id of listKeyboards()) out[id] = loadKeyboard(id);
  return out;
}
