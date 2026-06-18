import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import path from "node:path";

const MAX_OUTPUT_CHARS = 200_000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;

type RunMode = "read_only" | "coding" | "no_tools";

type SpawnSubagentParams = {
	prompt: string;
	cwd?: string;
	mode?: RunMode;
	model?: string;
	thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	timeoutMs?: number;
	loadExtensions?: boolean;
	inheritModel?: boolean;
};

function capText(text: string): string {
	if (text.length <= MAX_OUTPUT_CHARS) return text;
	return `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n[truncated after ${MAX_OUTPUT_CHARS} chars]`;
}

function toolsForMode(mode: RunMode): string[] | undefined {
	if (mode === "no_tools") return [];
	if (mode === "read_only") return ["read", "grep", "find", "ls"];
	return ["read", "bash", "edit", "write", "grep", "find", "ls"];
}

function resolveCwd(base: string, requested?: string): string {
	if (!requested?.trim()) return base;
	return path.resolve(base, requested);
}

async function runPi(args: string[], cwd: string, input: string, timeoutMs: number, signal?: AbortSignal) {
	return await new Promise<{ stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }>((resolve, reject) => {
		const child = spawn("pi", args, {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, PI_SUBAGENT: "1" },
		});

		let stdout = "";
		let stderr = "";
		let settled = false;
		let timedOut = false;

		const finish = (result: { code: number | null; signal: NodeJS.Signals | null }) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (abortHandler) signal?.removeEventListener("abort", abortHandler);
			resolve({ stdout: capText(stdout), stderr: capText(stderr), code: result.code, signal: result.signal, timedOut });
		};

		const kill = () => {
			if (!child.killed) child.kill("SIGTERM");
			setTimeout(() => {
				if (!child.killed) child.kill("SIGKILL");
			}, 2_000).unref();
		};

		const timer = setTimeout(() => {
			timedOut = true;
			kill();
		}, timeoutMs);
		timer.unref();

		const abortHandler = signal
			? () => {
					kill();
				}
			: undefined;
		if (abortHandler) signal?.addEventListener("abort", abortHandler, { once: true });

		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (abortHandler) signal?.removeEventListener("abort", abortHandler);
			reject(error);
		});

		child.stdout.on("data", (chunk) => {
			stdout = capText(stdout + chunk.toString());
		});
		child.stderr.on("data", (chunk) => {
			stderr = capText(stderr + chunk.toString());
		});

		child.on("close", (code, childSignal) => finish({ code, signal: childSignal }));
		child.stdin.end(input);
	});
}

export default function subagentRunner(pi: ExtensionAPI) {
	pi.registerTool({
		name: "spawn_subagent",
		label: "Spawn Subagent",
		description: "Run an isolated pi subprocess on a delegated task and return its final output.",
		promptSnippet: "Delegate independent investigation or implementation work to an isolated pi subprocess",
		promptGuidelines: [
			"Use spawn_subagent for independent, parallelizable investigation tasks where a separate pi process can inspect the repo and report back.",
			"Prefer spawn_subagent mode=read_only for research; use mode=coding only when the delegated task should be allowed to edit files.",
			"Keep spawn_subagent prompts specific and ask for concise findings, changed files, and any commands run.",
		],
		parameters: Type.Object({
			prompt: Type.String({ description: "Task for the subagent. Include clear goals and desired output format." }),
			cwd: Type.Optional(Type.String({ description: "Working directory for the subagent, relative to current cwd unless absolute." })),
			mode: Type.Optional(Type.Union([Type.Literal("read_only"), Type.Literal("coding"), Type.Literal("no_tools")], { description: "Tool access for the subagent. Default: read_only." })),
			model: Type.Optional(Type.String({ description: "Optional model selector, e.g. anthropic/claude-sonnet-4-5." })),
			thinking: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh")], { description: "Optional thinking level." })),
			timeoutMs: Type.Optional(Type.Number({ description: "Timeout in milliseconds. Default 600000; max 3600000." })),
			loadExtensions: Type.Optional(Type.Boolean({ description: "Load normal pi extensions in the subagent. Default false to prevent recursion." })),
			inheritModel: Type.Optional(Type.Boolean({ description: "Use the current session model when no model is provided. Default true." })),
		}),
		async execute(_toolCallId, params: SpawnSubagentParams, signal, onUpdate, ctx) {
			const mode = params.mode ?? "read_only";
			const timeoutMs = Math.min(Math.max(params.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000), MAX_TIMEOUT_MS);
			const cwd = resolveCwd(ctx.cwd, params.cwd);
			const args = ["-p", "--no-session"];

			if (!params.loadExtensions) args.push("--no-extensions");

			const model = params.model || (params.inheritModel !== false && ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
			if (model) args.push("--model", model);
			if (params.thinking) args.push("--thinking", params.thinking);

			const tools = toolsForMode(mode);
			if (tools && tools.length > 0) args.push("--tools", tools.join(","));
			if (tools && tools.length === 0) args.push("--no-tools");

			onUpdate?.({ content: [{ type: "text", text: `Spawning subagent in ${cwd} (${mode}, timeout ${timeoutMs}ms)...` }] });

			const result = await runPi(args, cwd, params.prompt, timeoutMs, signal);
			const ok = result.code === 0 && !result.timedOut;
			const summary = [
				`Subagent ${ok ? "completed" : "failed"}${result.timedOut ? " (timed out)" : ""}.`,
				`cwd: ${cwd}`,
				`exit: ${result.code ?? "null"}${result.signal ? ` signal=${result.signal}` : ""}`,
				"",
				"STDOUT:",
				result.stdout.trim() || "(empty)",
				result.stderr.trim() ? `\nSTDERR:\n${result.stderr.trim()}` : "",
			].join("\n");

			return {
				content: [{ type: "text", text: summary }],
				details: { cwd, mode, args, exitCode: result.code, signal: result.signal, timedOut: result.timedOut, stdout: result.stdout, stderr: result.stderr },
				isError: !ok,
			};
		},
	});

	pi.registerCommand("spawn-subagent", {
		description: "Run a read-only pi subagent from a slash command",
		handler: async (args, ctx) => {
			const prompt = args.trim();
			if (!prompt) {
				ctx.ui.notify("Usage: /spawn-subagent <task>", "warning");
				return;
			}

			ctx.ui.notify("Starting read-only subagent...", "info");
			const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const cliArgs = ["-p", "--no-session", "--no-extensions", "--tools", "read,grep,find,ls"];
			if (model) cliArgs.push("--model", model);
			const result = await runPi(cliArgs, ctx.cwd, prompt, DEFAULT_TIMEOUT_MS, ctx.signal);
			const text = (result.stdout.trim() || result.stderr.trim() || "(no output)").slice(0, MAX_OUTPUT_CHARS);
			pi.sendMessage({ customType: "subagent-result", content: text, display: true, details: result });
		},
	});
}
