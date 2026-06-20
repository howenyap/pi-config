import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	clampThinkingLevel,
	streamOpenAICodexResponses,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";

// OpenAI Codex Fast mode maps to request service_tier="priority".
// Per https://developers.openai.com/codex/speed, Fast mode currently supports
// GPT-5.5 and GPT-5.4 and consumes credits faster for lower latency.
const FAST_MODE_MODEL_IDS = new Set(["gpt-5.5", "gpt-5.4"]);
const STATE_ENTRY_TYPE = "codex-fast";
const STATE_EVENT = "codex-fast:state";

let fastEnabled = true;

function fastAppliesTo(model: Model<any> | undefined) {
	return !!model && model.provider === "openai-codex" && FAST_MODE_MODEL_IDS.has(model.id);
}

function persist(pi: ExtensionAPI) {
	pi.appendEntry(STATE_ENTRY_TYPE, { enabled: fastEnabled });
}

function publish(pi: ExtensionAPI) {
	pi.events.emit(STATE_EVENT, { enabled: fastEnabled });
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		fastEnabled = true;
		const saved = ctx.sessionManager
			.getEntries()
			.filter((entry: { type: string; customType?: string }) => {
				return entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE;
			})
			.pop() as { data?: { enabled?: boolean } } | undefined;

		if (typeof saved?.data?.enabled === "boolean") {
			fastEnabled = saved.data.enabled;
		}

		// Clear any status/footer artifacts from older versions. The quota footer
		// owns footer rendering and listens for STATE_EVENT to show "fast" inline.
		ctx.ui.setStatus("codex-fast", undefined);
		publish(pi);
	});

	pi.registerCommand("fast", {
		description: "Toggle OpenAI Codex Fast mode (/fast, /fast on, /fast off, /fast status)",
		getArgumentCompletions: (prefix) => {
			const options = ["on", "off", "status", "toggle"];
			return options
				.filter((option) => option.startsWith(prefix.trim().toLowerCase()))
				.map((option) => ({ value: option, label: option }));
		},
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();

			if (arg === "" || arg === "toggle") {
				fastEnabled = !fastEnabled;
			} else if (arg === "on" || arg === "enable" || arg === "enabled") {
				fastEnabled = true;
			} else if (arg === "off" || arg === "disable" || arg === "disabled") {
				fastEnabled = false;
			} else if (arg !== "status") {
				ctx.ui.notify("Usage: /fast, /fast on, /fast off, or /fast status", "warning");
				return;
			}

			if (arg !== "status") {
				persist(pi);
				publish(pi);
			}

			const appliesNow = fastAppliesTo(ctx.model);
			const suffix = fastEnabled
				? appliesNow
					? " Applies to the current model."
					: " Applies when using openai-codex/gpt-5.5 or openai-codex/gpt-5.4."
				: "";
			ctx.ui.notify(`Codex Fast mode is ${fastEnabled ? "on" : "off"}.${suffix}`, "info");
		},
	});

	pi.registerProvider("openai-codex", {
		api: "openai-codex-responses",

		streamSimple(model: Model<any>, context: Context, options?: SimpleStreamOptions) {
			const clampedReasoning = options?.reasoning
				? clampThinkingLevel(model, options.reasoning)
				: undefined;
			const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

			const serviceTier = fastEnabled && fastAppliesTo(model) ? "priority" : undefined;

			return streamOpenAICodexResponses(model as any, context, {
				...options,
				reasoningEffort,
				...(serviceTier ? { serviceTier } : {}),
			});
		},
	});
}
