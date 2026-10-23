#!/usr/bin/env node
/**
 * The promotion socket: let a pipeline gate on the delegation verdict without a git hook in the plugin.
 *
 * WHY THIS IS A SEPARATE PROGRAM. Settling a file is this plugin's job; refusing a commit is the
 * repository's. A DSH plugin reaching into git hooks would be the wrong layer, and worse, it would make
 * the control depend on a tool the caller may not use. So the plugin writes a local registry of verdicts
 * and this script reads it, so any CI step or pre-commit hook can ask a deterministic yes/no question:
 *
 *     node scripts/check-promotion.cjs --changed            # pre-commit: nothing changed since its verdict
 *     node scripts/check-promotion.cjs --path src/thing.ts  # one file
 *     node scripts/check-promotion.cjs --all                # everything registered
 *
 * Exit 0 means every file asked about is settled. Exit 1 means at least one is not, and the reason is
 * printed per file. Exit 2 means the question could not be answered at all -- a missing registry is a
 * refusal, not a pass, because "I could not check" and "it is fine" must never share an exit code.
 *
 * THE HASH IS THE POINT, NOT THE VERDICT. A verdict describes CONTENT. A file that passed and was then
 * edited is not the version anything verified, so the recorded sha256 is recomputed and compared. That
 * is what makes this useful for a pre-commit hook: it answers "is what is about to be committed the
 * artifact some unit verified", which a registry lookup alone cannot.
 *
 * THE LIMIT, stated here because a pipeline author needs it. The registry records files a DELEGATED
 * WORKER wrote. A file written by the architect directly, or by a human, has no record, and this reports
 * it as unknown rather than as passing. A repository that gates on this is gating on delegated work
 * being verified -- not on all work being verified.
 */

'use strict'

const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

function dataDir() {
  const explicit = process.env.DSH_LOCAL_ROUTER_DATA_DIR
  if (explicit && explicit.trim()) return explicit.trim()
  const home = process.env.DSH_HOME
  if (home && home.trim()) return path.join(home.trim(), 'local-router')
  return path.join(os.homedir(), '.dsh', 'local-router')
}

function argValue(name, argv) {
  const at = argv.indexOf('--' + name)
  return at !== -1 && argv[at + 1] ? argv[at + 1] : null
}

/** Windows paths are case-insensitive; the rest are not. Matches the plugin's own comparison. */
function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function sha256File(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  } catch {
    return null
  }
}

/**
 * Files staged relative to HEAD, as absolute paths.
 *
 * THE INDEX, NOT THE WORKING TREE. `git diff HEAD` reports working-tree bytes, which lets a file be
 * staged compliant and edited afterwards: the gate judges one version and the commit carries another.
 * `--cached --diff-filter=ACMR` is exactly the set the commit will contain.
 *
 * A git failure is FATAL here. It used to fall back to "check every registered path", which reads as
 * fail-closed but is not: it changes the question rather than answering it, and a caller cannot tell a
 * complete check from one that ran against a different target set.
 */
function changedFiles(repoRoot) {
  const { spawnSync } = require('child_process')
  const result = spawnSync('git', ['diff', '--name-only', '--diff-filter=ACMR', '--cached', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    return { ok: false, reason: 'git diff --cached failed: ' + String(result.stderr || '').trim() }
  }
  return {
    ok: true,
    files: String(result.stdout || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => path.resolve(repoRoot, line)),
  }
}

/**
 * The hash of a path's STAGED bytes, or null when it is not in the index.
 *
 * `git show :<path>` reads the blob the commit will contain, so the verdict is about the artifact
 * rather than about whatever sits in the working tree at the moment the hook runs.
 */
function stagedHash(repoRoot, target) {
  const { spawnSync } = require('child_process')
  const relative = path.relative(repoRoot, target).split(path.sep).join('/')
  const result = spawnSync('git', ['show', ':' + relative], {
    cwd: repoRoot,
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.status !== 0) return null
  return crypto.createHash('sha256').update(result.stdout).digest('hex')
}

function loadRegistry(registryPath) {
  if (!fs.existsSync(registryPath)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8'))
    return Array.isArray(parsed.records) ? parsed.records : []
  } catch {
    return null
  }
}

/** The most recent record for a path, or undefined. Later writes supersede earlier verdicts. */
function recordFor(records, target) {
  let best
  for (const record of records) {
    if (!record || typeof record.path !== 'string') continue
    if (!samePath(path.resolve(String(record.path)), target)) continue
    if (!best || Number(record.at || 0) >= Number(best.at || 0)) best = record
  }
  return best
}

/** Is this one file settled? Mirrors `evaluateSettledFile` rather than importing it, so a pipeline needs no build. */
function judge(target, records, hashOf = sha256File) {
  const record = recordFor(records, target)
  if (!record) return { ok: false, reason: 'no verdict: no delegated unit is recorded as writing it' }
  if (record.outcome === 'UNIT_FLAKY') {
    return { ok: false, reason: 'the contract disagreed with itself across repeated runs' }
  }
  if (record.outcome === 'UNIT_FAILED') {
    return { ok: false, reason: 'the unit that wrote it failed verification' }
  }
  if (record.outcome === 'UNIT_UNVERIFIED') {
    return { ok: false, reason: 'the unit that wrote it was never verified' }
  }
  if (record.outcome === 'OPERATOR_ATTESTED') {
    const current = hashOf(target)
    if (current === null) return { ok: false, reason: 'its content could not be read' }
    if (String(record.sha256) !== current) {
      return { ok: false, reason: 'its content changed after the operator attested it' }
    }
    const by = record.attestation && record.attestation.operator ? String(record.attestation.operator) : 'an operator'
    return { ok: true, reason: 'attested by ' + by + ' and unchanged since', attested: true }
  }  if (record.outcome !== 'UNIT_PASSED' || record.succeeded !== true) {
    return { ok: false, reason: 'the registry holds no verdict for it' }
  }
  const current = hashOf(target)
  if (current === null) return { ok: false, reason: 'its content could not be read' }
  if (String(record.sha256) !== current) {
    return { ok: false, reason: 'its content changed after the verdict, so it is not the version anything verified' }
  }
  return { ok: true, reason: 'a unit passed it and its content is unchanged' }
}

function main() {
  const argv = process.argv.slice(2)
  const registryPath = argValue('registry', argv) || path.join(dataDir(), 'delegated-registry.json')
  const repoRoot = path.resolve(argValue('repo', argv) || process.cwd())
  const all = argv.includes('--all')
  const changed = argv.includes('--changed')
  const asJson = argv.includes('--json')

  // MULTI-TARGET. Both `--path a --path b` and bare positionals are accepted, so a changeset can be gated
  // in one invocation. The value-taking flags are excluded explicitly rather than by testing for a leading
  // dash: `--registry <file>` would otherwise push the registry PATH into the target list, and the gate
  // would try to judge its own registry as a source file.
  const valueFlags = new Set(['--registry', '--repo', '--path'])
  const explicitTargets = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--path') {
      if (argv[i + 1]) explicitTargets.push(argv[i + 1])
      i++
      continue
    }
    if (valueFlags.has(arg)) {
      i++
      continue
    }
    if (!arg.startsWith('--')) explicitTargets.push(arg)
  }

  if (explicitTargets.length === 0 && !all && !changed) {
    console.error(
      'usage: node scripts/check-promotion.cjs <file> [file ...] | --path <file> | --all | --changed [--json]'
    )
    process.exit(2)
  }

  const records = loadRegistry(registryPath)
  if (records === null) {
    // Not a pass. An unanswerable question and a good answer must not share an exit code.
    console.error('cannot answer: no readable registry at ' + registryPath)
    process.exit(2)
  }

  let targets = []
  if (explicitTargets.length > 0) {
    // Resolved against the repo root, because a bare filename resolves against the cwd and silently finds
    // no record -- a false negative that reads exactly like a real failure.
    targets = explicitTargets.map((t) => path.resolve(repoRoot, t))
  } else if (all) {
    targets = records.map((r) => path.resolve(String(r.path)))
  } else {
    const diff = changedFiles(repoRoot)
    if (!diff.ok) {
      // FATAL, not a fallback. Widening to every registered path changes the question the gate answers
      // while still printing a result, so a caller cannot tell a complete check from a substituted one.
      // Failing closed here means refusing to report at all.
      console.error('FATAL: cannot determine the staged change set: ' + diff.reason)
      process.exit(1)
    }
    targets = diff.files
  }

  // In --changed mode the judgement is about the bytes the commit will carry, so the hash comes from the
  // index. Everywhere else the caller named a path that may not be staged, so the working tree is right.
  const hashOf = changed ? (target) => stagedHash(repoRoot, target) : (target) => sha256File(target)

  const results = targets.map((target) => ({ path: target, ...judge(target, records, hashOf) }))
  const failures = results.filter((r) => !r.ok)

  if (asJson) {
    // The shape is UNCHANGED deliberately. The oracle reads `results[0]`, so emitting a bare array here
    // would break every one of its twelve fixture cases -- a telemetry change silently invalidating the
    // test that guards the socket.
    console.log(
      JSON.stringify({ registry: registryPath, checked: results.length, failures: failures.length, results }, null, 2)
    )
  } else {
    // Telemetry on the DEFAULT path, so a gate can tell a machine pass from a human attestation without a
    // flag. Requiring --json to learn which kind of claim a promotion rests on had it backwards.
    let attested = 0
    let passed = 0
    for (const result of results) {
      if (result.ok) {
        if (result.attested) attested++
        else passed++
        console.log('SETTLED      ' + result.path + '\n             ' + result.reason)
      } else {
        console.log('NOT SETTLED  ' + result.path + '\n             ' + result.reason)
      }
    }
    console.log(
      results.length +
        ' target(s): ' +
        attested +
        ' operator-attested, ' +
        passed +
        ' unit-passed, ' +
        failures.length +
        ' unsettled' +
        (changed ? ' (changed against HEAD)' : '')
    )
  }

  process.exit(failures.length === 0 ? 0 : 1)
}

main()
