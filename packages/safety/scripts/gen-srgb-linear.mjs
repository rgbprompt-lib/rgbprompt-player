// Regenerate data/srgb-linear.json.
//
// The table is the cross-language contract: TS, Swift and Rust must all use
// these exact 256 integer values instead of recomputing the float formula at
// runtime. Values map an 8-bit sRGB channel to linear light in 0..65535:
//
//   c = byte / 255
//   linear = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
//   table[byte] = round(linear * 65535)
//
// Run from packages/safety:
//   node scripts/gen-srgb-linear.mjs
import { writeFileSync } from 'node:fs';
import { format } from 'prettier';

const SCALE = 65535;
const table = new Array(256);
for (let byte = 0; byte < 256; byte++) {
  const c = byte / 255;
  const linear = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  table[byte] = Math.round(linear * SCALE);
}

const target = new URL('../data/srgb-linear.json', import.meta.url);
const text = await format(JSON.stringify(table), { parser: 'json', printWidth: 110 });
writeFileSync(target, text);
console.log(`wrote ${target.pathname} (${table.length} entries)`);
