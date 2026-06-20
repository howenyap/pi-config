import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

type Mode = "insert" | "normal";
type PendingOperator = "d" | "g" | "y" | "r";

interface YankBuffer {
	text: string;
	linewise: boolean;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function isPrintable(data: string): boolean {
	return data.length === 1 && data.charCodeAt(0) >= 32;
}

function charKind(char: string): "space" | "word" | "punct" {
	if (/\s/.test(char)) return "space";
	if (/[\p{L}\p{N}_]/u.test(char)) return "word";
	return "punct";
}

class VimInputEditor extends CustomEditor {
	private mode: Mode = "insert";
	private pending?: PendingOperator;
	private countBuffer = "";
	private pendingCount = 1;
	private yankBuffer?: YankBuffer;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: any,
		private readonly onModeChange?: (mode: Mode) => void,
	) {
		super(tui, theme, keybindings);
		this.onModeChange?.(this.mode);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.handleEscape();
			return;
		}

		if (this.mode === "insert") {
			super.handleInput(data);
			return;
		}

		this.handleNormalInput(data);
	}


	private handleEscape(): void {
		if (this.mode === "insert") {
			// In vim, leaving insert mode places the cursor on the previous character.
			const { col } = this.getCursor();
			if (col > 0) super.handleInput("\x1b[D");
			this.setMode("normal");
			this.clearPending();
			this.requestRender();
			return;
		}

		if (this.pending || this.countBuffer) {
			this.clearPending();
			this.requestRender();
			return;
		}

		// Preserve pi's normal Escape behavior in normal mode (interrupt/abort).
		super.handleInput("\x1b");
	}

	private handleNormalInput(data: string): void {
		// Let app-level and editor-level controls through.
		if (!isPrintable(data)) {
			super.handleInput(data);
			return;
		}

		if (this.pending) {
			this.handlePending(data);
			return;
		}

		if (/^[1-9]$/.test(data) || (this.countBuffer && data === "0")) {
			this.countBuffer += data;
			this.requestRender();
			return;
		}

		const count = this.takeCount();

		switch (data) {
			case "i":
				this.enterInsert();
				return;
			case "I":
				this.vimMoveToLineStart();
				this.enterInsert();
				return;
			case "a":
				this.moveRight(1);
				this.enterInsert();
				return;
			case "A":
				this.vimMoveToLineEnd();
				this.enterInsert();
				return;
			case "o":
				this.openLineBelow();
				return;
			case "O":
				this.openLineAbove();
				return;
			case "h":
				this.moveLeft(count);
				return;
			case "j":
				this.repeatKey("\x1b[B", count);
				return;
			case "k":
				this.repeatKey("\x1b[A", count);
				return;
			case "l":
				this.moveRight(count);
				return;
			case "w":
				this.repeatPrivate("moveWordForwards", count);
				return;
			case "b":
				this.repeatPrivate("moveWordBackwards", count);
				return;
			case "e":
				this.moveToWordEnd(count);
				return;
			case "0":
				this.vimMoveToLineStart();
				return;
			case "^":
				this.moveToFirstNonBlank();
				return;
			case "$":
				this.vimMoveToLineEnd();
				return;
			case "G":
				this.goToBottom();
				return;
			case "g":
			case "d":
			case "y":
			case "r":
				this.pending = data;
				this.pendingCount = count;
				this.requestRender();
				return;
			case "x":
				this.deleteChars(count);
				return;
			case "X":
				this.repeatKey("\x7f", count);
				return;
			case "D":
				this.deleteToLineEnd();
				return;
			case "C":
				this.deleteToLineEnd();
				this.enterInsert();
				return;
			case "u":
				this.repeatPrivate("undo", count);
				return;
			case "p":
				this.pasteAfter();
				return;
			case "P":
				this.pasteBefore();
				return;
		}

		// Ignore unhandled printable keys in normal mode, like vim does.
	}

	private handlePending(data: string): void {
		const operator = this.pending;
		const count = this.pendingCount;
		this.clearPending();

		if (operator === "g") {
			if (data === "g") this.goToTop();
			return;
		}

		if (operator === "d") {
			if (data === "d") this.deleteLines(count);
			else if (data === "$") this.deleteToLineEnd();
			else if (data === "w") this.deleteWordsForward(count);
			return;
		}

		if (operator === "y") {
			if (data === "y") this.yankLines(count);
			return;
		}

		if (operator === "r") {
			if (isPrintable(data)) this.replaceChars(count, data);
			return;
		}
	}

	private enterInsert(): void {
		this.setMode("insert");
		this.clearPending();
		this.requestRender();
	}

	private setMode(mode: Mode): void {
		if (this.mode === mode) return;
		this.mode = mode;
		this.onModeChange?.(this.mode);
	}

	private clearPending(): void {
		this.pending = undefined;
		this.pendingCount = 1;
		this.countBuffer = "";
	}

	private takeCount(): number {
		const count = this.countBuffer ? Number.parseInt(this.countBuffer, 10) : 1;
		this.countBuffer = "";
		return Number.isFinite(count) && count > 0 ? count : 1;
	}

	private requestRender(): void {
		this.tui.requestRender();
	}

	private repeatKey(key: string, count: number): void {
		for (let i = 0; i < count; i++) super.handleInput(key);
		this.requestRender();
	}

	private repeatPrivate(methodName: string, count: number): void {
		const self = this as unknown as Record<string, () => void>;
		const method = self[methodName];
		if (typeof method !== "function") return;
		for (let i = 0; i < count; i++) method.call(this);
		this.requestRender();
	}

	private moveLeft(count: number): void {
		this.repeatKey("\x1b[D", count);
	}

	private moveRight(count: number): void {
		this.repeatKey("\x1b[C", count);
	}

	private vimMoveToLineStart(): void {
		// Do not name this moveToLineStart: Editor.handleInput() dispatches
		// to this.moveToLineStart(), so overriding it causes recursion.
		super.handleInput("\x01");
		this.requestRender();
	}

	private vimMoveToLineEnd(): void {
		// Do not name this moveToLineEnd for the same reason as above.
		super.handleInput("\x05");
		this.requestRender();
	}

	private deleteToLineEnd(): void {
		super.handleInput("\x0b");
		this.requestRender();
	}

	private moveToFirstNonBlank(): void {
		const lines = this.getLines();
		const { line } = this.getCursor();
		const text = lines[line] ?? "";
		this.setCursor(line, text.search(/\S|$/));
	}

	private goToTop(): void {
		this.setCursor(0, 0);
	}

	private goToBottom(): void {
		const lines = this.getLines();
		const line = Math.max(0, lines.length - 1);
		this.setCursor(line, (lines[line] ?? "").length);
	}

	private moveToWordEnd(count: number): void {
		for (let i = 0; i < count; i++) {
			this.repeatPrivate("moveWordForwards", 1);
			this.repeatKey("\x1b[D", 1);
		}
	}

	private openLineBelow(): void {
		const lines = this.getLines();
		const { line } = this.getCursor();
		const next = [...lines.slice(0, line + 1), "", ...lines.slice(line + 1)];
		this.replaceState(next, line + 1, 0);
		this.enterInsert();
	}

	private openLineAbove(): void {
		const lines = this.getLines();
		const { line } = this.getCursor();
		const next = [...lines.slice(0, line), "", ...lines.slice(line)];
		this.replaceState(next, line, 0);
		this.enterInsert();
	}

	private deleteChars(count: number): void {
		const lines = this.getLines();
		const { line, col } = this.getCursor();
		const text = lines[line] ?? "";
		if (col >= text.length) return;
		this.yankBuffer = { text: text.slice(col, col + count), linewise: false };
		this.repeatKey("\x1b[3~", count);
	}

	private replaceChars(count: number, replacement: string): void {
		const lines = this.getLines();
		const { line, col } = this.getCursor();
		const text = lines[line] ?? "";
		if (col >= text.length) return;

		const deleteCount = Math.min(count, text.length - col);
		const nextLine = text.slice(0, col) + replacement.repeat(deleteCount) + text.slice(col + deleteCount);
		const nextLines = [...lines];
		nextLines[line] = nextLine;
		this.replaceState(nextLines, line, col);
	}

	private deleteWordsForward(count: number): void {
		const lines = this.getLines();
		const start = this.getCursor();
		let end = { ...start };

		for (let i = 0; i < count; i++) {
			end = this.findNextWordStart(lines, end.line, end.col);
		}

		if (end.line === start.line && end.col === start.col) return;

		let deleted: string;
		let nextLines: string[];

		if (end.line === start.line) {
			const text = lines[start.line] ?? "";
			deleted = text.slice(start.col, end.col);
			nextLines = [...lines];
			nextLines[start.line] = text.slice(0, start.col) + text.slice(end.col);
		} else {
			const first = lines[start.line] ?? "";
			const last = lines[end.line] ?? "";
			deleted = [first.slice(start.col), ...lines.slice(start.line + 1, end.line), last.slice(0, end.col)].join("\n");
			nextLines = [
				...lines.slice(0, start.line),
				first.slice(0, start.col) + last.slice(end.col),
				...lines.slice(end.line + 1),
			];
		}

		this.yankBuffer = { text: deleted, linewise: false };
		this.replaceState(nextLines.length ? nextLines : [""], start.line, start.col);
	}

	private findNextWordStart(lines: string[], line: number, col: number): { line: number; col: number } {
		let currentLine = clamp(line, 0, Math.max(0, lines.length - 1));
		let currentCol = clamp(col, 0, (lines[currentLine] ?? "").length);
		const text = lines[currentLine] ?? "";

		// At EOL, move across the newline to the next line when possible.
		if (currentCol >= text.length) {
			if (currentLine < lines.length - 1) return { line: currentLine + 1, col: 0 };
			return { line: currentLine, col: currentCol };
		}

		const kind = charKind(text[currentCol]!);

		if (kind === "space") {
			while (currentCol < text.length && charKind(text[currentCol]!) === "space") currentCol++;
			return { line: currentLine, col: currentCol };
		}

		while (currentCol < text.length && charKind(text[currentCol]!) === kind) currentCol++;
		while (currentCol < text.length && charKind(text[currentCol]!) === "space") currentCol++;

		// If the word plus trailing whitespace reaches EOL, include the newline,
		// matching the practical expectation for `dw` before a next line.
		if (currentCol >= text.length && currentLine < lines.length - 1) {
			return { line: currentLine + 1, col: 0 };
		}

		return { line: currentLine, col: currentCol };
	}

	private deleteLines(count: number): void {
		const lines = this.getLines();
		const { line } = this.getCursor();
		if (lines.length === 0) return;

		const end = Math.min(lines.length, line + count);
		const deleted = lines.slice(line, end);
		const next = [...lines.slice(0, line), ...lines.slice(end)];
		this.yankBuffer = { text: deleted.join("\n") + "\n", linewise: true };
		this.replaceState(next.length ? next : [""], Math.min(line, Math.max(0, next.length - 1)), 0);
	}

	private yankLines(count: number): void {
		const lines = this.getLines();
		const { line } = this.getCursor();
		const yanked = lines.slice(line, Math.min(lines.length, line + count));
		this.yankBuffer = { text: yanked.join("\n") + "\n", linewise: true };
		this.requestRender();
	}

	private pasteAfter(): void {
		this.paste(true);
	}

	private pasteBefore(): void {
		this.paste(false);
	}

	private paste(after: boolean): void {
		if (!this.yankBuffer) return;
		if (!this.yankBuffer.linewise) {
			if (after) this.moveRight(1);
			this.insertTextAtCursor(this.yankBuffer.text);
			this.requestRender();
			return;
		}

		const lines = this.getLines();
		const { line } = this.getCursor();
		const insertAt = after ? line + 1 : line;
		const pasteLines = this.yankBuffer.text.replace(/\n$/, "").split("\n");
		const next = [...lines.slice(0, insertAt), ...pasteLines, ...lines.slice(insertAt)];
		this.replaceState(next, insertAt, 0);
	}

	private setCursor(line: number, col: number): void {
		const self = this as unknown as { state: { lines: string[]; cursorLine: number; cursorCol: number }; setCursorCol?: (col: number) => void };
		const lines = this.getLines();
		const nextLine = clamp(line, 0, Math.max(0, lines.length - 1));
		const nextCol = clamp(col, 0, (lines[nextLine] ?? "").length);
		self.state.cursorLine = nextLine;
		if (typeof self.setCursorCol === "function") self.setCursorCol.call(this, nextCol);
		else self.state.cursorCol = nextCol;
		this.requestRender();
	}

	private replaceState(lines: string[], cursorLine: number, cursorCol: number): void {
		const self = this as unknown as {
			state: { lines: string[]; cursorLine: number; cursorCol: number };
			pushUndoSnapshot?: () => void;
			cancelAutocomplete?: () => void;
			exitHistoryBrowsing?: () => void;
			setCursorCol?: (col: number) => void;
			lastAction?: string | null;
			preferredVisualCol?: number | null;
			snappedFromCursorCol?: number | null;
		};

		self.cancelAutocomplete?.call(this);
		self.exitHistoryBrowsing?.call(this);
		self.pushUndoSnapshot?.call(this);
		self.lastAction = null;
		self.preferredVisualCol = null;
		self.snappedFromCursorCol = null;

		self.state.lines = lines.length ? lines : [""];
		self.state.cursorLine = clamp(cursorLine, 0, Math.max(0, self.state.lines.length - 1));
		const maxCol = (self.state.lines[self.state.cursorLine] ?? "").length;
		if (typeof self.setCursorCol === "function") self.setCursorCol.call(this, clamp(cursorCol, 0, maxCol));
		else self.state.cursorCol = clamp(cursorCol, 0, maxCol);

		this.onChange?.(this.getText());
		this.requestRender();
	}
}

export default function vimInputExtension(pi: ExtensionAPI) {
	let enabled = true;
	let currentCtx: ExtensionContext | undefined;
	let editorMode: Mode = "insert";
	let overrideMode: Mode | undefined;

	function renderVimStatus(ctx = currentCtx): void {
		if (!ctx || ctx.mode !== "tui") return;
		if (!enabled) {
			ctx.ui.setStatus("vim-input", undefined);
			ctx.ui.setStatus("00-vim-input", undefined);
			return;
		}
		const mode = overrideMode ?? editorMode;
		ctx.ui.setStatus("vim-input", undefined);
		ctx.ui.setStatus("00-vim-input", ctx.ui.theme.fg("text", mode.toUpperCase()));
	}

	function apply(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		currentCtx = ctx;
		if (!enabled) {
			ctx.ui.setEditorComponent(undefined);
			ctx.ui.setStatus("vim-input", undefined);
			ctx.ui.setStatus("00-vim-input", undefined);
			return;
		}

		const setVimStatus = (mode: Mode) => {
			editorMode = mode;
			if (!overrideMode) renderVimStatus(ctx);
		};

		ctx.ui.setEditorComponent((tui, theme, keybindings) => new VimInputEditor(tui, theme, keybindings, setVimStatus));
		editorMode = "insert";
		renderVimStatus(ctx);
	}

	pi.events.on("vim-input:override-mode", (data) => {
		if (data === "insert" || data === "normal") {
			overrideMode = data;
			renderVimStatus();
		}
	});

	pi.events.on("vim-input:clear-override", () => {
		overrideMode = undefined;
		renderVimStatus();
	});

	pi.on("session_start", (_event, ctx) => {
		apply(ctx);
	});

	pi.registerCommand("vim", {
		description: "Toggle vim bindings for the pi input editor. Usage: /vim [on|off|status]",
		handler: async (args, ctx) => {
			const mode = args.trim().toLowerCase();
			if (["off", "disable", "disabled", "false"].includes(mode)) enabled = false;
			else if (["on", "enable", "enabled", "true"].includes(mode)) enabled = true;
			else if (!["", "toggle"].includes(mode)) {
				ctx.ui.notify(`vim input is ${enabled ? "on" : "off"}`, "info");
				return;
			} else if (mode !== "status") {
				enabled = !enabled;
			}

			apply(ctx);
			ctx.ui.notify(`vim input ${enabled ? "enabled" : "disabled"}`, "info");
		},
	});
}
