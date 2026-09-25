/**
 * jev_decide（Jev 原生集成）：TypeSafe System One 决策模型直调工具。
 * API 语义移植自 jev-mcp（~/Desktop/Zcode/jev-mcp/server.mjs，2026-09 实测口径），
 * 但不走 MCP 桥——作为 harness 原生 AgentTool 直接装配，享受轨迹视图计时与 details。
 *
 * Jev 不是 LLM：吃结构化 state + 类型化 questions，出 noul（概率）/score（分档）/
 * choice（单选）三种校准决策，各带置信度。定位是把"分类/路由/评分/验收"这类
 * 判断从自由文本里拿出来变成类型化决策。
 *
 * 三条使用纪律（description 原样透传给模型）：
 * 1. 材料必须进 state——问 state 里没有的事实，校准会失效；
 * 2. 一问一断——复合问题拆成多条原子问题，总数在代码里合成；
 * 3. 判据要显式且对比化（what/is/examples vs not_for），英文书写。
 *
 * key 安全：不落日志、不进报错文本；每次调用现读（换 key 不用重启进程）。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { JevConfig } from "./types.js";

const DEFAULT_BASE_URL = "https://api.typesafe.ai";
// 2026-09 起请求体必须带 model；jev-latest 是官方别名（自动跟最新版），裸 "jev" 不合法。
const DEFAULT_MODEL = "jev-latest";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;

const jevSchema = Type.Object({
	state: Type.Object({}, {
		additionalProperties: true,
		description:
			"The structured material to judge (documents, records, diffs, options). Everything the questions reference must be in here — calibration fails on out-of-distribution input.",
	}),
	questions: Type.Object({}, {
		additionalProperties: true,
		description:
			'Typed questions keyed by name: { "<name>": { type: "noul"|"score"|"choice", instructions: "...", criteria: {...} } }. One judgment per question; all are evaluated in parallel in one call.',
	}),
	timeoutMs: Type.Optional(
		Type.Number({ description: `Optional request timeout in ms, default ${DEFAULT_TIMEOUT_MS}.` }),
	),
});

/** 轨迹视图 details：调用概况（不含 state/questions 全文，避免视图膨胀） */
export interface JevCallDetails {
	status: number;
	questionCount: number;
	model: string;
	inputTokens?: number;
	outputTokens?: number;
	/** 置信度 < 0.7 的问题名（校准纪律：低置信应转人工/LLM，不硬信） */
	lowConfidence: string[];
}

/** key 解析链：显式配置 → env TYPESAFE_API_KEY → env TYPESAFE_API_KEY_FILE → ~/.typesafe-api-key */
function resolveJevKey(explicit?: string): string | undefined {
	if (explicit?.trim()) return explicit.trim();
	if (process.env.TYPESAFE_API_KEY?.trim()) return process.env.TYPESAFE_API_KEY.trim();
	const file = process.env.TYPESAFE_API_KEY_FILE || join(homedir(), ".typesafe-api-key");
	try {
		const v = readFileSync(file, "utf8").trim();
		if (v) return v;
	} catch {}
	return undefined;
}

export function createJevTool(config?: JevConfig): AgentTool<typeof jevSchema, JevCallDetails> {
	const baseUrl = (config?.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
	const model = config?.model ?? DEFAULT_MODEL;
	return {
		name: "jev_decide",
		label: "Jev",
		description:
			"Ask the TypeSafe Jev model (System One) to make typed decisions. Jev does NOT generate text: it takes structured \"state\" (the material to judge) plus typed \"questions\", and returns one calibrated answer per question — a probability (noul), a banded score, or a single choice — each with confidence.\n\nUse it when a judgment is better made as a typed decision than as free-form LLM prose: classify, route, score against a rubric, verify a claim, gate an action. One request evaluates many questions in parallel over the same state.\n\nThree disciplines for good results (calibrated against real usage):\n1. Put material in \"state\". Do not ask about facts absent from the state — calibration fails on out-of-distribution input.\n2. One judgment per question. Split compound questions into several atomic ones; synthesize totals in code afterwards.\n3. Make criteria explicit and contrastive: define what/is/examples vs not_for; write instructions/criteria in English; operationalize soft requirements into checkable evidence in the state.\n\nQuestion types (each needs \"type\" and English \"instructions\"; all live in one \"questions\" object, returned keyed by name):\n- \"noul\" — a true/false judgment with probability. criteria: {true: {what, examples?}, false: {what, not_for?}}.\n- \"score\" — a banded rating (e.g. 0-3). criteria: an ordered legend of bands, each {what, signals:[...]}.\n- \"choice\" — pick exactly one option. criteria: {options: [{value, what, ...}], ...}.\n\nResponse: {model, answers: {<name>: {type, noul|score|choice, confidence, probabilities?, legend?}}, usage: {input_tokens, output_tokens}}. Low confidence (< ~0.7) means: escalate to a human or an LLM instead of trusting the decision.",
		parameters: jevSchema,
		execute: async (_toolCallId, params) => {
			const { state, questions } = params;
			if (typeof state !== "object" || state === null || Array.isArray(state)) {
				throw new Error("state must be a JSON object (the material to judge).");
			}
			const questionNames = Object.keys(questions ?? {});
			if (questionNames.length === 0) {
				throw new Error(
					'questions must be a non-empty JSON object like { "<name>": { type: "noul"|"score"|"choice", instructions, criteria } }.',
				);
			}

			const apiKey = resolveJevKey(config?.apiKey);
			if (!apiKey) {
				throw new Error(
					"缺少 Jev API key：把 TypeSafe key 写入 ~/.typesafe-api-key（一行纯文本），或设 env TYPESAFE_API_KEY。",
				);
			}

			const timeoutMs = Math.min(
				Number(params.timeoutMs) || config?.timeoutMs || DEFAULT_TIMEOUT_MS,
				MAX_TIMEOUT_MS,
			);
			const ctrl = new AbortController();
			const timer = setTimeout(() => ctrl.abort(), timeoutMs);
			let response: Response;
			try {
				response = await fetch(`${baseUrl}/v1/systemone`, {
					method: "POST",
					headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
					body: JSON.stringify({ model, state, questions }),
					signal: ctrl.signal,
				});
			} catch (err) {
				if ((err as Error).name === "AbortError") throw new Error(`Jev 请求超时（${timeoutMs}ms）`);
				throw new Error(`Jev 请求失败: ${(err as Error).message}`);
			} finally {
				clearTimeout(timer);
			}

			const text = await response.text();
			if (!response.ok) {
				// 报错文本只带 API 回包片段，绝不带 key
				throw new Error(`Jev API returned HTTP ${response.status}: ${text.slice(0, 2000)}`);
			}

			let parsed: {
				model?: string;
				answers?: Record<string, { confidence?: number }>;
				usage?: { input_tokens?: number; output_tokens?: number };
			};
			try {
				parsed = JSON.parse(text);
			} catch {
				throw new Error(`Jev API 返回了无法解析的响应体: ${text.slice(0, 500)}`);
			}

			const lowConfidence = Object.entries(parsed.answers ?? {})
				.filter(([, a]) => typeof a.confidence === "number" && a.confidence < 0.7)
				.map(([name]) => name);

			return {
				content: [{ type: "text", text }],
				details: {
					status: response.status,
					questionCount: questionNames.length,
					model: parsed.model ?? model,
					inputTokens: parsed.usage?.input_tokens,
					outputTokens: parsed.usage?.output_tokens,
					lowConfidence,
				},
			};
		},
	};
}
