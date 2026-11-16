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
  values: Record<string, number>;
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

/** Read-only colour mode the editor must not pretend is a named palette or a solid swatch. */
export interface TuningModeColor {
  kind: 'mode';
  mode: 'hue_cycle' | 'from_input' | 'random' | 'palette_index' | 'default';
  palette?: string;
  period_ms?: number;
  min?: number;
  max?: number;
}

export const HUE_CYCLE_PERIOD = { min: 1, max: 65535, default: 3000 } as const;

export interface TuningParamControl {
  kind: 'param';
  param: string;
  value: number | string | boolean;
  min?: number;
  max?: number;
  enum?: string[];
  boolean?: boolean;
}

export type TuningControl =
  | TuningColorControl
  | TuningModeColor
  | TuningSpeedControl
  | TuningAreaControl
  | TuningDirectionControl
  | TuningParamControl;

export interface LayerTuningSchema {
  layerId: string;
  controls: TuningControl[];
}

export interface TuningHueCycleColor {
  kind: 'hue_cycle';
  period_ms: number;
}

export type TuningColor = TuningColorControl | TuningHueCycleColor;

export type TuningPatch =
  | { layerId: string; kind: 'enabled'; value: boolean }
  | { layerId: string; kind: 'color'; color: TuningColor }
  | { layerId: string; kind: 'speed'; multiplier: number }
  | { layerId: string; kind: 'area'; regions: string[] }
  | { layerId: string; kind: 'direction'; value: string }
  | { layerId: string; kind: 'param'; param: string; value: number | string | boolean };

/**
 * Extra editor params (beyond the shared speed / direction controls).
 * Only these registered fields are writable through a param patch.
 */
export const EDITOR_LAYER_PARAMS: Readonly<Record<string, readonly string[]>> = {
  breath: ['min_level'],
  blink: ['soft'],
  sparkle: ['rate'],
  fire: ['cooling', 'sparking', 'spread'],
  rain: ['drops_per_second', 'tail_first'],
  wave: ['wavelength', 'axis'],
  scroll: ['width', 'axis'],
  drift: ['count', 'size', 'motion'],
  mote: ['count', 'size', 'motion'],
  ring: ['max_radius', 'width'],
  key_ring: ['max_radius', 'width', 'origin', 'envelope'],
  key_burst: ['max_radius', 'origin', 'max_bursts'],
  ripple: ['max_waves'],
  ripple_square: ['max_waves'],
  reactive: ['duration_ms'],
  rainbow_wave: ['width_pct', 'axis', 'angle_deg'],
  spiral: ['arms', 'twist', 'beam'],
  spectrum: ['gain', 'dense'],
  spectrum_mirror: ['gain', 'dense', 'full_range'],
  spectrum_sum: ['gain', 'attack_ms', 'release_ms'],
};

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

function colorControl(layer: LayerDsl): TuningColorControl | TuningModeColor | null {
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
    if (
      color.type === 'hue_cycle' ||
      color.type === 'from_input' ||
      color.type === 'random' ||
      color.type === 'palette_index'
    ) {
      const palette = (color as { palette?: unknown }).palette;
      const period = color.type === 'hue_cycle' ? (color as { period_ms?: unknown }).period_ms : undefined;
      return {
        kind: 'mode',
        mode: color.type,
        ...(typeof palette === 'string' ? { palette } : {}),
        ...(color.type === 'hue_cycle'
          ? {
              period_ms:
                typeof period === 'number' && Number.isFinite(period) ? period : HUE_CYCLE_PERIOD.default,
              min: HUE_CYCLE_PERIOD.min,
              max: HUE_CYCLE_PERIOD.max,
            }
          : {}),
      };
    }
  }
  const product = getPrimitiveProduct(layer.component);
  if (product?.colorSlots.includes('palette')) {
    const palette = layer.params?.palette;
    return { kind: 'palette', palette: typeof palette === 'string' ? palette : 'rainbow24' };
  }
  // Fire with no color uses the built-in flame ramp; a solid swatch would fail validation.
  if (layer.component === 'fire') {
    return { kind: 'mode', mode: 'default' };
  }
  if (!color) {
    return { kind: 'single', rgb: [255, 255, 255] };
  }
  return null;
}

function speedControl(layer: LayerDsl): TuningSpeedControl | null {
  const product = getPrimitiveProduct(layer.component);
  if (!product || product.speed.params.length === 0) return null;
  const component = getComponent(layer.component);
  const values: Record<string, number> = {};
  for (const param of product.speed.params) {
    values[param] = effectiveNumber(layer, param, component?.params[param]);
  }
  return {
    kind: 'speed',
    multiplier: 1,
    min: SPEED_MIN_MULTIPLIER,
    max: SPEED_MAX_MULTIPLIER,
    params: [...product.speed.params],
    inverse: product.speed.inverse,
    values,
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

function isBooleanParam(spec: RegistryParamSpec | undefined, raw: unknown): boolean {
  return typeof spec?.default === 'boolean' || typeof raw === 'boolean';
}

function currentAxis(layer: LayerDsl): string | undefined {
  const raw = layer.params?.['axis'];
  if (typeof raw === 'string') return raw;
  const fromColor = axisOf(layer.color);
  if (fromColor) return fromColor;
  const fallback = getComponent(layer.component)?.params['axis']?.default;
  return typeof fallback === 'string' ? fallback : undefined;
}

function paramControls(layer: LayerDsl): TuningParamControl[] {
  const names = EDITOR_LAYER_PARAMS[layer.component];
  if (!names || names.length === 0) return [];
  const component = getComponent(layer.component);
  const controls: TuningParamControl[] = [];
  for (const param of names) {
    const spec = component?.params[param];
    if (!spec) continue;
    // Mode-aware: hide controls that are illegal or meaningless in the current mode.
    if (param === 'angle_deg' && currentAxis(layer) !== 'angle') continue;
    if (param === 'duration_ms' && layer.params?.['color_mode'] !== 'lifecycle') continue;
    const options = Array.isArray(spec.enum) ? [...spec.enum] : undefined;
    const raw = layer.params?.[param];
    let value: number | string | boolean;
    if (options && options.length > 0) {
      value = typeof raw === 'string' && options.includes(raw) ? raw : String(spec.default ?? options[0]);
    } else if (isBooleanParam(spec, raw)) {
      value = typeof raw === 'boolean' ? raw : Boolean(spec?.default);
    } else {
      value = effectiveNumber(layer, param, spec);
    }
    controls.push({
      kind: 'param',
      param,
      value,
      ...(typeof spec.min === 'number' ? { min: spec.min } : {}),
      ...(typeof spec.max === 'number' ? { max: spec.max } : {}),
      ...(options ? { enum: options } : {}),
      ...(typeof value === 'boolean' ? { boolean: true } : {}),
    });
  }
  return controls;
}

export function tuningSchema(effect: EffectDsl): LayerTuningSchema[] {
  return (effect.layer ?? []).map((layer) => {
    const controls: TuningControl[] = [];
    const color = colorControl(layer);
    if (color) controls.push(color);
    const speed = speedControl(layer);
    if (speed) controls.push(speed);
    controls.push(areaControl(layer));
    const direction = directionControl(layer);
    if (direction) controls.push(direction);
    controls.push(...paramControls(layer));
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

function colorTypeAllowed(component: string, type: ColorSpec['type'] | 'palette'): boolean {
  const capability = getCapabilities(component);
  if (!capability) return false;
  if (type !== 'palette' && capability.colorTypes.includes(type)) return true;
  // palette-only layers can omit color and keep a named palette in params.
  if (type === 'palette' && (capability.paletteValues?.length ?? 0) > 0) return true;
  return false;
}

function applyColor(layer: LayerDsl, color: TuningColor): ValidationIssue[] {
  if (color.kind === 'hue_cycle') {
    const existing = layer.color as ColorSpec | null | undefined;
    if (!existing || existing.type !== 'hue_cycle') {
      return [
        issue('layer.color', 'COLOR_INVALID', 'hue cycle period can only be edited on a hue_cycle colour'),
      ];
    }
    if (typeof color.period_ms !== 'number' || !Number.isFinite(color.period_ms)) {
      return [issue('layer.color.period_ms', 'PARAM_TYPE', 'must be a finite number')];
    }
    let period = Math.round(color.period_ms);
    if (period < HUE_CYCLE_PERIOD.min) period = HUE_CYCLE_PERIOD.min;
    if (period > HUE_CYCLE_PERIOD.max) period = HUE_CYCLE_PERIOD.max;
    layer.color = { ...existing, period_ms: period };
    return [];
  }
  if (color.kind === 'single') {
    if (!colorTypeAllowed(layer.component, 'solid')) {
      return [issue('layer.color', 'COLOR_UNSUPPORTED', `${layer.component} does not accept a solid swatch`)];
    }
    layer.color = { type: 'solid', rgb: cloneRgb(color.rgb) };
    return [];
  }
  if (color.kind === 'stops') {
    if (!colorTypeAllowed(layer.component, 'ramp')) {
      return [issue('layer.color', 'COLOR_UNSUPPORTED', `${layer.component} does not accept a colour ramp`)];
    }
    if (!Array.isArray(color.colors) || color.colors.length < 2 || color.colors.length > 32) {
      return [issue('layer.color.colors', 'COLOR_INVALID', 'must contain 2..32 RGB stops')];
    }
    const previous = isRecord(layer.color) ? (layer.color as Record<string, unknown>) : null;
    const next: Record<string, unknown> = {
      type: 'ramp',
      colors: color.colors.map((stop) => cloneRgb(stop)),
    };
    const axis = axisOf(previous) ?? (layer.component === 'gradient' ? 'x' : undefined);
    if (axis !== undefined) next['axis'] = axis;
    if (previous) {
      for (const key of ['alphas', 'stops', 'palette', 'from', 'to'] as const) {
        if (previous[key] !== undefined) next[key] = cloneValue(previous[key]);
      }
    }
    layer.color = next as ColorSpec;
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
  const existing = layer.color as ColorSpec | null | undefined;
  if (existing && existing.type === 'ramp' && Array.isArray(existing.colors) && existing.colors.length > 0) {
    return [
      issue(
        'layer.color',
        'COLOR_INVALID',
        'a custom ramp cannot be replaced by a named palette from this control',
      ),
    ];
  }
  if (existing && (existing.type === 'hue_cycle' || existing.type === 'from_input')) {
    return [
      issue(
        'layer.color',
        'COLOR_INVALID',
        `${existing.type} colour cannot be switched to a named palette from this control`,
      ),
    ];
  }
  if (existing && (existing.type === 'random' || existing.type === 'palette_index')) {
    layer.color = { ...existing, palette: color.palette } as ColorSpec;
    paramsFor(layer).palette = color.palette;
    return [];
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

function applyParam(layer: LayerDsl, param: string, value: number | string | boolean): ValidationIssue[] {
  const allowed = EDITOR_LAYER_PARAMS[layer.component];
  if (!allowed || !allowed.includes(param)) {
    return [
      issue(
        `layer.params.${param}`,
        'PARAM_UNKNOWN',
        `${layer.component} does not expose ${param} for editing`,
      ),
    ];
  }
  const product = getPrimitiveProduct(layer.component);
  if (product?.speed.params.includes(param) || product?.direction === param) {
    return [
      issue(
        `layer.params.${param}`,
        'PARAM_CONFLICT',
        `${param} is edited through the speed or direction control`,
      ),
    ];
  }
  const spec = getComponent(layer.component)?.params[param];
  if (!spec) {
    return [issue(`layer.params.${param}`, 'PARAM_UNKNOWN', `${param} is not in the registry`)];
  }
  const options = Array.isArray(spec.enum) ? spec.enum : null;
  if (options && options.length > 0) {
    if (typeof value !== 'string' || !options.includes(value)) {
      return [issue(`layer.params.${param}`, 'PARAM_TYPE', `must be one of ${options.join(', ')}`)];
    }
    paramsFor(layer)[param] = value;
    return [];
  }
  const raw = layer.params?.[param];
  if (isBooleanParam(spec, raw)) {
    if (typeof value !== 'boolean') {
      return [issue(`layer.params.${param}`, 'PARAM_TYPE', 'must be a boolean')];
    }
    paramsFor(layer)[param] = value;
    return [];
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return [issue(`layer.params.${param}`, 'PARAM_TYPE', 'must be a finite number')];
  }
  let next = Math.round(value);
  if (typeof spec.min === 'number' && next < spec.min) next = spec.min;
  if (typeof spec.max === 'number' && next > spec.max) next = spec.max;
  paramsFor(layer)[param] = next;
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
    case 'param':
      issues = applyParam(layer, patch.param, patch.value);
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
