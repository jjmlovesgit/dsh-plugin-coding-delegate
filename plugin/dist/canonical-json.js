"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.canonicalizeJson = canonicalizeJson;
/**
 * Canonical JSON for `value`, per RFC 8785.
 *
 * The result is a UTF-8-encodable string with no insignificant whitespace, properties sorted by
 * UTF-16 code unit, and no lone surrogates. Throws when the input is not representable in I-JSON,
 * which is the fail-closed direction for something about to be signed.
 */
function canonicalizeJson(value) {
    const out = [];
    write(value, out);
    return out.join('');
}
function write(value, out) {
    if (value === null) {
        out.push('null');
        return;
    }
    switch (typeof value) {
        case 'boolean':
            out.push(value ? 'true' : 'false');
            return;
        case 'number':
            out.push(writeNumber(value));
            return;
        case 'string':
            out.push(quote(value));
            return;
        case 'object':
            if (Array.isArray(value)) {
                writeArray(value, out);
                return;
            }
            writeObject(value, out);
            return;
        case 'bigint':
            // RFC 8785 Appendix D: a number outside IEEE 754 double precision is carried as a JSON
            // STRING. Accepting a BigInt here would produce a bare integer token that no JSON parser
            // round-trips to the same value.
            throw new Error('BigInt is not representable as a JSON number; RFC 8785 Appendix D recommends a string');
        default:
            // undefined, function, symbol. Object properties are filtered before they reach here, so this
            // is an array element or a top-level call.
            throw new Error(String(typeof value) + ' has no JSON representation');
    }
}
/**
 * RFC 8785 Section 3.2.2.3. `String()` on a number IS ECMAScript's Number::toString, which is the
 * algorithm the RFC names, so the shortest-round-trip formatting is the engine's rather than ours.
 * The finiteness check is the part the RFC adds: NaN and Infinity MUST terminate.
 */
function writeNumber(value) {
    if (!Number.isFinite(value)) {
        throw new Error(String(value) +
            ' is not representable in JSON; RFC 8785 Section 3.2.2.3 requires an error rather than a value');
    }
    // Note that this maps -0 to "0", which is what Section 3.2.2.3 and Appendix B both specify.
    return String(value);
}
/**
 * RFC 8785 Section 3.2.3. Property names sort as arrays of UTF-16 code units compared as unsigned
 * integers, independent of locale. JavaScript's `<` on strings is exactly that comparison, and
 * `Array.prototype.sort`'s default comparator uses it -- naming it here means the rule is stated
 * rather than inherited from a default that a future reader would have to know.
 */
function compareCodeUnits(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}
function writeObject(value, out) {
    const keys = Object.keys(value).sort(compareCodeUnits);
    out.push('{');
    let first = true;
    for (const key of keys) {
        const member = value[key];
        // Matching `JSON.stringify`: a property whose value is absent is not serialized at all. This is
        // the ordinary case here rather than an edge -- the registry records carry optional fields.
        if (member === undefined || typeof member === 'function' || typeof member === 'symbol')
            continue;
        if (!first)
            out.push(',');
        first = false;
        out.push(quote(key), ':');
        write(member, out);
    }
    out.push('}');
}
/** RFC 8785 Section 3.2.3: array order is preserved, but objects inside it are still canonicalized. */
function writeArray(value, out) {
    out.push('[');
    for (let i = 0; i < value.length; i++) {
        if (i > 0)
            out.push(',');
        const element = value[i];
        if (element === undefined || typeof element === 'function' || typeof element === 'symbol') {
            throw new Error('Array element ' + i + ' is ' + String(typeof element) + ', which has no JSON representation. ' +
                'JSON.stringify would emit null here, silently changing the element and the array length; ' +
                'RFC 8785 operates on I-JSON, where this cannot occur.');
        }
        write(element, out);
    }
    out.push(']');
}
/**
 * RFC 8785 Section 3.2.2.2. `JSON.stringify` IS the ECMAScript algorithm the RFC specifies --
 * lowercase `\uhhhh` for the remaining control characters and the five shorthand escapes
 * `\b \t \n \f \r` -- so the escaping is delegated rather than restated. The surrogate check is
 * added because ES2019 changed `JSON.stringify` to escape lone surrogates instead of failing, and
 * the RFC requires a failure.
 */
function quote(value) {
    assertNoLoneSurrogate(value);
    const quoted = JSON.stringify(value);
    if (typeof quoted !== 'string') {
        // Unreachable for a string input. Present because the lib signature is `string | undefined`,
        // and a silent `undefined` concatenated into a signed payload is exactly the class of bug this
        // repository keeps finding.
        throw new Error('JSON.stringify returned no string for a string input');
    }
    return quoted;
}
function assertNoLoneSurrogate(value) {
    for (let i = 0; i < value.length; i++) {
        const unit = value.charCodeAt(i);
        if (unit >= 0xd800 && unit <= 0xdbff) {
            const next = i + 1 < value.length ? value.charCodeAt(i + 1) : -1;
            if (next < 0xdc00 || next > 0xdfff) {
                throw new Error('Lone high surrogate at index ' + i + ': RFC 8785 Section 3.2.2.2 requires an error rather than an escape');
            }
            i++;
        }
        else if (unit >= 0xdc00 && unit <= 0xdfff) {
            throw new Error('Lone low surrogate at index ' + i + ': RFC 8785 Section 3.2.2.2 requires an error rather than an escape');
        }
    }
}
