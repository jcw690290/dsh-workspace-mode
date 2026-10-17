/**
 * dsh-workspace-mode — browser half: a Settings page that assigns a permission
 * preset to each workspace directory.
 *
 * Shipped pre-built (no bundler step): DSH loads it through `window.__ModuleLoader__`
 * with only platform modules available, so it uses `react.createElement` and inline
 * styles built from the `--dsw-alias-*` theme variables. Values are read from and
 * written to the host form of the profile entry `workspace-mode` via
 * `ctx.configForms`, which is the same live configuration the host plugin reads.
 */
window.__ModuleLoader__.load({
	id: "dsh-workspace-mode",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");

		const NS = "workspaceMode";
		const SETTINGS_NS = "workspace-mode";
		const BUILTIN_PRESETS = ["read-only", "workspace-write", "danger-full-access"];

		// ── locale ──────────────────────────────────────────────────────────
		const en = {
			nav: "Workspace modes",
			title: "Workspace modes",
			intro: "Give each workspace its own initial permission preset. New sessions opened in a listed directory start with the assigned preset; every other directory keeps the profile default. Changes apply immediately.",
			listTitle: "Assigned workspaces",
			empty: "No workspace has its own preset yet.",
			addTitle: "Add a workspace",
			pathLabel: "Workspace directory",
			pathPlaceholder: "Absolute path, e.g. D:\\work\\client",
			presetLabel: "Permission preset",
			add: "Add",
			remove: "Remove",
			includeSubagents: "Also apply to subagent sessions",
			includeSubagentsHint: "Subagents normally inherit the parent session's permission, so this is rarely needed.",
			pathHint: "Directories match by prefix: sessions below a listed directory inherit its preset, and the longest match wins.",
			ymlNote: "Rules written under rules in the profile's cordis.patch.yml keep working; an entry made here overrides a rule for the same directory.",
			loading: "Reading settings…",
			unavailable: "This profile exposes no editable form for dsh-workspace-mode. Update the plugin to 0.2.0 or newer (it needs @deepseek-ai/schemastery) and restart DSH.",
			readonly: "The current value comes from a higher-priority configuration layer, so it cannot be edited here.",
			busy: "Saving…",
			saveFailed: "Saving failed. Retry, or edit the profile's cordis.patch.yml directly.",
			errorEmpty: "Enter a workspace directory.",
			errorRelative: "Use an absolute path (drive letter or a leading slash).",
			errorDuplicate: "That directory already has a preset."
		};
		const zh = {
			nav: "工作区模式",
			title: "工作区模式",
			intro: "为每个工作区单独指定初始权限预设。在列出的目录里新建会话会用分配好的预设，其他目录继续沿用 profile 默认值。修改立即生效。",
			listTitle: "已分配的工作区",
			empty: "还没有为任何工作区分配预设。",
			addTitle: "添加工作区",
			pathLabel: "工作区目录",
			pathPlaceholder: "绝对路径，例如 D:\\work\\client",
			presetLabel: "权限预设",
			add: "添加",
			remove: "移除",
			includeSubagents: "同时作用于子代理会话",
			includeSubagentsHint: "子代理通常继承父会话的权限，一般不需要打开。",
			pathHint: "按目录前缀匹配：列出目录下的会话都继承该预设，前缀最长的规则优先。",
			ymlNote: "在 profile 的 cordis.patch.yml 里用 rules 写的规则仍然生效；同一目录以这里的设置为准。",
			loading: "正在读取设置…",
			unavailable: "当前 profile 没有提供 dsh-workspace-mode 的可编辑表单。请升级到 0.2.0 及以上（需要 @deepseek-ai/schemastery）并重启 DSH。",
			readonly: "当前值来自更高优先级的配置层，无法在这里修改。",
			busy: "正在保存…",
			saveFailed: "保存失败。可以重试，或直接修改 profile 的 cordis.patch.yml。",
			errorEmpty: "请输入工作区目录。",
			errorRelative: "请使用绝对路径（盘符或开头的斜杠）。",
			errorDuplicate: "该目录已经分配过预设。"
		};

		// ── styling (inline, self-contained) ───────────────────────────────
		const s = {
			section: { width: "100%", maxWidth: "760px", display: "flex", flexDirection: "column", gap: "16px", color: "var(--dsw-alias-label-primary)" },
			h2: { margin: 0, fontSize: "15px", fontWeight: 600, lineHeight: "22px" },
			h3: { margin: 0, fontSize: "13px", fontWeight: 600, lineHeight: "20px" },
			intro: { margin: 0, color: "var(--dsw-alias-label-tertiary)", fontSize: "13px", lineHeight: "20px" },
			card: { border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-3)", borderRadius: "10px", padding: "12px 14px", display: "flex", flexDirection: "column", gap: "10px" },
			rows: { display: "flex", flexDirection: "column", gap: "8px" },
			row: { display: "flex", alignItems: "center", gap: "10px" },
			path: { flex: 1, minWidth: 0, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: "12.5px", lineHeight: "18px", color: "var(--dsw-alias-label-primary)", wordBreak: "break-all" },
			addRow: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
			input: { flex: "1 1 260px", minWidth: 0, height: "32px", boxSizing: "border-box", border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-1)", color: "var(--dsw-alias-label-primary)", font: "inherit", borderRadius: "8px", outline: "none", padding: "0 10px", fontSize: "12.5px" },
			select: { flex: "0 0 auto", height: "32px", boxSizing: "border-box", border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-1)", color: "var(--dsw-alias-label-primary)", font: "inherit", borderRadius: "8px", padding: "0 8px", fontSize: "12.5px", maxWidth: "230px" },
			button: { flex: "0 0 auto", height: "32px", border: "1px solid var(--dsw-alias-border-l2)", color: "var(--dsw-alias-label-primary)", font: "inherit", cursor: "pointer", background: "var(--dsw-alias-bg-layer-1)", borderRadius: "8px", padding: "0 12px", fontSize: "12.5px" },
			removeBtn: { flex: "0 0 auto", border: "1px solid var(--dsw-alias-border-l2)", color: "var(--dsw-alias-label-secondary)", font: "inherit", cursor: "pointer", background: "transparent", borderRadius: "8px", padding: "4px 10px", fontSize: "12px" },
			status: { margin: 0, color: "var(--dsw-alias-label-tertiary)", fontSize: "12.5px", lineHeight: "18px" },
			hint: { margin: 0, color: "var(--dsw-alias-label-tertiary)", fontSize: "12px", lineHeight: "18px" },
			warn: { margin: 0, color: "var(--dsw-alias-state-warning-primary, #d97706)", fontSize: "12.5px", lineHeight: "18px" },
			error: { margin: 0, color: "var(--dsw-alias-state-error-primary)", fontSize: "12.5px", lineHeight: "18px" },
			checkRow: { display: "flex", alignItems: "center", gap: "8px", fontSize: "12.5px", cursor: "pointer" }
		};

		// ── helpers ─────────────────────────────────────────────────────────
		function optionNodes(options, selected) {
			const nodes = options.map((option) => react.createElement("option", { key: option.value, value: option.value }, option.label));
			if (typeof selected === "string" && selected !== "" && !options.some((option) => option.value === selected)) {
				nodes.push(react.createElement("option", { key: selected, value: selected }, selected));
			}
			return nodes;
		}

		function presetOptions(presets) {
			if (Array.isArray(presets) && presets.length > 0) {
				return presets.map((option) => {
					const value = String(option.value);
					const name = typeof option.name === "string" && option.name !== "" ? option.name : value;
					return { value: value, label: name === value ? value : name + " (" + value + ")" };
				});
			}
			return BUILTIN_PRESETS.map((value) => ({ value: value, label: value }));
		}

		/** Reject empty and relative directories before they reach the host. */
		function pathProblem(value) {
			const trimmed = typeof value === "string" ? value.trim() : "";
			if (trimmed === "") return "errorEmpty";
			if (!/^([A-Za-z]:[\\/]|[\\/])/.test(trimmed)) return "errorRelative";
			return null;
		}

		/** Store separators and trailing separators in one canonical form. */
		function canonicalKey(value) {
			let path = value.trim().replace(/\\/g, "/");
			while (path.length > 1 && path.endsWith("/") && !/^[A-Za-z]:\/$/.test(path)) {
				path = path.slice(0, -1);
			}
			return path;
		}

		// ── settings bridge ─────────────────────────────────────────────────
		function createBridge(ctx) {
			let form = null;
			try {
				form = ctx.configForms.get(SETTINGS_NS);
			} catch (error) {
				console.error("[dsh-workspace-mode] configForms.get failed:", error);
			}

			const listeners = new Set();
			let snapshot = form === null
				? { status: "unavailable", writable: false, value: undefined }
				: form.getSnapshot();
			let presets = null;
			let busy = false;
			let failure = null;
			let requestedCatalog = false;
			let disposed = false;

			const workspaces = () => {
				const value = snapshot && snapshot.value;
				if (value === null || typeof value !== "object") return {};
				const raw = value.workspaces;
				if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
				const out = {};
				for (const key of Object.keys(raw)) {
					const preset = raw[key];
					if (typeof preset === "string" && preset !== "") out[key] = preset;
				}
				return out;
			};

			const read = () => ({
				status: snapshot && typeof snapshot.status === "string" ? snapshot.status : "loading",
				writable: Boolean(snapshot && snapshot.writable === true),
				workspaces: workspaces(),
				includeSubagents: Boolean(snapshot && snapshot.value && snapshot.value.includeSubagents === true),
				presets: presets,
				busy: busy,
				failure: failure
			});

			let current = read();
			const emit = () => {
				current = read();
				for (const listener of listeners) {
					try {
						listener();
					} catch (error) {
						console.error("[dsh-workspace-mode] listener failed:", error);
					}
				}
			};

			const unsubscribeForm = form === null ? function () {} : form.subscribe(() => {
				if (disposed) return;
				snapshot = form.getSnapshot();
				emit();
			});

			const run = async (ops) => {
				if (form === null || disposed) return;
				busy = true;
				failure = null;
				emit();
				try {
					const ok = await form.mutate(ops);
					if (ok === false) failure = "saveFailed";
				} catch (error) {
					failure = "saveFailed";
					console.error("[dsh-workspace-mode] settings write failed:", error);
				} finally {
					busy = false;
					snapshot = form.getSnapshot();
					emit();
				}
			};

			const loadCatalog = () => {
				if (requestedCatalog) return;
				requestedCatalog = true;
				const readCatalog = (scope) => {
					let pending;
					try {
						pending = scope.remote.permissionPresets.catalog();
					} catch (error) {
						console.warn("[dsh-workspace-mode] permission preset catalog unavailable:", error);
						return;
					}
					Promise.resolve(pending).then((response) => {
						if (disposed) return;
						if (response && response.ok === true && response.value && Array.isArray(response.value.options)) {
							presets = response.value.options.filter((option) => option && typeof option.value === "string");
							emit();
						}
					}).catch((error) => {
						console.warn("[dsh-workspace-mode] permission preset catalog failed:", error);
					});
				};
				try {
					if (typeof ctx.inject === "function") ctx.inject(["remote.permissionPresets"], readCatalog);
					else readCatalog(ctx);
				} catch (error) {
					console.warn("[dsh-workspace-mode] cannot resolve the permission preset catalog:", error);
				}
			};

			return {
				getState() {
					return current;
				},
				subscribe(listener) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				loadCatalog: loadCatalog,
				add(path, preset) {
					return run([{ op: "set", path: ["workspaces", canonicalKey(path)], value: preset }]);
				},
				update(path, preset) {
					return run([{ op: "set", path: ["workspaces", path], value: preset }]);
				},
				remove(path) {
					return run([{ op: "unset", path: ["workspaces", path] }]);
				},
				setIncludeSubagents(value) {
					return run([{ op: "set", path: ["includeSubagents"], value: value === true }]);
				},
				dispose() {
					disposed = true;
					listeners.clear();
					unsubscribeForm();
				}
			};
		}

		// ── settings section ────────────────────────────────────────────────
		function WorkspaceModeSection(props) {
			const bridge = props.bridge;
			const t = props.t;
			const tx = (key) => {
				const value = typeof t === "function" ? t(key) : undefined;
				return typeof value === "string" && value !== "" ? value : key;
			};

			const [state, setState] = react.useState(() => (bridge ? bridge.getState() : null));
			const [draftPath, setDraftPath] = react.useState("");
			const [draftPreset, setDraftPreset] = react.useState("");
			const [problem, setProblem] = react.useState(null);

			react.useEffect(() => {
				if (!bridge) return undefined;
				setState(bridge.getState());
				bridge.loadCatalog();
				return bridge.subscribe(() => setState(bridge.getState()));
			}, [bridge]);

			if (!bridge || state === null) {
				return react.createElement("div", { style: s.section },
					react.createElement("p", { style: s.status }, tx("loading")));
			}

			const options = presetOptions(state.presets);
			const fallbackPreset = options.length > 0 ? options[0].value : "";
			const entries = Object.keys(state.workspaces).sort((left, right) => left.localeCompare(right));
			const disabled = !state.writable || state.busy;

			const onAdd = () => {
				const issue = pathProblem(draftPath);
				if (issue !== null) {
					setProblem(issue);
					return;
				}
				const key = canonicalKey(draftPath);
				if (Object.prototype.hasOwnProperty.call(state.workspaces, key)) {
					setProblem("errorDuplicate");
					return;
				}
				setProblem(null);
				bridge.add(draftPath, draftPreset || fallbackPreset);
				setDraftPath("");
			};

			const rows = entries.map((key) => react.createElement("div", { key: key, style: s.row },
				react.createElement("span", { style: s.path, title: key }, key),
				react.createElement("select", {
					style: s.select,
					value: state.workspaces[key],
					disabled: disabled,
					"aria-label": tx("presetLabel"),
					onChange: (event) => bridge.update(key, event.target.value)
				}, optionNodes(options, state.workspaces[key])),
				react.createElement("button", {
					type: "button",
					style: s.removeBtn,
					disabled: disabled,
					onClick: () => bridge.remove(key)
				}, tx("remove"))));

			const failure = state.failure === null || state.failure === undefined
				? null
				: react.createElement("p", { style: s.error }, tx(state.failure));

			return react.createElement("div", { style: s.section },
				react.createElement("h2", { style: s.h2 }, tx("title")),
				react.createElement("p", { style: s.intro }, tx("intro")),
				state.status === "loading" ? react.createElement("p", { style: s.status }, tx("loading")) : null,
				state.status === "unavailable" ? react.createElement("p", { style: s.warn }, tx("unavailable")) : null,
				state.status !== "unavailable" && !state.writable ? react.createElement("p", { style: s.warn }, tx("readonly")) : null,
				react.createElement("section", { style: s.card },
					react.createElement("h3", { style: s.h3 }, tx("listTitle")),
					entries.length === 0
						? react.createElement("p", { style: s.status }, tx("empty"))
						: react.createElement("div", { style: s.rows }, ...rows)),
				react.createElement("section", { style: s.card },
					react.createElement("h3", { style: s.h3 }, tx("addTitle")),
					react.createElement("div", { style: s.addRow },
						react.createElement("input", {
							style: s.input,
							value: draftPath,
							placeholder: tx("pathPlaceholder"),
							spellCheck: false,
							disabled: disabled,
							"aria-label": tx("pathLabel"),
							onChange: (event) => {
								setDraftPath(event.target.value);
								setProblem(null);
							},
							onKeyDown: (event) => {
								if (event.key === "Enter") onAdd();
							}
						}),
						react.createElement("select", {
							style: s.select,
							value: draftPreset || fallbackPreset,
							disabled: disabled,
							"aria-label": tx("presetLabel"),
							onChange: (event) => setDraftPreset(event.target.value)
						}, optionNodes(options, draftPreset || fallbackPreset)),
						react.createElement("button", {
							type: "button",
							style: s.button,
							disabled: disabled,
							onClick: onAdd
						}, tx("add"))),
					problem === null ? null : react.createElement("p", { style: s.error }, tx(problem)),
					react.createElement("p", { style: s.hint }, tx("pathHint"))),
				react.createElement("section", { style: s.card },
					react.createElement("label", { style: s.checkRow },
						react.createElement("input", {
							type: "checkbox",
							checked: state.includeSubagents,
							disabled: disabled,
							onChange: (event) => bridge.setIncludeSubagents(event.target.checked)
						}),
						react.createElement("span", null, tx("includeSubagents"))),
					react.createElement("p", { style: s.hint }, tx("includeSubagentsHint"))),
				react.createElement("p", { style: s.hint }, tx("ymlNote")),
				state.busy ? react.createElement("p", { style: s.status }, tx("busy")) : null,
				failure);
		}

		// ── client entry ────────────────────────────────────────────────────
		const inject = ["slots", "locale", "configForms"];
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-workspace-mode: dictionaries");
			const t = ctx.locale.bind(NS);

			const bridge = createBridge(ctx);
			ctx.effect(() => () => bridge.dispose(), "dsh-workspace-mode: settings form");

			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "workspace-mode",
				order: 21,
				label: () => t("nav"),
				locale: NS,
				inject: () => ({})
			}, (props) => react.createElement(WorkspaceModeSection, {
				bridge: bridge,
				t: typeof props.t === "function" ? props.t : t
			})));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
