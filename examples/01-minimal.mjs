#!/usr/bin/env node
/**
 * 最小可用：创建 → 跑一轮 → 打印回答。所有 example 的起点。
 *
 * 运行：npm run build && node examples/01-minimal.mjs
 * 前置：ZAI_CODING_CN_API_KEY（环境变量或 ~/.dsh/.credentials.yaml）
 * 成本：约 1 次模型调用
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
	systemPrompt: "你是 nanmi-harness 的演示体。用中文，一句话回答。",
	apiKey,
	// 纯对话演示：能关的配置面都关掉。todo/技能等常驻工具与
	// ~/.nanmi/plugins 用户插件仍按默认装配（启动日志的 [nanmi:extensions] 即它）
	tools: false,
	subagent: false,
	jev: false,
	computer: false,
	compaction: false,
});

// onEvent 是过程观察口：这里挑文本增量做打字机效果
const result = await harness.run("用一句话介绍 nanmi-harness 是什么。", (event) => {
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		process.stdout.write(event.assistantMessageEvent.delta);
	}
});

console.log(`\n\n── 结束：本轮新增 ${result.newMessages.length} 条消息，全程 ${result.events.length} 个事件 ──`);
await harness.dispose();
