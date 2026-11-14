// The device document: what a DSL document means on the wire (composable-v1).
// Authoring-only features are resolved here exactly as `normalize` resolves them,
// so encode(normalize(doc)) is byte-identical to the upstream encoding of
// deviceDocument(doc) (checked by `pnpm upstream:device`):
// - layers with `enabled: false` are dropped; `enabled` and the display `label`
//   are removed from the rest, and so is `trigger.threshold` (never read);
// - `regions` surfaces (this repo's region names) become explicit `cells`, and
//   `meta.region_profile` is removed;
// - sparkle always runs on time (`params.clock: "time"`), reactive lifecycle
//   always reads its custom palette (`params.palette: "custom"`).
import { boardForEffect, expandSurface } from './surfaces.ts';
import type { Board, SurfaceDsl } from './types.ts';

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function resolveSurface(surface: unknown, board: Board): unknown {
  if (!isRecord(surface) || surface.type !== 'regions') return surface;
  const cells = expandSurface(surface as unknown as SurfaceDsl, board);
  return { type: 'cells', cells: cells.map(([r, c]) => `${r},${c}`) };
}

/** Throws only when a surface cannot be expanded (validate reports that first). */
export function deviceDocument(dsl: unknown, board?: Board | null): Json {
  if (!isRecord(dsl)) return dsl as Json;
  const resolvedBoard = boardForEffect(dsl, board);
  const meta = isRecord(dsl.meta) ? { ...dsl.meta } : {};
  delete meta.region_profile;
  meta.execution_profile = 'composable-v1';
  const layers = Array.isArray(dsl.layer) ? dsl.layer : [];
  const layer = layers
    .filter((l) => !(isRecord(l) && l.enabled === false))
    .map((l) => {
      if (!isRecord(l)) return l;
      const out: Json = { ...l };
      delete out.enabled;
      delete out.label;
      out.surface = resolveSurface(l.surface, resolvedBoard);
      if (isRecord(l.playback) && l.playback.input !== undefined)
        out.playback = { ...l.playback, input: resolveSurface(l.playback.input, resolvedBoard) };
      // trigger.threshold is an authoring field the engine never reads; the device has no slot for it.
      if (isRecord(l.trigger) && 'threshold' in l.trigger) {
        const { threshold: _unused, ...trigger } = l.trigger;
        void _unused;
        out.trigger = trigger;
      }
      const params = isRecord(l.params) ? l.params : undefined;
      if (l.component === 'sparkle') out.params = { ...(params ?? {}), clock: 'time' };
      if (l.component === 'reactive' && params?.color_mode === 'lifecycle')
        out.params = { ...params, palette: 'custom' };
      return out;
    });
  return { ...dsl, meta, layer };
}
