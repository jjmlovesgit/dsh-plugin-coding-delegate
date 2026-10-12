import { describe, expect, it } from 'vitest'
import { canonicalizeJson } from '../src/canonical-json'
import {
  ATTESTATION_PAYLOAD_TYPE,
  AttestationPayload,
  generateWorkerKeyPair,
  hashBuffer,
  signManifest,
  verifyEnvelope,
} from '../src/crypto-attestation'

/**
 * RFC 8785 conformance, using the specification's own test data.
 *
 * Every vector below is copied from the RFC rather than invented, because a canonicalizer tested
 * only against its own output is a canonicalizer that agrees with itself. The number table is the
 * interesting half: it is where "just use JSON.stringify" would look correct and be wrong at the
 * edges, and where a hand-rolled serializer would part company with the engine by a digit.
 */

// ---------------------------------------------------------------------------
// RFC 8785 Section 3.2.2 (input) and Section 3.2.4 (expected UTF-8, given as hex)
// ---------------------------------------------------------------------------

const RFC_8785_SAMPLE = {
  numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 1e-27],
  string: '\u20ac$\u000f\nA\'B"\\\\"/',
  literals: [null, true, false],
}

// The RFC prints this as six hex-dump lines; spaces removed, order preserved. Keeping it as the
// byte sequence rather than a transcribed string means a typo shows up as a mismatch instead of as
// an escaped-literal that happens to compile.
const RFC_8785_SECTION_3_2_4_UTF8_HEX =
  '7b226c69746572616c73223a5b6e756c6c2c747275652c66616c73655d2c226e756d62657273223a' +
  '5b3333333333333333332e333333333333332c31' +
  '652b33302c342e352c302e3030322c31652d3237' +
  '5d2c22737472696e67223a22e282ac245c753030' +
  '30665c6e4127425c225c5c5c5c5c222f227d'

describe('RFC 8785 canonicalization', () => {
  it('reproduces the Section 3.2.4 canonical form byte for byte', () => {
    const expected = Buffer.from(RFC_8785_SECTION_3_2_4_UTF8_HEX, 'hex').toString('utf8')
    expect(canonicalizeJson(RFC_8785_SAMPLE)).toBe(expected)
  })

  it('sorts object properties by UTF-16 code unit, per Section 3.2.3', () => {
    const sample = {
      '\u20ac': 'Euro Sign',
      '\r': 'Carriage Return',
      '\ufb33': 'Hebrew Letter Dalet With Dagesh',
      '1': 'One',
      '\ud83d\ude00': 'Emoji: Grinning Face',
      '\u0080': 'Control',
      '\u00f6': 'Latin Small Letter O With Diaeresis',
    }
    const expectedOrder = [
      'Carriage Return', // U+000D
      'One', // U+0031
      'Control', // U+0080
      'Latin Small Letter O With Diaeresis', // U+00F6
      'Euro Sign', // U+20AC
      'Emoji: Grinning Face', // U+D83D, the high half of the surrogate pair
      'Hebrew Letter Dalet With Dagesh', // U+FB33
    ]

    const canonical = canonicalizeJson(sample)
    const positions = expectedOrder.map((value) => canonical.indexOf(value))
    expect(positions.every((at) => at >= 0)).toBe(true)
    // The order the values appear in IS the order the keys sorted to.
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })

  it('is independent of property insertion order', () => {
    const a = { z: 1, a: 2, m: { nestedB: true, nestedA: 'val' } }
    const b = { a: 2, m: { nestedA: 'val', nestedB: true }, z: 1 }
    expect(canonicalizeJson(a)).toBe(canonicalizeJson(b))
    expect(canonicalizeJson(a)).toBe('{"a":2,"m":{"nestedA":"val","nestedB":true},"z":1}')
  })

  it('preserves array order while canonicalizing objects inside it', () => {
    expect(canonicalizeJson([{ b: 1, a: 2 }, 'x', null])).toBe('[{"a":2,"b":1},"x",null]')
  })

  it('emits no insignificant whitespace', () => {
    expect(canonicalizeJson({ a: [1, 2], b: 'c' })).toBe('{"a":[1,2],"b":"c"}')
  })
})

// ---------------------------------------------------------------------------
// RFC 8785 Appendix B: ECMAScript-compatible number serialization
// ---------------------------------------------------------------------------

const IEEE754_VECTORS: Array<[hex: string, json: string, comment: string]> = [
  ['0000000000000000', '0', 'zero'],
  ['8000000000000000', '0', 'minus zero collapses to zero'],
  ['0000000000000001', '5e-324', 'minimum positive subnormal'],
  ['8000000000000001', '-5e-324', 'minimum negative subnormal'],
  ['7fefffffffffffff', '1.7976931348623157e+308', 'maximum positive'],
  ['ffefffffffffffff', '-1.7976931348623157e+308', 'maximum negative'],
  ['4340000000000000', '9007199254740992', 'maximum positive integer'],
  ['c340000000000000', '-9007199254740992', 'maximum negative integer'],
  ['4430000000000000', '295147905179352830000', 'approximately 2**68'],
  ['44b52d02c7e14af5', '9.999999999999997e+22', ''],
  ['44b52d02c7e14af6', '1e+23', ''],
  ['44b52d02c7e14af7', '1.0000000000000001e+23', ''],
  ['444b1ae4d6e2ef4e', '999999999999999700000', ''],
  ['444b1ae4d6e2ef4f', '999999999999999900000', ''],
  ['444b1ae4d6e2ef50', '1e+21', ''],
  ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7', ''],
  ['3eb0c6f7a0b5ed8d', '0.000001', ''],
  ['41b3de4355555553', '333333333.3333332', ''],
  ['41b3de4355555554', '333333333.33333325', ''],
  ['41b3de4355555555', '333333333.3333333', ''],
  ['41b3de4355555556', '333333333.3333334', ''],
  ['41b3de4355555557', '333333333.33333343', ''],
  ['becbf647612f3696', '-0.0000033333333333333333', ''],
  ['43143ff3c1cb0959', '1424953923781206.2', 'rounded to the closest even value'],
]

describe('RFC 8785 Appendix B number vectors', () => {
  for (const [hex, json, comment] of IEEE754_VECTORS) {
    it(`${hex} serializes as ${json}${comment ? ' (' + comment + ')' : ''}`, () => {
      // Built from the IEEE 754 bit pattern so the input is the exact double the RFC names, rather
      // than a decimal literal that a reader has to trust was parsed correctly.
      const value = Buffer.from(hex, 'hex').readDoubleBE(0)
      expect(canonicalizeJson(value)).toBe(json)
    })
  }
})

// ---------------------------------------------------------------------------
// The two places the RFC requires an error where JSON.stringify would not give one
// ---------------------------------------------------------------------------

describe('RFC 8785 requires an error where JSON.stringify would coerce', () => {
  it('refuses NaN and Infinity rather than emitting null', () => {
    expect(() => canonicalizeJson(NaN)).toThrow(/not representable in JSON/)
    expect(() => canonicalizeJson(Infinity)).toThrow(/not representable in JSON/)
    expect(() => canonicalizeJson(-Infinity)).toThrow(/not representable in JSON/)
    expect(() => canonicalizeJson({ nested: [1, NaN] })).toThrow(/not representable in JSON/)
    // What the coercion would have produced, and why it is refused: `null` is a value the caller
    // never supplied, signed as if they had.
    expect(JSON.stringify(NaN)).toBe('null')
  })

  it('refuses lone surrogates rather than escaping them', () => {
    expect(() => canonicalizeJson('\ud800')).toThrow(/Lone high surrogate/)
    expect(() => canonicalizeJson('\udfff')).toThrow(/Lone low surrogate/)
    expect(() => canonicalizeJson({ k: 'a\ud800b' })).toThrow(/Lone high surrogate/)
    // JSON.stringify escapes them since ES2019, which is exactly why the check has to exist here.
    expect(JSON.stringify('\ud800')).toBe('"\\ud800"')
  })

  it('accepts a well-formed surrogate pair', () => {
    expect(canonicalizeJson('\ud83d\ude00')).toBe('"\ud83d\ude00"')
  })

  it('refuses an undefined array element rather than silently shortening the array', () => {
    expect(() => canonicalizeJson([undefined])).toThrow(/no JSON representation/)
    // The coercion it is refusing: the element disappears and the array changes length.
    expect(JSON.stringify([undefined])).toBe('[null]')
  })

  it('omits undefined object properties, matching JSON.stringify, so optional fields are fine', () => {
    expect(canonicalizeJson({ a: 1, b: undefined, c: 2 })).toBe('{"a":1,"c":2}')
    expect(canonicalizeJson({ a: 1, b: undefined, c: 2 })).toBe(JSON.stringify({ a: 1, c: 2 }))
  })

  it('refuses a BigInt with the Appendix D advice rather than inventing a token', () => {
    expect(() => canonicalizeJson({ n: BigInt(1) })).toThrow(/BigInt/)
  })
})

// ---------------------------------------------------------------------------
// Ed25519 attestation
// ---------------------------------------------------------------------------

function samplePayload(overrides: Partial<AttestationPayload> = {}): AttestationPayload {
  return {
    specVersion: '1.0',
    runId: 'run-test-001',
    contractHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    baseCommit: '166ff33dfb601b0a60cc40c798c42b9c986285dc',
    modelIdentifier: 'Qwen 3.8 27B Local',
    artifacts: [{ path: 'plugin/dist/index.js', sha256: 'abc123' }],
    verification: { command: 'npm test', exitCode: 0, stdoutHash: 'def456', passed: true },
    ...overrides,
  }
}

describe('Ed25519 delegation attestation', () => {
  it('signs and verifies a canonicalized payload', () => {
    const keys = generateWorkerKeyPair()
    const envelope = signManifest(samplePayload(), keys.privateKeyPem, keys.publicKeyPem)
    expect(verifyEnvelope(envelope)).toBe(true)
    expect(envelope.payload).toBe(canonicalizeJson(samplePayload()))
    expect(Buffer.from(envelope.signature, 'base64')).toHaveLength(64)
  })

  it('detects a tampered payload', () => {
    const keys = generateWorkerKeyPair()
    const envelope = signManifest(samplePayload(), keys.privateKeyPem, keys.publicKeyPem)
    const forged = { ...envelope, payload: envelope.payload.replace('run-test-001', 'run-test-002') }
    expect(forged.payload).not.toBe(envelope.payload)
    expect(verifyEnvelope(forged)).toBe(false)
  })

  it('rejects a signature made by a different key', () => {
    const signer = generateWorkerKeyPair()
    const other = generateWorkerKeyPair()
    const envelope = signManifest(samplePayload(), signer.privateKeyPem, signer.publicKeyPem)
    expect(verifyEnvelope(envelope)).toBe(true)
    expect(verifyEnvelope({ ...envelope, publicKeyPem: other.publicKeyPem })).toBe(false)
  })

  it('returns false rather than throwing on a malformed key or signature', () => {
    const keys = generateWorkerKeyPair()
    const envelope = signManifest(samplePayload(), keys.privateKeyPem, keys.publicKeyPem)
    expect(verifyEnvelope({ ...envelope, publicKeyPem: 'not a pem' })).toBe(false)
    expect(verifyEnvelope({ ...envelope, signature: 'not base64 !!' })).toBe(false)
    expect(verifyEnvelope({ ...envelope, signature: '' })).toBe(false)
  })

  it('is deterministic: the same payload signs to the same bytes', () => {
    // Ed25519 is a deterministic scheme, so this pins that a verifier does not need the signature
    // to be recomputed -- and that nothing in the path adds a timestamp or a nonce.
    const keys = generateWorkerKeyPair()
    const a = signManifest(samplePayload(), keys.privateKeyPem, keys.publicKeyPem)
    const b = signManifest(samplePayload(), keys.privateKeyPem, keys.publicKeyPem)
    expect(a.signature).toBe(b.signature)
    expect(a.payload).toBe(b.payload)
  })

  it('does not label the payload with the in-toto media type', () => {
    // Deliberate: in-toto defines a Statement structure this payload does not have, so claiming its
    // media type would send a dispatching consumer looking for fields that are not there.
    const keys = generateWorkerKeyPair()
    const envelope = signManifest(samplePayload(), keys.privateKeyPem, keys.publicKeyPem)
    expect(envelope.payloadType).toBe(ATTESTATION_PAYLOAD_TYPE)
    expect(envelope.payloadType).not.toContain('in-toto')
  })

  it('hashes with the same lowercase-hex sha256 the registry already uses', () => {
    expect(hashBuffer('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    )
  })
})
