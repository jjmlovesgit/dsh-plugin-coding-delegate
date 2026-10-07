// Diagnostic: apply a search/replace patch that is too fence-heavy to survive as a model reply.
// `extractAndEmitFiles` scans fenced blocks with a non-greedy regex, so a patch whose SEARCH text
// contains three backticks has its body cut off at the first backtick pair. Staging the same patch in
// a file sidesteps the model's reply entirely: the harness reads the file, hands the text straight to
// the plugin's own patch primitives, and reports what they did.
//
//   node scripts/apply-patch.cjs <patch-markdown-file> <relative-target> [base-dir]
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
  console.error('usage: node scripts/apply-patch.cjs <patch-markdown-file> <relative-target> [base-dir]')
  process.exit(2)
}

const FENCE = '\x60\x60\x60'
const text = fs.readFileSync(patchFile, 'utf8')

// Take the fenced block that carries the patch, then the text inside it.
const start = text.indexOf(FENCE)
const end = text.indexOf(FENCE, start + FENCE.length)
if (start === -1 || end === -1) {
  console.error('APPLY_FAILED: no fenced block found in ' + patchFile)
  process.exit(1)
}
const body = text.slice(start + FENCE.length, end)

const blocks = parseSearchReplaceBlocks(body)
if (!blocks || blocks.length === 0) {
  console.error('APPLY_FAILED: the staged text is not a complete search/replace patch')
  console.error(JSON.stringify(body.slice(0, 400)))
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
