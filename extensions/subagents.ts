import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, SessionManager } from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";

const MAX_CAPTURE_CHARS = 50_000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const EXTENSION_ID = "linked-subagents";

type SpawnParams = {
	prompt: string;
	name?: string;
	waitForCompletion?: boolean;
	timeoutMs?: number;
	model?: string;
	thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
};

type SpawnResult = {
	sessionPath: string;
	parentSessionPath: string;
	name: string;
	prompt: string;
	pid?: number;
	status: "running" | "completed" | "failed" | "timed_out";
	exitCode?: number | null;
	signal?: NodeJS.Signals | null;
	stdout?: string;
	stderr?: string;
};

type RunningSubagent = {
	process: ChildProcessWithoutNullStreams;
	startedAt: number;
	prompt: string;
	name: string;
};

type SessionLike = {
	path: string;
	id?: string;
	cwd?: string;
	name?: string;
	parentSessionPath?: string;
	created?: Date;
	modified?: Date;
	messageCount?: number;
	firstMessage?: string;
};

type NavItem = {
	role: "main" | "subagent";
	session: SessionLike;
	isCurrent: boolean;
};

function capText(text: string): string {
	if (text.length <= MAX_CAPTURE_CHARS) return text;
	return `${text.slice(0, MAX_CAPTURE_CHARS)}\n\n[truncated after ${MAX_CAPTURE_CHARS} chars]`;
}

function clampTimeout(timeoutMs: number | undefined): number {
	return Math.min(Math.max(timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000), MAX_TIMEOUT_MS);
}

function summarizePrompt(prompt: string): string {
	return prompt.replace(/\s+/g, " ").trim().slice(0, 80) || "subagent";
}

function defaultName(prompt: string): string {
	return `subagent: ${summarizePrompt(prompt)}`;
}

function normalizeSessionPath(sessionPath: string | undefined): string | undefined {
	if (!sessionPath) return undefined;
	return path.resolve(sessionPath);
}

function sameSessionPath(a: string | undefined, b: string | undefined): boolean {
	const na = normalizeSessionPath(a);
	const nb = normalizeSessionPath(b);
	return Boolean(na && nb && na === nb);
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}

function runPiSession(
	sessionPath: string,
	prompt: string,
	options: { cwd: string; model?: string; thinking?: string; timeoutMs: number; signal?: AbortSignal },
): { child: ChildProcessWithoutNullStreams; done: Promise<SpawnResult> } {
	const args = ["--session", sessionPath, "-p"];
	if (options.model) args.push("--model", options.model);
	if (options.thinking) args.push("--thinking", options.thinking);

	const invocation = getPiInvocation(args);
	const child = spawn(invocation.command, invocation.args, {
		cwd: options.cwd,
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, PI_SUBAGENT: "1" },
	});

	let stdout = "";
	let stderr = "";
	let timedOut = false;
	let settled = false;

	const kill = () => {
		if (!child.killed) child.kill("SIGTERM");
		setTimeout(() => {
			if (!child.killed) child.kill("SIGKILL");
		}, 2_000).unref();
	};

	const done = new Promise<SpawnResult>((resolve, reject) => {
		const timer = setTimeout(() => {
			timedOut = true;
			kill();
		}, options.timeoutMs);
		timer.unref();

		const abortHandler = options.signal
			? () => {
					kill();
				}
			: undefined;
		if (abortHandler) options.signal?.addEventListener("abort", abortHandler, { once: true });

		const cleanup = () => {
			clearTimeout(timer);
			if (abortHandler) options.signal?.removeEventListener("abort", abortHandler);
		};

		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		});

		child.stdout.on("data", (chunk) => {
			stdout = capText(stdout + chunk.toString());
		});
		child.stderr.on("data", (chunk) => {
			stderr = capText(stderr + chunk.toString());
		});

		child.on("close", (code, childSignal) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve({
				sessionPath,
				parentSessionPath: "",
				name: "",
				prompt,
				pid: child.pid,
				status: timedOut ? "timed_out" : code === 0 ? "completed" : "failed",
				exitCode: code,
				signal: childSignal,
				stdout: stdout.trim(),
				stderr: stderr.trim(),
			});
		});
	});

	child.stdin.end(prompt);
	return { child, done };
}

function buildResultText(result: SpawnResult): string {
	const lines = [
		`Subagent ${result.status}.`,
		`session: ${result.sessionPath}`,
		`parent: ${result.parentSessionPath}`,
		`name: ${result.name}`,
	];
	if (result.pid) lines.push(`pid: ${result.pid}`);
	if (result.exitCode !== undefined) lines.push(`exit: ${result.exitCode}${result.signal ? ` signal=${result.signal}` : ""}`);
	if (result.stdout?.trim()) lines.push("", "STDOUT:", result.stdout.trim());
	if (result.stderr?.trim()) lines.push("", "STDERR:", result.stderr.trim());
	return lines.join("\n");
}

function forcePersistSessionSkeleton(manager: SessionManager): void {
	const sessionPath = manager.getSessionFile();
	const header = manager.getHeader();
	if (!sessionPath || !header) throw new Error("Cannot persist subagent session skeleton without a session file/header.");
	if (fs.existsSync(sessionPath)) return;
	fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
	const lines = [header, ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n");
	fs.writeFileSync(sessionPath, `${lines}\n`, { flag: "wx" });
}

function openSessionInfo(sessionPath: string): SessionLike | undefined {
	try {
		const manager = SessionManager.open(sessionPath);
		const header = manager.getHeader();
		const entries = manager.getEntries();
		const messages = entries.filter((entry) => entry.type === "message");
		const firstMessageEntry = messages[0];
		let firstMessage = "";
		if (firstMessageEntry?.type === "message") {
			const content = firstMessageEntry.message.content;
			if (typeof content === "string") firstMessage = content;
			else if (Array.isArray(content)) {
				firstMessage = content
					.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
					.map((part) => part.text)
					.join("\n");
			}
		}
		return {
			path: sessionPath,
			id: header?.id,
			cwd: header?.cwd,
			name: manager.getSessionName(),
			parentSessionPath: header?.parentSession,
			created: header?.timestamp ? new Date(header.timestamp) : undefined,
			modified: entries.length > 0 ? new Date(entries[entries.length - 1]!.timestamp) : undefined,
			messageCount: messages.length,
			firstMessage,
		};
	} catch {
		return undefined;
	}
}

function formatSessionDate(date: Date | undefined): string {
	if (!date) return "?";
	const diffMs = Date.now() - date.getTime();
	const diffMins = Math.floor(diffMs / 60_000);
	const diffHours = Math.floor(diffMs / 3_600_000);
	const diffDays = Math.floor(diffMs / 86_400_000);
	if (diffMins < 1) return "now";
	if (diffMins < 60) return `${diffMins}m`;
	if (diffHours < 24) return `${diffHours}h`;
	if (diffDays < 7) return `${diffDays}d`;
	if (diffDays < 30) return `${Math.floor(diffDays / 7)}w`;
	if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo`;
	return `${Math.floor(diffDays / 365)}y`;
}

function promptForSession(session: SessionLike): string {
	let title = session.firstMessage?.replace(/\s+/g, " ").trim() || session.name?.trim() || path.basename(session.path);
	if (title.startsWith("Task: ")) title = title.slice(6).trim();
	return title;
}

function labelForSession(session: SessionLike): string {
	const count = session.messageCount ?? 0;
	return `${promptForSession(session)} — ${count} msg — ${formatSessionDate(session.modified)}`;
}

function sessionInfoFromCurrent(ctx: ExtensionCommandContext): SessionLike | undefined {
	const sessionPath = ctx.sessionManager.getSessionFile();
	if (!sessionPath) return undefined;
	const header = ctx.sessionManager.getHeader();
	const entries = ctx.sessionManager.getEntries();
	const messages = entries.filter((entry) => entry.type === "message");
	return {
		path: sessionPath,
		id: header?.id,
		cwd: header?.cwd,
		name: ctx.sessionManager.getSessionName(),
		parentSessionPath: header?.parentSession,
		created: header?.timestamp ? new Date(header.timestamp) : undefined,
		modified: entries.length > 0 ? new Date(entries[entries.length - 1]!.timestamp) : header?.timestamp ? new Date(header.timestamp) : undefined,
		messageCount: messages.length,
		firstMessage: openSessionInfo(sessionPath)?.firstMessage,
	};
}

function extractLinkedSubagentRecord(entry: unknown): Partial<SpawnResult> | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	const e = entry as any;
	const candidates: unknown[] = [];
	if (e.type === "custom" && e.customType === EXTENSION_ID) candidates.push(e.data);
	if (e.type === "custom_message" && e.customType === EXTENSION_ID) candidates.push(e.details);
	if (e.type === "message") {
		const message = e.message;
		if (message?.role === "toolResult" && message.toolName === "spawn_subagent") candidates.push(message.details);
		if (message?.role === "custom" && message.customType === EXTENSION_ID) candidates.push(message.details);
	}

	for (const candidate of candidates) {
		if (!candidate || typeof candidate !== "object") continue;
		const record = candidate as Partial<SpawnResult>;
		if (typeof record.sessionPath === "string" && typeof record.parentSessionPath === "string") return record;
	}
	return undefined;
}

function sessionLikeFromRecord(record: Partial<SpawnResult>): SessionLike | undefined {
	if (!record.sessionPath) return undefined;
	const opened = openSessionInfo(record.sessionPath);
	return {
		path: record.sessionPath,
		...opened,
		name: opened?.name || record.name,
		parentSessionPath: opened?.parentSessionPath || record.parentSessionPath,
		firstMessage: opened?.firstMessage || record.prompt,
	};
}

export default function linkedSubagents(pi: ExtensionAPI) {
	const running = new Map<string, RunningSubagent>();

	async function spawnSubagent(
		params: SpawnParams,
		ctx: ExtensionContext,
		signal?: AbortSignal,
		onUpdate?: (partial: { content: Array<{ type: "text"; text: string }>; details?: unknown }) => void,
	): Promise<SpawnResult> {
		const prompt = params.prompt.trim();
		if (!prompt) throw new Error("Subagent prompt cannot be empty");

		const parentSessionPath = ctx.sessionManager.getSessionFile();
		if (!parentSessionPath) throw new Error("Current session is not persisted; cannot link a subagent parent session.");

		const name = (params.name?.trim() || defaultName(prompt)).slice(0, 160);
		const childManager = SessionManager.create(ctx.cwd, ctx.sessionManager.getSessionDir(), {
			parentSession: parentSessionPath,
		});
		childManager.appendSessionInfo(name);
		forcePersistSessionSkeleton(childManager);
		const childSessionPath = childManager.getSessionFile();
		if (!childSessionPath) throw new Error("Failed to create subagent session file.");

		const timeoutMs = clampTimeout(params.timeoutMs);
		const model = params.model || (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
		const thinking = params.thinking ?? pi.getThinkingLevel();
		const waitForCompletion = params.waitForCompletion ?? false;

		onUpdate?.({
			content: [{ type: "text", text: `Created subagent session ${childSessionPath}\nStarting pi...` }],
			details: { sessionPath: childSessionPath, parentSessionPath, name, status: "starting" },
		});

		const { child, done } = runPiSession(childSessionPath, prompt, { cwd: ctx.cwd, model, thinking, timeoutMs, signal });
		running.set(normalizeSessionPath(childSessionPath)!, { process: child, startedAt: Date.now(), prompt, name });

		const finalize = async (): Promise<SpawnResult> => {
			try {
				const result = await done;
				return { ...result, parentSessionPath, name };
			} finally {
				running.delete(normalizeSessionPath(childSessionPath)!);
			}
		};

		if (!waitForCompletion) {
			void finalize()
				.then((result) => {
					try {
						pi.appendEntry(EXTENSION_ID, { type: "subagent-complete", ...result, completedAt: Date.now() });
					} catch {
						// Session may have been replaced or shut down.
					}
				})
				.catch(() => {
					// Process error is only surfaced to waiters. The session file remains navigable.
				});

			return {
				sessionPath: childSessionPath,
				parentSessionPath,
				name,
				prompt,
				pid: child.pid,
				status: "running",
			};
		}

		const result = await finalize();
		onUpdate?.({ content: [{ type: "text", text: buildResultText(result) }], details: result });
		return result;
	}

	async function collectSubagentNavItems(ctx: ExtensionCommandContext): Promise<NavItem[]> {
		const currentPath = ctx.sessionManager.getSessionFile();
		if (!currentPath) return [];

		const currentHeader = ctx.sessionManager.getHeader();
		const mainPath = currentHeader?.parentSession ?? currentPath;
		const allSessions = await SessionManager.listAll();
		const items: NavItem[] = [];

		const currentInfo = sessionInfoFromCurrent(ctx);
		const mainInfo = sameSessionPath(currentPath, mainPath)
			? currentInfo
			: allSessions.find((session) => sameSessionPath(session.path, mainPath)) ?? openSessionInfo(mainPath);

		items.push({
			role: "main",
			session: mainInfo ?? { path: mainPath, name: "Main session" },
			isCurrent: sameSessionPath(currentPath, mainPath),
		});

		const childByPath = new Map<string, SessionLike>();
		const children = allSessions
			.filter((session) => sameSessionPath(session.parentSessionPath, mainPath))
			.sort((a, b) => b.modified.getTime() - a.modified.getTime());
		for (const child of children) childByPath.set(normalizeSessionPath(child.path)!, child);

		// Fallback for sessions created by older versions of this extension before
		// we forced the child header to disk with parentSession present.
		const mainManager = sameSessionPath(currentPath, mainPath) ? ctx.sessionManager : (() => {
			try {
				return SessionManager.open(mainPath);
			} catch {
				return undefined;
			}
		})();
		for (const entry of mainManager?.getEntries() ?? []) {
			const record = extractLinkedSubagentRecord(entry);
			if (!record || !sameSessionPath(record.parentSessionPath, mainPath)) continue;
			const session = sessionLikeFromRecord(record);
			if (!session) continue;
			childByPath.set(normalizeSessionPath(session.path)!, session);
		}

		if (currentHeader?.parentSession && currentInfo) {
			childByPath.set(normalizeSessionPath(currentPath)!, currentInfo);
		}

		for (const child of Array.from(childByPath.values()).sort((a, b) => (b.modified?.getTime() ?? 0) - (a.modified?.getTime() ?? 0))) {
			items.push({ role: "subagent", session: child, isCurrent: sameSessionPath(currentPath, child.path) });
		}

		return items;
	}

	async function pickSubagentSession(items: NavItem[], ctx: ExtensionCommandContext): Promise<NavItem | undefined> {
		if (ctx.mode !== "tui") {
			for (const item of items) {
				const current = item.isCurrent ? " current" : "";
				console.log(`(${item.role})${current}: ${item.session.path} — ${labelForSession(item.session)}`);
			}
			return undefined;
		}

		return await ctx.ui.custom<NavItem | undefined>((tui, theme, _kb, done) => {
			let selected = Math.max(0, items.findIndex((item) => item.isCurrent));
			let scroll = 0;

			const move = (delta: number) => {
				selected = Math.max(0, Math.min(items.length - 1, selected + delta));
				tui.requestRender();
			};

			const page = (delta: number) => move(delta * 8);

			const treePrefix = (item: NavItem, index: number): string => {
				if (item.role === "main") return "";
				const childIndex = items.slice(0, index + 1).filter((candidate) => candidate.role === "subagent").length;
				const childCount = items.filter((candidate) => candidate.role === "subagent").length;
				return childIndex === childCount ? "└─ " : "├─ ";
			};

			const renderItem = (item: NavItem, index: number, width: number, isSelected: boolean): string => {
				const prefix = treePrefix(item, index);
				const runningMarker = running.has(normalizeSessionPath(item.session.path)!) ? "… " : "";
				const currentMarker = item.isCurrent ? "* " : "";
				const role = `(${item.role})`;
				const prompt = promptForSession(item.session);
				const right = `${item.session.messageCount ?? 0} msg  ${formatSessionDate(item.session.modified)}`;

				// Selected rows need one continuous background. Nested fg/bold ANSI resets can
				// terminate the background early, so render the selected row mostly plain and
				// apply selectedBg to the fully padded final line.
				if (isSelected) {
					const leftFixed = `› ${prefix}${currentMarker || runningMarker}${role} `;
					const availablePrompt = Math.max(10, width - visibleWidth(leftFixed) - visibleWidth(right) - 2);
					const promptText = truncateToWidth(prompt, availablePrompt, "…");
					const left = leftFixed + promptText;
					const spacing = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
					let line = truncateToWidth(left + " ".repeat(spacing) + right, width, "");
					line += " ".repeat(Math.max(0, width - visibleWidth(line)));
					return theme.bg("selectedBg", line);
				}

				const cursor = "  ";
				const prefixText = theme.fg("dim", prefix);
				const roleText = item.role === "main" ? theme.fg("accent", role) : theme.fg("warning", role);
				const markerText = currentMarker ? theme.fg("success", currentMarker) : runningMarker ? theme.fg("warning", runningMarker) : "";
				const leftFixed = cursor + prefixText + markerText + roleText + " ";
				const rightText = theme.fg("dim", right);
				const availablePrompt = Math.max(10, width - visibleWidth(leftFixed) - visibleWidth(rightText) - 2);
				let promptText = truncateToWidth(prompt, availablePrompt, "…");
				if (item.isCurrent) promptText = theme.fg("success", promptText);
				const left = leftFixed + promptText;
				const spacing = Math.max(1, width - visibleWidth(left) - visibleWidth(rightText));
				return truncateToWidth(left + " ".repeat(spacing) + rightText, width, "");
			};

			return {
				render: (width: number) => {
					const maxItems = Math.min(Math.max(5, Math.floor((tui.terminal?.rows ?? 24) / 2)), items.length);
					if (selected < scroll) scroll = selected;
					if (selected >= scroll + maxItems) scroll = selected - maxItems + 1;

					const lines: string[] = [];
					lines.push("");
					lines.push(...new DynamicBorder((s: string) => theme.fg("border", s)).render(width));
					lines.push(theme.bold("  Subagent Sessions"));
					lines.push(theme.fg("dim", truncateToWidth("  j/k or ↑/↓ move · Ctrl+u/d page · g/G top/bottom · q/Esc close", width, "…")));
					lines.push(...new DynamicBorder((s: string) => theme.fg("border", s)).render(width));
					lines.push("");

					for (let i = scroll; i < Math.min(items.length, scroll + maxItems); i++) {
						lines.push(renderItem(items[i]!, i, width, i === selected));
					}

					if (items.length > maxItems) {
						lines.push(theme.fg("dim", `  (${selected + 1}/${items.length})`));
					}
					lines.push("");
					lines.push(...new DynamicBorder((s: string) => theme.fg("border", s)).render(width));
					return lines;
				},
				invalidate: () => {},
				handleInput: (data: string) => {
					if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") done(undefined);
					else if (matchesKey(data, "up") || data === "k") move(-1);
					else if (matchesKey(data, "down") || data === "j") move(1);
					else if (matchesKey(data, "ctrl+u")) page(-1);
					else if (matchesKey(data, "ctrl+d")) page(1);
					else if (data === "g") {
						selected = 0;
						tui.requestRender();
					} else if (data === "G") {
						selected = items.length - 1;
						tui.requestRender();
					} else if (matchesKey(data, "return") || matchesKey(data, "enter")) {
						done(items[selected]);
					}
				},
			};
		});
	}

	pi.registerTool({
		name: "spawn_subagent",
		label: "Spawn Subagent",
		description: "Create a regular persisted pi session linked to the current session as its parent, run a prompt in it, and return the child session path/output.",
		promptSnippet: "Create linked child pi sessions for delegated subagent work",
		promptGuidelines: [
			"Use spawn_subagent when independent work should happen in a regular child pi session that the user can later open with /sbs.",
			"spawn_subagent creates a persisted session linked to the current session as parent; include a clear, self-contained prompt.",
			"spawn_subagent runs in the background by default; set waitForCompletion=true only when you need the child result before continuing.",
		],
		parameters: Type.Object({
			prompt: Type.String({ description: "Prompt/task to run in the linked child pi session." }),
			name: Type.Optional(Type.String({ description: "Optional session display name. Defaults to a summary of the prompt." })),
			waitForCompletion: Type.Optional(Type.Boolean({ description: "Wait for the child pi run to finish and return output. Default false." })),
			timeoutMs: Type.Optional(Type.Number({ description: "Timeout in milliseconds when waiting/running. Default 600000; max 3600000." })),
			model: Type.Optional(Type.String({ description: "Optional model selector. Defaults to the current model." })),
			thinking: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh")], { description: "Optional thinking level. Defaults to current thinking level." })),
		}),
		async execute(_toolCallId, params: SpawnParams, signal, onUpdate, ctx) {
			const result = await spawnSubagent(params, ctx, signal, onUpdate);
			return {
				content: [{ type: "text", text: buildResultText(result) }],
				details: result,
			};
		},
		renderCall(args, theme) {
			const prompt = typeof args.prompt === "string" ? summarizePrompt(args.prompt) : "...";
			return new Text(`${theme.fg("toolTitle", theme.bold("spawn_subagent"))} ${theme.fg("dim", prompt)}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as SpawnResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "spawn_subagent completed", 0, 0);
			}
			const statusColor = details.status === "completed" ? "success" : details.status === "running" ? "warning" : "error";
			const lines = [
				`${theme.fg(statusColor, details.status === "completed" ? "✓" : details.status === "running" ? "…" : "✗")} ${theme.fg("toolTitle", theme.bold(details.name))}`,
				`${theme.fg("muted", "session:")} ${theme.fg("accent", details.sessionPath)}`,
			];
			if (details.stdout?.trim()) lines.push("", theme.fg("toolOutput", details.stdout.trim()));
			if (details.stderr?.trim()) lines.push("", theme.fg("error", details.stderr.trim()));
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	const subagentCommandHandler = async (args: string, ctx: ExtensionCommandContext) => {
		let raw = args.trim();
		let waitForCompletion = false;
		if (raw.startsWith("--wait ")) {
			waitForCompletion = true;
			raw = raw.replace(/^--wait\s+/, "");
		}
		if (!raw && ctx.hasUI) raw = (await ctx.ui.input("/sb", "Prompt:"))?.trim() ?? "";
		if (!raw) {
			ctx.ui.notify("Usage: /sb [--wait] <prompt>", "warning");
			return;
		}

		ctx.ui.notify(waitForCompletion ? "Starting linked subagent and waiting..." : "Starting linked background subagent...", "info");
		const result = await spawnSubagent({ prompt: raw, waitForCompletion }, ctx, ctx.signal);
		const text = buildResultText(result);
		pi.sendMessage({ customType: EXTENSION_ID, content: text, display: true, details: result });
	};

	const subagentsCommandHandler = async (_args: string, ctx: ExtensionCommandContext) => {
		const items = await collectSubagentNavItems(ctx);
		if (items.length === 0) {
			ctx.ui.notify("No parent or child subagent sessions for this session", "info");
			return;
		}

		const selected = await pickSubagentSession(items, ctx);
		if (!selected) return;
		const currentPath = ctx.sessionManager.getSessionFile();
		if (sameSessionPath(currentPath, selected.session.path)) return;
		const result = await ctx.switchSession(selected.session.path);
		if (result.cancelled) ctx.ui.notify("Session switch cancelled", "warning");
	};

	pi.registerCommand("sb", {
		description: "Spawn a linked child pi session from a prompt",
		handler: subagentCommandHandler,
	});

	pi.registerCommand("sbs", {
		description: "List linked subagent sessions and parent session",
		handler: subagentsCommandHandler,
	});

	pi.registerMessageRenderer(EXTENSION_ID, (message, _options, theme) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("borderMuted", s)));
		container.addChild(new Text(theme.fg("customMessageLabel", theme.bold("subagent")), 1, 0));
		const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
		container.addChild(new Text(content, 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("borderMuted", s)));
		return container;
	});
}
