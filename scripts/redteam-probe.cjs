'use strict';
// Red-team probes against scripts/verify-delegation-ledger.cjs.
//
// NON-DESTRUCTIVE: the notes ref is saved before the first probe and restored in `finally`, and the
// restore is verified by re-running the audit and requiring it to pass again.
//
// WHY EACH PROBE ASSERTS A SPECIFIC FAILURE MESSAGE. "The audit exited non-zero" is not evidence that an
// attack was blocked -- a malformed envelope, a typo'd ref or a spawn failure all produce non-zero too,
// and a probe that accepted any of them would report BLOCKED for an audit that never ran. Each probe
// therefore requires BOTH a non-zero exit AND the message from the check it is aimed at. Probes 5 and 6
// go further and require the audit's critical-failure COUNT to be exactly 1, because those two attacks
// are only interesting if every other check still passes: a probe that left four checks red would not
// have shown the new check catching anything.
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

// Tree membership, asked of the commit rather than the working tree: exactly the distinction probe 6 tests.
function inTreeAt(commit, repoRelativePath) {
  try {
    execFileSync('git', ['cat-file', '-e', commit + ':' + repoRelativePath], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

const noteBlobOf = (commit) => String(git(['notes', '--ref=' + NOTES_REF, 'list', commit])).trim().split(/\s+/)[0];

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

// BETWEEN PROBES THE LEDGER GOES BACK TO THE SAVED REF. Without this, each probe audits the wreckage of
// the ones before it and a failure count stops being attributable: measured, probe 5's count read 3
// because probe 2's tampered note was still in place, which says nothing about the check being probed.
function restoreLedger() {
  execFileSync('git', ['update-ref', NOTES_REF, backup], { cwd: REPO_ROOT });
}

const operatorPem = fs.readFileSync(PRIVATE_KEY, 'utf8');
const operatorPub = String(publicKeyFromPrivate(operatorPem)).trim();

let breached = 0;

function probe(number, label, expectedFragment, expect) {
  const result = runAudit();
  const firedExpected = result.output.includes(expectedFragment);
  const blocked = result.code !== 0 && firedExpected;
  let isolated = true;
  const countMatch = /AUDIT FAILED: (\d+) critical check\(s\) failed\./.exec(result.output);
  const failedCount = countMatch ? Number(countMatch[1]) : 0;
  if (expect && expect.onlyOneFailure) {
    isolated = failedCount === 1;
  }
  if (!blocked || !isolated) breached += 1;
  console.log(
    '  ' + (blocked && isolated ? 'BLOCKED ' : 'BREACHED') + '  probe ' + number + ': ' + label
  );
  console.log(
    '            audit exit ' + result.code + ' (non-zero required) · expected message ' +
      JSON.stringify(expectedFragment) + ' present: ' + firedExpected
  );
  console.log(
    '            critical checks failed: ' + failedCount +
      (expect && expect.onlyOneFailure ? ' (exactly 1 required, so only this check fired)' : '')
  );
}

// For claims a probe makes about its OWN setup, which are not the audit's verdict and must not be
// smuggled into it: if the evidence line is false, the probe did not test what it says it tested.
function requireOk(label, ok) {
  if (!ok) breached += 1;
  console.log('            ' + (ok ? 'ok    ' : 'FAILED') + '  ' + label);
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
  restoreLedger();

  // ---- Probe 2: blind payload tampering, no re-sign ------------------------
  const realEnvelope = JSON.parse(git(['notes', '--ref=' + NOTES_REF, 'show', 'ca05be7']).trim());
  const tampered = JSON.parse(realEnvelope.payload);
  const before = tampered.artifacts[0].sha256;
  tampered.artifacts[0].sha256 = 'deadbeef' + before.slice(8);
  realEnvelope.payload = JSON.stringify(tampered);
  attach('ca05be7', JSON.stringify(realEnvelope));
  probe(2, 'blind artifact-hash tampering on a signed note', 'signature check failed');
  restoreLedger();

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
  restoreLedger();

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
  restoreLedger();

  // ---- Probe 5: a sound record moved onto the wrong commit ------------------
  // The a113cff envelope is NOT modified at all: right key, right signature, right artifact hashes,
  // right contract digest. Every check that reads the payload therefore still passes, and the ONLY thing
  // left to reject it is whether the note lives on the commit its payload names. The isolation
  // assertion requires exactly one critical failure, so a green run here proves the attachment check
  // caught something the other five could not -- which is precisely the gap this check was added for.
  const a113Blob = noteBlobOf('a113cff');
  const movedVerbatim = String(git(['notes', '--ref=' + NOTES_REF, 'show', 'a113cff'])).trim();
  attach(head, movedVerbatim);
  requireOk(
    'note moved to ' + head.slice(0, 8) + ' byte-identical to the a113cff note blob (' + a113Blob.slice(0, 8) + ')',
    noteBlobOf(head) === a113Blob
  );
  probe(
    5,
    'sound a113cff record re-attached to ' + head.slice(0, 8) + ', payload untouched',
    'FAIL  attachment mismatch',
    { onlyOneFailure: true }
  );
  // HEAD carried no note before probe 4, and update-ref rewinds the whole ref, so clearing it puts the
  // ledger back and keeps each probe's failure count attributable to that probe alone.
  restoreLedger();

  // ---- Probe 6: an artifact that only exists later in history ---------------
  // Anchored at ca05be7, which is AFTER the 1.1 cutoff (so no spec regression) and whose tree DOES hold
  // that unit's real artifact and contract (so the digest still reproduces). The forged artifact entry
  // points at a file that exists in the working tree right now but that ca05be7 never contained, and it
  // carries that file's TRUE on-disk hash -- so a working-tree comparison says the note is honest. The
  // tree-backed comparison is the only one that rejects it, and exactly one check may fail.
  const futureRel = 'scripts/redteam-probe.cjs';
  const futureSha = hashBuffer(fs.readFileSync(path.join(REPO_ROOT, ...futureRel.split('/'))));
  const caEnvelope = JSON.parse(git(['notes', '--ref=' + NOTES_REF, 'show', 'ca05be7']).trim());
  const timeTraveller = JSON.parse(caEnvelope.payload);
  timeTraveller.artifacts = [{ path: futureRel, sha256: futureSha }];
  const timeTravellerPayload = canonicalizeJson(timeTraveller);
  attach(
    'ca05be7',
    canonicalizeJson({
      payload: timeTravellerPayload,
      payloadType: 'application/vnd.dsh-delegation-attestation+json',
      // Signed with the REAL key so check 1 passes: the point is a well-signed record that is false.
      signature: crypto
        .sign(null, Buffer.from(timeTravellerPayload, 'utf8'), operatorPem)
        .toString('base64'),
      publicKeyPem: operatorPub,
    })
  );
  const onDisk = hashBuffer(fs.readFileSync(path.join(REPO_ROOT, ...futureRel.split('/'))));
  console.log('  forged artifact ' + futureRel + ' hashes to ' + futureSha.slice(0, 8) + ' on disk');
  requireOk('the forged artifact is absent from the ca05be7 tree', !inTreeAt('ca05be7', futureRel));
  requireOk('the forged artifact is present at HEAD (so a disk read would accept it)', inTreeAt(head, futureRel));
  requireOk('the note\'s own artifact hash equals the on-disk bytes it names', onDisk === futureSha);
  probe(
    6,
    'artifact on disk today but absent from the anchored tree',
    'FAIL  artifact is not in the anchored tree',
    { onlyOneFailure: true }
  );
} finally {
  fs.rmSync(NOTE_TMP, { force: true });
  restoreLedger();
  const restored = git(['rev-parse', NOTES_REF]).trim() === backup;
  const after = runAudit();
  console.log('');
  console.log('  ledger restored to backup ref : ' + restored);
  console.log('  audit after restore           : exit ' + after.code + (after.code === 0 ? ' (clean)' : ' (STILL FAILING)'));
  if (!restored || after.code !== 0) breached += 1;
}

console.log('');
console.log(breached === 0 ? 'ALL 6 ATTACK VECTORS BLOCKED, LEDGER RESTORED' : breached + ' PROBE PROBLEM(S)');
process.exit(breached === 0 ? 0 : 1);
