#!/usr/bin/env node
/**
 * MCP 桥：编程式接入一个本地 stdio server，让模型调用它的工具。
 *
 * 运行：npm run build && node examples/06-mcp.mjs
 * 前置：ZAI_CODING_CN_API_KEY
 * 成本：约 2 次模型调用
 *
 * 工具命名规则：mcp__<server 名>__<工具名>；mcp.json 文件层配置见主 README，
 * 同名时编程传入覆盖文件层。
 */
import { fileURLToPath } from "node:url";
import { NanmiHarness, resolveApiKey } from "../dist/index.js";

const apiKey = resolveApiKey();
if (!apiKey) {
	console.error("未找到 ZAI_CODING_CN_API_KEY（环境变量或 ~/.dsh/.credentials.yaml）");
	process.exit(1);
}

const echoServer = fileURLToPath(new URL("../test/mcp-echo-server.mjs", import.meta.url));

const harness = await NanmiHarness.create({
	provider: "zai-coding-cn",
	modelId: "glm-5.3-flash",
	systemPrompt: "你是演示体。用中文，简短。",
	apiKey,
	tools: false, // 不装内置工具，让 MCP 工具独占视野
	permission: { mode: "bypass" }, // 本例只看 MCP 桥；权限门的行为见 02-permissions
	mcp: {
		echo: { command: process.execPath, args: [echoServer] },
	},
	subagent: false,
	jev: false,
	computer: false,
	compaction: false,
});

const result = await harness.run("调用 mcp 的 add 工具计算 19 + 23，把算式和结果告诉我。");

console.log(`\n── 模型最终回答 ──\n${result.text}`);
const calledMcp = result.events.some(
	(e) => e.type === "tool_execution_start" && e.toolName === "mcp__echo__add",
);
console.log(`\n调用了 mcp__echo__add: ${calledMcp ? "✅" : "❌"}`);
await harness.dispose();
