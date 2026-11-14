// Human-readable layer descriptions (ENGINE.md §9.1).
//
// The engine never resolves user-visible strings: it returns i18n keys and
// params, and the UI translates them (CLAUDE.md rule 7). Primitive names are
// the exception because they are data in primitives.product.json.
import { getPrimitiveProduct } from './product.ts';
import type { ColorSpec, EffectDsl, LayerDsl, Rgb } from './types.ts';

export const COLOR_NAME_KEYS = Object.freeze([
  'deepBlue',
  'iceBlue',
  'teal',
  'cyan',
  'green',
  'lime',
  'yellow',
  'amber',
  'warmOrange',
  'red',
  'pink',
  'magenta',
  'purple',
  'lavender',
  'white',
  'warmWhite',
  'grey',
  'rainbow',
  'multi',
] as const);

export type ColorNameKey = (typeof COLOR_NAME_KEYS)[number];

export interface ColorAnchor {
  key: ColorNameKey;
  rgb: Rgb;
}

// `rainbow` and `multi` are semantic names for palettes/ramps and have no
// single RGB anchor; nearest-colour lookup only uses the anchors below.
export const COLOR_ANCHORS: readonly ColorAnchor[] = Object.freeze([
  { key: 'deepBlue', rgb: [0, 40, 160] },
  { key: 'iceBlue', rgb: [150, 210, 255] },
  { key: 'teal', rgb: [0, 128, 128] },
  { key: 'cyan', rgb: [0, 220, 220] },
  { key: 'green', rgb: [0, 180, 60] },
  { key: 'lime', rgb: [140, 230, 0] },
  { key: 'yellow', rgb: [255, 230, 0] },
  { key: 'amber', rgb: [255, 170, 0] },
  { key: 'warmOrange', rgb: [255, 110, 30] },
  { key: 'red', rgb: [220, 20, 30] },
  { key: 'pink', rgb: [255, 120, 180] },
  { key: 'magenta', rgb: [230, 0, 200] },
  { key: 'purple', rgb: [120, 40, 200] },
  { key: 'lavender', rgb: [180, 150, 255] },
  { key: 'white', rgb: [255, 255, 255] },
  { key: 'warmWhite', rgb: [255, 230, 200] },
  { key: 'grey', rgb: [128, 128, 128] },
]);

export type DescribeLocale = 'en' | 'zh-CN';

export interface LabelParams {
  colorKey: string;
  primitiveName: string;
}

export interface LayerDescription {
  id: string;
  labelText?: string;
  labelKey: 'layer.label';
  labelParams: LabelParams;
  primitive: string;
  primitiveName: string;
  icon: string;
  enabled: boolean;
  requiresInput: 'key' | 'audio' | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function resolveDescribeLocale(locale: string | undefined): DescribeLocale {
  return locale !== undefined && locale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

export function nearestColorName(rgb: Rgb): ColorNameKey {
  let best = COLOR_ANCHORS[0] as ColorAnchor;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const anchor of COLOR_ANCHORS) {
    const dr = rgb[0] - anchor.rgb[0];
    const dg = rgb[1] - anchor.rgb[1];
    const db = rgb[2] - anchor.rgb[2];
    const distance = dr * dr + dg * dg + db * db;
    if (distance < bestDistance) {
      best = anchor;
      bestDistance = distance;
    }
  }
  return best.key;
}

export function colorNameKey(name: ColorNameKey): `colorName.${ColorNameKey}` {
  return `colorName.${name}`;
}

function colorNameForLayer(layer: LayerDsl): ColorNameKey {
  const color = layer.color as ColorSpec | null | undefined;
  if (color) {
    if (color.type === 'solid' && Array.isArray(color.rgb)) return nearestColorName(color.rgb);
    if (color.type === 'ramp') {
      const colors = color.colors;
      if (Array.isArray(colors) && colors.length > 0) {
        return colors.length > 1 ? 'multi' : nearestColorName(colors[0] as Rgb);
      }
      return 'rainbow';
    }
    return 'rainbow';
  }
  const product = getPrimitiveProduct(layer.component);
  return product?.colorSlots.includes('palette') ? 'rainbow' : 'white';
}

function explicitLabel(layer: LayerDsl, locale: DescribeLocale): string | undefined {
  const label = layer.label;
  if (!isRecord(label)) return undefined;
  const value = label[locale];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function describe(effect: EffectDsl, locale: string = 'en'): LayerDescription[] {
  const resolved = resolveDescribeLocale(locale);
  return (effect.layer ?? []).map((layer) => {
    const product = getPrimitiveProduct(layer.component);
    const primitiveName = product?.displayName[resolved] ?? layer.component;
    const description: LayerDescription = {
      id: layer.id,
      labelKey: 'layer.label',
      labelParams: {
        colorKey: colorNameKey(colorNameForLayer(layer)),
        primitiveName,
      },
      primitive: layer.component,
      primitiveName,
      icon: product?.icon ?? 'static',
      enabled: layer.enabled !== false,
      requiresInput: product?.requiresInput ?? null,
    };
    const labelText = explicitLabel(layer, resolved);
    if (labelText !== undefined) description.labelText = labelText;
    return description;
  });
}
