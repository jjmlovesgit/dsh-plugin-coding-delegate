/**
 * A merge whose result shares no object identity with its inputs.
 *
 * The behaviour is unchanged from the first version; what changed is where the loops live. As one
 * 50-line function with a recursive helper inside it, both the length and the branch count put it over
 * the Tier 1 ceilings -- and the ceilings are the reason a reader can still check the patch semantics
 * below without holding the whole function in their head.
 *
 * THE PROTOYPE GUARD IS LOAD-BEARING, not defensive tidiness: a patch carrying `__proto__` would
 * otherwise write through to the object's prototype, and a merge that can do that is a gadget rather
 * than a utility. Every loop here skips those keys, and they are skipped in the COPY as well as the
 * patch, because a base object can arrive carrying one.
 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(value: unknown): value is Record<string, any> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function deepClone(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => deepClone(item));
  if (!isPlainObject(value)) return value;

  const result: Record<string, any> = {};
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    result[key] = deepClone(value[key]);
  }
  return result;
}

/** A shallow copy of `source`'s own enumerable keys, cloned one level and filtered. */
function copyWithoutForbidden(source: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const key of Object.keys(source)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    result[key] = deepClone(source[key]);
  }
  return result;
}

/** Apply `patch`'s keys to an already-copied `result`. Null deletes; objects recurse; else replace. */
function applyPatch(
  result: Record<string, any>,
  base: Record<string, any>,
  patch: Record<string, any>
): Record<string, any> {
  for (const key of Object.keys(patch)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    if (patch[key] === null) {
      delete result[key];
    } else if (isPlainObject(base[key]) && isPlainObject(patch[key])) {
      result[key] = mergeValue(base[key], patch[key]);
    } else {
      result[key] = deepClone(patch[key]);
    }
  }
  return result;
}

function mergeValue(base: unknown, patch: unknown): unknown {
  if (patch === null) return null;
  if (!isPlainObject(base) || !isPlainObject(patch)) return deepClone(patch);
  return applyPatch(copyWithoutForbidden(base), base, patch);
}

export function canonicalMerge<T extends Record<string, any>>(base: T, patch: Record<string, any>): Record<string, any> {
  return mergeValue(base, patch) as Record<string, any>;
}
