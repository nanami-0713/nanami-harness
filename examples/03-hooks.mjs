#!/usr/bin/env node
/**
 * hooks：preToolCall 钩子实时拦截 bash。真实 run，看得见拦截全过程。
 *
 * 运行：npm run build && node examples/03-hooks.mjs
 * 前置：ZAI_CODING_CN_API_KEY
 * 成本：约 2 次模型调用
 *
 * 钩子协议：命令以 `bash -c` 执行、payload 走 stdin JSON；
 * exit 2 或 stdout 输出 {"block":true,"reason":"…"} 即阻断，其余一律放行。
 * 事件对应：PreToolUse→preToolCall，PostToolUse→postToolCall，Stop→runEnd。
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
	permission: { mode: "bypass" }, // 关掉权限门，确保拦截只来自钩子
	tools: ["bash", "read"],
	hooks: {
		preToolCall: [
			// 观察者：把每次工具调用的 JSON 打到 stderr，只看不裁
			`sed 's/^/[钩子·观察] /' >&2`,
			// 拦截者：见到 bash 就输出阻断 JSON
			`grep -q '"toolName":"bash"' && echo '{"block":true,"reason":"演示环境禁止 bash"}' || exit 0`,
		],
	},
	subagent: false,
	jev: false,
	computer: false,
	compaction: false,
});

const result = await harness.run("请用 bash 工具运行 `echo hello`，然后告诉我运行结果。");

console.log(`\n── 模型最终回答 ──\n${result.text}`);
const bashTried = result.events.some((e) => e.type === "tool_execution_start" && e.toolName === "bash");
// 模型会转述拦截理由，所以去消息历史里找钩子返回的原始 reason
const reasonFedBack = JSON.stringify(result.messages).includes("演示环境禁止 bash");
console.log(`\n模型尝试过 bash: ${bashTried ? "是" : "否"}；钩子拦截生效（理由已回灌给模型）: ${reasonFedBack ? "✅" : "❌"}`);
await harness.dispose();
