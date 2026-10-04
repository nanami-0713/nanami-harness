/**
 * 沙箱（硬层）。审批（permissions.ts）是"做事前问你"，沙箱是"想越权也跑不动"——两层独立。
 *
 * 实现：
 *  - macOS：sandbox-exec（Seatbelt）生成策略文件——写仅限工作区 + 系统临时目录，
 *    可选拒网；读取默认放行（否则连解释器都起不来）。
 *  - Linux：bwrap（bubblewrap）参数化等价物；不可用则降级为透传 + 一次警告。
 *
 * 诚实边界（写进了策略文件注释与 README）：沙箱防的是"意外事故"（模型手滑 rm、写错目录），
 * 不防有意的逃逸；approval 仍然是人机之间的主层。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

export interface SandboxPolicy {
	/** workspace = 写仅限工作区与系统临时目录；off = 不限制文件写 */
	fs: "off" | "workspace";
	network: "allow" | "deny";
}

export type SandboxKind = "seatbelt" | "bwrap" | null;

export class Sandbox {
	readonly kind: SandboxKind;
	readonly policy: SandboxPolicy;
	readonly cwd: string;
	private readonly profileFile: string;
	private warned = false;

	constructor(policy: SandboxPolicy, cwd: string) {
		this.policy = policy;
		this.cwd = cwd;
		this.kind = Sandbox.detect();
		this.profileFile = join(cwd, ".nanami", "sandbox.sb");
		if (this.kind) this.writeProfile();
	}

	static detect(): SandboxKind {
		if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) return "seatbelt";
		if (process.platform === "linux" && bwrapAvailable()) return "bwrap";
		return null;
	}

	/** 是否有可用的强制层；没有则只保留审批软层（构造后警告一次） */
	get active(): boolean {
		return this.kind !== null;
	}

	/** 把命令的 argv 包上沙箱前缀；未启用/不可用时原样返回 */
	wrap(argv: string[]): string[] {
		if (this.policy.fs === "off" && this.policy.network === "allow") return argv;
		if (!this.kind) {
			if (!this.warned) {
				this.warned = true;
				console.error("[nanami:sandbox] 本机没有 sandbox-exec/bwrap，沙箱策略降级为透传（仅剩审批层）");
			}
			return argv;
		}
		if (this.kind === "seatbelt") return ["/usr/bin/sandbox-exec", "-f", this.profileFile, ...argv];
		// bwrap：/ 只读，工作区与 /tmp 可写，可选断网
		const args = [
			"bwrap",
			"--ro-bind", "/", "/",
			"--bind", this.cwd, this.cwd,
			"--bind", "/tmp", "/tmp",
			"--dev", "/dev",
			"--proc", "/proc",
		];
		if (this.policy.network === "deny") args.push("--unshare-net");
		return [...args, ...argv];
	}

	private writeProfile(): void {
		const dir = join(this.cwd, ".nanami");
		mkdirSync(dir, { recursive: true });
		const denyNet = this.policy.network === "deny" ? "\n(deny network*)" : "";
		const fsRules =
			this.policy.fs === "workspace"
				? `
; 写仅限：工作区 + 系统临时目录（其余文件系统只读）
(deny file-write*)
(allow file-write*
	(subpath "${this.cwd}")
	(subpath "/private/tmp")
	(subpath "/private/var/folders")
	(literal "/dev/null")
	(literal "/dev/urandom"))`
				: "";
		// nanami-harness 沙箱策略：防意外事故，不防有意逃逸；人事仍由审批层把关
		const profile = `(version 1)
(allow default)${denyNet}${fsRules}
`;
		writeFileSync(this.profileFile, profile);
	}
}

function bwrapAvailable(): boolean {
	try {
		execFileSync("bwrap", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

const bashSchema = Type.Object({
	command: Type.String({ description: "要执行的 bash 命令" }),
});

export interface SandboxBashOptions {
	cwd: string;
	sandbox: Sandbox;
	timeoutMs?: number;
}

/** 沙箱化 bash 工具：命令经 Sandbox.wrap 包裹后执行，输出截断，超时中止 */
export function createSandboxedBashTool(opts: SandboxBashOptions): AgentTool<typeof bashSchema, { ms: number }> {
	const timeoutMs = opts.timeoutMs ?? 120_000;
	return {
		name: "bash",
		label: "Bash",
		description: `在沙箱中执行 bash 命令（工作目录 ${opts.cwd}；文件写与网络受沙箱策略约束）。`,
		parameters: bashSchema,
		execute: async (_id, params) => {
			const started = Date.now();
			const argv = opts.sandbox.wrap(["bash", "-c", params.command]);
			const proc = spawnSync(argv[0], argv.slice(1), {
				cwd: opts.cwd,
				encoding: "utf8",
				timeout: timeoutMs,
				maxBuffer: 4 * 1024 * 1024,
			});
			const out = [proc.stdout, proc.stderr].filter(Boolean).join("\n").trim();
			const truncated = out.length > 30_000 ? `${out.slice(0, 30_000)}…(截断)` : out;
			if (proc.error) throw new Error(String(proc.error.message ?? proc.error));
			const ms = Date.now() - started;
			const exitNote = proc.status === 0 ? "" : `\n(退出码 ${proc.status})`;
			return {
				content: [{ type: "text", text: `${truncated}${exitNote}` || "(无输出)" }],
				details: { ms },
			};
		},
	};
}

/** 探测本机沙箱能力（设置页展示用） */
export function sandboxProbe(): string {
	const kind = Sandbox.detect();
	if (kind === "seatbelt") return "macOS Seatbelt (sandbox-exec)";
	if (kind === "bwrap") return "Linux bubblewrap (bwrap)";
	return "无（仅审批层）";
}
