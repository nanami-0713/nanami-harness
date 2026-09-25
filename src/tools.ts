/**
 * 工具面（M1a）。内置七件借自 pi-coding-agent 的生产实现（带 cwd 的工厂函数），
 * 自建工具用同一套 TypeBox schema 形状，模型看到的面完全一致。
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-coding-agent";
import type { BuiltinToolName } from "./types.js";

export const BUILTIN_TOOL_NAMES: readonly BuiltinToolName[] = [
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
];

/** 只读工具：任何权限模式下都放行；也是子代理的默认工具面 */
export const READONLY_TOOL_NAMES: readonly BuiltinToolName[] = ["read", "grep", "find", "ls"];

export function isReadonlyTool(toolName: string): boolean {
	return READONLY_TOOL_NAMES.includes(toolName as BuiltinToolName) || toolName === "subagent";
}

export function buildBuiltinTools(cwd: string, names: readonly BuiltinToolName[]): AgentTool<any, any>[] {
	const set = new Set(names);
	const tools: AgentTool<any, any>[] = [];
	if (set.has("read")) tools.push(createReadTool(cwd));
	if (set.has("bash")) tools.push(createBashTool(cwd));
	if (set.has("edit")) tools.push(createEditTool(cwd));
	if (set.has("write")) tools.push(createWriteTool(cwd));
	if (set.has("grep")) tools.push(createGrepTool(cwd));
	if (set.has("find")) tools.push(createFindTool(cwd));
	if (set.has("ls")) tools.push(createLsTool(cwd));
	return tools;
}
