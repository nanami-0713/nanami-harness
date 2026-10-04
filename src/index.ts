/**
 * @nanmi/harness —— 个人 harness（M1-M3 完整版）
 *
 * 分层：L0 pi-ai（模型路由）→ L1 pi-agent-core（loop）→ 本包（L2 你的 harness）。
 * 不 fork 上游：定制全部放在本层，上游升级只受公共 API 面约束（版本钉 exact）。
 *
 * M1 工具面 + 权限 + 会话   ：src/tools.ts / permissions.ts / session.ts
 * M2 压缩 + 子代理         ：src/compaction.ts / subagent.ts
 * M3 MCP 桥 + hooks        ：src/mcp.ts / hooks.ts
 *
 * 组装顺序即依赖顺序：models → 工具（builtin/todo/custom/subagent/mcp）→
 * 钩子链（hooks.pre → permission）→ 压缩钩子 → 会话恢复/落盘。
 */
import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { MutableModels } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";
import { buildModels, loadUserConfig } from "./providers.js";
import type { UserConfig } from "./providers.js";
import { buildSystemPrompt, createSkillTool, discoverSkills, loadAgentsFiles } from "./context.js";
import { Sandbox, createSandboxedBashTool } from "./sandbox.js";
import { Compactor, contextWindowOf } from "./compaction.js";
import { HookRunner } from "./hooks.js";
import { loadExtensions } from "./plugins.js";
import { McpBridge } from "./mcp.js";
import { PermissionGate } from "./permissions.js";
import { SessionStore } from "./session.js";
import { createSubagentTool } from "./subagent.js";
import { BUILTIN_TOOL_NAMES, buildBuiltinTools } from "./tools.js";
import { createComputerTool } from "./tools-computer.js";
import { createJevTool } from "./tools-jev.js";
import { createTodoTool } from "./tools-todo.js";
import type { NanmiConfig, RunResult, PermissionMode, HookConfig } from "./types.js";

export type { NanmiConfig, RunResult, PermissionMode, JevConfig, HookConfig, ComputerConfig, SessionStats } from "./types.js";
export type { CustomProviderConfig, UserConfig } from "./providers.js";
export { loadUserConfig, loadCredentialsIntoEnv, buildModels, catalog } from "./providers.js";
export { loadMcpServers, loadPlugins, loadExtensions, type PluginManifest } from "./plugins.js";
export { createJevTool, type JevCallDetails } from "./tools-jev.js";
export { createComputerTool, type ComputerDetails } from "./tools-computer.js";
export { SessionStore, type SessionMeta } from "./session.js";
export { PermissionGate } from "./permissions.js";
export { resolveApiKey } from "./key.js";

const DEFAULT_SESSION_DIR = ".nanmi/sessions";
const DEFAULT_RUN_TIMEOUT_MS = 180_000;

export class NanmiHarness {
	readonly sessionId?: string;
	readonly models: MutableModels;

	private readonly agent: Agent;
	private readonly session?: SessionStore;
	private readonly hooks: HookRunner;
	private readonly mcp?: McpBridge;
	private readonly gate: PermissionGate;
	private provider: string;
	/** 共享模型槽：主 Agent state、压缩摘要器、子代理都从这里取当前模型 */
	private readonly modelHolder: { current: Model<Api> };
	private readonly scopedGetApiKey: (() => string | undefined) | undefined;
	private apiKey?: string;
	private readonly runTimeoutMs: number;

	private constructor(
		agent: Agent,
		deps: {
			models: MutableModels;
			provider: string;
			modelHolder: { current: Model<Api> };
			scopedGetApiKey?: () => string | undefined;
			apiKey?: string;
			session?: SessionStore;
			hooks: HookRunner;
			mcp?: McpBridge;
			gate: PermissionGate;
			runTimeoutMs: number;
		},
	) {
		this.agent = agent;
		this.models = deps.models;
		this.provider = deps.provider;
		this.modelHolder = deps.modelHolder;
		this.scopedGetApiKey = deps.scopedGetApiKey;
		this.apiKey = deps.apiKey;
		this.session = deps.session;
		this.hooks = deps.hooks;
		this.mcp = deps.mcp;
		this.gate = deps.gate;
		this.runTimeoutMs = deps.runTimeoutMs;
		this.sessionId = deps.session?.id;
	}

	/** 会话存储（Web 宿主做 rename/archive 用）；没开会话时为 undefined */
	get sessionStore(): SessionStore | undefined {
		return this.session;
	}

	static async create(config: NanmiConfig): Promise<NanmiHarness> {
		const cwd = config.cwd ?? process.cwd();
		// ── 模型面（M-A）：内置 40 家 + ~/.nanmi/config.json 自定义端点，凭据先装 env ──
		const userConfig: UserConfig = { ...loadUserConfig(), ...(config.userConfig ?? {}) };
		if (config.customProviders?.length) {
			userConfig.customProviders = [...(userConfig.customProviders ?? []), ...config.customProviders];
		}
		const models = buildModels(userConfig) as MutableModels;
		const model = models.getModel(config.provider, config.modelId);
		if (!model) {
			throw new Error(`模型不存在: ${config.provider}/${config.modelId} —— id 以该 provider 的模型目录为准`);
		}
		// 共享模型槽：切模型后主 Agent / 压缩摘要器 / 子代理统一读这里
		const modelHolder: { current: Model<Api> } = { current: model };
		// 显式 key 只属于配置时的 provider；切到别家后让位给 pi-ai 的 env 认证
		const apiKey = config.apiKey;
		const apiKeyFor = config.provider;
		const scopedGetApiKey = apiKey
			? (): string | undefined => (modelHolder.current.provider === apiKeyFor ? apiKey : undefined)
			: undefined;

		// ── 扩展面（M-B/M-C）：mcp.json 双层 + ~/.nanmi/plugins/ ────────────────
		const ext = await loadExtensions(cwd);
		for (const warning of ext.warnings) console.error(`[nanmi:extensions] ${warning}`);
		if (ext.plugins.length) {
			const summary = ext.plugins
				.map((p) => `${p.name}${p.version ? "@" + p.version : ""}(${p.contributes.join(",") || "空"})`)
				.join("; ");
			console.error(`[nanmi:extensions] 已加载插件: ${summary}`);
		}

		// ── 上下文组装：AGENTS.md + Skills 渐进披露（M·上下文）────────────────
		// AGENTS.md 一次性注入 system prompt（前缀稳定=缓存友好）；技能只放目录，
		// 全文经 skill 工具按需加载。插件技能目录与 prompt 片段在此并入。
		const ctx = {
			agentsFiles: loadAgentsFiles(cwd, config.context?.agentsFiles),
			skills: discoverSkills(cwd, [...ext.skillDirs, ...(config.context?.skillDirs ?? [])]),
		};
		const systemPrompt =
			buildSystemPrompt(config.systemPrompt, ctx) +
			(ext.promptFragments.length ? `\n\n${ext.promptFragments.join("\n\n")}` : "");

		// ── 工具面：builtin + todo + skill + custom + subagent + mcp ─────────
		const sandboxCfg = config.sandbox === false ? undefined : config.sandbox;
		const builtinNames = config.tools === false ? [] : (config.tools ?? [...BUILTIN_TOOL_NAMES]);
		const useSandboxBash = !!sandboxCfg && (sandboxCfg.fs ?? "off") !== "off" && builtinNames.includes("bash");
		const nonBash = useSandboxBash ? builtinNames.filter((n) => n !== "bash") : builtinNames;
		const tools = [
			...buildBuiltinTools(cwd, nonBash),
			createTodoTool(cwd),
			...(config.customTools ?? []),
			...ext.tools,
		];
		if (config.jev !== false) {
			tools.push(createJevTool(config.jev));
		}
		if (config.computer !== false) {
			tools.push(createComputerTool(config.computer));
		}
		if (useSandboxBash && sandboxCfg) {
			tools.push(
				createSandboxedBashTool({
					cwd,
					sandbox: new Sandbox(
						{ fs: sandboxCfg.fs ?? "workspace", network: sandboxCfg.network ?? "deny" },
						cwd,
					),
				}),
			);
		}
		tools.push(createSkillTool(ctx.skills));
		if (config.subagent !== false) {
			tools.push(
				createSubagentTool({
					models,
					model,
					getModel: () => modelHolder.current,
					getApiKey: scopedGetApiKey,
					cwd,
					timeoutMs: config.subagent?.timeoutMs,
				}),
			);
		}

		// MCP：文件层（mcp.json + 插件）打底，编程传入同名覆盖
		const mcpConfig = { ...ext.mcpServers, ...(config.mcp ?? {}) };
		let mcp: McpBridge | undefined;
		if (Object.keys(mcpConfig).length > 0) {
			mcp = new McpBridge();
			tools.push(...(await mcp.connect(mcpConfig)));
		}

		// ── 会话：新建或恢复 ─────────────────────────────────────────────────
		const sessionDir = config.session?.dir ?? `${cwd}/${DEFAULT_SESSION_DIR}`;
		let session: SessionStore | undefined;
		let resumedMessages: AgentMessage[] = [];
		if (config.session) {
			if (config.session.resumeId) {
				const loaded = SessionStore.load(sessionDir, config.session.resumeId);
				if (!loaded) throw new Error(`会话不存在: ${config.session.resumeId}（目录 ${sessionDir}）`);
				session = SessionStore.reopen(sessionDir, loaded.meta);
				resumedMessages = loaded.view;
			} else {
				session = SessionStore.create(sessionDir, config.provider, config.modelId, cwd);
			}
		}

		// ── 钩子链与权限门 ───────────────────────────────────────────────────
		// 插件钩子打底、编程传入追加（多层都跑，exit 2 先到先断）
		const mergedHooks: HookConfig = {};
		for (const key of ["preToolCall", "postToolCall", "runEnd"] as const) {
			const cmds = [...(ext.hooks[key] ?? []), ...(config.hooks?.[key] ?? [])];
			if (cmds.length) mergedHooks[key] = cmds;
		}
		const hooks = new HookRunner(mergedHooks);
		const permission = new PermissionGate(config.permission, cwd);

		// ── 压缩器（挂在 prepareNextTurnWithContext）─────────────────────────
		const compactionConfig = config.compaction === false ? undefined : config.compaction;
		const compactor = compactionConfig === undefined && config.compaction === false ? undefined : new Compactor(
			{ models, model, getModel: () => modelHolder.current, getApiKey: scopedGetApiKey },
			{
				thresholdRatio: compactionConfig?.thresholdRatio ?? 0.8,
				keepRecentTokens: compactionConfig?.keepRecentTokens ?? 20_000,
			},
		);

		const agent = new Agent({
			initialState: {
				// 组装后的最终规范：基础 persona + AGENTS.md + 技能目录（稳定前缀，缓存友好）
				systemPrompt,
				model,
				tools,
				messages: resumedMessages,
				...(config.thinkingLevel ? { thinkingLevel: config.thinkingLevel } : {}),
			},
			// L1（loop）↔ L0（provider）的唯一接缝；换路由只改这一行
			streamFn: (m, context, options) => models.streamSimple(m, context, options),
			...(scopedGetApiKey ? { getApiKey: scopedGetApiKey } : {}),
			// 工具调用前的完整裁决链：hooks（可阻断）→ 权限门（allow/ask/deny）
			beforeToolCall: async (ctx) => {
				const hookBlock = await hooks.runPreTool({ toolName: ctx.toolCall.name, args: ctx.args });
				if (hookBlock) return { block: true, reason: hookBlock.reason };
				const denied = await permission.authorize(ctx.toolCall.name, ctx.args);
				if (denied) return { block: true, reason: denied };
				return undefined;
			},
			// 压缩：越过阈值就把"摘要 + 保留尾部"整体换进上下文，并写回 state 防止逐轮重压
			prepareNextTurnWithContext: async (ctx) => {
				if (!compactor) return undefined;
				if (!compactor.shouldTrigger(ctx.context.messages, contextWindowOf(modelHolder.current))) return undefined;
				const compacted = await compactor.compact(ctx.context.messages);
				agent.state.messages = compacted;
				console.error(
					`[nanmi:compaction] ${ctx.context.messages.length} 条消息压缩为 ${compacted.length} 条`,
				);
				return { context: { ...ctx.context, messages: compacted } };
			},
		});

		return new NanmiHarness(agent, {
			models,
			provider: config.provider,
			modelHolder,
			scopedGetApiKey,
			apiKey,
			session,
			hooks,
			mcp,
			gate: permission,
			runTimeoutMs: config.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
		});
	}

	/** 当前会话绑定的 provider */
	get providerName(): string {
		return this.provider;
	}

	/** 当前模型 id（agent.state.model 的回读） */
	get modelId(): string {
		return (this.agent.state.model as { id?: string }).id ?? "";
	}

	/** 当前 provider（切模型后跟随） */
	get currentProvider(): string {
		return this.provider;
	}

	/**
	 * 切换模型：写 state.model，下一条消息（下一次 prompt()）生效 ——
	 * pi 的 loop 每次 run 从 state 重取 model（agent.ts:464），中途不热切。
	 * 压缩摘要器与子代理经 modelHolder 同步跟进。
	 */
	setModel(modelId: string): void {
		this.setProviderModel(this.provider, modelId);
	}

	/** 跨 provider 切模型（M-A）：key 由各家 provider 的 env 认证层自理 */
	setProviderModel(provider: string, modelId: string): void {
		const model = this.models.getModel(provider, modelId);
		if (!model) throw new Error(`模型不存在: ${provider}/${modelId}`);
		this.provider = provider;
		this.agent.state.model = model;
		this.modelHolder.current = model;
	}

	/** 当前推理强度（pi 的 ThinkingLevel：minimal/low/medium/high/xhigh/max） */
	get thinkingLevel(): string {
		return (this.agent.state as { thinkingLevel?: string }).thinkingLevel ?? "";
	}

	/**
	 * 切换推理强度：写 state.thinkingLevel，与模型同为"下一条消息生效"。
	 * 是否真正生效取决于 provider 对该模型的 thinking 参数映射。
	 */
	setThinkingLevel(level: string): void {
		(this.agent.state as { thinkingLevel?: string }).thinkingLevel = level;
	}

	/** 当前权限模式 */
	get permissionMode(): PermissionMode {
		return this.gate.currentMode;
	}

	/** 运行时切权限模式（Web UI 的模式下拉框） */
	setPermissionMode(mode: PermissionMode): void {
		this.gate.setMode(mode);
	}

	/** 中止当前 run（Web UI 的停止按钮） */
	abort(): void {
		this.agent.abort();
	}

	/** 常驻事件汇（Web 宿主用）：订阅一次、跨 run 生效，返回退订函数 */
	attachEventSink(sink: (event: AgentEvent) => void): () => void {
		return this.agent.subscribe(sink);
	}

	/** 消息历史的 JSON 安全快照（转屏/多端同步用） */
	snapshotMessages(): AgentMessage[] {
		return JSON.parse(JSON.stringify(this.agent.state.messages)) as AgentMessage[];
	}

	/**
	 * 跑一轮对话（可能内含多次工具调用与压缩），阻塞到 agent 空闲。
	 * onEvent 是过程观察口；结束后按序落盘会话、触发 runEnd 钩子。
	 */
	async run(prompt: string, onEvent?: (event: AgentEvent) => void): Promise<RunResult> {
		const events: AgentEvent[] = [];
		let text = "";
		let abortedByTimeout = false;
		const countAtRunStart = this.agent.state.messages.length;
		// 工具参数只在 start 事件里出现，先记账，postToolCall 钩子要用
		const argsByCallId = new Map<string, unknown>();

		const timer = setTimeout(() => {
			abortedByTimeout = true;
			this.agent.abort();
		}, this.runTimeoutMs);

		const off = this.agent.subscribe((event) => {
			events.push(event);
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				text += event.assistantMessageEvent.delta;
			}
			if (event.type === "tool_execution_start") {
				argsByCallId.set(event.toolCallId, event.args);
			}
			if (event.type === "tool_execution_end") {
				void this.hooks.runPostTool({
					toolName: event.toolName,
					args: argsByCallId.get(event.toolCallId),
					isError: event.isError,
				});
			}
			onEvent?.(event);
		});

		try {
			await this.agent.prompt(prompt);
		} catch (err) {
			if (abortedByTimeout) throw new Error(`run 超时（>${this.runTimeoutMs}ms），已强制中止`);
			throw err;
		} finally {
			clearTimeout(timer);
			off();
		}

		const messages = this.agent.state.messages;
		// append-only 同步：视图前缀延伸=追加增量；压缩改头=追加检查点（物理史前史保留）
		this.session?.sync(messages);
		await this.hooks.runEnd({
			sessionId: this.sessionId,
			textLength: text.length,
			messageCount: messages.length,
		});

		return {
			text,
			messages,
			newMessages: messages.slice(countAtRunStart),
			events,
			sessionId: this.sessionId,
		};
	}

	/** 释放外部资源（MCP 连接等） */
	async dispose(): Promise<void> {
		await this.mcp?.dispose();
	}

	/** 旁路小任务：子 Agent 完成一次性文本任务（标题生成等），不经主循环、不带工具 */
	async complete(prompt: string, systemPrompt?: string): Promise<string> {
		const child = new Agent({
			initialState: {
				systemPrompt:
					systemPrompt ?? "你是助手。只输出被要求的内容本身，不要任何解释、引号或多余的话。",
				model: this.modelHolder.current,
				tools: [],
				messages: [],
			},
			streamFn: (m, context, options) => this.models.streamSimple(m, context, options),
			...(this.scopedGetApiKey ? { getApiKey: this.scopedGetApiKey } : {}),
		});
		await child.prompt(prompt);
		for (let i = child.state.messages.length - 1; i >= 0; i--) {
			const message = child.state.messages[i] as { role?: string; content?: unknown };
			if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
			const text = message.content
				.filter((b) => (b as { type?: string }).type === "text")
				.map((b) => String((b as { text?: string }).text ?? ""))
				.join("")
				.trim();
			if (text) return text;
		}
		return "";
	}
}
