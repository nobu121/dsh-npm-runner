# dsh-npm-runner

[![CI](https://github.com/nobu121/dsh-npm-runner/actions/workflows/ci.yml/badge.svg)](https://github.com/nobu121/dsh-npm-runner/actions/workflows/ci.yml)

A DeepSeek Harness plugin that finds the npm scripts of the current workspace and runs any of them in the background, from a small control that sits above the composer in a new session and in the header utility row of an established conversation.

- **Discovers scripts without walking `node_modules`.** The scanner reads the workspace root manifest, plus either the package directories its `workspaces` field declares or its immediate subdirectories — never a dependency tree.
- **Runs in the background**, keeps bounded output per run, and can stop a run's whole process tree (a dev server's real work lives in a grandchild).
- **Picks the right package manager** per package from the lockfiles present (`pnpm`, `yarn`, `bun`, or `npm`).
- **Shows nothing when there is nothing to show.** A workspace with no npm scripts never grows a dead button.

## Requirements

- DSH `0.1.5-rc.1` (the release this was built and verified against).
- Node.js 20 or newer.
- The package must be installed into the profile's `dsh.profile.bundles`; that is what makes the browser half discoverable (see *Install*).

## Install

From the plugin checkout:

```sh
dsh plugin --profile web add -w .
```

Or, from the published package:

```sh
dsh plugin --profile web add -w dsh-npm-runner
```

`dsh plugin` forwards to `pnpm` inside the profile directory and then appends the package to `dsh.profile.bundles`, because `package.json` declares `dsh.bundle`. **`-w` is not optional there**: the profile directory is itself a pnpm workspace root, and without the flag pnpm refuses the install with `ERR_PNPM_ADDING_TO_ROOT`. You can also mount it by hand from the profile's own `cordis.patch.yml` with the same `- insert:` row found in this package's `cordis.patch.yml`.

> **Restart DSH afterwards.** The web plugin table is scanned and the boot manifest composed at profile boot, so a newly added bundle is picked up on the next start — not by a page refresh.

To remove it:

```sh
dsh plugin --profile web remove -w dsh-npm-runner
```

## Usage

The control appears only when the current workspace actually has at least one npm script.

| Session state | Where it appears |
| --- | --- |
| New session (the empty Hero layout) | On the Hero's workspace/mode row, right-aligned — not on a line of its own. |
| Established conversation | The header's action row: just after the mode control and immediately before the built-in background-job list. |

The trigger is a single glyph — Solar's [`play-outline`](https://icones.js.org/collection/all?icon=solar:play-outline) — with no label or count beside it; the package headers inside the popover carry the counts. Running state shows as a small corner badge, so the button keeps the same 28px footprint as its neighbours.

Its styling is deliberately the same recipe DSH uses for its own header icon buttons (`dsh-session-log-export`'s `.moreButton`): a 28px round target tinted `--dsw-alias-label-secondary`, a 15px glyph, and a hover that only tints the background.

Exactly one of the two renders at a time: the header does not render its utility row while a session is still blank, and the composer dock is hidden again once the conversation has content.

Clicking it opens a popover listing the runnable scripts, shaped like VS Code's NPM Scripts view:

- **One collapsible group per package.** The header names the directory the scripts will run in — the workspace folder for the root package, its relative path for any other — with the package's own `name` beside it and a script count. Clicking the header folds the group. The choice is remembered per workspace, so a monorepo keeps the shape you gave it across popover opens and page reloads. With more than one package the header also offers **Collapse all / Expand all**.
- **Each row is one script**, indented under its package, showing the script name and the command it expands to. Clicking it starts the script in the background and expands its live output.
- **A running script** shows a status dot and elapsed time, with a **Stop** action that reaps the whole process tree. A dot on the trigger itself means something is running, so the state stays visible with the popover closed.
- **Visibility is by workspace.** The run list shows every run of the *current* workspace — including ones started from another conversation — and never a run from a different project. Switching conversations inside one project loses nothing; switching to a different project shows only that project.
- **Finished runs are yours to clear.** The **Background runs** header carries a **Clear finished** action on its right as soon as one exists. It drops completed, failed *and* stopped runs — none of them still owns a process — while leaving live ones alone, and reports a failure instead of failing silently. The plugin also evicts the oldest finished run past `maxJobs` on its own.

Each script runs in its own package directory, using that package's own package manager.

## DSH background jobs

Runs are also registered with DSH's own background-job registry, which means:

- they appear in the background-job list alongside any job the agent started;
- the agent can reach them with `job_list`, `job_output` and `job_kill` — so you can start a dev server by clicking, then ask the agent to read its log;
- DSH's kill path and this plugin's **Stop** button funnel into the single place that owns the process, so neither can orphan it.

**Stop is deliberate, so it does not talk back.** When a registered run settles unreported, `dsh-tool-jobs` injects a *background job … finished* notice into the owning Session — as a follow-up message that starts a fresh agent turn even when the agent is idle. That is right for a job that ends on its own and wrong for a process you stopped on purpose, so the plugin's **Stop** marks the DSH record as accounted for first. It does that by routing through `jobs.kill` — the registry's own reported-flag path — instead of only killing the process; that call also lands back on the same cancel hook, so the process is still stopped exactly once. A run that finishes *on its own* keeps its notice, and `job_kill` from the agent behaves as DSH defines it. Stopping a run that was never registered is a silent no-op.

This is an additive integration, not a hand-off. `ctx.jobs` is a registry, not an executor: `jobs.start(spec)` calls `spec.run()` and the caller supplies the process. The process is still spawned by this plugin, which is what keeps the tree kill and the un-sandboxed launch described below.

**Visibility is by workspace, and DSH's registry cannot express that.** It scopes jobs by owner (a Session) or not at all, so neither value means "visible in this workspace". The split that follows from that:

- The **plugin's own popover** is the workspace-scoped view, and it enforces the rule exactly: every run of the current workspace, including ones started from another conversation, and nothing from another project.
- The **DSH registration** therefore defaults to `jobScope: 'session'` — owned by the originating Session's live agent. That is the only option that cannot surface one project's run inside another project. The cost is that DSH's own job list (and the agent's `job_list`) does not show a run from a *different* conversation in the *same* workspace; the popover is what covers that case.

Set `jobScope: 'global'` if you would rather the agent reach a run from any conversation and accept that reach being machine-wide — DSH then lists it everywhere, including in other projects, and never reaps it.

The registry also needs a controller: the web profile mounts it but disables the model-facing `tool-jobs` row, so `jobs.start` refuses until the plugin reserves one with `ctx.jobs.attachController`. That reservation is scoped to the plugin fiber and released when the plugin stops.

Set `registerJobs: false` to turn the whole integration off.

## Examples

The repository ships `examples/`, a second package whose scripts exist so the plugin's behaviour can be *seen* rather than only asserted. It is excluded from the published tarball, and the scanner picks it up as its own collapsible group — so opening this package as a workspace gives you a two-group popover and one of each kind of run:

| Script | What it shows |
| --- | --- |
| `examples: serve` | A long-lived backend service. Prints its URL, logs a heartbeat every second and answers `/health`, so the status dot, the elapsed-time counter, the streaming output pane and **Stop** all have something real to watch. |
| `examples: stream` | A finite task that streams 24 progress lines, then settles as **completed**. |
| `examples: chatty` | Writes ~1.5 MiB as fast as it can, so the retained tail and the `truncated` flag are visible — the visible face of `bufferBytes`. |
| `examples: tree` | Spawns a grandchild, proving that stopping a run reaps the whole tree and not just the direct child. Prints both pids to check by hand. |
| `examples: fail` | Emits on stdout and stderr, then exits 3, producing a **failed** row with the exit code. |
| `examples: where` | Prints its own working directory and manifest, proving each script runs in *its own* package directory. |

Run one from the DSH popover, or directly:

```sh
cd examples
npm run serve      # PORT=4319 by default; falls back to a free port if taken
```

The output pane follows the newest line while a run is live, and stops following as soon as you scroll up — it resumes when you scroll back to the bottom.

## Configuration

All optional, set on the plugin row in the profile's `cordis.patch.yml`:

```yaml
- id: npm-runner
  name: 'dsh-npm-runner'
  config:
    maxPackages: 60      # cap on packages reported per scan
    maxJobs: 12          # cap on retained runs; oldest finished run is evicted first
    maxRunning: 6        # cap on concurrently live runs (further starts are refused)
    bufferBytes: 65536   # retained output per run, in bytes
    registerJobs: true   # also register runs with DSH's background-job registry
    jobScope: session    # 'session' (never leaks across workspaces) or 'global'
```

## HTTP surface

The browser half talks to the host half over ordinary same-origin JSON routes. They are usable on their own:

| Route | Purpose |
| --- | --- |
| `GET /npm-runner/state?cwd=<dir>&sessionId=<id>` | Packages and scripts found under the workspace. |
| `GET /npm-runner/jobs` | Every retained run, newest first, without output. |
| `GET /npm-runner/job?id=<id>` | One run, including its retained output. |
| `POST /npm-runner/run` | `{ cwd, sessionId, dir, script }` — start a run. |
| `POST /npm-runner/stop` | `{ id }` — request a stop. |
| `POST /npm-runner/clear` | Drop every finished run; returns `{ removed }`. |

Every response is `{ ok: true, value }` or `{ ok: false, error: { code, message } }`.

## Security

These routes start processes, so three independent limits apply.

1. **A trust fence** on every request, mirroring the one DSH's own `/api` gateway applies: the `Host` must be loopback or a configured trusted authority, `Sec-Fetch-Site: cross-site` is refused, and a present `Origin` must name that same hostname. This is a DNS-rebinding and cross-site defense, not authentication.
2. **The workspace comes from the host, not the request.** When `sessionId` can be resolved, its `SessionHeader.cwd` wins outright and a caller-supplied `cwd` is ignored. The supplied value is only a fallback for a deployment whose session store cannot answer.
3. **A request cannot name a command.** The client sends a directory and a script *name*. The host re-reads that directory's own `package.json`, requires the script to be declared there, and rebuilds `<packageManager> run <name>` itself. The manifest's raw command string is never executed, and the script name is matched against an allowlist (`^[A-Za-z0-9][A-Za-z0-9._:@+-]*$`) rather than escaped — which matters because Windows needs `shell: true` to execute the npm `.cmd` shim.

Runs are started in the host process, on the machine DSH itself runs on.

## Design notes

- **Typography follows the app, not the plugin.** The popover states `--dsw-font-family` once on its root, and only two things step down to the code font (`--ds-font-family-code`): a script's command line and a run's raw output. Note that `--dsw-font-mono` is **not** a real token — DSH's own `var(--dsw-font-mono)` silently resolves to the inherited UI font, so adding a fallback list (as this plugin originally did) forces monospace and makes the panel look foreign. A test pins this: no rule may reference `--dsw-font-mono`, and the code font may appear on exactly those two selectors.
- **No build step.** `lib/client.js` is a hand-written `window.__ModuleLoader__.load({ id: '<package name>', factory })` bundle, the format DSH's client module loader expects. It `require`s only `react` and `react-dom`, both of which the shell seeds, so it declares no `dsh.client.external` edges and cannot break when another plugin is absent or reordered. Icons, the popover and outside-click dismissal are implemented in the bundle rather than imported, for the same reason.
- **The plugin owns the process; DSH owns the job record.** `ctx.jobs` is a registry, not an executor — `jobs.start(spec)` runs `spec.run()` and takes the hooks, so the caller supplies the process. Registering with it (rather than trying to hand execution over) is what puts a run in the Session's job list and in reach of the agent's `job_*` tools, while the plugin keeps the tree kill and the un-sandboxed launch. `lib/jobs.js` is that bridge, and it refuses to publish an owner-less job because DSH lists those in every Session.
- **`node:fs` and `node:child_process` directly**, rather than `ctx.fs`/`ctx.subprocess`/`ctx.shell`. DSH's read paths are not sandbox-fenced, but `ctx.subprocess` deliberately never shell-interprets `argv` (so it cannot run the npm `.cmd` shim on Windows) and exposes no pid to kill a tree by; and `ctx.shell` on Windows is the sandbox-confined pwsh executor, whose policy root is the DSH process's own cwd rather than the workspace — which would deny a dev server writing to its own `node_modules/.cache`. The shipping third-party plugin used as a reference makes the same choices.
- **Runs never outlive the plugin.** The registry is disposed with the plugin fiber, which stops every live run.

## Files

```
lib/scan.js      workspace script discovery     — pure, no DSH, no fs
lib/runner.js    background run registry        — injected spawn/signals
lib/jobs.js      DSH background-job bridge       — the ctx.jobs integration
lib/index.js     host half: JSON routes         — node:http via ctx.webServer
lib/client.js    browser half: the control      — hand-written module bundle
examples/        a second package of runnable fixtures (not published)
tests/           one suite per module, plus the two that spawn real processes
cordis.patch.yml the plugin row for the profile
```

## Development

```sh
npm test          # 165 checks: scanner, runner, job bridge, host routes, client bundle
npm run test:e2e  # 14 more; really runs npm — the fixtures, the run lifecycle and the tree kill
```

`npm test` needs no network and spawns no process. `npm run test:e2e` is separate because it starts real children: it runs every `examples/` fixture through the plugin's own registry, makes a real HTTP request against the service it started, and checks that stopping a run actually reaped its grandchild. It skips nothing and stops every process it starts.

The two suites that need a filesystem or a child process are the only ones that touch the outside world. Everything else drives an injected port or a fake: `lib/scan.js` is tested through an in-memory `io`, and `lib/runner.js` through an injected `spawn` plus injected signal senders, which is how the POSIX and win32 kill paths are both covered on either platform.

The client suite renders its components through real React when it can find one — `DSH_PLUGIN_TEST_NODE_MODULES`, else the local DSH profile store, else this checkout's own `node_modules`. With none of those it still runs: three render cases skip and the other 35 assert the loader contract, the stylesheet, the label and visibility helpers and the collapse behaviour, none of which need React. CI installs React for exactly that reason, which is why the package can have no dependencies and still be fully tested.

## Limitations

- **New sessions only, when a session exists.** With no session selected at all, DSH renders neither seat this plugin uses, so no control is shown. Runs are also matched by workspace, so they appear only once that Session's workspace resolves.
- **One workspace per session for *scripts*.** The scanner never walks above the session's `cwd`, so a script in a parent directory is not offered.
- **No session-less root surface.** If you want the control on a completely blank page, the only additive root-scope seat is `shell.overlay`; that is a deliberate follow-up, not an oversight.
- **Clearing does not touch DSH's own job list.** **Clear finished** empties *this plugin's* list. DSH's background-task count keeps the finished entry until DSH restarts, because its registry exposes no delete — only disposing the owning agent or the service removes a record, and the registry does not re-broadcast after a removal either. Set `registerJobs: false` if you would rather DSH never list plugin runs at all; the popover keeps working either way.
- **DSH's own job list is not workspace-aware.** The registry scopes by owner or not at all, so the default `jobScope: 'session'` keeps a run out of DSH's list in other conversations of the same workspace, while `jobScope: 'global'` puts it in *every* conversation, including other projects. The popover is the surface that matches by workspace either way.

## License

MIT
