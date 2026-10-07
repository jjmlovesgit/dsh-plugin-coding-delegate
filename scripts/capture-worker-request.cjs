// Diagnostic: stand up an OpenAI-compatible endpoint that dumps the exact request body the plugin
// sends to the worker, then answer with the content of a reply file. The plugin reports only a
// summary of a delegation, never the prompt it transmitted, so this is the way to see it.
//
//   node scripts/capture-worker-request.cjs <out-prefix> <reply-file>
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const PLUGIN = path.resolve(__dirname, '..', 'plugin')
const { delegateWorker } = require(path.join(PLUGIN, 'dist', 'index.js'))

const outPrefix = process.argv[2]
const replyFile = process.argv[3]

if (!outPrefix || !replyFile) {
  console.error('usage: node scripts/capture-worker-request.cjs <out-prefix> <reply-file>')
  process.exit(2)
}

const reply = fs.readFileSync(replyFile, 'utf8')

const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    fs.writeFileSync(outPrefix + '.request.json', Buffer.concat(chunks).toString('utf8'), 'utf8')
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: reply } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    )
  })
})

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port
  try {
    const verdict = await delegateWorker({
      taskName: 'capture-worker-request',
      instruction: 'CAPTURE-ME',
      targetFiles: ['plugin/src/index.ts'],
      endpoint: 'http://127.0.0.1:' + port + '/v1',
      workspaceDir: path.join(os.tmpdir(), 'dsh-capture-nothing'),
      timeoutMs: 30000,
    })
    console.log(JSON.stringify(verdict, null, 2).slice(0, 1500))
  } catch (err) {
    console.error('CAPTURE_FAILED', err)
  } finally {
    server.close()
  }
})
