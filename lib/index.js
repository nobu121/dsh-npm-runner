// dsh-npm-runner — host half.
//
// Serves the plugin's JSON routes and owns the background run registry. The
// browser half (lib/client.js) is the only intended caller, but the routes are
// ordinary same-origin HTTP and stay useful on their own:
//
//   GET  /npm-runner/state?cwd=<dir>   packages + scripts found under <dir>
//   GET  /npm-runner/jobs              every retained run, newest first
//   GET  /npm-runner/job?id=<id>       one run, including its retained output
//   POST /npm-runner/run               { cwd, dir, script } -> start a run
//   POST /npm-runner/stop              { id } -> request a stop
//   POST /npm-runner/clear             drop every settled run
//
// Two deliberate choices:
//
//   * The script NAME is never taken from the client as a command. The client
//     sends a directory plus a script name; `lib/scan.js` re-reads that
//     directory's own package.json and rebuilds `<packageManager> run <name>`.
//     A crafted request can therefore only run a script the manifest already
//     declares — it cannot reach the manifest's raw command string and cannot
//     name a command of its own.
//   * Reads go through `node:fs`, and runs through `node:child_process`, in
//     the host process. That makes the plugin local-workspace by construction:
//     it runs scripts on the machine DSH itself is running on.

import { spawn } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

import { resolveRun, scanWorkspace } from './scan.js'
import { createRunner } from './runner.js'
import { createJobsBridge, liveAgent } from './jobs.js'

export const name = 'npm-runner'

/** The browser carrier that owns HTTP route registration. */
export const inject = ['webServer']

/** Fixed HTTP prefix; the shipped client half calls these exact paths. */
export const ROUTE_PREFIX = '/npm-runner'

/** Bound on one JSON request body. */
const MAX_BODY_BYTES = 64 * 1024

/** Normalize the plugin row's `config` block. */
export function resolveConfig(config = {}) {
  const positive = (value, fallback) => (Number.isInteger(value) && value > 0 ? value : fallback)
  return {
    maxPackages: positive(config.maxPackages, 60),
    maxJobs: positive(config.maxJobs, 12),
    maxRunning: positive(config.maxRunning, 6),
    bufferBytes: positive(config.bufferBytes, 65536),
    registerJobs: config.registerJobs !== false,
    // 'session' by default. DSH's registry can scope a job by owner or not at
    // all — it has no notion of a workspace — so a global job surfaces in every
    // conversation, including ones in a different project. Session scope is the
    // only option that cannot leak across workspaces. The workspace-level view
    // is the plugin's own popover, which filters runs by workspace.
    jobScope: config.jobScope === 'global' ? 'global' : 'session',
  }
}

/** One request failure carrying the HTTP status and wire code to report. */
export class RequestError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

/**
 * Adapt `node:fs/promises` to the `io` port `lib/scan.js` expects.
 * `listDirNames` deliberately lets a read failure escape: the scanner treats a
 * throw from the workspace root as "unreadable" and returns an empty snapshot,
 * while a missing candidate directory is already handled by `readTextFile`.
 * @returns the filesystem port.
 */
export function createFsPort() {
  return {
    join: (...parts) => join(...parts),
    relative: (from, to) => relative(from, to).split(sep).join('/'),
    contains: (parent, child) => {
      const rel = relative(parent, child)
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
    },
    async readTextFile(path) {
      try {
        return await readFile(path, 'utf8')
      } catch {
        return undefined
      }
    },
    async listDirNames(path) {
      return readdir(path)
    },
  }
}

/**
 * The browser-trust fence, mirroring the one DSH's own `/api` gateway applies
 * (host-webserver's `isTrustedApiRequest`): the request's Host must be loopback
 * or a configured trusted authority, and cross-site browser markers are
 * refused. This is a DNS-rebinding / cross-site defense, not authentication —
 * it exists because these routes start processes.
 * @param headers - the incoming request headers.
 * @param trustedHosts - non-loopback authorities this deployment serves.
 * @returns true when the request may reach the plugin routes.
 */
export function isTrustedRequest(headers, trustedHosts) {
  const host = headers?.host
  if (typeof host !== 'string' || host.length === 0) return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  const loopback = hostUrl.hostname === 'localhost'
    || hostUrl.hostname === '[::1]'
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostUrl.hostname)
  if (!loopback) {
    const trusted = Array.isArray(trustedHosts) && trustedHosts.some((entry) => {
      try {
        const entryUrl = new URL(`http://${entry}`)
        return entryUrl.host === hostUrl.host || entryUrl.hostname === hostUrl.hostname
      } catch {
        return false
      }
    })
    if (!trusted) return false
  }
  if (headers?.['sec-fetch-site'] === 'cross-site') return false
  const origin = headers?.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).hostname === hostUrl.hostname
  } catch {
    return false
  }
}

/** Write one JSON response. */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(payload)
}

/** Write the success envelope. */
function writeOk(res, value) {
  writeJson(res, 200, { ok: true, value })
}

/** Write the failure envelope for a thrown value. */
function writeError(res, error) {
  if (error instanceof RequestError) {
    writeJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  writeJson(res, 500, { ok: false, error: { code: 'internal', message } })
}

/** Read and parse a bounded JSON body. */
async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new RequestError(413, 'too-large', 'request body too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new RequestError(400, 'bad-request', 'request body is not valid JSON')
  }
}

/** Require a non-empty string field. */
function requireString(payload, key) {
  const value = payload?.[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new RequestError(400, 'bad-request', `missing or invalid "${key}"`)
  }
  return value
}

/** Require the request to use one of the allowed methods. */
function requireMethod(req, allowed) {
  const method = req.method ?? 'GET'
  if (!allowed.includes(method)) {
    throw new RequestError(405, 'method-error', `${method} not allowed; use ${allowed.join(' or ')}`)
  }
  return method
}

/**
 * Decide which workspace directory a request is really about.
 *
 * The Session's own header cwd is authoritative and wins whenever it can be
 * read, so a caller cannot point the plugin at an arbitrary directory by
 * editing a query string. The client-supplied value is only a fallback for
 * deployments where the session store cannot answer — and even then
 * `resolveRun` still confines every run to the directory that was chosen and
 * requires the script to be declared in that directory's own manifest.
 * @param deps - the request dependencies.
 * @param sessionId - the Session id the browser sent, when it sent one.
 * @param provided - the raw directory the browser sent.
 * @returns the chosen directory, or undefined when neither source answered.
 */
function resolveCwd(deps, sessionId, provided) {
  if (typeof sessionId === 'string' && sessionId.length > 0) {
    const session = deps.sessions()?.get?.(sessionId)
    const cwd = session?.header?.cwd
    if (typeof cwd === 'string' && cwd.length > 0) return cwd
  }
  return typeof provided === 'string' && provided.length > 0 ? provided : undefined
}

/**
 * Answer one request against the plugin's routes.
 *
 * This function owns the whole response lifecycle, including failures: it
 * never rejects, and every outcome — success, a refused request, or an
 * unexpected fault — leaves a JSON envelope on the wire. Callers can therefore
 * hand it straight to `webServer.register` without a wrapper.
 * @param req - the Node HTTP request.
 * @param res - the Node HTTP response.
 * @param deps - `{ io, runner, config, trustedHosts, sessions }`.
 */
export async function handleRequest(req, res, deps) {
  try {
    await dispatchRequest(req, res, deps)
  } catch (error) {
    if (res.writableEnded === true) return
    writeError(res, error)
  }
}

/**
 * Route and serve one request, throwing `RequestError` for refused input.
 * @param req - the Node HTTP request.
 * @param res - the Node HTTP response.
 * @param deps - the request dependencies.
 */
async function dispatchRequest(req, res, deps) {
  if (!isTrustedRequest(req.headers, deps.trustedHosts())) {
    writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden request origin' } })
    return
  }
  const url = new URL(req.url ?? '/', 'http://dsh.internal')
  if (url.pathname !== ROUTE_PREFIX && !url.pathname.startsWith(`${ROUTE_PREFIX}/`)) {
    writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown route' } })
    return
  }
  const action = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\/+/, '')

  switch (action) {
    case 'state': {
      requireMethod(req, ['GET'])
      const cwd = resolveCwd(deps, url.searchParams.get('sessionId'), url.searchParams.get('cwd'))
      if (cwd === undefined) throw new RequestError(400, 'bad-request', 'no workspace: pass a resolvable "sessionId" or a "cwd" query parameter')
      writeOk(res, await scanWorkspace(deps.io, { cwd, maxPackages: deps.config.maxPackages }))
      return
    }

    case 'jobs': {
      requireMethod(req, ['GET'])
      writeOk(res, { jobs: deps.runner.list() })
      return
    }

    case 'job': {
      requireMethod(req, ['GET'])
      const id = url.searchParams.get('id')
      if (id === null || id.length === 0) throw new RequestError(400, 'bad-request', 'missing "id" query parameter')
      const job = deps.runner.get(id)
      if (job === undefined) throw new RequestError(404, 'not-found', 'unknown run')
      writeOk(res, { job })
      return
    }

    case 'run': {
      requireMethod(req, ['POST'])
      const payload = await readJsonBody(req)
      const cwd = resolveCwd(deps, payload?.sessionId, payload?.cwd)
      if (cwd === undefined) throw new RequestError(400, 'bad-request', 'no workspace: pass a resolvable "sessionId" or a "cwd"')
      const dir = requireString(payload, 'dir')
      const script = requireString(payload, 'script')
      const resolved = await resolveRun(deps.io, { cwd, dir, script })
      if (resolved.error !== undefined) throw new RequestError(400, 'bad-request', resolved.error)
      const started = deps.runner.start({
        command: resolved.command,
        args: resolved.args,
        cwd: resolved.cwd,
        workspace: cwd,
        label: resolved.label,
        script,
        packageName: resolved.packageName,
        dir,
      })
      if (started.error !== undefined) throw new RequestError(429, 'too-many-runs', started.error)
      // Expose the run through DSH's own registry when it can be scoped to this
      // Session; otherwise it stays visible only in this plugin's popover.
      const dshJobId = deps.publishRun({
        runId: started.job.id,
        label: resolved.label,
        sessionId: payload?.sessionId,
      })
      deps.log?.(
        dshJobId === undefined
          ? 'started %s in %s (plugin-only)'
          : 'started %s in %s as DSH job %s',
        resolved.label,
        resolved.cwd,
        ...(dshJobId === undefined ? [] : [dshJobId]),
      )
      writeOk(res, { job: started.job, dshJobId })
      return
    }

    case 'stop': {
      requireMethod(req, ['POST'])
      const payload = await readJsonBody(req)
      const id = requireString(payload, 'id')
      const stopped = deps.runner.stop(id)
      if (stopped.error !== undefined) throw new RequestError(404, 'not-found', stopped.error)
      // Kill the process first, then tell DSH this stop is accounted for. Without
      // the second step the registry's record still settles unreported, and
      // `dsh-tool-jobs` injects a "background job X finished" notice into the
      // Session — as a followup that starts a fresh agent turn when the agent is
      // idle — for something the user did deliberately on the page.
      deps.noteUserStop({ runId: id, reason: 'stopped from the panel' })
      writeOk(res, { status: stopped.status })
      return
    }

    case 'clear': {
      requireMethod(req, ['POST'])
      // Drops settled records only; live runs are left alone.
      writeOk(res, deps.runner.clear())
      return
    }

    default:
      writeJson(res, 404, { ok: false, error: { code: 'not-found', message: `unknown route: ${action}` } })
  }
}

/**
 * Build the per-request "surface this run to DSH" callback.
 *
 * The services are read through getters at request time rather than captured at
 * apply time, which keeps the plugin independent of activation order relative
 * to the `jobs` and `agents` services.
 *
 * `scope` decides who can see the run afterwards. It is a real trade-off,
 * because DSH's registry only scopes jobs by owner — it has no notion of a
 * workspace — so neither value can express "visible in this workspace":
 *
 *   'session' Owned by this Session's live agent. DSH's list shows it only
 *             there, and reaps it when that agent is disposed. This is the
 *             default because it is the only option that cannot surface one
 *             project's run inside a different project. The cost is that
 *             another conversation in the *same* workspace does not see it in
 *             DSH's list — the plugin's own popover is the workspace-scoped
 *             view that covers that case.
 *   'global'  No owner, so DSH lists it in EVERY conversation, including ones
 *             in other workspaces, and it never gets reaped. Useful when you
 *             want the agent to reach a run from anywhere and accept that
 *             reach being machine-wide.
 *
 * A Session-scoped job also needs a live agent; without one the run stays
 * plugin-only rather than silently becoming global.
 * @param options - `{ getJobs, getAgents, bridge, enabled, scope }`.
 * @returns `(request: { runId, label, sessionId }) => string | undefined`.
 */
export function createRunPublisher(options) {
  const { getJobs, getAgents, bridge, enabled = true, scope = 'session' } = options
  return (request) => {
    if (enabled !== true) return undefined
    const jobs = getJobs()
    if (jobs === undefined) return undefined
    if (scope === 'global') {
      return bridge.publish({ jobs, runId: request.runId, label: request.label })
    }
    const agent = liveAgent(getAgents(), request.sessionId)
    if (agent === undefined) return undefined
    return bridge.publish({ jobs, agent, runId: request.runId, label: request.label })
  }
}

/**
 * Build everything one plugin activation needs: the run registry, the DSH
 * bridge, the request dependencies, and the two callbacks the routes use to
 * reach DSH.
 *
 * This is separate from `apply` so tests can drive the exact object `apply`
 * hands to `handleRequest`, with a fake process spawner. Mirroring that object
 * by hand in a test is how a route ends up calling a dependency nobody wired.
 * @param ctx - the host cordis context.
 * @param config - the plugin row's `config` block.
 * @param overrides - test seams: `{ io, runner, spawn }`.
 * @returns `{ config, runner, bridge, deps }`.
 */
export function createPluginState(ctx, config, overrides = {}) {
  const resolved = resolveConfig(config)
  const io = overrides.io ?? createFsPort()
  const runner = overrides.runner ?? createRunner({
    maxJobs: resolved.maxJobs,
    maxRunning: resolved.maxRunning,
    bufferBytes: resolved.bufferBytes,
    spawn: overrides.spawn ?? spawn,
  })
  const trustedHosts = () => {
    const runtime = ctx.get('webRuntime')
    return Array.isArray(runtime?.trustedHosts) ? runtime.trustedHosts : []
  }
  // Read lazily and optionally: when the session store is present the header
  // cwd is authoritative, and when it is not the client value is still usable.
  const sessions = () => ctx.get('sessions')
  const log = typeof ctx.logger?.info === 'function'
    ? (...args) => ctx.logger.info(`[npm-runner] ${args[0]}`, ...args.slice(1))
    : undefined
  const warn = typeof ctx.logger?.warn === 'function'
    ? (...args) => ctx.logger.warn(`[npm-runner] ${args[0]}`, ...args.slice(1))
    : undefined

  const bridge = createJobsBridge({ runner, log: warn })
  const publishRun = createRunPublisher({
    getJobs: () => ctx.get('jobs'),
    getAgents: () => ctx.get('agents'),
    bridge,
    enabled: resolved.registerJobs,
    scope: resolved.jobScope,
  })

  /**
   * Mark a run the user stopped from the panel in DSH's registry, so its
   * completion notice is suppressed. Read through `ctx.get` for the same reason
   * as `publishRun`: no activation-order coupling.
   * @param request - `{ runId, reason }`.
   * @returns the registry outcome, or `'unavailable'` without a registry.
   */
  const noteUserStop = (request) => bridge.release({
    jobs: ctx.get('jobs'),
    runId: request.runId,
    reason: request.reason,
  })

  const deps = { io, runner, config: resolved, trustedHosts, sessions, log, publishRun, noteUserStop }

  return { config: resolved, runner, bridge, deps }
}

/**
 * Host plugin body: build the activation state and register the JSON routes
 * plus their disposal.
 * @param ctx - the host cordis context.
 * @param config - the plugin row's `config` block.
 */
export function apply(ctx, config) {
  const { config: resolved, runner, bridge, deps } = createPluginState(ctx, config)

  // Reserve the registry controller this deployment needs. Done through
  // `ctx.inject` so it happens whenever the jobs service appears, and through
  // `ctx.effect` so the reservation is released with the plugin fiber.
  if (resolved.registerJobs) {
    ctx.inject(['jobs'], (jobsCtx) => {
      jobsCtx.effect(
        () => bridge.attach(jobsCtx.jobs) ?? (() => {}),
        'dsh-npm-runner: background-job controller',
      )
    })
  }

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      // `handleRequest` owns its error envelope, so no wrapper is needed here.
      handler: (req, res) => handleRequest(req, res, deps),
    }),
    'dsh-npm-runner: json routes',
  )

  // Runs outlive a request by design, so they must not outlive the plugin.
  ctx.effect(() => () => { runner.dispose() }, 'dsh-npm-runner: stop background runs')

  deps.log?.('active on %s (maxPackages=%d maxJobs=%d)', ROUTE_PREFIX, resolved.maxPackages, resolved.maxJobs)
}

export default { name, inject, apply }
