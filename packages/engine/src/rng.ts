// Deterministic PRNG used by the reference renderer and other engine modules.
// docs/07 §7: xorshift32. State must never be zero.

// UTF-8 bytes of a JS string, including U+FFFD for lone surrogates, without
// relying on a host UTF-8 encoder (QuickJS has none).
export function utf8Bytes(input: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i++) {
    let code = input.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < input.length ? input.charCodeAt(i + 1) : -1;
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      } else {
        code = 0xfffd;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      code = 0xfffd;
    }
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return bytes;
}

// UTF-8 decoding without a host decoder. Malformed sequences produce U+FFFD
// per maximal subpart, matching the previous host decoder.
export function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  let needed = 0;
  let seen = 0;
  let codePoint = 0;
  let lower = 0x80;
  let upper = 0xbf;
  let index = 0;
  while (index < bytes.length) {
    // Reason: index < bytes.length in the loop condition.
    const byte = bytes[index] as number;
    index++;
    if (needed === 0) {
      if (byte <= 0x7f) {
        out += String.fromCharCode(byte);
      } else if (byte >= 0xc2 && byte <= 0xdf) {
        needed = 1;
        codePoint = byte & 0x1f;
      } else if (byte >= 0xe0 && byte <= 0xef) {
        if (byte === 0xe0) lower = 0xa0;
        else if (byte === 0xed) upper = 0x9f;
        needed = 2;
        codePoint = byte & 0x0f;
      } else if (byte >= 0xf0 && byte <= 0xf4) {
        if (byte === 0xf0) lower = 0x90;
        else if (byte === 0xf4) upper = 0x8f;
        needed = 3;
        codePoint = byte & 0x07;
      } else {
        out += '\ufffd';
      }
    } else if (byte < lower || byte > upper) {
      needed = 0;
      seen = 0;
      codePoint = 0;
      lower = 0x80;
      upper = 0xbf;
      out += '\ufffd';
      index--;
    } else {
      lower = 0x80;
      upper = 0xbf;
      codePoint = (codePoint << 6) | (byte & 0x3f);
      seen++;
      if (seen === needed) {
        out += String.fromCodePoint(codePoint);
        needed = 0;
        seen = 0;
        codePoint = 0;
      }
    }
  }
  if (needed !== 0) out += '\ufffd';
  return out;
}

export function sparkleIdHash(id: string): number {
  let h = 0x811c9dc5;
  for (const b of utf8Bytes(id || '')) h = Math.imul((h ^ b) >>> 0, 0x01000193) >>> 0;
  return h;
}

// Pure integer mixer for time/layer/cell identities. Reuses the avalanche
// steps of sparkleHash; it never touches the shared RNG state.
export function hash32(...values: Array<number | string>): number {
  let x = 0x9e3779b9;
  for (const value of values) {
    x = Math.imul((x ^ (Number(value) >>> 0)) >>> 0, 0x9e3779b9) >>> 0;
    x ^= x >>> 16;
    x = Math.imul(x, 0x7feb352d) >>> 0;
    x ^= x >>> 15;
    x = Math.imul(x, 0x846ca68b) >>> 0;
    x = (x ^ (x >>> 16)) >>> 0;
  }
  return x >>> 0;
}

export class Rng {
  s: number;

  constructor(seed: number) {
    let s = seed >>> 0;
    if (s === 0) s = 0x9e3779b9 >>> 0; // fixed non-zero constant
    this.s = s >>> 0;
  }

  // xorshift32
  next(): number {
    let x = this.s >>> 0;
    x ^= (x << 13) >>> 0;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= (x << 5) >>> 0;
    x >>>= 0;
    this.s = x >>> 0;
    return x >>> 0;
  }

  // returns integer in [0, n)
  int(n: number): number {
    if (n <= 0) return 0;
    return this.next() % n;
  }
}

/** Deterministic audio-onset origin pick. Same mixer on every end; integer-only. */
export function pickRandomMaskedKey(
  seed: number,
  layerSalt: number,
  onsetTick: number,
  seq: number,
  candidates: ReadonlyArray<readonly [number, number]>,
): [number, number] | null {
  if (!candidates.length) return null;
  const idx = hash32(seed >>> 0, layerSalt >>> 0, onsetTick >>> 0, seq >>> 0) % candidates.length;
  const cell = candidates[idx];
  if (!cell) return null;
  return [cell[0], cell[1]];
}

/** Collect present+masked logical keys in row-major order (r outer, c inner). */
export function collectMaskedKeys(
  rows: number,
  cols: number,
  present: (r: number, c: number) => boolean,
  inMask: (r: number, c: number) => boolean,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) if (present(r, c) && inMask(r, c)) out.push([r, c]);
  return out;
}
