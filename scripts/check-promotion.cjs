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
 * Files changed relative to HEAD, as absolute paths.
 *
 * `git diff --name-only HEAD` rather than a diff of the index, because a pre-commit hook runs before the
 * commit exists and HEAD is the last committed state -- which is exactly the baseline a verdict was
 * reached against.
 */
function changedFiles(repoRoot) {
  const { spawnSync } = require('child_process')
  const result = spawnSync('git', ['diff', '--name-only', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  if (result.status !== 0) return { ok: false, reason: 'git diff failed: ' + String(result.stderr || '').trim() }
  return {
    ok: true,
    files: String(result.stdout || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => path.resolve(repoRoot, line)),
  }
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
function judge(target, records) {
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
  if (record.outcome !== 'UNIT_PASSED' || record.succeeded !== true) {
    return { ok: false, reason: 'the registry holds no verdict for it' }
  }
  const current = sha256File(target)
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
  const onePath = argValue('path', argv)
  const all = argv.includes('--all')
  const changed = argv.includes('--changed')
  const asJson = argv.includes('--json')

  if (!onePath && !all && !changed) {
    console.error('usage: node scripts/check-promotion.cjs --changed | --path <file> | --all [--json]')
    process.exit(2)
  }

  const records = loadRegistry(registryPath)
  if (records === null) {
    // Not a pass. An unanswerable question and a good answer must not share an exit code.
    console.error('cannot answer: no readable registry at ' + registryPath)
    process.exit(2)
  }

  let targets = []
  if (onePath) {
    targets = [path.resolve(repoRoot, onePath)]
  } else if (all) {
    targets = records.map((r) => path.resolve(String(r.path)))
  } else {
    const diff = changedFiles(repoRoot)
    if (!diff.ok) {
      // Could not determine what changed -- git missing, not a repository, or the process denied. Treat
      // that as "check everything" rather than as an error, because this is a GATE: failing closed means
      // checking MORE than asked, never waving the commit through. The reason is still reported, so a
      // caller can tell a fallback from a normal run.
      console.error('note: could not diff against HEAD (' + diff.reason + '); checking every registered path instead')
      targets = records.map((r) => path.resolve(String(r.path)))
    } else {
      targets = diff.files
    }
  }

  const results = targets.map((target) => ({ path: target, ...judge(target, records) }))
  const failures = results.filter((r) => !r.ok)

  if (asJson) {
    console.log(JSON.stringify({ registry: registryPath, checked: results.length, failures: failures.length, results }, null, 2))
  } else {
    for (const result of results) {
      if (!result.ok) console.log('NOT SETTLED  ' + result.path + '\n             ' + result.reason)
    }
    console.log(
      results.length + ' file(s) checked, ' + failures.length + ' not settled' +
        (changed ? ' (changed against HEAD)' : '')
    )
  }

  process.exit(failures.length === 0 ? 0 : 1)
}

main()
