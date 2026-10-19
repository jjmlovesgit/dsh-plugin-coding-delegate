// Negative fixture for result.contract.cjs: correct in every respect EXCEPT unwrapOr.
//
// `unwrapOr` ignores the Ok branch and always returns the fallback. That is a plausible-looking
// implementation of the wrong behaviour -- it type-checks, it never throws, and it silently discards
// every successful value at the boundary that unwraps it. The contract must fail on this and pass on
// the real module.
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function Ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function Err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is { readonly ok: true; readonly value: T } {
  return result.ok === true;
}

export function isErr<T, E>(result: Result<T, E>): result is { readonly ok: false; readonly error: E } {
  return result.ok === false;
}

export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  // THE DEFECT: the success branch is never consulted.
  return fallback;
}

export function map<T, U, E>(result: Result<T, E>, transform: (value: T) => U): Result<U, E> {
  return result.ok ? Ok(transform(result.value)) : result;
}
