import { describe, expect, it } from 'vitest';
import { evaluateShellCommandApproval } from '../src/guard';

/**
 * F4, inverted: read-only is an allowlist, not a scan for mutation.
 *
 * Every command that cannot be proven read-only asks the operator, because the worker's only authorised
 * write path is emission — where `isTestPath` and containment run — and a shell mutation bypasses both.
 */

describe('evaluateShellCommandApproval', () => {
  it('permits provably read-only commands', () => {
    for (const command of [
      'git status',
      'git diff HEAD',
      'git log -n 5',
      'cat src/index.ts',
      'rg "function foo" src/',
      'ls -la',
    ]) {
      const result = evaluateShellCommandApproval(command);
      expect(result.allowed, command).toBe(true);
      expect(result.requiresApproval, command).toBe(false);
    }
  });

  it('routes opaque mutations to approval', () => {
    for (const command of [
      'patch -p1 < changes.patch',
      'git apply fix.patch',
      'sed -i "s/foo/bar/g" src/core.ts',
      'tee output.txt',
      'python -c "open(\'test.txt\', \'w\').write(\'bad\')"',
      'npm test',
      'cargo build',
    ]) {
      const result = evaluateShellCommandApproval(command);
      expect(result.allowed, command).toBe(false);
      expect(result.requiresApproval, command).toBe(true);
      expect(result.reason, command).toContain('APPROVAL_REQUIRED_SHELL_MUTATION');
    }
  });

  it('intercepts redirection smuggled onto an allowed command', () => {
    for (const command of ['cat file.txt > target.ts', 'git diff >> changes.patch', 'git log > history.txt']) {
      const result = evaluateShellCommandApproval(command);
      expect(result.allowed, command).toBe(false);
      expect(result.requiresApproval, command).toBe(true);
      expect(result.reason, command).toContain('redirection');
    }
  });

  it('does not treat a longer word as a prefix match', () => {
    // `catalogue` must not match `cat`; the separator is part of the rule.
    expect(evaluateShellCommandApproval('catalogue list').requiresApproval).toBe(true);
  });
});
