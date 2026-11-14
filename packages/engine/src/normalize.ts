// DSL -> normalized runtime program (surfaces expanded to ordered cells/mask).
import { hasPlayback } from './playback.ts';
import { expandSurface, boardForEffect } from './surfaces.ts';
import { LOGIC_ROWS, LOGIC_COLS } from './constants.ts';
import { bakeEasing } from './timing.ts';
import { primitiveContract } from './execution.ts';
import { getComponent } from './registry.ts';
import type {
  Board,
  ColorSpec,
  Rgb,
  BoardCell,
  EffectDsl,
  EasingSpec,
  LayerDsl,
  LayerParams,
  NormalizedLayer,
  Program,
  TriggerDsl,
} from './types.ts';

// components whose motion shape / envelope is driven by an easing curve
export const EASE_COMPONENTS = new Set(['breath', 'blink', 'reactive', 'aurora']);
const DEFAULT_EASE: Record<string, string> = {
  breath: 'sine',
  blink: 'sine',
  reactive: 'ease-out',
  aurora: 'ease-out',
};

export function resolveEasing(layer: LayerDsl): EasingSpec {
  const spec = (layer.time && layer.time.easing) ?? (layer.params && layer.params.easing);
  if (spec !== undefined) return spec;
  return DEFAULT_EASE[layer.component] || 'linear';
}

export function cellsToMask(cells: BoardCell[]): number[] {
  const mask = new Array<number>(22).fill(0);
  for (const [r, c] of cells) {
    // Reason: c is a logical column (< 22), so the slot always exists.
    mask[c] = (mask[c] as number) | (1 << r);
  }
  return mask;
}

export function maskToCells(mask: number[]): BoardCell[] {
  const cells: BoardCell[] = [];
  for (let r = 0; r < LOGIC_ROWS; r++) {
    for (let c = 0; c < LOGIC_COLS; c++) {
      // Reason: c is a logical column (< 22); the mask is always 22 long.
      if ((mask[c] as number) & (1 << r)) cells.push([r, c]);
    }
  }
  return cells;
}

// The wire trigger is the primitive's own (composable-v1); selectable key input
// carries its scope, "surface" unless the layer asks for "all".
function deviceTrigger(layer: LayerDsl): TriggerDsl {
  const cap = primitiveContract(layer.component);
  if (!cap) return layer.trigger || { type: 'always' };
  const lifecycle = layer.component === 'reactive' && layer.params?.color_mode === 'lifecycle';
  return {
    type: cap.trigger,
    ...(cap.inputScope === 'selectable' && !lifecycle
      ? { scope: (layer.trigger?.scope as string | undefined) ?? 'surface' }
      : {}),
  };
}

// Params the registry does not list for a primitive do nothing on any engine (the
// validator warns about them); drop them so the preview, the .lep and every player
// read the same parameters. `params.easing` is the old spelling of time.easing.
function knownParams(layer: LayerDsl): LayerParams {
  const params = layer.params || {};
  const spec = getComponent(layer.component)?.params;
  if (!spec || layer.component === 'sparkle') return params;
  const out: LayerParams = {};
  for (const [k, v] of Object.entries(params)) if (k in spec || k === 'easing') out[k] = v;
  return out;
}

function normalizeParams(layer: LayerDsl, dsl: EffectDsl): LayerParams {
  const params = knownParams(layer);
  if (layer.component === 'sparkle') {
    // Equivalent to `const { clock, ...rest } = params; return rest;`.
    const rest = { ...params };
    delete rest.clock;
    return rest;
  }
  // Lifecycle colours always come from layer.color; the wire format says so
  // with palette "custom".
  if (layer.component === 'reactive' && params.color_mode === 'lifecycle') {
    return { ...params, palette: 'custom' };
  }
  // Upstream lepc: physical-v1 flips the wave direction (a reversed spatial
  // direction flips it back); a uniform wave has no direction to flip.
  if (
    layer.component === 'rainbow_wave' &&
    params.axis !== 'uniform' &&
    dsl.meta?.motion_profile === 'physical-v1'
  ) {
    const reversed = (params.direction ?? layer.time?.direction) === 'reverse';
    const spatialReversed = ['reverse', 'mirror_reverse'].includes(params.spatial_direction as string);
    return { ...params, direction: reversed !== spatialReversed ? 'forward' : 'reverse' };
  }
  // A random reactive colour draws from color.palette; the wire carries it as the
  // palette parameter (upstream canonicalParams).
  if (
    layer.component === 'reactive' &&
    layer.color?.type === 'random' &&
    params.palette === undefined &&
    layer.color.palette !== undefined
  )
    return { ...params, palette: layer.color.palette };
  return params;
}

// The keyboard firmware does not carry custom colours for palette_index, so a
// custom palette entry is resolved to its solid colour (same rule as lepc).
export function deviceColor(color: LayerDsl['color']): ColorSpec | null {
  if (color?.type === 'palette_index' && color.palette === 'custom' && color.colors?.length) {
    const i = Math.max(0, Math.min(color.colors.length - 1, color.index ?? 0));
    return { type: 'solid', rgb: (color.colors[i] as Rgb).slice() as Rgb };
  }
  return color || null;
}

// Build a runtime program. Assumes the DSL already passed `validate`.
export function normalize(dsl: EffectDsl, board?: Board | null): Program {
  board = boardForEffect(dsl, board);
  // ENGINE.md §2.4: disabled layers stay in the document so they can be
  // re-enabled, but they do not render and are not written to `.lep`.
  const layers: NormalizedLayer[] = dsl.layer
    .filter((layer) => layer.enabled !== false)
    .map((layer) => {
      const cells = expandSurface(layer.surface, board);
      return {
        id: layer.id,
        component: layer.component,
        blend: layer.blend || 'replace',
        opacity: layer.opacity ?? 255,
        cells,
        mask: cellsToMask(cells),
        color: deviceColor(layer.color),
        ...(layer.audio_mod !== undefined ? { audio_mod: layer.audio_mod } : {}),
        ...(layer.playback?.start === 'audio_onset'
          ? { playback: layer.playback }
          : hasPlayback(layer)
            ? {
                playback: {
                  ...layer.playback,
                  inputMask:
                    layer.playback &&
                    typeof layer.playback === 'object' &&
                    ('start' in layer.playback || 'stop' in layer.playback) &&
                    ((layer.playback as { start?: string }).start === 'selected_press' ||
                      (layer.playback as { stop?: string }).stop === 'selected_press')
                      ? cellsToMask(
                          expandSurface(
                            (layer.playback as { input?: typeof layer.surface }).input ?? layer.surface,
                            board,
                          ),
                        )
                      : new Array(22).fill(0),
                },
              }
            : {}),
        time: layer.time || { type: 'static' },
        trigger: deviceTrigger(layer),
        params: normalizeParams(layer, dsl),
        frames: layer.frames || null,
        // Upstream lepc: a reactive lifecycle layer has no easing LUT (none on the wire).
        lut:
          EASE_COMPONENTS.has(layer.component) &&
          !(layer.component === 'reactive' && layer.params?.color_mode === 'lifecycle')
            ? bakeEasing(resolveEasing(layer))
            : null,
      };
    });

  return {
    seed: dsl.meta.seed,
    layers,
    meta: { ...dsl.meta, execution_profile: 'composable-v1' },
  };
}
