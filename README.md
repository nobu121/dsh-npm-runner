# dsh-npm-runner

[![CI](https://github.com/nobu121/dsh-npm-runner/actions/workflows/ci.yml/badge.svg)](https://github.com/nobu121/dsh-npm-runner/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-npm-runner.svg)](https://www.npmjs.com/package/dsh-npm-runner)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that finds the npm scripts of the current workspace and runs any of them in the background.

- **Finds the scripts without walking `node_modules`** — the workspace root manifest, plus the packages its `workspaces` field declares or its immediate subdirectories.
- **One collapsible group per package**, like VS Code's NPM Scripts view, with the folded shape remembered per workspace.
- **Runs in the background**, with live output, elapsed time, and a **Stop** that reaps the whole process tree.
- **Uses each package's own package manager** (`pnpm`, `yarn`, `bun` or `npm`, from the lockfiles present) in each package's own directory.
- **Shows nothing when there is nothing to show.**

## Requirements

DSH `0.1.5-rc.1` or newer, and Node.js 20 or newer.

## Install

```sh
dsh plugin --profile web add -w dsh-npm-runner
```

`-w` is not optional: the profile directory is a pnpm workspace root, and pnpm refuses an `add` there without it.

To track the repository instead of a release:

```sh
dsh plugin --profile web add -w github:nobu121/dsh-npm-runner
```

Update or remove:

```sh
dsh plugin --profile web update -w dsh-npm-runner
dsh plugin --profile web remove dsh-npm-runner
```

**Restart DSH afterwards** — a newly added bundle is picked up at profile boot, not by a page refresh.

Working on the plugin itself? `dsh plugin --profile web add -w .` from the checkout links the working tree instead of taking a snapshot.

## Usage

| Session state | Where it appears |
| --- | --- |
| New session | Right-aligned on the workspace/mode row. |
| Conversation | In the header's action row, next to DSH's own background-task list. |

The control appears only when the current workspace has at least one script. Clicking it opens the script list:

- **One collapsible group per package**, labelled with the directory its scripts run in and a script count. With several packages there are also **Collapse all** / **Expand all**.
- **One row per script**, showing the name and the command it expands to. Clicking starts it in the background and expands its live output.
- **A running script** shows a status dot and elapsed time, with **Stop** to reap it. A dot on the trigger means something is running, so the state stays visible with the list closed.
- **The list is per workspace**: every run of the current workspace, including ones started from another conversation, and nothing from another project.
- **Clear finished**, on the **Background runs** header, drops completed, failed and stopped runs and leaves live ones alone.

## DSH background jobs

Runs are also registered with DSH's own background-job registry, so they join the job list and the agent can read them with `job_list` / `job_output` / `job_kill`.

Stopping a run from the panel marks it as accounted for, so DSH does not inject a *background job finished* notice into the session for a stop you asked for — a run that ends on its own still notifies. Set `registerJobs: false` to keep runs private to the plugin's own list.

## Configuration

Optional, on the plugin row in the profile's `cordis.patch.yml`:

```yaml
- id: npm-runner
  name: 'dsh-npm-runner'
  config:
    maxPackages: 60      # packages reported per scan
    maxJobs: 12          # retained runs; the oldest finished one is evicted first
    maxRunning: 6        # concurrently live runs
    bufferBytes: 65536   # retained output per run, in bytes
    registerJobs: true   # also register runs with DSH's background-job registry
    jobScope: session    # 'session' keeps a run inside its own conversation; 'global' shares it machine-wide
```

## Security

These routes start processes, so three limits apply: every request passes the same trust fence DSH's own gateway applies (loopback or a trusted `Host`, no cross-site, a matching `Origin`); the workspace comes from the Session rather than from the request; and a request cannot name a command — the client sends a directory and a script *name*, and the host re-reads that directory's own `package.json` and rebuilds `<packageManager> run <name>` itself. Runs start in the DSH host process, on the machine DSH runs on.

## Limitations

- **Clearing does not touch DSH's own job list.** DSH's background-task count keeps a finished entry until DSH restarts; its registry exposes no delete.
- **DSH's job list is not workspace-aware.** With the default `jobScope: 'session'`, a run does not appear there in another conversation, even one in the same workspace. The plugin's own list is the surface that matches by workspace.
- **The scanner never walks above the session's workspace**, and nothing is shown while no session is selected.

## Development

```sh
npm test          # hermetic: scanner, runner, job bridge, host routes, client bundle
npm run test:e2e  # really runs npm: the fixtures, the run lifecycle and the tree kill
```

`examples/` holds a second package of runnable fixtures — a long-lived service, a streamer, a high-volume writer, a process tree, a failure and a working-directory probe. It is not published, and `npm run test:e2e` drives all of it through the plugin's own registry.

## License

MIT
