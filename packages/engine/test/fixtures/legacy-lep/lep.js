// .lep binary container encode/decode. docs/09.
// Layout: FileHeader + [metaLen u16][meta ascii] + layer records (compact,
// see src/codec.js / docs/schemas/param-layout.json) + CRC32.
import { LOGIC_ROWS, LOGIC_COLS } from '../../../src/constants.ts';
import { maskToCells } from '../../../src/normalize.ts';
import { encodeLayer, decodeLayer } from './codec.js';

export const HEADER_SIZE = 44;
export const MAGIC = 'LEP1';
export const PKG_VERSION = 2; // v2 adds per-layer easing LUT; v1 is incompatible
export const DSL_VERSION = 1;
const FLAG_HAS_META = 0x01;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function encode(program) {
  const meta = Buffer.from(JSON.stringify(program.meta || {}), 'utf8');
  const metaLenBuf = Buffer.alloc(2);
  metaLenBuf.writeUInt16LE(meta.length, 0);
  const layers = program.layers.map(encodeLayer);
  const body = Buffer.concat([metaLenBuf, meta, ...layers]);

  const totalSize = HEADER_SIZE + body.length + 4;
  const buf = Buffer.alloc(totalSize);
  buf.write(MAGIC, 0, 'ascii');
  buf.writeUInt16LE(PKG_VERSION, 4);
  buf.writeUInt16LE(DSL_VERSION, 6);
  buf.writeUInt8(LOGIC_ROWS, 8);
  buf.writeUInt8(LOGIC_COLS, 9);
  buf.writeUInt8(program.layers.length, 10);
  buf.writeUInt8(FLAG_HAS_META, 11);
  buf.writeUInt32LE(program.seed >>> 0, 12);
  buf.writeUInt32LE(HEADER_SIZE, 16); // offsetMeta
  buf.writeUInt32LE(HEADER_SIZE + 2 + meta.length, 20); // offsetLayers
  buf.writeUInt32LE(0, 24);
  buf.writeUInt32LE(0, 28);
  buf.writeUInt32LE(0, 32);
  buf.writeUInt32LE(totalSize, 36);
  body.copy(buf, HEADER_SIZE);
  buf.writeUInt32LE(crc32(buf.subarray(0, totalSize - 4)), totalSize - 4);
  return buf;
}

export function decode(buf) {
  if (buf.length < HEADER_SIZE) throw new Error('lep: too small');
  if (buf.toString('ascii', 0, 4) !== MAGIC) throw new Error('lep: bad magic');
  const pkgVersion = buf.readUInt16LE(4);
  const dslVersion = buf.readUInt16LE(6);
  const rows = buf.readUInt8(8);
  const cols = buf.readUInt8(9);
  const layerCount = buf.readUInt8(10);
  const flags = buf.readUInt8(11);
  const seed = buf.readUInt32LE(12);
  const offsetMeta = buf.readUInt32LE(16);
  const offsetLayers = buf.readUInt32LE(20);
  const totalSize = buf.readUInt32LE(36);
  const payloadCrc = buf.readUInt32LE(totalSize - 4);

  if (pkgVersion !== PKG_VERSION) {
    throw new Error(
      `lep: incompatible package (version ${pkgVersion}, this tool needs ${PKG_VERSION}) — re-export with the current lepc/edit code`,
    );
  }
  if (rows !== LOGIC_ROWS || cols !== LOGIC_COLS) throw new Error('lep: logical dims mismatch');
  if (totalSize !== buf.length) throw new Error('lep: total_size mismatch');
  if (offsetMeta < HEADER_SIZE || offsetLayers < HEADER_SIZE || offsetLayers > totalSize - 4) {
    throw new Error('lep: corrupt offsets');
  }
  if (crc32(buf.subarray(0, totalSize - 4)) !== payloadCrc) throw new Error('lep: crc mismatch');

  let meta = {};
  if (flags & FLAG_HAS_META) {
    const metaLen = buf.readUInt16LE(offsetMeta);
    meta = JSON.parse(buf.toString('utf8', offsetMeta + 2, offsetMeta + 2 + metaLen));
  }

  const layers = [];
  let off = offsetLayers;
  try {
    for (let i = 0; i < layerCount; i++) {
      const { layer, offset } = decodeLayer(buf, off);
      off = offset;
      if (!layer.component) throw new Error('unknown component id');
      layer.cells = maskToCells(layer.mask);
      layers.push(layer);
    }
  } catch (e) {
    throw new Error(
      `lep: malformed layer data (${e.message}) — the file may be from an old/incompatible build`,
    );
  }
  if (off > totalSize - 4) throw new Error('lep: layer data overruns the package');

  return { pkgVersion, dslVersion, seed, meta, program: { seed, layers, meta } };
}
