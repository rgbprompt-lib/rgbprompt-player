import { audioContract, instanceLimit, usesAudioContract, usesV15Audio } from './audio/control.ts';
// .lep binary container encode/decode. docs/09.
// Layout: FileHeader + [metaLen u16][meta ascii] + layer records (compact,
// see src/codec.ts / docs/schemas/param-layout.json) + CRC32.
import { LOGIC_ROWS, LOGIC_COLS } from './constants.ts';
import { maskToCells } from './normalize.ts';
import {
  byteView,
  concatBytes,
  decodeLayer,
  encodeLayer,
  featurePackageVersion,
  isAudioPackage,
  layerRequiresV3,
  readByte,
  readUint16LE,
  readUint32LE,
} from './codec.ts';
import { utf8Bytes, utf8Decode } from './rng.ts';
import type { EffectMeta, NormalizedLayer, Program } from './types.ts';

export const HEADER_SIZE = 44;
export const MAGIC = 'LEP1';
export const PKG_VERSION = 3;
export const AUDIO_PKG_VERSION = audioContract.package_version;
export const AUDIO_EXT_PKG_VERSION = audioContract.extended_package_version;
export const MIN_PKG_VERSION = 2;
/** Time-based sparkle: the keyboard runs it from package version 8 (v2 layer layout). */
export const SPARKLE_PKG_VERSION = 8;
export const DSL_VERSION = 1;
/** Non-audio package versions this decoder accepts (ENGINE.md §8.1). */
/** Composable-v1 container (non-audio). Feature versions 13+ still win when needed. */
export const COMPOSABLE_PKG_VERSION = 12;
/** color.alphas container (upstream package 5). */
export const ALPHA_PKG_VERSION = 5;
const FEATURE_PKG_VERSIONS: ReadonlySet<number> = new Set([
  MIN_PKG_VERSION,
  3,
  4,
  ALPHA_PKG_VERSION,
  6,
  7,
  SPARKLE_PKG_VERSION,
  9,
  10,
  11,
  COMPOSABLE_PKG_VERSION,
  13,
]);
const FLAG_HAS_META = 0x01;
/** Header flags bit1: document uses the composable-v1 execution profile. */
export const EXECUTION_FLAG = 0x02;
export const EXECUTION_PROFILE = 'composable-v1';

/** Read the package version from a `.lep` header without decoding layers. */
export function peekPackageVersion(buf: Uint8Array): number {
  if (buf.length < HEADER_SIZE) throw new Error('lep: too small');
  return readUint16LE(byteView(buf), 4);
}

/**
 * Package version `encode` writes for this program (ENGINE.md §8.1): audio
 * 14/15, else the highest feature version, never below the composable-v1
 * container 12. Computed from the program, so callers need not encode first.
 */
export function packageVersionForProgram(program: Pick<Program, 'layers'>): number {
  const enabledLayers = program.layers.filter((layer) => layer.enabled !== false);
  if (enabledLayers.some(usesV15Audio)) return AUDIO_EXT_PKG_VERSION;
  if (enabledLayers.some(usesAudioContract)) return AUDIO_PKG_VERSION;
  const featureVersion = Math.max(0, ...enabledLayers.map(featurePackageVersion));
  const featureOrBase = featureVersion
    ? featureVersion
    : enabledLayers.some(layerRequiresV3)
      ? 3
      : enabledLayers.some((layer) => layer.component === 'sparkle')
        ? SPARKLE_PKG_VERSION
        : MIN_PKG_VERSION;
  // Non-audio composable documents are at least package 12. Audio 14/15 already outrank it.
  return Math.max(featureOrBase, COMPOSABLE_PKG_VERSION);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    // Reason: n is in [0, 256), so the slot always exists.
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of buf) {
    // Reason: the index is masked to [0, 256), so the slot always exists.
    c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export interface DecodeResult {
  pkgVersion: number;
  dslVersion: number;
  seed: number;
  meta: EffectMeta;
  program: Program;
}

export function encode(program: Program): Uint8Array {
  const enabledLayers = program.layers.filter((layer) => layer.enabled !== false);
  const pkgVersion = packageVersionForProgram(program);
  const modern = isAudioPackage(pkgVersion);
  // region_profile only names the authoring region set; regions are already resolved
  // into layer masks, so it is not part of the device document (device_doc.ts).
  const { region_profile: _regionProfile, ...wireMeta } = (program.meta || {}) as EffectMeta & {
    region_profile?: unknown;
  };
  void _regionProfile;
  const metaObject = { ...wireMeta, execution_profile: EXECUTION_PROFILE };
  const meta = new Uint8Array(utf8Bytes(JSON.stringify(metaObject)));
  const metaLenBuf = new Uint8Array(2);
  new DataView(metaLenBuf.buffer).setUint16(0, meta.length, true);
  // ENGINE.md §2.4: disabled layers are kept in the DSL but not encoded.
  // A ported upstream feature picks the highest version any layer needs.
  if (
    modern &&
    enabledLayers.reduce((count, layer) => count + instanceLimit(layer), 0) > audioContract.max_instances
  )
    throw new Error('audio instance budget exceeded');
  const layers = enabledLayers.map((layer) => encodeLayer(layer, pkgVersion));
  const body = concatBytes([metaLenBuf, meta, ...layers]);

  const totalSize = HEADER_SIZE + body.length + 4;
  if (modern && totalSize > 2048) throw new Error('audio package exceeds 2048 bytes');
  const buf = new Uint8Array(totalSize);
  const view = new DataView(buf.buffer);
  buf.set([0x4c, 0x45, 0x50, 0x31], 0);
  view.setUint16(4, pkgVersion, true);
  view.setUint16(6, DSL_VERSION, true);
  view.setUint8(8, LOGIC_ROWS);
  view.setUint8(9, LOGIC_COLS);
  view.setUint8(10, enabledLayers.length);
  view.setUint8(11, FLAG_HAS_META | EXECUTION_FLAG);
  view.setUint32(12, program.seed >>> 0, true);
  view.setUint32(16, HEADER_SIZE, true); // offsetMeta
  view.setUint32(20, HEADER_SIZE + 2 + meta.length, true); // offsetLayers
  view.setUint32(24, 0, true);
  view.setUint32(28, 0, true);
  view.setUint32(32, 0, true);
  view.setUint32(36, totalSize, true);
  buf.set(body, HEADER_SIZE);
  view.setUint32(totalSize - 4, crc32(buf.subarray(0, totalSize - 4)), true);
  return buf;
}

export function decode(buf: Uint8Array): DecodeResult {
  if (buf.length < HEADER_SIZE) throw new Error('lep: too small');
  const view = byteView(buf);
  for (let i = 0; i < MAGIC.length; i++) {
    // Reason: the previous 'ascii' decoding masked the high bit of each byte.
    if ((readByte(view, i) & 0x7f) !== MAGIC.charCodeAt(i)) throw new Error('lep: bad magic');
  }
  const pkgVersion = readUint16LE(view, 4);
  const dslVersion = readUint16LE(view, 6);
  const rows = readByte(view, 8);
  const cols = readByte(view, 9);
  const layerCount = readByte(view, 10);
  const flags = readByte(view, 11);
  const seed = readUint32LE(view, 12);
  const offsetMeta = readUint32LE(view, 16);
  const offsetLayers = readUint32LE(view, 20);
  const totalSize = readUint32LE(view, 36);

  const modern = pkgVersion === AUDIO_PKG_VERSION || pkgVersion === AUDIO_EXT_PKG_VERSION;
  if (!FEATURE_PKG_VERSIONS.has(pkgVersion) && !modern) {
    throw new Error(
      `lep: incompatible package (version ${pkgVersion}, this tool accepts ${[...FEATURE_PKG_VERSIONS].join(', ')} and the audio extension in ${AUDIO_PKG_VERSION}/${AUDIO_EXT_PKG_VERSION}) — re-export with the current lepc/edit code`,
    );
  }
  const payloadCrc = readUint32LE(view, totalSize - 4);
  if (modern && (flags !== 3 || totalSize > 2048 || !layerCount || layerCount > 8))
    throw new Error('invalid audio execution profile flags');
  if (rows !== LOGIC_ROWS || cols !== LOGIC_COLS) throw new Error('lep: logical dims mismatch');
  if (totalSize !== buf.length) throw new Error('lep: total_size mismatch');
  if (offsetMeta < HEADER_SIZE || offsetLayers < HEADER_SIZE || offsetLayers > totalSize - 4) {
    throw new Error('lep: corrupt offsets');
  }
  if (crc32(buf.subarray(0, totalSize - 4)) !== payloadCrc) throw new Error('lep: crc mismatch');

  // Reason: packages without the meta flag carry an empty object, as before.
  let meta = {} as EffectMeta;
  if (flags & FLAG_HAS_META) {
    const metaLen = readUint16LE(view, offsetMeta);
    // Reason: meta is a JSON object written by encode; malformed files are rejected by decode.
    meta = JSON.parse(utf8Decode(buf.subarray(offsetMeta + 2, offsetMeta + 2 + metaLen))) as EffectMeta;
  }

  const layers: NormalizedLayer[] = [];
  let off = offsetLayers;
  try {
    for (let i = 0; i < layerCount; i++) {
      const { layer, offset } = decodeLayer(buf, off, pkgVersion);
      off = offset;
      if (!layer.component) throw new Error('unknown component id');
      layer.cells = maskToCells(layer.mask);
      // Reason: the component check above and cells assignment make this a full layer.
      layers.push(layer as NormalizedLayer);
    }
  } catch (e) {
    // Reason: decode failures are always Error instances here.
    throw new Error(
      `lep: malformed layer data (${(e as Error).message}) — the file may be from an old/incompatible build`,
    );
  }
  if (off > totalSize - 4 || (modern && off !== totalSize - 4))
    throw new Error('lep: invalid layer data length');
  if (
    modern &&
    ((meta.execution_profile !== undefined && meta.execution_profile !== EXECUTION_PROFILE) ||
      !layers.some((layer) => usesAudioContract(layer) || usesV15Audio(layer)) ||
      layers.reduce((n, layer) => n + instanceLimit(layer), 0) > audioContract.max_instances)
  )
    throw new Error('lep: invalid audio execution profile');

  // Silent upgrade: this repo always executes composable-v1, including documents
  // that omitted the field (unlike upstream, which keeps those on the legacy path).
  if (meta.execution_profile !== EXECUTION_PROFILE) {
    meta = { ...meta, execution_profile: EXECUTION_PROFILE };
  }

  return { pkgVersion, dslVersion, seed, meta, program: { seed, layers, meta } };
}
