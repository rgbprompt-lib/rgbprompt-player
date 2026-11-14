import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('effect schema component names match the primitive registry', () => {
  const schema = JSON.parse(readFileSync(new URL('../data/schemas/effect.schema.json', import.meta.url)));
  const registry = JSON.parse(
    readFileSync(new URL('../data/schemas/primitive-registry.json', import.meta.url)),
  );
  assert.deepEqual(
    [...schema.$defs.layer.properties.component.enum].sort(),
    registry.primitives.map((primitive) => primitive.name).sort(),
  );
});
