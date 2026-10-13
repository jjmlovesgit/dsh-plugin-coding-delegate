// NEGATIVE FIXTURE - never imported by the module under test, only by the discrimination gate.
//
// It is deliberately PLAUSIBLE: the signature is the required generic one, it merges recursively, it
// deletes on null, it skips the forbidden keys, and it never writes into either argument. It is wrong
// in exactly one respect -- it hands the caller REFERENCES instead of copies, for array values and for
// keys that exist only in `base`.
//
// Expected: the contract passes every case EXCEPT the two decoupling cases, which it must fail. This
// is the defect the first local generation actually shipped, minus its signature error, so the only
// property under test here is the aliasing.
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(value: any): boolean {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function canonicalMerge<T extends Record<string, any>>(
  base: T,
  patch: Record<string, any>
): Record<string, any> {
  const result: Record<string, any> = {};

  for (const key of Object.keys(base)) {
    if (FORBIDDEN.has(key)) continue;
    // ALIASED: no clone. A key that exists only in base is handed to the caller by reference.
    result[key] = (base as Record<string, any>)[key];
  }

  for (const key of Object.keys(patch)) {
    if (FORBIDDEN.has(key)) continue;
    const value = patch[key];
    if (value === null) {
      delete result[key];
      continue;
    }
    if (isPlainObject(value)) {
      const existing = result[key];
      result[key] = isPlainObject(existing)
        ? canonicalMerge(existing, value)
        : canonicalMerge({}, value);
      continue;
    }
    // ALIASED: arrays and every other non-plain value are stored by reference.
    result[key] = value;
  }

  return result;
}
