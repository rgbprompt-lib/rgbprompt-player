import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const product = JSON.parse(readFileSync(new URL('../data/primitives.product.json', import.meta.url), 'utf8'));
const promptData = JSON.parse(
  readFileSync(new URL('../data/primitives.prompt.json', import.meta.url), 'utf8'),
);
const registry = JSON.parse(
  readFileSync(new URL('../data/schemas/primitive-registry.json', import.meta.url), 'utf8'),
);

const CLOSED = new Set(['frame_sequence', 'layer_event']);
const FIELDS = new Set([
  'displayName',
  'icon',
  'tags',
  'speed',
  'direction',
  'colorSlots',
  'requiresInput',
  'flashRisk',
  'space',
]);

test('product metadata covers exactly the v1-open primitives', () => {
  const open = registry.primitives.map((primitive) => primitive.name).filter((name) => !CLOSED.has(name));
  assert.deepEqual(Object.keys(product).sort(), [...open].sort());
});

test('every product key exists in the registry', () => {
  const registryKeys = new Set(registry.primitives.map((primitive) => primitive.name));
  for (const key of Object.keys(product)) assert.ok(registryKeys.has(key), `unknown primitive ${key}`);
});

test('typed product export matches the JSON file', async () => {
  const { PRIMITIVES_PRODUCT, getPrimitiveProduct } = await import('../src/product.ts');
  assert.deepEqual(PRIMITIVES_PRODUCT, product);
  assert.equal(getPrimitiveProduct('rain').displayName.en, 'Rain');
  assert.equal(getPrimitiveProduct('missing'), null);
});

test('prompt data covers exactly the product catalogue', () => {
  assert.deepEqual(Object.keys(promptData).sort(), Object.keys(product).sort());
  for (const [name, entry] of Object.entries(promptData)) {
    assert.deepEqual(new Set(Object.keys(entry)), new Set(['purpose']), `${name} prompt fields`);
    assert.equal(typeof entry.purpose, 'string', `${name} purpose`);
    assert.ok(entry.purpose.trim().length > 0, `${name} purpose`);
  }
});

test('typed prompt export matches the JSON file', async () => {
  const { PRIMITIVE_PURPOSE, getPrimitivePurpose } = await import('../src/server/prompt-data.ts');
  assert.deepEqual(PRIMITIVE_PURPOSE, promptData);
  assert.equal(getPrimitivePurpose('rain'), promptData.rain.purpose);
  assert.equal(getPrimitivePurpose('missing'), '');
});

test('product entries have the documented shape and valid references', () => {
  const byName = new Map(registry.primitives.map((primitive) => [primitive.name, primitive]));
  for (const [name, entry] of Object.entries(product)) {
    assert.deepEqual(new Set(Object.keys(entry)), FIELDS, `${name} fields`);
    assert.equal(typeof entry.icon, 'string');
    assert.ok(entry.icon.length > 0, `${name} icon`);
    assert.ok(Array.isArray(entry.tags) && entry.tags.length > 0, `${name} tags`);
    assert.equal(typeof entry.displayName.en, 'string');
    assert.ok(entry.displayName.en.length > 0, `${name} displayName.en`);
    assert.equal(typeof entry.displayName['zh-CN'], 'string');
    assert.ok(entry.displayName['zh-CN'].length > 0, `${name} displayName.zh-CN`);
    assert.ok(['logical', 'physical'].includes(entry.space), `${name} space`);
    assert.ok(['low', 'medium', 'high'].includes(entry.flashRisk), `${name} flashRisk`);
    assert.ok([null, 'key', 'audio'].includes(entry.requiresInput), `${name} requiresInput`);
    assert.ok(Array.isArray(entry.colorSlots) && entry.colorSlots.length > 0, `${name} colorSlots`);

    const primitive = byName.get(name);
    assert.ok(primitive, `${name} in registry`);
    const params = new Set(Object.keys(primitive.params || {}));
    assert.ok(Array.isArray(entry.speed.params), `${name} speed.params`);
    assert.equal(typeof entry.speed.inverse, 'boolean', `${name} speed.inverse`);
    for (const param of entry.speed.params) {
      assert.ok(params.has(param), `${name} speed param "${param}" is not in the registry`);
    }
    if (entry.direction !== null) {
      assert.equal(typeof entry.direction, 'string', `${name} direction`);
      assert.ok(params.has(entry.direction), `${name} direction "${entry.direction}" is not in the registry`);
    }
  }
});
