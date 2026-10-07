// Diagnostic harness: ask the configured local worker exactly what `delegate_worker` asks it, then
// print the raw reply. `delegate_worker` never returns the raw text -- it parses, emits and reports
// only a summary -- so when an emission is refused, the bytes the model produced are otherwise
// invisible, and a prompt problem cannot be told from a parse problem.
//
//   node scripts/probe-worker.cjs <instruction-file> [model]
//
// Operator tool. Not part of the plugin surface.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const PLUGIN = path.resolve(__dirname, '..', 'plugin')
const { delegateWorker } = require(path.join(PLUGIN, 'dist', 'index.js'))

const instructionPath = process.argv[2]
const model = process.argv[3]

process.env.DSH_LOCAL_ROUTER_RAW_VERIFICATION = '1'

if (!instructionPath) {
  console.error('usage: node scripts/probe-worker.cjs <instruction-file> [model]')
  process.exit(2)
}

const instruction = fs.readFileSync(instructionPath, 'utf8')

delegateWorker({
  taskName: 'probe-worker-output',
  instruction,
  ...(model ? { model } : {}),
  // A workspace that does not exist keeps the probe honest: it must never be able to write into the
  // repository, whatever the model returns.
  workspaceDir: path.join(os.tmpdir(), 'dsh-probe-nothing-here'),
  timeoutMs: 900000,
})
  .then((verdict) => {
    console.log('=== VERDICT ===')
    console.log(JSON.stringify(verdict, null, 2).slice(0, 6000))
  })
  .catch((err) => {
    console.error('PROBE_FAILED', err)
    process.exit(1)
  })
