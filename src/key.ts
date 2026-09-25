/**
 * API key 解析。安全纪律：key 只进内存与环境变量，绝不打印、绝不落日志。
 */
import { readFileSync } from "node:fs";

const DSH_CREDENTIALS = `${process.env.HOME}/.dsh/.credentials.yaml`;

/**
 * 解析顺序：环境变量 → DSH 凭据库（~/.dsh/.credentials.yaml 的 refs）。
 * 与 pi-ai 的 env 认证路径共用同一个环境变量，所以拿到后写回 process.env。
 */
export function resolveApiKey(envName = "ZAI_CODING_CN_API_KEY"): string | undefined {
	if (process.env[envName]) return process.env[envName];
	try {
		const m = readFileSync(DSH_CREDENTIALS, "utf8").match(new RegExp(`^ {2}${envName}:\\s*(.+)$`, "m"));
		if (!m) return undefined;
		const key = m[1].trim().replace(/^["']|["']$/g, "");
		process.env[envName] = key;
		return key;
	} catch {
		return undefined;
	}
}
