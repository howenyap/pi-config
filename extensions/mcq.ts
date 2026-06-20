import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Key, decodePrintableKey, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const OTHER_VALUE = "__pi_mcq_other__";

interface McqItem {
	value: string;
	label: string;
	index: number;
	isOther?: boolean;
}

interface McqResult {
	item: McqItem;
	customAnswer?: string;
}

function printableInput(data: string) {
	const decoded = decodePrintableKey(data);
	if (decoded) return decoded;
	return data.length === 1 && data >= " " && data !== "\x7f" ? data : undefined;
}

function findWordStart(value: string, cursor: number) {
	let i = cursor;
	while (i > 0 && /\s/.test(value[i - 1]!)) i--;
	while (i > 0 && !/\s/.test(value[i - 1]!)) i--;
	return i;
}

function findWordEnd(value: string, cursor: number) {
	let i = cursor;
	while (i < value.length && /\s/.test(value[i]!)) i++;
	while (i < value.length && !/\s/.test(value[i]!)) i++;
	return i;
}

export default function mcqExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_mcq",
		label: "Ask MCQ",
		description:
			"Ask the user a multiple-choice question using an interactive selection UI. By default, appends an Other option for custom free-text input.",
		promptSnippet: "Ask the user to choose from multiple-choice options, with an Other free-text fallback.",
		promptGuidelines: [
			"Use ask_mcq when you need the user to choose one option before continuing.",
			"ask_mcq includes an Other option by default so the user can enter custom text when none of the choices fit.",
		],
		parameters: Type.Object({
			question: Type.String({ description: "Question to show the user." }),
			options: Type.Array(Type.String(), {
				minItems: 1,
				description: "Choices to show. Do not include the Other option unless includeOther is false.",
			}),
			includeOther: Type.Optional(
				Type.Boolean({
					default: true,
					description: "Whether to append an Other option that lets the user enter free text.",
				}),
			),
			otherLabel: Type.Optional(
				Type.String({
					default: "Other…",
					description: "Label for the free-text fallback option.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI || ctx.mode !== "tui") {
				return {
					isError: true,
					content: [{ type: "text", text: "ask_mcq requires interactive TUI mode." }],
				};
			}

			const includeOther = params.includeOther ?? true;
			const otherLabel = params.otherLabel ?? "Other…";
			const items: McqItem[] = [
				...params.options.map((label, i) => ({ value: label, label, index: i + 1 })),
				...(includeOther
					? [
							{
								value: OTHER_VALUE,
								label: otherLabel,
								index: params.options.length + 1,
								isOther: true,
							},
						]
					: []),
			];

			const selected = await ctx.ui.custom<McqResult | null>((tui, theme, keybindings, done) => {
				let cursor = 0;
				let otherInput = "";
				let otherCursor = 0;
				let otherInputRequired = false;

				function move(delta: number) {
					cursor = Math.max(0, Math.min(items.length - 1, cursor + delta));
					tui.requestRender();
				}

				function currentItem() {
					return items[cursor] ?? null;
				}

				return {
					handleInput(data: string) {
						if (keybindings.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape)) {
							done(null);
							return;
						}

						const item = currentItem();

						if (keybindings.matches(data, "tui.select.confirm") || keybindings.matches(data, "tui.input.submit")) {
							if (item?.isOther && !otherInput.trim()) {
								otherInputRequired = true;
								tui.requestRender();
								return;
							}
							done(item ? { item, customAnswer: item.isOther ? otherInput.trim() : undefined } : null);
							return;
						}

						if (item?.isOther) {
							if (keybindings.matches(data, "tui.editor.cursorLeft")) {
								otherCursor = Math.max(0, otherCursor - 1);
								tui.requestRender();
								return;
							}

							if (keybindings.matches(data, "tui.editor.cursorRight")) {
								otherCursor = Math.min(otherInput.length, otherCursor + 1);
								tui.requestRender();
								return;
							}

							if (keybindings.matches(data, "tui.editor.cursorWordLeft")) {
								otherCursor = findWordStart(otherInput, otherCursor);
								tui.requestRender();
								return;
							}

							if (keybindings.matches(data, "tui.editor.cursorWordRight")) {
								otherCursor = findWordEnd(otherInput, otherCursor);
								tui.requestRender();
								return;
							}

							if (keybindings.matches(data, "tui.editor.cursorLineStart")) {
								otherCursor = 0;
								tui.requestRender();
								return;
							}

							if (keybindings.matches(data, "tui.editor.cursorLineEnd")) {
								otherCursor = otherInput.length;
								tui.requestRender();
								return;
							}

							if (keybindings.matches(data, "tui.editor.deleteWordBackward")) {
								const start = findWordStart(otherInput, otherCursor);
								otherInput = otherInput.slice(0, start) + otherInput.slice(otherCursor);
								otherCursor = start;
								tui.requestRender();
								return;
							}

							if (keybindings.matches(data, "tui.editor.deleteWordForward")) {
								const end = findWordEnd(otherInput, otherCursor);
								otherInput = otherInput.slice(0, otherCursor) + otherInput.slice(end);
								tui.requestRender();
								return;
							}

							if (keybindings.matches(data, "tui.editor.deleteToLineStart")) {
								otherInput = otherInput.slice(otherCursor);
								otherCursor = 0;
								tui.requestRender();
								return;
							}

							if (keybindings.matches(data, "tui.editor.deleteToLineEnd")) {
								otherInput = otherInput.slice(0, otherCursor);
								tui.requestRender();
								return;
							}

							if (keybindings.matches(data, "tui.editor.deleteCharBackward") || matchesKey(data, Key.ctrl("h"))) {
								if (otherCursor > 0) {
									otherInput = otherInput.slice(0, otherCursor - 1) + otherInput.slice(otherCursor);
									otherCursor--;
								}
								tui.requestRender();
								return;
							}

							if (keybindings.matches(data, "tui.editor.deleteCharForward")) {
								otherInput = otherInput.slice(0, otherCursor) + otherInput.slice(otherCursor + 1);
								tui.requestRender();
								return;
							}

							const printable = printableInput(data);
							if (printable) {
								otherInputRequired = false;
								otherInput = otherInput.slice(0, otherCursor) + printable + otherInput.slice(otherCursor);
								otherCursor += printable.length;
								tui.requestRender();
								return;
							}
						}

						// Arrow keys plus vim-style navigation.
						if (keybindings.matches(data, "tui.select.up") || data === "k") {
							move(-1);
							return;
						}

						if (keybindings.matches(data, "tui.select.down") || data === "j") {
							move(1);
							return;
						}

						// Numeric shortcuts: jump to the item without submitting.
						if (/^[1-9]$/.test(data)) {
							const index = Number(data) - 1;
							if (items[index]) {
								cursor = index;
								tui.requestRender();
							}
						}
					},

					render(width: number) {
						const lines: string[] = [];
						const usableWidth = Math.max(1, width);

						lines.push(...wrapTextWithAnsi(theme.fg("accent", theme.bold(params.question)), usableWidth));
						lines.push("");

						for (let i = 0; i < items.length; i++) {
							const item = items[i]!;
							const selected = i === cursor;
							const prefix = selected ? "› " : "  ";
							let label = item.label;
							if (item.isOther) {
								label = otherInput
									? `${otherInput.slice(0, otherCursor)}${selected ? "▌" : ""}${otherInput.slice(otherCursor)}`
									: "Other (input)";
							}
							const itemPrefix = `${prefix}${item.index}. `;
							const rawLines = wrapTextWithAnsi(label, Math.max(1, usableWidth - itemPrefix.length)).map((line, lineIndex) =>
								lineIndex === 0 ? `${itemPrefix}${line}` : `${" ".repeat(itemPrefix.length)}${line}`,
							);
							for (const rawLine of rawLines) {
								const styled = selected ? theme.bg("selectedBg", theme.fg("accent", rawLine)) : theme.fg("text", rawLine);
								lines.push(truncateToWidth(styled, usableWidth));
							}
						}

						lines.push("");
						const help = currentItem()?.isOther
							? otherInputRequired
								? "type a custom answer before pressing enter"
								: "type custom answer • backspace edit • ctrl-w/opt-del word delete • ctrl-u clear • enter choose • ↑/↓ move • esc cancel"
							: "↑/k up • ↓/j down • 1-9 jump • enter choose • esc cancel";
						lines.push(truncateToWidth(theme.fg("dim", help), usableWidth));
						return lines;
					},

					invalidate() {},
				};
			});

			if (!selected) {
				return {
					isError: true,
					content: [{ type: "text", text: "User cancelled the multiple-choice selection." }],
					details: { cancelled: true },
				};
			}

			let answer = selected.item.value;
			let source: "option" | "other" = "option";

			if (selected.item.value === OTHER_VALUE) {
				if (!selected.customAnswer?.trim()) {
					return {
						isError: true,
						content: [{ type: "text", text: "User selected Other but did not provide a custom answer." }],
						details: { cancelled: true, selected: "other" },
					};
				}
				answer = selected.customAnswer.trim();
				source = "other";
			}

			return {
				content: [{ type: "text", text: answer }],
				details: {
					answer,
					source,
					selectedLabel: selected.item.label,
					selectedIndex: selected.item.index,
				},
			};
		},
	});
}
