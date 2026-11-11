import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { extractAndEmitFiles } from '../src/emission';
import { evaluateProtectedWrite } from '../src/write-policy';

/**
 * Blast-radius fence: the worker may not write the machinery that judges or signs it.
 *
 * `targetFiles` already bounds a unit to what it declared, but the declaration is the architect's. A
 * delegation that names `.github/workflows/ci.yml` would pass that check and still be a confused deputy
 * editing its own gate. These paths are refused independently of any declaration.
 */

const workspace = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'write-policy-'));

describe('evaluateProtectedWrite', () => {
  it('refuses the control surface', () => {
    const dir = workspace();
    for (const relative of [
      '.github/workflows/ci.yml',
      'keys/delegation-operator.pem',
      'scripts/git-hooks/pre-commit',
      'scripts/attest-unit.cjs',
      'scripts/policy-config.cjs',
      'plugin/src/sandbox.ts',
      'plugin/package.json',
      'eslint.config.mjs',
    ]) {
      const refusal = evaluateProtectedWrite(path.join(dir, relative), dir);
      expect(refusal, relative).toContain('REFUSED_PROTECTED_PATH');
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('allows ordinary source, and does not judge paths outside the workspace', () => {
    const dir = workspace();
    expect(evaluateProtectedWrite(path.join(dir, 'src/feature.ts'), dir)).toBeNull();
    expect(evaluateProtectedWrite(path.join(dir, 'docs/notes.md'), dir)).toBeNull();
    // Containment owns the outside-the-workspace answer; claiming "not protected" there would be true
    // and useless, so the fence abstains.
    expect(evaluateProtectedWrite('C:/elsewhere/secrets.txt', dir)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses the path through the emission pipeline, not only the predicate', () => {
    const dir = workspace();
    const transcript =
      '```yaml file=".github/workflows/ci.yml"\non: push\n```\n\n' +
      '```typescript file="src/allowed.ts"\nexport const ok = 1\n```';

    const result = extractAndEmitFiles(transcript, ['src/allowed.ts'], dir);
    const names = result.filesWritten.map((f: any) => String(f.relativeName).replace(/\\/g, '/'));

    expect(names).toContain('src/allowed.ts');
    expect(names).not.toContain('.github/workflows/ci.yml');
    expect(fs.existsSync(path.join(dir, '.github', 'workflows', 'ci.yml'))).toBe(false);
    expect(result.errors.join(' ')).toContain('REFUSED_PROTECTED_PATH');

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
