#!/usr/bin/env node
/**
 * 会话持久化与恢复：run A 写入事实并落盘 → 全新实例凭 resumeId 接上 → 验证记忆。
 *
 * 运行：npm run build && node examples/04-session-resume.mjs
 * 前置：ZAI_CODING_CN_API_KEY
 * 成本：约 2 次模型调用
 *
 * 落盘位置：./.nanami/sessions/<id>.jsonl（append-only，压缩写检查点，物理史保留）
 */
import { NanmiHarness, resolveApiKey } from "../dist/index.js";

const apiKey = resolveApiKey();
if (!apiKey) {
	console.error("未找到 ZAI_CODING_CN_API_KEY（环境变量或 ~/.dsh/.credentials.yaml）");
	process.exit(1);
}

const base = {
	provider: "zai-coding-cn",
	modelId: "glm-5.3-flash",
	systemPrompt: "你是演示体。用中文，简短。",
	apiKey,
	tools: false,
	subagent: false,
	jev: false,
	computer: false,
	compaction: false,
};

// ── run A：新会话，约定一个暗号 ────────────────────────────────────────────
const a = await NanmiHarness.create({ ...base, session: {} });
const r1 = await a.run("记住这个暗号：橘子汽水。现在只回复「已记住」。");
console.log(`run A 回答：${r1.text.trim()}`);
console.log(`run A 会话 id：${a.sessionId}`);
await a.dispose();

// ── run B：全新实例，凭 id 恢复历史 ───────────────────────────────────────
const b = await NanmiHarness.create({ ...base, session: { resumeId: a.sessionId } });
const r2 = await b.run("我们刚才约定的暗号是什么？"); // 本例 tools:false，模型没有工具可用
const remembered = r2.text.includes("橘子汽水");
console.log(`run B（新实例）回答：${r2.text.trim()}`);
console.log(remembered ? "✅ 会话恢复成功，记忆还在" : "❌ 没记起来");
await b.dispose();
process.exit(remembered ? 0 : 1);
