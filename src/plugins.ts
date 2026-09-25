/**
 * 扩展面（M-B MCP 配置 + M-C 插件系统）。
 *
 * 三个加载来源，全部在 NanmiHarness.create 时合并进装配：
 *
 * 1. MCP 配置文件（ZCode 风格的 user + project 双层）：
 *    ~/.nanmi/mcp.json                          —— 用户层
 *    <cwd>/.nanmi/mcp.json                      —— 项目层，同名覆盖，"disabled": true 可关
 *    格式：{ "servers": { "<name>": { "command"|"url", ... } } }
 *
 * 2. 插件目录：~/.nanmi/plugins/<id>/plugin.json，每个插件可贡献五种东西：
 *    mcp.servers        —— MCP server（名字带 <id>- 前缀防碰撞）
 *    hooks              —— preToolCall/postToolCall/runEnd 原生命令
 *    skills             —— 技能目录（相对插件根），进渐进披露目录
 *    tools              —— 工具模块（相对插件根的 .mjs/.js，default 导出 AgentTool[]）
 *    systemPromptFragment —— 追加到 system prompt 末尾（稳定前缀之后，仍缓存友好）
 *
 * 3. 编程用法经 NanmiConfig 直传（最高优先级）。
 *
 * 设计原则：文件是声明式的壳，一切最终仍走 NanmiConfig 的既有接缝；
 * 加载失败（坏 JSON / 工具模块抛错）只降级该插件并 console.error，绝不拖垮整个会话。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { HookConfig, McpServerConfig } from "./types.js";
import { NANMI_DIR } from "./providers.js";

/** 单层 MCP 配置文件 */
interface McpFile {
	servers?: Record<string, McpServerConfig & { disabled?: boolean }>;
}

/** 插件 manifest */
export interface PluginManifest {
	name?: string;
	version?: string;
	description?: string;
	mcp?: { servers?: Record<string, McpServerConfig & { disabled?: boolean }> };
	hooks?: HookConfig;
	/** 相对插件根的技能目录列表 */
	skills?: string[];
	/** 相对插件根的工具模块列表 */
	tools?: string[];
	systemPromptFragment?: string;
	/** false = 不加载（等同删除插件） */
	disabled?: boolean;
}

/** 扩展加载结果：create() 消费的合并产物 */
export interface ExtensionLoad {
	mcpServers: Record<string, McpServerConfig>;
	hooks: HookConfig;
	skillDirs: string[];
	tools: AgentTool<any, any>[];
	promptFragments: string[];
	plugins: Array<{ name: string; version?: string; contributes: string[] }>;
	warnings: string[];
}

/** 读一层 mcp.json（不存在给空）；坏 JSON 记 warning 返回空 */
function readMcpFile(file: string, warnings: string[]): Record<string, McpServerConfig> {
	if (!existsSync(file)) return {};
	let parsed: McpFile;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8")) as McpFile;
	} catch (err) {
		warnings.push(`MCP 配置解析失败 ${file}: ${(err as Error).message}`);
		return {};
	}
	const out: Record<string, McpServerConfig> = {};
	for (const [name, cfg] of Object.entries(parsed.servers ?? {})) {
		if (!cfg || typeof cfg !== "object") continue;
		if (cfg.disabled) continue;
		const { disabled: _drop, ...server } = cfg;
		out[name] = server as McpServerConfig;
	}
	return out;
}

/**
 * MCP 配置合并（M-B）：user 层打底，project 层同名覆盖 / disabled 关闭。
 * 编程传入的 config.mcp 优先级最高（在 index.ts 里后合并）。
 */
export function loadMcpServers(cwd: string): { servers: Record<string, McpServerConfig>; warnings: string[] } {
	const warnings: string[] = [];
	const servers = {
		...readMcpFile(join(NANMI_DIR, "mcp.json"), warnings),
		...readMcpFile(join(cwd, ".nanmi", "mcp.json"), warnings),
	};
	return { servers, warnings };
}

/** 加载一个插件目录 */
async function loadPlugin(
	dir: string,
	out: ExtensionLoad,
): Promise<{ name: string; version?: string; contributes: string[] } | null> {
	const manifestFile = join(dir, "plugin.json");
	if (!existsSync(manifestFile)) return null;
	let manifest: PluginManifest;
	try {
		manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as PluginManifest;
	} catch (err) {
		out.warnings.push(`插件 manifest 解析失败 ${dir}: ${(err as Error).message}`);
		return null;
	}
	if (manifest.disabled) return null;
	const id = dir.split("/").pop() ?? "plugin";
	const name = manifest.name ?? id;
	const contributes: string[] = [];

	// MCP：名字加插件前缀，防跨插件碰撞
	if (manifest.mcp?.servers) {
		for (const [sname, cfg] of Object.entries(manifest.mcp.servers)) {
			if (!cfg || cfg.disabled) continue;
			const { disabled: _drop, ...server } = cfg;
			out.mcpServers[`${id}__${sname}`] = server as McpServerConfig;
		}
		contributes.push(`mcp×${Object.keys(manifest.mcp.servers).length}`);
	}

	// hooks：追加（多层钩子都跑，exit 2 谁先谁断）
	if (manifest.hooks) {
		for (const key of ["preToolCall", "postToolCall", "runEnd"] as const) {
			const cmds = manifest.hooks[key];
			if (cmds?.length) {
				out.hooks[key] = [...(out.hooks[key] ?? []), ...cmds];
				contributes.push(key);
			}
		}
	}

	// skills：相对目录，进渐进披露
	for (const rel of manifest.skills ?? []) {
		const skillDir = join(dir, rel);
		if (existsSync(skillDir)) {
			out.skillDirs.push(skillDir);
			contributes.push("skills");
		} else {
			out.warnings.push(`插件 ${name}: 技能目录不存在 ${skillDir}`);
		}
	}

	// tools：动态 import，default 导出 AgentTool[]
	for (const rel of manifest.tools ?? []) {
		const mod = join(dir, rel);
		try {
			const imported = (await import(mod)) as { default?: unknown };
			const exported = imported.default ?? imported;
			const list = Array.isArray(exported)
				? (exported as AgentTool<any, any>[])
				: typeof exported === "function"
					? [exported as unknown as AgentTool<any, any>]
					: [];
			if (!list.length) throw new Error("default 导出须是 AgentTool[] 或单个 AgentTool");
			out.tools.push(...list);
			contributes.push(`tools×${list.length}`);
		} catch (err) {
			out.warnings.push(`插件 ${name}: 工具模块加载失败 ${rel}: ${(err as Error).message}`);
		}
	}

	if (manifest.systemPromptFragment) {
		out.promptFragments.push(manifest.systemPromptFragment);
		contributes.push("prompt");
	}

	return { name, version: manifest.version, contributes };
}

/**
 * 插件加载（M-C）：扫 ~/.nanmi/plugins/ 下所有含 plugin.json 的子目录。
 * 单个插件失败只降级自身（warning 里留痕）。
 */
export async function loadPlugins(): Promise<ExtensionLoad> {
	const out: ExtensionLoad = {
		mcpServers: {},
		hooks: {},
		skillDirs: [],
		tools: [],
		promptFragments: [],
		plugins: [],
		warnings: [],
	};
	const pluginsDir = join(NANMI_DIR, "plugins");
	if (!existsSync(pluginsDir)) return out;
	let entries: string[] = [];
	try {
		entries = readdirSync(pluginsDir).filter((e) => statSync(join(pluginsDir, e)).isDirectory());
	} catch {
		return out;
	}
	for (const entry of entries.sort()) {
		const loaded = await loadPlugin(join(pluginsDir, entry), out);
		if (loaded) out.plugins.push(loaded);
	}
	return out;
}

/** M-B + M-C 一体化入口：给 create() 用的完整扩展加载 */
export async function loadExtensions(cwd: string): Promise<ExtensionLoad> {
	const mcpLayer = loadMcpServers(cwd);
	const plugins = await loadPlugins();
	return {
		...plugins,
		mcpServers: { ...mcpLayer.servers, ...plugins.mcpServers },
		warnings: [...mcpLayer.warnings, ...plugins.warnings],
	};
}
