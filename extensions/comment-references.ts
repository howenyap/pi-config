import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";

const WIDGET_KEY = "terminal-comment-references";
const MAX_SELECTION_CHARS = 20_000;

function truncate(value: string, max: number): string {
	if (value.length <= max) return value;
	return value.slice(0, max) + `\n\n[truncated ${value.length - max} chars]`;
}

function tryCommand(command: string, args: string[]): string | undefined {
	try {
		return execFileSync(command, args, {
			encoding: "utf8",
			timeout: 500,
			maxBuffer: MAX_SELECTION_CHARS * 4,
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return undefined;
	}
}

function readClipboardText(): string | undefined {
	const platform = process.platform;
	const candidates: Array<[string, string[]]> = [];

	if (process.env.TERMUX_VERSION) candidates.push(["termux-clipboard-get", []]);
	if (platform === "darwin") candidates.push(["pbpaste", []]);
	else if (platform === "win32") candidates.push(["powershell.exe", ["-NoProfile", "-Command", "Get-Clipboard -Raw"]]);
	else {
		if (process.env.WAYLAND_DISPLAY) candidates.push(["wl-paste", ["--no-newline"]]);
		if (process.env.DISPLAY) {
			candidates.push(["xclip", ["-selection", "clipboard", "-o"]]);
			candidates.push(["xsel", ["--clipboard", "--output"]]);
		}
	}

	for (const [command, args] of candidates) {
		const text = tryCommand(command, args);
		if (text !== undefined) return text;
	}
	return undefined;
}

function getLeadingPrintableInput(data: string): { firstChar: string; rest: string } | undefined {
	const firstChar = Array.from(data)[0];
	if (!firstChar) return undefined;

	const code = firstChar.codePointAt(0);
	if (code === undefined || code < 32 || code === 127) return undefined;
	if (/\p{C}/u.test(firstChar)) return undefined;

	return { firstChar, rest: data.slice(firstChar.length) };
}

function makeReferenceBlock(id: number, selection: string, firstTypedChar: string): string {
	return [
		`Terminal comment #${id}`,
		"Selected terminal output:",
		"```text",
		truncate(selection.trim(), MAX_SELECTION_CHARS),
		"```",
		"",
		`Comment: ${firstTypedChar}`,
	].join("\n");
}

export default function commentReferencesExtension(pi: ExtensionAPI) {
	let insertedCount = 0;
	let enabled = true;
	let unsubscribeTerminalInput: (() => void) | undefined;

	function refreshStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(WIDGET_KEY, enabled ? ctx.ui.theme.fg("accent", "Comments: ON") : undefined);
	}

	function refreshWidget(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	}

	function install(ctx: ExtensionContext) {
		if (ctx.mode !== "tui") return;
		unsubscribeTerminalInput?.();
		refreshStatus(ctx);
		refreshWidget(ctx);

		unsubscribeTerminalInput = ctx.ui.onTerminalInput((data) => {
			if (!enabled || !ctx.isIdle()) return undefined;

			const typed = getLeadingPrintableInput(data);
			if (!typed) return undefined;

			const clipboard = readClipboardText()?.trim();
			if (!clipboard) return undefined;

			const current = ctx.ui.getEditorText();
			const selectedText = truncate(clipboard, MAX_SELECTION_CHARS);
			if (current.includes(selectedText)) return undefined;

			insertedCount += 1;

			const block = makeReferenceBlock(insertedCount, clipboard, typed.firstChar);
			const next = current.trim().length > 0 ? `${block}\n\n${current}` : block;
			ctx.ui.setEditorText(next);
			ctx.ui.notify(`Inserted terminal comment #${insertedCount}`, "info");

			// We already inserted the leading typed character after `Comment:`. If the
			// terminal batched more printable input with it, pass the remainder through
			// instead of dropping it; this fixes intermittent misses from input batching.
			return typed.rest ? { data: typed.rest } : { consume: true };
		});
	}

	pi.on("session_start", async (_event, ctx) => install(ctx));
	pi.on("session_tree", async (_event, ctx) => install(ctx));
	pi.on("session_shutdown", async () => {
		unsubscribeTerminalInput?.();
		unsubscribeTerminalInput = undefined;
	});

	pi.registerCommand("comments", {
		description: "Toggle terminal selection comments. Usage: /comments [on|off|toggle|status]",
		handler: async (args, ctx) => {
			const mode = args.trim().toLowerCase();
			if (["off", "disable", "disabled", "false"].includes(mode)) enabled = false;
			else if (["on", "enable", "enabled", "true"].includes(mode)) enabled = true;
			else if (["status", "state", "?"].includes(mode)) {
				ctx.ui.notify(`Comments are ${enabled ? "ON" : "OFF"}`, "info");
				return;
			} else if (["", "toggle"].includes(mode)) enabled = !enabled;

			refreshStatus(ctx);
			refreshWidget(ctx);
			ctx.ui.notify(`Comments ${enabled ? "enabled" : "disabled"}`, "info");
		},
	});
}
