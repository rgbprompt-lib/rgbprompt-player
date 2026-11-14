// Generation-only primitive descriptions (GENERATION.md §3.1, ADR-0013).
// Kept out of the product catalogue so client builds never include them.
import promptJson from '../../data/primitives.prompt.json' with { type: 'json' };

export interface PrimitivePromptData {
  purpose: string;
}

export type PrimitivePromptCatalog = Readonly<Record<string, PrimitivePromptData>>;

export const PRIMITIVE_PURPOSE = promptJson as unknown as PrimitivePromptCatalog;

export function getPrimitivePurpose(name: string): string {
  return PRIMITIVE_PURPOSE[name]?.purpose ?? '';
}
