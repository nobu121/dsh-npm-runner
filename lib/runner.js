// dsh-npm-runner — background run registry.
//
// One in-process registry of child processes started from the browser. The
// spawn function is injected, so the whole module is exercised in tests
// against a fake child; `lib/index.js` supplies the real `node:child_process`
// spawn.
//
// Design constraints that shaped this module:
//   * Output is retained as bounded raw chunks and decoded only on read, so a
//     chatty dev server cannot grow host memory without bound and a UTF-8
//     sequence split across two chunks still decodes correctly.
//   * A run must be stoppable as a TREE. `npm run dev` puts the real work in a
//     grandchild, so killing only the direct child would orphan a listening
//     server. That is why POSIX spawns detached (own process group) and
//     Windows kills through `taskkill /T`.
//   * A running job is never evicted to make room; only settled jobs are.

import { spawn as nodeSpawn } from 'node:child_process'

/** Run states a job can be in. `stopping` means a kill was requested. */
export const RUNNING = 'running'
export const STOPPING = 'stopping'
export const COMPLETED = 'completed'
export const FAILED = 'failed'
export const KILLED = 'killed'

/** True while the job still owns a process. */
export function isLive(status) {
  return status === RUNNING || status === STOPPING
}

/**
 * Append bytes to a bounded buffer, dropping whole old chunks first and
 * truncating a single oversized chunk from its front as a last resort.
 * @param state - `{ chunks, bytes, truncated }`, mutated in place.
 * @param chunk - the newly read bytes.
 * @param limit - the retained-byte cap.
 */
function appendBounded(state, chunk, limit) {
  if (chunk.length === 0) return
  state.chunks.push(chunk)
  state.bytes += chunk.length
  while (state.bytes > limit && state.chunks.length > 1) {
    const dropped = state.chunks.shift()
    state.bytes -= dropped.length
    state.truncated = true
  }
  if (state.bytes > limit) {
    const last = state.chunks[state.chunks.length - 1]
    state.chunks[state.chunks.length - 1] = last.subarray(last.length - limit)
    state.bytes = limit
    state.truncated = true
  }
}

/** Default signal senders; injectable so tests never signal a real process. */
export const defaultSignals = {
  group: (pid, signal) => process.kill(-pid, signal),
  process: (pid, signal) => process.kill(pid, signal),
}

/**
 * Kill one process and everything it started.
 * @param child - the live child handle.
 * @param platform - the platform to target.
 * @param spawn - the spawn port (used for `taskkill`).
 * @param pid - the child's pid, when known.
 * @param signals - the signal senders.
 * @returns true when a kill was attempted.
 */
export function killTree(child, platform, spawn, pid, signals = defaultSignals) {
  if (platform === 'win32') {
    if (pid === undefined) return false
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      killer.on?.('error', () => {})
      return true
    } catch {
      return false
    }
  }
  // POSIX: the child leads its own process group (see `detached` below), so a
  // negative pid signals the whole group.
  if (pid !== undefined) {
    try {
      signals.group(pid, 'SIGTERM')
      return true
    } catch {
      // Fall through to the direct kill when the group is already gone.
    }
  }
  try {
    child.kill('SIGTERM')
    return true
  } catch {
    return false
  }
}

/**
 * Create one run registry.
 * @param options - `{ maxJobs, maxRunning, bufferBytes, platform, spawn, signals, now, graceMs }`.
 * @returns the registry: `{ start, list, get, stop, stopAll, dispose, size }`.
 */
export function createRunner(options = {}) {
  const maxJobs = Number.isInteger(options.maxJobs) && options.maxJobs > 0 ? options.maxJobs : 12
  const maxRunning = Number.isInteger(options.maxRunning) && options.maxRunning > 0 ? options.maxRunning : 6
  const bufferBytes = Number.isInteger(options.bufferBytes) && options.bufferBytes > 0 ? options.bufferBytes : 65536
  const platform = options.platform ?? process.platform
  const spawn = options.spawn ?? nodeSpawn
  const signals = options.signals ?? defaultSignals
  const now = options.now ?? Date.now
  const graceMs = Number.isInteger(options.graceMs) && options.graceMs >= 0 ? options.graceMs : 4000

  /** @type {Map<string, object>} */
  const jobs = new Map()
  let counter = 0
  let disposed = false
  /** Timers armed by a stop request, cleared on exit so disposal never leaks one. */
  const timers = new Set()

  /** Drop settled jobs, oldest first, until the registry fits its cap. */
  function evict() {
    while (jobs.size > maxJobs) {
      let victim
      for (const job of jobs.values()) {
        if (isLive(job.status)) continue
        if (victim === undefined || job.startedAt < victim.startedAt) victim = job
      }
      if (victim === undefined) return
      jobs.delete(victim.id)
    }
  }

  /** The JSON-safe view of one job; `includeOutput` adds the retained text. */
  function view(job, includeOutput) {
    const base = {
      id: job.id,
      label: job.label,
      script: job.script,
      packageName: job.packageName,
      dir: job.dir,
      cwd: job.cwd,
      workspace: job.workspace,
      command: job.command,
      args: job.args,
      status: job.status,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      exitCode: job.exitCode,
      signal: job.signal,
      error: job.error,
      outputBytes: job.output.bytes,
      truncated: job.output.truncated,
    }
    if (includeOutput) base.output = Buffer.concat(job.output.chunks).toString('utf8')
    return base
  }

  return {
    /**
     * Start one background run.
     * @param spec - `{ command, args, cwd, workspace, label, script, packageName, dir, env }`.
     * @returns `{ job }` on success or `{ error }` when refused.
     */
    start(spec) {
      if (disposed) return { error: 'runner is disposed' }
      let running = 0
      for (const job of jobs.values()) if (isLive(job.status)) running += 1
      if (running >= maxRunning) return { error: `too many runs already active (limit ${maxRunning})` }

      const id = `run-${now().toString(36)}-${(counter += 1).toString(36)}`
      const job = {
        id,
        label: spec.label,
        script: spec.script,
        packageName: spec.packageName,
        dir: spec.dir,
        cwd: spec.cwd,
        /** The workspace root the request came from, so the UI can scope runs. */
        workspace: spec.workspace,
        command: spec.command,
        args: spec.args,
        status: RUNNING,
        startedAt: now(),
        finishedAt: undefined,
        exitCode: undefined,
        signal: undefined,
        error: undefined,
        output: { chunks: [], bytes: 0, truncated: false },
        child: undefined,
        pid: undefined,
      }
      jobs.set(id, job)
      /**
       * Resolved once this run settles. DSH's job registry awaits this as the
       * producer's `done` promise, so it must settle exactly once — on a spawn
       * failure as well as on exit.
       */
      let markSettled
      job.settled = new Promise((resolve) => { markSettled = resolve })
      job.markSettled = () => { markSettled(view(job, true)) }

      let child
      // On Windows the package manager is a `.cmd` shim, and modern Node
      // refuses to spawn one without a shell. Node passes a single command
      // string to the shell verbatim, but CONCATENATES an `args` array without
      // escaping it (and warns about exactly that: DEP0190). So on Windows the
      // whole command line is built here and passed as one program string with
      // no args, which keeps `shell: true` safe given that every component is
      // either a fixed literal or the allowlisted script name validated in
      // `resolveRun`. POSIX needs no shell and keeps the argv array.
      const useShell = platform === 'win32'
      const program = useShell ? [spec.command, ...spec.args].join(' ') : spec.command
      const argv = useShell ? [] : spec.args
      try {
        child = spawn(program, argv, {
          cwd: spec.cwd,
          env: { ...process.env, ...(spec.env ?? {}) },
          stdio: ['ignore', 'pipe', 'pipe'],
          // POSIX needs its own process group for a group-wide kill.
          detached: !useShell,
          shell: useShell,
          windowsHide: true,
        })
      } catch (error) {
        job.status = FAILED
        job.error = error instanceof Error ? error.message : String(error)
        job.finishedAt = now()
        job.markSettled()
        evict()
        return { job: view(job, false) }
      }

      job.child = child
      job.pid = child.pid

      const onData = (chunk) => {
        try {
          appendBounded(job.output, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), bufferBytes)
        } catch {
          // Output retention is best-effort; a decode failure must not kill the run.
        }
      }
      child.stdout?.on?.('data', onData)
      child.stderr?.on?.('data', onData)
      child.on?.('error', (error) => {
        job.error = error instanceof Error ? error.message : String(error)
        if (isLive(job.status)) job.status = FAILED
      })
      child.on?.('exit', (code, signal) => {
        for (const timer of timers) clearTimeout(timer)
        timers.clear()
        job.exitCode = typeof code === 'number' ? code : undefined
        job.signal = signal ?? undefined
        job.finishedAt = now()
        job.child = undefined
        if (job.status === STOPPING || job.status === KILLED) job.status = KILLED
        else job.status = code === 0 ? COMPLETED : FAILED
        job.markSettled()
        evict()
      })

      evict()
      return { job: view(job, false) }
    },

    /** Every retained job, newest first, without output text. */
    list() {
      return [...jobs.values()]
        .sort((left, right) => right.startedAt - left.startedAt)
        .map((job) => view(job, false))
    },

    /** One job with its retained output, or undefined. */
    get(id) {
      const job = jobs.get(id)
      return job === undefined ? undefined : view(job, true)
    },

    /**
     * Resolve once one run settles, with its final record.
     * @param id - the job id.
     * @returns the settled record, or undefined when the id is unknown.
     */
    async wait(id) {
      const job = jobs.get(id)
      if (job === undefined) return undefined
      return job.settled
    },

    /**
     * The run's retained output as text.
     *
     * Deliberately idempotent rather than a consuming delta read: DSH's job
     * registry assigns whatever this returns straight to the text an agent
     * sees, so returning the whole retained window keeps `job_output` correct
     * however many times it is called, and loses nothing between calls.
     * @param id - the job id.
     * @returns the retained output, or undefined when the id is unknown.
     */
    outputOf(id) {
      const job = jobs.get(id)
      return job === undefined ? undefined : Buffer.concat(job.output.chunks).toString('utf8')
    },

    /**
     * Drop every settled run, keeping live ones.
     *
     * The registry is what the popover lists, so this backs the user-facing
     * "clear finished" action. Live runs are never dropped: their record is
     * what a stop request and the output view still address.
     * @returns `{ removed }` with the number of records dropped.
     */
    clear() {
      let removed = 0
      for (const [id, job] of [...jobs]) {
        if (isLive(job.status)) continue
        jobs.delete(id)
        removed += 1
      }
      return { removed }
    },

    /**
     * Request a stop. Returns immediately; the exit handler settles the state.
     * @param id - the job id.
     * @returns `{ status }` describing what was requested.
     */
    stop(id) {
      const job = jobs.get(id)
      if (job === undefined) return { error: 'unknown run' }
      if (!isLive(job.status)) return { status: 'already-finished' }
      // Already signalled: report the same "stop is in effect" answer without
      // signalling the tree again or arming a second escalation timer. This is
      // reachable in normal use — DSH's kill path routes back into `stop`
      // through the job's cancel hook, so a panel Stop that already stopped the
      // run arrives here a second time.
      if (job.status === STOPPING) return { status: 'requested' }
      job.status = STOPPING
      const pid = job.pid
      killTree(job.child, platform, spawn, pid, signals)
      // Escalate if SIGTERM is ignored (POSIX). On Windows `taskkill /F` is
      // already forceful, so no escalation is needed.
      if (platform !== 'win32' && job.child !== undefined) {
        const child = job.child
        const timer = setTimeout(() => {
          timers.delete(timer)
          try {
            if (pid !== undefined) signals.group(pid, 'SIGKILL')
            else child.kill('SIGKILL')
          } catch {
            // Already gone.
          }
        }, graceMs)
        timer.unref?.()
        timers.add(timer)
      }
      return { status: 'requested' }
    },

    /** Stop every live run; used on plugin disposal. */
    stopAll() {
      for (const job of jobs.values()) {
        if (!isLive(job.status)) continue
        job.status = STOPPING
        killTree(job.child, platform, spawn, job.pid, signals)
      }
    },

    /** Stop everything and refuse further starts. */
    dispose() {
      if (disposed) return
      this.stopAll()
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      disposed = true
    },

    /** Number of retained jobs (diagnostics). */
    get size() {
      return jobs.size
    },
  }
}
