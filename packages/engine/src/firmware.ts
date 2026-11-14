// Firmware export layer (ADR-0017). `validate` is the product layer: everything the
// TypeScript engine renders, previews and plays (web, Player) the same way, before and
// after a .lep round trip. The keyboard firmware runs a stricter composable-v1
// execution contract (one state pool per kind, fewer colour and time combinations,
// no trigger options, ...). Those limits apply only when a document is exported to
// firmware: `validateForFirmware` = product validation + the device contract checked
// on `deviceDocument(effect)`. A document it accepts loads on the firmware, passes the
// pinned upstream strict validator and encodes to the same bytes.
import { boardForEffect } from './surfaces.ts';
import { deviceDocument } from './device_doc.ts';
import { executionIssues } from './execution.ts';
import { validate } from './validate.ts';
import type { Board, ValidationCode, ValidationIssue, ValidationReport } from './types.ts';

const EXECUTION_CODES: Record<string, ValidationCode> = {
  meta: 'META_INVALID',
  color: 'COLOR_UNSUPPORTED',
  time: 'TIME_INVALID',
  trigger: 'TRIGGER_INVALID',
  params: 'PARAM_UNKNOWN',
  surface: 'SURFACE_INVALID',
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Device-contract issues of a product-valid document, with paths into the original layers. */
export function firmwareIssues(dsl: Record<string, unknown>, board?: Board | null): ValidationIssue[] {
  const layers = Array.isArray(dsl.layer) ? dsl.layer : [];
  const enabled = layers.flatMap((layer, i) => (isRecord(layer) && layer.enabled === false ? [] : [i]));
  return executionIssues(deviceDocument(dsl, boardForEffect(dsl, board))).map(({ layer, field, message }) => {
    const head = field.split('.')[0] as string;
    const code = EXECUTION_CODES[head] ?? 'LAYER_INVALID';
    const path = layer === null ? field : `layer[${enabled[layer]}].${field}`;
    return { path, code, message };
  });
}

/** Product validation (strict) followed by the firmware execution contract. */
export function validateForFirmware(dsl: unknown, opts: { board?: Board | null } = {}): ValidationReport {
  const report = validate(
    dsl,
    opts.board === undefined ? { mode: 'strict' } : { mode: 'strict', board: opts.board },
  );
  if (!report.ok || !isRecord(dsl)) return report;
  const errors = firmwareIssues(dsl, opts.board);
  return errors.length === 0 ? report : { ...report, ok: false, errors, value: null };
}
