// Compact binary layer encoding shared with the reference interpreter.
// Layout is defined by data/schemas/param-layout.json (single source).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getComponent } from '../../../src/registry.ts';
import { EASE_COMPONENTS } from '../../../src/normalize.ts';

const LUT_SAMPLES = 33;

const LAYOUT_URL = new URL('../../../data/schemas/param-layout.json', import.meta.url);
let layoutCache = null;

export function layout() {
  if (!layoutCache) layoutCache = JSON.parse(readFileSync(fileURLToPath(LAYOUT_URL), 'utf8'));
  return layoutCache;
}

export function enumCode(enumName, value) {
  return layout().enums[enumName]?.[value] ?? 0;
}
export function enumName(enumName, code) {
  const e = layout().enums[enumName] || {};
  for (const [k, v] of Object.entries(e)) if (v === code) return k;
  return null;
}

const PAL_NAME = ['rainbow24', 'seven', 'custom'];

function resolveParam(layer, key) {
  const comp = getComponent(layer.component);
  if (layer.params && layer.params[key] !== undefined) return layer.params[key];
  const t = layer.time || {};
  if (layer.color && key === 'period_ms' && layer.color.period_ms !== undefined) return layer.color.period_ms;
  const direct = [
    'period_ms',
    'phase_ms',
    'easing',
    'min_level',
    'on_ms',
    'off_ms',
    'soft',
    'direction',
    'attack_ms',
    'release_ms',
  ];
  if (direct.includes(key) && t[key] !== undefined) return t[key];
  const spec = comp?.params?.[key];
  if (spec && spec.default !== undefined) return spec.default;
  return 0;
}

function encodeValue(key, value) {
  const vt = layout().valueTypes[key] || 'u16';
  if (vt.startsWith('enum:')) return enumCode(vt.slice(5), value);
  if (vt === 'bool') return value ? 1 : 0;
  return Number(value) || 0;
}

export function compileParams(layer) {
  const keys = layout().componentParams[layer.component] || [];
  return keys.map((k) => encodeValue(k, resolveParam(layer, k)));
}

function colorFields(color) {
  const out = { colorType: 0, a: 0, b: 0, c: 0, paletteId: 0, axis: 0, from: 0, to: 0, customColors: null };
  if (!color) return out;
  const ct = color.type;
  const pal = PAL_NAME.indexOf(color.palette || 'rainbow24');
  switch (ct) {
    case 'solid':
      out.colorType = enumCode('colorType', 'solid');
      out.a = color.rgb?.[0] ?? 0;
      out.b = color.rgb?.[1] ?? 0;
      out.c = color.rgb?.[2] ?? 0;
      break;
    case 'palette_index':
      out.colorType = enumCode('colorType', 'palette_index');
      out.paletteId = pal < 0 ? 0 : pal;
      out.a = color.index ?? 0;
      break;
    case 'ramp':
      out.colorType = enumCode('colorType', 'ramp');
      out.axis = enumCode('axis', color.axis || 'x');
      out.from = color.from ?? 0;
      out.to = color.to ?? 1000;
      if (color.colors && color.colors.length) {
        out.paletteId = 2;
        out.customColors = color.colors;
      } else {
        out.paletteId = pal < 0 ? 0 : pal;
      }
      break;
    case 'hue_cycle':
      out.colorType = enumCode('colorType', 'hue_cycle');
      out.a = color.saturation ?? 255;
      out.b = color.value ?? 255;
      out.from = color.period_ms ?? 3000;
      break;
    case 'random':
      out.colorType = enumCode('colorType', 'random');
      out.paletteId = pal < 0 ? 0 : pal;
      break;
    case 'from_input':
      out.colorType = enumCode('colorType', 'from_input');
      out.paletteId = pal < 0 ? 0 : pal;
      out.a = enumCode('source', color.source || 'key_press');
      break;
    default:
      break;
  }
  return out;
}

function decodeColor(fields, customColors) {
  const t = enumName('colorType', fields.colorType);
  switch (t) {
    case 'solid':
      return { type: 'solid', rgb: [fields.a, fields.b, fields.c] };
    case 'palette_index':
      return { type: 'palette_index', palette: PAL_NAME[fields.paletteId] || 'rainbow24', index: fields.a };
    case 'ramp': {
      const base = {
        type: 'ramp',
        axis: enumName('axis', fields.axis) || 'x',
        from: fields.from,
        to: fields.to,
      };
      if (fields.paletteId === 2 && customColors && customColors.length) base.colors = customColors;
      else base.palette = PAL_NAME[fields.paletteId] || 'rainbow24';
      return base;
    }
    case 'hue_cycle':
      return { type: 'hue_cycle', saturation: fields.a, value: fields.b, period_ms: fields.from };
    case 'random':
      return { type: 'random', palette: PAL_NAME[fields.paletteId] || 'rainbow24' };
    case 'from_input':
      return {
        type: 'from_input',
        palette: PAL_NAME[fields.paletteId] || 'rainbow24',
        source: enumName('source', fields.a) || 'key_press',
      };
    default:
      return null;
  }
}

function decodeParams(component, raw) {
  const keys = layout().componentParams[component] || [];
  const obj = {};
  keys.forEach((k, i) => {
    const vt = layout().valueTypes[k] || 'u16';
    let v = raw[i] ?? 0;
    if (vt.startsWith('enum:')) v = enumName(vt.slice(5), v) ?? v;
    else if (vt === 'bool') v = !!v;
    obj[k] = v;
  });
  return obj;
}

// ---- binary layer record ---------------------------------------------------
const FRAME_SEQUENCE_ID = 32;

export function encodeLayer(layer) {
  const params = compileParams(layer);
  const cf = colorFields(layer.color);
  const name = Buffer.from(layer.id || '', 'utf8');
  const custom = cf.customColors || [];
  const parts = [];

  const head = Buffer.alloc(1 + name.length);
  head.writeUInt8(name.length, 0);
  name.copy(head, 1);
  parts.push(head);
  parts.push(
    Buffer.from([
      layout().componentIds[layer.component] ?? 0,
      enumCode('blend', layer.blend || 'replace'),
      layer.opacity ?? 255,
    ]),
  );
  parts.push(Buffer.from(layer.mask.map((x) => x & 0xff)));
  parts.push(Buffer.from([cf.colorType, cf.a, cf.b, cf.c, cf.paletteId, cf.axis]));
  const ft = Buffer.alloc(4);
  ft.writeUInt16LE(cf.from, 0);
  ft.writeUInt16LE(cf.to, 2);
  parts.push(ft);
  parts.push(Buffer.from([enumCode('timeType', layer.time?.type || 'static')]));
  const tt = Buffer.alloc(4);
  tt.writeUInt16LE(layer.time?.period_ms ?? 0, 0);
  tt.writeUInt16LE(
    layer.component === 'rain' ? (layer.time?.min_level ?? 23) : (layer.time?.phase_ms ?? 0),
    2,
  );
  parts.push(tt);
  parts.push(
    Buffer.from([
      enumCode('easing', layer.time?.easing || 'sine'),
      enumCode('direction', layer.time?.direction || 'forward'),
      enumCode('trigger', layer.trigger?.type || 'always'),
    ]),
  );
  const ta = Buffer.alloc(2);
  ta.writeUInt16LE(layer.trigger?.threshold ?? layer.trigger?.period_ms ?? 0, 0);
  parts.push(ta);
  parts.push(Buffer.from([params.length]));
  const pb = Buffer.alloc(params.length * 2);
  params.forEach((v, i) => pb.writeUInt16LE(v & 0xffff, i * 2));
  parts.push(pb);

  if (EASE_COMPONENTS.has(layer.component)) {
    const lut = layer.lut || new Array(LUT_SAMPLES).fill(0);
    const lb = Buffer.alloc(LUT_SAMPLES * 2);
    for (let i = 0; i < LUT_SAMPLES; i++) lb.writeUInt16LE((lut[i] | 0) & 0xffff, i * 2);
    parts.push(lb);
  }

  if (custom.length) {
    const cb = Buffer.alloc(1 + custom.length * 3);
    cb.writeUInt8(custom.length, 0);
    custom.forEach((c, i) => {
      cb[1 + i * 3] = c[0];
      cb[2 + i * 3] = c[1];
      cb[3 + i * 3] = c[2];
    });
    parts.push(cb);
  }
  if ((layout().componentIds[layer.component] ?? 0) === FRAME_SEQUENCE_ID) {
    const frames = layer.frames || [];
    parts.push(Buffer.from([frames.length & 0xff]));
    for (const f of frames) {
      const pts = f.points || [];
      const fb = Buffer.alloc(4);
      fb.writeUInt16LE(Math.max(1, f.hold || 1) & 0xffff, 0);
      fb.writeUInt16LE(pts.length & 0xffff, 2);
      parts.push(fb);
      for (const p of pts)
        parts.push(
          Buffer.from([p[0] & 0xff, p[1] & 0xff, p[2] & 0xff, p[3] & 0xff, p[4] & 0xff, p[5] & 0xff]),
        );
    }
  }
  return Buffer.concat(parts);
}

export function decodeLayer(buf, offset) {
  let o = offset;
  const nameLen = buf.readUInt8(o);
  o += 1;
  const name = buf.toString('utf8', o, o + nameLen);
  o += nameLen;
  const componentId = buf.readUInt8(o);
  o += 1;
  const blend = enumName('blend', buf.readUInt8(o)) || 'replace';
  o += 1;
  const opacity = buf.readUInt8(o);
  o += 1;
  const mask = [];
  for (let i = 0; i < 22; i++) mask.push(buf.readUInt8(o++));
  const fields = {};
  fields.colorType = buf.readUInt8(o++);
  fields.a = buf.readUInt8(o++);
  fields.b = buf.readUInt8(o++);
  fields.c = buf.readUInt8(o++);
  fields.paletteId = buf.readUInt8(o++);
  fields.axis = buf.readUInt8(o++);
  fields.from = buf.readUInt16LE(o);
  o += 2;
  fields.to = buf.readUInt16LE(o);
  o += 2;
  const timeType = enumName('timeType', buf.readUInt8(o)) || 'static';
  o += 1;
  const period = buf.readUInt16LE(o);
  o += 2;
  const phase = buf.readUInt16LE(o);
  o += 2;
  const easing = enumName('easing', buf.readUInt8(o)) || 'sine';
  o += 1;
  const direction = enumName('direction', buf.readUInt8(o)) || 'forward';
  o += 1;
  const trigger = enumName('trigger', buf.readUInt8(o)) || 'always';
  o += 1;
  const trigArg = buf.readUInt16LE(o);
  o += 2;
  const paramCount = buf.readUInt8(o);
  o += 1;
  const paramsRaw = [];
  for (let i = 0; i < paramCount; i++) {
    paramsRaw.push(buf.readUInt16LE(o));
    o += 2;
  }
  const componentNameEarly =
    Object.keys(layout().componentIds).find((k) => layout().componentIds[k] === componentId) || null;
  let lut = null;
  if (componentNameEarly && EASE_COMPONENTS.has(componentNameEarly)) {
    lut = [];
    for (let i = 0; i < LUT_SAMPLES; i++) {
      lut.push(buf.readUInt16LE(o));
      o += 2;
    }
  }
  let customColors = null;
  if (fields.colorType === enumCode('colorType', 'ramp') && fields.paletteId === 2) {
    const n = buf.readUInt8(o);
    o += 1;
    customColors = [];
    for (let i = 0; i < n; i++) {
      customColors.push([buf.readUInt8(o), buf.readUInt8(o + 1), buf.readUInt8(o + 2)]);
      o += 3;
    }
  }
  if (componentNameEarly === 'rain' && (paramCount !== 8 || !customColors || customColors.length !== 5)) {
    throw new Error('rain requires 8 parameters and 5 RGB colors');
  }
  let frames = null;
  if (componentId === FRAME_SEQUENCE_ID) {
    const fc = buf.readUInt8(o);
    o += 1;
    frames = [];
    for (let i = 0; i < fc; i++) {
      const hold = buf.readUInt16LE(o);
      o += 2;
      const pc = buf.readUInt16LE(o);
      o += 2;
      const points = [];
      for (let j = 0; j < pc; j++) {
        points.push([
          buf.readUInt8(o),
          buf.readUInt8(o + 1),
          buf.readUInt8(o + 2),
          buf.readUInt8(o + 3),
          buf.readUInt8(o + 4),
          buf.readUInt8(o + 5),
        ]);
        o += 6;
      }
      frames.push({ hold, points });
    }
  }
  return {
    layer: {
      id: name,
      component: componentNameEarly,
      blend,
      opacity,
      mask,
      color: decodeColor(fields, customColors),
      time: {
        type: timeType,
        period_ms: period,
        ...(componentNameEarly === 'rain' ? { min_level: phase } : { phase_ms: phase }),
        easing,
        direction,
      },
      trigger: { type: trigger, threshold: trigArg },
      params: decodeParams(componentNameEarly, paramsRaw),
      frames,
      lut,
    },
    offset: o,
  };
}

export { PAL_NAME };
