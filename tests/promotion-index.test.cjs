// The promotion gate must judge the INDEX, not the working tree.
//
// A pre-commit hook runs before the commit exists, so the question it has to answer is "do the bytes
// about to be committed match a verdict?", not "do the bytes on disk right now?". Those differ whenever
// anyone stages one thing and edits another — accidentally, or on purpose.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'check-promotion.cjs');

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promotion-'));
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('-c', 'user.email=t@example.test', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'base');
  return { dir, git };
}

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

function registry(dir, records) {
  const file = path.join(dir, 'registry.json');
  fs.writeFileSync(file, JSON.stringify({ records }), 'utf8');
  return file;
}

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

test('the gate judges staged bytes, not the working tree', async (t) => {
  await t.test('a compliant staged file passes even when the working copy is edited', () => {
    const { dir, git } = repo();
    const target = path.join(dir, 'a.ts');
    fs.writeFileSync(target, 'export const a = 1\n', 'utf8');
    git('add', 'a.ts');
    const reg = registry(dir, [{ path: target, sha256: sha('export const a = 1\n'), outcome: 'UNIT_PASSED', succeeded: true, at: 1 }]);

    // Bait and switch: the index holds the good bytes, the working tree holds something else.
    fs.writeFileSync(target, 'export const a = 999 // edited after staging\n', 'utf8');

    const result = run(['--changed', '--repo', dir, '--registry', reg]);
    assert.equal(result.status, 0, result.stdout + result.stderr);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t.test('a failing staged file fails even when the working copy is repaired', () => {
    const { dir, git } = repo();
    const target = path.join(dir, 'a.ts');
    fs.writeFileSync(target, 'export const a = BAD\n', 'utf8');
    git('add', 'a.ts');
    const reg = registry(dir, [{ path: target, sha256: sha('export const a = GOOD\n'), outcome: 'UNIT_PASSED', succeeded: true, at: 1 }]);

    // The working tree is "fixed", but the commit would carry the bad version.
    fs.writeFileSync(target, 'export const a = GOOD\n', 'utf8');

    const result = run(['--changed', '--repo', dir, '--registry', reg]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /NOT SETTLED/);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t.test('a git failure is fatal rather than a silent fallback', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promotion-norepo-'));
    const target = path.join(dir, 'a.ts');
    fs.writeFileSync(target, 'x', 'utf8');
    const reg = registry(dir, [{ path: target, sha256: sha('x'), outcome: 'UNIT_PASSED', succeeded: true, at: 1 }]);

    const result = run(['--changed', '--repo', dir, '--registry', reg]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /FATAL: cannot determine the staged change set/);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
