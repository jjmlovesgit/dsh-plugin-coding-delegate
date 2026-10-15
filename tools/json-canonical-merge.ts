export function canonicalMerge<T extends Record<string, any>>(base: T, patch: Record<string, any>): Record<string, any> {
  const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

  function isPlainObject(value: unknown): value is Record<string, any> {
    if (value === null || typeof value !== 'object') return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }

  function deepClone(value: unknown): unknown {
    if (value === null || typeof value !== 'object') {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => deepClone(item));
    }
    if (isPlainObject(value)) {
      const result: Record<string, any> = {};
      for (const key of Object.keys(value)) {
        if (FORBIDDEN_KEYS.has(key)) continue;
        result[key] = deepClone(value[key]);
      }
      return result;
    }
    return value;
  }

  function merge(baseVal: unknown, patchVal: unknown): unknown {
    if (patchVal === null) {
      return null;
    }

    if (isPlainObject(baseVal) && isPlainObject(patchVal)) {
      const result: Record<string, any> = {};

      for (const key of Object.keys(baseVal)) {
        if (FORBIDDEN_KEYS.has(key)) continue;
        result[key] = deepClone(baseVal[key]);
      }

      for (const key of Object.keys(patchVal)) {
        if (FORBIDDEN_KEYS.has(key)) continue;
        if (patchVal[key] === null) {
          delete result[key];
        } else if (isPlainObject(baseVal[key]) && isPlainObject(patchVal[key])) {
          result[key] = merge(baseVal[key], patchVal[key]);
        } else {
          result[key] = deepClone(patchVal[key]);
        }
      }

      return result;
    }

    return deepClone(patchVal);
  }

  return merge(base, patch);
}
