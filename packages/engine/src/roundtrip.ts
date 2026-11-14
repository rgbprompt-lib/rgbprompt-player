// Convert a decoded .lep program back into editable DSL (import / reverse view).
import { EASE_COMPONENTS } from './normalize.ts';
import { LOGIC_ROWS, LOGIC_COLS } from './constants.ts';
import type {
  DecodedLayer,
  EffectDsl,
  EffectMeta,
  LayerDsl,
  LayerTimeDsl,
  Program,
  SurfaceDsl,
} from './types.ts';

const ALL_MASK = (1 << LOGIC_ROWS) - 1; // 0x3f (6 rows)

function surfaceFromLayer(layer: DecodedLayer): SurfaceDsl {
  const mask = layer.mask || [];
  let all = mask.length === LOGIC_COLS;
  for (let c = 0; c < LOGIC_COLS; c++)
    if ((mask[c] || 0) !== ALL_MASK) {
      all = false;
      break;
    }
  if (all) return { type: 'all' };
  return { type: 'cells', cells: (layer.cells || []).map(([r, c]) => `${r},${c}`) };
}

/**
 * Decoded playback back to DSL: `inputMask` is a normalized/wire field the DSL
 * validator rejects, so it becomes `playback.input` (cells) when a
 * selected_press event uses a selection other than the layer surface.
 */
function playbackToDsl(layer: DecodedLayer): NonNullable<LayerDsl['playback']> {
  const playback = layer.playback as Record<string, unknown> | undefined;
  if (!playback || playback.start === 'audio_onset')
    return layer.playback as NonNullable<LayerDsl['playback']>;
  const { inputMask, ...rest } = playback as { inputMask?: number[] } & Record<string, unknown>;
  const selected = rest.start === 'selected_press' || rest.stop === 'selected_press';
  const mask = layer.mask || [];
  if (selected && Array.isArray(inputMask) && inputMask.some((v, c) => v !== (mask[c] ?? 0))) {
    const cells: string[] = [];
    for (let r = 0; r < LOGIC_ROWS; r++)
      for (let c = 0; c < LOGIC_COLS; c++) if (((inputMask[c] ?? 0) >> r) & 1) cells.push(`${r},${c}`);
    rest.input = { type: 'cells', cells };
  }
  return rest as NonNullable<LayerDsl['playback']>;
}

export function programToDsl(program: Program, meta?: EffectMeta): EffectDsl {
  const layers: LayerDsl[] = (program.layers || []).map((l) => {
    const out: LayerDsl = {
      id: l.id || l.component,
      component: l.component,
      surface: surfaceFromLayer(l),
    };
    if (l.blend && l.blend !== 'replace') out.blend = l.blend;
    if (l.opacity !== undefined && l.opacity !== 255) out.opacity = l.opacity;
    if (l.color) out.color = l.color;
    if (l.audio_mod) out.audio_mod = l.audio_mod;
    if (l.playback) out.playback = playbackToDsl(l);

    const time: LayerTimeDsl = { type: (l.time && l.time.type) || 'static' };
    if (l.time) {
      if (l.time.period_ms) time.period_ms = l.time.period_ms;
      if (l.time.phase_ms) time.phase_ms = l.time.phase_ms;
      if (l.time.direction && l.time.direction !== 'forward') time.direction = l.time.direction;
    }
    if (l.lut && EASE_COMPONENTS.has(l.component)) time.easing = { lut: l.lut };
    else if (l.time && l.time.easing && l.time.easing !== 'sine') time.easing = l.time.easing;
    if (time.type !== 'static' || Object.keys(time).length > 1) out.time = time;

    if (l.trigger && l.trigger.type && l.trigger.type !== 'always') out.trigger = { type: l.trigger.type };
    if (l.params && Object.keys(l.params).length) {
      out.params = { ...l.params };
      if (l.component === 'rainbow_wave' && meta?.motion_profile === 'physical-v1') {
        out.params.direction = l.params.direction === 'reverse' ? 'forward' : 'reverse';
      }
    }
    if (l.frames) out.frames = l.frames;
    return out;
  });

  const m: EffectMeta = {
    name: (meta && meta.name) || 'Imported',
    author: (meta && meta.author) || 'import',
    generator: (meta && meta.generator) || 'human',
    seed: program.seed >>> 0,
  };
  if (meta && meta.tags) m.tags = meta.tags;
  if (meta && meta.license) m.license = meta.license;
  if (meta && meta.region_profile) m.region_profile = meta.region_profile;
  if (meta && meta.motion_profile) m.motion_profile = meta.motion_profile;
  m.execution_profile = 'composable-v1';

  return { schema: 'lep.effect/1', meta: m, layer: layers };
}
