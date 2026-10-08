// Independent check of a judge's fairness. Used once per task, then kept as the record.
//
// It copies a judge and a reference implementation into a scratch tree under the system temp
// directory, runs the judge, then runs it again against several deliberately broken versions of the
// reference. The repository is never the scratch area.
//
// The point is that the judge's author is not the judge's verifier. A suite that has only ever been
// seen passing is not evidence of anything: it must also be shown red on a plausible mistake, which is
// what the mutation runs below establish.
//
// Usage:
//   node verify-judge.cjs <judge.cjs> <relModuleFromScratch> <scratchName>
//     e.g. node verify-judge.cjs experiments/delegation-ab/tests/spec-conformance-2.test.cjs src/aggregation-window.js aggwin
//
// Exit 0 means: green on a correct implementation, red on every mutation.

'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const [judgePath, relModule, scratchName] = process.argv.slice(2)
if (!judgePath || !relModule || !scratchName) {
  console.error('usage: node verify-judge.cjs <judge.cjs> <relModuleFromScratch> <scratchName>')
  process.exit(2)
}

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const judgeSource = path.resolve(repoRoot, judgePath)
const referenceSource = path.join(__dirname, 'reference-window.js') // lives beside this file, outside the repo
if (!fs.existsSync(judgeSource)) {
  console.error('no judge at ' + judgeSource)
  process.exit(2)
}
if (!fs.existsSync(referenceSource)) {
  console.error('no reference at ' + referenceSource)
  process.exit(2)
}

const scratch = path.join(os.tmpdir(), 'judge-check', scratchName)
fs.rmSync(scratch, { recursive: true, force: true })
fs.mkdirSync(path.join(scratch, 'src'), { recursive: true })
fs.mkdirSync(path.join(scratch, 'tests'), { recursive: true })

const judgeName = path.basename(judgeSource)
fs.copyFileSync(judgeSource, path.join(scratch, 'tests', judgeName))
const referenceText = fs.readFileSync(referenceSource, 'utf8')
const moduleFile = path.join(scratch, relModule)

function run(label, mode) {
  fs.writeFileSync(moduleFile, referenceText)
  // The source the judge loads is the file above; the mutation is selected through the environment so
  // that one reviewed reference is the only implementation in play.
  const env = { ...process.env, WINDOW_MUTATION: mode }
  delete env.NODE_TEST_CONTEXT
  const result = spawnSync(process.execPath, ['--test', path.join('tests', judgeName)], {
    cwd: scratch,
    encoding: 'utf8',
    env,
  })
  const out = (result.stdout || '') + (result.stderr || '')
  const pass = /^# pass (\d+)/m.exec(out)
  const fail = /^# fail (\d+)/m.exec(out)
  const caught = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1].trim())
  const green = result.status === 0 && pass && Number(pass[1]) > 0
  console.log(
    String(label).padEnd(30) +
      'pass=' + (pass ? pass[1] : '?') +
      ' fail=' + (fail ? fail[1] : '?') +
      (green ? '  [green]' : '  [red]')
  )
  if (!green) for (const name of caught) console.log('      caught by: ' + name)
  if (!pass) console.log('      (no TAP summary -- the run did not execute)\n' + out.slice(-1200))
  return { green, caught }
}

const MUTATIONS = [
  ['none (reference)', 'none'],
  ['evicts newest', 'evict-newest'],
  ['never expires for age', 'no-age-expiry'],
  ['windowMs itself retained', 'boundary-inclusive'],
  ['observation mutates', 'count-removes'],
  ['zero-seeded min/max', 'min-max-zero'],
  ['capacity discard counted as age', 'capacity-as-expired'],
]

let broken = 0
const baseline = run(MUTATIONS[0][0], MUTATIONS[0][1])
if (!baseline.green) {
  console.log('\nFAIL: the judge rejects a correct implementation. It is unfair, and unfair means unfixable by any arm.')
  process.exit(1)
}

for (const [label, mode] of MUTATIONS.slice(1)) {
  const outcome = run(label, mode)
  if (outcome.green) {
    console.log('      NOT CAUGHT -- the judge lets this mistake through')
    broken += 1
  }
}

fs.rmSync(scratch, { recursive: true, force: true })

if (broken === 0) {
  console.log('\nOK: green on a correct implementation, red on all ' + (MUTATIONS.length - 1) + ' mutations.')
  process.exit(0)
}
console.log('\nWEAK: ' + broken + ' mutation(s) survived. The judge has a hole; fix it before freezing.')
process.exit(1)
