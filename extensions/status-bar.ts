import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { basename } from "node:path";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

type QuotaSeverity = "dim" | "success" | "warning" | "error";

type QuotaState = {
	text: string;
	severity: QuotaSeverity;
	updatedAt?: number;
};

const FAST_MODE_MODEL_IDS = new Set(["gpt-5.5", "gpt-5.4"]);
const FAST_STATE_ENTRY_TYPE = "codex-fast";
const FAST_STATE_EVENT = "codex-fast:state";
const QUOTA_STATE_EVENT = "codex-quota:state";
const MOBILE_FOOTER_WIDTH = 80;

function fastAppliesTo(model: any) {
	return !!model && model.provider === "openai-codex" && FAST_MODE_MODEL_IDS.has(model.id);
}

export default function statusBarExtension(pi: ExtensionAPI) {
	let fastEnabled = true;
	let quota: QuotaState = {
		text: "Codex quota: loading…",
		severity: "dim",
	};
	let render: (() => void) | undefined;
	let activeFooter: symbol | undefined;

	function requestRender() {
		render?.();
	}

	pi.events.on(FAST_STATE_EVENT, (data) => {
		const enabled = (data as { enabled?: unknown } | undefined)?.enabled;
		if (typeof enabled === "boolean") {
			fastEnabled = enabled;
			requestRender();
		}
	});

	pi.events.on(QUOTA_STATE_EVENT, (data) => {
		if (isQuotaState(data)) {
			quota = data;
			requestRender();
		}
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		fastEnabled = true;
		quota = {
			text: "Codex quota: loading…",
			severity: "dim",
		};
		const savedFast = ctx.sessionManager
			.getBranch()
			.filter((entry: { type: string; customType?: string }) => {
				return entry.type === "custom" && entry.customType === FAST_STATE_ENTRY_TYPE;
			})
			.pop() as { data?: { enabled?: boolean } } | undefined;
		if (typeof savedFast?.data?.enabled === "boolean") {
			fastEnabled = savedFast.data.enabled;
		}

		ctx.ui.setFooter((tui, theme, footerData) => {
				const footerToken = Symbol("status-footer");
				activeFooter = footerToken;
				const footerRender = () => tui.requestRender();
				render = footerRender;
				const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());

				return {
					dispose() {
						unsubscribeBranch();
						if (activeFooter === footerToken) {
							activeFooter = undefined;
							render = undefined;
						}
					},
				invalidate() {},
				render(width: number): string[] {
					const stats = getSessionStats(ctx);
					const branch = footerData.getGitBranch();
					const usage = ctx.getContextUsage();
					const cwd = basename(ctx.cwd) || ctx.cwd;

					const leftParts = [
						cwd,
						branch ? ` ${branch}` : undefined,
						`↑${formatCount(stats.input)}`,
						`↓${formatCount(stats.output)}`,
						stats.cost > 0 ? `$${stats.cost.toFixed(3)}` : undefined,
						usage?.percent != null ? `ctx ${Math.round(usage.percent)}%` : undefined,
					].filter(Boolean) as string[];

					const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model";
					const thinking = pi.getThinkingLevel();
					const left = theme.fg("dim", leftParts.join("  "));
					const rightParts = [
						...(fastEnabled && fastAppliesTo(ctx.model) ? [theme.fg("text", "fast")] : []),
						theme.fg("accent", model),
						theme.fg("dim", `thinking ${thinking}`),
					];
					const right = rightParts.join(theme.fg("dim", " · "));

					const statuses = Array.from(footerData.getExtensionStatuses().entries())
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, text]) => text)
						.join("  ");
					const quotaText = colorQuotaText(theme, quota);

					const mobileLayout = width <= MOBILE_FOOTER_WIDTH;
					return [
						...formatStatusPair(left, right, width, mobileLayout),
						...formatStatusPair(theme.fg("dim", statuses), quotaText, width, mobileLayout),
					];
				},
			};
		});
	});

}

function isQuotaState(value: unknown): value is QuotaState {
	if (!value || typeof value !== "object") return false;
	const state = value as Partial<QuotaState>;
	return typeof state.text === "string" && ["dim", "success", "warning", "error"].includes(String(state.severity));
}

function getSessionStats(ctx: any) {
	let input = 0;
	let output = 0;
	let cost = 0;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const message = entry.message as AssistantMessage;
		input += message.usage?.input ?? 0;
		output += message.usage?.output ?? 0;
		cost += message.usage?.cost?.total ?? 0;
	}
	return { input, output, cost };
}

function colorQuotaText(theme: any, quota: QuotaState): string {
	const percentPattern = /(\d+)%/g;
	let result = "";
	let cursor = 0;
	for (const match of quota.text.matchAll(percentPattern)) {
		const start = match.index ?? 0;
		if (start > cursor) result += theme.fg("text", quota.text.slice(cursor, start));

		const percent = Number(match[1]);
		const color = percent <= 20 ? "error" : percent <= 40 ? "warning" : "text";
		result += theme.fg(color, match[0]);
		cursor = start + match[0].length;
	}
	if (cursor < quota.text.length) result += theme.fg("text", quota.text.slice(cursor));
	return result || theme.fg(quota.severity, quota.text);
}

function formatCount(n: number): string {
	if (n < 1_000) return String(n);
	if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(1)}m`;
}

function formatStatusPair(left: string, right: string, width: number, stacked: boolean): string[] {
	if (width <= 0) return [""];
	if (!stacked) return [alignLine(left, right, width)];

	const lines = [...wrapStatusLine(left, width), ...wrapStatusLine(right, width)];
	return lines.length ? lines : [""];
}

function wrapStatusLine(text: string, width: number): string[] {
	if (visibleWidth(text) <= 0) return [];
	return wrapTextWithAnsi(text, width).filter((line) => visibleWidth(line) > 0);
}

function alignLine(left: string, right: string, width: number): string {
	if (width <= 0) return "";
	const rightText = truncateToWidth(right, width, "");
	const rightWidth = visibleWidth(rightText);
	if (rightWidth >= width) return rightText;

	const leftMax = Math.max(0, width - rightWidth - 1);
	const leftText = truncateToWidth(left, leftMax, "");
	const pad = " ".repeat(Math.max(1, width - visibleWidth(leftText) - rightWidth));
	return truncateToWidth(`${leftText}${pad}${rightText}`, width, "");
}
