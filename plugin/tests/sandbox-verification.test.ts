import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runSandboxVerification } from '../src/verification';

/**
 * The verification sandbox, asserted from the outside: what an operator's command does when it is
 * submitted, not how the flag is assembled.
 *
 * The refusal case is the one that matters. A fallback to unsandboxed execution would make every
 * attestation citing the run misleading, so the test asserts a hard failure and the remediation text an
 * operator needs to fix the command without reading source.
 */

function workspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-verify-'));
}

function write(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

describe('verification sandbox', () => {
  it("refuses 'node --test' with a hard error and a remediation", () => {
    const dir = workspace();
    const result = runSandboxVerification('node --test tests/contracts/foo.contract.cjs', dir);

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('REFUSED_UNSANDBOXED_RUNNER');
    expect(result.output).toContain('new: node tests/contracts/foo.contract.cjs');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('runs a direct contract and reports its exit code', () => {
    const dir = workspace();
    write(
      dir,
      'pass.cjs',
      "const assert = require('node:assert/strict');\nassert.equal(1 + 1, 2);\nconsole.log('ok');\n"
    );
    const pass = runSandboxVerification('node pass.cjs', dir);
    expect(pass.exitCode).toBe(0);

    write(dir, 'fail.cjs', "const assert = require('node:assert/strict');\nassert.equal(1, 2);\n");
    const fail = runSandboxVerification('node fail.cjs', dir);
    expect(fail.exitCode).not.toBe(0);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('blocks child_process from inside the sandbox', () => {
    const dir = workspace();
    write(
      dir,
      'child.cjs',
      "try { require('node:child_process').execSync('whoami'); process.exit(0); } catch (e) { process.exit(2); }\n"
    );
    const result = runSandboxVerification('node child.cjs', dir);
    expect(result.exitCode).not.toBe(0);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('blocks network access from inside the sandbox', () => {
    const dir = workspace();
    write(
      dir,
      'net.cjs',
      "fetch('http://127.0.0.1:1234/v1/models').then(() => process.exit(0)).catch(() => process.exit(2));\n"
    );
    const result = runSandboxVerification('node net.cjs', dir);
    expect(result.exitCode).not.toBe(0);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
