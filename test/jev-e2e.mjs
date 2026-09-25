// jev-e2e：完整 Agent 循环验证 —— GLM 能看到 jev_decide 并正确调用。
// 用法: node test/jev-e2e.mjs（需先 npm run build；真实消耗 GLM flash + Jev 各一次）
// 注意：pi 的事件流里没有 "tool_call" 事件类型——工具调用以 assistant 消息的
// toolCall content block 出现，执行以 tool_execution_start/end 事件出现。
import { NanmiHarness, resolveApiKey } from "../dist/index.js";

const harness = await NanmiHarness.create({
	provider: "zai-coding-cn",
	modelId: "glm-5.3-flash",
	apiKey: resolveApiKey(),
	systemPrompt: "You are a concise assistant. Use tools when asked.",
	cwd: "/tmp",
	permission: { mode: "bypass" },
	session: false,
	compaction: false,
	subagent: false,
	timeoutMs: 120_000,
});

const result = await harness.run(
	"Call jev_decide with state = {forecast: 'Sunny, 22C, light breeze'}, one noul question " +
		"good_for_outdoor_run with English criteria. Report the tool-returned noul value.",
	() => {},
);

const calls = result.newMessages.flatMap((m) =>
	m.role === "assistant" ? m.content.filter((b) => b.type === "toolCall" && b.name === "jev_decide") : [],
);
const results = result.newMessages.filter((m) => m.role === "toolResult");
const ok = calls.length === 1 && results.length === 1 && !results[0].isError && /noul/i.test(result.text);

console.log("— jev_decide calls:", calls.length, "| toolResult isError:", results[0]?.isError ?? "(none)");
console.log("— final text:", result.text);
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
