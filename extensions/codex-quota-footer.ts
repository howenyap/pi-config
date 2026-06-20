import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { basename } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type QuotaSeverity = "dim" | "success" | "warning" | "error";

type QuotaState = {
	text: string;
	severity: QuotaSeverity;
	updatedAt?: number;
};

type UsageWindow = {
	used_percent?: number;
	usedPercent?: number;
	limit_window_seconds?: number;
	limitWindowSeconds?: number;
	reset_after_seconds?: number;
	resetAfterSeconds?: number;
	reset_at?: number;
	resetAt?: number;
};

type UsageLimit = {
	allowed?: boolean;
	limit_reached?: boolean;
	limitReached?: boolean;
	primary_window?: UsageWindow | null;
	primaryWindow?: UsageWindow | null;
	secondary_window?: UsageWindow | null;
	secondaryWindow?: UsageWindow | null;
};

type UsageResponse = {
	plan_type?: string;
	planType?: string;
	rate_limit?: UsageLimit;
	rateLimit?: UsageLimit;
	code_review_rate_limit?: UsageLimit;
	codeReviewRateLimit?: UsageLimit;
	additional_rate_limits?: unknown;
	additionalRateLimits?: unknown;
	credits?: {
		has_credits?: boolean;
		hasCredits?: boolean;
		unlimited?: boolean;
		balance?: string | number;
		approx_local_messages?: [number, number];
		approxLocalMessages?: [number, number];
	};
	spend_control?: { reached?: boolean };
	spendControl?: { reached?: boolean };
};

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const REFRESH_MS = 60_000;
const FAST_MODE_MODEL_IDS = new Set(["gpt-5.5", "gpt-5.4"]);
const FAST_STATE_ENTRY_TYPE = "codex-fast";
const FAST_STATE_EVENT = "codex-fast:state";

let fastEnabled = true;

function fastAppliesTo(model: any) {
	return !!model && model.provider === "openai-codex" && FAST_MODE_MODEL_IDS.has(model.id);
}

export default function (pi: ExtensionAPI) {
	let quota: QuotaState = {
		text: "Codex quota: loading…",
		severity: "dim",
	};
	let inFlight = false;
	let disposed = false;
	let lastFetch = 0;
	let render: (() => void) | undefined;
	let interval: ReturnType<typeof setInterval> | undefined;
	let refreshTimeout: ReturnType<typeof setTimeout> | undefined;

	function requestRender() {
		render?.();
	}

	function setQuota(next: QuotaState) {
		quota = next;
		requestRender();
	}

	pi.events.on(FAST_STATE_EVENT, (data) => {
		const enabled = (data as { enabled?: unknown } | undefined)?.enabled;
		if (typeof enabled === "boolean") {
			fastEnabled = enabled;
			requestRender();
		}
	});

	function scheduleRefresh(ctx: any, delayMs = 0, force = false) {
		if (disposed) return;
		if (refreshTimeout) clearTimeout(refreshTimeout);
		refreshTimeout = setTimeout(() => {
			void refreshQuota(ctx, force);
		}, delayMs);
	}

	async function refreshQuota(ctx: any, force = false) {
		if (disposed || inFlight) return;
		const now = Date.now();
		if (!force && quota.updatedAt && now - lastFetch < REFRESH_MS) return;

		inFlight = true;
		lastFetch = now;
		if (!quota.updatedAt) {
			setQuota({ text: "Codex quota: loading…", severity: "dim" });
		}

		try {
			const token = await ctx.modelRegistry.getApiKeyForProvider("openai-codex");
			if (!token) {
				setQuota({ text: "Codex quota: not logged in", severity: "warning", updatedAt: Date.now() });
				return;
			}

			const accountId = extractAccountId(token);
			if (!accountId) {
				setQuota({
					text: "Codex quota: ChatGPT subscription login required",
					severity: "warning",
					updatedAt: Date.now(),
				});
				return;
			}

			const response = await fetch(USAGE_URL, {
				headers: {
					Authorization: `Bearer ${token}`,
					"ChatGPT-Account-Id": accountId,
					originator: "pi",
					"User-Agent": "pi codex-quota-footer",
				},
				signal: ctx.signal,
			});

			if (!response.ok) {
				setQuota({
					text: `Codex quota: usage endpoint ${response.status}`,
					severity: response.status === 401 || response.status === 403 ? "error" : "warning",
					updatedAt: Date.now(),
				});
				return;
			}

			const data = (await response.json()) as UsageResponse;
			setQuota(formatUsage(data));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			setQuota({
				text: `Codex quota: ${message}`,
				severity: "warning",
				updatedAt: Date.now(),
			});
		} finally {
			inFlight = false;
		}
	}

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		fastEnabled = true;
		const savedFast = ctx.sessionManager
			.getEntries()
			.filter((entry: { type: string; customType?: string }) => {
				return entry.type === "custom" && entry.customType === FAST_STATE_ENTRY_TYPE;
			})
			.pop() as { data?: { enabled?: boolean } } | undefined;
		if (typeof savedFast?.data?.enabled === "boolean") {
			fastEnabled = savedFast.data.enabled;
		}

		if (interval) clearInterval(interval);
		if (refreshTimeout) clearTimeout(refreshTimeout);
		disposed = false;

		ctx.ui.setFooter((tui, theme, footerData) => {
			render = () => tui.requestRender();
			const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose() {
					unsubscribeBranch();
					render = undefined;
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

					const statuses = Array.from(footerData.getExtensionStatuses().values()).join("  ");
					const quotaText = colorQuotaText(theme, quota.text);

					return [
						alignLine(left, right, width),
						alignLine(theme.fg("dim", statuses), quotaText, width),
					];
				},
			};
		});

		scheduleRefresh(ctx, 0, true);
		interval = setInterval(() => scheduleRefresh(ctx, 0, false), REFRESH_MS);
	});

	pi.on("after_provider_response", (_event, ctx) => {
		if (ctx.model?.provider === "openai-codex") {
			scheduleRefresh(ctx, 1_000, true);
		}
	});

	pi.on("model_select", (_event, ctx) => {
		scheduleRefresh(ctx, 0, false);
	});

	pi.on("session_shutdown", () => {
		disposed = true;
		if (interval) clearInterval(interval);
		if (refreshTimeout) clearTimeout(refreshTimeout);
		interval = undefined;
		refreshTimeout = undefined;
		render = undefined;
	});
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

function colorQuotaText(theme: any, text: string): string {
	const percentPattern = /(\d+)%/g;
	let result = "";
	let cursor = 0;
	for (const match of text.matchAll(percentPattern)) {
		const start = match.index ?? 0;
		if (start > cursor) result += theme.fg("text", text.slice(cursor, start));

		const percent = Number(match[1]);
		const color = percent <= 20 ? "error" : percent <= 40 ? "warning" : "text";
		result += theme.fg(color, match[0]);
		cursor = start + match[0].length;
	}
	if (cursor < text.length) result += theme.fg("text", text.slice(cursor));
	return result || theme.fg("text", text);
}

function formatUsage(data: UsageResponse): QuotaState {
	const parts: string[] = [];
	let severity: QuotaSeverity = "success";
	let minRemaining = 100;

	const plan = data.plan_type ?? data.planType;
	if (plan) parts.push(`Codex ${capitalize(plan)}`);
	else parts.push("Codex");

	const main = data.rate_limit ?? data.rateLimit;
	const mainParts = formatLimitWindows(main, "");
	parts.push(...mainParts.parts);
	minRemaining = Math.min(minRemaining, mainParts.minRemaining);
	if (mainParts.reached) severity = "error";

	const review = data.code_review_rate_limit ?? data.codeReviewRateLimit;
	const reviewParts = formatLimitWindows(review, "review ");
	parts.push(...reviewParts.parts.slice(0, 1));
	minRemaining = Math.min(minRemaining, reviewParts.minRemaining);
	if (reviewParts.reached) severity = "error";


	const spendReached = (data.spend_control ?? data.spendControl)?.reached;
	if (spendReached) {
		parts.push("spend limit reached");
		severity = "error";
	}

	if (severity !== "error") {
		severity = minRemaining <= 20 ? "error" : minRemaining <= 40 ? "warning" : "success";
	}

	return {
		text: parts.length > 1 ? parts.join(" · ") : "Codex quota: no limits returned",
		severity,
		updatedAt: Date.now(),
	};
}

function formatLimitWindows(limit: UsageLimit | undefined, prefix: string) {
	const parts: string[] = [];
	let minRemaining = 100;
	const reached = limit?.limit_reached === true || limit?.limitReached === true || limit?.allowed === false;

	const primary = limit?.primary_window ?? limit?.primaryWindow;
	const secondary = limit?.secondary_window ?? limit?.secondaryWindow;
	for (const win of [primary, secondary]) {
		if (!win) continue;
		const usedPercent = getPercent(win);
		const remainingPercent = usedPercent == null ? undefined : Math.max(0, Math.min(100, 100 - usedPercent));
		if (remainingPercent != null) minRemaining = Math.min(minRemaining, remainingPercent);
		const label = formatWindowLabel(win);
		const reset = getResetSeconds(win);
		const pctText = remainingPercent == null ? "?%" : `${Math.round(remainingPercent)}%`;
		parts.push(`${prefix}${label} ${pctText}${reset == null ? "" : ` reset ${formatDuration(reset)}`}`);
	}

	return { parts, minRemaining, reached };
}

function getPercent(win: UsageWindow): number | undefined {
	const raw = win.used_percent ?? win.usedPercent;
	if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
	return raw <= 1 && raw >= 0 ? raw * 100 : raw;
}

function getResetSeconds(win: UsageWindow): number | undefined {
	const raw = win.reset_after_seconds ?? win.resetAfterSeconds;
	if (typeof raw === "number" && Number.isFinite(raw)) return Math.max(0, raw);
	const resetAt = win.reset_at ?? win.resetAt;
	if (typeof resetAt === "number" && Number.isFinite(resetAt)) {
		const millis = resetAt > 10_000_000_000 ? resetAt : resetAt * 1000;
		return Math.max(0, Math.round((millis - Date.now()) / 1000));
	}
	return undefined;
}

function formatWindowLabel(win: UsageWindow): string {
	const seconds = win.limit_window_seconds ?? win.limitWindowSeconds;
	if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return "limit";
	if (seconds % 604800 === 0) return `${seconds / 604800}w`;
	if (seconds % 86400 === 0) return `${seconds / 86400}d`;
	if (seconds % 3600 === 0) return `${seconds / 3600}h`;
	if (seconds % 60 === 0) return `${seconds / 60}m`;
	return `${Math.round(seconds)}s`;
}

function formatDuration(seconds: number): string {
	if (seconds <= 0) return "now";
	if (seconds >= 86400) return `${Math.ceil(seconds / 86400)}d`;
	if (seconds >= 3600) return `${Math.ceil(seconds / 3600)}h`;
	if (seconds >= 60) return `${Math.ceil(seconds / 60)}m`;
	return `${Math.ceil(seconds)}s`;
}

function formatCount(n: number): string {
	if (n < 1_000) return String(n);
	if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(1)}m`;
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

function extractAccountId(token: string): string | undefined {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return undefined;
		const payload = JSON.parse(base64UrlDecode(parts[1]));
		return payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
	} catch {
		return undefined;
	}
}

function base64UrlDecode(value: string): string {
	const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
	const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
	return Buffer.from(padded, "base64").toString("utf8");
}

function capitalize(value: string): string {
	return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}
