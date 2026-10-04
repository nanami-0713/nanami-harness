/**
 * 模型服务面（从 web-server 拆出，M·结构）：服务商目录装饰 + 配置文件定位。
 * 独立成模块的原因：显示名表、env 指引表、reveal 白名单都是"供应商目录"领域知识。
 */
import { execFile as execFileCb } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import type { Models } from "@earendil-works/pi-ai";
import { catalog } from "./providers.js";
import type { UserConfig } from "./providers.js";
import { CREDENTIALS_FILE, USER_CONFIG_FILE } from "./providers.js";

const execFileAsync = promisify(execFileCb);

/** 常用供应商的显示名（模型 tab 卡片用；缺省回退 providerName） */
const PROVIDER_DISPLAY: Record<string, string> = {
	"zai-coding-cn": "智谱 Coding", zai: "智谱开放", anthropic: "Anthropic", openai: "OpenAI",
	"openai-codex": "OpenAI Codex", deepseek: "DeepSeek", google: "Google", "google-vertex": "Google Vertex",
	"amazon-bedrock": "AWS Bedrock", "azure-openai-responses": "Azure OpenAI", groq: "Groq",
	together: "Together", fireworks: "Fireworks", mistral: "Mistral", minimax: "MiniMax",
	"minimax-cn": "MiniMax 国内", moonshotai: "Moonshot", "moonshotai-cn": "Moonshot 国内",
	"kimi-coding": "Kimi Code", openrouter: "OpenRouter", xai: "xAI", "qwen-token-plan": "Qwen",
	"qwen-token-plan-cn": "Qwen 国内", "qwen-token-plan-individual": "Qwen 个人",
	huggingface: "HuggingFace", nvidia: "NVIDIA", cerebras: "Cerebras", baseten: "Baseten",
	"github-copilot": "GitHub Copilot", opencode: "OpenCode", radius: "Radius", "ant-ling": "蚂蚁 Ling",
	xiaomi: "小米", "vercel-ai-gateway": "Vercel Gateway", "cloudflare-ai-gateway": "Cloudflare Gateway",
	"cloudflare-workers-ai": "Cloudflare Workers", "openai-responses": "OpenAI Responses",
};

/** 内置供应商 key 的 env 变量名（未配 key 时的指引；缺省按 <ID>_API_KEY 推测） */
const PROVIDER_ENV: Record<string, string> = {
	anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", deepseek: "DEEPSEEK_API_KEY",
	google: "GEMINI_API_KEY", groq: "GROQ_API_KEY", openrouter: "OPENROUTER_API_KEY",
	mistral: "MISTRAL_API_KEY", together: "TOGETHER_API_KEY", xai: "XAI_API_KEY",
	fireworks: "FIREWORKS_API_KEY", "zai-coding-cn": "ZAI_CODING_CN_API_KEY", zai: "ZAI_API_KEY",
	"kimi-coding": "KIMI_CODE_API_KEY", moonshotai: "MOONSHOT_API_KEY", "moonshotai-cn": "MOONSHOT_API_KEY",
	"qwen-token-plan": "QWEN_TOKEN_PLAN_API_KEY", minimax: "MINIMAX_API_KEY", "minimax-cn": "MINIMAX_API_KEY",
	togetherai: "TOGETHER_API_KEY", cerebras: "CEREBRAS_API_KEY", huggingface: "HF_API_KEY",
};

/** /api/models 的完整响应体（服务商卡片面板与 composer 共用） */
export async function providerCatalog(models: Models, userConfig: UserConfig) {
	const raw = await catalog(models);
	const customById = new Map((userConfig.customProviders ?? []).map((cp) => [cp.id, cp]));
	const providers = raw.map((p) => {
		const cp = customById.get(p.provider);
		return {
			...p,
			providerName: PROVIDER_DISPLAY[p.provider] ?? cp?.name ?? p.providerName,
			source: cp ? "custom" : "builtin",
			// 未配 key 时展示该往哪个 env 写；自定义端点显示其 envVar
			envHint: cp
				? cp.envVar ?? `${cp.id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`
				: PROVIDER_ENV[p.provider] ?? `${p.provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`,
		};
	});
	return {
		files: {
			config: USER_CONFIG_FILE,
			credentials: CREDENTIALS_FILE,
			credentialsExists: existsSync(CREDENTIALS_FILE),
		},
		providers,
	};
}

/**
 * 在 Finder 中显示配置文件（白名单仅 config/credentials 两项）。
 * 文件还不存在（首次配置）时退回显示其父目录。
 */
export async function revealConfigFile(
	target: string,
): Promise<{ ok: true; path: string; revealed: string } | { ok: false; error: string }> {
	const allow: Record<string, string> = { config: USER_CONFIG_FILE, credentials: CREDENTIALS_FILE };
	const path = allow[target];
	if (!path) return { ok: false, error: "target 只能是 config 或 credentials" };
	try {
		const { dirname } = await import("node:path");
		const reveal = existsSync(path) ? path : dirname(path);
		await execFileAsync("open", ["-R", reveal]);
		return { ok: true, path, revealed: reveal };
	} catch (err) {
		return { ok: false, error: `打开失败: ${(err as Error).message}` };
	}
}
