// The contract for canonicalMerge. Architect-authored: hashed before the unit runs and re-hashed
// after it, so the worker may not touch it and any change to it voids the verdict.
//
// Two of these assertions were strengthened after the first local generation passed an earlier
// revision of this file while aliasing its inputs. The lesson is recorded in the cases themselves:
//   - a decoupling test must compare IDENTITY and must reach past one level of nesting, or a shallow
//     spread satisfies it;
//   - a test named for three forbidden keys must assert all three, at depth, or the name overstates
//     the coverage.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { canonicalMerge } = require('../../tools/json-canonical-merge.ts');

test('json-canonical-merge specification contract', async (t) => {
  await t.test('enforces exact generic signature in source', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../tools/json-canonical-merge.ts'), 'utf8');
    const sigPattern = /export\s+function\s+canonicalMerge\s*<\s*T\s+extends\s+Record<\s*string\s*,\s*any\s*>\s*>\s*\(\s*base\s*:\s*T\s*,\s*patch\s*:\s*Record<\s*string\s*,\s*any\s*>\s*\)\s*:\s*Record<\s*string\s*,\s*any\s*>/;
    assert.match(src, sigPattern, 'Source must define exact generic type signature');
  });

  await t.test('merges shallow non-overlapping keys', () => {
    assert.deepEqual(canonicalMerge({ b: 2 }, { a: 1 }), { a: 1, b: 2 });
  });

  await t.test('overwrites scalar collisions with patch value', () => {
    assert.deepEqual(canonicalMerge({ a: 1, b: 'old' }, { b: 'new' }), { a: 1, b: 'new' });
  });

  await t.test('recursively merges nested sub-objects', () => {
    assert.deepEqual(
      canonicalMerge({ nested: { x: 10, y: 20 }, flag: true }, { nested: { y: 30, z: 40 } }),
      { flag: true, nested: { x: 10, y: 30, z: 40 } }
    );
  });

  await t.test('deletes keys when patch value is explicit null', () => {
    assert.deepEqual(
      canonicalMerge({ keep: true, removeMe: 123, nested: { a: 1, kill: 2 } }, { removeMe: null, nested: { kill: null, add: 3 } }),
      { keep: true, nested: { a: 1, add: 3 } }
    );
  });

  await t.test('arrays are treated as replacement values', () => {
    assert.deepEqual(canonicalMerge({ items: [1, 2, 3] }, { items: [4, 5] }), { items: [4, 5] });
  });

  // Restored: the non-plain-object clause runs in BOTH directions. A suite that only tests
  // scalar-over-scalar leaves half of the requirement unexercised.
  await t.test('a scalar replaces an object and an object replaces a scalar', () => {
    assert.deepEqual(canonicalMerge({ a: { b: 1 } }, { a: 5 }), { a: 5 });
    assert.deepEqual(canonicalMerge({ a: 5 }, { a: { b: 1 } }), { a: { b: 1 } });
  });

  await t.test('deeply decouples result from base and patch inputs (no aliasing)', () => {
    const base = { nested: { x: 10 }, arr: [1, 2] };
    const patch = { nested: { y: 20 }, arr: [3, 4], addedObj: { z: 30 } };

    // Identity first: a shallow spread passes any assertion that only inspects primitives.
    assert.notEqual(canonicalMerge(base, patch).nested, base.nested, 'result.nested must not be base.nested');
    assert.notEqual(canonicalMerge(base, patch).nested, patch.nested, 'result.nested must not be patch.nested');

    const out = canonicalMerge(base, patch);
    assert.notEqual(out.arr, base.arr, 'result.arr must not be base.arr');
    assert.notEqual(out.arr, patch.arr, 'result.arr must not be patch.arr');
    assert.notEqual(out.addedObj, patch.addedObj, 'result.addedObj must not be patch.addedObj');

    out.nested.x = 999;
    out.arr.push(999);
    out.addedObj.z = 999;

    assert.equal(base.nested.x, 10, 'Mutating output nested object must not affect base');
    assert.equal(base.arr.length, 2, 'Mutating output array must not affect base');
    assert.equal(patch.addedObj.z, 30, 'Mutating output sub-object must not affect patch');
    // The array here came from PATCH, so patch.arr is the one to check. The earlier revision checked
    // base.arr and therefore passed while patch.arr was being mutated through the result.
    assert.deepEqual(patch.arr, [3, 4], 'Mutating output array must not affect patch');
    assert.equal(patch.nested.y, 20, 'Mutating output must not affect patch nested object');
  });

  // Depth is the point: one level of nesting is exactly where a shallow spread stops being detectable.
  await t.test('decouples at depth, not just one level', () => {
    const baseOnly = { keep: { deep: { v: 1 } } };
    const outA = canonicalMerge(baseOnly, {});
    outA.keep.deep.v = 111;
    assert.equal(baseOnly.keep.deep.v, 1, 'base-only nested value must not be aliased');
    assert.notEqual(outA.keep, baseOnly.keep);

    const patch = { a: { deep: { v: 5 } } };
    const outB = canonicalMerge({ a: 1 }, patch);
    assert.notEqual(outB.a, patch.a);
    assert.notEqual(outB.a.deep, patch.a.deep);
    outB.a.deep.v = 222;
    assert.equal(patch.a.deep.v, 5, 'patch nested value must not be aliased');

    const arrPatch = { arr: [{ n: 1 }] };
    const outC = canonicalMerge({}, arrPatch);
    assert.notEqual(outC.arr, arrPatch.arr);
    assert.notEqual(outC.arr[0], arrPatch.arr[0], 'array elements must be copied, not aliased');
    outC.arr[0].n = 333;
    assert.equal(arrPatch.arr[0].n, 1, 'array elements must be deep-copied');
  });

  await t.test('omits __proto__, constructor, and prototype at all depths', () => {
    const maliciousPayload = JSON.parse(
      '{"nested":{"__proto__":{"polluted":true},"safe":1},' +
        '"constructor":{"x":1},"prototype":{"y":2},' +
        '"deep":{"constructor":{"z":3},"prototype":{"w":4},"__proto__":{"q":5}}}'
    );
    const out = canonicalMerge({}, maliciousPayload);

    assert.equal(Object.prototype.polluted, undefined, 'Prototype must not be polluted');
    assert.equal({}.polluted, undefined, 'Prototype must not be polluted');
    assert.equal(Object.getPrototypeOf(out), Object.prototype, 'result must be a plain object');

    assert.equal(Object.prototype.hasOwnProperty.call(out, '__proto__'), false, 'no own __proto__ at top level');
    assert.equal(Object.prototype.hasOwnProperty.call(out, 'constructor'), false, 'no own constructor at top level');
    assert.equal(Object.prototype.hasOwnProperty.call(out, 'prototype'), false, 'no own prototype at top level');

    assert.equal(Object.prototype.hasOwnProperty.call(out.nested, '__proto__'), false, 'no own __proto__ nested');
    assert.equal(Object.prototype.hasOwnProperty.call(out.deep, 'constructor'), false, 'no own constructor nested');
    assert.equal(Object.prototype.hasOwnProperty.call(out.deep, 'prototype'), false, 'no own prototype nested');
    assert.equal(Object.prototype.hasOwnProperty.call(out.deep, '__proto__'), false, 'no own __proto__ at depth');

    assert.deepEqual(out.nested, { safe: 1 }, 'nested object keeps only its legitimate key');
  });

  await t.test('does not mutate either argument during the call', () => {
    const base = { a: { b: 1 }, keep: [1, 2] };
    const patch = { a: { c: 2 }, drop: null, arr: [1] };
    const baseBefore = JSON.parse(JSON.stringify(base));
    const patchBefore = JSON.parse(JSON.stringify(patch));
    canonicalMerge(base, patch);
    assert.deepEqual(base, baseBefore);
    assert.deepEqual(patch, patchBefore);
  });
});
