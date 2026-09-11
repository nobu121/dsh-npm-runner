// dsh-npm-runner — bridge into DSH's background-job registry.
//
// `ctx.jobs` is a registry, not an executor. `jobs.start(spec)` runs
// `spec.run()` and takes whatever hooks come back; the process itself is the
// caller's. So this module does not hand execution over to DSH — it surfaces
// each run the plugin already owns, which is the part with real value:
//
//   * the run appears in that Session's own background-job list (`jobsBySession`
//     frames), not only in this plugin's popover;
//   * the agent can reach it with `job_list`, `job_output` and `job_kill`;
//   * DSH handles the retention and the "reported" bookkeeping.
//
// Two facts about the registry shape everything here:
//
//   1. A host-plane producer must reserve a controller first. The web profile
//      mounts the registry (`dsh-base`) but disables the model-facing
//      `tool-jobs` row, so `servesOwner` finds no controller in the global
//      layer and `start()` throws until `attachController` is called.
//   2. An owner-less job is visible to EVERY session (`list(caller)` keeps
//      `owner === undefined`). Publishing without a live owner would therefore
//      sprinkle one workspace's dev server across every open conversation, so
//      `publish` refuses instead and the run stays plugin-only.

/** The only kind DSH's closed `JobKind` union accepts for a command run. */
export const JOB_KIND = 'bash'

/** The controller name this plugin reserves; purely a diagnostic label. */
export const CONTROLLER_NAME = 'npm-runner'

/**
 * Human detail for a settled run, matching the shape DSH's own bash tool
 * reports ("signal: SIGTERM" / "exit code: 0").
 * @param run - the settled run record, when one survived.
 * @returns one short line.
 */
export function detailOf(run) {
  if (run === undefined || run === null) return 'run record was no longer retained'
  if (typeof run.error === 'string' && run.error.length > 0) return run.error
  if (run.status === 'killed') {
    return run.signal === undefined || run.signal === null ? 'stopped on request' : `signal: ${run.signal}`
  }
  return `exit code: ${run.exitCode ?? 0}`
}

/**
 * The live Agent for one Session, when there is one.
 *
 * Only a live owner scopes a job to its Session, and a blank Session has no
 * Agent yet, so this legitimately returns undefined.
 * @param agents - the `agents` service, when mounted.
 * @param sessionId - the Session the run was requested from.
 * @returns the Agent, or undefined.
 */
export function liveAgent(agents, sessionId) {
  if (agents === undefined || agents === null || typeof agents.get !== 'function') return undefined
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  try {
    return agents.get(sessionId) ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Create the bridge.
 * @param options - `{ runner, log }`.
 * @returns `{ attach, publish, dshIdFor, attached }`.
 */
export function createJobsBridge(options = {}) {
  const runner = options.runner
  const log = options.log
  /** Plugin run id -> `{ id, owner }` for the DSH record, so a run is never registered twice. */
  const published = new Map()
  let hasController = false

  return {
    /** True once a controller has been reserved. */
    get attached() {
      return hasController
    },

    /**
     * Reserve the registry controller this plugin needs, once.
     *
     * Called from an effect so the reservation is scoped to the plugin fiber
     * and released when the plugin stops, which lets a later activation
     * reserve it again.
     * @param jobs - the `jobs` service.
     * @returns a disposer that releases the reservation, or undefined when the
     *          registry is absent or refused.
     */
    attach(jobs) {
      if (jobs === undefined || jobs === null || typeof jobs.attachController !== 'function') return undefined
      // Idempotent while held: a second attach must not reserve a second
      // controller, and the disposer below belongs to the first reservation.
      if (hasController) return undefined
      let dispose
      try {
        dispose = jobs.attachController(CONTROLLER_NAME)
      } catch (error) {
        log?.('could not reserve a background-job controller; runs stay plugin-only: %s', messageOf(error))
        return undefined
      }
      hasController = true
      return () => {
        hasController = false
        try {
          dispose?.()
        } catch {
          // The registry may already be torn down.
        }
      }
    },

    /**
     * Expose one plugin run through DSH's registry.
     *
     * Whether the job carries an owner is the caller's policy, not this
     * module's: `createRunPublisher` chooses between a Session-scoped job
     * (visible in one conversation, reaped when that Session's agent is
     * disposed) and a global one (visible and controllable from every
     * conversation, and never reaped). This just forwards what it is given.
     * @param request - `{ jobs, agent?, runId, label }`.
     * @returns the DSH job id, or undefined when the run stays plugin-only.
     */
    publish(request) {
      const { jobs, agent, runId, label } = request
      if (runner === undefined) return undefined
      if (jobs === undefined || jobs === null || typeof jobs.start !== 'function') return undefined
      const existing = published.get(runId)
      if (existing !== undefined) return existing.id

      try {
        const id = jobs.start({
          kind: JOB_KIND,
          label,
          // The key is only built when there is an owner: `owner: undefined`
          // means the same thing to the registry, and omitting it keeps the
          // global-versus-session intent visible at the call site.
          ...agent === undefined || agent === null ? {} : { owner: agent },
          run: () => ({
            // DSH's kill path funnels here, so the agent's job_kill and this
            // plugin's own Stop button end up in exactly one place.
            cancel: () => {
              runner.stop(runId)
            },
            done: runner.wait(runId).then((run) => ({
              status: run === undefined
                ? 'failed'
                : run.status === 'killed' ? 'killed' : run.status === 'completed' ? 'completed' : 'failed',
              detail: detailOf(run),
            })),
            // Idempotent full-window read: DSH assigns this straight to the text
            // an agent sees, so a repeated job_output stays correct.
            readOutput: () => runner.outputOf(runId) ?? '',
          }),
        })
        const record = { id, owner: agent }
        published.set(runId, record)
        return id
      } catch (error) {
        log?.('could not register the run with DSH; it stays plugin-only: %s', messageOf(error))
        return undefined
      }
    },

    /**
     * Tell DSH that this run was stopped from the panel.
     *
     * Without this, stopping a run only kills the process: the registry's record
     * still settles with `reported === false`, and `dsh-tool-jobs`' `onJobDone`
     * listener then injects a "background job X finished" notice into the
     * Session — as a *followup* when the agent is idle, which starts a fresh
     * agent turn for something the user just did deliberately.
     *
     * `jobs.kill` is the registry's own way to say "already accounted for": it
     * marks the record reported *before* settling, which is exactly the flag
     * that listener checks, and it routes through the same `cancel` hook this
     * plugin already owns, so the process is stopped either way.
     *
     * The caller passed to `kill` is the agent recorded at publish time rather
     * than the Session doing the stopping: the registry fences a job to its
     * owner, and a run started in this workspace may legitimately be stopped
     * from another conversation that can see it.
     * @param request - `{ jobs, runId, reason }`.
     * @returns the registry outcome, 'unmanaged' for a plugin-only run, or
     *          'unavailable'/'failed' when the registry could not be told.
     */
    release(request) {
      const { jobs, runId, reason } = request
      const record = published.get(runId)
      if (record === undefined) return 'unmanaged'
      if (jobs === undefined || jobs === null || typeof jobs.kill !== 'function') return 'unavailable'
      try {
        return jobs.kill(record.id, record.owner, reason)
      } catch (error) {
        log?.('could not mark run %s stopped in DSH; it may still notify: %s', runId, messageOf(error))
        return 'failed'
      }
    },

    /** The DSH job id for one plugin run, when it was registered. */
    dshIdFor(runId) {
      return published.get(runId)?.id
    },
  }
}

/** Message of any thrown value. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
