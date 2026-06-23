import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Key, decodeKittyPrintable, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const OTHER_VALUE = "__pi_question_other__";

type QuestionMode = "multiple_choice" | "subjective";

interface QuestionItem {
	value: string;
	label: string;
	index: number;
	isOther?: boolean;
}

interface QuestionResult {
	answer: string;
	source: "option" | "other" | "subjective";
	item?: QuestionItem;
}

function printableInput(data: string) {
	const decoded = decodeKittyPrintable(data);
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

function questionParameters(optionsRequired: boolean) {
	return Type.Object({
		question: Type.Optional(Type.String({ description: "Question to show the user." })),
		questions: Type.Optional(
			Type.Array(
				Type.Object({
					question: Type.String({ description: "Question to show the user." }),
					mode: Type.Optional(Type.Union([Type.Literal("multiple_choice"), Type.Literal("subjective")])),
					type: Type.Optional(Type.Union([Type.Literal("multiple_choice"), Type.Literal("subjective")])),
					options: Type.Optional(Type.Array(Type.String())),
					includeOther: Type.Optional(Type.Boolean()),
					otherLabel: Type.Optional(Type.String()),
					placeholder: Type.Optional(Type.String()),
					requireAnswer: Type.Optional(Type.Boolean()),
					correctAnswer: Type.Optional(Type.String()),
					correctIndex: Type.Optional(Type.Number()),
				}),
				{
					description:
						"Optional batch of questions to ask up front. The UI prefixes each question with progress like 1/5, 2/5.",
				},
			),
		),
		mode: Type.Optional(
			Type.Union([Type.Literal("multiple_choice"), Type.Literal("subjective")], {
				default: "multiple_choice",
				description:
					"Question style. Use multiple_choice for selectable options, or subjective for a free-text input box.",
			}),
		),
		type: Type.Optional(
			Type.Union([Type.Literal("multiple_choice"), Type.Literal("subjective")], {
				description: "Alias for mode.",
			}),
		),
		options: optionsRequired
			? Type.Array(Type.String(), {
					minItems: 1,
					description: "Choices to show. Do not include the Other option unless includeOther is false.",
				})
			: Type.Optional(
					Type.Array(Type.String(), {
						description:
							"Choices to show for multiple-choice questions. If omitted or empty, the question is asked as subjective free text.",
					}),
				),
		includeOther: Type.Optional(
			Type.Boolean({
				default: true,
				description: "Whether to append an Other option that lets the user enter free text for multiple-choice questions.",
			}),
		),
		otherLabel: Type.Optional(
			Type.String({
				default: "Other…",
				description: "Label for the multiple-choice free-text fallback option.",
			}),
		),
		placeholder: Type.Optional(
			Type.String({
				default: "Type your answer…",
				description: "Placeholder shown in the free-text input when it is empty.",
			}),
		),
		requireAnswer: Type.Optional(
			Type.Boolean({
				default: true,
				description: "Whether subjective and Other answers must contain non-whitespace text before submitting.",
			}),
		),
		correctAnswer: Type.Optional(
			Type.String({
				description:
					"Optional correct answer. When provided, the result is marked successful only if the user's answer matches it exactly.",
			}),
		),
		correctIndex: Type.Optional(
			Type.Number({
				description:
					"Optional 1-based index of the correct multiple-choice option. Used to derive correctAnswer from options.",
			}),
		),
	});
}

export default function questionsExtension(pi: ExtensionAPI) {
	async function askQuestion(params: any, ctx: any, toolName: string) {
		if (Array.isArray(params.questions) && params.questions.length > 0) {
			const results: any[] = [];
			let anyIncorrect = false;

			for (let i = 0; i < params.questions.length; i++) {
				const question = params.questions[i];
				const result = await askQuestion(
					{
						...params,
						...question,
						questions: undefined,
						question: `${i + 1}/${params.questions.length}: ${question.question}`,
						originalQuestion: question.question,
					},
					ctx,
					toolName,
				);

				if (result.isError && result.details?.cancelled) return result;
				if (result.isError && result.details?.isCorrect !== false) return result;
				if (result.details?.isCorrect === false) anyIncorrect = true;
				results.push(result.details);
			}

			return {
				isError: anyIncorrect,
				content: [
					{
						type: "text",
						text: results
							.map((result) => {
								const lines = [`Question: ${result.originalQuestion ?? result.question}`, `Answer: ${result.answer}`];
								if (result.correctAnswer !== undefined) lines.push(`Correct Answer: ${result.correctAnswer}`);
								return lines.join("\n");
							})
							.join("\n\n"),
					},
				],
				details: {
					questions: results,
					isCorrect: results.every((result) => result.isCorrect !== false),
				},
			};
		}

		if (!ctx.hasUI || ctx.mode !== "tui") {
			return {
				isError: true,
				content: [{ type: "text", text: `${toolName} requires interactive TUI mode.` }],
			};
		}

		if (typeof params.question !== "string" || params.question.length === 0) {
			return {
				isError: true,
				content: [{ type: "text", text: `${toolName} requires question or questions.` }],
			};
		}

		const options = Array.isArray(params.options) ? params.options : [];
		const requestedMode = params.mode ?? params.type;
		const mode: QuestionMode = requestedMode === "subjective" || options.length === 0 ? "subjective" : "multiple_choice";
		const includeOther = params.includeOther ?? true;
		const otherLabel = params.otherLabel ?? "Other…";
		const placeholder = params.placeholder ?? "Type your answer…";
		const requireAnswer = params.requireAnswer ?? true;
		const correctIndex = typeof params.correctIndex === "number" ? params.correctIndex : undefined;
		const correctAnswer =
			typeof params.correctAnswer === "string"
				? params.correctAnswer
				: correctIndex && correctIndex >= 1 && correctIndex <= options.length
					? options[correctIndex - 1]
					: undefined;
		const items: QuestionItem[] =
			mode === "multiple_choice"
				? [
						...options.map((label, i) => ({ value: label, label, index: i + 1 })),
						...(includeOther
							? [
									{
										value: OTHER_VALUE,
										label: otherLabel,
										index: options.length + 1,
										isOther: true,
									},
								]
							: []),
					]
				: [];

			const selected = await ctx.ui.custom<QuestionResult | null>((tui: any, theme: any, keybindings: any, done: any) => {
				let cursor = 0;
				let input = "";
				let inputCursor = 0;
				let inputRequired = false;
				let cancelArmedAt = 0;
				let cancelTimer: ReturnType<typeof setTimeout> | undefined;
				const cancelDebounceMs = 2000;

			function move(delta: number) {
				cursor = Math.max(0, Math.min(items.length - 1, cursor + delta));
				tui.requestRender();
			}

			function currentItem() {
				return items[cursor] ?? null;
			}

				function showInput() {
					return mode === "subjective" || currentItem()?.isOther;
				}

				function clearCancelArmed() {
					cancelArmedAt = 0;
					if (cancelTimer) clearTimeout(cancelTimer);
					cancelTimer = undefined;
				}

				function armCancel() {
					clearCancelArmed();
					cancelArmedAt = Date.now();
					cancelTimer = setTimeout(() => {
						cancelArmedAt = 0;
						cancelTimer = undefined;
						tui.requestRender();
					}, cancelDebounceMs);
				}

				function submit() {
					clearCancelArmed();
					if (mode === "subjective") {
						const answer = input.trim();
						if (requireAnswer && !answer) {
							inputRequired = true;
							tui.requestRender();
							return;
						}
						done({ answer, source: "subjective" });
						return;
					}

					const item = currentItem();
					if (!item) {
						done(null);
						return;
					}

				if (item.isOther) {
					const answer = input.trim();
					if (requireAnswer && !answer) {
						inputRequired = true;
						tui.requestRender();
						return;
					}
					done({ answer, source: "other", item });
					return;
				}

				done({ answer: item.value, source: "option", item });
			}

			function handleTextInput(data: string) {
				if (keybindings.matches(data, "tui.editor.cursorLeft")) {
					inputCursor = Math.max(0, inputCursor - 1);
					tui.requestRender();
					return true;
				}

				if (keybindings.matches(data, "tui.editor.cursorRight")) {
					inputCursor = Math.min(input.length, inputCursor + 1);
					tui.requestRender();
					return true;
				}

				if (keybindings.matches(data, "tui.editor.cursorWordLeft")) {
					inputCursor = findWordStart(input, inputCursor);
					tui.requestRender();
					return true;
				}

				if (keybindings.matches(data, "tui.editor.cursorWordRight")) {
					inputCursor = findWordEnd(input, inputCursor);
					tui.requestRender();
					return true;
				}

				if (keybindings.matches(data, "tui.editor.cursorLineStart")) {
					inputCursor = 0;
					tui.requestRender();
					return true;
				}

				if (keybindings.matches(data, "tui.editor.cursorLineEnd")) {
					inputCursor = input.length;
					tui.requestRender();
					return true;
				}

				if (keybindings.matches(data, "tui.editor.deleteWordBackward")) {
					const start = findWordStart(input, inputCursor);
					input = input.slice(0, start) + input.slice(inputCursor);
					inputCursor = start;
					tui.requestRender();
					return true;
				}

				if (keybindings.matches(data, "tui.editor.deleteWordForward")) {
					const end = findWordEnd(input, inputCursor);
					input = input.slice(0, inputCursor) + input.slice(end);
					tui.requestRender();
					return true;
				}

				if (keybindings.matches(data, "tui.editor.deleteToLineStart")) {
					input = input.slice(inputCursor);
					inputCursor = 0;
					tui.requestRender();
					return true;
				}

				if (keybindings.matches(data, "tui.editor.deleteToLineEnd")) {
					input = input.slice(0, inputCursor);
					tui.requestRender();
					return true;
				}

				if (keybindings.matches(data, "tui.editor.deleteCharBackward") || matchesKey(data, Key.ctrl("h"))) {
					if (inputCursor > 0) {
						input = input.slice(0, inputCursor - 1) + input.slice(inputCursor);
						inputCursor--;
					}
					tui.requestRender();
					return true;
				}

				if (keybindings.matches(data, "tui.editor.deleteCharForward")) {
					input = input.slice(0, inputCursor) + input.slice(inputCursor + 1);
					tui.requestRender();
					return true;
				}

				const printable = printableInput(data);
				if (printable) {
					inputRequired = false;
					input = input.slice(0, inputCursor) + printable + input.slice(inputCursor);
					inputCursor += printable.length;
					tui.requestRender();
					return true;
				}

				return false;
			}

				return {
					handleInput(data: string) {
						if (keybindings.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape)) {
							const now = Date.now();
							if (cancelArmedAt > 0 && now - cancelArmedAt <= cancelDebounceMs) {
								if (cancelTimer) clearTimeout(cancelTimer);
								done(null);
								return;
							}
							armCancel();
							tui.requestRender();
							return;
						}

						clearCancelArmed();

					if (keybindings.matches(data, "tui.select.confirm") || keybindings.matches(data, "tui.input.submit")) {
						submit();
						return;
					}

					if (showInput() && handleTextInput(data)) return;

					if (mode === "multiple_choice") {
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
					}
				},

				render(width: number) {
					const lines: string[] = [];
					const usableWidth = Math.max(1, width);

					lines.push(...wrapTextWithAnsi(theme.fg("accent", theme.bold(params.question)), usableWidth));
					lines.push("");

					if (mode === "subjective") {
						const visibleInput = input
							? `${input.slice(0, inputCursor)}▌${input.slice(inputCursor)}`
							: theme.fg("dim", placeholder);
						const inputLine = `› ${visibleInput}`;
						lines.push(...wrapTextWithAnsi(theme.fg("text", inputLine), usableWidth));
					} else {
						for (let i = 0; i < items.length; i++) {
							const item = items[i]!;
							const selected = i === cursor;
							const prefix = selected ? "› " : "  ";
							let label = item.label;
							if (item.isOther) {
								label = input
									? `${input.slice(0, inputCursor)}${selected ? "▌" : ""}${input.slice(inputCursor)}`
									: selected
										? placeholder
										: item.label;
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
					}

					lines.push("");
					const cancelArmed = cancelArmedAt > 0 && Date.now() - cancelArmedAt <= cancelDebounceMs;
					const help = cancelArmed
						? "press esc again to cancel"
						: inputRequired
							? "type an answer before pressing enter"
							: showInput()
								? "type answer • backspace edit • ctrl-w/opt-del word delete • ctrl-u clear • enter submit • esc esc cancel"
								: "↑/k up • ↓/j down • 1-9 jump • enter choose • esc esc cancel";
					lines.push(truncateToWidth(theme.fg("dim", help), usableWidth));
					return lines;
				},

					invalidate() {},
					dispose() {
						if (cancelTimer) clearTimeout(cancelTimer);
					},
				};
			});

		if (!selected) {
			return {
				isError: true,
				content: [{ type: "text", text: "User cancelled the question." }],
				details: { cancelled: true },
			};
		}

		const isCorrect = correctAnswer === undefined ? undefined : selected.answer === correctAnswer;
		const summaryLines = [`Question: ${params.question}`, `Answer: ${selected.answer}`];
		if (correctAnswer !== undefined) summaryLines.push(`Correct Answer: ${correctAnswer}`);

		return {
			isError: isCorrect === false,
			content: [{ type: "text", text: summaryLines.join("\n") }],
			details: {
				question: params.question,
				originalQuestion: params.originalQuestion,
				answer: selected.answer,
				correctAnswer,
				isCorrect,
				source: selected.source,
				selectedLabel: selected.item?.label,
				selectedIndex: selected.item?.index,
			},
		};
	}

	pi.registerTool({
		name: "ask_question",
		label: "Ask Question",
		description:
			"Ask the user a question in the interactive TUI. Supports multiple-choice selection and subjective free-text answers.",
		promptSnippet: "Ask the user a multiple-choice or subjective free-text question.",
		promptGuidelines: [
			"Use ask_question when you need the user's answer before continuing.",
			"Use mode='subjective' (or type='subjective') for open-ended answers; this shows only a free-text input box.",
			"Use mode='multiple_choice' with options when the user should choose from fixed choices. includeOther defaults to true.",
		],
		parameters: questionParameters(false),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await askQuestion(params, ctx, "ask_question");
			if (result.isError) {
				const text = result.content
					?.map((item: any) => (item?.type === "text" ? item.text : undefined))
					.filter(Boolean)
					.join("\n") || "Question failed.";
				throw new Error(text);
			}
			return result;
		},
	});

}
