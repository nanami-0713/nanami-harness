/**
 * M1-M3 集成测试。全程 GLM（glm-5.3-flash），预计 6 次左右模型调用。
 *
 * 步骤 0  权限矩阵（纯逻辑，零成本）
 * 步骤 1  hooks 单测（阻断脚本，零成本）
 * 步骤 2  压缩单测（真实摘要调用 ×1）
 * 步骤 3  全链路 run A（新会话：bash + todo_write + subagent + mcp echo）
 * 步骤 4  resume run B（恢复会话：追问 todo 状态 + 复述 echo 结果）
 */
import { resolveApiKey } from "./key.js";
import { PermissionGate } from "./permissions.js";
import { SessionStore } from "./session.js";
import { Compactor } from "./compaction.js";
import { HookRunner } from "./hooks.js";
import { NanmiHarness } from "./index.js";
import { buildModels } from "./providers.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

const results: Array<{ name: string; pass: boolean; note: string }> = [];
function record(name: string, pass: boolean, note: string) {
	results.push({ name, pass, note });
	console.log(`${pass ? "✅" : "❌"} ${name} —— ${note}`);
}

const API_KEY = resolveApiKey();
if (!API_KEY) {
	console.error("未找到 ZAI_CODING_CN_API_KEY（环境变量或 ~/.dsh/.credentials.yaml）");
	process.exit(1);
}

const PROVIDER = "zai-coding-cn";
const MODEL_ID = "glm-5.3-flash";
const SYSTEM_PROMPT = `你是 nanmi-harness 集成测试体。用中文，简短。需要事实时用工具查，不要猜。`;

// ── 步骤 0：权限矩阵 ────────────────────────────────────────────────────────
{
	const cases: Array<[string, string, string, unknown, "allow" | "ask" | "deny"]> = [
		["readonly 放行 read", "readonly", "read", {}, "allow"],
		["readonly 拒绝 bash", "readonly", "bash", { command: "ls" }, "deny"],
		["default 放行 read", "default", "read", {}, "allow"],
		["default 审批 bash", "default", "bash", { command: "ls" }, "ask"],
		["default 审批 write", "default", "write", { path: "/tmp/proj/a.txt" }, "ask"],
		["acceptEdits 放行 cwd 内 write", "acceptEdits", "write", { path: "/tmp/proj/a.txt" }, "allow"],
		["acceptEdits 审批 cwd 外 write", "acceptEdits", "write", { path: "/etc/hosts" }, "ask"],
		["bypass 全放行", "bypass", "bash", { command: "rm -rf /" }, "allow"],
		["非交互 ask 降级为 deny（经 authorize）", "default", "bash", { command: "ls" }, "deny"],
	];
	for (const [name, mode, tool, args, expect] of cases) {
		const gate = new PermissionGate({ mode: mode as never, interactive: false }, "/tmp/proj");
		const actual =
			expect === "deny" && mode === "default" && tool === "bash"
				? (await gate.authorize(tool, args)) !== undefined
					? ("deny" as const)
					: ("allow" as const)
				: gate.check(tool, args).decision;
		record(name, actual === expect, `期望 ${expect}，实际 ${actual}`);
	}
}

// ── 步骤 1：hooks 阻断单测 ──────────────────────────────────────────────────
{
	const blocker = new HookRunner({
		preToolCall: [`grep -q '"toolName":"bash"' && echo '{"block":true,"reason":"拦截 bash"}' || exit 0`],
	});
	const blocked = await blocker.runPreTool({ toolName: "bash", args: { command: "ls" } });
	const allowed = await blocker.runPreTool({ toolName: "read", args: {} });
	record(
		"hooks preToolCall 阻断",
		!!blocked && blocked.reason === "拦截 bash" && !allowed,
		blocked ? `阻断理由="${blocked.reason}"` : "未阻断",
	);
}

// ── 步骤 2：压缩单测（真实摘要调用 ×1）────────────────────────────────────
{
	const models = buildModels();
	const model = models.getModel(PROVIDER, MODEL_ID)!;
	const compactor = new Compactor({ models, model, apiKey: API_KEY }, { thresholdRatio: 0.8, keepRecentTokens: 16 });
	// 构造 8 条假历史（内容真实可摘要），keepRecent=2 → 头部 6 条应被摘要
	const fake: AgentMessage[] = [];
	for (let i = 1; i <= 4; i++) {
		fake.push({ role: "user", content: `第${i}步：请把 config.json 里的端口改成 ${8000 + i}。`, timestamp: Date.now() } as AgentMessage);
		fake.push({
			role: "assistant",
			content: [{ type: "text", text: `已完成第${i}步：端口已改为 ${8000 + i}。` }],
			timestamp: Date.now(),
		} as AgentMessage);
	}
	const compacted = await compactor.compact(fake);
	const summaryText = JSON.stringify(compacted[0]);
	// keepRecentTokens=16 只够装下 1 条尾消息（每条约 8-10 token），断言语义而非具体条数：
	// 摘要在首位、尾部至少保留 1 条且是原消息引用
	const tailKept = compacted.length >= 2 && compacted.slice(1).every((m, i) => m === fake[fake.length - compacted.length + 1 + i]);
	record(
		"压缩：头部摘要 + 尾部保留",
		summaryText.includes("系统压缩") && tailKept && !summaryText.includes("摘要生成失败"),
		`${fake.length} 条 → ${compacted.length} 条，尾部原样=${tailKept}`,
	);
}

// ── 步骤 3：全链路 run A（新会话）──────────────────────────────────────────
{
	const harness = await NanmiHarness.create({
		provider: PROVIDER,
		modelId: MODEL_ID,
		systemPrompt: SYSTEM_PROMPT,
		apiKey: API_KEY,
		permission: { mode: "bypass" },
		compaction: false,
		session: {},
		mcp: { echo: { command: process.execPath, args: ["test/mcp-echo-server.mjs"] } },
	});

	console.log("\n── run A：bash + todo + subagent + mcp（约 3 次模型调用）──");
	const result = await harness.run(
		"依次完成三件事，全部完成后再回答：1) 用 bash 运行 `ls src` 看看源码文件；" +
			"2) 用 todo_write 建两条任务：'接 GLM 路由'(in_progress) 和 '写 README'(pending)；" +
			"3) 派 subagent 数一下 src 目录下有多少个 .ts 文件并汇报数字。" +
			"4) 调用 mcp 的 echo 工具，text 参数填 'mcp-ok'。最后把 .ts 文件数量和 echo 的返回值放进你的回答。",
		(event) => {
			if (event.type === "tool_execution_start") console.log(`  [工具] ${event.toolName}`);
			if (event.type === "tool_execution_end" && event.isError) console.log(`  [工具错误] ${event.toolName}`);
		},
	);
	const text = result.text;
	record("run A: 调用了 todo_write", result.events.some((e) => e.type === "tool_execution_start" && e.toolName === "todo_write"), "事件流验证");
	record("run A: 调用了 subagent", result.events.some((e) => e.type === "tool_execution_start" && e.toolName === "subagent"), "事件流验证");
	record("run A: 调用了 mcp__echo__echo", result.events.some((e) => e.type === "tool_execution_start" && e.toolName === "mcp__echo__echo"), "MCP 桥命名 mcp__<server>__<tool>");
	record("run A: 回答含 echo 返回值", text.includes("mcp-ok"), text.slice(-80).replace(/\n/g, " "));

	const sessionId = harness.sessionId!;
	console.log(`\n会话已落盘：${sessionId}`);
	record("会话 id 生成", !!sessionId, sessionId);
	record("会话可读取", SessionStore.load(".nanmi/sessions", sessionId) !== undefined, "JSONL 落盘验证");
	await harness.dispose();

	// ── 步骤 4：resume run B ────────────────────────────────────────────────
	console.log("\n── run B：恢复会话 + 追问（约 1 次模型调用）──");
	const resumed = await NanmiHarness.create({
		provider: PROVIDER,
		modelId: MODEL_ID,
		systemPrompt: SYSTEM_PROMPT,
		apiKey: API_KEY,
		permission: { mode: "bypass" },
		compaction: false,
		mcp: { echo: { command: process.execPath, args: ["test/mcp-echo-server.mjs"] } },
		session: { resumeId: sessionId },
	});
	const r2 = await resumed.run("不用工具。只回答：我们刚才用 todo_write 建立的第一条任务是什么？它当时是什么状态？");
	const answer = r2.text.replace(/\s+/g, " ");
	record(
		"resume：记起 todo 历史",
		answer.includes("接 GLM") || answer.includes("GLM"),
		answer.slice(0, 100),
	);
	await resumed.dispose();
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log("\n════════ 集成测试汇总 ════════");
const failed = results.filter((r) => !r.pass);
for (const r of results) console.log(`${r.pass ? "✅" : "❌"} ${r.name}`);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length > 0 ? 1 : 0);
