/**
 * 上下文组装（AGENTS.md + Skills 渐进披露）。
 *
 * 分层原则：
 *  - AGENTS.md 是"项目宪法"：会话创建时一次性注入 system prompt（前缀稳定 = 缓存友好），
 *    全局（~/.nanmi/AGENTS.md）在前、项目（cwd/AGENTS.md）在后；
 *  - Skills 走渐进披露：system prompt 只放"名称 + 一句话描述"的目录（每个技能几十 token），
 *    全文由模型按需调用 skill 工具加载——不用到的技能永远不占上下文。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

export interface AgentsFile {
	path: string;
	content: string;
}

export interface SkillMeta {
	name: string;
	description: string;
	path: string; // SKILL.md 全文路径
}

export interface LoadedContext {
	agentsFiles: AgentsFile[];
	skills: SkillMeta[];
}

const GLOBAL_AGENTS = `${process.env.HOME}/.nanmi/AGENTS.md`;

/** AGENTS.md：全局在前、项目在后（后者更具体的指令可以覆盖前者） */
export function loadAgentsFiles(cwd: string, extraFiles?: string[]): AgentsFile[] {
	const candidates = [...(extraFiles ?? []), GLOBAL_AGENTS, join(cwd, "AGENTS.md")];
	const files: AgentsFile[] = [];
	const seen = new Set<string>();
	for (const p of candidates) {
		if (!p || seen.has(p) || !existsSync(p)) continue;
		seen.add(p);
		const content = readFileSync(p, "utf8").trim();
		if (content) files.push({ path: p, content });
	}
	return files;
}

/**
 * 技能发现：扫描目录下 `<name>/SKILL.md`，解析 frontmatter 的 name/description。
 * 目录默认 = cwd/skills、cwd/.nanmi/skills、~/.nanmi/skills
 */
export function discoverSkills(cwd: string, extraDirs?: string[]): SkillMeta[] {
	const roots = [...(extraDirs ?? []), join(cwd, "skills"), join(cwd, ".nanmi/skills"), `${process.env.HOME}/.nanmi/skills`];
	const skills: SkillMeta[] = [];
	const seen = new Set<string>();
	for (const root of roots) {
		if (!existsSync(root)) continue;
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const skPath = join(root, entry.name, "SKILL.md");
			if (!existsSync(skPath) || seen.has(skPath)) continue;
			seen.add(skPath);
			const meta = parseFrontmatter(readFileSync(skPath, "utf8"));
			skills.push({
				name: meta.name || entry.name,
				description: meta.description || "（无描述）",
				path: skPath,
			});
		}
	}
	return skills;
}

/** 极简 frontmatter 解析：只取 --- 块内的 name/description 键值，避免引依赖 */
function parseFrontmatter(raw: string): { name?: string; description?: string } {
	const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!m) return {};
	const out: { name?: string; description?: string } = {};
	for (const line of m[1].split("\n")) {
		const kv = line.match(/^(name|description):\s*(.+)$/);
		if (kv) out[kv[1] as "name" | "description"] = kv[2].trim().replace(/^["']|["']$/g, "");
	}
	return out;
}

/** 组装最终 system prompt：基础规范在前，AGENTS.md 与技能目录作为稳定段落追加 */
export function buildSystemPrompt(base: string, ctx: LoadedContext): string {
	const sections: string[] = [];
	if (ctx.agentsFiles.length) {
		sections.push(
			"# 项目指令（AGENTS.md）\n\n" +
				ctx.agentsFiles.map((f) => `<!-- 来源: ${f.path} -->\n${f.content}`).join("\n\n"),
		);
	}
	if (ctx.skills.length) {
		sections.push(
			"# 可用技能（渐进披露目录）\n\n需要某项技能时，先用 skill 工具加载全文再照做：\n" +
				ctx.skills.map((s) => `- **${s.name}**：${s.description}`).join("\n"),
		);
	}
	return sections.length ? `${base.trimEnd()}\n\n${sections.join("\n\n")}` : base;
}

const skillSchema = Type.Object({
	name: Type.String({ description: "要加载的技能名称（见系统提示中的技能目录）" }),
});

/** skill 工具：按需加载 SKILL.md 全文——渐进披露的"展开"动作 */
export function createSkillTool(skills: SkillMeta[]): AgentTool<typeof skillSchema, { path: string }> {
	return {
		name: "skill",
		label: "Skill",
		description:
			"加载某个技能的完整说明（SKILL.md 全文）。仅在目录中的技能描述与当前任务相关时调用；加载后遵循其中的指令执行。",
		parameters: skillSchema,
		execute: async (_id, params) => {
			const skill = skills.find((s) => s.name === params.name || s.path.includes(`/${params.name}/`));
			if (!skill) {
				throw new Error(
					`未知技能: ${params.name}。可用技能：${skills.map((s) => s.name).join(", ") || "（无）"}`,
				);
			}
			return {
				content: [{ type: "text", text: readFileSync(skill.path, "utf8") }],
				details: { path: skill.path },
			};
		},
	};
}
