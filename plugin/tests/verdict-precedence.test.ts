import { describe, expect, it } from 'vitest';
import { resolveDelegateStatus } from '../src/delegation';

/**
 * The verdict precedence, pinned as a truth table.
 *
 * WHY THIS EXISTS. `resolveDelegateStatus` is a six-clause cascade, and its order IS the semantic
 * contract: a boundary breach must outrank a test failure, and a flaky oracle must outrank a clean
 * single run. That order was documented in comments and correct in six clauses, and nothing stopped a
 * future edit from reordering it — every existing test asserts one combination at a time, so a swap
 * that still produced a plausible verdict would stay green.
 *
 * The table below is the lattice, written independently of the implementation:
 *
 *   boundary (contract mutations) > gate (nothing ran) > flaky (oracle disagrees with itself)
 *   > coherence (project check) > unverified (absence of evidence) > success
 *
 * All 64 combinations of the six inputs are checked, so a reordering fails here even if each
 * individually-asserted case still happens to pass.
 */

type Inputs = {
  violations: boolean;
  gate: boolean;
  flaky: boolean;
  coherenceFailed: boolean;
  unverified: boolean;
  isSuccess: boolean;
};

const status = (i: Inputs): string =>
  resolveDelegateStatus({
    verificationGate: i.gate ? 'denied by operator' : null,
    unverified: i.unverified,
    contractViolations: i.violations ? ['tests/x.contract.cjs was modified while the unit ran'] : [],
    isSuccess: i.isSuccess,
    coherenceFailed: i.coherenceFailed,
    flaky: i.flaky,
  });

/** The expected verdict, derived from the lattice rather than from the implementation. */
function expected(i: Inputs): string {
  if (i.violations) return 'CONTRACT_MODIFIED';
  if (i.gate) return 'VERIFICATION_NOT_APPROVED';
  if (i.flaky) return 'FLAKY';
  if (i.coherenceFailed) return i.isSuccess ? 'INCOHERENT' : 'VERIFICATION_FAILED';
  if (i.unverified) return 'UNVERIFIED';
  return i.isSuccess ? 'SUCCESS' : 'VERIFICATION_FAILED';
}

function allCombinations(): Inputs[] {
  const out: Inputs[] = [];
  for (const violations of [false, true]) {
    for (const gate of [false, true]) {
      for (const flaky of [false, true]) {
        for (const coherenceFailed of [false, true]) {
          for (const unverified of [false, true]) {
            for (const isSuccess of [false, true]) {
              out.push({ violations, gate, flaky, coherenceFailed, unverified, isSuccess });
            }
          }
        }
      }
    }
  }
  return out;
}

describe('verdict precedence', () => {
  it('resolves all 64 combinations according to the lattice', () => {
    const combinations = allCombinations();
    expect(combinations).toHaveLength(64);

    for (const combination of combinations) {
      expect(status(combination), JSON.stringify(combination)).toBe(expected(combination));
    }
  });

  it('lets a boundary breach outrank every other fault', () => {
    // The case that matters most: a unit that failed its tests AND mutated its contract must not be
    // reported as an ordinary verification failure, because the audit trail has to name the breach.
    const result = status({
      violations: true,
      gate: true,
      flaky: true,
      coherenceFailed: true,
      unverified: true,
      isSuccess: false,
    });
    expect(result).toBe('CONTRACT_MODIFIED');
  });

  it('does not call a unit flaky unless it eventually passed', () => {
    // Flakiness is a statement about an oracle that disagreed with itself. A unit that failed every
    // run is broken, not flaky, and the gate outranks it because nothing ran at all.
    expect(
      status({ violations: false, gate: false, flaky: true, coherenceFailed: true, unverified: false, isSuccess: true })
    ).toBe('FLAKY');
    expect(
      status({ violations: false, gate: true, flaky: true, coherenceFailed: false, unverified: false, isSuccess: true })
    ).toBe('VERIFICATION_NOT_APPROVED');
  });

  it('prefers positive evidence of breakage over the absence of evidence', () => {
    // coherenceFailed is evidence; unverified is its absence, so coherence wins even when both are set.
    expect(
      status({ violations: false, gate: false, flaky: false, coherenceFailed: true, unverified: true, isSuccess: true })
    ).toBe('INCOHERENT');
    expect(
      status({ violations: false, gate: false, flaky: false, coherenceFailed: true, unverified: true, isSuccess: false })
    ).toBe('VERIFICATION_FAILED');
  });

  it('reaches every verdict in the vocabulary, with none stranded', () => {
    const seen = new Set(allCombinations().map(status));
    expect([...seen].sort()).toEqual(
      ['CONTRACT_MODIFIED', 'FLAKY', 'INCOHERENT', 'SUCCESS', 'UNVERIFIED', 'VERIFICATION_FAILED', 'VERIFICATION_NOT_APPROVED'].sort()
    );
  });
});
