// Integration tests for the host half's HTTP surface (lib/index.js).
//
// Run with: node tests/host.test.mjs
//
// Two layers, on purpose:
//   * a REAL node:http server driven by fetch, which proves the node:http
//     route contract end to end (the browser half depends on it);
//   * direct `handleRequest` calls against fake req/res objects, which makes
//     the error and fence paths deterministic instead of timing-dependent.
//
// The child process is still faked, so no `npm` is ever really run here.

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ROUTE_PREFIX, apply, createFsPort, createPluginState, createRunPublisher, handleRequest, isTrustedRequest, resolveConfig } from '../lib/index.js'
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

/** Fake spawn: records calls and hands back a child a test can drive. */
function createFakeSpawn() {
  const calls = []
  function spawn(command, args, options) {
    const listeners = new Map()
    const child = {
      pid: 500 + calls.length,
      stdout: { on: (event, handler) => listeners.set(`stdout:${event}`, [...(listeners.get(`stdout:${event}`) ?? []), handler]) },
      stderr: { on: (event, handler) => listeners.set(`stderr:${event}`, [...(listeners.get(`stderr:${event}`) ?? []), handler]) },
      on: (event, handler) => listeners.set(event, [...(listeners.get(event) ?? []), handler]),
      kill: () => true,
      emit(event, ...args) {
        for (const handler of listeners.get(event) ?? []) handler(...args)
      },
    }
    calls.push({ command, args, options, child })
    return child
  }
  spawn.calls = calls
  return spawn
}

const noSignals = { group: () => {}, process: () => {} }

/** Build request dependencies around fake spawn and an optional session store. */
function makeDeps(options = {}) {
  const spawn = options.spawn ?? createFakeSpawn()
  const store = options.sessions ?? {}
  const runner = createRunner({
    spawn,
    signals: options.signals ?? noSignals,
    platform: options.platform ?? 'linux',
    graceMs: 0,
    maxJobs: options.maxJobs ?? 12,
    maxRunning: options.maxRunning ?? 6,
    bufferBytes: options.bufferBytes ?? 4096,
    now: (() => { let t = 1_000; return () => (t += 100) })(),
  })
  // The real publisher, wired to fakes, so /run exercises the same code path
  // `apply` builds rather than a stand-in.
  const bridge = options.bridge ?? createJobsBridge({ runner })
  const publishRun = createRunPublisher({
    getJobs: () => options.jobs,
    getAgents: () => options.agents,
    bridge,
    enabled: options.registerJobs !== false,
    scope: options.jobScope,
  })
  return {
    spawn,
    runner,
    bridge,
    io: createFsPort(),
    config: resolveConfig(options.config ?? {}),
    trustedHosts: () => options.trustedHosts ?? [],
    sessions: () => ({ get: (id) => store[id] }),
    publishRun,
    // Mirrors the `noteUserStop` `apply` builds, so /stop exercises the real
    // release path rather than a stand-in.
    noteUserStop: (request) => bridge.release({
      jobs: options.jobs,
      runId: request.runId,
      reason: request.reason,
    }),
  }
}

/** A stand-in for DSH's `jobs` registry, recording every start and kill. */
function createFakeJobs() {
  const started = []
  const kills = []
  const jobs = {
    started,
    kills,
    attachController(name) {
      jobs.controllerName = name
      return () => {
        jobs.controllerReleased = true
      }
    },
    start(spec) {
      if (jobs.controllerName === undefined) throw new Error('background jobs unavailable: no job controller serves this agent')
      const hooks = spec.run()
      const id = `bash-${started.length + 1}`
      started.push({ id, spec, hooks })
      return id
    },
    kill(id, caller, reason) {
      kills.push({ id, caller, reason })
      return 'killed'
    },
  }
  return jobs
}

/** A minimal stand-in for node:http's IncomingMessage. */
function fakeReq({ method = 'GET', url = '/', headers = {}, chunks = [] } = {}) {
  return {
    method,
    url,
    headers: { host: '127.0.0.1:55860', ...headers },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield Buffer.from(chunk)
    },
  }
}

/** A minimal stand-in for node:http's ServerResponse. */
function fakeRes() {
  return {
    statusCode: 0,
    headers: undefined,
    body: '',
    writableEnded: false,
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
    },
    end(payload) {
      this.body = payload ?? ''
      this.writableEnded = true
    },
  }
}

/** Call the handler directly and decode the envelope. */
async function callDirect(deps, options) {
  return callHandler((req, res) => handleRequest(req, res, deps), options)
}

/** Call any request handler and decode the envelope it wrote. */
async function callHandler(handler, options) {
  const res = fakeRes()
  await handler(fakeReq(options), res)
  let parsed
  try {
    parsed = JSON.parse(res.body)
  } catch {
    parsed = undefined
  }
  return { status: res.statusCode, body: parsed }
}

/** Start a real HTTP server that dispatches into the plugin handler. */
async function serve(deps) {
  const server = createServer((req, res) => {
    handleRequest(req, res, deps).catch(() => {
      if (!res.writableEnded) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end('{"ok":false}')
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    port,
    base: `http://127.0.0.1:${port}${ROUTE_PREFIX}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** Read the JSON envelope of one fetch. */
async function read(response) {
  let body
  try {
    body = await response.json()
  } catch {
    body = undefined
  }
  return { status: response.status, body }
}

/** One raw node:http request, able to set headers fetch refuses to set. */
function raw(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers, setHost: false }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

// ── Fixture workspace ──────────────────────────────────────────────────────
const root = await mkdtemp(join(tmpdir(), 'dsh-npm-runner-host-'))
const ws = join(root, 'ws')
await mkdir(join(ws, 'node_modules', 'dep'), { recursive: true })
await mkdir(join(ws, 'packages', 'app'), { recursive: true })
await mkdir(join(ws, 'packages', 'empty'), { recursive: true })
await writeFile(join(ws, 'package.json'), JSON.stringify({
  name: 'ws-root',
  private: true,
  workspaces: ['packages/*'],
  scripts: { dev: 'vite', build: 'tsc -p .' },
}), 'utf8')
await writeFile(join(ws, 'node_modules', 'dep', 'package.json'), JSON.stringify({ name: 'dep', scripts: { evil: 'curl bad' } }), 'utf8')
await writeFile(join(ws, 'packages', 'app', 'package.json'), JSON.stringify({ name: 'app', scripts: { test: 'vitest run' } }), 'utf8')
await writeFile(join(ws, 'packages', 'app', 'pnpm-lock.yaml'), '', 'utf8')
await writeFile(join(ws, 'packages', 'empty', 'package.json'), JSON.stringify({ name: 'empty' }), 'utf8')

console.log('GET /state')

await test('reports the workspace scripts and never a node_modules one', async () => {
  const deps = makeDeps()
  const { status, body } = await callDirect(deps, { url: `${ROUTE_PREFIX}/state?cwd=${encodeURIComponent(ws)}` })
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.deepEqual(body.value.packages.map((pkg) => pkg.relDir), ['.', 'packages/app'])
  assert.deepEqual(body.value.packages[0].scripts.map((s) => s.name), ['dev', 'build'])
  assert.equal(body.value.scriptCount, 3)
  assert.equal(JSON.stringify(body.value).includes('evil'), false)
  assert.equal(body.value.packageManager, 'npm')
})

await test('a nested package reports its own lockfile-derived runner', async () => {
  const deps = makeDeps()
  const { body } = await callDirect(deps, { url: `${ROUTE_PREFIX}/state?cwd=${encodeURIComponent(ws)}` })
  const app = body.value.packages.find((pkg) => pkg.relDir === 'packages/app')
  assert.equal(app.name, 'app')
  assert.equal(app.scripts[0].name, 'test')
})

await test('a Session id resolves the workspace server-side and outranks the query', async () => {
  const deps = makeDeps({ sessions: { 's-1': { header: { cwd: ws } } } })
  const { body } = await callDirect(deps, {
    url: `${ROUTE_PREFIX}/state?cwd=${encodeURIComponent('C:/definitely/not/here')}&sessionId=s-1`,
  })
  assert.equal(body.value.cwd, ws)
  assert.equal(body.value.scriptCount, 3)
})

await test('an unresolvable Session id falls back to the supplied cwd', async () => {
  const deps = makeDeps({ sessions: {} })
  const { body } = await callDirect(deps, {
    url: `${ROUTE_PREFIX}/state?cwd=${encodeURIComponent(ws)}&sessionId=ghost`,
  })
  assert.equal(body.value.cwd, ws)
})

await test('rejects a request that names no workspace at all', async () => {
  const deps = makeDeps()
  const { status, body } = await callDirect(deps, { url: `${ROUTE_PREFIX}/state` })
  assert.equal(status, 400)
  assert.equal(body.error.code, 'bad-request')
})

await test('an unknown workspace scans to an empty snapshot, not an error', async () => {
  const deps = makeDeps()
  const { status, body } = await callDirect(deps, { url: `${ROUTE_PREFIX}/state?cwd=${encodeURIComponent(join(root, 'nope'))}` })
  assert.equal(status, 200)
  assert.deepEqual(body.value.packages, [])
  assert.equal(body.value.reason, 'unreadable')
})

console.log('POST /run, /stop and the run registry')

await test('starts a declared script with the package manager and returns a live run', async () => {
  const deps = makeDeps()
  const { status, body } = await callDirect(deps, {
    method: 'POST',
    url: `${ROUTE_PREFIX}/run`,
    chunks: [JSON.stringify({ cwd: ws, dir: ws, script: 'dev' })],
  })
  assert.equal(status, 200)
  assert.equal(body.value.job.status, 'running')
  assert.equal(body.value.job.label, 'npm run dev')
  assert.equal(body.value.job.workspace, ws)
  assert.equal(deps.spawn.calls.length, 1)
  assert.equal(deps.spawn.calls[0].command, 'npm')
  assert.deepEqual(deps.spawn.calls[0].args, ['run', 'dev'])
  assert.equal(deps.spawn.calls[0].options.cwd, ws)
})

await test('a pnpm workspace package runs through pnpm', async () => {
  const deps = makeDeps()
  const { body } = await callDirect(deps, {
    method: 'POST',
    url: `${ROUTE_PREFIX}/run`,
    chunks: [JSON.stringify({ cwd: ws, dir: join(ws, 'packages', 'app'), script: 'test' })],
  })
  assert.equal(body.value.job.command, 'pnpm')
  assert.equal(deps.spawn.calls[0].command, 'pnpm')
})

await test('refuses a script the manifest does not declare', async () => {
  const deps = makeDeps()
  const { status, body } = await callDirect(deps, {
    method: 'POST',
    url: `${ROUTE_PREFIX}/run`,
    chunks: [JSON.stringify({ cwd: ws, dir: ws, script: 'postinstall' })],
  })
  assert.equal(status, 400)
  assert.match(body.error.message, /no script named/)
  assert.equal(deps.spawn.calls.length, 0)
})

await test('refuses a directory outside the workspace', async () => {
  const deps = makeDeps()
  const { status } = await callDirect(deps, {
    method: 'POST',
    url: `${ROUTE_PREFIX}/run`,
    chunks: [JSON.stringify({ cwd: ws, dir: join(ws, '..', '..'), script: 'dev' })],
  })
  assert.equal(status, 400)
  assert.equal(deps.spawn.calls.length, 0)
})

await test('refuses a shell-metacharacter script name', async () => {
  const deps = makeDeps()
  const { status, body } = await callDirect(deps, {
    method: 'POST',
    url: `${ROUTE_PREFIX}/run`,
    chunks: [JSON.stringify({ cwd: ws, dir: ws, script: 'dev && echo pwned' })],
  })
  assert.equal(status, 400)
  assert.match(body.error.message, /invalid script name/)
  assert.equal(deps.spawn.calls.length, 0)
})

await test('carries run output through /job and settles the status on exit', async () => {
  const deps = makeDeps()
  const started = await callDirect(deps, {
    method: 'POST',
    url: `${ROUTE_PREFIX}/run`,
    chunks: [JSON.stringify({ cwd: ws, dir: ws, script: 'dev' })],
  })
  const id = started.body.value.job.id
  deps.spawn.calls[0].child.emit('stdout:data', Buffer.from('vite v5 ready\n'))
  const live = await callDirect(deps, { url: `${ROUTE_PREFIX}/job?id=${id}` })
  assert.equal(live.body.value.job.output, 'vite v5 ready\n')

  deps.spawn.calls[0].child.emit('exit', 0, null)
  const settled = await callDirect(deps, { url: `${ROUTE_PREFIX}/job?id=${id}` })
  assert.equal(settled.body.value.job.status, 'completed')
  assert.equal(settled.body.value.job.exitCode, 0)
})

await test('lists runs newest first without their output', async () => {
  const deps = makeDeps()
  const first = await callDirect(deps, { method: 'POST', url: `${ROUTE_PREFIX}/run`, chunks: [JSON.stringify({ cwd: ws, dir: ws, script: 'dev' })] })
  const second = await callDirect(deps, { method: 'POST', url: `${ROUTE_PREFIX}/run`, chunks: [JSON.stringify({ cwd: ws, dir: ws, script: 'build' })] })
  const { body } = await callDirect(deps, { url: `${ROUTE_PREFIX}/jobs` })
  assert.deepEqual(body.value.jobs.map((job) => job.id), [second.body.value.job.id, first.body.value.job.id])
  assert.equal('output' in body.value.jobs[0], false)
})

await test('stops a live run and reports the request', async () => {
  const deps = makeDeps()
  const started = await callDirect(deps, { method: 'POST', url: `${ROUTE_PREFIX}/run`, chunks: [JSON.stringify({ cwd: ws, dir: ws, script: 'dev' })] })
  const id = started.body.value.job.id
  const stopped = await callDirect(deps, { method: 'POST', url: `${ROUTE_PREFIX}/stop`, chunks: [JSON.stringify({ id })] })
  assert.equal(stopped.status, 200)
  assert.equal(stopped.body.value.status, 'requested')
  deps.spawn.calls[0].child.emit('exit', null, 'SIGTERM')
  const after = await callDirect(deps, { url: `${ROUTE_PREFIX}/job?id=${id}` })
  assert.equal(after.body.value.job.status, 'killed')
})

await test('an unknown run id is a 404', async () => {
  const deps = makeDeps()
  assert.equal((await callDirect(deps, { url: `${ROUTE_PREFIX}/job?id=ghost` })).status, 404)
  const stop = await callDirect(deps, { method: 'POST', url: `${ROUTE_PREFIX}/stop`, chunks: [JSON.stringify({ id: 'ghost' })] })
  assert.equal(stop.status, 404)
})

await test('refuses more concurrent runs than the configured limit', async () => {
  const deps = makeDeps({ maxRunning: 1 })
  await callDirect(deps, { method: 'POST', url: `${ROUTE_PREFIX}/run`, chunks: [JSON.stringify({ cwd: ws, dir: ws, script: 'dev' })] })
  const second = await callDirect(deps, { method: 'POST', url: `${ROUTE_PREFIX}/run`, chunks: [JSON.stringify({ cwd: ws, dir: ws, script: 'build' })] })
  assert.equal(second.status, 429)
  assert.equal(second.body.error.code, 'too-many-runs')
})

await test('clear drops finished runs and keeps live ones', async () => {
  const deps = makeDeps()
  const done = await callDirect(deps, { method: 'POST', url: `${ROUTE_PREFIX}/run`, chunks: [JSON.stringify({ cwd: ws, dir: ws, script: 'dev' })] })
  const live = await callDirect(deps, { method: 'POST', url: `${ROUTE_PREFIX}/run`, chunks: [JSON.stringify({ cwd: ws, dir: ws, script: 'build' })] })
  deps.spawn.calls[0].child.emit('exit', 0, null)

  const cleared = await callDirect(deps, { method: 'POST', url: `${ROUTE_PREFIX}/clear`, chunks: ['{}'] })
  assert.equal(cleared.status, 200)
  assert.equal(cleared.body.value.removed, 1)

  const listed = await callDirect(deps, { url: `${ROUTE_PREFIX}/jobs` })
  assert.deepEqual(listed.body.value.jobs.map((job) => job.id), [live.body.value.job.id])
  assert.equal(
    (await callDirect(deps, { url: `${ROUTE_PREFIX}/job?id=${done.body.value.job.id}` })).status,
    404,
    'a cleared run is gone',
  )
})

await test('clear also drops stopped runs, not just completed ones', async () => {
  const deps = makeDeps()
  await callDirect(deps, { method: 'POST', url: `${ROUTE_PREFIX}/run`, chunks: [JSON.stringify({ cwd: ws, dir: ws, script: 'dev' })] })
  const stoppedRun = await callDirect(deps, { method: 'POST', url: `${ROUTE_PREFIX}/run`, chunks: [JSON.stringify({ cwd: ws, dir: ws, script: 'build' })] })
  // One run finishes on its own; the other is stopped.
  deps.spawn.calls[0].child.emit('exit', 0, null)
  await callDirect(deps, { method: 'POST', url: `${ROUTE_PREFIX}/stop`, chunks: [JSON.stringify({ id: stoppedRun.body.value.job.id })] })
  deps.spawn.calls[1].child.emit('exit', null, 'SIGTERM')

  const statuses = (await callDirect(deps, { url: `${ROUTE_PREFIX}/jobs` })).body.value.jobs.map((job) => job.status).sort()
  assert.deepEqual(statuses, ['completed', 'killed'], 'both terminal states should be present')

  const cleared = await callDirect(deps, { method: 'POST', url: `${ROUTE_PREFIX}/clear`, chunks: ['{}'] })
  assert.equal(cleared.body.value.removed, 2, 'stopped is as clearable as completed')
  assert.deepEqual((await callDirect(deps, { url: `${ROUTE_PREFIX}/jobs` })).body.value.jobs, [])
})

await test('clear on an empty registry removes nothing', async () => {
  const deps = makeDeps()
  const cleared = await callDirect(deps, { method: 'POST', url: `${ROUTE_PREFIX}/clear`, chunks: ['{}'] })
  assert.equal(cleared.status, 200)
  assert.equal(cleared.body.value.removed, 0)
})

await test('clear rejects the wrong method', async () => {
  const deps = makeDeps()
  assert.equal((await callDirect(deps, { url: `${ROUTE_PREFIX}/clear` })).status, 405)
})

console.log('DSH background-job integration')

/** Deps with a live Agent for Session s-1, which `jobScope: 'session'` requires. */
function makeJobsDeps(overrides = {}) {
  const jobs = overrides.jobs ?? createFakeJobs()
  const agent = { id: 's-1' }
  const deps = makeDeps({
    jobs,
    agents: { get: (id) => (id === 's-1' ? agent : undefined) },
    ...overrides,
  })
  deps.bridge.attach(jobs)
  return { jobs, agent, deps }
}

/** Start `dev` from Session s-1 and return the decoded envelope. */
function runDev(deps, sessionId = 's-1') {
  return callDirect(deps, {
    method: 'POST',
    url: `${ROUTE_PREFIX}/run`,
    chunks: [JSON.stringify({ cwd: ws, dir: ws, script: 'dev', sessionId })],
  })
}

await test('a run is scoped to the Session by default', async () => {
  const { jobs, agent, deps } = makeJobsDeps()
  const { status, body } = await runDev(deps)
  assert.equal(status, 200)
  assert.equal(body.value.dshJobId, 'bash-1')
  assert.equal(jobs.started.length, 1)
  assert.equal(jobs.started[0].spec.kind, 'bash', 'JobKind is a closed union: only bash is valid')
  assert.equal(jobs.started[0].spec.label, 'npm run dev')
  // Owned. DSH's registry can only scope by owner, so this is the option that
  // cannot surface the run inside another workspace.
  assert.equal(jobs.started[0].spec.owner, agent)
})

await test('the DSH job mirrors output, idempotently', async () => {
  const { jobs, deps } = makeJobsDeps()
  await runDev(deps)
  deps.spawn.calls[0].child.emit('stdout:data', Buffer.from('vite ready\n'))
  deps.spawn.calls[0].child.emit('stderr:data', Buffer.from('warn\n'))
  const read = jobs.started[0].hooks
  assert.equal(read.readOutput(), 'vite ready\nwarn\n')
  assert.equal(read.readOutput(), 'vite ready\nwarn\n', 'a repeated read must not lose or duplicate text')
})

await test('the DSH job settles with the exit outcome', async () => {
  const { jobs, deps } = makeJobsDeps()
  await runDev(deps)
  deps.spawn.calls[0].child.emit('exit', 0, null)
  assert.deepEqual(await jobs.started[0].hooks.done, { status: 'completed', detail: 'exit code: 0' })
})

await test('a non-zero exit is reported as failed with its code', async () => {
  const { jobs, deps } = makeJobsDeps()
  await runDev(deps)
  deps.spawn.calls[0].child.emit('exit', 130, null)
  assert.deepEqual(await jobs.started[0].hooks.done, { status: 'failed', detail: 'exit code: 130' })
})

await test("DSH's cancel path stops the plugin's run", async () => {
  const { jobs, deps } = makeJobsDeps()
  await runDev(deps)
  jobs.started[0].hooks.cancel()
  assert.equal(deps.runner.list()[0].status, 'stopping')
  deps.spawn.calls[0].child.emit('exit', null, 'SIGTERM')
  assert.deepEqual(await jobs.started[0].hooks.done, { status: 'killed', detail: 'signal: SIGTERM' })
})

await test("a panel stop tells DSH the job is accounted for", async () => {
  const { jobs, agent, deps } = makeJobsDeps()
  const started = await runDev(deps)
  const id = started.body.value.job.id
  const stopped = await callDirect(deps, { method: 'POST', url: `${ROUTE_PREFIX}/stop`, chunks: [JSON.stringify({ id })] })
  assert.equal(stopped.status, 200)
  // `jobs.kill` is the registry's "already accounted for" path: it marks the
  // record reported before settling, which is what keeps `dsh-tool-jobs` from
  // injecting a completion notice — and waking the agent — for a deliberate stop.
  assert.deepEqual(jobs.kills, [{ id: 'bash-1', caller: agent, reason: 'stopped from the panel' }])
  deps.spawn.calls[0].child.emit('exit', null, 'SIGTERM')
  assert.equal(deps.runner.get(id).status, 'killed')
})

await test('a panel stop signals the process tree exactly once', async () => {
  const signals = { calls: [], group(pid, signal) { signals.calls.push({ pid, signal }) }, process(pid, signal) { signals.calls.push({ pid, signal }) } }
  const jobs = createFakeJobs()
  const agent = { id: 's-1' }
  const deps = makeDeps({ jobs, agents: { get: (id) => (id === 's-1' ? agent : undefined) }, signals })
  deps.bridge.attach(jobs)
  const started = await runDev(deps)
  await callDirect(deps, {
    method: 'POST',
    url: `${ROUTE_PREFIX}/stop`,
    chunks: [JSON.stringify({ id: started.body.value.job.id })],
  })
  // The route stops the run, then `release` -> `jobs.kill` -> the job's cancel
  // hook calls back into the same stop. That second call must not re-signal.
  assert.equal(signals.calls.length, 1)
})

await test('a run that ends on its own is left reported, so DSH still notifies', async () => {
  const { jobs, deps } = makeJobsDeps()
  await runDev(deps)
  deps.spawn.calls[0].child.emit('exit', 0, null)
  assert.deepEqual(jobs.kills, [], 'an unrequested finish must keep its notice')
})

await test('stopping a plugin-only run does not require a registry', async () => {
  const deps = makeDeps()
  const started = await callDirect(deps, { method: 'POST', url: `${ROUTE_PREFIX}/run`, chunks: [JSON.stringify({ cwd: ws, dir: ws, script: 'dev' })] })
  const stopped = await callDirect(deps, {
    method: 'POST',
    url: `${ROUTE_PREFIX}/stop`,
    chunks: [JSON.stringify({ id: started.body.value.job.id })],
  })
  assert.equal(stopped.status, 200)
  assert.equal(stopped.body.value.status, 'requested')
})

await test('the default stays plugin-only without a live agent', async () => {
  const jobs = createFakeJobs()
  const deps = makeDeps({ jobs, agents: { get: () => undefined } })
  deps.bridge.attach(jobs)
  const { status, body } = await runDev(deps)
  assert.equal(status, 200)
  assert.equal(body.value.dshJobId, undefined)
  assert.equal(jobs.started.length, 0, 'a Session-scoped job needs a live owner to scope it to')
})

await test("jobScope:'global' registers without an owner and needs no agent", async () => {
  const jobs = createFakeJobs()
  const deps = makeDeps({ jobs, agents: { get: () => undefined }, jobScope: 'global' })
  deps.bridge.attach(jobs)
  const { status, body } = await runDev(deps)
  assert.equal(status, 200)
  assert.equal(body.value.dshJobId, 'bash-1')
  assert.equal(jobs.started.length, 1)
  assert.equal('owner' in jobs.started[0].spec, false, 'a global job must not carry an owner key')
})

await test("jobScope:'global' also works when a live agent exists", async () => {
  const { jobs, deps } = makeJobsDeps({ jobScope: 'global' })
  const { body } = await runDev(deps)
  assert.equal(body.value.dshJobId, 'bash-1')
  assert.equal('owner' in jobs.started[0].spec, false)
})

await test('a deployment without the jobs registry stays plugin-only', async () => {
  const deps = makeDeps({ agents: { get: () => ({ id: 's-1' }) } })
  const { status, body } = await runDev(deps)
  assert.equal(status, 200)
  assert.equal(body.value.dshJobId, undefined)
})

await test('registerJobs:false disables the integration entirely', async () => {
  const { jobs, deps } = makeJobsDeps({ registerJobs: false })
  const { status, body } = await runDev(deps)
  assert.equal(status, 200)
  assert.equal(body.value.dshJobId, undefined)
  assert.equal(jobs.started.length, 0)
})

await test('a registry that refuses the start degrades to plugin-only', async () => {
  const jobs = {
    started: [],
    attachController: () => () => {},
    start() {
      throw new Error('background job limit reached for this owner')
    },
  }
  const deps = makeDeps({ jobs, agents: { get: () => ({ id: 's-1' }) } })
  deps.bridge.attach(jobs)
  const { status, body } = await runDev(deps)
  assert.equal(status, 200, 'a failed registration must not fail the run')
  assert.equal(body.value.dshJobId, undefined)
  assert.equal(body.value.job.status, 'running')
})

console.log('routing, methods and bodies')

await test('an unknown action is a 404', async () => {
  const deps = makeDeps()
  assert.equal((await callDirect(deps, { url: `${ROUTE_PREFIX}/nope` })).status, 404)
  assert.equal((await callDirect(deps, { url: '/elsewhere' })).status, 404)
})

await test('the wrong method is a 405', async () => {
  const deps = makeDeps()
  const state = await callDirect(deps, { method: 'POST', url: `${ROUTE_PREFIX}/state`, chunks: ['{}'] })
  assert.equal(state.status, 405)
  assert.equal(state.body.error.code, 'method-error')
  const run = await callDirect(deps, { url: `${ROUTE_PREFIX}/run` })
  assert.equal(run.status, 405)
})

await test('a malformed JSON body is a 400', async () => {
  const deps = makeDeps()
  const { status, body } = await callDirect(deps, { method: 'POST', url: `${ROUTE_PREFIX}/run`, chunks: ['{ not json'] })
  assert.equal(status, 400)
  assert.equal(body.error.code, 'bad-request')
})

await test('an oversized body is a 413', async () => {
  const deps = makeDeps()
  const { status, body } = await callDirect(deps, {
    method: 'POST',
    url: `${ROUTE_PREFIX}/run`,
    chunks: [JSON.stringify({ blob: 'x'.repeat(70 * 1024) })],
  })
  assert.equal(status, 413)
  assert.equal(body.error.code, 'too-large')
})

await test('a missing required field is a 400', async () => {
  const deps = makeDeps()
  const { status } = await callDirect(deps, { method: 'POST', url: `${ROUTE_PREFIX}/run`, chunks: [JSON.stringify({ cwd: ws, dir: ws })] })
  assert.equal(status, 400)
})

console.log('trust fence')

await test('the fence accepts loopback and trusted authorities', () => {
  assert.equal(isTrustedRequest({ host: '127.0.0.1:55860' }, []), true)
  assert.equal(isTrustedRequest({ host: 'localhost' }, []), true)
  assert.equal(isTrustedRequest({ host: '127.0.0.1:55860', origin: 'http://127.0.0.1:55860' }, []), true)
  assert.equal(isTrustedRequest({ host: 'dsh.example.com:443' }, ['dsh.example.com:443']), true)
})

await test('the fence refuses foreign hosts and cross-site markers', () => {
  assert.equal(isTrustedRequest({ host: 'evil.example.com' }, []), false)
  assert.equal(isTrustedRequest({}, []), false)
  assert.equal(isTrustedRequest({ host: 'not a host' }, []), false)
  assert.equal(isTrustedRequest({ host: '127.0.0.1:55860', 'sec-fetch-site': 'cross-site' }, []), false)
  assert.equal(isTrustedRequest({ host: '127.0.0.1:55860', origin: 'http://evil.example.com' }, []), false)
  assert.equal(isTrustedRequest({ host: '127.0.0.1:55860', origin: 'null' }, []), false)
})

await test('a foreign Host header is refused before any scanning happens', async () => {
  const deps = makeDeps()
  const { status, body } = await callDirect(deps, {
    url: `${ROUTE_PREFIX}/state?cwd=${encodeURIComponent(ws)}`,
    headers: { host: 'evil.example.com' },
  })
  assert.equal(status, 403)
  assert.equal(body.error.code, 'forbidden')
})

console.log('over a real HTTP server')

await test('serves the full lifecycle over the wire', async () => {
  const deps = makeDeps()
  const server = await serve(deps)
  try {
    const state = await read(await fetch(`${server.base}/state?cwd=${encodeURIComponent(ws)}`))
    assert.equal(state.status, 200)
    assert.equal(state.body.value.scriptCount, 3)

    const started = await read(await fetch(`${server.base}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: ws, dir: ws, script: 'dev' }),
    }))
    assert.equal(started.status, 200)
    const id = started.body.value.job.id

    deps.spawn.calls[0].child.emit('stdout:data', Buffer.from('listening on 5173\n'))
    const seen = await read(await fetch(`${server.base}/job?id=${encodeURIComponent(id)}`))
    assert.match(seen.body.value.job.output, /listening on 5173/)

    const jobs = await read(await fetch(`${server.base}/jobs`))
    assert.equal(jobs.body.value.jobs.length, 1)

    const stopped = await read(await fetch(`${server.base}/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    }))
    assert.equal(stopped.body.value.status, 'requested')

    const missing = await read(await fetch(`${server.base}/job?id=nope`))
    assert.equal(missing.status, 404)
  } finally {
    await server.close()
  }
})

await test('a spoofed Host is refused over the wire', async () => {
  const deps = makeDeps()
  const server = await serve(deps)
  try {
    const spoofed = await raw(server.port, `${ROUTE_PREFIX}/state?cwd=${encodeURIComponent(ws)}`, {
      headers: { host: 'evil.example.com' },
    })
    assert.equal(spoofed.status, 403)
    const crossSite = await raw(server.port, `${ROUTE_PREFIX}/state?cwd=${encodeURIComponent(ws)}`, {
      headers: { host: `127.0.0.1:${server.port}`, 'sec-fetch-site': 'cross-site' },
    })
    assert.equal(crossSite.status, 403)
    const ok = await raw(server.port, `${ROUTE_PREFIX}/state?cwd=${encodeURIComponent(ws)}`, {
      headers: { host: `127.0.0.1:${server.port}` },
    })
    assert.equal(ok.status, 200)
  } finally {
    await server.close()
  }
})

console.log('apply')

/** A fake cordis context that captures the route `apply` registers. */
function fakeCtx(services) {
  const registered = []
  const ctx = {
    registered,
    get: (name) => services[name],
    logger: { info: () => {}, warn: () => {} },
    // `inject` fires immediately, as cordis does when the service already exists.
    inject: (names, callback) => callback(ctx),
    effect: (callback) => callback(),
    webServer: {
      register(spec) {
        registered.push(spec)
        return () => {}
      },
    },
  }
  // cordis exposes an injected service as a context property too, which is how
  // `ctx.inject(['jobs'], ...)`'s callback reads it.
  return Object.assign(ctx, services)
}

await test('apply registers one prefixed route that serves the plugin surface', async () => {
  const jobs = createFakeJobs()
  const agent = { id: 's-1' }
  const ctx = fakeCtx({ jobs, agents: { get: (id) => (id === 's-1' ? agent : undefined) } })
  apply(ctx, {})
  assert.equal(ctx.registered.length, 1)
  assert.equal(ctx.registered[0].kind, 'prefix')
  assert.equal(ctx.registered[0].path, ROUTE_PREFIX)
  assert.equal(jobs.controllerName, 'npm-runner', 'apply reserves the controller DSH needs')

  const state = await callHandler(ctx.registered[0].handler, { url: `${ROUTE_PREFIX}/state?cwd=${encodeURIComponent(ws)}` })
  assert.equal(state.status, 200)
  assert.ok(state.body.value.scriptCount > 0)
})

await test('the object apply hands the routes marks a panel stop in DSH', async () => {
  const spawn = createFakeSpawn()
  const jobs = createFakeJobs()
  const agent = { id: 's-1' }
  const ctx = fakeCtx({ jobs, agents: { get: (id) => (id === 's-1' ? agent : undefined) } })
  // Same wiring `apply` builds, with only the process spawner faked. Driving the
  // real deps object is the point: a route that calls something nobody wired
  // would otherwise only fail in a live session.
  const { deps, bridge } = createPluginState(ctx, {}, { spawn })
  // Reserving the controller is `apply`'s job (covered above); the registry
  // refuses a start until someone holds one.
  bridge.attach(jobs)
  const handler = (req, res) => handleRequest(req, res, deps)

  const started = await callHandler(handler, {
    method: 'POST',
    url: `${ROUTE_PREFIX}/run`,
    chunks: [JSON.stringify({ cwd: ws, dir: ws, script: 'dev', sessionId: 's-1' })],
  })
  assert.equal(started.status, 200)
  assert.equal(started.body.value.dshJobId, 'bash-1')

  const stopped = await callHandler(handler, {
    method: 'POST',
    url: `${ROUTE_PREFIX}/stop`,
    chunks: [JSON.stringify({ id: started.body.value.job.id })],
  })
  assert.equal(stopped.status, 200)
  assert.deepEqual(jobs.kills, [{ id: 'bash-1', caller: agent, reason: 'stopped from the panel' }])
})

// ── Teardown ───────────────────────────────────────────────────────────────await rm(root, { recursive: true, force: true })

console.log('')
console.log(`${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
