import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Image, Text } from "@earendil-works/pi-tui";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CUSTOM_TYPE = "mermaid-renderer";
const MAX_DIAGRAMS_PER_MESSAGE = 5;
const RENDER_TIMEOUT_MS = 30_000;

type TextBlock = { type?: string; text?: string };

type MermaidDiagram = {
	index: number;
	hash: string;
	pngPath: string;
	sourcePath: string;
	code: string;
};

type MermaidRenderDetails = {
	diagrams: MermaidDiagram[];
	sourceMessageHash: string;
};

function extensionDir(): string {
	return path.dirname(fileURLToPath(import.meta.url));
}

function cacheDir(): string {
	const dir = path.join(process.env.PI_CODING_AGENT_DIR ?? path.join(process.env.HOME ?? tmpdir(), ".pi", "agent"), "mermaid-renderer");
	mkdirSync(dir, { recursive: true });
	return dir;
}

function localMmdcPath(): string {
	const bin = process.platform === "win32" ? "mmdc.cmd" : "mmdc";
	return path.join(extensionDir(), "node_modules", ".bin", bin);
}

function mmdcCommand(): string {
	const local = localMmdcPath();
	return existsSync(local) ? local : "mmdc";
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	const parts: string[] = [];
	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		const block = item as TextBlock;
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n");
}

function extractMermaidBlocks(text: string): string[] {
	const blocks: string[] = [];
	const re = /```(?:mermaid|mmd)\s*\n([\s\S]*?)```/gi;
	let match: RegExpExecArray | null;
	while ((match = re.exec(text)) !== null) {
		const code = match[1]?.trim();
		if (code) blocks.push(code);
	}
	return blocks;
}

async function renderMermaid(code: string, index: number): Promise<MermaidDiagram> {
	const hash = sha256(code).slice(0, 16);
	const dir = cacheDir();
	const sourcePath = path.join(dir, `${hash}.mmd`);
	const pngPath = path.join(dir, `${hash}.png`);

	writeFileSync(sourcePath, code, "utf8");
	if (!existsSync(pngPath)) {
		await execFileAsync(mmdcCommand(), ["-i", sourcePath, "-o", pngPath, "-b", "transparent", "--quiet"], {
			timeout: RENDER_TIMEOUT_MS,
			maxBuffer: 1024 * 1024,
		});
	}

	return { index, hash, pngPath, sourcePath, code };
}

export default function (pi: ExtensionAPI) {
	pi.registerMessageRenderer<MermaidRenderDetails>(CUSTOM_TYPE, (message, { expanded }, theme) => {
		const details = message.details;
		const diagrams = details?.diagrams ?? [];
		const container = new Container();

		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold(`Mermaid diagram${diagrams.length === 1 ? "" : "s"}`)), 1, 0));

		for (const diagram of diagrams) {
			if (diagrams.length > 1) {
				container.addChild(new Text(theme.fg("muted", `#${diagram.index + 1}`), 1, 0));
			}

			try {
				const base64 = readFileSync(diagram.pngPath).toString("base64");
				container.addChild(
					new Image(base64, "image/png", { fallbackColor: (s: string) => theme.fg("muted", s) }, {
						maxWidthCells: 100,
						maxHeightCells: 40,
						filename: path.basename(diagram.pngPath),
					}),
				);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				container.addChild(new Text(theme.fg("error", `Could not read rendered diagram: ${msg}`), 1, 0));
			}

			if (expanded) {
				container.addChild(new Text(theme.fg("dim", `PNG: ${diagram.pngPath}\nSource: ${diagram.sourcePath}`), 1, 0));
				container.addChild(new Text(theme.fg("dim", diagram.code), 1, 0));
			}
		}

		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		return container;
	});

	pi.on("message_end", async (event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (event.message.role !== "assistant") return;

		const text = textFromContent((event.message as { content?: unknown }).content);
		const blocks = extractMermaidBlocks(text).slice(0, MAX_DIAGRAMS_PER_MESSAGE);
		if (blocks.length === 0) return;

		try {
			const diagrams: MermaidDiagram[] = [];
			for (let i = 0; i < blocks.length; i++) {
				diagrams.push(await renderMermaid(blocks[i]!, i));
			}

			pi.sendMessage<MermaidRenderDetails>(
				{
					customType: CUSTOM_TYPE,
					content: `Rendered ${diagrams.length} Mermaid diagram${diagrams.length === 1 ? "" : "s"}.`,
					display: true,
					details: {
						diagrams,
						sourceMessageHash: sha256(text).slice(0, 16),
					},
				},
				{ deliverAs: ctx.isIdle() ? "steer" : "followUp" },
			);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Mermaid render failed: ${msg}. Install/fix mmdc in ${extensionDir()}.`, "error");
		}
	});
}
