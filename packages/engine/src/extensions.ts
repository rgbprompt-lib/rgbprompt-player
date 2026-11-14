// Shape rules for the primitive parameters ported from the upstream toolchain
// (ENGINE.md §5.3): rainbow_wave geometry, reactive lifecycle colours, and
// fire. Ranges come from the registry and trigger or time types from the
// capability table, both checked by `validate`; this file covers enum values
// and the combinations those cannot express.
import { getComponent } from './registry.ts';
import type { ValidationCode } from './types.ts';

export interface ExtensionIssue {
  path: string;
  code: ValidationCode;
  message: string;
}

interface LayerLike {
  component?: unknown;
  params?: unknown;
  color?: unknown;
  trigger?: unknown;
  time?: unknown;
  blend?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const isRgb = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.length === 3 &&
  value.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 255);

/** True when `color` is a ramp that carries 2..32 RGB stops of its own. */
function isCustomRamp(color: unknown): boolean {
  if (!isRecord(color) || color.type !== 'ramp' || !Array.isArray(color.colors)) return false;
  return color.colors.length >= 2 && color.colors.length <= 32 && color.colors.every(isRgb);
}

const EXTENDED_COMPONENTS = new Set(['rainbow_wave', 'reactive', 'spiral', 'fire']);

/** Largest parameter count a layer of this primitive may carry. */
export const maxParamsFor = (component: string, fallback: number): number =>
  component === 'spiral' ? Math.max(fallback, 10) : fallback;

export function extensionIssues(layer: LayerLike, at: string): ExtensionIssue[] {
  const component = typeof layer.component === 'string' ? layer.component : '';
  if (!EXTENDED_COMPONENTS.has(component)) return [];
  const issues: ExtensionIssue[] = [];
  const params = isRecord(layer.params) ? layer.params : {};
  const specs = getComponent(component)?.params ?? {};
  // Enum values are checked for every primitive in validate.ts.
  const triggerType = isRecord(layer.trigger) ? layer.trigger.type : undefined;
  const timeType = isRecord(layer.time) ? layer.time.type : undefined;

  if (component === 'rainbow_wave') {
    const axis = params.axis ?? 'x';
    if (axis !== 'angle' && (params.angle_deg ?? 0) !== 0)
      issues.push({
        path: `${at}.params.angle_deg`,
        code: 'PARAM_CONFLICT',
        message: 'needs axis "angle"',
      });
    if (
      axis === 'uniform' &&
      ((params.width_pct ?? 100) !== 100 || (params.spatial_direction ?? 'forward') !== 'forward')
    )
      issues.push({
        path: `${at}.params.axis`,
        code: 'PARAM_CONFLICT',
        message: 'uniform has no width_pct or spatial_direction: the whole surface shares one colour',
      });
  }

  if (component === 'rainbow_wave' || component === 'spiral') {
    // Upstream lepc (validate.js / spiral_color.js): a ramp on these primitives is
    // the custom palette, so the two always come together, and the ramp carries
    // only colors plus the optional alphas / stops tables.
    const custom = params.palette === 'custom';
    const ramp = isRecord(layer.color) && layer.color.type === 'ramp';
    if (custom && !isCustomRamp(layer.color))
      issues.push({
        path: `${at}.color`,
        code: 'COLOR_INVALID',
        message: `palette "custom" needs layer.color as a ramp with 2..32 RGB colors`,
      });
    if (
      ramp &&
      (!custom ||
        Object.keys(layer.color as Record<string, unknown>).some(
          (key) => !['type', 'colors', 'alphas', 'stops'].includes(key),
        ))
    )
      issues.push({
        path: `${at}.color`,
        code: 'COLOR_UNSUPPORTED',
        message: `a ${component} ramp needs params.palette "custom" and only colors/alphas/stops`,
      });
  }

  if (component === 'rainbow_wave' && isRecord(layer.color) && layer.color.stops !== undefined) {
    // Upstream wave_geometry.js: a stops wave is static time (phase_ms only) and always.
    if (
      isRecord(layer.time) &&
      (layer.time.type !== 'static' ||
        Object.keys(layer.time).some((key) => !['type', 'phase_ms'].includes(key)))
    )
      issues.push({
        path: `${at}.time`,
        code: 'TIME_INVALID',
        message: 'a stops wave supports only static time and phase_ms',
      });
    if (
      isRecord(layer.trigger) &&
      (layer.trigger.type !== 'always' || Object.keys(layer.trigger).some((key) => key !== 'type'))
    )
      issues.push({
        path: `${at}.trigger`,
        code: 'TRIGGER_INVALID',
        message: 'a stops wave supports the always trigger only',
      });
  }

  if (component === 'reactive') {
    const lifecycle = params.color_mode === 'lifecycle';
    if (!lifecycle) {
      if ((params.duration_ms ?? 1000) !== 1000)
        issues.push({
          path: `${at}.params.duration_ms`,
          code: 'PARAM_CONFLICT',
          message: 'needs color_mode "lifecycle"',
        });
      if (isRecord(layer.color) && layer.color.type === 'ramp')
        issues.push({
          path: `${at}.color.type`,
          code: 'COLOR_UNSUPPORTED',
          message: 'reactive takes a ramp only with color_mode "lifecycle"',
        });
    } else {
      if (!isCustomRamp(layer.color))
        issues.push({
          path: `${at}.color`,
          code: 'COLOR_INVALID',
          message: 'reactive lifecycle needs a ramp with 2..32 RGB colors',
        });
      if (params.palette !== undefined && params.palette !== 'custom')
        issues.push({
          path: `${at}.params.palette`,
          code: 'PARAM_CONFLICT',
          message: 'reactive lifecycle reads layer.color; omit palette or set it to custom',
        });
      if ((params.speed ?? 2) !== 2)
        issues.push({
          path: `${at}.params.speed`,
          code: 'PARAM_CONFLICT',
          message: 'reactive lifecycle is timed by duration_ms, not speed',
        });
      if (triggerType !== 'key_press')
        issues.push({
          path: `${at}.trigger.type`,
          code: 'TRIGGER_INVALID',
          message: 'reactive lifecycle needs trigger key_press',
        });
      if (timeType !== undefined && timeType !== 'static')
        issues.push({
          path: `${at}.time.type`,
          code: 'TIME_INVALID',
          message: 'reactive lifecycle is linear; use duration_ms',
        });
      if ((layer.blend ?? 'replace') !== 'replace')
        issues.push({
          path: `${at}.blend`,
          code: 'LAYER_INVALID',
          message: 'reactive lifecycle needs blend replace',
        });
    }
  }

  if (component === 'fire') {
    for (const [key, value] of Object.entries(params)) {
      const spec = specs[key];
      if (spec && !spec.enum && !(typeof value === 'number' && Number.isInteger(value)))
        issues.push({ path: `${at}.params.${key}`, code: 'PARAM_TYPE', message: 'must be an integer' });
    }
    if (layer.color !== undefined && layer.color !== null && !isCustomRamp(layer.color))
      issues.push({
        path: `${at}.color`,
        code: 'COLOR_INVALID',
        message: 'fire takes no color or a ramp with 2..32 RGB colors, coldest first',
      });
    if (timeType !== undefined && timeType !== 'static')
      issues.push({
        path: `${at}.time.type`,
        code: 'TIME_INVALID',
        message: 'fire is timed by params.step_ms',
      });
  }
  return issues;
}
