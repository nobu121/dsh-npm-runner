// Unit tests for the background run registry (lib/runner.js).
//
// Run with: node tests/runner.test.mjs
//
// The child process is faked, and so are the two signal senders, so the suite
// exercises the real control flow — output bounding, exit settlement, tree
// kill, eviction — without ever spawning or signalling a real process.

import assert from 'node:assert/strict'

import { COMPLETED, FAILED, KILLED, STOPPING, createRunner, isLive, killTree } from '../lib/runner.js'

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

/**
 * A stand-in for `node:child_process.spawn` that records its calls and lets a
 * test drive stdout, stderr, exit and error by hand.
 */
function createFakeSpawn() {
  const calls = []
  function spawn(command, args, options) {
    const listeners = new Map()
    const on = (event, handler) => {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
    }
    const child = {
      pid: 1000 + calls.length,
      stdout: { on: (event, handler) => on(`stdout:${event}`, handler) },
      stderr: { on: (event, handler) => on(`stderr:${event}`, handler) },
      on,
      kill: (signal) => {
        child.killed = signal ?? 'SIGTERM'
      },
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

/** Signal senders that only record what would have been signalled. */
function createFakeSignals() {
  const calls = []
  return {
    calls,
    group: (pid, signal) => calls.push({ pid, signal, scope: 'group' }),
    process: (pid, signal) => calls.push({ pid, signal, scope: 'process' }),
  }
}

/** A runner wired to fakes, with a controllable clock. */
function harness(overrides = {}) {
  const spawn = createFakeSpawn()
  const signals = createFakeSignals()
  let clock = 1_000
  const runner = createRunner({
    spawn,
    signals,
    now: () => (clock += 10),
    platform: 'linux',
    graceMs: 0,
    ...overrides,
  })
  return { runner, spawn, signals }
}

const SPEC = { command: 'npm', args: ['run', 'dev'], cwd: '/ws/app', label: 'npm run dev', script: 'dev', packageName: 'app', dir: '/ws/app' }

console.log('start')

await test('starts a run and reports it as live', async () => {
  const { runner, spawn } = harness()
  const { job } = runner.start(SPEC)
  assert.equal(job.status, 'running')
  assert.equal(job.label, 'npm run dev')
  assert.ok(job.id.startsWith('run-'))
  assert.equal(spawn.calls.length, 1)
  assert.equal(spawn.calls[0].command, 'npm')
  assert.deepEqual(spawn.calls[0].args, ['run', 'dev'])
  assert.equal(spawn.calls[0].options.cwd, '/ws/app')
  assert.equal(spawn.calls[0].options.detached, true)
  assert.equal(spawn.calls[0].options.shell, false)
})

await test('uses a shell on win32 so the npm .cmd shim can execute', async () => {
  const { runner, spawn } = harness({ platform: 'win32' })
  runner.start(SPEC)
  const call = spawn.calls[0]
  assert.equal(call.options.shell, true)
  assert.equal(call.options.detached, false)
  // The command line is pre-joined and the argv array left empty, so Node
  // never concatenates unescaped arguments into a shell (DEP0190).
  assert.equal(call.command, 'npm run dev')
  assert.deepEqual(call.args, [])
})

await test('a spawn throw is reported as a failed run, not an exception', async () => {
  const { runner } = harness({
    spawn: () => {
      throw new Error('spawn npm ENOENT')
    },
  })
  const { job } = runner.start(SPEC)
  assert.equal(job.status, 'failed')
  assert.match(job.error, /ENOENT/)
})

console.log('output')

await test('retains stdout and stderr interleaved in arrival order', async () => {
  const { runner, spawn } = harness()
  const { job } = runner.start(SPEC)
  const child = spawn.calls[0].child
  child.emit('stdout:data', Buffer.from('starting\n'))
  child.emit('stderr:data', Buffer.from('warn: port busy\n'))
  child.emit('stdout:data', Buffer.from('ready\n'))
  assert.equal(runner.get(job.id).output, 'starting\nwarn: port busy\nready\n')
  assert.equal(runner.get(job.id).outputBytes, 31)
})

await test('bounds retained output and flags truncation', async () => {
  const { runner, spawn } = harness({ bufferBytes: 10 })
  const { job } = runner.start(SPEC)
  const child = spawn.calls[0].child
  for (const chunk of ['aaaa', 'bbbb', 'cccc', 'dddd']) child.emit('stdout:data', Buffer.from(chunk))
  const seen = runner.get(job.id)
  // Whole chunks are dropped, so retention lands at or below the cap rather
  // than exactly on it — the newest 8 bytes survive a 10-byte limit.
  assert.ok(seen.outputBytes <= 10, `expected <= 10 retained bytes, got ${seen.outputBytes}`)
  assert.equal(seen.outputBytes, 8)
  assert.equal(seen.output, 'ccccdddd')
  assert.equal(seen.truncated, true)
})

await test('keeps a single oversized chunk byte-accurate', async () => {
  const { runner, spawn } = harness({ bufferBytes: 4 })
  const { job } = runner.start(SPEC)
  spawn.calls[0].child.emit('stdout:data', Buffer.from('0123456789'))
  assert.equal(runner.get(job.id).output, '6789')
})

await test('decodes a multi-byte character split across chunks', async () => {
  const { runner, spawn } = harness()
  const { job } = runner.start(SPEC)
  const encoded = Buffer.from('完成', 'utf8')
  spawn.calls[0].child.emit('stdout:data', encoded.subarray(0, 2))
  spawn.calls[0].child.emit('stdout:data', encoded.subarray(2))
  assert.equal(runner.get(job.id).output, '完成')
})

console.log('settlement')

await test('exit 0 settles as completed', async () => {
  const { runner, spawn } = harness()
  const { job } = runner.start(SPEC)
  spawn.calls[0].child.emit('exit', 0, null)
  const seen = runner.get(job.id)
  assert.equal(seen.status, COMPLETED)
  assert.equal(seen.exitCode, 0)
  assert.ok(seen.finishedAt > seen.startedAt)
})

await test('a non-zero exit settles as failed', async () => {
  const { runner, spawn } = harness()
  const { job } = runner.start(SPEC)
  spawn.calls[0].child.emit('exit', 1, null)
  assert.equal(runner.get(job.id).status, FAILED)
})

await test('an error event marks failure before exit arrives', async () => {
  const { runner, spawn } = harness()
  const { job } = runner.start(SPEC)
  spawn.calls[0].child.emit('error', new Error('EPIPE'))
  assert.equal(runner.list()[0].error, 'EPIPE')
  assert.equal(runner.get(job.id).status, FAILED)
})

console.log('stop')

await test('stop signals the whole process group on POSIX', async () => {
  const { runner, spawn, signals } = harness()
  const { job } = runner.start(SPEC)
  const result = runner.stop(job.id)
  assert.equal(result.status, 'requested')
  assert.equal(runner.list()[0].status, STOPPING)
  assert.deepEqual(signals.calls[0], { pid: spawn.calls[0].child.pid, signal: 'SIGTERM', scope: 'group' })
})

await test('a stopped run settles as killed, not failed', async () => {
  const { runner, spawn } = harness()
  const { job } = runner.start(SPEC)
  runner.stop(job.id)
  spawn.calls[0].child.emit('exit', null, 'SIGTERM')
  assert.equal(runner.get(job.id).status, KILLED)
  assert.equal(runner.get(job.id).signal, 'SIGTERM')
})

await test('stop escalates to SIGKILL after the grace period on POSIX', async () => {
  const { runner, spawn, signals } = harness({ graceMs: 0 })
  const { job } = runner.start(SPEC)
  runner.stop(job.id)
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual(signals.calls[1], { pid: spawn.calls[0].child.pid, signal: 'SIGKILL', scope: 'group' })
})

await test('stop uses taskkill on win32 and escalates nothing', async () => {
  const { runner, spawn, signals } = harness({ platform: 'win32', graceMs: 0 })
  const { job } = runner.start(SPEC)
  runner.stop(job.id)
  const kill = spawn.calls[1]
  assert.equal(kill.command, 'taskkill')
  assert.deepEqual(kill.args, ['/pid', String(spawn.calls[0].child.pid), '/T', '/F'])
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(signals.calls.length, 0)
})

await test('stopping a finished run is a no-op', async () => {
  const { runner, spawn } = harness()
  const { job } = runner.start(SPEC)
  spawn.calls[0].child.emit('exit', 0, null)
  assert.equal(runner.stop(job.id).status, 'already-finished')
})

await test('a repeated stop does not signal the tree twice', async () => {
  const { runner, spawn, signals } = harness()
  const { job } = runner.start(SPEC)
  runner.stop(job.id)
  // The panel Stop stops the process itself and then tells DSH, whose kill path
  // routes back through the job's cancel hook into this method.
  assert.equal(runner.stop(job.id).status, 'requested', 'still reported as in effect')
  assert.equal(signals.calls.length, 1, 'one signal, not two')
  assert.equal(runner.get(job.id).status, STOPPING)
})

await test('stopping an unknown run reports an error', async () => {
  const { runner } = harness()
  assert.match(runner.stop('nope').error, /unknown run/)
})

await test('stopAll stops every live run', async () => {
  const { runner } = harness()
  runner.start(SPEC)
  runner.start({ ...SPEC, script: 'build' })
  runner.stopAll()
  assert.equal(runner.list().every((job) => job.status === STOPPING), true)
})

console.log('limits')

await test('refuses a start past the concurrent-run limit', async () => {
  const { runner } = harness({ maxRunning: 2 })
  assert.equal(runner.start(SPEC).job.status, 'running')
  assert.equal(runner.start(SPEC).job.status, 'running')
  assert.match(runner.start(SPEC).error, /too many runs already active/)
})

await test('evicts settled runs but never a live one', async () => {
  const { runner, spawn } = harness({ maxJobs: 2 })
  const first = runner.start(SPEC).job
  const second = runner.start(SPEC).job
  spawn.calls[0].child.emit('exit', 0, null)
  const third = runner.start(SPEC).job
  const ids = runner.list().map((job) => job.id)
  assert.equal(ids.includes(first.id), false, 'the settled run should have been evicted')
  assert.equal(ids.includes(second.id), true)
  assert.equal(ids.includes(third.id), true)
  assert.equal(runner.size, 2)
})

await test('dispose stops live runs and refuses further starts', async () => {
  const { runner } = harness()
  runner.start(SPEC)
  runner.dispose()
  assert.equal(runner.list()[0].status, STOPPING)
  assert.match(runner.start(SPEC).error, /disposed/)
})

await test('list is newest-first and excludes output text', async () => {
  const { runner, spawn } = harness({ now: (() => { let t = 0; return () => (t += 100) })() })
  const first = runner.start(SPEC).job
  const second = runner.start(SPEC).job
  spawn.calls[0].child.emit('stdout:data', Buffer.from('hello'))
  const list = runner.list()
  assert.deepEqual(list.map((job) => job.id), [second.id, first.id])
  assert.equal('output' in list[0], false)
  assert.equal(runner.get(first.id).output, 'hello')
})

console.log('settlement observation')

await test('wait resolves with the final record once the run exits', async () => {
  const { runner, spawn } = harness()
  const { job } = runner.start(SPEC)
  const pending = runner.wait(job.id)
  spawn.calls[0].child.emit('stdout:data', Buffer.from('hi'))
  spawn.calls[0].child.emit('exit', 0, null)
  const settled = await pending
  assert.equal(settled.status, 'completed')
  assert.equal(settled.exitCode, 0)
  assert.equal(settled.output, 'hi')
})

await test('wait on an already-settled run resolves immediately', async () => {
  const { runner, spawn } = harness()
  const { job } = runner.start(SPEC)
  spawn.calls[0].child.emit('exit', 1, null)
  assert.equal((await runner.wait(job.id)).status, 'failed')
})

await test('wait on an unknown run resolves undefined', async () => {
  const { runner } = harness()
  assert.equal(await runner.wait('ghost'), undefined)
})

await test('a spawn failure still settles the run exactly once', async () => {
  const { runner } = harness({
    spawn: () => {
      throw new Error('spawn npm ENOENT')
    },
  })
  const { job } = runner.start(SPEC)
  const settled = await runner.wait(job.id)
  assert.equal(settled.status, 'failed')
  assert.match(settled.error, /ENOENT/)
  // A second await must not hang or change the answer.
  assert.equal((await runner.wait(job.id)).status, 'failed')
})

await test('a stopped run settles as killed for the waiter', async () => {
  const { runner, spawn } = harness()
  const { job } = runner.start(SPEC)
  const pending = runner.wait(job.id)
  runner.stop(job.id)
  spawn.calls[0].child.emit('exit', null, 'SIGTERM')
  const settled = await pending
  assert.equal(settled.status, KILLED)
  assert.equal(settled.signal, 'SIGTERM')
})

await test('outputOf returns the retained window and is idempotent', async () => {
  const { runner, spawn } = harness()
  const { job } = runner.start(SPEC)
  spawn.calls[0].child.emit('stdout:data', Buffer.from('abc'))
  spawn.calls[0].child.emit('stderr:data', Buffer.from('def'))
  assert.equal(runner.outputOf(job.id), 'abcdef')
  assert.equal(runner.outputOf(job.id), 'abcdef', 'a repeated read must not consume the window')
  assert.equal(runner.outputOf('ghost'), undefined)
})

await test('outputOf respects the retention cap', async () => {
  const { runner, spawn } = harness({ bufferBytes: 4 })
  const { job } = runner.start(SPEC)
  spawn.calls[0].child.emit('stdout:data', Buffer.from('0123456789'))
  assert.equal(runner.outputOf(job.id), '6789')
})

console.log('clearing finished runs')

await test('clear drops settled runs and keeps live ones', async () => {
  const { runner, spawn } = harness()
  runner.start(SPEC)
  const live = runner.start({ ...SPEC, script: 'build' }).job
  spawn.calls[0].child.emit('exit', 0, null)
  assert.deepEqual(runner.clear(), { removed: 1 })
  assert.deepEqual(runner.list().map((job) => job.id), [live.id])
})

await test('clear leaves a live run addressable', async () => {
  const { runner } = harness()
  const live = runner.start(SPEC).job
  assert.deepEqual(runner.clear(), { removed: 0 })
  assert.equal(runner.stop(live.id).status, 'requested')
})

await test('clear removes a stopped run too', async () => {
  const { runner, spawn } = harness()
  const { job } = runner.start(SPEC)
  runner.stop(job.id)
  spawn.calls[0].child.emit('exit', null, 'SIGTERM')
  assert.equal(runner.list()[0].status, KILLED)
  assert.deepEqual(runner.clear(), { removed: 1 })
  assert.deepEqual(runner.list(), [])
})

await test('clear is idempotent and safe on an empty registry', async () => {
  const { runner, spawn } = harness()
  assert.deepEqual(runner.clear(), { removed: 0 })
  runner.start(SPEC)
  spawn.calls[0].child.emit('exit', 1, null)
  assert.deepEqual(runner.clear(), { removed: 1 })
  assert.deepEqual(runner.clear(), { removed: 0 })
})

console.log('helpers')

await test('isLive covers running and stopping only', () => {
  assert.equal(isLive('running'), true)
  assert.equal(isLive('stopping'), true)
  assert.equal(isLive('completed'), false)
  assert.equal(isLive('failed'), false)
  assert.equal(isLive('killed'), false)
})

await test('killTree falls back to the child when no pid is known', () => {
  const killed = []
  const child = { kill: (signal) => killed.push(signal) }
  assert.equal(killTree(child, 'linux', () => {}, undefined, { group: () => { throw new Error('no group') } }), true)
  assert.deepEqual(killed, ['SIGTERM'])
})

console.log('')
console.log(`${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
