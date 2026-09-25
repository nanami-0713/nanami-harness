/**
 * 记忆压缩（M2a）。挂 pi-agent-core 的 prepareNextTurnWithContext 钩子：
 * 每个新 turn 开始前检查上次 usage.totalTokens 是否越过阈值（contextWindow × ratio），
 * 越线就把"摘要 + 最近尾部"整体换进上下文。
 *
 * 安全边界：切分点只会落在 user 或 assistant 消息上 —— assistant(toolCall) 与其
 * toolResult 是一体，切开会导致 provider 报错，所以从尾部圈出 keepRecent 预算后
 * 再向前吞掉连续的 toolResult，保证头部/尾部断口干净。
 *
 * 简化声明：摘要一次性生成、原史前史不另存（会话文件存的是压缩后视图）。
 */
import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai";

export interface CompactorOptions {
	thresholdRatio: number;
	keepRecentTokens: number;
}

export class Compactor {
	constructor(
		private readonly deps: {
			models: MutableModels;
			model: Model<Api>;
			/** 当前模型（切模型后跟随） */
			getModel?: () => Model<Api>;
			/** key 归属校验后的取 key 函数（跨 provider 切换后自动让位 env 认证） */
			getApiKey?: () => string | undefined;
			apiKey?: string;
		},
		private readonly options: CompactorOptions,
	) {}

	/** 以最近一次 assistant usage 为上下文占用的真值；没有 usage 时按字符数估 */
	shouldTrigger(messages: AgentMessage[], contextWindow: number): boolean {
		const used = lastTotalTokens(messages) ?? estimateByChars(messages);
		return used > contextWindow * this.options.thresholdRatio;
	}

	async compact(messages: AgentMessage[]): Promise<AgentMessage[]> {
		const cut = this.findCutIndex(messages);
		if (cut <= 0) return messages; // 尾部已覆盖全部（或空），无从压缩

		const head = messages.slice(0, cut);
		const tail = messages.slice(cut);
		const summary = await this.summarize(head);

		// 摘要以 user 消息形式回注：所有 provider 都接受，且天然是合法切分点
		const summaryMessage: AgentMessage = {
			role: "user",
			content: `[系统压缩] 以下是此前对话的摘要（原始细节已折叠，最近 ${tail.length} 条消息原样保留）：\n\n${summary}`,
			timestamp: Date.now(),
		} as AgentMessage;

		return [summaryMessage, ...tail];
	}

	/**
	 * 从尾部按 keepRecentTokens 预算圈出保留区起点，再向前吞掉连续 toolResult
	 * （保证 assistant→toolResult 链不跨断口）。返回值 ≤ 消息数。
	 */
	private findCutIndex(messages: AgentMessage[]): number {
		let budget = this.options.keepRecentTokens;
		let index = messages.length;
		while (index > 0) {
			const message = messages[index - 1]!;
			budget -= estimateMessageTokens(message);
			if (budget < 0) break;
			index--;
		}
		// 防御：预算小到一条都装不下时，至少保住最后一条，避免全量摘要
		if (index === messages.length && messages.length > 0) {
			index = messages.length - 1;
		}
		// 断口不能落在 toolResult 上（会把 assistant→result 链切开）：
		// 向头扩到链首，或向尾收 到链尾，取代价最小的方向
		while (index > 0 && (messages[index] as { role?: string })?.role === "toolResult") {
			index--;
		}
		while (index < messages.length && (messages[index] as { role?: string })?.role === "toolResult") {
			index++;
		}
		return index;
	}

	/**
	 * 摘要走子 Agent 通道（同 subagent 的接线）：让 pi 的 loop 负责上下文组装，
	 * 绕开手工构造 TranscriptContext 会踩的 adapter 契约。
	 */
	private async summarize(head: AgentMessage[]): Promise<string> {
		const summarizer = new Agent({
			initialState: {
				systemPrompt:
					"你是对话压缩器。把编码会话的历史压缩成事实摘要，供后续对话续接。保留：用户的目标与决策、已完成的操作及其结果、重要文件路径与命令、未完成的事项与遗留问题。不保留寒暄与重复内容。中文输出，500 字以内。",
				model: this.deps.getModel?.() ?? this.deps.model,
				tools: [],
				messages: [],
			},
			streamFn: (m, context, options) => this.deps.models.streamSimple(m, context, options),
			...(this.deps.getApiKey ? { getApiKey: this.deps.getApiKey } : {}),
		});
		await summarizer.prompt(`请压缩以下会话历史：\n\n${serializeHead(head)}`);
		return extractText(summarizer.state.messages) || "(摘要生成失败，保留空摘要继续)";
	}
}

export function contextWindowOf(model: Model<Api>): number {
	return (model as { contextWindow?: number }).contextWindow ?? 128_000;
}

function lastTotalTokens(messages: AgentMessage[]): number | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as { role?: string; usage?: { totalTokens?: number } };
		if (message.role === "assistant" && message.usage?.totalTokens) {
			return message.usage.totalTokens;
		}
	}
	return undefined;
}

function estimateByChars(messages: AgentMessage[]): number {
	return Math.round(messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0));
}

/** 粗估：4 字符 ≈ 1 token，够做阈值判断 */
function estimateMessageTokens(message: AgentMessage): number {
	return Math.ceil(serializeMessage(message).length / 4);
}

function serializeHead(head: AgentMessage[]): string {
	const parts = head.map((m) => serializeMessage(m));
	const text = parts.join("\n\n");
	// 摘要输入自身也不能无限大：截到 30k 字符
	return text.length > 30_000 ? `${text.slice(0, 30_000)}\n…(已截断)` : text;
}

function serializeMessage(message: AgentMessage): string {
	const m = message as {
		role?: string;
		content?: unknown;
		isError?: boolean;
	};
	const role = m.role ?? "unknown";
	if (typeof m.content === "string") return `${role}: ${m.content}`;
	if (!Array.isArray(m.content)) return `${role}: (非文本消息)`;
	const lines: string[] = [];
	for (const block of m.content as Array<Record<string, unknown>>) {
		switch (block.type) {
			case "text":
				lines.push(`${role}: ${truncate(String(block.text ?? ""))}`);
				break;
			case "thinking":
				break; // 思考块不进摘要
			case "toolCall":
				lines.push(`${role}: 调用工具 ${block.name}(${truncate(JSON.stringify(block.arguments ?? {}), 300)})`);
				break;
			case "toolResult":
				lines.push(`工具结果${m.isError ? "(错误)" : ""}: ${truncate(String((block as { text?: string }).text ?? ""), 300)}`);
				break;
			default:
				lines.push(`${role}: (${String(block.type)})`);
		}
	}
	return lines.join("\n") || `${role}: (空)`;
}

function truncate(text: string, max = 500): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function extractText(messages: unknown): string {
	if (!Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as { role?: string; content?: unknown };
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		const text = message.content
			.filter((block) => (block as { type?: string })?.type === "text")
			.map((block) => String((block as { text?: string }).text ?? ""))
			.join("")
			.trim();
		if (text) return text;
	}
	return "";
}
