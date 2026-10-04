#!/usr/bin/env node
/**
 * 子代理：主循环派 subagent 干活 + complete() 旁路小任务。
 *
 * 运行：npm run build && node examples/07-subagent.mjs
 * 前置：ZAI_CODING_CN_API_KEY
 * 成本：约 3 次模型调用（主循环 2 + 旁路 1）
 *
 * 两条通道的区别：
 *   subagent 工具 —— 主循环内的模型自己派生带工具的子 Agent，结果回流上下文；
 *   complete()    —— 宿主代码直接调用的旁路子 Agent，不带工具，适合标题生成等一次性文本任务。
 */
import { NanmiHarness, resolveApiKey } from "../dist/index.js";

const apiKey = resolveApiKey();
if (!apiKey) {
	console.error("未找到 ZAI_CODING_CN_API_KEY（环境变量或 ~/.dsh/.credentials.yaml）");
	process.exit(1);
}

const harness = await NanmiHarness.create({
	provider: "zai-coding-cn",
	modelId: "glm-5.3-flash",
	systemPrompt: "你是演示体。用中文，简短。",
	apiKey,
	permission: { mode: "bypass" },
	tools: ["bash", "ls", "read"],
	subagent: {}, // 默认就开着，这里显式写出来示意可配 timeoutMs
	jev: false,
	computer: false,
	compaction: false,
});

// ── 主循环派活：模型自己决定派 subagent 去数文件 ─────────────────────────
const result = await harness.run(
	"派一个 subagent 数一下 src 目录下有多少个 .ts 文件，把数字直接告诉我。",
	(event) => {
		if (event.type === "tool_execution_start") console.log(`  [主循环工具] ${event.toolName}`);
	},
);
console.log(`\n── 主循环最终回答 ──\n${result.text}`);
const spawned = result.events.some((e) => e.type === "tool_execution_start" && e.toolName === "subagent");

// ── 旁路小任务：不经主循环，一次性文本进出 ───────────────────────────────
const title = await harness.complete("为「数 src 目录下的 .ts 文件数量」这个任务起一个不超过 8 字的标题。");
console.log(`\n旁路 complete() 生成的标题：${title}`);
console.log(`\nsubagent 工具被调用: ${spawned ? "✅" : "❌"}`);
await harness.dispose();
