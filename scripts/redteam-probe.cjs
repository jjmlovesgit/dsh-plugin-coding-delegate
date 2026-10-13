'use strict';
// Red-team probes against scripts/verify-delegation-ledger.cjs.
//
// NON-DESTRUCTIVE: the notes ref is saved before the first probe and restored in `finally`, and the
// restore is verified by re-running the audit and requiring it to pass again.
//
// WHY EACH PROBE ASSERTS A SPECIFIC FAILURE MESSAGE. "The audit exited non-zero" is not evidence that an
// attack was blocked -- a malformed envelope, a typo'd ref or a spawn failure all produce non-zero too,
// and a probe that accepted any of them would report BLOCKED for an audit that never ran. Each probe
// therefore requires BOTH a non-zero exit AND the message from the check it is aimed at.
//
// No shell is used anywhere: git is invoked with an argv array and note bodies are handed over with -F,
// because an envelope full of JSON quotes does not survive being interpolated into a command line.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

const { publicKeyFromPrivate, hashBuffer } = require('../plugin/dist/crypto-attestation.js');
const { canonicalizeJson } = require('../plugin/dist/canonical-json.js');

const REPO_ROOT = path.resolve(__dirname, '..');
const NOTES_REF = 'refs/notes/delegations';
const AUDIT = path.join(REPO_ROOT, 'scripts', 'verify-delegation-ledger.cjs');
const NOTE_TMP = path.join(os.tmpdir(), 'redteam-probe-note.json');
const PRIVATE_KEY = path.join(os.homedir(), '.dsh', 'keys', 'delegation_ed25519.pem');

const git = (args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });

function attach(commit, body) {
  fs.writeFileSync(NOTE_TMP, body, 'utf8');
  execFileSync('git', ['notes', '--ref=' + NOTES_REF, 'add', '-f', '-F', NOTE_TMP, commit], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

function runAudit() {
  const result = spawnSync(process.execPath, [AUDIT], { cwd: REPO_ROOT, encoding: 'utf8' });
  return { code: result.status, output: String(result.stdout || '') + String(result.stderr || '') };
}

const head = git(['rev-parse', 'HEAD']).trim();
const backup = git(['rev-parse', NOTES_REF]).trim();
const operatorPem = fs.readFileSync(PRIVATE_KEY, 'utf8');
const operatorPub = String(publicKeyFromPrivate(operatorPem)).trim();

let breached = 0;

function probe(number, label, expectedFragment) {
  const result = runAudit();
  const firedExpected = result.output.includes(expectedFragment);
  const blocked = result.code !== 0 && firedExpected;
  if (!blocked) breached += 1;
  console.log(
    '  ' + (blocked ? 'BLOCKED ' : 'BREACHED') + '  probe ' + number + ': ' + label
  );
  console.log(
    '            audit exit ' + result.code + ' (non-zero required) · expected message ' +
      JSON.stringify(expectedFragment) + ' present: ' + firedExpected
  );
}

console.log('HEAD            : ' + head.slice(0, 8));
console.log('notes ref saved : ' + backup.slice(0, 8));
console.log('');

try {
  // ---- Probe 1: foreign key substitution -----------------------------------
  const foreign = crypto.generateKeyPairSync('ed25519');
  const foreignPub = String(foreign.publicKey.export({ type: 'spki', format: 'pem' }));
  const foreignPriv = String(foreign.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const forgedPayload = JSON.stringify({
    specVersion: '1.1',
    runId: 'redteam-foreign-key',
    contractHash: 'a'.repeat(64),
    contracts: [{ path: 'tests/contracts/lru-cache.contract.cjs', sha256: 'b'.repeat(64) }],
    baseCommit: head,
    modelIdentifier: 'attacker',
    artifacts: [{ path: 'tools/lru-cache.ts', sha256: 'c'.repeat(64) }],
    verification: { command: 'x', exitCode: 0, stdoutHash: 'd'.repeat(64), passed: true },
  });
  const foreignSignature = crypto
    .sign(null, Buffer.from(forgedPayload, 'utf8'), foreignPriv)
    .toString('base64');
  attach(
    head,
    JSON.stringify({
      payload: forgedPayload,
      payloadType: 'application/vnd.dsh-delegation-attestation+json',
      signature: foreignSignature,
      publicKeyPem: foreignPub,
    })
  );
  probe(1, 'foreign key substitution (own key, own pubkey embedded)', 'signature check failed');

  // ---- Probe 2: blind payload tampering, no re-sign ------------------------
  const realEnvelope = JSON.parse(git(['notes', '--ref=' + NOTES_REF, 'show', 'ca05be7']).trim());
  const tampered = JSON.parse(realEnvelope.payload);
  const before = tampered.artifacts[0].sha256;
  tampered.artifacts[0].sha256 = 'deadbeef' + before.slice(8);
  realEnvelope.payload = JSON.stringify(tampered);
  attach('ca05be7', JSON.stringify(realEnvelope));
  probe(2, 'blind artifact-hash tampering on a signed note', 'signature check failed');

  // ---- Probe 3: post-cutoff spec regression --------------------------------
  // Signed with the REAL key so check 1 passes, and carrying a real artifact hash so check 3 passes:
  // the only thing that can reject this is the ancestry-anchored spec rule.
  const artifactSha = hashBuffer(fs.readFileSync(path.join(REPO_ROOT, 'tools/lru-cache.ts')));
  const regressed = JSON.stringify({
    specVersion: '1.0',
    runId: 'redteam-spec-regression',
    contractHash: 'e'.repeat(64),
    baseCommit: head,
    modelIdentifier: 'qwen/qwen3.8-27b',
    artifacts: [{ path: 'tools/lru-cache.ts', sha256: artifactSha }],
    verification: { command: 'x', exitCode: 0, stdoutHash: 'f'.repeat(64), passed: true },
  });
  const regressedSig = crypto.sign(null, Buffer.from(regressed, 'utf8'), operatorPem).toString('base64');
  attach(
    head,
    canonicalizeJson({
      payload: regressed,
      payloadType: 'application/vnd.dsh-delegation-attestation+json',
      signature: regressedSig,
      publicKeyPem: operatorPub,
    })
  );
  probe(3, 'post-cutoff note claiming spec 1.0 with no contracts array', 'spec regression');

  // ---- Probe 4: disconnected commit lineage --------------------------------
  const tree = git(['rev-parse', 'HEAD^{tree}']).trim();
  const orphan = git(['commit-tree', tree, '-m', 'red-team orphan commit (no parent)']).trim();
  const ancestry = spawnSync('git', ['merge-base', '--is-ancestor', orphan, 'main'], { cwd: REPO_ROOT });
  console.log('  orphan commit created: ' + orphan.slice(0, 8) + '   is ancestor of main: ' + (ancestry.status === 0));

  const realRingEnvelope = JSON.parse(git(['notes', '--ref=' + NOTES_REF, 'show', '0286c6b']).trim());
  const reAnchored = JSON.parse(realRingEnvelope.payload);
  reAnchored.baseCommit = orphan;
  realRingEnvelope.payload = canonicalizeJson(reAnchored);
  // Re-signed with the real key, so check 1 passes and only the lineage check can reject it.
  const reAnchoredSig = crypto
    .sign(null, Buffer.from(realRingEnvelope.payload, 'utf8'), operatorPem)
    .toString('base64');
  realRingEnvelope.signature = reAnchoredSig;
  realRingEnvelope.publicKeyPem = operatorPub;
  attach(head, canonicalizeJson(realRingEnvelope));
  probe(4, 'note anchored to an orphan commit outside main', 'is not an ancestor of main');
} finally {
  fs.rmSync(NOTE_TMP, { force: true });
  execFileSync('git', ['update-ref', NOTES_REF, backup], { cwd: REPO_ROOT });
  const restored = git(['rev-parse', NOTES_REF]).trim() === backup;
  const after = runAudit();
  console.log('');
  console.log('  ledger restored to backup ref : ' + restored);
  console.log('  audit after restore           : exit ' + after.code + (after.code === 0 ? ' (clean)' : ' (STILL FAILING)'));
  if (!restored || after.code !== 0) breached += 1;
}

console.log('');
console.log(breached === 0 ? 'ALL 4 ATTACK VECTORS BLOCKED, LEDGER RESTORED' : breached + ' PROBE PROBLEM(S)');
process.exit(breached === 0 ? 0 : 1);
