import { complete, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, matchesKey, Text } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";

const SYSTEM_PROMPT = `You answer quick side questions about the current coding-agent session.

Rules:
- Answer only from the provided conversation context and the user's side question.
- You have no tool access. Do not claim you inspected files or ran commands now.
- If the answer is not in the provided context, say so clearly.
- Be concise, but include enough detail to be useful.
- This is an ephemeral aside; do not try to steer the main task.`;

type ContentBlock = {
	type?: string;
	text?: string;
	name?: string;
	arguments?: unknown;
	content?: unknown;
};

type SessionEntry = {
	type: string;
	customType?: string;
	data?: unknown;
	message?: {
		role?: string;
		content?: unknown;
	};
};

type BtwExchange = {
	id: string;
	question: string;
	answer?: string;
	error?: string;
	timestamp: number;
	completedAt?: number;
	status: "running" | "done" | "error";
	model?: string;
};

const BTW_SUBAGENT_ENTRY = "btw-subagent";
const BTW_REPORT_ENTRY = "btw-report";

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	const lines: string[] = [];
	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		const block = item as ContentBlock;

		if (block.type === "text" && typeof block.text === "string") {
			lines.push(block.text);
		} else if (block.type === "toolCall" && typeof block.name === "string") {
			lines.push(`[tool call: ${block.name} ${JSON.stringify(block.arguments ?? {})}]`);
		} else if (block.type === "toolResult") {
			const resultText = textFromContent(block.content);
			if (resultText.trim()) lines.push(`[tool result]\n${resultText}`);
		}
	}
	return lines.join("\n");
}

function buildConversationText(entries: SessionEntry[]): string {
	const sections: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message?.role) continue;
		const role = entry.message.role;
		if (!["user", "assistant", "toolResult"].includes(role)) continue;

		const text = textFromContent(entry.message.content).trim();
		if (!text) continue;
		const label = role === "toolResult" ? "Tool result" : role === "user" ? "User" : "Assistant";
		sections.push(`${label}: ${text}`);
	}
	return sections.join("\n\n");
}

async function copyToClipboard(text: string): Promise<boolean> {
	const commands = process.platform === "darwin" ? [["pbcopy"]] : [["wl-copy"], ["xclip", "-selection", "clipboard"]];
	for (const command of commands) {
		const ok = await new Promise<boolean>((resolve) => {
			const child = spawn(command[0]!, command.slice(1), { stdio: ["pipe", "ignore", "ignore"] });
			child.on("error", () => resolve(false));
			child.on("close", (code) => resolve(code === 0));
			child.stdin.end(text);
		});
		if (ok) return true;
	}
	return false;
}

function clipText(text: string, width: number): string {
	if (width <= 0) return "";
	return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text;
}

async function showAnswer(answer: string, ctx: ExtensionCommandContext, title = "/btw side answer"): Promise<void> {
	if (ctx.mode !== "tui") {
		console.log(answer);
		return;
	}

	await ctx.ui.custom<void>(
		(_tui, theme, _kb, done) => {
			const container = new Container();
			const mdTheme = getMarkdownTheme();

			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
			container.addChild(new Markdown(answer.trim(), 1, 1, mdTheme));
			container.addChild(new Text(theme.fg("dim", "Enter/Esc: close   c: copy markdown"), 1, 0));
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			return {
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: async (data: string) => {
					if (matchesKey(data, "enter") || matchesKey(data, "escape")) {
						done(undefined);
					} else if (data === "c") {
						const ok = await copyToClipboard(answer);
						ctx.ui.notify(ok ? "Copied /btw answer" : "Could not copy to clipboard", ok ? "info" : "warning");
					}
				},
			};
		},
		{ overlay: true, overlayOptions: { anchor: "center", width: 90, maxHeight: 30 } },
	);
}

export default function btwExtension(pi: ExtensionAPI) {
	let subagents: BtwExchange[] = [];

	function reportToMainThread(exchange: BtwExchange) {
		const status = exchange.status === "done" ? "finished" : "failed";
		const body = exchange.status === "done" ? (exchange.answer ?? "No answer returned.") : `Error: ${exchange.error ?? "unknown error"}`;
		try {
			pi.sendMessage(
				{
					customType: BTW_REPORT_ENTRY,
					content: ["Main-thread report from a completed /btw side question. Orchestrate any user-facing response yourself.", "", `Status: ${status}`, `Question: ${exchange.question}`, "", body].join("\n"),
					display: false,
					details: { exchangeId: exchange.id, status: exchange.status },
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch {
			// The session may be shutting down; persistence already happened.
		}
	}

	function restoreSubagents(ctx: { sessionManager: { getBranch(): unknown[] } }) {
		const current = subagents;
		const restored: BtwExchange[] = [];
		for (const entry of ctx.sessionManager.getBranch() as SessionEntry[]) {
			if (entry.type !== "custom" || entry.customType !== BTW_SUBAGENT_ENTRY) continue;
			const data = entry.data as Partial<BtwExchange> | undefined;
			if (!data?.id || !data.question || typeof data.timestamp !== "number") continue;
			restored.push({
				id: data.id,
				question: data.question,
				answer: data.answer,
				error: data.error,
				timestamp: data.timestamp,
				completedAt: data.completedAt,
				status: data.status ?? (data.answer ? "done" : "error"),
				model: data.model,
			});
		}
		const restoredIds = new Set(restored.map((exchange) => exchange.id));
		subagents = [...restored, ...current.filter((exchange) => !restoredIds.has(exchange.id))];
	}

	function persistCompletedSubagent(exchange: BtwExchange) {
		pi.appendEntry<BtwExchange>(BTW_SUBAGENT_ENTRY, exchange);
	}

	async function pickSubagent(ordered: BtwExchange[], labels: string[], ctx: ExtensionCommandContext): Promise<BtwExchange | undefined> {
		if (ctx.mode !== "tui") {
			console.log(labels.join("\n"));
			return undefined;
		}

		const selectedIndex = await ctx.ui.custom<number | undefined>(
			(tui, theme, _kb, done) => {
				let selected = 0;
				let scroll = 0;

				const move = (delta: number) => {
					selected = Math.max(0, Math.min(ordered.length - 1, selected + delta));
					tui.requestRender();
				};

				return {
					render: (width: number) => {
						const innerWidth = Math.max(20, width - 4);
						const maxItems = Math.min(12, ordered.length);
						if (selected < scroll) scroll = selected;
						if (selected >= scroll + maxItems) scroll = selected - maxItems + 1;

						const lines: string[] = [];
						lines.push(theme.fg("accent", theme.bold("/btw subagents")));
						lines.push(theme.fg("dim", "↑/k: up   ↓/j: down   Enter: open   Esc/q: close"));
						lines.push("");

						for (let i = scroll; i < Math.min(ordered.length, scroll + maxItems); i++) {
							const label = clipText(labels[i] ?? "", innerWidth - 2);
							const line = `${i === selected ? "›" : " "} ${label}`;
							lines.push(i === selected ? theme.bg("selectedBg", theme.fg("text", line.padEnd(innerWidth))) : line);
						}

						if (ordered.length > maxItems) {
							lines.push("");
							lines.push(theme.fg("dim", `${selected + 1}/${ordered.length}`));
						}
						return lines;
					},
					invalidate: () => {},
					handleInput: (data: string) => {
						if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") {
							done(undefined);
						} else if (matchesKey(data, "up") || data === "k") {
							move(-1);
						} else if (matchesKey(data, "down") || data === "j") {
							move(1);
						} else if (matchesKey(data, "return") || matchesKey(data, "enter")) {
							done(selected);
						}
					},
				};
			},
			{ overlay: true, overlayOptions: { anchor: "center", width: 90, maxHeight: 18 } },
		);

		return selectedIndex === undefined ? undefined : ordered[selectedIndex];
	}

	pi.on("session_start", async (_event, ctx) => {
		restoreSubagents(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreSubagents(ctx);
	});

	pi.registerCommand("btw", {
		description: "Ask an ephemeral side question about the current session without adding it to history",
		handler: async (args, ctx) => {
			let question = args.trim();
			if (!question && ctx.hasUI) {
				question = (await ctx.ui.input("/btw", "Side question:"))?.trim() ?? "";
			}
			if (!question) {
				ctx.ui.notify("Usage: /btw <question>", "warning");
				return;
			}
			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			const model = ctx.model;
			const conversation = buildConversationText(ctx.sessionManager.getBranch() as SessionEntry[]);
			const prompt = [`<conversation>`, conversation || "(No prior conversation.)", `</conversation>`, "", `<side_question>`, question, `</side_question>`].join("\n");

			const run = async (signal?: AbortSignal): Promise<string> => {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
				if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? `No API key for ${model.provider}` : auth.error);

				const message: UserMessage = {
					role: "user",
					content: [{ type: "text", text: prompt }],
					timestamp: Date.now(),
				};
				const response = await complete(model, { systemPrompt: SYSTEM_PROMPT, messages: [message] }, { apiKey: auth.apiKey, headers: auth.headers, signal });
				if (response.stopReason === "aborted") return "";
				return response.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n")
					.trim();
			};

			const exchange: BtwExchange = {
				id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				question,
				timestamp: Date.now(),
				status: "running",
				model: `${model.provider}/${model.id}`,
			};
			subagents.push(exchange);
			ctx.ui.notify(`Spawned /btw subagent #${subagents.length}. Use /subagents to view it.`, "info");

			void (async () => {
				try {
					const answer = await run();
					if (!answer) throw new Error("No answer returned");
					exchange.answer = answer;
					exchange.status = "done";
					exchange.completedAt = Date.now();
					persistCompletedSubagent(exchange);
					reportToMainThread(exchange);
				} catch (error) {
					exchange.error = error instanceof Error ? error.message : String(error);
					exchange.status = "error";
					exchange.completedAt = Date.now();
					persistCompletedSubagent(exchange);
					reportToMainThread(exchange);
				}
			})();
		},
	});

	function subagentBody(exchange: BtwExchange): string {
		if (exchange.status === "running") return `Still running.\n\nQuestion: ${exchange.question}`;
		if (exchange.status === "error") return `Failed: ${exchange.error ?? "unknown error"}\n\nQuestion: ${exchange.question}`;
		return exchange.answer ?? "No answer saved.";
	}

	pi.registerCommand("subagents", {
		description: "Navigate /btw side-question subagents saved for this session",
		handler: async (args, ctx) => {
			restoreSubagents(ctx);
			if (subagents.length === 0) {
				ctx.ui.notify("No /btw subagents in this session yet", "info");
				return;
			}

			const requestedIndex = Number.parseInt(args.trim(), 10);
			if (Number.isFinite(requestedIndex) && requestedIndex >= 1 && requestedIndex <= subagents.length) {
				const exchange = subagents[requestedIndex - 1]!;
				await showAnswer(subagentBody(exchange), ctx, `/btw #${requestedIndex}: ${exchange.question.slice(0, 50)}`);
				return;
			}

			const ordered = [...subagents].sort((a, b) => b.timestamp - a.timestamp);
			const labels = ordered.map((exchange, index) => {
				const when = new Date(exchange.timestamp).toLocaleTimeString();
				const status = exchange.status === "running" ? "…" : exchange.status === "error" ? "✗" : "✓";
				const question = exchange.question.replace(/\s+/g, " ").slice(0, 80);
				return `${index + 1}. ${status} ${when} — ${question}`;
			});

			const exchange = await pickSubagent(ordered, labels, ctx);
			if (!exchange) return;
			await showAnswer(subagentBody(exchange), ctx, `/btw: ${exchange.question.slice(0, 60)}`);
		},
	});
}
