#!/usr/bin/env node
/**
 * Physical file hygiene for the trees that are generated, attested, or both.
 *
 * WHY THIS IS A GATE STEP AND NOT A LINE IN THE WORKER PROMPT. A convention that lives only in the
 * prompt is aspirational: the model may or may not honour it, nothing fails when it does not, and the
 * requirement then reads as enforced while being optional. These are properties of the BYTES, they are
 * cheap to check, and a generated file that violates one is caught before it can be committed or
 * attested. MEASURED: the local worker regenerated `tools/currency.ts` with no trailing newline, the
 * contract passed it 9/9, and the diff read `\ No newline at end of file`. Nothing objected.
 *
 * THE THREE RULES, and what each one actually protects:
 *
 *   1. TRAILING NEWLINE. A file that ends mid-line is what generates the diff noise above, and it is
 *      the one hygiene defect this repository demonstrably produces.
 *   2. NO CRLF. This one is load-bearing rather than cosmetic. The signer hashes the bytes on DISK and
 *      records that digest in the envelope; the auditor compares it against the blob in the anchored
 *      tree. Git stores LF, so a working tree with CRLF makes those two disagree, and the resulting
 *      note fails the audit it was supposed to satisfy. The audit itself is tree-backed and survives a
 *      CRLF checkout; the SIGNER does not, which is why the check is here rather than only in review.
 *   3. NO UTF-8 BOM. A BOM is invisible in every editor and breaks the first token of a file. It is a
 *      live hazard on this host specifically: PowerShell 5.1 writes one for `-Encoding utf8`, which is
 *      the default people reach for, and this session has already produced one that way.
 *
 * SCOPE. `tools/`, `plugin/src/` and `scripts/` -- the generated artefacts, the source compiled from
 * them, and the operator tooling that signs and audits both. `plugin/dist/` is deliberately NOT
 * checked: it is tsc output, tsc already emits conforming files, and a check that cannot fail is a
 * check that teaches people to ignore the one that can.
 *
 * `scripts/` was added on 2026-10-18, after a policy config landed there that the check could not
 * see. The gap was not hypothetical: the rule that matters most for this tree is CRLF, because the
 * signer hashes the bytes on disk while the auditor compares against the blob, and a script that
 * signs is exactly the file whose line endings have to agree.
 *
 * Usage: node scripts/check-file-hygiene.cjs
 * Exit 0 when every file conforms, 1 otherwise.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '..')
const TARGET_DIRS = [
  path.join(REPO_ROOT, 'tools'),
  path.join(REPO_ROOT, 'plugin', 'src'),
  path.join(REPO_ROOT, 'scripts'),
  // Added with the first Tier 2 engine. `src/` is hand-written source now, not a reserved path, and
  // the rule that matters here is CRLF: a checkout that rewrites line endings changes the bytes a
  // reviewer read, whether or not the file is attested.
  path.join(REPO_ROOT, 'src'),
]
const TARGET_LABELS = TARGET_DIRS.map(
  (dir) => path.relative(REPO_ROOT, dir).split(path.sep).join('/') + '/'
).join(', ')
const EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.cjs', '.json', '.md'])

const BOM = [0xef, 0xbb, 0xbf]
const LF = 0x0a
const CR = 0x0d

function collectFiles(dir) {
  const found = []
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...collectFiles(full))
    else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name).toLowerCase())) found.push(full)
  }
  return found
}

let checked = 0
const violations = []

for (const dir of TARGET_DIRS) {
  for (const file of collectFiles(dir)) {
    const relative = path.relative(REPO_ROOT, file).split(path.sep).join('/')
    const bytes = fs.readFileSync(file)
    checked += 1
    // An empty file cannot lack a trailing newline, and a BOM is its own decision. Skipped rather than
    // special-cased per rule, so the reason is in one place.
    if (bytes.length === 0) continue

    if (bytes[bytes.length - 1] !== LF) {
      violations.push({ relative, rule: 'missing trailing newline at end of file' })
    }
    for (let i = 0; i < bytes.length - 1; i++) {
      if (bytes[i] === CR && bytes[i + 1] === LF) {
        violations.push({ relative, rule: 'contains CRLF line endings; this tree stores LF' })
        break
      }
    }
    if (bytes.length >= BOM.length && BOM.every((byte, i) => bytes[i] === byte)) {
      violations.push({ relative, rule: 'starts with a UTF-8 BOM' })
    }
  }
}

console.log('=== file hygiene (' + checked + ' file(s) under ' + TARGET_LABELS + ') ===')

if (violations.length === 0) {
  console.log('  ok    every file ends with a newline, stores LF, and carries no BOM')
  process.exit(0)
}

for (const violation of violations) {
  console.error('  FAIL  ' + violation.relative + ': ' + violation.rule)
}
console.error('')
console.error(
  violations.length + ' hygiene failure(s). These are byte-level invariants, not style preferences: a\n' +
    'CRLF working tree makes the signer record a digest the anchored tree does not contain, and it is\n' +
    'the audit that discovers that afterwards. Fix the files rather than the check.'
)
process.exit(1)
