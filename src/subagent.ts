/**
 * 子代理（M2b）。pi 官方明确不做 subagent，这里是 harness 的自有编排：
 * 把一个受限的进程内 Agent（只读工具面、独立提示词、深度 1、带超时）包装成
 * 一个普通工具 —— 模型侧看到的就是一个可调用的 `subagent`。
 *
 * 用途对齐 ZCode：广度探索（多文件扫描/架构测绘）委派出去，主循环只消费结论。
 */
import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { buildBuiltinTools } from "./tools.js";

const subagentSchema = Type.Object({
	prompt: Type.String({ description: "交给子代理的完整任务描述。要自包含：子代理看不到父对话" }),
});

const SUBAGENT_SYSTEM_PROMPT = `你是一个只读调查子代理。你的任务是为父代理做广度探索：
- 只使用只读工具（read/grep/find/ls），绝不修改任何文件。
- 结论先行：先给直接答案，再给支撑事实（带文件路径）。
- 中文回答，控制在 300 字以内。`;

export interface SubagentDeps {
	models: MutableModels;
	model: Model<Api>;
	/** 当前模型（切模型后跟随） */
	getModel?: () => Model<Api>;
	apiKey?: string;
	/**
	 * key 归属校验后的取 key 函数：仅当当前模型属于配置时的 provider 才返回 key，
	 * 否则 undefined（走 pi-ai 各 provider 的 env 认证）。
	 */
	getApiKey?: () => string | undefined;
	cwd: string;
	timeoutMs?: number;
}

export function createSubagentTool(deps: SubagentDeps): AgentTool<typeof subagentSchema, { turns: number }> {
	// 深度 1：子代理的工具面里没有 subagent，天然无法再派生
	const readonlyTools = buildBuiltinTools(deps.cwd, ["read", "grep", "find", "ls"]);

	return {
		name: "subagent",
		label: "Subagent",
		description:
			"派出一个只读子代理执行独立调查任务（多文件扫描、代码测绘、资料汇总）。它看不到父对话，所以 prompt 必须自包含。适合广度优先的探索；单点事实查询不要用它。",
		parameters: subagentSchema,
		execute: async (_toolCallId, params, signal) => {
			const timeoutMs = deps.timeoutMs ?? 180_000;
			const child = new Agent({
				initialState: {
					systemPrompt: SUBAGENT_SYSTEM_PROMPT,
					model: deps.getModel?.() ?? deps.model,
					tools: readonlyTools,
					messages: [],
				},
				streamFn: (m, context, options) => deps.models.streamSimple(m, context, options),
				...(deps.getApiKey ? { getApiKey: deps.getApiKey } : {}),
			});

			const timer = setTimeout(() => child.abort(), timeoutMs);
			try {
				// 父代理被中止时，子代理跟着中止
				signal?.addEventListener("abort", () => child.abort(), { once: true });
				await child.prompt(params.prompt);
				const finalText = lastAssistantText(child.state.messages);
				return {
					content: [
						{ type: "text", text: finalText || "(子代理没有产出文本)" },
					],
					details: { turns: child.state.messages.length },
				};
			} finally {
				clearTimeout(timer);
			}
		},
	};
}

function lastAssistantText(messages: Array<{ role?: string; content?: unknown }>): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (message.role !== "assistant") continue;
		const blocks = (message.content ?? []) as Array<Record<string, unknown>>;
		const text = blocks
			.filter((block) => block.type === "text")
			.map((block) => String(block.text ?? ""))
			.join("")
			.trim();
		if (text) return text;
	}
	return "";
}
