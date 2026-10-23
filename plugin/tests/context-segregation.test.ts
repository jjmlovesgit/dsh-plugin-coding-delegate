import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { delegateWorker, validateDelegationContext } from '../src/delegation';

/**
 * Contract/context segregation.
 *
 * The rule is one sentence — the worker may not be shown the tests that judge it — and the interesting
 * part is the comparison: two spellings of one path must collide, or the rule is a string check that a
 * `./` defeats.
 */

const workspace = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'segregation-'));

describe('validateDelegationContext', () => {
  it('refuses the same path in both lists', () => {
    const dir = workspace();
    const message = validateDelegationContext(dir, ['tests/foo.contract.cjs'], ['tests/foo.contract.cjs']);
    expect(message).toContain('REFUSED_CONTRACT_AS_CONTEXT');
    expect(message).toContain('tests/foo.contract.cjs');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('sees through a relative spelling of the same path', () => {
    const dir = workspace();
    expect(validateDelegationContext(dir, ['tests/foo.contract.cjs'], ['./tests/foo.contract.cjs'])).toContain(
      'REFUSED_CONTRACT_AS_CONTEXT'
    );
    expect(validateDelegationContext(dir, ['./tests/foo.contract.cjs'], ['tests/foo.contract.cjs'])).toContain(
      'REFUSED_CONTRACT_AS_CONTEXT'
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not depend on case on Windows', () => {
    const dir = workspace();
    const message = validateDelegationContext(dir, ['tests/foo.contract.cjs'], ['TESTS/FOO.CONTRACT.CJS']);
    if (process.platform === 'win32') {
      expect(message).toContain('REFUSED_CONTRACT_AS_CONTEXT');
    } else {
      // On a case-sensitive filesystem those are two different files, and refusing would be wrong.
      expect(message).toBeNull();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('accepts disjoint lists, including objects that carry a path', () => {
    const dir = workspace();
    expect(
      validateDelegationContext(dir, ['tests/foo.contract.cjs'], ['src/foo.ts', { path: 'src/types.ts', reason: 'iface' }])
    ).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('accepts an empty contract list, which is the common case', () => {
    const dir = workspace();
    expect(validateDelegationContext(dir, [], ['src/foo.ts'])).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('ignores an absolute path that only shares a suffix with the contract', () => {
    const dir = workspace();
    // `other/tests/foo.contract.cjs` is a different file; a suffix check would refuse it wrongly.
    const other = path.join(os.tmpdir(), 'elsewhere', 'tests', 'foo.contract.cjs');
    expect(validateDelegationContext(dir, ['tests/foo.contract.cjs'], [other])).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('delegateWorker refuses a contract/context collision', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns CONTEXT_REFUSED without calling the worker', async () => {
    const dir = workspace();
    let workerCalled = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        workerCalled = true;
        throw new Error('the worker must not be called');
      })
    );

    const result = await delegateWorker({
      taskName: 'collision',
      instruction: 'implement it',
      workspaceDir: dir,
      contractFiles: ['tests/foo.contract.cjs'],
      contextFiles: ['./tests/foo.contract.cjs'],
    });

    expect(result.status).toBe('CONTEXT_REFUSED');
    expect(result.success).toBe(false);
    expect(result.message).toContain('REFUSED_CONTRACT_AS_CONTEXT');
    // The point of refusing rather than filtering: the worker never sees a narrowed task.
    expect(workerCalled).toBe(false);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
