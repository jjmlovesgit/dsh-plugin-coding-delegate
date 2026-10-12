/**
 * RFC 8785 (JSON Canonicalization Scheme), zero dependencies.
 *
 * WHY THIS EXISTS. A signature is over BYTES, and two processes that agree on a document do not
 * automatically agree on its serialization: `JSON.stringify` preserves insertion order, so
 * `{a,b}` and `{b,a}` are the same object and different byte strings. Canonicalization is what
 * makes "sign this record" a well-defined instruction. JCS is the standard for it, and it is defined
 * by reference to ECMAScript rather than by a grammar of its own, which is why a V8 host can
 * implement it exactly rather than approximately.
 *
 * WHAT IT DELEGATES, AND WHY THAT IS CORRECT RATHER THAN LAZY. Strings and numbers are serialized by
 * `JSON.stringify` and `String()` respectively, because RFC 8785 defines them *as* the ECMAScript
 * algorithms (Sections 3.2.2.2 and 3.2.2.3) rather than restating them. Hand-writing ES6's
 * shortest-round-trip number formatter would be a large amount of code whose only useful property
 * would be that it agrees with the engine it is already running on.
 *
 * TWO PLACES IT IS STRICTER THAN `JSON.stringify`, both required by the RFC:
 *
 *   - NaN and Infinity are not JSON, and Section 3.2.2.3 requires a compliant implementation to
 *     terminate rather than serialize. `JSON.stringify` quietly emits `null` for both, which would
 *     sign a value the caller never supplied.
 *   - Lone surrogates are not Unicode, and Section 3.2.2.2 requires an error. `JSON.stringify` has
 *     escaped them since ES2019, so a document carrying one would be signed as if it were
 *     well-formed text.
 *
 * THE LIMIT. This canonicalizes values that are representable in JSON. `undefined`, functions and
 * symbols are OMITTED from object properties, matching `JSON.stringify`, because every registry
 * record has optional fields and making callers strip them first would be a footgun. In an ARRAY
 * they THROW instead: `JSON.stringify([undefined])` is `[null]`, which silently changes both the
 * element and the length, and a value that cannot be represented is a caller error rather than
 * something to paper over.
 */
/**
 * Canonical JSON for `value`, per RFC 8785.
 *
 * The result is a UTF-8-encodable string with no insignificant whitespace, properties sorted by
 * UTF-16 code unit, and no lone surrogates. Throws when the input is not representable in I-JSON,
 * which is the fail-closed direction for something about to be signed.
 */
export declare function canonicalizeJson(value: unknown): string;
