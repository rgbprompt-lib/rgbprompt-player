// Loads the authoritative primitive registry (data/schemas/primitive-registry.json).
import registryJson from '../data/schemas/primitive-registry.json' with { type: 'json' };
import type { PrimitiveRegistry, RegistryIndex, RegistryPrimitive } from './types.ts';

// Reason: JSON imports infer string literals for region values; the registry
// data is authoritative and validated by its schema.
const raw = registryJson as PrimitiveRegistry;
const byName = new Map<string, RegistryPrimitive>();
const byId = new Map<number, RegistryPrimitive>();
for (const p of raw.primitives) {
  byName.set(p.name, p);
  byId.set(p.id, p);
}
const cache: RegistryIndex = { raw, byName, byId };

export function loadRegistry(): RegistryIndex {
  return cache;
}

export function componentNames(): string[] {
  return [...loadRegistry().byName.keys()];
}

export function getComponent(name: unknown): RegistryPrimitive | null {
  // Reason: Map lookups accept any key at runtime; unknown names simply miss.
  return loadRegistry().byName.get(name as string) || null;
}

export function idToName(id: number): string | null {
  const p = loadRegistry().byId.get(id);
  return p ? p.name : null;
}

export function nameToId(name: string): number | null {
  const p = loadRegistry().byName.get(name);
  return p ? p.id : null;
}
