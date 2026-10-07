// Apply a search/replace patch that is staged in a file, using the plugin's own patch primitives.
// Needed because `extractAndEmitFiles` scans fenced blocks with a non-greedy regex, so any patch whose
// SEARCH text contains three backticks is truncated mid-body before the parser ever sees it. Reading
// the patch from a file avoids the model's reply entirely; the parse and apply logic is the plugin's.
//
//   node scripts/apply-staged-patch.cjs <patch-file> <relative-target> [base-dir]
const fs = require('node:fs')
const path = require('node:path')

const PLUGIN = path.resolve(__dirname, '..', 'plugin')
const { parseSearchReplaceBlocks, applySearchReplaceBlocks } = require(
  path.join(PLUGIN, 'dist', 'index.js')
)

const patchFile = process.argv[2]
const target = process.argv[3]
const baseDir = process.argv[4] || path.resolve(__dirname, '..')

if (!patchFile || !target) {
  console.error('usage: node scripts/apply-staged-patch.cjs <patch-file> <relative-target> [base-dir]')
  process.exit(2)
}

const body = fs.readFileSync(patchFile, 'utf8')
const blocks = parseSearchReplaceBlocks(body)
if (!blocks || blocks.length === 0) {
  console.error('APPLY_FAILED: not a complete search/replace patch: ' + patchFile)
  process.exit(1)
}

const targetPath = path.resolve(baseDir, target)
const original = fs.readFileSync(targetPath, 'utf8')
const applied = applySearchReplaceBlocks(original, blocks)
if (!applied.ok) {
  console.error('APPLY_FAILED: ' + applied.reason)
  process.exit(1)
}

fs.writeFileSync(targetPath, applied.content, 'utf8')
console.log('APPLIED ' + blocks.length + ' hunk(s) to ' + targetPath)
