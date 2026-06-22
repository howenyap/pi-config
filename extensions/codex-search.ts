import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const STATE_ENTRY_TYPE = "codex-search";
const STATE_EVENT = "codex-search:state";
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const MAX_OUTPUT_CHARS = 60_000;
const MAX_ERROR_CHARS = 4_000;

const SEARCH_EXTENSION_MODES = ["off", "standalone", "hosted", "both"] as const;
const WEB_SEARCH_ACCESS_MODES = ["cached", "indexed", "live"] as const;
const SEARCH_CONTEXT_SIZES = ["low", "medium", "high"] as const;
const RESPONSE_LENGTHS = ["short", "medium", "long"] as const;

type SearchExtensionMode = (typeof SEARCH_EXTENSION_MODES)[number];
type WebSearchAccessMode = (typeof WEB_SEARCH_ACCESS_MODES)[number];
type SearchContextSize = (typeof SEARCH_CONTEXT_SIZES)[number];
type ResponseLength = (typeof RESPONSE_LENGTHS)[number];

type CodexSearchState = {
	mode: SearchExtensionMode;
	access: WebSearchAccessMode;
	contextSize?: SearchContextSize;
	allowedDomains?: string[];
};

type SearchQuery = {
	q: string;
	recency?: number;
	domains?: string[];
};

type OpenOperation = { ref_id: string; lineno?: number };
type ClickOperation = { ref_id: string; id: number };
type FindOperation = { ref_id: string; pattern: string };
type ScreenshotOperation = { ref_id: string; pageno: number };
type FinanceOperation = { ticker: string; type: "equity" | "fund" | "crypto" | "index"; market?: string };
type WeatherOperation = { location: string; start?: string; duration?: number };
type SportsOperation = {
	tool?: "sports";
	fn: "schedule" | "standings";
	league: "nba" | "wnba" | "nfl" | "nhl" | "mlb" | "epl" | "ncaamb" | "ncaawb" | "ipl";
	team?: string;
	opponent?: string;
	date_from?: string;
	date_to?: string;
	num_games?: number;
	locale?: string;
};
type TimeOperation = { utc_offset: string };

type WebRunParams = {
	search_query?: SearchQuery[];
	image_query?: SearchQuery[];
	open?: OpenOperation[];
	click?: ClickOperation[];
	find?: FindOperation[];
	screenshot?: ScreenshotOperation[];
	finance?: FinanceOperation[];
	weather?: WeatherOperation[];
	sports?: SportsOperation[];
	time?: TimeOperation[];
	response_length?: ResponseLength;
};

type SearchResponse = {
	encrypted_output?: string;
	output?: string;
};

type AgentToolContent = { type: "text"; text: string };

let state: CodexSearchState = {
	mode: "hosted",
	access: "live",
	contextSize: "medium",
};

const searchQuerySchema = Type.Object({
	q: Type.String({ minLength: 1, description: "Search query." }),
	recency: Type.Optional(Type.Integer({ minimum: 1, description: "Restrict results to this many recent days." })),
	domains: Type.Optional(Type.Array(Type.String(), { description: "Restrict this query to specific domains." })),
});

const webRunSchema = Type.Object({
	search_query: Type.Optional(Type.Array(searchQuerySchema, { description: "Query the internet search engine for one or more text queries." })),
	image_query: Type.Optional(Type.Array(searchQuerySchema, { description: "Query the image search engine for one or more image queries." })),
	open: Type.Optional(Type.Array(Type.Object({
		ref_id: Type.String({ description: "Reference id from prior search/open results, or a literal URL." }),
		lineno: Type.Optional(Type.Integer({ minimum: 1, description: "Line number to position the opened page near." })),
	}), { description: "Open pages by reference id or URL." })),
	click: Type.Optional(Type.Array(Type.Object({
		ref_id: Type.String({ description: "Reference id containing numbered links." }),
		id: Type.Integer({ minimum: 0, description: "Numbered link id to open." }),
	}), { description: "Open links from previously opened pages." })),
	find: Type.Optional(Type.Array(Type.Object({
		ref_id: Type.String({ description: "Reference id or URL to search within." }),
		pattern: Type.String({ minLength: 1, description: "Text pattern to find in the page." }),
	}), { description: "Find text patterns in opened pages." })),
	screenshot: Type.Optional(Type.Array(Type.Object({
		ref_id: Type.String({ description: "Reference id or URL to screenshot." }),
		pageno: Type.Integer({ minimum: 0, description: "Zero-indexed PDF page number." }),
	}), { description: "Take screenshots of PDF pages." })),
	finance: Type.Optional(Type.Array(Type.Object({
		ticker: Type.String({ minLength: 1, description: "Ticker symbol." }),
		type: StringEnum(["equity", "fund", "crypto", "index"] as const),
		market: Type.Optional(Type.String({ description: "ISO 3166-1 alpha-3 country code, OTC, or empty for crypto." })),
	}), { description: "Look up prices for stock symbols, funds, crypto, or indices." })),
	weather: Type.Optional(Type.Array(Type.Object({
		location: Type.String({ description: "Location in 'Country, Area, City' format." }),
		start: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Start date in YYYY-MM-DD format. Defaults to today." })),
		duration: Type.Optional(Type.Integer({ minimum: 1, maximum: 14, description: "Number of forecast days. Defaults to 7." })),
	}), { description: "Look up weather forecasts." })),
	sports: Type.Optional(Type.Array(Type.Object({
		tool: Type.Optional(StringEnum(["sports"] as const)),
		fn: StringEnum(["schedule", "standings"] as const),
		league: StringEnum(["nba", "wnba", "nfl", "nhl", "mlb", "epl", "ncaamb", "ncaawb", "ipl"] as const),
		team: Type.Optional(Type.String()),
		opponent: Type.Optional(Type.String()),
		date_from: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
		date_to: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
		num_games: Type.Optional(Type.Integer({ minimum: 1 })),
		locale: Type.Optional(Type.String()),
	}), { description: "Look up sports schedules and standings." })),
	time: Type.Optional(Type.Array(Type.Object({
		utc_offset: Type.String({ pattern: "^[+-]\\d{2}:\\d{2}$", description: "UTC offset like '+03:00'." }),
	}), { description: "Get local time for UTC offsets." })),
	response_length: Type.Optional(StringEnum(RESPONSE_LENGTHS, { description: "Length of the search response to return." })),
});

function compactObject<T extends Record<string, unknown>>(value: T): Partial<T> {
	return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== null)) as Partial<T>;
}

function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n[truncated after ${maxChars} chars]`;
}

function decodeJwtPayload(token: string): Record<string, any> {
	const parts = token.split(".");
	if (parts.length !== 3) throw new Error("Invalid OpenAI Codex token shape");
	const payload = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
	return JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
}

function extractAccountId(token: string): string {
	const payload = decodeJwtPayload(token);
	const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
	if (typeof accountId !== "string" || !accountId) {
		throw new Error("Failed to extract chatgpt_account_id from OpenAI Codex token");
	}
	return accountId;
}

function getHeader(headers: Record<string, string> | undefined, name: string): string | undefined {
	if (!headers) return undefined;
	const lower = name.toLowerCase();
	const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === lower);
	return entry?.[1];
}

function resolveCodexApiBaseUrl(baseUrl: string | undefined): string {
	let normalized = (baseUrl?.trim() || DEFAULT_CODEX_BASE_URL).replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) normalized = normalized.slice(0, -"/responses".length);
	if (!normalized.endsWith("/codex")) normalized = `${normalized}/codex`;
	return normalized;
}

function resolveSearchUrl(baseUrl: string | undefined): string {
	const normalized = resolveCodexApiBaseUrl(baseUrl);
	if (normalized.endsWith("/alpha/search")) return normalized;
	return `${normalized}/alpha/search`;
}

function externalWebAccess(access: WebSearchAccessMode): boolean | "indexed" {
	if (access === "cached") return false;
	if (access === "indexed") return "indexed";
	return true;
}

function hostedWebSearchTool() {
	return compactObject({
		type: "web_search",
		external_web_access: state.access === "cached" ? false : true,
		index_gated_web_access: state.access === "indexed" ? true : undefined,
		filters: state.allowedDomains?.length ? { allowed_domains: state.allowedDomains } : undefined,
		search_context_size: state.contextSize,
	});
}

function hasCommand(params: WebRunParams): boolean {
	return [
		params.search_query,
		params.image_query,
		params.open,
		params.click,
		params.find,
		params.screenshot,
		params.finance,
		params.weather,
		params.sports,
		params.time,
	].some((value) => Array.isArray(value) && value.length > 0);
}

function summarizeCommand(params: WebRunParams): string {
	const pieces: string[] = [];
	if (params.search_query?.length) pieces.push(`search: ${params.search_query.map((q) => q.q).join("; ")}`);
	if (params.image_query?.length) pieces.push(`image: ${params.image_query.map((q) => q.q).join("; ")}`);
	if (params.open?.length) pieces.push(`open: ${params.open.map((o) => o.ref_id).join(", ")}`);
	if (params.click?.length) pieces.push(`click: ${params.click.map((c) => `${c.ref_id}#${c.id}`).join(", ")}`);
	if (params.find?.length) pieces.push(`find: ${params.find.map((f) => `${f.pattern} in ${f.ref_id}`).join(", ")}`);
	if (params.weather?.length) pieces.push(`weather: ${params.weather.map((w) => w.location).join(", ")}`);
	if (params.finance?.length) pieces.push(`finance: ${params.finance.map((f) => f.ticker).join(", ")}`);
	if (params.sports?.length) pieces.push(`sports: ${params.sports.map((s) => `${s.league} ${s.fn}`).join(", ")}`);
	if (params.time?.length) pieces.push(`time: ${params.time.map((t) => t.utc_offset).join(", ")}`);
	return pieces.join(" · ") || "web.run";
}

function publish(pi: ExtensionAPI) {
	pi.events.emit(STATE_EVENT, { ...state });
}

function persist(pi: ExtensionAPI) {
	pi.appendEntry(STATE_ENTRY_TYPE, { ...state });
}

function syncActiveTools(pi: ExtensionAPI) {
	const active = new Set(pi.getActiveTools());
	const shouldEnableWebRun = state.mode === "standalone" || state.mode === "both";
	if (shouldEnableWebRun) active.add("web_run");
	else active.delete("web_run");
	pi.setActiveTools([...active]);
}

function parseMode(value: string): SearchExtensionMode | undefined {
	return SEARCH_EXTENSION_MODES.find((mode) => mode === value);
}

function parseAccess(value: string): WebSearchAccessMode | undefined {
	return WEB_SEARCH_ACCESS_MODES.find((mode) => mode === value);
}

function parseContextSize(value: string): SearchContextSize | undefined {
	return SEARCH_CONTEXT_SIZES.find((size) => size === value);
}

function formatState(): string {
	const domains = state.allowedDomains?.length ? `, domains=${state.allowedDomains.join(",")}` : "";
	return `mode=${state.mode}, access=${state.access}, context=${state.contextSize ?? "default"}${domains}`;
}

function formatCollapsedResult(result: { details?: any }, params: WebRunParams, theme: Theme): string {
	const detail = summarizeCommand(params);
	const chars = typeof result.details?.outputChars === "number" ? `, ${result.details.outputChars} chars` : "";
	return [
		`${theme.fg("success", "✓ web.run completed")}${theme.fg("dim", chars)}`,
		`${theme.fg("muted", "command:")} ${theme.fg("toolOutput", detail)}`,
		`${theme.fg("muted", keyHint("app.tools.expand", "to expand search output"))}`,
	].join("\n");
}

function textContent(result: { content?: unknown }): string {
	if (!Array.isArray(result.content)) return "";
	return result.content
		.filter((item): item is AgentToolContent => typeof item === "object" && item !== null && (item as { type?: unknown }).type === "text" && typeof (item as { text?: unknown }).text === "string")
		.map((item) => item.text)
		.join("\n");
}

function restoreFromBranch(ctx: any) {
	state = { mode: "hosted", access: "live", contextSize: "medium" };
	const saved = ctx.sessionManager
		.getBranch()
		.filter((entry: { type: string; customType?: string }) => entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE)
		.pop() as { data?: Partial<CodexSearchState> } | undefined;

	if (saved?.data) {
		state = {
			mode: parseMode(String(saved.data.mode)) ?? state.mode,
			access: parseAccess(String(saved.data.access)) ?? state.access,
			contextSize: parseContextSize(String(saved.data.contextSize)) ?? state.contextSize,
			allowedDomains: Array.isArray(saved.data.allowedDomains) ? saved.data.allowedDomains.filter((d): d is string => typeof d === "string" && d.trim().length > 0) : undefined,
		};
	}
}

export default function codexSearch(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		restoreFromBranch(ctx);
		syncActiveTools(pi);
		publish(pi);
	});

	pi.on("session_tree", (_event, ctx) => {
		restoreFromBranch(ctx);
		syncActiveTools(pi);
		publish(pi);
	});

	pi.registerCommand("codex-search", {
		description: "Configure Codex search (/codex-search status|off|standalone|hosted|both|cached|indexed|live|context low|domains ...)",
		getArgumentCompletions: (prefix) => {
			const options = ["status", "off", "standalone", "hosted", "both", "cached", "indexed", "live", "context low", "context medium", "context high", "domains clear"];
			return options.filter((option) => option.startsWith(prefix.trim().toLowerCase())).map((option) => ({ value: option, label: option }));
		},
		handler: async (args, ctx) => {
			const raw = args.trim();
			const lower = raw.toLowerCase();
			let changed = false;

			if (!lower || lower === "status") {
				ctx.ui.notify(`Codex search: ${formatState()}`, "info");
				return;
			}

			const mode = parseMode(lower);
			const access = parseAccess(lower);
			if (mode) {
				state.mode = mode;
				changed = true;
			} else if (access) {
				state.access = access;
				changed = true;
			} else if (lower.startsWith("context ")) {
				const size = parseContextSize(lower.slice("context ".length).trim());
				if (!size) {
					ctx.ui.notify("Usage: /codex-search context low|medium|high", "warning");
					return;
				}
				state.contextSize = size;
				changed = true;
			} else if (lower.startsWith("domains ")) {
				const domainText = raw.slice("domains ".length).trim();
				if (domainText.toLowerCase() === "clear" || !domainText) {
					state.allowedDomains = undefined;
				} else {
					state.allowedDomains = domainText.split(/[\s,]+/).map((d) => d.trim()).filter(Boolean);
				}
				changed = true;
			} else {
				ctx.ui.notify("Usage: /codex-search status|off|standalone|hosted|both|cached|indexed|live|context low|medium|high|domains <domain...>|domains clear", "warning");
				return;
			}

			if (changed) {
				persist(pi);
				syncActiveTools(pi);
				publish(pi);
			}
			ctx.ui.notify(`Codex search: ${formatState()}`, "info");
		},
	});

	pi.registerTool({
		name: "web_run",
		label: "web.run",
		description: "Codex-style standalone web.run. Search the web, open result refs or URLs, click links, find text in pages, and query weather/finance/sports/time using OpenAI Codex alpha/search.",
		promptSnippet: "Codex-style web.run for current web search, opening refs/URLs, finding text in pages, and weather/finance/sports/time lookups.",
		promptGuidelines: [
			"Use web_run when current web information, source verification, documentation, news, weather, finance, sports, or page lookup is needed.",
			"Use web_run search_query first, then use web_run open/click/find with returned refs when deeper page inspection is needed.",
			"Cite source URLs from web_run results in the final answer when using web information.",
		],
		parameters: webRunSchema,
		executionMode: "parallel",
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("web.run"))} ${theme.fg("toolOutput", summarizeCommand(args as WebRunParams))}`, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			const output = textContent(result);
			if (isPartial) return new Text(theme.fg("warning", "Running web.run…"), 0, 0);
			if (context.isError) return new Text(output ? theme.fg("error", output) : theme.fg("error", "web.run failed."), 0, 0);
			if (!expanded) return new Text(formatCollapsedResult(result, context.args as WebRunParams, theme), 0, 0);
			return new Text(output ? theme.fg("toolOutput", output) : theme.fg("muted", "No web.run output."), 0, 0);
		},
		async execute(_toolCallId, params: WebRunParams, signal, onUpdate, ctx) {
			if (state.mode !== "standalone" && state.mode !== "both") {
				throw new Error(`web_run is disabled because Codex search mode is '${state.mode}'. Use /codex-search standalone or /codex-search both.`);
			}
			if (!hasCommand(params)) {
				throw new Error("web_run requires at least one command: search_query, image_query, open, click, find, screenshot, finance, weather, sports, or time.");
			}

			onUpdate?.({ content: [{ type: "text" as const, text: "Running Codex alpha/search…" }] });

			const currentModel = ctx.model;
			const auth = currentModel?.provider === "openai-codex"
				? await ctx.modelRegistry.getApiKeyAndHeaders(currentModel)
				: { ok: true as const, apiKey: await ctx.modelRegistry.getApiKeyForProvider("openai-codex") };

			if (!auth.ok) throw new Error(auth.error);
			const apiKey = auth.apiKey;
			if (!apiKey) throw new Error("Missing OpenAI Codex auth. Run /login and select OpenAI Codex/ChatGPT, or configure openai-codex credentials.");

			const accountId = getHeader(auth.headers, "chatgpt-account-id") ?? extractAccountId(apiKey);
			const baseUrl = currentModel?.provider === "openai-codex" ? currentModel.baseUrl : undefined;
			const modelId = currentModel?.provider === "openai-codex" ? currentModel.id : "gpt-5.5";
			const sessionId = ctx.sessionManager.getSessionId();
			const body = compactObject({
				id: sessionId,
				model: modelId,
				commands: compactObject(params as Record<string, unknown>),
				settings: compactObject({
					allowed_callers: ["direct"],
					external_web_access: externalWebAccess(state.access),
					search_context_size: state.contextSize,
					filters: state.allowedDomains?.length ? { allowed_domains: state.allowedDomains } : undefined,
				}),
				max_output_tokens: 12_000,
			});

			let response: Response;
			try {
				response = await fetch(resolveSearchUrl(baseUrl), {
					method: "POST",
					signal,
					headers: {
						...(auth.headers ?? {}),
						"authorization": `Bearer ${apiKey}`,
						"chatgpt-account-id": accountId,
						"originator": "pi",
						"user-agent": "pi codex-search",
						"accept": "application/json",
						"content-type": "application/json",
						"openai-beta": "responses=experimental",
						"session-id": sessionId,
						"x-client-request-id": sessionId,
					},
					body: JSON.stringify(body),
				});
			} catch (error) {
				throw new Error(`Codex alpha/search request failed: ${error instanceof Error ? error.message : String(error)}`);
			}

			const rawText = await response.text();
			let data: SearchResponse & Record<string, unknown>;
			try {
				data = rawText ? JSON.parse(rawText) : {};
			} catch {
				data = { output: rawText };
			}

			if (!response.ok) {
				throw new Error(`Codex alpha/search error ${response.status}: ${truncate(JSON.stringify(data), MAX_ERROR_CHARS)}`);
			}

			const output = typeof data.output === "string" ? data.output : JSON.stringify(data, null, 2);
			return {
				content: [{ type: "text" as const, text: truncate(output || "No search output.", MAX_OUTPUT_CHARS) }],
				details: compactObject({
					request: body,
					outputChars: output.length,
					hasEncryptedOutput: typeof data.encrypted_output === "string" && data.encrypted_output.length > 0,
				}),
			};
		},
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (state.mode !== "hosted" && state.mode !== "both") return;
		if (ctx.model?.provider !== "openai-codex") return;
		const payload = event.payload as any;
		if (!payload || typeof payload !== "object") return;
		if (!Array.isArray(payload.tools)) payload.tools = [];
		if (payload.tools.some((tool: any) => tool?.type === "web_search")) return payload;
		payload.tools.push(hostedWebSearchTool());
		return payload;
	});
}
