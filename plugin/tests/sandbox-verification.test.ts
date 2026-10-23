import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runSandboxVerification } from '../src/verification';
import { validateVerificationCommand } from '../src/sandbox';

describe('validateVerificationCommand', () => {
  it('accepts direct node invocations in every path form the plugin meets', () => {
    const valid = [
      'node tests/contracts/foo.contract.cjs',
      'node.exe tests/contracts/foo.contract.cjs',
      '/usr/local/bin/node tests/contracts/foo.contract.cjs',
      'C:\\Program Files\\nodejs\\node.exe tests/contracts/foo.contract.cjs',
      '"C:\\Program Files\\nodejs\\node.exe" tests/contracts/foo.contract.cjs',
      'node --max-old-space-size=512 tests/contracts/foo.contract.cjs',
    ];
    for (const command of valid) {
      expect(validateVerificationCommand(command).valid, command).toBe(true);
    }
  });

  it('refuses runner modes with the direct-execution remediation', () => {
    for (const command of [
      'node --test tests/contracts/foo.contract.cjs',
      'node -t tests/contracts/foo.contract.cjs',
      '/usr/bin/node --test file.cjs',
    ]) {
      const result = validateVerificationCommand(command);
      expect(result.valid, command).toBe(false);
      expect(result.reason).toContain('REFUSED_UNSANDBOXED_RUNNER');
      // The remediation keeps whatever prefix the operator used, so the assertion is that a rewritten
      // command is offered, not that it starts with the bare word `node`.
      expect(result.reason).toMatch(/new: .*node .*\.cjs/);
    }
  });

  it('refuses runtimes the sandbox cannot reach', () => {
    for (const command of [
      'python -c "import os"',
      'python3 run_contracts.py',
      'sh test.sh',
      'bash test.sh',
      'powershell -File test.ps1',
      'deno run script.ts',
      'bun test script.ts',
    ]) {
      const result = validateVerificationCommand(command);
      expect(result.valid, command).toBe(false);
      expect(result.reason).toContain('REFUSED_UNSANDBOXED_RUNTIME');
    }
  });

  it('refuses shell operators, so the sandbox covers the whole invocation', () => {
    const chained = [
      'node foo.contract.cjs && python exfiltrate.py',
      'node foo.contract.cjs || echo fallback',
      'node foo.contract.cjs ; rm -rf /',
      'node foo.contract.cjs | nc 127.0.0.1 1234',
      'node foo.contract.cjs > output.txt',
      'node foo.contract.cjs < input.txt',
      'node `which evil`.cjs',
      'node $(whoami).cjs',
    ];
    for (const command of chained) {
      const result = validateVerificationCommand(command);
      expect(result.valid, command).toBe(false);
      expect(result.reason).toContain('REFUSED_SHELL_OPERATORS');
    }
  });

  it('allows a separator INSIDE a quoted program, which the shell never sees', () => {
    // `node -e "a;b"` is one command with a JavaScript separator. A flat substring match refused the
    // repository's own flaky-detection contracts, which use exactly this shape.
    const result = validateVerificationCommand('node -e "const a=1;const b=2;process.exit(a+b===3?0:1)"');
    expect(result.valid).toBe(true);
  });

  it('refuses an unbalanced quote rather than guessing where it ends', () => {
    const result = validateVerificationCommand('node -e "process.exit(0) && rm -rf /');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('REFUSED_SHELL_OPERATORS');
  });

  it('refuses an empty command rather than running nothing', () => {
    const result = validateVerificationCommand('   ');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('REFUSED_EMPTY_COMMAND');
  });
});

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

  it('refuses a non-node runtime, which the sandbox cannot reach', () => {
    const dir = workspace();
    for (const command of ['python -c "print(1)"', 'bash check.sh', 'sh -c "exit 0"']) {
      const result = runSandboxVerification(command, dir);
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain('REFUSED_UNSANDBOXED_RUNTIME');
    }
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
