// Unit tests for the DSH background-job bridge (lib/jobs.js).
//
// Run with: node tests/jobs.test.mjs
//
// The bridge is the one place this plugin reaches into another DSH service, and
// every failure mode there must degrade to "the run still works, it just stays
// plugin-only". These cases pin that: a missing registry, a registry that
// refuses to start, a refused controller reservation, and the deliberate
// refusal to publish an owner-less job.

import assert from 'node:assert/strict'

import { CONTROLLER_NAME, JOB_KIND, createJobsBridge, detailOf, liveAgent } from '../lib/jobs.js'

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

/** Minimal stand-in for the plugin's run registry, recording delegation. */
function createFakeRunner() {
  const stops = []
  const waiters = []
  return {
    stops,
    stop(id) {
      stops.push(id)
      return { status: 'requested' }
    },
    wait(id) {
      return new Promise((resolve) => {
        waiters.push({ id, resolve })
      })
    },
    outputOf(id) {
      return `output:${id}`
    },
    /** Settle every pending `wait` with one final record. */
    settle(run) {
      for (const waiter of waiters.splice(0)) waiter.resolve(run)
    },
  }
}

/** Minimal stand-in for DSH's `jobs` registry. */
function createFakeJobs() {
  const started = []
  const kills = []
  const jobs = {
    started,
    kills,
    attachController(name) {
      jobs.controllerName = name
      return () => {
        jobs.released = true
      }
    },
    start(spec) {
      const hooks = spec.run()
      const id = `bash-${started.length + 1}`
      started.push({ id, spec, hooks })
      return id
    },
    // The real registry marks the record reported before settling, which is the
    // whole point of routing a panel Stop through it. Recording the call is
    // enough to pin that the bridge forwards to this method and not to `cancel`.
    kill(id, caller, reason) {
      kills.push({ id, caller, reason })
      return 'killed'
    },
  }
  return jobs
}

const AGENT = { id: 's-1' }

console.log('detailOf')

await test('reports an exit code for a normal finish', () => {
  assert.equal(detailOf({ status: 'completed', exitCode: 0 }), 'exit code: 0')
  assert.equal(detailOf({ status: 'failed', exitCode: 130 }), 'exit code: 130')
  assert.equal(detailOf({ status: 'completed' }), 'exit code: 0', 'a missing code reads as success')
})

await test('reports a signal for a stopped run', () => {
  assert.equal(detailOf({ status: 'killed', signal: 'SIGTERM' }), 'signal: SIGTERM')
  assert.equal(detailOf({ status: 'killed' }), 'stopped on request')
})

await test('prefers a spawn error over the exit code', () => {
  assert.equal(detailOf({ status: 'failed', error: 'spawn npm ENOENT', exitCode: 1 }), 'spawn npm ENOENT')
})

await test('survives an evicted record', () => {
  assert.equal(detailOf(undefined), 'run record was no longer retained')
})

console.log('liveAgent')

await test('reads the agent registry defensively', () => {
  assert.equal(liveAgent({ get: (id) => (id === 's-1' ? AGENT : undefined) }, 's-1'), AGENT)
  assert.equal(liveAgent({ get: () => undefined }, 's-1'), undefined, 'a blank Session has no live Agent')
  assert.equal(liveAgent(undefined, 's-1'), undefined, 'no agents service')
  assert.equal(liveAgent({ get: () => AGENT }, ''), undefined, 'no Session id')
  assert.equal(liveAgent({ get: () => AGENT }, undefined), undefined)
  assert.equal(liveAgent({ get() { throw new Error('boom') } }, 's-1'), undefined, 'a throwing registry')
})

console.log('attach')

await test('reserves exactly one controller and names it', () => {
  const runner = createFakeRunner()
  const jobs = createFakeJobs()
  const bridge = createJobsBridge({ runner })
  const release = bridge.attach(jobs)
  assert.equal(jobs.controllerName, CONTROLLER_NAME)
  assert.equal(bridge.attached, true)
  assert.equal(typeof release, 'function')
  // A second attach while held must not reserve again.
  assert.equal(bridge.attach(jobs), undefined)
  release()
  assert.equal(jobs.released, true)
  assert.equal(bridge.attached, false)
})

await test('a later activation can reserve again', () => {
  const bridge = createJobsBridge({ runner: createFakeRunner() })
  const jobs = createFakeJobs()
  bridge.attach(jobs)()
  assert.equal(bridge.attached, false)
  assert.equal(typeof bridge.attach(jobs), 'function')
  assert.equal(bridge.attached, true)
})

await test('degrades when the registry is absent or refuses', () => {
  assert.equal(createJobsBridge({ runner: createFakeRunner() }).attach(undefined), undefined)
  assert.equal(createJobsBridge({ runner: createFakeRunner() }).attach({}), undefined, 'no attachController')
  const refused = {
    attachController() {
      throw new Error('already reserved')
    },
  }
  const logged = []
  const bridge = createJobsBridge({ runner: createFakeRunner(), log: (...args) => logged.push(args[0]) })
  assert.equal(bridge.attach(refused), undefined)
  assert.equal(bridge.attached, false)
  assert.equal(logged.length, 1, 'a refusal is logged once, not thrown')
})

console.log('publish')

await test('registers the run as a bash job owned by the Session', () => {
  const runner = createFakeRunner()
  const jobs = createFakeJobs()
  const bridge = createJobsBridge({ runner })
  const id = bridge.publish({ jobs, agent: AGENT, runId: 'run-1', label: 'npm run dev' })
  assert.equal(id, 'bash-1')
  assert.equal(jobs.started.length, 1)
  assert.equal(jobs.started[0].spec.kind, JOB_KIND)
  assert.equal(jobs.started[0].spec.kind, 'bash', 'DSH\'s JobKind union accepts only bash or subagent')
  assert.equal(jobs.started[0].spec.label, 'npm run dev')
  assert.equal(jobs.started[0].spec.owner, AGENT)
  assert.equal(bridge.dshIdFor('run-1'), 'bash-1')
})

await test('registers one run only once', () => {
  const jobs = createFakeJobs()
  const bridge = createJobsBridge({ runner: createFakeRunner() })
  const first = bridge.publish({ jobs, agent: AGENT, runId: 'run-1', label: 'a' })
  const second = bridge.publish({ jobs, agent: AGENT, runId: 'run-1', label: 'a' })
  assert.equal(first, second)
  assert.equal(jobs.started.length, 1)
})

await test('forwards an ownerless publish, and refuses a missing registry', () => {
  const jobs = createFakeJobs()
  const bridge = createJobsBridge({ runner: createFakeRunner() })
  // Whether a job carries an owner is the caller's policy, not the bridge's:
  // this forwards a global (owner-less) job exactly as it forwards an owned one.
  assert.equal(bridge.publish({ jobs, agent: undefined, runId: 'run-1', label: 'a' }), 'bash-1')
  assert.equal('owner' in jobs.started[0].spec, false, 'a global job must not carry an owner key')
  assert.equal(bridge.publish({ jobs, agent: null, runId: 'run-2', label: 'b' }), 'bash-2')
  assert.equal('owner' in jobs.started[1].spec, false)
  assert.equal(bridge.publish({ jobs: undefined, agent: AGENT, runId: 'run-3', label: 'c' }), undefined)
})

await test('publishes an owned job when the caller supplies an owner', () => {
  const jobs = createFakeJobs()
  const bridge = createJobsBridge({ runner: createFakeRunner() })
  assert.equal(bridge.publish({ jobs, agent: AGENT, runId: 'run-1', label: 'a' }), 'bash-1')
  assert.equal(jobs.started[0].spec.owner, AGENT)
})

await test('a refused start degrades instead of throwing', () => {
  const logged = []
  const bridge = createJobsBridge({ runner: createFakeRunner(), log: (...args) => logged.push(args[0]) })
  const jobs = {
    start() {
      throw new Error('background job limit reached for this owner')
    },
  }
  assert.equal(bridge.publish({ jobs, agent: AGENT, runId: 'run-1', label: 'a' }), undefined)
  assert.equal(logged.length, 1)
})

console.log('hooks')

await test('cancel delegates to the run registry', () => {
  const runner = createFakeRunner()
  const jobs = createFakeJobs()
  const bridge = createJobsBridge({ runner })
  bridge.publish({ jobs, agent: AGENT, runId: 'run-1', label: 'a' })
  jobs.started[0].hooks.cancel()
  assert.deepEqual(runner.stops, ['run-1'])
})

await test('readOutput delegates to the retained window', () => {
  const jobs = createFakeJobs()
  const bridge = createJobsBridge({ runner: createFakeRunner() })
  bridge.publish({ jobs, agent: AGENT, runId: 'run-1', label: 'a' })
  assert.equal(jobs.started[0].hooks.readOutput(), 'output:run-1')
})

await test('done maps the settled run onto a DSH outcome', async () => {
  const cases = [
    [{ status: 'completed', exitCode: 0 }, { status: 'completed', detail: 'exit code: 0' }],
    [{ status: 'failed', exitCode: 2 }, { status: 'failed', detail: 'exit code: 2' }],
    [{ status: 'killed', signal: 'SIGKILL' }, { status: 'killed', detail: 'signal: SIGKILL' }],
  ]
  for (const [finalRecord, expected] of cases) {
    const runner = createFakeRunner()
    const jobs = createFakeJobs()
    const bridge = createJobsBridge({ runner })
    bridge.publish({ jobs, agent: AGENT, runId: 'run-1', label: 'a' })
    const done = jobs.started[0].hooks.done
    runner.settle(finalRecord)
    assert.deepEqual(await done, expected)
  }
})

await test('done resolves failed when the run record is gone', async () => {
  const runner = createFakeRunner()
  const jobs = createFakeJobs()
  const bridge = createJobsBridge({ runner })
  bridge.publish({ jobs, agent: AGENT, runId: 'run-1', label: 'a' })
  const done = jobs.started[0].hooks.done
  runner.settle(undefined)
  assert.deepEqual(await done, { status: 'failed', detail: 'run record was no longer retained' })
})

console.log('release')

await test('marks a panel stop in the registry so DSH stays quiet', () => {
  const runner = createFakeRunner()
  const jobs = createFakeJobs()
  const bridge = createJobsBridge({ runner })
  bridge.publish({ jobs, agent: AGENT, runId: 'run-1', label: 'a' })
  assert.equal(bridge.release({ jobs, runId: 'run-1', reason: 'stopped from the panel' }), 'killed')
  assert.deepEqual(jobs.kills, [{ id: 'bash-1', caller: AGENT, reason: 'stopped from the panel' }])
  // `kill` is the registry's reported-flag path; the route already stopped the
  // process, and release must not race a second stop in behind it.
  assert.deepEqual(runner.stops, [])
})

await test('stops a run that was never registered as unmanaged', () => {
  const bridge = createJobsBridge({ runner: createFakeRunner() })
  assert.equal(bridge.release({ jobs: createFakeJobs(), runId: 'run-9', reason: 'r' }), 'unmanaged')
})

await test('degrades when the registry cannot be told', () => {
  const bridge = createJobsBridge({ runner: createFakeRunner() })
  const jobs = createFakeJobs()
  bridge.publish({ jobs, agent: AGENT, runId: 'run-1', label: 'a' })
  assert.equal(bridge.release({ jobs: undefined, runId: 'run-1', reason: 'r' }), 'unavailable')
  assert.equal(bridge.release({ jobs: {}, runId: 'run-1', reason: 'r' }), 'unavailable', 'no kill method')
})

await test('a refused kill is logged, not thrown', () => {
  const logged = []
  const bridge = createJobsBridge({ runner: createFakeRunner(), log: (...args) => logged.push(args[0]) })
  const jobs = createFakeJobs()
  bridge.publish({ jobs, agent: AGENT, runId: 'run-1', label: 'a' })
  jobs.kill = () => {
    throw new Error('job is not owned by this caller')
  }
  assert.equal(bridge.release({ jobs, runId: 'run-1', reason: 'r' }), 'failed')
  assert.equal(logged.length, 1)
})

console.log('')
console.log(`${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
