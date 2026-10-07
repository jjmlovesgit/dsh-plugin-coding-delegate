// Diagnostic: drive `delegateWorker` against a real model reply, with the plugin's exact request.
// The plugin reports only a verdict, so when a patch is refused the bytes the model returned are
// otherwise invisible. This harness tees the request, forwards it to the real worker, tees the reply
// and hands the reply back, so one flaky parse can be inspected instead of guessed at.
//
//   node scripts/simulate-worker.cjs <out-prefix> <instruction-file>
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const PLUGIN = path.resolve(__dirname, '..', 'plugin')
const { delegateWorker } = require(path.join(PLUGIN, 'dist', 'index.js'))

const outPrefix = process.argv[2]
const instructionFile = process.argv[3]

if (!outPrefix || !instructionFile) {
  console.error('usage: node scripts/simulate-worker.cjs <out-prefix> <instruction-file>')
  process.exit(2)
}

const instruction = fs.readFileSync(instructionFile, 'utf8')

const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', async () => {
    const bodyText = Buffer.concat(chunks).toString('utf8')
    fs.writeFileSync(outPrefix + '.request.json', bodyText, 'utf8')

    let parsed = {}
    try {
      parsed = JSON.parse(bodyText)
    } catch {}
    if (parsed.model) {
      fs.writeFileSync(outPrefix + '.model.txt', String(parsed.model), 'utf8')
    }

    try {
      const upstreamRes = await fetch('http://127.0.0.1:1234/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: bodyText,
      })
      const text = await upstreamRes.text()
      fs.writeFileSync(outPrefix + '.response.json', text, 'utf8')
      res.writeHead(upstreamRes.status, { 'Content-Type': 'application/json' })
      res.end(text)
    } catch (err) {
      fs.writeFileSync(outPrefix + '.error.txt', String(err), 'utf8')
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: String(err) }))
    }
  })
})

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port
  try {
    const verdict = await delegateWorker({
      taskName: 'simulate-worker',
      instruction,
      targetFiles: ['plugin/src/index.ts'],
      endpoint: 'http://127.0.0.1:' + port + '/v1',
      workspaceDir: 'C:\\Projects\\DSHLaya',
      timeoutMs: 900000,
    })
    console.log(JSON.stringify(verdict, null, 2).slice(0, 2500))
  } catch (err) {
    console.error('SIMULATE_FAILED', err)
  } finally {
    server.close()
  }
})
