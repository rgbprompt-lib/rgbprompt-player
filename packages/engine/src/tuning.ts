// Tuning controls and safe edits (ENGINE.md §9.2, §9.3).
import { REGION_LABELS } from '@rgbprompt/layouts';
import type { RegionId } from '@rgbprompt/layouts';
import { getCapabilities } from './capabilities.ts';
import { primitiveContract } from './execution.ts';
import { getPrimitiveProduct } from './product.ts';
import { getComponent } from './registry.ts';
import { validate } from './validate.ts';
import type {
  ColorSpec,
  EffectDsl,
  LayerDsl,
  LayerParams,
  RegistryParamSpec,
  Rgb,
  ValidationCode,
  ValidationIssue,
} from './types.ts';

export interface TuningSingleColor {
  kind: 'single';
  rgb: Rgb;
}

export interface TuningStopsColor {
  kind: 'stops';
  colors: Rgb[];
}

export interface TuningPaletteColor {
  kind: 'palette';
  palette: string;
}

export type TuningColorControl = TuningSingleColor | TuningStopsColor | TuningPaletteColor;

export interface TuningSpeedControl {
  kind: 'speed';
  multiplier: number;
  min: number;
  max: number;
  params: string[];
  inverse: boolean;
}

export interface TuningAreaControl {
  kind: 'area';
  regions: RegionId[];
  custom: boolean;
}

export interface TuningDirectionControl {
  kind: 'direction';
  param: string;
  value: string;
  options: string[];
}

export type TuningControl =
  TuningColorControl | TuningSpeedControl | TuningAreaControl | TuningDirectionControl;

export interface LayerTuningSchema {
  layerId: string;
  controls: TuningControl[];
}

export type TuningColor = TuningColorControl;

export type TuningPatch =
  | { layerId: string; kind: 'enabled'; value: boolean }
  | { layerId: string; kind: 'color'; color: TuningColor }
  | { layerId: string; kind: 'speed'; multiplier: number }
  | { layerId: string; kind: 'area'; regions: string[] }
  | { layerId: string; kind: 'direction'; value: string };

export interface ApplyTuningOk {
  ok: true;
  effect: EffectDsl;
}

export interface ApplyTuningError {
  ok: false;
  issues: ValidationIssue[];
}

export type ApplyTuningResult = ApplyTuningOk | ApplyTuningError;

export const SPEED_MIN_MULTIPLIER = 0.5;
export const SPEED_MAX_MULTIPLIER = 2;

const REGION_IDS = new Set<string>(REGION_LABELS.map((region) => region.id));

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneRgb(rgb: Rgb): Rgb {
  return [rgb[0], rgb[1], rgb[2]];
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) out[key] = cloneValue((value as Record<string, unknown>)[key]);
    return out as T;
  }
  return value;
}

function issue(path: string, code: ValidationCode, message: string): ValidationIssue {
  return { path, code, message };
}

function axisOf(color: unknown): string | undefined {
  if (!isRecord(color)) return undefined;
  const axis = color['axis'];
  return typeof axis === 'string' ? axis : undefined;
}

function setAxis(color: unknown, value: string): void {
  if (isRecord(color)) color['axis'] = value;
}

function colorControl(layer: LayerDsl): TuningColorControl {
  const color = layer.color as ColorSpec | null | undefined;
  if (color) {
    if (color.type === 'solid') {
      return { kind: 'single', rgb: cloneRgb(color.rgb ?? [255, 255, 255]) };
    }
    if (color.type === 'ramp') {
      if (Array.isArray(color.colors) && color.colors.length > 0) {
        return { kind: 'stops', colors: color.colors.map((stop) => cloneRgb(stop)) };
      }
      return { kind: 'palette', palette: color.palette ?? 'rainbow24' };
    }
    const palette = (color as { palette?: unknown }).palette;
    return { kind: 'palette', palette: typeof palette === 'string' ? palette : 'rainbow24' };
  }
  const product = getPrimitiveProduct(layer.component);
  if (product?.colorSlots.includes('palette')) {
    const palette = layer.params?.palette;
    return { kind: 'palette', palette: typeof palette === 'string' ? palette : 'rainbow24' };
  }
  return { kind: 'single', rgb: [255, 255, 255] };
}

function speedControl(layer: LayerDsl): TuningSpeedControl | null {
  const product = getPrimitiveProduct(layer.component);
  if (!product || product.speed.params.length === 0) return null;
  return {
    kind: 'speed',
    multiplier: 1,
    min: SPEED_MIN_MULTIPLIER,
    max: SPEED_MAX_MULTIPLIER,
    params: [...product.speed.params],
    inverse: product.speed.inverse,
  };
}

function areaControl(layer: LayerDsl): TuningAreaControl {
  const surface = layer.surface;
  if (surface?.type === 'regions') {
    const regions = (surface.regions ?? []).filter((id): id is RegionId => REGION_IDS.has(id));
    return { kind: 'area', regions, custom: false };
  }
  if (surface?.type === 'all') return { kind: 'area', regions: ['all'], custom: false };
  return { kind: 'area', regions: [], custom: true };
}

function directionControl(layer: LayerDsl): TuningDirectionControl | null {
  const product = getPrimitiveProduct(layer.component);
  const param = product?.direction;
  if (!param) return null;
  const spec = getComponent(layer.component)?.params[param];
  const options = Array.isArray(spec?.enum) ? [...spec.enum] : [];
  if (options.length === 0) return null;

  let value: unknown = layer.params?.[param];
  if (typeof value !== 'string' && param === 'axis') {
    value = axisOf(layer.color);
  }
  if (typeof value !== 'string') value = layer.time?.direction;
  if (typeof value !== 'string') value = spec?.default;
  if (typeof value !== 'string') value = options[0];

  return {
    kind: 'direction',
    param,
    value: value as string,
    options,
  };
}

export function tuningSchema(effect: EffectDsl): LayerTuningSchema[] {
  return (effect.layer ?? []).map((layer) => {
    const controls: TuningControl[] = [colorControl(layer)];
    const speed = speedControl(layer);
    if (speed) controls.push(speed);
    controls.push(areaControl(layer));
    const direction = directionControl(layer);
    if (direction) controls.push(direction);
    return { layerId: layer.id, controls };
  });
}

function paramsFor(layer: LayerDsl): LayerParams {
  const existing = layer.params;
  const params = isRecord(existing) ? (existing as LayerParams) : {};
  if (params !== existing) (layer as Record<string, unknown>).params = params;
  return params;
}

function effectiveNumber(layer: LayerDsl, param: string, spec: RegistryParamSpec | undefined): number {
  const params = layer.params;
  const direct = params?.[param];
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
  const time = layer.time as Record<string, unknown> | undefined;
  const timed = time?.[param];
  if (typeof timed === 'number' && Number.isFinite(timed)) return timed;
  if (typeof spec?.default === 'number') return spec.default;
  return 0;
}

function applyColor(layer: LayerDsl, color: TuningColor): ValidationIssue[] {
  if (color.kind === 'single') {
    layer.color = { type: 'solid', rgb: cloneRgb(color.rgb) };
    return [];
  }
  if (color.kind === 'stops') {
    if (!Array.isArray(color.colors) || color.colors.length < 2 || color.colors.length > 32) {
      return [issue('layer.color.colors', 'COLOR_INVALID', 'must contain 2..32 RGB stops')];
    }
    const axis = axisOf(layer.color) ?? 'x';
    layer.color = {
      type: 'ramp',
      axis,
      colors: color.colors.map((stop) => cloneRgb(stop)),
    };
    return [];
  }
  const capability = getCapabilities(layer.component);
  if (!capability?.paletteValues) {
    return [issue('layer.params.palette', 'PARAM_UNKNOWN', `${layer.component} has no palette`)];
  }
  if (!capability.paletteValues.includes(color.palette)) {
    return [
      issue('layer.params.palette', 'PARAM_TYPE', `must be one of ${capability.paletteValues.join(', ')}`),
    ];
  }
  paramsFor(layer).palette = color.palette;
  delete (layer as Record<string, unknown>).color;
  return [];
}

function applySpeed(layer: LayerDsl, multiplier: number): ValidationIssue[] {
  if (!Number.isFinite(multiplier) || multiplier <= 0) {
    return [issue('layer.params', 'PARAM_RANGE', 'speed multiplier must be a positive number')];
  }
  const product = getPrimitiveProduct(layer.component);
  if (!product || product.speed.params.length === 0) {
    return [issue('layer.params', 'PARAM_UNKNOWN', `${layer.component} has no speed parameter`)];
  }
  const component = getComponent(layer.component);
  const params = paramsFor(layer);
  const next: Array<{ param: string; value: number }> = [];
  for (const param of product.speed.params) {
    const spec = component?.params[param];
    if (!spec) {
      return [issue(`layer.params.${param}`, 'PARAM_UNKNOWN', `${param} is not in the registry`)];
    }
    const current = effectiveNumber(layer, param, spec);
    const scaled = product.speed.inverse ? current / multiplier : current * multiplier;
    let value = Math.round(scaled);
    if (typeof spec.min === 'number' && value < spec.min) value = spec.min;
    if (typeof spec.max === 'number' && value > spec.max) value = spec.max;
    next.push({ param, value });
  }
  for (const { param, value } of next) params[param] = value;
  return [];
}

function applyArea(layer: LayerDsl, regions: string[]): ValidationIssue[] {
  if (!Array.isArray(regions) || regions.length === 0) {
    return [issue('layer.surface.regions', 'SURFACE_INVALID', 'must select at least one region')];
  }
  layer.surface = { type: 'regions', regions: regions.map(String) };
  return [];
}

function applyDirection(layer: LayerDsl, value: string): ValidationIssue[] {
  const product = getPrimitiveProduct(layer.component);
  const param = product?.direction;
  if (!param) {
    return [issue('layer.params', 'PARAM_UNKNOWN', `${layer.component} has no direction`)];
  }
  const spec = getComponent(layer.component)?.params[param];
  const options = Array.isArray(spec?.enum) ? spec.enum : [];
  if (!options.includes(value)) {
    return [issue(`layer.params.${param}`, 'PARAM_TYPE', `must be one of ${options.join(', ')}`)];
  }
  // The device contract decides where the value lives: gradient keeps its axis on
  // the colour ramp only, other primitives carry it as a param.
  if (param in (primitiveContract(layer.component)?.params ?? {})) paramsFor(layer)[param] = value;
  if (param === 'axis') setAxis(layer.color, value);
  return [];
}

export function applyTuning(effect: EffectDsl, patch: TuningPatch): ApplyTuningResult {
  const next = cloneValue(effect);
  const layer = (next.layer ?? []).find((candidate) => candidate.id === patch.layerId);
  if (!layer) {
    return {
      ok: false,
      issues: [issue('layer', 'LAYER_INVALID', `unknown layer id "${patch.layerId}"`)],
    };
  }

  let issues: ValidationIssue[];
  switch (patch.kind) {
    case 'enabled':
      if (typeof patch.value !== 'boolean') {
        issues = [issue('layer.enabled', 'LAYER_INVALID', 'must be a boolean')];
        break;
      }
      (layer as Record<string, unknown>).enabled = patch.value;
      issues = [];
      break;
    case 'color':
      if (!isRecord(patch.color) || typeof patch.color.kind !== 'string') {
        issues = [issue('layer.color', 'COLOR_INVALID', 'missing color patch')];
        break;
      }
      issues = applyColor(layer, patch.color);
      break;
    case 'speed':
      issues = applySpeed(layer, patch.multiplier);
      break;
    case 'area':
      issues = applyArea(layer, patch.regions);
      break;
    case 'direction':
      issues = applyDirection(layer, patch.value);
      break;
    default:
      issues = [issue('layer', 'LAYER_INVALID', 'unknown tuning patch')];
      break;
  }
  if (issues.length > 0) return { ok: false, issues };

  const report = validate(next, { mode: 'strict' });
  if (!report.ok) return { ok: false, issues: report.errors };
  return { ok: true, effect: next };
}
