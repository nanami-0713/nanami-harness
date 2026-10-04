/**
 * 记忆压缩（M2a）。挂 pi-agent-core 的 prepareNextTurnWithContext 钩子：
 * 每个新 turn 开始前检查上次 usage.totalTokens 是否越过阈值（contextWindow × ratio），
 * 越线就把"摘要 + 最近尾部"整体换进上下文。
 *
 * 安全边界：切分点只会落在 user 或 assistant 消息上 —— assistant(toolCall) 与其
 * toolResult 是一体，切开会导致 provider 报错，所以从尾部圈出 keepRecent 预算后
 * 再向前吞掉连续的 toolResult，保证头部/尾部断口干净。
 *
 * 前缀纪律（参照 DSH）：
 * - 若前导存在 system 消息（pi 新版把 systemPrompt+tools 折在 messages[0]），
 *   它永不参与压缩 —— 丢了它，会话从此没有 persona/AGENTS.md/技能目录。
 *   （现装 pi 0.85.1 的 systemPrompt 是 Context 独立字段，不在 messages 里，
 *   此守卫为升级到折叠式 pi 的前向兼容。）
 * - 摘要请求构造成主对话的"真前缀"（同 system + 同工具面 + 头部原消息 + 末尾
 *   一条指令），provider 侧 KV cache 对这段前缀直接命中，摘要按缓存价计费，
 *   且全文保真无截断。
 *
 * 简化声明：摘要一次性生成、原史前史不另存（会话文件存的是压缩后视图）。
 */
import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai";

export interface CompactorOptions {
	thresholdRatio: number;
	keepRecentTokens: number;
}

export interface CompactorDeps {
	models: MutableModels;
	model: Model<Api>;
	/** 当前模型（切模型后跟随） */
	getModel?: () => Model<Api>;
	/** key 归属校验后的取 key 函数（跨 provider 切换后自动让位 env 认证） */
	getApiKey?: () => string | undefined;
	apiKey?: string;
	/** 主对话的 system prompt：真前缀摘要请求逐字节复用它；缺省时退回独立压缩器 */
	systemPrompt?: string;
	/** 主对话的工具面：真前缀摘要请求带同款声明（只声明不执行）；缺省时退回独立压缩器 */
	tools?: AgentTool[];
}

export class Compactor {
	constructor(
		private readonly deps: CompactorDeps,
		private readonly options: CompactorOptions,
	) {}

	/** 以最近一次 assistant usage 为上下文占用的真值；没有 usage 时按字符数估 */
	shouldTrigger(messages: AgentMessage[], contextWindow: number): boolean {
		const used = lastTotalTokens(messages) ?? estimateByChars(messages);
		return used > contextWindow * this.options.thresholdRatio;
	}

	async compact(messages: AgentMessage[]): Promise<AgentMessage[]> {
		// 前导 system 消息（pi 把 systemPrompt+tools 折在 messages[0]）留在原地
		const leading: AgentMessage[] = [];
		let start = 0;
		if ((messages[0] as { role?: string } | undefined)?.role === "system") {
			leading.push(messages[0]!);
			start = 1;
		}

		const cut = this.findCutIndex(messages, start);
		if (cut <= start) return messages; // 尾部已覆盖全部对话（或空），无从压缩

		const head = messages.slice(start, cut);
		const tail = messages.slice(cut);
		const summary = await this.summarize(head);

		// 摘要以 user 消息形式回注：所有 provider 都接受，且天然是合法切分点
		const summaryMessage: AgentMessage = {
			role: "user",
			content: `[系统压缩] 以下是此前对话的摘要（原始细节已折叠，最近 ${tail.length} 条消息原样保留）：\n\n${summary}`,
			timestamp: Date.now(),
		} as AgentMessage;

		return [...leading, summaryMessage, ...tail];
	}

	/**
	 * 从尾部按 keepRecentTokens 预算圈出保留区起点，再向前吞掉连续 toolResult
	 * （保证 assistant→toolResult 链不跨断口）。返回值 ∈ [floor, 消息数]。
	 */
	private findCutIndex(messages: AgentMessage[], floor: number): number {
		let budget = this.options.keepRecentTokens;
		let index = messages.length;
		while (index > floor) {
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
		while (index > floor && (messages[index] as { role?: string })?.role === "toolResult") {
			index--;
		}
		while (index < messages.length && (messages[index] as { role?: string })?.role === "toolResult") {
			index++;
		}
		return index;
	}

	/**
	 * 摘要走"真前缀"请求：Context 复用主对话的 systemPrompt 与工具面（同一数组
	 * 引用，序列化逐字节一致），messages = [头部原消息..., 指令]。前缀与上一条
	 * 主请求一致，provider 的 KV cache 直接命中。streamSimple 是裸 provider 调用，
	 * 只序列化工具 schema、永不执行工具。真前缀路径不可用（缺 system/tools）或
	 * 请求失败时，退回独立压缩器子代理。
	 */
	private async summarize(head: AgentMessage[]): Promise<string> {
		const systemPrompt = this.deps.systemPrompt;
		const tools = this.deps.tools;
		if (!systemPrompt || !tools || tools.length === 0) {
			return this.legacySummarize(head);
		}
		const instruction: AgentMessage = {
			role: "user",
			content:
				"以上是即将被压缩的对话历史。请直接输出一份中文事实摘要（500 字以内），供后续对话续接。" +
				"保留：用户的目标与决策、已完成的操作及其结果、重要文件路径与命令、未完成的事项与遗留问题。" +
				"不要调用任何工具，只输出摘要文本本身。",
			timestamp: Date.now(),
		} as AgentMessage;
		try {
			const apiKey = this.deps.getApiKey?.() ?? this.deps.apiKey;
			// 与主循环 defaultConvertToLlm 同款过滤：非对话消息本来就不进主请求，
			// 滤掉它们才谈得上"前缀与主请求一致"
			const llmHead = head.filter(
				(m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
			);
			const message = await this.deps.models
				.streamSimple(
					this.deps.getModel?.() ?? this.deps.model,
					{
						systemPrompt,
						tools,
						messages: [...llmHead, instruction] as unknown as Parameters<
							MutableModels["streamSimple"]
						>[1]["messages"],
					},
					{ ...(apiKey !== undefined ? { apiKey } : {}) },
				)
				.result();
			const text = extractText([message]);
			return text || this.legacySummarize(head);
		} catch {
			return this.legacySummarize(head);
		}
	}

	/**
	 * 兜底：独立压缩器子代理（同 subagent 接线，pi loop 负责上下文组装）。
	 * 前缀与主对话无关（冷启动），仅在真前缀路径不可用时使用。
	 */
	private async legacySummarize(head: AgentMessage[]): Promise<string> {
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
