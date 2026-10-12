// canonicalMerge: a JSON-shaped merge that never mutates its inputs, never shares
// references with them, deletes keys on a null patch value, and refuses to write
// prototype-polluting keys at any depth.

type JsonObject = Record<string, any>;

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** True for a non-null object whose prototype is Object.prototype or null. */
function isPlainObject(value: any): value is JsonObject {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Own-enumerable deep copy. Plain objects and arrays become fresh literals that
 * share no references with the source; every other value is returned by reference.
 */
function cloneDeep(value: any): any {
  if (Array.isArray(value)) {
    const out: any[] = [];
    for (let i = 0; i < value.length; i += 1) out.push(cloneDeep(value[i]));
    return out;
  }
  if (isPlainObject(value)) {
    const out: JsonObject = {};
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(key)) continue;
      out[key] = cloneDeep(value[key]);
    }
    return out;
  }
  return value;
}

/** Applies `patch` onto `target` in place. `target` is always caller-owned. */
function applyPatch(target: JsonObject, patch: JsonObject): void {
  if (patch === null || typeof patch !== 'object') return;
  for (const key of Object.keys(patch)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    const value = patch[key];
    if (value === null) {
      delete target[key];
      continue;
    }
    if (isPlainObject(value)) {
      const existing = target[key];
      if (isPlainObject(existing)) {
        applyPatch(existing, value);
      } else {
        // Nothing mergeable was there, so the patch object is applied onto an empty target
        // rather than copied verbatim: a null member is a deletion at any depth, and it must
        // delete here too instead of arriving as a literal null.
        const fresh: JsonObject = {};
        applyPatch(fresh, value);
        target[key] = fresh;
      }
      continue;
    }
    target[key] = cloneDeep(value);
  }
}

export function canonicalMerge<T extends Record<string, any>>(
  base: T,
  patch: Record<string, any>
): Record<string, any> {
  const result: JsonObject = {};
  if (base !== null && typeof base === 'object') {
    for (const key of Object.keys(base)) {
      if (FORBIDDEN_KEYS.has(key)) continue;
      result[key] = cloneDeep((base as JsonObject)[key]);
    }
  }
  applyPatch(result, patch);
  return result;
}
