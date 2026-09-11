// End-to-end tests that run the `examples/` fixtures through the plugin's own
// run registry, with real child processes.
//
// Run with: npm run test:e2e
//
// The fixtures exist so the plugin's behaviour can be *seen* in the DSH page:
// a live service, a streamer, a high-volume writer, a process tree, a failure
// and a working-directory probe. This suite makes them load-bearing instead of
// decorative — every fixture is asserted here, including a real HTTP request
// against the service the plugin started, and a real check that stopping a run
// also reaped its grandchild.
//
// Everything started here is stopped before the suite ends.

import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const EXAMPLES = join(ROOT, 'examples')

function makeDeps() {
  const runner = createRunner({ maxJobs: 20, maxRunning: 10, bufferBytes: 64 * 1024 })
  const bridge = createJobsBridge({ runner })
  return {
    runner,
    io: createFsPort(),
    config: resolveConfig({}),
    trustedHosts: () => [],
    sessions: () => ({}),
    // No jobs/agents services here, so every run stays plugin-only.
    publishRun: createRunPublisher({ getJobs: () => undefined, getAgents: () => undefined, bridge }),
    // No registry to tell, so a panel stop must go through quietly as 'unmanaged'.
    noteUserStop: (request) => bridge.release({ jobs: undefined, runId: request.runId, reason: request.reason }),
  }
}

/** Call the plugin handler without a socket. */
async function call(deps, { method = 'GET', url, body }) {
  const chunks = body === undefined ? [] : [JSON.stringify(body)]
  const request = {
    method,
    url,
    headers: { host: '127.0.0.1:55860' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield Buffer.from(chunk)
    },
  }
  let status = 0
  let text = ''
  const response = {
    writableEnded: false,
    writeHead(code) {
      status = code
    },
    end(payload) {
      text = payload ?? ''
      this.writableEnded = true
    },
  }
  await handleRequest(request, response, deps)
  return { status, body: JSON.parse(text) }
}

/** Start one fixture script from the examples package. */
async function start(deps, script) {
  const started = await call(deps, {
    method: 'POST',
    url: `${ROUTE_PREFIX}/run`,
    body: { cwd: ROOT, dir: EXAMPLES, script },
  })
  assert.equal(started.status, 200, `${script}: ${JSON.stringify(started.body)}`)
  return started.body.value.job.id
}

/** One run's current record. */
async function see(deps, id) {
  const { body } = await call(deps, { url: `${ROUTE_PREFIX}/job?id=${id}` })
  return body.value.job
}

/** Poll one run until its output matches, or the budget runs out. */
async function waitForOutput(deps, id, pattern, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    const job = await see(deps, id)
    last = job.output ?? ''
    const match = pattern.exec(last)
    if (match !== null) return { job, match }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`output never matched ${pattern} within ${timeoutMs}ms; saw:\n${last}`)
}

/** Poll one run until it settles. */
async function settle(deps, id, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const job = await see(deps, id)
    if (job.status !== 'running' && job.status !== 'stopping') return job
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`run ${id} did not settle within ${timeoutMs}ms`)
}

/** Whether a pid is still alive. */
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Wait for a pid to disappear. */
async function waitForGone(pid, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!alive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return !alive(pid)
}

const deps = makeDeps()

console.log('examples: the fixtures the DSH page is meant to show')

await test('the examples package is discovered as its own package group', async () => {
  const { status, body } = await call(deps, { url: `${ROUTE_PREFIX}/state?cwd=${encodeURIComponent(ROOT)}` })
  assert.equal(status, 200)
  const examples = body.value.packages.find((pkg) => pkg.relDir === 'examples')
  assert.ok(examples !== undefined, `expected an "examples" package, saw ${JSON.stringify(body.value.packages.map((p) => p.relDir))}`)
  assert.equal(examples.name, 'dsh-npm-runner-examples')
  assert.deepEqual(
    examples.scripts.map((script) => script.name).sort(),
    ['chatty', 'fail', 'serve', 'stream', 'tree', 'where'],
  )
})

await test('where: a script runs in its own package directory', async () => {
  const id = await start(deps, 'where')
  const settled = await settle(deps, id)
  assert.equal(settled.status, 'completed', settled.output)
  assert.equal(settled.exitCode, 0)
  assert.ok(settled.output.includes(EXAMPLES), `expected the examples dir in:\n${settled.output}`)
  assert.match(settled.output, /package\.json here\s+dsh-npm-runner-examples/)
  assert.match(settled.output, /owns this script\s+yes/)
  assert.match(settled.output, /npm_lifecycle_event where/)
})

await test('stream: output arrives while it runs, then it completes', async () => {
  const id = await start(deps, 'stream')
  // Catch it mid-flight: the first step must land well before the last.
  const { job: early } = await waitForOutput(deps, id, /step\s+1\/24/)
  assert.equal(early.status, 'running', 'the first step should arrive while the run is still live')
  assert.equal(early.finishedAt, undefined)

  const settled = await settle(deps, id)
  assert.equal(settled.status, 'completed', settled.output)
  assert.match(settled.output, /step\s+24\/24/)
  assert.match(settled.output, /100%/)
  assert.match(settled.output, /finished 24 steps — exiting 0/)
  assert.equal(settled.truncated, false, 'a short stream must not be truncated')
})

await test('fail: a non-zero exit is reported with its code and merged streams', async () => {
  const id = await start(deps, 'fail')
  const settled = await settle(deps, id)
  assert.equal(settled.status, 'failed')
  assert.equal(settled.exitCode, 3)
  assert.match(settled.output, /about to fail on purpose/, 'stdout is retained')
  assert.match(settled.output, /this line goes to stderr/, 'stderr is merged into the same stream')
  assert.match(settled.output, /exiting with code 3/)
})

await test('chatty: high-volume output is bounded and flagged truncated', async () => {
  const id = await start(deps, 'chatty')
  const settled = await settle(deps, id)
  assert.equal(settled.status, 'completed', settled.output)
  assert.equal(settled.truncated, true, 'the retention cap must have been hit')
  assert.ok(settled.outputBytes <= deps.config.bufferBytes + 4096, `retained ${settled.outputBytes} bytes`)
  // The tail survives; the head does not.
  assert.match(settled.output, /done: wrote 20000 lines/)
  assert.equal(settled.output.includes('line      1 '), false, 'the oldest output should have been dropped')
})

await test('tree: stopping a run also reaps its grandchild', async () => {
  const id = await start(deps, 'tree')
  const { match } = await waitForOutput(deps, id, /spawned worker pid=(\d+)/)
  const workerPid = Number(match[1])
  assert.ok(workerPid > 0)
  assert.equal(alive(workerPid), true, 'the worker should be running before the stop')
  // Give the worker a moment to prove it is producing output of its own.
  await waitForOutput(deps, id, /worker tick #1/)

  const stopped = await call(deps, { method: 'POST', url: `${ROUTE_PREFIX}/stop`, body: { id } })
  assert.equal(stopped.body.value.status, 'requested')

  const settled = await settle(deps, id)
  assert.equal(settled.status, 'killed', `expected killed, saw ${settled.status}`)
  assert.equal(await waitForGone(workerPid), true, `worker pid ${workerPid} survived the stop`)
})

await test('serve: a long-lived service runs, streams and answers requests', async () => {
  const id = await start(deps, 'serve')
  const { job: listening, match } = await waitForOutput(deps, id, /listening on (http:\/\/127\.0\.0\.1:\d+)/)
  assert.equal(listening.status, 'running', 'a service must still be live after it announces itself')
  const base = match[1]

  // It really is serving: hit it twice and watch its own request counter move.
  const health = await fetch(`${base}/health`)
  assert.equal(health.status, 200)
  const payload = await health.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.requests, 1)

  const page = await fetch(`${base}/`)
  assert.match(await page.text(), /dsh-npm-runner example service/)

  const second = await (await fetch(`${base}/health`)).json()
  assert.equal(second.requests, 3, 'the service keeps counting between requests')

  // And it keeps talking on its own, which is what the popover's live pane shows.
  const { job: beating } = await waitForOutput(deps, id, /heartbeat #1/)
  assert.equal(beating.status, 'running')
  assert.match(beating.output, /heartbeat #\d+ · up \d+s · \d+ request\(s\)/)

  const stopped = await call(deps, { method: 'POST', url: `${ROUTE_PREFIX}/stop`, body: { id } })
  assert.equal(stopped.body.value.status, 'requested')
  const settled = await settle(deps, id)
  assert.equal(settled.status, 'killed', `expected killed, saw ${settled.status}`)

  // The port is free again once the run is stopped.
  await assert.rejects(fetch(`${base}/health`), 'the service should be gone after a stop')
})

await test('every fixture run is retained and listable', async () => {
  const { body } = await call(deps, { url: `${ROUTE_PREFIX}/jobs` })
  const scripts = new Set(body.value.jobs.map((job) => job.script))
  for (const script of ['where', 'stream', 'fail', 'chatty', 'tree', 'serve']) {
    assert.ok(scripts.has(script), `expected a retained run for ${script}`)
  }
})

deps.runner.dispose()

console.log('')
console.log(`${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
