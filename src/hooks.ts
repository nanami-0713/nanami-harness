/**
 * 原生命令钩子（M3b）。轻量自有实现（ZCode 侧本无存量 hooks 需要迁移，
 * 所以不做 CC 全格式兼容，只留事件语义映射：PreToolUse→preToolCall、
 * PostToolUse→postToolCall、Stop→runEnd，将来要兼容再包一层适配器）。
 *
 * 约定：每条命令以 `bash -c <cmd>` 执行，payload 以 JSON 从 stdin 喂入，10s 超时。
 * preToolCall 的裁决：exit 2 = 阻断（stderr 为理由）；stdout 输出 JSON {block, reason} 亦可；
 * 其余情形一律放行（观察者钩子随便写日志）。
 */
import { spawn } from "node:child_process";
import type { HookConfig } from "./types.js";

const HOOK_TIMEOUT_MS = 10_000;

export class HookRunner {
	constructor(private readonly config: HookConfig | undefined) {}

	/** 返回 undefined = 放行；返回对象 = 阻断（含理由） */
	async runPreTool(payload: { toolName: string; args: unknown }): Promise<{ block: true; reason: string } | undefined> {
		for (const cmd of this.config?.preToolCall ?? []) {
			const { code, stdout, stderr } = await runCommand(cmd, payload);
			if (code === 2) {
				return { block: true, reason: stderr.trim() || `被 preToolCall 钩子阻断（exit 2）` };
			}
			const parsed = parseJson(stdout) as { block?: boolean; reason?: string } | null;
			if (parsed?.block) {
				return { block: true, reason: parsed.reason ?? "被 preToolCall 钩子阻断" };
			}
		}
		return undefined;
	}

	async runPostTool(payload: { toolName: string; args: unknown; isError: boolean }): Promise<void> {
		for (const cmd of this.config?.postToolCall ?? []) {
			await runCommand(cmd, payload);
		}
	}

	async runEnd(payload: { sessionId?: string; textLength: number; messageCount: number }): Promise<void> {
		for (const cmd of this.config?.runEnd ?? []) {
			await runCommand(cmd, payload);
		}
	}
}

function runCommand(
	cmd: string,
	payload: unknown,
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn("bash", ["-c", cmd], {
			stdio: ["pipe", "pipe", "pipe"],
			timeout: HOOK_TIMEOUT_MS,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
		child.on("error", () => resolve({ code: 127, stdout, stderr: stderr || "钩子进程启动失败" }));
		child.stdin.end(JSON.stringify(payload));
	});
}

function parseJson(text: string): unknown | null {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}
