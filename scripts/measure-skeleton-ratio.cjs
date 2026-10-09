#!/usr/bin/env node
/**
 * How much smaller is a type skeleton than the source it describes?
 *
 * WHY THIS EXISTS. The argument for inverted ingestion -- feed the architect declarations instead of
 * implementations -- rested on a claim that was never measured and then had to be retracted: that it turns
 * O(10^6) tokens into O(10^3). Those are not the same quantity, so the ratio is not a constant and cannot
 * be quoted without measuring a corpus. This script measures it, on this repository, so the number in the
 * docs is a reading rather than a hope.
 *
 * WHAT IT COMPARES. Three figures, because the middle one is the honest default and the third is the best
 * case:
 *
 *   source        every byte of the .ts files
 *   declarations  `tsc --declaration --emitDeclarationOnly`
 *   stripped      the same, with --removeComments
 *
 * Comment stripping matters more than it looks. This repository documents its code heavily, and a
 * declaration emit preserves doc comments -- so the unstripped skeleton carries a large share of the
 * prose while removing none of the bodies' readers. Reporting only one figure would let either the
 * flattering or the unflattering number be quoted as "the" ratio.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: count tokens properly. Four bytes per token is a rough constant for
 * source text and it is labelled as such wherever it is printed. A real tokeniser would change the absolute
 * figures by a few tens of percent and would not change the RATIO, which is the point of the measurement.
 *
 * Usage:
 *   node scripts/measure-skeleton-ratio.cjs
 *   node scripts/measure-skeleton-ratio.cjs --json
 */

'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const REPO = path.resolve(__dirname, '..')
const BYTES_PER_TOKEN = 4

function argValue(name, argv) {
  const at = argv.indexOf('--' + name)
  return at !== -1 && argv[at + 1] ? argv[at + 1] : null
}

function walk(dir, predicate) {
  const out = []
  const visit = (current) => {
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (entry.isFile() && predicate(full)) out.push(full)
    }
  }
  visit(dir)
  return out
}

function totalBytes(files) {
  let bytes = 0
  for (const file of files) bytes += fs.statSync(file).size
  return bytes
}

function generateDeclarations(pluginDir, outDir, removeComments) {
  // TypeScript is invoked through its JavaScript entry point rather than through `npx`. On Windows `npx`
  // is a `.cmd` shim, and `spawnSync` without a shell cannot launch it -- it fails with a non-zero status
  // and an EMPTY stderr, which is how the first version of this script reported "declaration emit failed:"
  // with nothing after the colon. Running the compiler's own JS file removes the shell from the path
  // entirely, which is also the safer direction for a script that a gate might call.
  const tsc = path.join(pluginDir, 'node_modules', 'typescript', 'bin', 'tsc')
  if (!fs.existsSync(tsc)) {
    return { status: 2, stderr: 'typescript not installed at ' + tsc }
  }
  const args = [
    tsc,
    '-p',
    'tsconfig.json',
    '--declaration',
    '--emitDeclarationOnly',
    '--outDir',
    outDir,
  ]
  if (removeComments) args.push('--removeComments')
  const result = spawnSync(process.execPath, args, { cwd: pluginDir, encoding: 'utf8' })
  return { status: result.status, stderr: String(result.stderr || '') }
}

function main() {
  const argv = process.argv.slice(2)
  const pluginDir = path.join(REPO, 'plugin')
  const sourceDir = path.resolve(REPO, argValue('source', argv) || path.join('plugin', 'src'))
  const scratch =
    argValue('emit', argv) || fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-skeleton-'))

  if (!fs.existsSync(sourceDir)) {
    console.error('no source directory at ' + sourceDir)
    process.exit(2)
  }

  const sourceFiles = walk(sourceDir, (f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
  const sourceBytes = totalBytes(sourceFiles)

  const plainDir = path.join(scratch, 'with-comments')
  const strippedDir = path.join(scratch, 'stripped')
  const plain = generateDeclarations(pluginDir, plainDir, false)
  if (plain.status !== 0) {
    console.error('declaration emit failed: ' + plain.stderr.trim())
    process.exit(2)
  }
  const stripped = generateDeclarations(pluginDir, strippedDir, true)
  if (stripped.status !== 0) {
    console.error('stripped declaration emit failed: ' + stripped.stderr.trim())
    process.exit(2)
  }

  const plainBytes = totalBytes(walk(plainDir, (f) => f.endsWith('.d.ts')))
  const strippedBytes = totalBytes(walk(strippedDir, (f) => f.endsWith('.d.ts')))

  const pct = (ratio) => ((1 - ratio) * 100).toFixed(1) + '%'
  const summary = {
    source: { files: sourceFiles.length, bytes: sourceBytes, approxTokens: Math.round(sourceBytes / BYTES_PER_TOKEN) },
    declarations: {
      bytes: plainBytes,
      ratio: Number((plainBytes / sourceBytes).toFixed(3)),
      reduction: pct(plainBytes / sourceBytes),
      approxTokens: Math.round(plainBytes / BYTES_PER_TOKEN),
    },
    declarationsStripped: {
      bytes: strippedBytes,
      ratio: Number((strippedBytes / sourceBytes).toFixed(3)),
      reduction: pct(strippedBytes / sourceBytes),
      approxTokens: Math.round(strippedBytes / BYTES_PER_TOKEN),
    },
    bytesPerToken: BYTES_PER_TOKEN,
  }

  if (argv.includes('--json')) {
    console.log(JSON.stringify(summary, null, 2))
    return
  }

  const n = (v) => Number(v).toLocaleString('en-US')
  console.log('source directory   ' + sourceDir)
  console.log('')
  console.log('  source          ' + n(sourceBytes).padStart(10) + ' bytes   ~' + n(summary.source.approxTokens).padStart(8) + ' tokens   ' + sourceFiles.length + ' files')
  console.log('  declarations    ' + n(plainBytes).padStart(10) + ' bytes   ~' + n(summary.declarations.approxTokens).padStart(8) + ' tokens   ratio ' + summary.declarations.ratio + '  (' + summary.declarations.reduction + ' smaller)')
  console.log('  stripped        ' + n(strippedBytes).padStart(10) + ' bytes   ~' + n(summary.declarationsStripped.approxTokens).padStart(8) + ' tokens   ratio ' + summary.declarationsStripped.ratio + '  (' + summary.declarationsStripped.reduction + ' smaller)')
  console.log('')
  console.log('token figures use ~' + BYTES_PER_TOKEN + ' bytes per token, a rough constant, not a tokeniser.')
  console.log('The ratio is what this measures; the absolute token counts are indicative.')
}

main()
