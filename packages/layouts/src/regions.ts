// TUN-04 user-facing region labels (ENGINE.md §4.3), in the table's order.
// Labels are i18n keys; the en / zh-CN strings belong in the i18n catalogue.
import type { RegionLabel } from './types.ts';

export const REGION_LABELS: readonly RegionLabel[] = Object.freeze([
  { id: 'all', labelKey: 'tuning.region.all' },
  { id: 'alphas', labelKey: 'tuning.region.alphas' },
  { id: 'numbers', labelKey: 'tuning.region.numbers' },
  { id: 'f_row', labelKey: 'tuning.region.f_row' },
  { id: 'arrows', labelKey: 'tuning.region.arrows' },
  { id: 'numpad', labelKey: 'tuning.region.numpad' },
  { id: 'left_half', labelKey: 'tuning.region.left_half' },
  { id: 'right_half', labelKey: 'tuning.region.right_half' },
]);
