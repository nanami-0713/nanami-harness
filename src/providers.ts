/**
 * 多供应商模型层（M-A）。
 *
 * Models 实例的三个合成来源：
 * 1. DEFAULT_PROVIDERS 的默认四家 provider（GLM=智谱双端点 / DeepSeek / Anthropic /
 *    OpenAI），key 走各家约定 env（ANTHROPIC_API_KEY、OPENAI_API_KEY…），从 shell
 *    env 或 ~/.nanmi/credentials.yaml 来；不穷举 pi-ai 全目录，其余走 customProviders；
 * 2. ~/.nanmi/config.json 的 customProviders：OpenAI 兼容端点（baseUrl + 模型表），
 *    走 createProvider + openai-completions api，注册进同一 Models 实例；
 * 3. 编程用法经 NanmiConfig.providers 直传。
 *
 * key 纪律（与 key.ts 同源）：启动时写进 process.env，绝不打印、绝不落日志、
 * 绝不进任何 API 响应；credentials 文件建议 600 权限。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { zaiProvider } from "@earendil-works/pi-ai/providers/zai";
import { zaiCodingCnProvider } from "@earendil-works/pi-ai/providers/zai-coding-cn";
import { createModels, createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import * as openaiCompletions from "@earendil-works/pi-ai/api/openai-completions";
import type { Models, Model, Api, MutableModels, Provider } from "@earendil-works/pi-ai";

/** 默认内置服务商：GLM（智谱双端点）、DeepSeek、Anthropic、OpenAI */
const DEFAULT_PROVIDERS: Array<() => Provider> = [
	zaiCodingCnProvider,
	zaiProvider,
	deepseekProvider,
	anthropicProvider,
	openaiProvider,
];

export const NANMI_DIR = join(homedir(), ".nanmi");
export const USER_CONFIG_FILE = join(NANMI_DIR, "config.json");
export const CREDENTIALS_FILE = join(NANMI_DIR, "credentials.yaml");

/** OpenAI 兼容自定义端点（config.json: customProviders[]） */
export interface CustomProviderConfig {
	id: string;
	name?: string;
	baseUrl: string;
	/** 本端点的 key 读哪个 env（缺省 <ID 大写>_API_KEY）；也可 apiKey 直配 */
	envVar?: string;
	apiKey?: string;
	models: Array<{
		id: string;
		name?: string;
		contextWindow?: number;
		maxTokens?: number;
		input?: ("text" | "image")[];
		reasoning?: boolean;
	}>;
}

export interface UserConfig {
	defaultProvider?: string;
	defaultModel?: string;
	customProviders?: CustomProviderConfig[];
	/** 额外凭据文件（默认 ~/.nanmi/credentials.yaml；DSH 用户可指 ~/.dsh/.credentials.yaml） */
	credentialsFile?: string;
}

/** 读 ~/.nanmi/config.json；不存在给空配置（一切走缺省） */
export function loadUserConfig(): UserConfig {
	try {
		return JSON.parse(readFileSync(USER_CONFIG_FILE, "utf8")) as UserConfig;
	} catch {
		return {};
	}
}

/**
 * 把凭据文件里的 key 装进 process.env（provider 认证层只认 env）。
 * 格式：<ENV_VAR_NAME>: <value>（容忍缩进/引号/注释行）。
 * 已存在的 env 不覆盖（shell 优先）。绝不打印任何值。
 */
export function loadCredentialsIntoEnv(file?: string): number {
	const target = file ?? CREDENTIALS_FILE;
	if (!existsSync(target)) return 0;
	let loaded = 0;
	try {
		const text = readFileSync(target, "utf8");
		for (const line of text.split("\n")) {
			const m = line.match(/^\s*([A-Z][A-Z0-9_]+)\s*:\s*(.+?)\s*$/);
			if (!m || line.trim().startsWith("#")) continue;
			const [, name, raw] = m;
			const value = raw.replace(/^["']|["']$/g, "");
			if (value && !process.env[name]) {
				process.env[name] = value;
				loaded++;
			}
		}
	} catch {
		// 读不了就算了：走 shell env
	}
	return loaded;
}

/** 注册一个 OpenAI 兼容自定义端点（key 解析顺序：config.apiKey → envVar） */
function registerCustomProvider(models: MutableModels, cp: CustomProviderConfig): void {
	const envVar = cp.envVar ?? `${cp.id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
	const modelEntries: Model<"openai-completions">[] = cp.models.map((m) => ({
		id: m.id,
		name: m.name ?? m.id,
		api: "openai-completions" as const,
		provider: cp.id,
		baseUrl: cp.baseUrl,
		reasoning: m.reasoning ?? false,
		input: m.input ?? (["text"] as ("text" | "image")[]),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: m.contextWindow ?? 128_000,
		maxTokens: m.maxTokens ?? 8_192,
	}));
	models.setProvider(
		createProvider({
			id: cp.id,
			name: cp.name ?? cp.id,
			baseUrl: cp.baseUrl,
			auth: { apiKey: envApiKeyAuth(cp.name ?? cp.id, [envVar]) },
			models: modelEntries,
			api: { stream: openaiCompletions.stream, streamSimple: openaiCompletions.streamSimple },
		}),
	);
	// 直配 key 的便捷路径：写进 env 让认证层捡到（同样不落日志）
	if (cp.apiKey && !process.env[envVar]) process.env[envVar] = cp.apiKey;
}

/**
 * 组装完整 Models：默认四家 + 自定义端点；凭据先装进 env。
 * 每个进程装一次（模块级 guard），重复调用返回已装配实例的刷新。
 */
export function buildModels(userConfig: UserConfig = {}): MutableModels {
	loadCredentialsIntoEnv(userConfig.credentialsFile);
	const models = createModels();
	for (const factory of DEFAULT_PROVIDERS) {
		models.setProvider(factory());
	}
	for (const cp of userConfig.customProviders ?? []) {
		try {
			registerCustomProvider(models, cp);
		} catch (err) {
			console.error(`[nanmi:providers] 自定义 provider "${cp.id}" 注册失败: ${(err as Error).message}`);
		}
	}
	return models;
}

/** /api/models 的目录条目 */
export interface ProviderCatalogEntry {
	provider: string;
	providerName: string;
	available: boolean;
	models: Array<{ id: string; name: string; input: string[]; contextWindow: number }>;
}

/**
 * 全供应商模型目录 + 可用性（checkAuth：env 或凭据库里有 key 即 available）。
 * available=false 只是"没配 key"，不是坏：前端置灰并提示配 key 的方法。
 */
export async function catalog(models: Models): Promise<ProviderCatalogEntry[]> {
	const providers = models.getProviders();
	const checks = await Promise.allSettled(
		providers.map((p) => models.checkAuth(p.id).catch(() => undefined)),
	);
	return providers.map((p, i) => {
		const settled = checks[i];
		const available = settled.status === "fulfilled" && !!settled.value;
		return {
			provider: p.id,
			providerName: (p as { name?: string }).name ?? p.id,
			available,
			models: models
				.getModels(p.id)
				.map((m: Model<Api>) => ({
					id: m.id,
					name: m.name ?? m.id,
					input: [...(m.input ?? ["text"])],
					contextWindow: m.contextWindow,
				})),
		};
	});
}
