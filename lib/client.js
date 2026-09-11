window.__ModuleLoader__.load({
	id: "dsh-npm-runner",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		// Only `react` and `react-dom` are required from the shell. Everything
		// else — icons, the popover, outside-click dismissal — is built here, so
		// this bundle has no dependency on another plugin's bundle and cannot be
		// broken by one being absent or reordered.
		const React = require("react");
		const ReactDOM = require("react-dom");
		const h = React.createElement;

		const ROUTE = "/npm-runner";
		const NS = "npmRunner";

		//#region styles
		// Colours come only from `--dsw-*` theme tokens, which already carry a
		// light and a dark value, so the control re-themes with the app. The
		// fallbacks after each comma are the last resort for a page with no
		// theme layer at all.
		const CSS = [
			// The blank-Session control belongs on the Hero's workspace/preset row,
			// not on a line of its own. That row is this slot's previous sibling in
			// the composer stack, so the row here claims no height and the trigger
			// is pulled up by exactly the `composerHero` gap (8px) — which lands it
			// on the same line, since both controls share the 28px control metric.
			// 16px matches that row's own right padding so the two right edges align.
			".dsh-npmr-dockRow{display:flex;justify-content:flex-end;width:100%;min-width:0;height:0;position:relative}",
			".dsh-npmr-dock{position:absolute;right:16px;bottom:8px}",
			// Deliberately the same recipe as DSH's own header icon buttons (see
			// dsh-session-log-export's `.moreButton`): a 28px round target tinted
			// with `label-secondary` and a 15px glyph, whose hover only tints the
			// background. Anything else reads as a foreign widget next to them.
			".dsh-npmr-trigger{position:relative;box-sizing:border-box;width:28px;height:28px;flex:none;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:0;border-radius:28px;justify-content:center;align-items:center;padding:6px;display:inline-flex}",
			".dsh-npmr-trigger svg{width:15px;height:15px}",
			".dsh-npmr-trigger:hover,.dsh-npmr-trigger:focus-visible{background:var(--dsw-alias-interactive-bg-hover);outline:none}",
			".dsh-npmr-trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover)}",
			".dsh-npmr-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#3fb950)}",
			// The trigger's running indicator is a corner badge so the button keeps
			// the 28px square footprint the neighbouring icons share.
			".dsh-npmr-dotBadge{position:absolute;top:3px;right:3px;box-shadow:0 0 0 2px var(--dsw-alias-bg-base)}",
			".dsh-npmr-dot[data-state=running]{background:var(--dsw-alias-state-warn-primary,#d29922)}",
			".dsh-npmr-dot[data-state=stopping]{background:var(--dsw-alias-state-warn-primary,#d29922)}",
			".dsh-npmr-dot[data-state=killed]{background:var(--dsw-alias-state-warn-primary,#d29922)}",
			".dsh-npmr-dot[data-state=failed]{background:var(--dsw-alias-state-error-primary,#f85149)}",
			// The popover is portaled to <body>, so it would otherwise inherit
			// whatever font happens to be there. Stating the app's own UI font once
			// on the menu means every label matches DSH's chrome, and only genuine
			// code — a script's command line, a run's raw output — steps down to the
			// code font. (`--dsw-font-mono` is NOT a real token: DSH's own
			// `var(--dsw-font-mono)` silently resolves to the inherited UI font,
			// while a fallback list would have forced monospace here and made the
			// whole panel look foreign.)
			".dsh-npmr-menu{position:fixed;z-index:1000;box-sizing:border-box;width:min(380px,calc(100vw - 24px));max-height:min(460px,calc(100vh - 96px));overflow:auto;display:flex;flex-direction:column;gap:1px;margin:0;padding:4px;list-style:none;font-family:var(--dsw-font-family);font-size:13px;line-height:18px;background:var(--dsw-specific-menu);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);border:0;border-radius:14px}",
			".dsh-npmr-head{display:flex;align-items:center;gap:8px;padding:4px 6px 6px}",
			".dsh-npmr-headTitle{flex:1;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dsh-npmr-ghost{flex:none;cursor:pointer;background:0 0;border:0;border-radius:6px;padding:3px 6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}",
			".dsh-npmr-ghost:hover,.dsh-npmr-ghost:focus-visible{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);outline:none}",
			".dsh-npmr-chevron{flex:none;transition:transform .12s;color:var(--dsw-alias-label-tertiary)}",
			".dsh-npmr-chevronOpen{transform:rotate(90deg)}",
			".dsh-npmr-group{list-style:none;margin:0;padding:0}",
			".dsh-npmr-pkg{display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;min-height:28px;padding:4px 8px;border:0;border-radius:8px;background:0 0;text-align:left;cursor:pointer;color:var(--dsw-alias-label-secondary)}",
			".dsh-npmr-pkg:hover,.dsh-npmr-pkg:focus-visible{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);outline:none}",
			".dsh-npmr-pkgName{flex:none;max-width:60%;font-size:13px;line-height:18px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dsh-npmr-pkgMeta{flex:1;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dsh-npmr-pkgCount{flex:none;font-size:10px;line-height:16px;padding:0 5px;border-radius:5px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}",
			".dsh-npmr-scripts{list-style:none;margin:0;padding:0 0 2px 16px}",
			".dsh-npmr-section{display:flex;align-items:center;gap:8px;padding:7px 8px 2px;font-size:11px;line-height:16px;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}",
			".dsh-npmr-sectionLabel{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dsh-npmr-row{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;min-height:32px;padding:5px 8px;border:0;border-radius:8px;background:0 0;text-align:left;cursor:pointer;color:var(--dsw-alias-label-primary)}",
			".dsh-npmr-row:hover:not(:disabled),.dsh-npmr-row:focus-visible:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);outline:none}",
			".dsh-npmr-row:disabled{cursor:default;opacity:.55}",
			".dsh-npmr-name{flex:none;font-size:13px;line-height:18px;font-weight:500}",
			".dsh-npmr-cmd{flex:1;min-width:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dsh-npmr-sep{height:1px;margin:5px 6px;background:var(--dsw-alias-border-l1)}",
			".dsh-npmr-run{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:8px}",
			".dsh-npmr-run:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".dsh-npmr-runLabel{flex:1;min-width:0;font-size:13px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:0 0;border:0;color:inherit;text-align:left;cursor:pointer;padding:0}",
			".dsh-npmr-runLabel:focus-visible{outline:1px solid var(--dsw-alias-border-l2);border-radius:4px}",
			".dsh-npmr-meta{flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}",
			".dsh-npmr-output{margin:2px 8px 6px;padding:6px 8px;max-height:180px;overflow:auto;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;line-height:16px;white-space:pre-wrap;word-break:break-word}",
			".dsh-npmr-error{margin:2px 8px 6px;padding:6px 8px;border-radius:8px;font-size:11px;line-height:16px;color:var(--dsw-alias-state-error-primary,#f85149);background:var(--dsw-alias-bg-layer-2)}",
			".dsh-npmr-empty{padding:10px 8px;font-size:13px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
		].join("");
		const TAG_ID = "dsh-npm-runner/client.css";
		if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + TAG_ID + '"]') === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-npm-runner";
			tag.dataset.pluginCss = TAG_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region dictionaries
		/** Simplified Chinese — the key-set source of truth. */
		const zh = {
			"trigger": "运行 npm 脚本",
			"menu.aria": "可运行的 npm 脚本",
			"loading": "正在扫描工作区…",
			"empty": "当前工作区没有 npm 脚本",
			"refresh": "重新扫描",
			"scanFailed": "扫描失败",
			"runFailed": "启动失败",
			"runs": "后台运行",
			"clearFinished": "清理已结束",
			"clearFailed": "清理失败",
			"collapseAll": "全部折叠",
			"expandAll": "全部展开",
			"noOutput": "暂无输出",
			"stop": "停止",
			"status.running": "运行中",
			"status.stopping": "正在停止",
			"status.completed": "已完成",
			"status.failed": "已失败",
			"status.killed": "已停止",
			"more": "还有 {count} 个脚本未显示",
		};
		/** English, key-identical to the Chinese source of truth. */
		const en = {
			"trigger": "Run an npm script",
			"menu.aria": "Runnable npm scripts",
			"loading": "Scanning workspace…",
			"empty": "No npm scripts in this workspace",
			"refresh": "Rescan",
			"scanFailed": "Scan failed",
			"runFailed": "Could not start",
			"runs": "Background runs",
			"clearFinished": "Clear finished",
			"clearFailed": "Could not clear",
			"collapseAll": "Collapse all",
			"expandAll": "Expand all",
			"noOutput": "No output yet",
			"stop": "Stop",
			"status.running": "running",
			"status.stopping": "stopping",
			"status.completed": "completed",
			"status.failed": "failed",
			"status.killed": "stopped",
			"more": "{count} more script(s) not shown",
		};
		//#endregion

		//#region helpers
		/** Interpolate `{name}` placeholders. */
		function format(template, params) {
			if (params === undefined) return template;
			return template.replace(/\{(\w+)\}/g, (whole, key) => (key in params ? String(params[key]) : whole));
		}

		/**
		 * Mirror of the shell's conversation phase rule: a Session is "blank"
		 * (the Hero layout, no messages yet) when it has no conversation
		 * targets, has not left its first-turn state, and is not running.
		 * @param session - the Session snapshot, when one exists.
		 * @param conversation - the Conversation snapshot, when one exists.
		 * @returns true for a brand-new Session.
		 */
		function isBlankSession(session, conversation) {
			if (session === undefined || session === null) return true;
			const targets = conversation === undefined || conversation === null ? undefined : conversation.activeTargets;
			if (targets !== undefined && targets !== null && targets.size > 0) return false;
			if (session.blank === false && session.awaitingFirstTurn !== true) return false;
			if (session.running === true) return false;
			return session.promptAttempted !== true;
		}

		/** Status word for one run. */
		function statusLabel(status, tr) {
			return tr("status." + status);
		}

		/** Elapsed time in at most two adjacent units. */
		function formatDuration(ms) {
			const total = Math.max(0, Math.floor(ms / 1000));
			const seconds = total % 60;
			const minutes = Math.floor(total / 60) % 60;
			const hours = Math.floor(total / 3600);
			if (hours > 0) return hours + "h " + minutes + "m";
			if (minutes > 0) return minutes + "m " + seconds + "s";
			return seconds + "s";
		}

		/** One JSON call against the plugin's host routes. */
		async function call(path, options) {
			const init = { method: options?.method ?? "GET" };
			if (options?.body !== undefined) {
				init.headers = { "content-type": "application/json" };
				init.body = JSON.stringify(options.body);
			}
			const response = await fetch(ROUTE + path, init);
			let payload;
			try {
				payload = await response.json();
			} catch {
				payload = undefined;
			}
			if (payload === undefined || payload.ok !== true) {
				throw new Error(payload?.error?.message ?? "HTTP " + response.status);
			}
			return payload.value;
		}

		/** Final path segment, tolerating either separator. */
		function baseName(path) {
			const trimmed = String(path).replace(/[/\\]+$/, "");
			const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
			return index === -1 ? trimmed : trimmed.slice(index + 1);
		}

		/**
		 * Labels for one package group header.
		 *
		 * The primary label identifies where the scripts run — the workspace
		 * folder name for the root package, its relative path for any other —
		 * because that is the fact a script list has to make obvious. The
		 * package's own `name` is secondary, and is dropped when it would only
		 * repeat the primary label.
		 * @param pkg - one package from the scan snapshot.
		 * @returns `{ name, meta }`, with `meta` possibly undefined.
		 */
		function packageLabel(pkg) {
			const rel = pkg.relDir;
			const primary = rel === undefined || rel === "" || rel === "." ? baseName(pkg.dir) : rel;
			const meta = pkg.name !== undefined && pkg.name !== primary ? pkg.name : undefined;
			return { name: primary, meta };
		}

		/**
		 * The runs visible in one workspace.
		 *
		 * Visibility is by workspace and nothing else: a run started from another
		 * conversation in the same workspace is still this workspace's business,
		 * while a run from a different project is not shown at all. A run whose
		 * own workspace is unknown never matches, and an unresolved workspace
		 * matches nothing — the rule is stated once, here, so it cannot drift
		 * between the callers.
		 * @param jobs - every run the plugin knows about.
		 * @param cwd - the current workspace root.
		 * @returns the runs belonging to that workspace.
		 */
		function runsForWorkspace(jobs, cwd) {
			if (typeof cwd !== "string" || cwd === "") return [];
			return jobs.filter((job) => job.workspace === cwd);
		}

		/** localStorage key holding one workspace's collapsed package groups. */
		const COLLAPSED_KEY = "dsh-npm-runner:collapsed:";

		/**
		 * Read the collapsed set for one workspace. Persisted so the shape a
		 * user chose survives closing the popover and reloading the page, and
		 * scoped per workspace so two projects keep their own shape.
		 * @param cwd - the workspace root.
		 * @returns a map of package directory to `true`.
		 */
		function readCollapsed(cwd) {
			const empty = {};
			if (typeof cwd !== "string" || cwd === "") return empty;
			try {
				const raw = window.localStorage.getItem(COLLAPSED_KEY + cwd);
				if (raw === null) return empty;
				const parsed = JSON.parse(raw);
				if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return empty;
				const out = {};
				for (const key of Object.keys(parsed)) if (parsed[key] === true) out[key] = true;
				return out;
			} catch {
				// A blocked, unavailable or corrupt store must never break the list.
				return empty;
			}
		}

		/** Persist the collapsed set for one workspace, best effort. */
		function writeCollapsed(cwd, value) {
			if (typeof cwd !== "string" || cwd === "") return;
			try {
				window.localStorage.setItem(COLLAPSED_KEY + cwd, JSON.stringify(value));
			} catch {
				// Same as above: the control works without persistence.
			}
		}

		/** Disclosure chevron; points right when collapsed, down when expanded. */
		function ChevronIcon(props) {
			return h("svg", {
				viewBox: "0 0 16 16",
				width: 12,
				height: 12,
				"aria-hidden": "true",
				focusable: "false",
				className: props.open === true ? "dsh-npmr-chevron dsh-npmr-chevronOpen" : "dsh-npmr-chevron",
			}, h("path", {
				d: "M6 3.5 10.5 8 6 12.5",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: "1.6",
				strokeLinecap: "round",
				strokeLinejoin: "round",
			}));
		}

		/**
		 * The trigger glyph: Solar's `play-outline` (solar:play-outline), an
		 * outlined play triangle that reads as "run" without the weight of a
		 * filled one. 24-unit source box, drawn at the neighbouring controls'
		 * 14px and coloured by the button through `currentColor`.
		 */
		function RunIcon(props) {
			return h(
				"svg",
				{ viewBox: "0 0 24 24", width: 14, height: 14, "aria-hidden": "true", focusable: "false", ...props },
				h("path", {
					fill: "currentColor",
					fillRule: "evenodd",
					clipRule: "evenodd",
					d: "M7.23832 3.04445C5.65196 2.1818 3.75 3.31957 3.75 5.03299L3.75 18.9672C3.75 20.6806 5.65196 21.8184 7.23832 20.9557L20.0503 13.9886C21.6499 13.1188 21.6499 10.8814 20.0503 10.0116L7.23832 3.04445ZM2.25 5.03299C2.25 2.12798 5.41674 0.346438 7.95491 1.72669L20.7669 8.6938C23.411 10.1317 23.411 13.8685 20.7669 15.3064L7.95491 22.2735C5.41674 23.6537 2.25 21.8722 2.25 18.9672L2.25 5.03299Z",
				}),
			);
		}
		//#endregion

		//#region component
		/**
		 * The compact run control.
		 *
		 * Registered twice — once in the composer dock and once in the session
		 * header — and exactly one of the two renders for any given Session:
		 * the dock owns a blank Session (where the header's utility row is not
		 * yet the natural home) and the header owns an established
		 * conversation. The control renders nothing at all until the workspace
		 * is known to have at least one script, so a repository without npm
		 * scripts never grows a dead affordance.
		 * @param props - standard slot props plus `placement` and the namespace translator.
		 */
		function NpmRunnerControl(props) {
			const { sessionId, useSessions, useSession, useConversation, placement, t } = props;
			const tr = typeof t === "function" ? t : (key, params) => format(en[key] ?? key, params);

			// Every hook runs unconditionally, before any early return.
			const cwd = useSessions((state) => (sessionId === undefined ? undefined : state.byId[sessionId]?.cwd));
			const session = useSession((state) => state);
			const conversation = useConversation((state) => state);
			const [snapshot, setSnapshot] = React.useState(undefined);
			const [scanError, setScanError] = React.useState(undefined);
			const [open, setOpen] = React.useState(false);
			const [anchor, setAnchor] = React.useState(undefined);
			const [jobs, setJobs] = React.useState([]);
			const [runError, setRunError] = React.useState(undefined);
			const [clearError, setClearError] = React.useState(undefined);
			const [busy, setBusy] = React.useState(false);
			const [expanded, setExpanded] = React.useState(undefined);
			const [output, setOutput] = React.useState(undefined);
			const [collapsed, setCollapsed] = React.useState(() => ({}));
			const [, forceTick] = React.useState(0);
			const triggerRef = React.useRef(null);
			const menuRef = React.useRef(null);
			const outputRef = React.useRef(null);
			/**
			 * Whether the output pane should keep following the tail. True until
			 * the reader scrolls away from the bottom, so a live task's newest
			 * lines stay visible without fighting someone reading back.
			 */
			const followRef = React.useRef(true);
			const scanGeneration = React.useRef(0);

			const blank = isBlankSession(session, conversation);
			const visible = placement === "dock" ? blank : !blank;

			const scan = React.useCallback((generation) => {
				if (cwd === undefined || cwd === "") return;
				// `sessionId` rides along so the host can resolve the workspace from
				// its own session store rather than trusting this path.
				const query = "/state?cwd=" + encodeURIComponent(cwd)
					+ (sessionId === undefined ? "" : "&sessionId=" + encodeURIComponent(sessionId));
				call(query)
					.then((value) => {
						if (generation !== scanGeneration.current) return;
						setSnapshot(value);
						setScanError(undefined);
					})
					.catch((error) => {
						if (generation !== scanGeneration.current) return;
						setScanError(error instanceof Error ? error.message : String(error));
					});
			}, [cwd, sessionId]);

			// A package group collapses on its header, and the choice is persisted
			// per workspace so the list keeps the shape the user gave it.
			const togglePackage = React.useCallback((dir) => {
				setCollapsed((current) => {
					const next = { ...current };
					if (next[dir] === true) delete next[dir];
					else next[dir] = true;
					writeCollapsed(cwd, next);
					return next;
				});
			}, [cwd]);

			// Rescan whenever the Session's workspace changes. Running this from an
			// effect (not on open) is what lets the icon appear or stay hidden
			// without the user opening the menu first.
			React.useEffect(() => {
				scanGeneration.current += 1;
				setSnapshot(undefined);
				setScanError(undefined);
				setJobs([]);
				setExpanded(undefined);
				setOutput(undefined);
				setCollapsed(readCollapsed(cwd));
				scan(scanGeneration.current);
			}, [scan]);

			// Poll the run registry while the control is on screen: slower when the
			// menu is closed (enough to keep the running dot honest) and faster
			// while it is open.
			React.useEffect(() => {
				if (!visible) return;
				let cancelled = false;
				const tick = () => {
					call("/jobs")
						.then((value) => {
							if (!cancelled) setJobs(Array.isArray(value.jobs) ? value.jobs : []);
						})
						.catch(() => {});
				};
				tick();
				const timer = setInterval(tick, open ? 1200 : 4000);
				return () => {
					cancelled = true;
					clearInterval(timer);
				};
			}, [visible, open, cwd]);

			// A live run list is also a clock: re-render once a second so durations
			// advance without a dedicated interval per row.
			const liveJobs = jobs.filter((job) => job.status === "running" || job.status === "stopping");
			React.useEffect(() => {
				if (!open || liveJobs.length === 0) return;
				const timer = setInterval(() => forceTick((value) => value + 1), 1000);
				return () => clearInterval(timer);
			}, [open, liveJobs.length]);

			const computeAnchor = React.useCallback((rect) => {
				const gap = 6;
				const spaceBelow = window.innerHeight - rect.bottom;
				// The dock sits directly above the composer, so opening downward
				// would cover the very control the user is about to type in.
				const useBelow = placement !== "dock" && spaceBelow >= 240;
				return {
					right: Math.max(8, Math.min(window.innerWidth - rect.right, window.innerWidth - 240)),
					top: useBelow ? rect.bottom + gap : undefined,
					bottom: useBelow ? undefined : Math.max(8, window.innerHeight - rect.top + gap),
				};
			}, [placement]);

			const openMenu = React.useCallback(() => {
				const rect = triggerRef.current?.getBoundingClientRect();
				if (rect !== undefined) setAnchor(computeAnchor(rect));
				setRunError(undefined);
				setOpen(true);
			}, [computeAnchor]);

			React.useEffect(() => {
				if (!open) return;
				const recompute = () => {
					const rect = triggerRef.current?.getBoundingClientRect();
					if (rect === undefined) return;
					setAnchor(computeAnchor(rect));
				};
				const onPointerDown = (event) => {
					const target = event.target;
					if (menuRef.current?.contains(target) === true) return;
					if (triggerRef.current?.contains(target) === true) return;
					setOpen(false);
				};
				const onKeyDown = (event) => {
					if (event.key !== "Escape") return;
					event.preventDefault();
					setOpen(false);
					triggerRef.current?.focus();
				};
				window.addEventListener("resize", recompute);
				window.addEventListener("scroll", recompute, true);
				document.addEventListener("pointerdown", onPointerDown, true);
				document.addEventListener("keydown", onKeyDown);
				return () => {
					window.removeEventListener("resize", recompute);
					window.removeEventListener("scroll", recompute, true);
					document.removeEventListener("pointerdown", onPointerDown, true);
					document.removeEventListener("keydown", onKeyDown);
				};
			}, [open, computeAnchor]);

			// Load output for whichever run is expanded.
			React.useEffect(() => {
				if (!open || expanded === undefined) return;
				// Opening a different run starts fresh, following the tail again.
				followRef.current = true;
				let cancelled = false;
				const load = () => {
					call("/job?id=" + encodeURIComponent(expanded))
						.then((value) => {
							if (!cancelled) setOutput(value.job?.output ?? "");
						})
						.catch(() => {});
				};
				load();
				const timer = setInterval(load, 1500);
				return () => {
					cancelled = true;
					clearInterval(timer);
				};
			}, [open, expanded]);

			// Keep the output pane pinned to the newest line while following. A
			// long-lived service's output is only useful if the newest line is the
			// one on screen, and the pane is far shorter than the retained buffer.
			React.useEffect(() => {
				const node = outputRef.current;
				if (node === null || followRef.current !== true) return;
				node.scrollTop = node.scrollHeight;
			}, [output]);

			const start = React.useCallback((pkg, script) => {
				setBusy(true);
				setRunError(undefined);
				call("/run", { method: "POST", body: { cwd, sessionId, dir: pkg.dir, script } })
					.then((value) => {
						setExpanded(value.job?.id);
						call("/jobs").then((next) => setJobs(Array.isArray(next.jobs) ? next.jobs : [])).catch(() => {});
					})
					.catch((error) => setRunError(error instanceof Error ? error.message : String(error)))
					.finally(() => setBusy(false));
			}, [cwd, sessionId]);

			const stop = React.useCallback((id) => {
				call("/stop", { method: "POST", body: { id } })
					.then(() => call("/jobs"))
					.then((value) => setJobs(Array.isArray(value.jobs) ? value.jobs : []))
					.catch(() => {});
			}, []);

			// Visibility is by WORKSPACE, not by conversation and not global: a run
			// started from another conversation in this same workspace is still
			// this workspace's business and stays listed here, while a run from a
			// different project is not this Session's concern at all. Without a
			// resolved workspace there is nothing to match against, so nothing is
			// claimed.
			if (!visible || cwd === undefined || cwd === "") return null;
			const packages = snapshot?.packages ?? [];
			const scriptCount = snapshot?.scriptCount ?? 0;
			const workspaceRuns = runsForWorkspace(jobs, cwd);
			const liveWorkspaceRuns = workspaceRuns.filter((job) => job.status === "running" || job.status === "stopping");
			const settledCount = workspaceRuns.filter((job) => job.status !== "running" && job.status !== "stopping").length;
			// Nothing to offer and nothing to report: stay out of the layout
			// entirely rather than showing a control that can only say "nothing".
			if (scriptCount === 0 && workspaceRuns.length === 0) return null;
			if (snapshot === undefined && scanError === undefined) return null;

			const now = Date.now();
			const triggerLabel = tr("trigger");
			const body = [];
			const allCollapsed = packages.length > 0 && packages.every((pkg) => collapsed[pkg.dir] === true);
			/** Collapse or expand every package group at once. */
			const setAllCollapsed = (value) => {
				const next = {};
				if (value === true) for (const pkg of packages) next[pkg.dir] = true;
				setCollapsed(next);
				writeCollapsed(cwd, next);
			};
			/**
			 * Drop every settled run — completed, failed and stopped alike, since
			 * none of them still owns a process.
			 *
			 * A failure is reported rather than swallowed: the clear route lives on
			 * the host half, so a deployment whose host has not been restarted since
			 * the route was added answers 404, and a silent no-op would be
			 * indistinguishable from a broken button.
			 */
			const clearFinished = () => {
				setClearError(undefined);
				call("/clear", { method: "POST", body: {} })
					.then(() => call("/jobs"))
					.then((value) => setJobs(Array.isArray(value.jobs) ? value.jobs : []))
					.catch((error) => {
						setClearError(error instanceof Error ? error.message : String(error));
					});
			};

			if (scanError !== undefined) {
				body.push(h("div", { key: "scan-error", className: "dsh-npmr-error" }, tr("scanFailed") + ": " + scanError));
			}
			if (runError !== undefined) {
				body.push(h("div", { key: "run-error", className: "dsh-npmr-error" }, tr("runFailed") + ": " + runError));
			}
			if (clearError !== undefined) {
				body.push(h("div", { key: "clear-error", className: "dsh-npmr-error" }, tr("clearFailed") + ": " + clearError));
			}

			if (scriptCount > 0) {
				let rendered = 0;
				for (const pkg of packages) {
					const isCollapsed = collapsed[pkg.dir] === true;
					const label = packageLabel(pkg);
					// Cap across the whole menu, not per package, so a monorepo with
					// hundreds of scripts cannot produce an unbounded tree.
					const rows = [];
					if (!isCollapsed) {
						for (const script of pkg.scripts) {
							if (rendered >= 200) break;
							rendered += 1;
							rows.push(h("li", { key: script.name },
								h("button", {
									type: "button",
									className: "dsh-npmr-row",
									disabled: busy,
									title: pkg.dir + " — " + script.command,
									onClick: () => start(pkg, script.name),
								},
									h("span", { className: "dsh-npmr-name" }, script.name),
									h("span", { className: "dsh-npmr-cmd" }, script.command),
								),
							));
						}
					}
					body.push(h("li", { key: "pkg-" + pkg.dir, className: "dsh-npmr-group" },
						h("button", {
							type: "button",
							className: "dsh-npmr-pkg",
							"aria-expanded": !isCollapsed,
							title: pkg.dir,
							onClick: () => togglePackage(pkg.dir),
						},
							h(ChevronIcon, { open: !isCollapsed }),
							h("span", { className: "dsh-npmr-pkgName" }, label.name),
							label.meta === undefined ? null : h("span", { className: "dsh-npmr-pkgMeta" }, label.meta),
							h("span", { className: "dsh-npmr-pkgCount" }, String(pkg.scripts.length)),
						),
						isCollapsed ? null : h("ul", { className: "dsh-npmr-scripts" }, rows),
					));
				}
			} else if (snapshot !== undefined) {
				body.push(h("li", { key: "empty", className: "dsh-npmr-empty" }, tr("empty")));
			}

			/**
			 * One run row plus its output pane. A plain render helper, not a
			 * component, so it stays inside this render and owns no hooks.
			 * @param job - the run record.
			 */
			const runRow = (job) => {
				const live = job.status === "running" || job.status === "stopping";
				const elapsed = (live ? now : (job.finishedAt ?? job.startedAt)) - job.startedAt;
				return h("li", { key: "run-" + job.id },
					h("div", { className: "dsh-npmr-run" },
						h("span", { className: "dsh-npmr-dot", "data-state": job.status }),
						h("button", {
							type: "button",
							className: "dsh-npmr-runLabel",
							"aria-expanded": expanded === job.id,
							title: job.label,
							onClick: () => setExpanded(expanded === job.id ? undefined : job.id),
						}, job.script ?? job.label),
						h("span", { className: "dsh-npmr-meta" }, statusLabel(job.status, tr)),
						h("span", { className: "dsh-npmr-meta" }, formatDuration(elapsed)),
						live
							? h("button", { type: "button", className: "dsh-npmr-ghost", onClick: () => stop(job.id) }, tr("stop"))
							: null,
					),
					expanded === job.id
						? h("pre", {
							ref: outputRef,
							className: "dsh-npmr-output",
							onScroll: (event) => {
								const node = event.currentTarget;
								followRef.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 24;
							},
						}, output === undefined || output === "" ? tr("noOutput") : output)
						: null,
				);
			};

			if (workspaceRuns.length > 0) {
				body.push(h("li", { key: "sep-runs", className: "dsh-npmr-sep" }));
				// The clear action belongs to the run list it acts on, so it rides
				// this section's own row rather than the popover header.
				body.push(h("li", { key: "runs-head", className: "dsh-npmr-section" },
					h("span", { className: "dsh-npmr-sectionLabel" }, tr("runs")),
					settledCount > 0
						? h("button", {
							type: "button",
							className: "dsh-npmr-ghost",
							title: tr("clearFinished"),
							onClick: clearFinished,
						}, tr("clearFinished"))
						: null,
				));
				for (const job of workspaceRuns.slice(0, 8)) body.push(runRow(job));
			}

			const menu = open && anchor !== undefined
				? ReactDOM.createPortal(
					h("ul", {
						ref: menuRef,
						className: "dsh-npmr-menu",
						"aria-label": tr("menu.aria"),
						style: { right: anchor.right + "px", top: anchor.top === undefined ? undefined : anchor.top + "px", bottom: anchor.bottom === undefined ? undefined : anchor.bottom + "px" },
					},
						h("li", { className: "dsh-npmr-head" },
							h("span", { className: "dsh-npmr-headTitle", title: cwd }, cwd),
							packages.length > 1
								? h("button", {
									type: "button",
									className: "dsh-npmr-ghost",
									onClick: () => setAllCollapsed(!allCollapsed),
								}, allCollapsed ? tr("expandAll") : tr("collapseAll"))
								: null,
							h("button", {
								type: "button",
								className: "dsh-npmr-ghost",
								onClick: () => {
									scanGeneration.current += 1;
									scan(scanGeneration.current);
								},
							}, tr("refresh")),
						),
						body.length > 0 ? body : h("li", { className: "dsh-npmr-empty" }, tr("loading")),
					),
					document.body,
				)
				: null;

			const trigger = h("button", {
				ref: triggerRef,
				type: "button",
				className: "dsh-npmr-trigger",
				"aria-expanded": open,
				"aria-label": triggerLabel,
				title: triggerLabel,
				onClick: () => (open ? setOpen(false) : openMenu()),
			},
				h(RunIcon, null),
				liveWorkspaceRuns.length > 0
					? h("span", { className: "dsh-npmr-dot dsh-npmr-dotBadge", "data-state": "running", "aria-hidden": "true" })
					: null,
			);

			if (placement === "dock") {
				// The Hero's workspace/preset row is this row's previous sibling in
				// the composer stack, so the trigger is lifted onto that line rather
				// than claiming a line of its own.
				return h(
					React.Fragment,
					null,
					h("div", { className: "dsh-npmr-dockRow" }, h("div", { className: "dsh-npmr-dock" }, trigger)),
					menu,
				);
			}
			return h(React.Fragment, null, trigger, menu);
		}

		/** Bind one placement into a stable component identity. */
		function controlFor(placement) {
			return function NpmRunnerControlForPlacement(props) {
				return h(NpmRunnerControl, { ...props, placement });
			};
		}
		//#endregion

		//#region plugin
		/** Services the runtime must have published before the control mounts. */
		const inject = ["sessions", "slots", "locale"];

		/**
		 * Client plugin body: register the dictionaries and both placements.
		 * @param ctx - the client root context.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-npm-runner: dictionaries");

			// Blank Session: the dock is the row directly above the composer card.
			// The header does not render its children while a Session is blank, and
			// the dock does render in an established conversation, so each half
			// self-hides outside its own state.
			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
				name: "conversation.input.dock",
				id: "npm-runner:dock",
				order: 40,
				locale: NS,
				registrant: "dsh-npm-runner",
			}, controlFor("dock")));

			// Established conversation: the header's action row, which lives inside
			// the title cluster and holds DSH's own compact session controls. The
			// neighbours there fix the order: `agent-preset` ("创造模式") is -10,
			// `schedule-catalog` is 10 and the built-in `job-list` is 20. Sitting at
			// 15 therefore lands just after the mode control and immediately before
			// the background-job list — beside the control it has most in common
			// with, instead of splitting the mode control away from it.
			ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
				name: "conversation.session.header.actions",
				id: "npm-runner:header",
				order: 15,
				locale: NS,
				registrant: "dsh-npm-runner",
			}, controlFor("header")));
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		// Beyond the shell's `apply`/`inject` contract: the pure decision logic is
		// published so the package's own tests can drive it directly. The module
		// loader ignores extra exports.
		exports.helpers = {
			format,
			isBlankSession,
			formatDuration,
			statusLabel,
			packageLabel,
			baseName,
			runsForWorkspace,
			readCollapsed,
			writeCollapsed,
			dictionaries: { zh, en },
			css: CSS,
			route: ROUTE,
		};
		return module.exports;
	}
});
