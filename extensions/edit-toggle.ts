import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface EditToggleState {
	editsEnabled: boolean;
	previousActiveTools?: string[];
}

const STATE_ENTRY = "edit-toggle-state";
const STATUS_KEY = "edit-toggle";
const MUTATING_TOOLS = new Set(["bash", "edit", "write"]);

export default function editToggleExtension(pi: ExtensionAPI) {
	let editsEnabled = true;
	let previousActiveTools: string[] | undefined;

	function allToolNames(): Set<string> {
		return new Set(pi.getAllTools().map((tool) => tool.name));
	}

	function validTools(names: string[]): string[] {
		const all = allToolNames();
		return [...new Set(names)].filter((name) => all.has(name));
	}

	function safeTools(names: string[]): string[] {
		return validTools(names).filter((name) => !MUTATING_TOOLS.has(name));
	}

	function persist() {
		pi.appendEntry<EditToggleState>(STATE_ENTRY, {
			editsEnabled,
			previousActiveTools,
		});
	}

	function updateStatus(ctx?: ExtensionContext) {
		if (!ctx) return;
		ctx.ui.setStatus(STATUS_KEY, editsEnabled ? ctx.ui.theme.fg("success", "Edits: ON") : ctx.ui.theme.fg("warning", "Edits: OFF"));
	}

	function disableEdits(ctx?: ExtensionContext, shouldPersist = true) {
		if (editsEnabled) {
			previousActiveTools = pi.getActiveTools();
		}
		editsEnabled = false;
		pi.setActiveTools(safeTools(previousActiveTools ?? pi.getActiveTools()));
		updateStatus(ctx);
		if (shouldPersist) persist();
	}

	function enableEdits(ctx?: ExtensionContext, shouldPersist = true) {
		editsEnabled = true;
		const current = pi.getActiveTools();
		const restoreMutating = (previousActiveTools ?? [])
			.filter((name) => MUTATING_TOOLS.has(name));
		pi.setActiveTools(validTools([...current, ...restoreMutating]));
		updateStatus(ctx);
		if (shouldPersist) persist();
	}

	function restoreFromBranch(ctx: ExtensionContext) {
		let saved: EditToggleState | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE_ENTRY) {
				saved = entry.data as EditToggleState | undefined;
			}
		}

		if (saved) {
			editsEnabled = saved.editsEnabled;
			previousActiveTools = saved.previousActiveTools;
			if (editsEnabled) enableEdits(ctx, false);
			else disableEdits(ctx, false);
		} else {
			// Default to safe/read-only mode for new sessions or sessions without saved state.
			// Remember only the current active set so `/edits on` does not resurrect
			// tools that another extension intentionally disabled.
			previousActiveTools = pi.getActiveTools();
			editsEnabled = false;
			pi.setActiveTools(safeTools(previousActiveTools));
			updateStatus(ctx);
		}
	}

	pi.registerCommand("edits", {
		description: "Toggle edit/write/bash tools on or off. Usage: /edits [on|off|status]",
		handler: async (args, ctx) => {
			const mode = args.trim().toLowerCase();

			if (["on", "enable", "enabled", "yes"].includes(mode)) {
				enableEdits(ctx);
				ctx.ui.notify("Edits enabled", "info");
				return;
			}

			if (["off", "disable", "disabled", "no"].includes(mode)) {
				disableEdits(ctx);
				ctx.ui.notify("Edits disabled. Mutating tools are unavailable until /edits on.", "warning");
				return;
			}

			if (["status", "state", "?"].includes(mode)) {
				ctx.ui.notify(`Edits are ${editsEnabled ? "enabled" : "disabled"}`, editsEnabled ? "info" : "warning");
				return;
			}

			if (editsEnabled) {
				disableEdits(ctx);
				ctx.ui.notify("Edits disabled. Mutating tools are unavailable until /edits on.", "warning");
			} else {
				enableEdits(ctx);
				ctx.ui.notify("Edits enabled", "info");
			}
		},
	});

	pi.on("before_agent_start", (event) => {
		if (editsEnabled) return;
		return {
			systemPrompt:
				event.systemPrompt +
				"\n\nEdit mode is currently disabled by the user. Do not modify files, run shell commands, or perform any tool action that could change local state. Answer conversationally unless the user runs /edits on.",
		};
	});

	pi.on("tool_call", (event) => {
		if (editsEnabled) return;
		if (MUTATING_TOOLS.has(event.toolName)) {
			return { block: true, reason: "Edits are disabled. Run /edits on to re-enable mutating tools." };
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});
}
