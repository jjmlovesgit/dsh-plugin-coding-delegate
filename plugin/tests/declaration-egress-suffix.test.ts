import { describe, expect, it } from 'vitest';
import { evaluateDeclarationEgress } from '../src/declaration-egress';

/**
 * Two parser leniencies in declarations mode, both from SECURITY-REVIEW-6.
 *
 * [5] `endsWith('.d.ts')` allowed a COMMAND whose last characters happen to be `.d.ts`.
 * [6] A glob is expanded by the shell after the gate reads the string, so a per-file verdict is about a
 *     pattern rather than about the files that will actually be read.
 */

const base = {
  sourceReadEgress: 'declarations' as const,
  isCodeExtension: (p: string) => /\.(ts|js|cjs|mjs|py)$/i.test(p),
  declarationPathFor: () => null,
  commandReadsContent: (cmd: string) => /\b(cat|rg|grep|sed|head|tail)\b/.test(cmd),
  commandNamesSource: () => true,
  commandReadsDirectoryScope: () => false,
  commandScopeUnparseable: () => false,
  directoryScope: () => false,
  listSourceFiles: () => [],
  readDeclaration: () => ({ exists: false }),
  pathExists: () => true,
  workspaceRoot: '/ws',
  workspaceVerified: true,
};

describe('declaration file suffix [5]', () => {
  it('allows a declaration file that is actually one path', () => {
    expect(evaluateDeclarationEgress({ ...base, toolKind: 'read', target: 'src/foo.d.ts' })).toEqual({
      action: 'allow',
    });
  });

  it('does not allow a command that merely ends in .d.ts', () => {
    const verdict = evaluateDeclarationEgress({
      ...base,
      toolKind: 'shell',
      target: 'cat secret.ts; echo x.d.ts',
    });
    expect(verdict.action).not.toBe('allow');
  });

  it('does not allow a compound filename that merely contains the suffix', () => {
    const verdict = evaluateDeclarationEgress({ ...base, toolKind: 'read', target: 'src/foo.d.ts.js' });
    expect(verdict.action).not.toBe('allow');
  });

  it('does not allow a target that names more than one path', () => {
    // `src/foo.d.ts secret.ts` is not one path; the suffix rule must not see it as a declaration read.
    const verdict = evaluateDeclarationEgress({
      ...base,
      toolKind: 'read',
      target: 'src/foo.d.ts secret.ts',
    });
    expect(verdict.action).not.toBe('allow');
  });
});

describe('wildcard reads [6]', () => {
  it('refuses a glob in a command that reads content', () => {
    const verdict = evaluateDeclarationEgress({
      ...base,
      toolKind: 'shell',
      target: 'cat src/**/*.ts',
      commandHasWildcard: (cmd) => /[*?[\]{}]/.test(cmd),
    });
    expect(verdict.action).toBe('block');
    expect(String((verdict as { reason?: string }).reason)).toContain('REFUSED_WILDCARD_READ');
  });

  it('leaves an explicit file list alone', () => {
    const verdict = evaluateDeclarationEgress({
      ...base,
      toolKind: 'shell',
      target: 'cat src/a.ts src/b.ts',
      commandHasWildcard: (cmd) => /[*?[\]{}]/.test(cmd),
    });
    expect(verdict.action).not.toBe('block-with-wildcard');
    // The shell branch may still refuse for its own reasons; what matters is that the wildcard rule did
    // not fire on a command with no wildcard.
    if (verdict.action === 'block') {
      expect(String((verdict as { reason?: string }).reason)).not.toContain('REFUSED_WILDCARD_READ');
    }
  });
});
