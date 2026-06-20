import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const KEYCHAIN_SERVICE = "pi-exa-api-key";
const DEFAULT_NUM_RESULTS = 8;
const MAX_NUM_RESULTS = 20;
const DEFAULT_TEXT_MAX_CHARACTERS = 3_000;
const MAX_TEXT_MAX_CHARACTERS = 20_000;
const MAX_SUMMARY_CHARS = 900;
const MAX_HIGHLIGHT_CHARS = 500;
const MAX_RESULT_TEXT_CHARS = 1_800;
const MAX_OUTPUT_CHARS = 45_000;
const EXA_SEARCH_TYPES = ["auto", "neural", "keyword", "instant", "deep-reasoning"] as const;

const exaSearchSchema = Type.Object({
	query: Type.String({ minLength: 1, description: "Search query. Be specific and include relevant product/library/version terms when useful." }),
	numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_NUM_RESULTS, description: `Number of results to return. Default: ${DEFAULT_NUM_RESULTS}.` })),
	type: Type.Optional(StringEnum(EXA_SEARCH_TYPES, { description: "Exa search type. Default: auto.", default: "auto" })),
	includeDomains: Type.Optional(Type.Array(Type.String(), { description: "Only return results from these domains, e.g. ['docs.exa.ai']." })),
	excludeDomains: Type.Optional(Type.Array(Type.String(), { description: "Exclude results from these domains." })),
	startPublishedDate: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Earliest publish date, ISO format YYYY-MM-DD." })),
	endPublishedDate: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Latest publish date, ISO format YYYY-MM-DD." })),
	text: Type.Optional(Type.Boolean({ description: `Request page text content. Default: true. Text requests are capped at ${DEFAULT_TEXT_MAX_CHARACTERS} characters per result by default.` })),
	textMaxCharacters: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_TEXT_MAX_CHARACTERS, description: `Maximum page text characters per result when text=true. Default: ${DEFAULT_TEXT_MAX_CHARACTERS}; max: ${MAX_TEXT_MAX_CHARACTERS}.` })),
	highlights: Type.Optional(Type.Boolean({ description: "Request Exa highlights/snippets. Default: true." })),
	summary: Type.Optional(Type.Boolean({ description: "Request Exa summaries when supported. Default: false." })),
});

type ExaSearchType = (typeof EXA_SEARCH_TYPES)[number];

type ExaSearchParams = {
	query: string;
	numResults?: number;
	type?: ExaSearchType;
	includeDomains?: string[];
	excludeDomains?: string[];
	startPublishedDate?: string;
	endPublishedDate?: string;
	text?: boolean;
	textMaxCharacters?: number;
	highlights?: boolean;
	summary?: boolean;
};

type ExaResult = {
	id?: string;
	title?: string;
	url?: string;
	publishedDate?: string;
	author?: string | null;
	text?: string;
	highlights?: string[];
	highlight?: string;
	summary?: string;
	score?: number;
};

type ExaSearchResponse = {
	results?: ExaResult[];
	requestId?: string;
	autopromptString?: string;
	resolvedSearchType?: string;
	searchTime?: number;
	costDollars?: unknown;
};

type ExaResultSummary = {
	title?: string;
	url?: string;
	publishedDate?: string;
	author?: string | null;
	score?: number;
	hasText?: boolean;
	textLength?: number;
	highlightCount?: number;
	hasSummary?: boolean;
};

type ExaSearchDetails = {
	resultCount?: number;
	results?: ExaResultSummary[];
	searchTime?: number;
	resolvedSearchType?: string;
};

function compactObject<T extends Record<string, unknown>>(value: T): Partial<T> {
	return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== null)) as Partial<T>;
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.min(Math.max(Math.trunc(value!), min), max);
}

function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n[truncated after ${maxChars} chars]`;
}

function formatResult(result: ExaResult, index: number): string {
	const highlights = Array.isArray(result.highlights) ? result.highlights : result.highlight ? [result.highlight] : [];
	const parts = [
		`${index + 1}. ${result.title ?? "Untitled"}`,
		result.url,
		result.publishedDate ? `Published: ${result.publishedDate}` : undefined,
		result.author ? `Author: ${result.author}` : undefined,
		typeof result.score === "number" ? `Score: ${result.score}` : undefined,
		result.summary ? `Summary: ${truncate(result.summary, MAX_SUMMARY_CHARS)}` : undefined,
		highlights.length > 0 ? `Highlights:\n${highlights.map((h) => `- ${truncate(String(h), MAX_HIGHLIGHT_CHARS)}`).join("\n")}` : undefined,
		result.text ? `Text:\n${truncate(result.text, MAX_RESULT_TEXT_CHARS)}` : undefined,
	];
	return parts.filter(Boolean).join("\n");
}

function formatResults(results: ExaResult[]): string {
	const output = results.length > 0 ? results.map(formatResult).join("\n\n---\n\n") : "No Exa results.";
	return truncate(output, MAX_OUTPUT_CHARS);
}

function getTextContent(result: { content?: unknown }): string {
	if (!Array.isArray(result.content)) return "";
	return result.content
		.filter((item): item is { type: "text"; text: string } => typeof item === "object" && item !== null && (item as { type?: unknown }).type === "text" && typeof (item as { text?: unknown }).text === "string")
		.map((item) => item.text)
		.join("\n");
}

function formatCollapsedResults(details: ExaSearchDetails | undefined, params: ExaSearchParams, theme: Theme): string {
	const count = details?.resultCount ?? details?.results?.length ?? 0;
	let text = theme.fg("success", `✓ Exa search returned ${count} result${count === 1 ? "" : "s"}`);
	const meta = [details?.resolvedSearchType, typeof details?.searchTime === "number" ? `${details.searchTime}ms` : undefined].filter(Boolean).join(", ");
	if (meta) text += theme.fg("dim", ` (${meta})`);

	text += `\n${theme.fg("muted", "query:")} ${theme.fg("toolOutput", params.query ?? "")}`;

	const paramSummary = [
		`numResults=${params.numResults ?? DEFAULT_NUM_RESULTS}`,
		`type=${params.type ?? "auto"}`,
		`text=${params.text ?? true}`,
		params.text !== false ? `textMaxCharacters=${params.textMaxCharacters ?? DEFAULT_TEXT_MAX_CHARACTERS}` : undefined,
		`highlights=${params.highlights ?? true}`,
		`summary=${params.summary ?? false}`,
		params.includeDomains?.length ? `includeDomains=${params.includeDomains.join(",")}` : undefined,
		params.excludeDomains?.length ? `excludeDomains=${params.excludeDomains.join(",")}` : undefined,
		params.startPublishedDate ? `start=${params.startPublishedDate}` : undefined,
		params.endPublishedDate ? `end=${params.endPublishedDate}` : undefined,
	].filter(Boolean);

	text += `\n${theme.fg("muted", "params:")} ${theme.fg("dim", paramSummary.join(" · "))}`;
	text += `\n${theme.fg("muted", keyHint("app.tools.expand", "to expand results"))}`;
	return text;
}

function summarizeResult(result: ExaResult) {
	return compactObject({
		id: result.id,
		title: result.title,
		url: result.url,
		publishedDate: result.publishedDate,
		author: result.author,
		score: result.score,
		hasText: typeof result.text === "string" && result.text.length > 0,
		textLength: typeof result.text === "string" ? result.text.length : undefined,
		highlightCount: Array.isArray(result.highlights) ? result.highlights.length : result.highlight ? 1 : 0,
		hasSummary: typeof result.summary === "string" && result.summary.length > 0,
	});
}

function parseJson(text: string): unknown {
	try {
		return text ? JSON.parse(text) : {};
	} catch {
		return { raw: text };
	}
}

async function getExaApiKey(): Promise<string | undefined> {
	if (process.env.EXA_API_KEY?.trim()) return process.env.EXA_API_KEY.trim();

	if (process.platform === "darwin") {
		try {
			const { stdout } = await execFileAsync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], {
				timeout: 10_000,
				maxBuffer: 10_000,
			});
			const key = stdout.trim();
			if (key) return key;
		} catch {
			// Keychain item missing or access denied. Fall through to friendly error.
		}
	}

	return undefined;
}

export default function exaSearch(pi: ExtensionAPI) {
	pi.registerTool({
		name: "exa_search",
		label: "Exa Search",
		description: "Search the web using Exa for current, high-quality results and source URLs. Output is capped to avoid overwhelming context.",
		promptSnippet: "Search the web with Exa for current docs, APIs, libraries, articles, and source verification.",
		promptGuidelines: [
			"Use exa_search when current web information, recent documentation, API references, library/framework details, or external source verification is needed.",
			"When using exa_search, cite relevant result URLs in the final answer.",
			"Prefer targeted exa_search queries that include the library, framework, API, version, and domain hints when known.",
		],
		parameters: exaSearchSchema,
		renderCall(args, theme) {
			const query = typeof args.query === "string" ? args.query : "";
			const count = typeof args.numResults === "number" ? args.numResults : DEFAULT_NUM_RESULTS;
			return new Text(`${theme.fg("toolTitle", theme.bold("Exa Search"))} ${theme.fg("dim", `(${count})`)} ${theme.fg("toolOutput", query)}`, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			const output = getTextContent(result);
			if (isPartial) {
				return new Text(theme.fg("warning", "Searching Exa…"), 0, 0);
			}
			if (context.isError) {
				return new Text(output ? theme.fg("error", output) : theme.fg("error", "Exa search failed."), 0, 0);
			}
			if (!expanded) {
				return new Text(formatCollapsedResults(result.details as ExaSearchDetails | undefined, context.args as ExaSearchParams, theme), 0, 0);
			}
			return new Text(output ? theme.fg("toolOutput", output) : theme.fg("muted", "No Exa output."), 0, 0);
		},
		async execute(_toolCallId, params: ExaSearchParams, signal) {
			const apiKey = await getExaApiKey();
			if (!apiKey) {
				throw new Error(`Missing Exa API key. On macOS, store it in Keychain with service '${KEYCHAIN_SERVICE}'. Fallback env var EXA_API_KEY is also supported.`);
			}

			const query = params.query.trim();
			if (!query) throw new Error("Exa search query must not be empty.");

			const wantsText = params.text ?? true;
			const textMaxCharacters = clampInteger(params.textMaxCharacters, DEFAULT_TEXT_MAX_CHARACTERS, 0, MAX_TEXT_MAX_CHARACTERS);
			const body = compactObject({
				query,
				numResults: clampInteger(params.numResults, DEFAULT_NUM_RESULTS, 1, MAX_NUM_RESULTS),
				type: params.type ?? "auto",
				includeDomains: params.includeDomains,
				excludeDomains: params.excludeDomains,
				startPublishedDate: params.startPublishedDate,
				endPublishedDate: params.endPublishedDate,
				contents: compactObject({
					text: wantsText ? { maxCharacters: textMaxCharacters } : false,
					highlights: params.highlights ?? true,
					summary: params.summary ? true : undefined,
				}),
			});

			let response: Response;
			try {
				response = await fetch("https://api.exa.ai/search", {
					method: "POST",
					signal,
					headers: {
						"content-type": "application/json",
						"x-api-key": apiKey,
					},
					body: JSON.stringify(body),
				});
			} catch (error) {
				throw new Error(`Exa request failed: ${error instanceof Error ? error.message : String(error)}`);
			}

			const rawText = await response.text();
			const data = parseJson(rawText) as ExaSearchResponse & Record<string, unknown>;

			if (!response.ok) {
				throw new Error(`Exa API error ${response.status}: ${truncate(JSON.stringify(data), 4_000)}`);
			}

			const results: ExaResult[] = Array.isArray(data.results) ? data.results : [];
			return {
				content: [{ type: "text" as const, text: formatResults(results) }],
				details: compactObject({
					request: body,
					requestId: data.requestId,
					autopromptString: data.autopromptString,
					resolvedSearchType: data.resolvedSearchType,
					searchTime: data.searchTime,
					costDollars: data.costDollars,
					resultCount: results.length,
					results: results.map(summarizeResult),
				}),
			};
		},
	});
}
