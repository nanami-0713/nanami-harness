/**
 * 全局配置与结果类型。
 * 设计原则：程序化配置优先（这是个库），JSON 配置文件的壳留给以后。
 */
import type { AgentEvent, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { CustomProviderConfig, UserConfig } from "./providers.js";
import type { ComputerConfig } from "./tools-computer.js";

export type { ComputerConfig };

/** pi-coding-agent 工具工厂覆盖的内置工具名（均可按需启停） */
export type BuiltinToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";

/** 会话累计计时（毫秒）。ttftSum/ttftN 用于平均首 token 延迟；genMs/outTok 用于吞吐 */
export interface SessionStats {
	llmMs: number;
	toolMs: number;
	ttftSum: number;
	ttftN: number;
	genMs: number;
	outTok: number;
}

/** 上下文组装：AGENTS.md 与技能目录的自定义路径 */
export interface ContextConfig {
	agentsFiles?: string[];
	skillDirs?: string[];
}

/** 沙箱策略（硬层，与审批软层独立）。false 关闭 */
export interface SandboxPolicyConfig {
	/** workspace = bash 写仅限工作区与系统临时目录；off = 不限 */
	fs?: "off" | "workspace";
	network?: "allow" | "deny";
}

/** 四档权限模式，语义对齐 ZCode/Claude Code 的习惯 */
export type PermissionMode = "readonly" | "default" | "acceptEdits" | "bypass";

export interface PermissionConfig {
	mode?: PermissionMode;
	/** 交互式审批：false 时所有 "ask" 降级为 deny（fail-closed）。缺省 true */
	interactive?: boolean;
	/**
	 * 自定义审批通道（Web UI 注入浏览器审批）。给了它，TTY 检查自动豁免。
	 * 缺省 = 终端问答（y/n/a）。
	 */
	asker?: (toolName: string, reason: string | undefined, args: unknown) => Promise<"allow" | "deny" | "always">;
}

/** MCP server 配置：stdio 子进程或 streamable-http 端点 */
export type McpServerConfig =
	| { command: string; args?: string[]; env?: Record<string, string> }
	| { url: string; headers?: Record<string, string> };

/**
 * 原生命令钩子：每条命令用 `bash -c` 执行，payload 以 JSON 从 stdin 喂入。
 * preToolCall 的裁决方式：exit 2 = 阻断（stderr 为理由）；stdout 输出 JSON {block, reason} 亦可。
 * 与 Claude Code 事件的对应：PreToolUse→preToolCall，PostToolUse→postToolCall，Stop→runEnd。
 */
export interface HookConfig {
	preToolCall?: string[];
	postToolCall?: string[];
	runEnd?: string[];
}

/** Jev（TypeSafe System One）决策模型直调；false 关闭该工具。默认开启 */
export interface JevConfig {
	/** API base，默认 https://api.typesafe.ai */
	baseUrl?: string;
	/** 模型名，默认 jev-latest（官方别名自动跟新；裸 "jev" 不是合法 model 名） */
	model?: string;
	/** 显式 key；缺省 env TYPESAFE_API_KEY → TYPESAFE_API_KEY_FILE → ~/.typesafe-api-key（每次调用现读） */
	apiKey?: string;
	/** 单次请求超时，默认 120s，上限 300s */
	timeoutMs?: number;
}

export interface CompactionConfig {
	/** 触发阈值：上次 usage.totalTokens 超过 contextWindow * ratio 时压缩，默认 0.8 */
	thresholdRatio?: number;
	/** 尾部保留预算（token），这段最近历史不参与摘要，默认 20000 */
	keepRecentTokens?: number;
}

export interface NanmiConfig {
	provider: string;
	modelId: string;
	/** 初始推理强度；缺省 = 模型默认。可被会话内 /api/thinking 随时覆盖 */
	thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	/** 编程注入的自定义 OpenAI 兼容端点（等价于 ~/.nanmi/config.json 的 customProviders） */
	customProviders?: CustomProviderConfig[];
	/** 覆盖 ~/.nanmi/config.json 的用户配置（测试/嵌入用） */
	userConfig?: UserConfig;
	systemPrompt: string;
	cwd?: string;
	apiKey?: string;
	/** 内置工具子集；缺省 = 全部七件。false = 不装内置（只用 customTools/mcp/subagent） */
	tools?: BuiltinToolName[] | false;
	/** 自建工具（todo_write 已默认内置；这里放额外的） */
	customTools?: AgentTool<any, any>[];
	permission?: PermissionConfig;
	/** 会话持久化。resumeId 缺省 = 新会话；给了 = 恢复历史消息 */
	session?: { dir?: string; resumeId?: string };
	/** 记忆压缩；false 关闭。默认开启 */
	compaction?: CompactionConfig | false;
	/** 沙箱（硬层）：bash 进程级文件写/网络约束。false 关闭。默认关闭（opt-in） */
	sandbox?: SandboxPolicyConfig | false;
	/** 上下文组装：AGENTS.md 与技能目录自定义 */
	context?: ContextConfig;
	/** 子代理工具；false 关闭。默认开启 */
	subagent?: { timeoutMs?: number } | false;
	/** Jev 决策工具（jev_decide）；false 关闭。默认开启 */
	jev?: JevConfig | false;
	/** 电脑控制（computer，Codex 式视觉-动作回路）；false 关闭。默认开启（权限门兜底） */
	computer?: ComputerConfig | false;
	mcp?: Record<string, McpServerConfig>;
	hooks?: HookConfig;
	/** 主循环单次 run 的超时保险丝，默认 180s */
	timeoutMs?: number;
}

export interface RunResult {
	/** 最终助手文本 = 全部 text_delta 拼接 */
	text: string;
	/** 本轮结束时的完整上下文（可能已被压缩改写） */
	messages: AgentMessage[];
	/** 本轮新增的消息 */
	newMessages: AgentMessage[];
	/** 全部事件（调试/审计/回放） */
	events: AgentEvent[];
	/** 会话 id（开了 session 才有） */
	sessionId?: string;
}
