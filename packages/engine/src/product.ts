// Product metadata layered on top of the primitive registry (ENGINE.md §3.2).
import productJson from '../data/primitives.product.json' with { type: 'json' };
import type { PrimitiveProduct, PrimitiveProductCatalog } from './types.ts';

// The JSON file is authoritative; its shape is checked by test/product.test.js.
export const PRIMITIVES_PRODUCT = productJson as unknown as PrimitiveProductCatalog;

export function getPrimitiveProduct(name: string): PrimitiveProduct | null {
  return PRIMITIVES_PRODUCT[name] ?? null;
}
