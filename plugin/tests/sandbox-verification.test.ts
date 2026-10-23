import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runSandboxVerification } from '../src/verification';
import { resolveVerificationInvocation, tokenizeCommand } from '../src/sandbox';

/**
 * The verification gate, tested at both levels: the parser that decides what will run, and the sandbox
 * that actually runs it.
 */

describe('tokenizeCommand', () => {
  it('parses unquoted arguments', () => {
    expect(tokenizeCommand('node script.cjs foo bar').tokens).toEqual(['node', 'script.cjs', 'foo', 'bar']);
  });

  it('preserves spaces AND backslashes in a quoted Windows path', () => {
    // The default install path on this platform. A tokenizer that treats backslash as a general escape
    // returns 'C:Program Filesnodejsnode.exe', and every verification on Windows fails to start.
    const { tokens } = tokenizeCommand('"C:\\Program Files\\nodejs\\node.exe" -e "const x = 1; process.exit(0)"');
    expect(tokens).toEqual(['C:\\Program Files\\nodejs\\node.exe', '-e', 'const x = 1; process.exit(0)']);
  });

  it('preserves spaces within single quotes', () => {
    expect(tokenizeCommand("node -e 'const a = [1, 2];' arg2").tokens).toEqual([
      'node',
      '-e',
      'const a = [1, 2];',
      'arg2',
    ]);
  });

  it('handles escaped quotes', () => {
    expect(tokenizeCommand('node -e "console.log(\\"hello\\")"').tokens).toEqual(['node', '-e', 'console.log("hello")']);
  });

  it('fails closed on unbalanced quotes', () => {
    for (const command of ['node -e "console.log(1)', "node -e 'console.log(1)"]) {
      const result = tokenizeCommand(command);
      expect(result.tokens).toEqual([]);
      expect(result.error).toContain('REFUSED_UNBALANCED_QUOTES');
    }
  });
});

describe('resolveVerificationInvocation', () => {
  it('accepts direct node scripts with flag prefixes', () => {
    const result = resolveVerificationInvocation('node --max-old-space-size=512 contract.cjs');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.binary).toBe('node');
      expect(result.args).toEqual(['--max-old-space-size=512', 'contract.cjs']);
    }
  });

  it('rejects node --test regardless of position', () => {
    for (const command of ['node --test foo.cjs', 'node -t foo.cjs', 'node --max-old-space-size=512 --test foo.cjs']) {
      const result = resolveVerificationInvocation(command);
      expect(result.valid, command).toBe(false);
      if (!result.valid) expect(result.reason).toContain('REFUSED_UNSANDBOXED_RUNNER');
    }
  });

  it('rejects shell operators as distinct tokens', () => {
    const commands = [
      'node foo.cjs && python evil.py',
      'node foo.cjs || exit 1',
      'node foo.cjs ; rm -rf /',
      'node foo.cjs | cat',
      'node foo.cjs > output.txt',
    ];
    for (const command of commands) {
      const result = resolveVerificationInvocation(command);
      expect(result.valid, command).toBe(false);
      if (!result.valid) expect(result.reason).toContain('REFUSED_SHELL_OPERATORS');
    }
  });

  it('permits semicolons inside quoted evaluation strings', () => {
    expect(
      resolveVerificationInvocation('node -e "const a = 1; const b = 2; process.exit(a - b + 1);"').valid
    ).toBe(true);
  });

  it('rejects non-node runtimes', () => {
    const result = resolveVerificationInvocation('python test.py');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toContain('REFUSED_UNSANDBOXED_RUNTIME');
  });

  it('rejects an empty command and a bare node', () => {
    for (const command of ['   ', 'node']) {
      const result = resolveVerificationInvocation(command);
      expect(result.valid, command).toBe(false);
      if (!result.valid) expect(result.reason).toContain('REFUSED_EMPTY_COMMAND');
    }
  });
});

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

  it('passes arguments through without a shell to re-quote them', () => {
    const dir = workspace();
    write(
      dir,
      'argv.cjs',
      "const assert = require('node:assert/strict');\n" +
        "assert.deepEqual(process.argv.slice(2), ['a b', 'c;d', 'e&f']);\n"
    );
    const result = runSandboxVerification('node argv.cjs "a b" "c;d" "e&f"', dir);
    expect(result.exitCode).toBe(0);

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
