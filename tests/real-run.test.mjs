// End-to-end check that really runs npm.
//
// Run with: npm run test:e2e
//
// This is the one suite that spawns a real child process, because the thing
// worth proving cannot be faked: that `npm run <script>` starts correctly from
// this host's own spawn options (a Windows shell, a `.cmd` shim, a detached
// process group) and that a stop really reaps the tree. It is kept out of
// `npm test` so the default suite stays fast and offline.
//
// Every child is stopped or has already exited before the suite ends.

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ROUTE_PREFIX, createFsPort, createRunPublisher, handleRequest, resolveConfig } from '../lib/index.js'
import { createJobsBridge } from '../lib/jobs.js'
import { createRunner } from '../lib/runner.js'

let passed = 0
let failed = 0

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}`)
    console.log(`       ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** A runner using the real `node:child_process` spawn and the real platform. */
function realDeps() {
  const runner = createRunner({ maxJobs: 12, maxRunning: 6, bufferBytes: 256 * 1024 })
  const bridge = createJobsBridge({ runner })
  return {
    io: createFsPort(),
    runner,
    bridge,
    config: resolveConfig({}),
    trustedHosts: () => [],
    sessions: () => ({}),
    // This harness has no jobs/agents services, so every run stays plugin-only
    // — which is itself worth exercising against a real process.
    publishRun: createRunPublisher({ getJobs: () => undefined, getAgents: () => undefined, bridge }),
    // No registry to tell, so a panel stop must go through quietly as 'unmanaged'.
    noteUserStop: (request) => bridge.release({ jobs: undefined, runId: request.runId, reason: request.reason }),
  }
}

/** Call the plugin handler without a socket. */
async function call(deps, { method = 'GET', url, body }) {
  const chunks = body === undefined ? [] : [JSON.stringify(body)]
  const req = {
    method,
    url,
    headers: { host: '127.0.0.1:55860' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield Buffer.from(chunk)
    },
  }
  let status = 0
  let text = ''
  const res = {
    writableEnded: false,
    writeHead(code) {
      status = code
    },
    end(payload) {
      text = payload ?? ''
      this.writableEnded = true
    },
  }
  await handleRequest(req, res, deps)
  return { status, body: JSON.parse(text) }
}

/** Poll one run until it settles or the budget runs out. */
async function settle(deps, id, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { body } = await call(deps, { url: `${ROUTE_PREFIX}/job?id=${id}` })
    if (body.value.job.status !== 'running' && body.value.job.status !== 'stopping') return body.value.job
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
  throw new Error(`run ${id} did not settle within ${timeoutMs}ms`)
}

// ── Fixture ────────────────────────────────────────────────────────────────
const ws = await mkdtemp(join(tmpdir(), 'dsh-npm-runner-e2e-'))
await writeFile(join(ws, 'print.js'), "console.log('npm-runner-ok'); console.log('second line');\n", 'utf8')
await writeFile(join(ws, 'fail.js'), 'process.exit(3)\n', 'utf8')
await writeFile(join(ws, 'stay.js'), 'setTimeout(() => {}, 300000)\n', 'utf8')
await writeFile(join(ws, 'package.json'), JSON.stringify({
  name: 'e2e-workspace',
  version: '1.0.0',
  scripts: {
    hello: 'node print.js',
    fail: 'node fail.js',
    stay: 'node stay.js',
  },
}, null, 2), 'utf8')

const deps = realDeps()

console.log(`real npm run on ${process.platform}`)

await test('scans the fixture workspace', async () => {
  const { status, body } = await call(deps, { url: `${ROUTE_PREFIX}/state?cwd=${encodeURIComponent(ws)}` })
  assert.equal(status, 200)
  assert.deepEqual(body.value.packages[0].scripts.map((s) => s.name).sort(), ['fail', 'hello', 'stay'])
  assert.equal(body.value.packageManager, 'npm')
})

await test('runs a script for real and captures its output', async () => {
  const started = await call(deps, { method: 'POST', url: `${ROUTE_PREFIX}/run`, body: { cwd: ws, dir: ws, script: 'hello' } })
  assert.equal(started.status, 200, JSON.stringify(started.body))
  const settled = await settle(deps, started.body.value.job.id, 60_000)
  assert.equal(settled.status, 'completed', `output was:\n${settled.output}`)
  assert.equal(settled.exitCode, 0)
  assert.match(settled.output, /npm-runner-ok/)
  assert.match(settled.output, /second line/)
})

await test('reports a non-zero exit as failed', async () => {
  const started = await call(deps, { method: 'POST', url: `${ROUTE_PREFIX}/run`, body: { cwd: ws, dir: ws, script: 'fail' } })
  const settled = await settle(deps, started.body.value.job.id, 60_000)
  assert.equal(settled.status, 'failed')
  assert.equal(settled.exitCode, 3)
})

await test('stops a long-running script and reaps the process tree', async () => {
  const started = await call(deps, { method: 'POST', url: `${ROUTE_PREFIX}/run`, body: { cwd: ws, dir: ws, script: 'stay' } })
  const id = started.body.value.job.id
  // Give the child a moment to actually be alive before stopping it.
  await new Promise((resolve) => setTimeout(resolve, 700))
  const live = await call(deps, { url: `${ROUTE_PREFIX}/job?id=${id}` })
  assert.equal(live.body.value.job.status, 'running')

  const stopped = await call(deps, { method: 'POST', url: `${ROUTE_PREFIX}/stop`, body: { id } })
  assert.equal(stopped.body.value.status, 'requested')

  const settled = await settle(deps, id, 30_000)
  assert.equal(settled.status, 'killed', `expected killed, saw ${settled.status}`)
  assert.ok(settled.finishedAt >= settled.startedAt)
})

await test('a second stop of the same run is a no-op', async () => {
  const started = await call(deps, { method: 'POST', url: `${ROUTE_PREFIX}/run`, body: { cwd: ws, dir: ws, script: 'hello' } })
  const id = started.body.value.job.id
  await settle(deps, id, 60_000)
  const again = await call(deps, { method: 'POST', url: `${ROUTE_PREFIX}/stop`, body: { id } })
  assert.equal(again.body.value.status, 'already-finished')
})

await test('disposal stops anything still running', async () => {
  const started = await call(deps, { method: 'POST', url: `${ROUTE_PREFIX}/run`, body: { cwd: ws, dir: ws, script: 'stay' } })
  const id = started.body.value.job.id
  await new Promise((resolve) => setTimeout(resolve, 700))
  deps.runner.dispose()
  const settled = await settle(deps, id, 30_000)
  assert.equal(settled.status, 'killed')
})

await rm(ws, { recursive: true, force: true })

console.log('')
console.log(`${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
