import type {
	ExtensionAPI,
	ExtensionCommandContext,
	SessionEntry,
	SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type Focusable,
	type TUI,
} from "@earendil-works/pi-tui";

type Role = "user" | "assistant";
type Mode = "normal" | "input";
type RoleFilter = "all" | Role;

type ContentBlock = {
	type?: string;
	text?: string;
	name?: string;
	arguments?: Record<string, unknown>;
};

type Theme = {
	fg: (name: string, text: string) => string;
	bg: (name: string, text: string) => string;
	bold: (text: string) => string;
};

type TreeNode = {
	entry: SessionEntry;
	children: TreeNode[];
	label?: string;
};

type MessageRow = {
	entry: SessionMessageEntry;
	role: Role;
	depth: number;
	label?: string;
	text: string;
	searchText: string;
	isOnBranch: boolean;
	isLeaf: boolean;
};

type Selection = MessageRow | null;

function isTextContentBlock(part: unknown): part is { type: "text"; text: string } {
	return !!part && typeof part === "object" && (part as ContentBlock).type === "text" && typeof (part as ContentBlock).text === "string";
}

function getTextParts(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	return content.filter(isTextContentBlock).map((part) => part.text);
}

function stripTerminalControls(text: string): string {
	return text
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b[PX^_][\s\S]*?\x1b\\/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b[ -/]*[@-~]/g, "")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}

function getMessageText(entry: SessionMessageEntry): string {
	const message = entry.message as { role?: string; content?: unknown };
	const text = stripTerminalControls(getTextParts(message.content).join("\n"))
		.replace(/\s+/g, " ")
		.trim();

	// Assistant rows represent only visible text output. Tool-call-only assistant
	// messages are omitted by flattenMessageRows().
	return text;
}

function getEditorText(entry: SessionMessageEntry): string {
	const message = entry.message as { content?: unknown };
	return getTextParts(message.content).join("\n").trim();
}

function isMessageEntry(entry: SessionEntry): entry is SessionMessageEntry {
	return entry.type === "message";
}

function getRole(entry: SessionEntry): Role | null {
	if (!isMessageEntry(entry)) return null;
	if (entry.message.role === "user" || entry.message.role === "assistant") return entry.message.role;
	return null;
}

function isPrintable(data: string): boolean {
	return data.length === 1 && data.charCodeAt(0) >= 32 && data.charCodeAt(0) !== 127;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function flattenMessageRows(nodes: TreeNode[], branchIds: Set<string>, leafId: string | null): MessageRow[] {
	const rows: MessageRow[] = [];

	function visit(node: TreeNode): void {
		const role = getRole(node.entry);

		if (role) {
			const entry = node.entry as SessionMessageEntry;
			const text = getMessageText(entry);
			if (role === "assistant" && !text) {
				for (const child of node.children) visit(child);
				return;
			}
			const label = node.label;
			rows.push({
				entry,
				role,
				depth: 0,
				label,
				text: text || "[no text]",
				searchText: [role, entry.id, label ?? "", text].join(" ").toLowerCase(),
				isOnBranch: branchIds.has(entry.id),
				isLeaf: leafId === entry.id,
			});
		}

		for (const child of node.children) visit(child);
	}

	for (const node of nodes) visit(node);
	return rows;
}

function filterRows(rows: MessageRow[], query: string, roleFilter: RoleFilter): MessageRow[] {
	const roleRows = roleFilter === "all" ? rows : rows.filter((row) => row.role === roleFilter);
	const terms = query
		.trim()
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean);
	if (terms.length === 0) return roleRows;
	return roleRows.filter((row) => terms.every((term) => row.searchText.includes(term)));
}

function padToWidth(line: string, width: number): string {
	const visible = visibleWidth(line);
	if (visible >= width) return line;
	return line + " ".repeat(width - visible);
}

function blue(text: string): string {
	return `\x1b[94m${text}\x1b[39m`;
}

function green(text: string): string {
	return `\x1b[92m${text}\x1b[39m`;
}

function white(text: string): string {
	return `\x1b[97m${text}\x1b[39m`;
}

class MessagesTreeComponent implements Component, Focusable {
	private mode: Mode = "normal";
	private query = "";
	private selected = 0;
	private scroll = 0;
	private roleFilter: RoleFilter = "all";
	private filteredRows: MessageRow[];
	private focusedValue = false;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly rows: MessageRow[],
		private readonly done: (selection: Selection) => void,
		private readonly updateStatus: (mode: Mode, roleFilter: RoleFilter, query: string) => void,
	) {
		this.filteredRows = rows;
		const leafIndex = rows.findIndex((row) => row.isLeaf);
		let branchIndex = -1;
		for (let i = rows.length - 1; i >= 0; i--) {
			if (rows[i]?.isOnBranch) {
				branchIndex = i;
				break;
			}
		}
		this.selected = Math.max(0, leafIndex >= 0 ? leafIndex : branchIndex);
		this.updateStatus(this.mode, this.roleFilter, this.query);
	}

	get focused(): boolean {
		return this.focusedValue;
	}

	set focused(value: boolean) {
		this.focusedValue = value;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+c")) {
			this.done(null);
			return;
		}

		if (matchesKey(data, "tab")) {
			this.cycleRoleFilter();
			this.tui.requestRender();
			return;
		}

		if (this.mode === "input") {
			this.handleInputMode(data);
			return;
		}

		this.handleNormalMode(data);
	}

	private handleNormalMode(data: string): void {
		if (matchesKey(data, "escape") || data === "q") {
			this.done(null);
			return;
		}

		if (matchesKey(data, "enter")) {
			this.done(this.filteredRows[this.selected] ?? null);
			return;
		}

		if (matchesKey(data, "up") || data === "k") this.move(-1);
		else if (matchesKey(data, "down") || data === "j") this.move(1);
		else if (matchesKey(data, "left") || matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u")) this.move(-10);
		else if (matchesKey(data, "right") || matchesKey(data, "pageDown") || matchesKey(data, "ctrl+d")) this.move(10);
		else if (data === "g") this.moveTo(0);
		else if (data === "G") this.moveTo(this.filteredRows.length - 1);
		else if (data === "/" || data === "i" || data === "s") this.setMode("input");
		else return;

		this.tui.requestRender();
	}

	private handleInputMode(data: string): void {
		if (matchesKey(data, "escape")) {
			this.setMode("normal");
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "enter")) {
			this.done(this.filteredRows[this.selected] ?? null);
			return;
		}

		if (matchesKey(data, "up")) this.move(-1);
		else if (matchesKey(data, "down")) this.move(1);
		else if (matchesKey(data, "backspace")) this.setQuery(this.query.slice(0, -1));
		else if (matchesKey(data, "delete")) this.setQuery("");
		else if (matchesKey(data, "ctrl+u")) this.setQuery("");
		else if (isPrintable(data)) this.setQuery(this.query + data);
		else return;

		this.tui.requestRender();
	}

	private setMode(mode: Mode): void {
		this.mode = mode;
		this.updateStatus(this.mode, this.roleFilter, this.query);
	}

	private setQuery(query: string): void {
		const previousId = this.filteredRows[this.selected]?.entry.id;
		this.query = query;
		this.applyFilters(previousId);
	}

	private cycleRoleFilter(): void {
		const previousId = this.filteredRows[this.selected]?.entry.id;
		this.roleFilter = this.roleFilter === "all" ? "user" : this.roleFilter === "user" ? "assistant" : "all";
		this.applyFilters(previousId);
	}

	private applyFilters(previousId?: string): void {
		this.filteredRows = filterRows(this.rows, this.query, this.roleFilter);
		const sameIndex = previousId ? this.filteredRows.findIndex((row) => row.entry.id === previousId) : -1;
		this.selected = sameIndex >= 0 ? sameIndex : clamp(this.selected, 0, Math.max(0, this.filteredRows.length - 1));
		this.scroll = clamp(this.scroll, 0, this.selected);
		this.updateStatus(this.mode, this.roleFilter, this.query);
	}

	private move(delta: number): void {
		this.moveTo(this.selected + delta);
	}

	private moveTo(index: number): void {
		if (this.filteredRows.length === 0) {
			this.selected = 0;
			this.scroll = 0;
			return;
		}
		this.selected = clamp(index, 0, this.filteredRows.length - 1);
	}

	private ensureSelectedVisible(maxRows: number): void {
		if (this.selected < this.scroll) this.scroll = this.selected;
		if (this.selected >= this.scroll + maxRows) this.scroll = this.selected - maxRows + 1;
		this.scroll = clamp(this.scroll, 0, Math.max(0, this.filteredRows.length - maxRows));
	}

	invalidate(): void {}

	render(width: number): string[] {
		const safeWidth = Math.max(20, width);
		const maxRows = Math.max(3, Math.min(this.tui.terminal.rows - 5, 30));
		this.ensureSelectedVisible(maxRows);

		const lines: string[] = [];
		const border = new DynamicBorder((s: string) => this.theme.fg("accent", s));
		lines.push(...border.render(safeWidth));
		const viewLabel = this.roleFilter === "all" ? "ALL" : this.roleFilter === "user" ? "USER" : "ASSISTANT";
		const filterLabel = this.roleFilter === "all" ? white(viewLabel) : this.roleFilter === "user" ? blue(viewLabel) : green(viewLabel);
		const searchLabel = this.query ? this.theme.fg("dim", `  /${this.query}`) : "";
		lines.push(truncateToWidth(this.theme.fg("accent", this.theme.bold("Messages")) + "  " + filterLabel + searchLabel, safeWidth));

		if (this.filteredRows.length === 0) {
			lines.push(this.theme.fg("warning", "No matching user or assistant messages."));
		} else {
			const end = Math.min(this.filteredRows.length, this.scroll + maxRows);
			for (let i = this.scroll; i < end; i++) {
				const row = this.filteredRows[i]!;
				lines.push(this.renderRow(row, i, safeWidth));
			}
		}

		const position = this.filteredRows.length === 0 ? "0/0" : `${this.selected + 1}/${this.filteredRows.length}`;
		const total = this.query || this.roleFilter !== "all" ? ` (${this.rows.length} total)` : "";
		lines.push(this.theme.fg("dim", `${position}${total} • tab filter • normal: j/k ↑/↓ move, / or i search, enter select, esc/q cancel • insert: type filter, esc normal`));
		lines.push(...border.render(safeWidth));
		return lines.map((line) => truncateToWidth(line, safeWidth));
	}

	private renderRow(row: MessageRow, index: number, width: number): string {
		const selected = index === this.selected;
		const selector = selected ? ">" : " ";
		const branch = row.isLeaf ? "◆" : row.isOnBranch ? "●" : "○";
		const role = row.role === "user" ? blue("user") : green("assistant");
		const label = row.label ? this.theme.fg("accent", ` #${row.label}`) : "";
		const id = this.theme.fg("dim", row.entry.id);
		const prefix = `${selector} ${branch} ${role} ${id}${label}: `;
		const contentWidth = Math.max(10, width - visibleWidth(prefix));
		const preview = row.role === "user" ? white(truncateToWidth(row.text, contentWidth)) : this.theme.fg("muted", truncateToWidth(row.text, contentWidth));
		let line = prefix + preview;
		line = truncateToWidth(line, width, "", true);
		return selected ? this.theme.bg("selectedBg", padToWidth(line, width)) : line;
	}
}

async function resetToRoot(ctx: ExtensionCommandContext): Promise<boolean> {
	const sessionManager = ctx.sessionManager as unknown as { resetLeaf?: () => void };
	if (typeof sessionManager.resetLeaf !== "function") return false;
	sessionManager.resetLeaf();
	return true;
}

async function navigateToSelection(selection: MessageRow, ctx: ExtensionCommandContext): Promise<void> {
	if (selection.role === "user") {
		const editorText = getEditorText(selection.entry);
		if (selection.entry.parentId) {
			const result = await ctx.navigateTree(selection.entry.parentId, { summarize: false });
			if (result.cancelled) return;
		} else {
			const ok = await resetToRoot(ctx);
			if (!ok) {
				ctx.ui.notify("Could not reset to the root before the first message", "warning");
				return;
			}
		}
		ctx.ui.setEditorText(editorText);
		ctx.ui.notify("Selected user message; edit and submit to branch", "info");
		return;
	}

	const result = await ctx.navigateTree(selection.entry.id, { summarize: false });
	if (!result.cancelled) {
		ctx.ui.setEditorText("");
		ctx.ui.notify("Moved to assistant message", "info");
	}
}

export default function messagesExtension(pi: ExtensionAPI) {
	pi.registerCommand("messages", {
		description: "Navigate the session tree showing only user and assistant messages",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();

			if (ctx.mode !== "tui") {
				if (ctx.hasUI) ctx.ui.notify("/messages requires the interactive TUI", "warning");
				return;
			}

			const branchIds = new Set(ctx.sessionManager.getBranch().map((entry) => entry.id));
			const rows = flattenMessageRows(ctx.sessionManager.getTree() as TreeNode[], branchIds, ctx.sessionManager.getLeafId());
			if (rows.length === 0) {
				ctx.ui.notify("No user or assistant messages in this session", "warning");
				return;
			}

			const updateStatus = (mode: Mode, _roleFilter: RoleFilter, _query: string) => {
				pi.events.emit("vim-input:override-mode", mode === "input" ? "insert" : "normal");
			};

			let selection: Selection;
			try {
				selection = await ctx.ui.custom<Selection>((tui, theme, _keybindings, done) => {
					return new MessagesTreeComponent(tui, theme as unknown as Theme, rows, done, updateStatus);
				});
			} finally {
				pi.events.emit("vim-input:clear-override", undefined);
			}

			if (!selection) return;
			await navigateToSelection(selection, ctx);
		},
	});
}
