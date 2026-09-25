/**
 * 权限门（M1b）。pi 官方不做权限系统，这是 harness 的自有实现。
 *
 * 四档模式（语义对齐 ZCode/Claude Code）：
 *   readonly    —— 只读工具放行，其余一律 deny
 *   default     —— 只读放行；bash/edit/write/MCP 全部 ask
 *   acceptEdits —— cwd 内的 edit/write 放行；bash 与 MCP 仍然 ask
 *   bypass      —— 全放行（冒烟/自动化用）
 *
 * ask 的落地是可注入的：缺省 = 终端问答（y/n/a）；Web UI 注入浏览器审批 asker。
 * 返回三态 allow/deny/always（always = 本会话该工具全部放行）。
 * 非交互（interactive:false）一律 deny —— fail-closed，绝不静默放行。
 */
import { createInterface } from "node:readline/promises";
import type { PermissionConfig, PermissionMode } from "./types.js";
import { isReadonlyTool } from "./tools.js";

/** 高危 bash 命令模式：即使在 acceptEdits 下也要在理由里点名 */
const DANGEROUS_BASH: RegExp[] = [
	/\brm\s+(-rf?|--recursive)/i,
	/\bsudo\b/i,
	/\b(chmod|chown)\b.*777/i,
	/\bmkfs\b/i,
	/\bdd\b[^|]*\bof=/i,
	/\bcurl\b[^|]*\|\s*(ba)?sh/i,
	/\bgit\s+push\s+--force/i,
];

export type AskGrant = "allow" | "deny" | "always";
export type AskFn = (toolName: string, reason: string | undefined, args: unknown) => Promise<AskGrant>;

export interface PermissionDecision {
	decision: "allow" | "ask" | "deny";
	reason?: string;
}

export class PermissionGate {
	private mode: PermissionMode;
	private readonly interactive: boolean;
	private readonly cwd: string;
	private readonly asker: AskFn | undefined;
	/** 会话级放行（用户在问答里选了 a / always） */
	private readonly sessionAllowed = new Set<string>();

	constructor(config: PermissionConfig | undefined, cwd: string) {
		this.mode = config?.mode ?? "default";
		this.asker = config?.asker;
		// 有注入 asker 时跳过 TTY 检查（Web 宿主进程没有终端，但审批仍然可用）
		this.interactive =
			(config?.interactive ?? true) && (this.asker ? true : process.stdin.isTTY === true);
		this.cwd = cwd;
	}

	/** 运行时切档（Web UI 的模式下拉框） */
	setMode(mode: PermissionMode): void {
		this.mode = mode;
	}

	get currentMode(): PermissionMode {
		return this.mode;
	}

	/** 纯函数裁决：不碰终端/网络，方便单测与审计 */
	check(toolName: string, args: unknown): PermissionDecision {
		if (this.mode === "bypass" || this.sessionAllowed.has(toolName)) {
			return { decision: "allow" };
		}

		const readonlyTool = isReadonlyTool(toolName);
		const mutating = !readonlyTool;

		if (this.mode === "readonly") {
			return mutating
				? { decision: "deny", reason: `只读模式：禁止调用 ${toolName}` }
				: { decision: "allow" };
		}

		if (readonlyTool) return { decision: "allow" };

		if (this.mode === "acceptEdits" && (toolName === "edit" || toolName === "write")) {
			const path = (args as { file_path?: string; path?: string })?.file_path
				?? (args as { path?: string })?.path;
			if (path && !path.startsWith(this.cwd)) {
				return { decision: "ask", reason: `写入目标在 cwd 之外：${path}` };
			}
			return { decision: "allow" };
		}

		// default 与 acceptEdits 下的 bash/MCP：ask；危险命令在理由里点名
		const danger = toolName === "bash" && isDangerousBash(args);
		return {
			decision: "ask",
			reason: danger
				? "高危命令"
				: this.mode === "default"
					? `default 模式：${toolName} 需要确认`
					: `${toolName} 需要确认`,
		};
	}

	/** ask 的落地：注入 asker（Web）或终端问答；非交互绝不走到这里（check 已降级为 deny） */
	async ask(toolName: string, reason: string | undefined, args: unknown): Promise<boolean> {
		if (!this.interactive) return false;
		const grant = this.asker
			? await this.asker(toolName, reason, args)
			: await terminalAsk(toolName, reason);
		if (grant === "always") {
			this.sessionAllowed.add(toolName);
			return true;
		}
		return grant === "allow";
	}

	/** check + ask 的一体化入口：返回 undefined 表示放行，否则返回阻断理由 */
	async authorize(toolName: string, args: unknown): Promise<string | undefined> {
		const { decision, reason } = this.check(toolName, args);
		if (decision === "allow") return undefined;
		if (decision === "deny") return reason ?? `已被权限门拒绝：${toolName}`;
		const granted = await this.ask(toolName, reason, args);
		return granted ? undefined : `用户拒绝了 ${toolName} 调用`;
	}
}

/** 缺省 asker：终端问答 */
async function terminalAsk(toolName: string, reason: string | undefined): Promise<AskGrant> {
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	try {
		const answer = await rl.question(
			`⚠️  ${reason ?? `允许调用 ${toolName}`}\n   [y]允许 [n]拒绝 [a]本会话始终允许 —— `,
		);
		const normalized = answer.trim().toLowerCase();
		if (normalized === "a") return "always";
		return normalized === "y" || normalized === "yes" ? "allow" : "deny";
	} finally {
		rl.close();
	}
}

function isDangerousBash(args: unknown): boolean {
	const command = (args as { command?: string })?.command;
	if (typeof command !== "string") return false;
	return DANGEROUS_BASH.some((pattern) => pattern.test(command));
}
