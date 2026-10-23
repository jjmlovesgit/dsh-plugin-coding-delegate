/**
 * Result: the smallest total representation of "succeeded with a value, or failed with a reason".
 *
 * WHY THIS IS A TIER 1 PRIMITIVE AND NOT A CONVENIENCE. Every function in this repository that can
 * fail has to answer the same question at its boundary: is a failure a thrown exception, a sentinel,
 * or a structured value? Three answers in one codebase is how a caller ends up checking `if (result)`
 * on an object that is truthy even when it failed. A Result makes the two outcomes the same shape and
 * forces the caller to name which one it has.
 *
 * IT IS ALSO THE FIRST FILE IN `src/core/primitives/`, WHICH MAKES IT THE PROOF OF THAT FENCE. The
 * leaf rule now binds this directory, so this module may import nothing at all -- not a helper, not a
 * type, not a Node builtin. That is not a stylistic preference here: a primitive whose failure type
 * depends on another module's failure type is not a primitive, it is a convenience wrapper wearing
 * one's name.
 *
 * THE API IS DELIBERATELY TINY. `Ok`, `Err`, `isOk`, `isErr`, `unwrapOr` and `map` cover what a
 * boundary needs; anything larger (chaining, async variants, applicative combinators) belongs to
 * whichever engine needs it, built out of these. A primitive that grows a combinator library becomes
 * the coupling it was meant to remove.
 */

/** A value or a reason. `ok` is the discriminant, so narrowing needs no cast. */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/** Wrap a success. The error type is `never` because this branch cannot carry one. */
export function Ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/** Wrap a failure. The value type is `never` because this branch cannot carry one. */
export function Err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is { readonly ok: true; readonly value: T } {
  return result.ok === true;
}

export function isErr<T, E>(result: Result<T, E>): result is { readonly ok: false; readonly error: E } {
  return result.ok === false;
}

/** The value, or the fallback when there is none. The failure reason is discarded here by design. */
export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

/** Transform a success and leave a failure untouched, including its type. */
export function map<T, U, E>(result: Result<T, E>, transform: (value: T) => U): Result<U, E> {
  return result.ok ? Ok(transform(result.value)) : result;
}
