#!/usr/bin/env node
/**
 * 记忆压缩：把 8 条假历史交给 Compactor，看「头部摘要 + 尾部原样保留」。
 *
 * 运行：npm run build && node examples/05-compaction.mjs
 * 前置：ZAI_CODING_CN_API_KEY
 * 成本：1 次摘要模型调用
 *
 * 真实链路里压缩挂在 prepareNextTurnWithContext：usage 越过
 * contextWindow × thresholdRatio（默认 0.8）就自动触发，本例直接手动调一次看效果。
 */
import { NanmiHarness, resolveApiKey, buildModels, Compactor } from "../dist/index.js";

const apiKey = resolveApiKey();
if (!apiKey) {
	console.error("未找到 ZAI_CODING_CN_API_KEY（环境变量或 ~/.dsh/.credentials.yaml）");
	process.exit(1);
}

const models = buildModels();
const model = models.getModel("zai-coding-cn", "glm-5.3-flash");
if (!model) {
	console.error("模型不存在：zai-coding-cn/glm-5.3-flash");
	process.exit(1);
}

// 构造 4 轮对话（内容真实可摘要）；keepRecentTokens 压到 16 → 只有最后 1 条能进尾部保留区
const history = [];
for (let i = 1; i <= 4; i++) {
	history.push({ role: "user", content: `第${i}步：请把 config.json 里的端口改成 ${8000 + i}。`, timestamp: Date.now() });
	history.push({
		role: "assistant",
		content: [{ type: "text", text: `已完成第${i}步：端口已改为 ${8000 + i}。` }],
		timestamp: Date.now(),
	});
}

const compactor = new Compactor(
	{ models, model, apiKey },
	{ thresholdRatio: 0.8, keepRecentTokens: 16 },
);
const compacted = await compactor.compact(history);

console.log(`压缩前：${history.length} 条消息`);
console.log(`压缩后：${compacted.length} 条消息`);
const summary = JSON.stringify(compacted[0]);
console.log(`\n头部摘要（前 200 字）：\n${summary.slice(0, 200)}…`);
const tailKept = compacted.length >= 2 && compacted[compacted.length - 1] === history[history.length - 1];
console.log(`\n尾部保留的是原消息引用：${tailKept ? "✅" : "❌"}`);
console.log(`摘要生成成功：${summary.includes("系统压缩") && !summary.includes("摘要生成失败") ? "✅" : "❌"}`);
