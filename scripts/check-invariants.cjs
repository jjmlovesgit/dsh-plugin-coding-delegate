#!/usr/bin/env node
/**
 * Deterministic invariant oracle for the refusal vocabulary.
 *
 * WHY THIS EXISTS. Every refusal the plugin can emit is a contract with an operator: the code says
 * `REFUSED_PROTECTED_PATH`, and the documentation is where they learn what that means. Nothing kept the
 * two in step, so a new fence could ship undocumented — and did: `REFUSED_PROTECTED_PATH` was added and
 * named nowhere a reader would look. `scripts/check-readme-consistency.cjs` checks the policy tables;
 * this checks the vocabulary those tables and the guides actually explain.
 *
 * It is deliberately textual and mechanical: no heuristics, no prose understanding. A code exists in the
 * source or it does not; it is documented or it is not.
 *
 * Usage: node scripts/check-invariants.cjs
 * Exit 0 when every emitted code is documented, 1 otherwise.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '..')
const SOURCE_DIR = path.join(REPO_ROOT, 'plugin', 'src')
const DOCUMENTS = [
  path.join(REPO_ROOT, 'README.md'),
  path.join(REPO_ROOT, 'docs', 'architecture', 'ADR-SEC-AISDLC-001.md'),
  path.join(REPO_ROOT, 'docs', 'security', 'red-team-brief.md'),
]

const CODE_PATTERN = /\b(?:REFUSED|APPROVAL_REQUIRED)_[A-Z0-9_]+\b/g

function emittedCodes() {
  const codes = new Set()
  for (const file of fs.readdirSync(SOURCE_DIR)) {
    if (!file.endsWith('.ts') || file.endsWith('.d.ts')) continue
    const text = fs.readFileSync(path.join(SOURCE_DIR, file), 'utf8')
    for (const match of text.match(CODE_PATTERN) || []) codes.add(match)
  }
  return [...codes].sort()
}

function documentedCorpus() {
  return DOCUMENTS.filter((file) => fs.existsSync(file))
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n')
}

function main() {
  const codes = emittedCodes()
  if (codes.length === 0) {
    console.error('ERROR  no refusal codes found under ' + SOURCE_DIR)
    process.exit(1)
  }
  const corpus = documentedCorpus()
  const missing = codes.filter((code) => corpus.indexOf(code) === -1)

  if (missing.length > 0) {
    console.error('UNDOCUMENTED REFUSAL CODE(S): the plugin can emit these and no reader can look them up.')
    for (const code of missing) console.error('  ' + code)
    console.error('')
    console.error('Document each in README.md, the ADR, or the red-team brief, then re-run.')
    process.exit(1)
  }

  console.log('All ' + codes.length + ' refusal code(s) emitted by the plugin are documented.')
}

main()
