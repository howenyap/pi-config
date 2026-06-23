import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { isReadToolResult, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BUFFER = 1024 * 1024;
const STATUS_KEY = "skill-dynamic-context";

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

function shellExecutionDisabled(cwd: string): boolean {
	for (const settingsPath of [join(homedir(), ".pi/agent/settings.json"), join(cwd, ".pi/settings.json")]) {
		try {
			if (!existsSync(settingsPath)) continue;
			const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
			if (settings?.disableSkillShellExecution === true) return true;
		} catch {
			// Ignore malformed settings; Pi will report settings issues separately.
		}
	}
	return false;
}

function shellEnv(): NodeJS.ProcessEnv {
	return {
		HOME: process.env.HOME,
		LANG: process.env.LANG,
		LC_ALL: process.env.LC_ALL,
		LOGNAME: process.env.LOGNAME,
		PATH: process.env.PATH,
		SHELL: process.env.SHELL,
		TMPDIR: process.env.TMPDIR,
		USER: process.env.USER,
	};
}

function truncateOutput(text: string): string {
	const max = 50_000;
	if (text.length <= max) return text.trimEnd();
	return `${text.slice(0, max).trimEnd()}\n[output truncated by skill-dynamic-context: ${text.length - max} more chars]`;
}

async function runShell(command: string, cwd: string, disabled: boolean): Promise<string> {
	if (disabled) return "[shell command execution disabled by policy]";
	try {
		const { stdout, stderr } = await execFileAsync("/bin/bash", ["-lc", command], {
			cwd,
			timeout: DEFAULT_TIMEOUT_MS,
			maxBuffer: DEFAULT_MAX_BUFFER,
			env: shellEnv(),
		});
		return truncateOutput([stdout, stderr].filter(Boolean).join(""));
	} catch (error) {
		const err = error as { stdout?: string; stderr?: string; message?: string; code?: unknown; signal?: unknown };
		const output = [err.stdout, err.stderr].filter(Boolean).join("").trimEnd();
		const suffix = err.signal ? `signal ${err.signal}` : `exit ${err.code ?? "unknown"}`;
		return truncateOutput(`${output}${output ? "\n" : ""}[shell command failed: ${suffix}${err.message ? `: ${err.message}` : ""}]`);
	}
}

async function renderDynamicContext(markdown: string, skillDir: string, sessionCwd: string): Promise<{ text: string; count: number }> {
	const disabled = shellExecutionDisabled(sessionCwd);
	let count = 0;

	// Fenced multi-line command blocks:
	// ```!
	// command...
	// ```
	let rendered = "";
	let cursor = 0;
	const fenceRegex = /^```!\s*\n([\s\S]*?)^```[ \t]*$/gm;
	for (const match of markdown.matchAll(fenceRegex)) {
		const start = match.index ?? 0;
		rendered += markdown.slice(cursor, start);
		rendered += await runShell(match[1] ?? "", skillDir, disabled);
		cursor = start + match[0].length;
		count++;
	}
	rendered += markdown.slice(cursor);

	// Inline substitutions. Per Claude's documented behavior, ! must appear at
	// the start of a line or immediately after whitespace.
	let inlineRendered = "";
	cursor = 0;
	const inlineRegex = /(^|\s)!`([^`\n]+)`/gm;
	for (const match of rendered.matchAll(inlineRegex)) {
		const start = match.index ?? 0;
		const prefix = match[1] ?? "";
		inlineRendered += rendered.slice(cursor, start) + prefix;
		inlineRendered += await runShell(match[2] ?? "", skillDir, disabled);
		cursor = start + match[0].length;
		count++;
	}
	inlineRendered += rendered.slice(cursor);

	return { text: inlineRendered, count };
}

function isSkillMarkdownPath(path: unknown): path is string {
	return typeof path === "string" && /(^|\/)SKILL\.md$/i.test(path);
}

function findSkillFiles(root: string, out: string[] = []): string[] {
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (entry === "node_modules" || entry === ".git") continue;
		const full = join(root, entry);
		let stat;
		try {
			stat = statSync(full);
		} catch {
			continue;
		}
		if (stat.isDirectory()) {
			const skill = join(full, "SKILL.md");
			if (existsSync(skill)) out.push(skill);
			findSkillFiles(full, out);
		} else if (stat.isFile() && entry.endsWith(".md") && root.endsWith("/skills")) {
			out.push(full);
		}
	}
	return out;
}

function parseSkillName(markdown: string, fallback: string): string {
	const frontmatter = markdown.match(/^---\s*\n([\s\S]*?)\n---/);
	const name = frontmatter?.[1]?.match(/^name:\s*["']?([^"'\n]+)["']?\s*$/m)?.[1]?.trim();
	return name || fallback;
}

function standardSkillRoots(): string[] {
	const roots = ["~/.pi/agent/skills", "~/.agents/skills"].map(expandHome);
	try {
		const settingsPath = join(homedir(), ".pi/agent/settings.json");
		if (existsSync(settingsPath)) {
			const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
			if (Array.isArray(settings?.skills)) {
				for (const path of settings.skills) if (typeof path === "string") roots.push(resolve(expandHome(path)));
			}
		}
	} catch {}
	return [...new Set(roots)];
}

function realPathOrResolved(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function isWithin(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function isTrustedSkillPath(path: string): boolean {
	const realPath = realPathOrResolved(path);
	return standardSkillRoots().some((root) => existsSync(root) && isWithin(realPathOrResolved(root), realPath));
}

function findSkillByName(name: string): string | undefined {
	for (const root of standardSkillRoots()) {
		if (!existsSync(root)) continue;
		const directDir = join(root, name, "SKILL.md");
		if (existsSync(directDir)) return directDir;
		const directFile = join(root, `${name}.md`);
		if (existsSync(directFile)) return directFile;
		for (const file of findSkillFiles(root)) {
			try {
				const markdown = readFileSync(file, "utf8");
				if (parseSkillName(markdown, dirname(file).split("/").pop() ?? "") === name) return file;
			} catch {}
		}
	}
	return undefined;
}

export default function skillDynamicContext(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, "Skill ctx: ON");
	});

	// Make `/skill:name` work too by rendering before Pi's built-in skill expansion.
	pi.on("input", async (event, ctx) => {
		const match = event.text.match(/^\/skill:([a-z0-9-]+)(?:\s+([\s\S]*))?$/);
		if (!match) return { action: "continue" };

		const skillFile = findSkillByName(match[1]);
		if (!skillFile) return { action: "continue" };

		const raw = readFileSync(skillFile, "utf8");
		const { text, count } = await renderDynamicContext(raw, dirname(skillFile), ctx.cwd);
		if (count > 0) ctx.ui.notify(`Rendered ${count} dynamic skill context command${count === 1 ? "" : "s"} for ${match[1]}`, "info");
		const args = match[2]?.trim();
		return { action: "transform", text: args ? `${text}\n\nUser: ${args}` : text };
	});

	// Make model-initiated `read` of SKILL.md render dynamic context in-place.
	pi.on("tool_result", async (event, ctx) => {
		if (!isReadToolResult(event) || event.isError || !isSkillMarkdownPath(event.input.path)) return;
		const firstText = event.content.find((part) => part.type === "text");
		if (!firstText) return;

		const skillPath = resolve(ctx.cwd, event.input.path);
		if (!isTrustedSkillPath(skillPath)) return;

		const { text, count } = await renderDynamicContext(firstText.text, dirname(skillPath), ctx.cwd);
		if (count === 0) return;
		ctx.ui.notify(`Rendered ${count} dynamic skill context command${count === 1 ? "" : "s"} in ${event.input.path}`, "info");
		return {
			content: event.content.map((part) => (part === firstText ? { ...part, text } : part)),
		};
	});
}
