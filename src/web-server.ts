/**
 * Web GUI 宿主（M4）。架构与 DSH/ZCode 同构：Node 宿主进程 + 浏览器前端，
 * Electron 壳只是这层的一张皮。
 *
 * 传输：REST（提交动作）+ SSE（事件流）。
 *  - 每个会话一个事件环（ring buffer，带 seq），SSE 断线用 ?since=<seq> 补放；
 *  - 权限审批：harness 的 ask 被注入的 webAsker 接管 —— 往事件环里推
 *    permission_request，把 Promise 挂进 pending 队列，浏览器点按钮后
 *    POST /api/approve 兑现，run 就地继续。这就是 GUI 版的 y/n/a。
 *
 * 启动：npm run web（构建后 node dist/web-server.js），默认 127.0.0.1:6110。
 * 可选配置文件 ./nanmi.web.json：{provider, modelId, systemPrompt, mcp, permissionMode}
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { join, extname, dirname as pathDirname, resolve as pathResolve } from "node:path";
import { NanmiHarness } from "./index.js";
import { buildModels, catalog, loadUserConfig } from "./providers.js";
import { CREDENTIALS_FILE, USER_CONFIG_FILE } from "./providers.js";

const execFileAsync = promisify(execFileCb);

/** 常用供应商的显示名（模型 tab 卡片用；缺省回退 providerName） */
const PROVIDER_DISPLAY: Record<string, string> = {
	"zai-coding-cn": "智谱 Coding", zai: "智谱开放", deepseek: "DeepSeek",
	anthropic: "Anthropic", openai: "OpenAI",
};

/** 内置供应商 key 的 env 变量名（未配 key 时的指引；缺省按 <ID>_API_KEY 推测） */
const PROVIDER_ENV: Record<string, string> = {
	anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", deepseek: "DEEPSEEK_API_KEY",
	"zai-coding-cn": "ZAI_CODING_CN_API_KEY", zai: "ZAI_API_KEY",
};
import type { NanmiConfig, PermissionMode } from "./types.js";
import { SessionStore, type SessionStats } from "./session.js";
import { resolveApiKey } from "./key.js";
import { BUILTIN_TOOL_NAMES } from "./tools.js";

const PORT = Number(process.env.NANMI_PORT ?? 6110);
const HOST = "127.0.0.1";
const RING_CAP = 4_000;
const RESULT_PREVIEW_CAP = 8_000;

// ── 可选配置文件 ────────────────────────────────────────────────────────────
interface WebConfig extends Partial<NanmiConfig> {
	permissionMode?: PermissionMode;
}
const webConfig: WebConfig = existsSync("nanmi.web.json")
	? (JSON.parse(readFileSync("nanmi.web.json", "utf8")) as WebConfig)
	: {};

// ── 模型面（M-A）：默认四家 + ~/.nanmi/config.json 自定义端点，凭据先装 env ──
const userConfig = loadUserConfig();
const MODELS = buildModels(userConfig);
const PROVIDER = userConfig.defaultProvider ?? webConfig.provider ?? process.env.NANMI_PROVIDER ?? "zai-coding-cn";
const MODEL_ID = userConfig.defaultModel ?? webConfig.modelId ?? process.env.NANMI_MODEL ?? "glm-5.3-flash";
const SESSION_DIR = join(process.cwd(), ".nanmi/sessions"); // 会话目录全局固定，与目标工作文件夹解耦

/** 运行时可改的默认设置（设置弹窗写入，持久化到 nanmi.web.json，对新会话生效） */
const runtimeSettings = {
	defaultPermissionMode: (webConfig.permissionMode ?? "default") as PermissionMode,
	defaultProvider: PROVIDER,
	defaultModelId: MODEL_ID,
	defaultThinkingLevel: webConfig.thinkingLevel ?? "", // 空 = 跟随模型默认
};

function persistSettings(): void {
	const file = join(process.cwd(), "nanmi.web.json");
	const conf = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {};
	conf.permissionMode = runtimeSettings.defaultPermissionMode;
	conf.provider = runtimeSettings.defaultProvider;
	conf.modelId = runtimeSettings.defaultModelId;
	if (runtimeSettings.defaultThinkingLevel) conf.thinkingLevel = runtimeSettings.defaultThinkingLevel;
	else delete conf.thinkingLevel;
	writeFileSync(file, `${JSON.stringify(conf, null, 2)}\n`);
}
const SYSTEM_PROMPT =
	webConfig.systemPrompt ??
	`你是 nanmi-harness，一个运行在本机上的编码 agent。用中文，结论先行。需要事实时用工具查，不要猜。对破坏性操作先确认。`;
const PERMISSION_MODE: PermissionMode = webConfig.permissionMode ?? "default";

// zai key 仍走 DSH 凭据库兼容链（写 env 即可，provider 认证层自取）；多供应商下缺它不致命
if (!resolveApiKey()) {
	console.error("[web] 未找到 ZAI_CODING_CN_API_KEY（env 或 ~/.dsh/.credentials.yaml）——zai 系模型不可用，其他 provider 不受影响");
}

// ── 会话注册表 ──────────────────────────────────────────────────────────────
/** 环里的事件都是可直接 JSON 序列化的快照（emit 时统一补 seq） */
type RingEvent = Record<string, unknown>;

interface SessionReg {
	id: string;
	harness: NanmiHarness;
	ring: RingEvent[];
	seq: number;
	running: boolean;
	sseClients: Set<ServerResponse>;
	pendingApprovals: Map<string, (grant: "allow" | "deny" | "always") => void>;
	/** 跨进程计时基线（来自 meta.stats） */
	statsBaseline: SessionStats;
	/** 本进程实时增量（事件汇测量） */
	live: SessionStats;
	/** 轨迹计时：assistant 消息按 `a:<timestamp>`，工具按 `t:<toolCallId>` */
	traceTiming: Map<string, Record<string, unknown>>;
	curLlmStart: number | null;
	curLlmFirstDelta: number | null;
	curToolStart: Map<string, number>;
}

const ZERO_STATS: SessionStats = { llmMs: 0, toolMs: 0, ttftSum: 0, ttftN: 0, genMs: 0, outTok: 0 };

/**
 * 事件汇计时（DSH 对齐版）：
 * TTFT 判定 = 首个"非空增量"——text_delta / thinking_delta / toolcall_delta 任一
 * （对齐 DSH isTokenDelta：纯工具轮次也有首 token；start/end 块事件不算）；
 * gen = 首增量 → message_end；每次请求记录完整 usage 分解（未缓存输入/缓存读/写/输出/推理）
 * 与单请求缓存命中率 = cacheRead / (input + cacheRead + cacheWrite)。
 * 记录同时落盘 <id>.trace.jsonl（append-only），重开会话轨迹不丢。
 */
function isTokenDelta(e: Record<string, any> | undefined): boolean {
	switch (e?.type) {
		case "text_delta":
		case "thinking_delta":
			return String(e.delta ?? "") !== "";
		case "toolcall_delta":
			return String(e.delta ?? "") !== "";
		case "toolcall_start":
			// DSH 语义：工具名到达即算 token（argumentsDelta/name 首现）
			return true;
		default:
			return false;
	}
}

function trackTiming(reg: SessionReg, event: Record<string, any>): void {
	const L = reg.live;
	switch (event.type) {
		case "message_start":
			if ((event.message as { role?: string })?.role === "assistant") {
				reg.curLlmStart = Date.now();
				reg.curLlmFirstDelta = null;
			}
			break;
		case "message_update":
			if (
				isTokenDelta(event.assistantMessageEvent) &&
				reg.curLlmStart !== null &&
				reg.curLlmFirstDelta === null
			) {
				reg.curLlmFirstDelta = Date.now();
			}
			break;
		case "message_end": {
			const m = event.message as {
				role?: string; timestamp?: number; model?: string; provider?: string; stopReason?: string;
				usage?: {
					input?: number; output?: number; totalTokens?: number;
					cacheRead?: number; cacheWrite?: number; reasoning?: number;
				};
			};
			if (m?.role !== "assistant" || reg.curLlmStart === null) break;
			const now = Date.now();
			const llmMs = now - reg.curLlmStart;
			let ttftMs = 0;
			let genMs = 0;
			if (reg.curLlmFirstDelta !== null) {
				ttftMs = reg.curLlmFirstDelta - reg.curLlmStart;
				genMs = now - reg.curLlmFirstDelta;
				L.ttftSum += ttftMs;
				L.ttftN++;
				L.genMs += genMs;
			}
			L.llmMs += llmMs;
			const u = m.usage ?? {};
			const inTok = u.input ?? 0;
			const cacheRead = u.cacheRead ?? 0;
			const cacheWrite = u.cacheWrite ?? 0;
			const out = u.output ?? 0;
			L.outTok += out;
			const denom = inTok + cacheRead + cacheWrite;
			recordTiming(reg, `a:${m.timestamp ?? now}`, {
				startTs: reg.curLlmStart,
				endTs: now,
				llmMs,
				ttftMs,
				genMs,
				tokPerSec: genMs > 0 ? Math.round(((out / genMs) * 1000) * 10) / 10 : 0,
				model: m.model,
				provider: m.provider,
				stopReason: m.stopReason,
				inTok,
				cacheRead,
				cacheWrite,
				outTok: out,
				reasoningTok: u.reasoning ?? 0,
				totalTokens: u.totalTokens,
				cacheHitPct: denom > 0 ? Math.round((cacheRead / denom) * 1000) / 10 : 0,
			});
			reg.curLlmStart = null;
			reg.curLlmFirstDelta = null;
			break;
		}
		case "tool_execution_start":
			reg.curToolStart.set(String(event.toolCallId), Date.now());
			break;
		case "tool_execution_end": {
			const st = reg.curToolStart.get(String(event.toolCallId));
			if (st !== undefined) {
				const ms = Date.now() - st;
				L.toolMs += ms;
				recordTiming(reg, `t:${event.toolCallId}`, { startTs: st, endTs: st + ms, ms });
				reg.curToolStart.delete(String(event.toolCallId));
			}
			break;
		}
	}
}

/** 计时记录：进内存 Map（/api/trace 即时读）+ 追加落盘 <id>.trace（重开恢复）。
 *  扩展名刻意不用 .jsonl —— 会话列表按 *.jsonl 枚举，别把副车当会话。 */
function recordTiming(reg: SessionReg, key: string, record: Record<string, unknown>): void {
	reg.traceTiming.set(key, record);
	const store = reg.harness.sessionStore;
	if (!store) return;
	try {
		appendFileSync(join(store.dir, `${reg.id}.trace`), `${JSON.stringify({ k: key, r: record })}\n`);
	} catch (err) {
		console.error(`[web:trace] 计时落盘失败: ${(err as Error).message}`);
	}
}

/** 重开会话时从 <id>.trace 恢复计时记录（没有文件=旧会话，给空） */
function loadTiming(store: { dir: string } | undefined, id: string): Map<string, Record<string, unknown>> {
	const map = new Map<string, Record<string, unknown>>();
	if (!store) return map;
	try {
		const text = readFileSync(join(store.dir, `${id}.trace`), "utf8");
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			try {
				const { k, r } = JSON.parse(line) as { k?: string; r?: Record<string, unknown> };
				if (k && r) map.set(k, r);
			} catch { /* 脏行跳过 */ }
		}
	} catch { /* 文件不存在 */ }
	return map;
}

const sessions = new Map<string, SessionReg>();

// ── 工具 ────────────────────────────────────────────────────────────────────
function normalizeEvent(event: unknown): RingEvent {
	// tool_execution_end 的 result 可能是整文件内容，环里存预览防内存膨胀
	const e = event as { type?: string; result?: unknown; toolCallId?: string };
	if (e.type === "tool_execution_end" && e.result != null) {
		const text = JSON.stringify(e.result);
		if (text.length > RESULT_PREVIEW_CAP) {
			return { ...e, result: { truncated: `${text.slice(0, RESULT_PREVIEW_CAP)}…(截断)` } };
		}
	}
	return event as RingEvent;
}

function emit(reg: SessionReg, event: Record<string, unknown>): void {
	const tagged: RingEvent = { ...normalizeEvent(event), seq: ++reg.seq };
	reg.ring.push(tagged);
	if (reg.ring.length > RING_CAP) reg.ring.splice(0, reg.ring.length - RING_CAP);
	const payload = `data: ${JSON.stringify(tagged)}\n\n`;
	for (const res of reg.sseClients) res.write(payload);
}

/** 浏览器审批 asker：推 permission_request，挂起 Promise，/api/approve 兑现 */
function makeWebAsker(reg: SessionReg) {
	return async (
		toolName: string,
		reason: string | undefined,
		args: unknown,
	): Promise<"allow" | "deny" | "always"> => {
		const requestId = randomUUID();
		emit(reg, { type: "permission_request", requestId, toolName, reason, args });
		console.log(`[web] 审批请求 ${toolName}（${requestId.slice(0, 8)}）等待浏览器裁决`);
		return new Promise((resolve) => reg.pendingApprovals.set(requestId, resolve));
	};
}

async function createSession(opts: {
	resumeId?: string;
	cwd?: string;
	provider?: string;
	modelId?: string;
	projectName?: string;
	isolateMemory?: boolean;
}): Promise<SessionReg> {
	const cwd = opts.cwd ?? process.cwd();
	if (!existsSync(cwd)) throw new Error(`工作文件夹不存在: ${cwd}`);
	// 隔离记忆的真实语义：该项目会话数据物理存在 <项目>/.nanmi/sessions，不进全局库
	const sessionDir = opts.isolateMemory ? join(cwd, ".nanmi/sessions") : SESSION_DIR;
	// 恢复会话沿用其 provider/模型；显式参数 > 会话元数据 > 全局默认
	const resumedMeta = opts.resumeId ? SessionStore.load(sessionDir, opts.resumeId)?.meta : undefined;
	const provider = opts.provider ?? resumedMeta?.provider ?? runtimeSettings.defaultProvider;
	const config: NanmiConfig = {
		provider,
		modelId: opts.modelId ?? resumedMeta?.modelId ?? runtimeSettings.defaultModelId,
		...(runtimeSettings.defaultThinkingLevel
			? { thinkingLevel: runtimeSettings.defaultThinkingLevel as NanmiConfig["thinkingLevel"] }
			: {}),
		systemPrompt: SYSTEM_PROMPT,
		tools: [...BUILTIN_TOOL_NAMES],
		permission: { mode: runtimeSettings.defaultPermissionMode, asker: undefined! }, // asker 在下方注入（需要 reg）
		compaction: webConfig.compaction === false ? false : (webConfig.compaction ?? {}),
		mcp: webConfig.mcp,
		cwd,
		session: { dir: sessionDir, ...(opts.resumeId ? { resumeId: opts.resumeId } : {}) },
	};

	// 先建 reg 壳拿 emit，再建 harness 把 webAsker 注进去 —— 鸡生蛋用两段式
	const reg: SessionReg = {
		id: "",
		harness: undefined!,
		ring: [],
		seq: 0,
		running: false,
		sseClients: new Set(),
		pendingApprovals: new Map(),
		statsBaseline: { ...ZERO_STATS },
		live: { ...ZERO_STATS },
		traceTiming: new Map(),
		curLlmStart: null,
		curLlmFirstDelta: null,
		curToolStart: new Map(),
	};
	config.permission!.asker = makeWebAsker(reg);
	reg.harness = await NanmiHarness.create(config);
	reg.id = reg.harness.sessionId!;
	// 恢复历史计时记录（<id>.trace.jsonl）：旧会话没有文件，轨迹计时显示 —
	reg.traceTiming = loadTiming(reg.harness.sessionStore, reg.id);
	if (opts.projectName) {
		reg.harness.sessionStore?.setProject(opts.projectName);
	}
	// 恢复会话时从 meta 读回计时基线（跨进程累计）
	if (reg.harness.sessionStore?.metaSnapshot.stats) {
		reg.statsBaseline = { ...ZERO_STATS, ...reg.harness.sessionStore.metaSnapshot.stats };
	}

	// 常驻事件汇：计时 + 进环 + SSE（run() 不再传回调，避免双发）
	reg.harness.attachEventSink((event) => {
		trackTiming(reg, event);
		emit(reg, { type: "agent", event });
	});
	sessions.set(reg.id, reg);
	return reg;
}

// ── HTTP 基础设施 ───────────────────────────────────────────────────────────
function json(res: ServerResponse, code: number, body: unknown): void {
	res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<any> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
	} catch {
		return {};
	}
}

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".webmanifest": "application/manifest+json",
};

function serveStatic(pathname: string, res: ServerResponse): void {
	const webDir = join(process.cwd(), "web");
	const rel = pathname === "/" ? "index.html" : pathname.slice(1);
	const file = join(webDir, rel);
	if (!file.startsWith(webDir) || !existsSync(file)) {
		res.writeHead(404).end("not found");
		return;
	}
	res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
	res.end(readFileSync(file));
}

// ── 路由 ────────────────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", `http://${HOST}`);
	const pathname = url.pathname;

	try {
		if (pathname.startsWith("/api/")) {
			await routeApi(req, res, url);
			return;
		}
		if (pathname === "/vendor/marked.min.js") {
			res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
			res.end(readFileSync(join(process.cwd(), "node_modules/marked/lib/marked.umd.js")));
			return;
		}
		serveStatic(pathname, res);
	} catch (err) {
		json(res, 500, { error: (err as Error).message });
	}
});

async function routeApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
	const { pathname } = url;
	const body = req.method === "POST" ? await readBody(req) : {};

	// GET /api/health
	if (pathname === "/api/health") {
		return json(res, 200, { ok: true, provider: runtimeSettings.defaultProvider, model: runtimeSettings.defaultModelId });
	}

	// GET /api/sessions —— 会话清单（侧栏"最近"；归档默认隐藏）
	if (pathname === "/api/sessions" && req.method === "GET") {
		const all = SessionStore.list(SESSION_DIR);
		return json(res, 200, {
			sessions: all.filter((s) => !s.archived).map((s) => ({ ...s })),
		});
	}

	// GET /api/models —— 全供应商模型目录 + 可用性 + 管理面元数据（模型 tab 卡片与 composer 共用）
	if (pathname === "/api/models" && req.method === "GET") {
		const raw = await catalog(MODELS);
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
		return json(res, 200, {
			current: { provider: runtimeSettings.defaultProvider, modelId: runtimeSettings.defaultModelId },
			files: {
				config: USER_CONFIG_FILE,
				credentials: CREDENTIALS_FILE,
				credentialsExists: existsSync(CREDENTIALS_FILE),
			},
			providers,
		});
	}

	// POST /api/reveal {target:"config"|"credentials"} —— 在 Finder 中显示配置文件（白名单）
	if (pathname === "/api/reveal" && req.method === "POST") {
		const allow = { config: USER_CONFIG_FILE, credentials: CREDENTIALS_FILE } as Record<string, string>;
		const target = allow[String(body.target ?? "")];
		if (!target) return json(res, 400, { error: "target 只能是 config 或 credentials" });
		try {
			// 文件还不存在（首次配置）时退回显示其父目录
			const reveal = existsSync(target) ? target : pathDirname(target);
			await execFileAsync("open", ["-R", reveal]);
			return json(res, 200, { ok: true, path: target, revealed: reveal });
		} catch (err) {
			return json(res, 500, { error: `打开失败: ${(err as Error).message}` });
		}
	}

	// GET /api/folders —— 可选工作文件夹：服务根 + 历史会话用过的 cwd（去重、仍存在）
	if (pathname === "/api/folders" && req.method === "GET") {
		const seen = new Set<string>([process.cwd()]);
		for (const s of SessionStore.list(SESSION_DIR)) {
			if (s.cwd && existsSync(s.cwd)) seen.add(s.cwd);
		}
		return json(res, 200, { folders: [...seen] });
	}

	// GET /api/fs/browse?path= —— 服务端目录浏览器（浏览器拿不到绝对路径，由宿主代劳）
	if (pathname === "/api/fs/browse" && req.method === "GET") {
		let dir = url.searchParams.get("path") ?? process.cwd();
		if (!dir.startsWith("/")) dir = join(process.cwd(), dir);
		dir = pathResolve(dir);
		if (!existsSync(dir)) return json(res, 404, { error: "目录不存在" });
		if (!statSync(dir).isDirectory()) dir = pathDirname(dir);
		let dirs: string[] = [];
		try {
			dirs = readdirSync(dir, { withFileTypes: true })
				.filter((d) => d.isDirectory() && !d.name.startsWith("."))
				.map((d) => d.name)
				.sort((a, b) => a.localeCompare(b));
		} catch { /* 无权限目录给空列表 */ }
		return json(res, 200, { path: dir, parent: pathDirname(dir), dirs });
	}

	// GET /api/settings —— 设置弹窗回显
	if (pathname === "/api/settings" && req.method === "GET") {
		return json(res, 200, { provider: runtimeSettings.defaultProvider, url: `http://127.0.0.1:${PORT}`, ...runtimeSettings });
	}

	// POST /api/settings {defaultPermissionMode?, defaultModelId?, defaultThinkingLevel?} —— 持久化，对新会话生效
	if (pathname === "/api/settings" && req.method === "POST") {
		const modes = ["readonly", "default", "acceptEdits", "bypass"];
		if (body.defaultPermissionMode !== undefined) {
			if (!modes.includes(body.defaultPermissionMode)) return json(res, 400, { error: "非法权限模式" });
			runtimeSettings.defaultPermissionMode = body.defaultPermissionMode;
		}
		if (body.defaultProvider !== undefined) {
			const pid = String(body.defaultProvider);
			if (!MODELS.getProvider(pid)) return json(res, 400, { error: `provider 不存在: ${pid}` });
			runtimeSettings.defaultProvider = pid;
		}
		if (body.defaultModelId !== undefined) {
			const exists = MODELS.getModels(runtimeSettings.defaultProvider).some((m) => m.id === body.defaultModelId);
			if (!exists) return json(res, 400, { error: `模型不存在: ${runtimeSettings.defaultProvider}/${body.defaultModelId}` });
			runtimeSettings.defaultModelId = body.defaultModelId;
		}
		if (body.defaultThinkingLevel !== undefined) {
			const levels = ["", "off", "minimal", "low", "medium", "high", "xhigh", "max"];
			if (!levels.includes(body.defaultThinkingLevel))
				return json(res, 400, { error: `非法推理强度: ${body.defaultThinkingLevel}` });
			runtimeSettings.defaultThinkingLevel = body.defaultThinkingLevel;
		}
		persistSettings();
		return json(res, 200, { ok: true, settings: runtimeSettings });
	}

	// GET /api/usage —— 使用情况聚合（近 40 个会话；token ≈ 各请求 totalTokens 累加）
	if (pathname === "/api/usage" && req.method === "GET") {
		const metas = SessionStore.list(SESSION_DIR);
		let messages = 0;
		let tokens = 0;
		let peakTokens = 0;
		let maxDurationMs = 0;
		let firstTs = Infinity;
		let lastTs = 0;
		const daily = new Map<string, { total: number; byModel: Map<string, number> }>();
		const per: Array<{ id: string; title: string; messages: number; tokens: number }> = [];
		for (const meta of metas.slice(0, 40)) {
			const loaded = SessionStore.load(SESSION_DIR, meta.id);
			if (!loaded) continue;
			messages += loaded.view.length;
			let sessionTokens = 0;
			// 物理口径：含被检查点替换的史前史（每一次请求都是真实计费）
			for (const msg of loaded.physical) {
				const m = msg as { role?: string; timestamp?: number; usage?: { totalTokens?: number }; model?: string };
				if (typeof m.timestamp === "number") {
					if (m.timestamp < firstTs) firstTs = m.timestamp;
					if (m.timestamp > lastTs) lastTs = m.timestamp;
				}
				if (m.role !== "assistant") continue;
				const t = m.usage?.totalTokens ?? 0;
				sessionTokens += t;
				const date = localDate(m.timestamp ?? Date.now());
				const day = daily.get(date) ?? { total: 0, byModel: new Map<string, number>() };
				day.total += t;
				day.byModel.set(m.model ?? "unknown", (day.byModel.get(m.model ?? "unknown") ?? 0) + t);
				daily.set(date, day);
			}
			if (firstTs !== Infinity && lastTs > firstTs) maxDurationMs = Math.max(maxDurationMs, lastTs - firstTs);
			tokens += sessionTokens;
			per.push({ id: meta.id, title: meta.title ?? meta.id, messages: loaded.view.length, tokens: sessionTokens });
		}
		per.sort((a, b) => b.tokens - a.tokens);
		const dailyArr = [...daily.entries()]
			.sort((a, b) => a[0].localeCompare(b[0]))
			.map(([date, v]) => ({ date, total: v.total, byModel: Object.fromEntries(v.byModel) }));
		for (const d of dailyArr) if (d.total > peakTokens) peakTokens = d.total;
		const { current, longest } = streaks(dailyArr.filter((d) => d.total > 0).map((d) => d.date));
		return json(res, 200, {
			sessions: metas.length,
			messages,
			tokens,
			peakTokens,
			maxDurationMs,
			currentStreak: current,
			longestStreak: longest,
			daily: dailyArr,
			per: per.slice(0, 10),
		});
	}

	// POST /api/sessions {resumeId?, cwd?, modelId?, projectName?, isolateMemory?} —— 新建/恢复
	if (pathname === "/api/sessions" && req.method === "POST") {
		const reg = await createSession({
			resumeId: body.resumeId,
			cwd: body.cwd,
			provider: body.provider ? String(body.provider) : undefined,
			modelId: body.modelId,
			projectName: body.projectName,
			isolateMemory: !!body.isolateMemory,
		});
		const meta = reg.harness.sessionStore?.metaSnapshot;
		return json(res, 200, {
			sessionId: reg.id,
			resumed: !!body.resumeId,
			permissionMode: reg.harness.permissionMode,
			cwd: meta?.cwd ?? process.cwd(),
			modelId: reg.harness.modelId,
			thinkingLevel: reg.harness.thinkingLevel,
			project: meta?.project,
			isolated: reg.harness.sessionStore ? reg.harness.sessionStore.dir !== SESSION_DIR : false,
			sessionDir: reg.harness.sessionStore?.dir ?? SESSION_DIR,
			messages: reg.harness.snapshotMessages(),
			seq: reg.seq,
		});
	}

	// 其余端点都要带 sessionId（查询串或 POST body 均可）
	const sessionId = url.searchParams.get("sessionId") ?? body.sessionId ?? null;
	const reg = sessionId ? sessions.get(sessionId) : undefined;
	if (!reg) {
		return json(res, 404, { error: "会话不存在或未加载" });
	}
	// POST /api/thinking {level} —— 推理强度，下一条消息生效
	if (pathname === "/api/thinking" && req.method === "POST") {
		const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
		if (!levels.includes(body.level)) return json(res, 400, { error: `非法推理强度: ${body.level}` });
		reg!.harness.setThinkingLevel(body.level);
		return json(res, 200, { ok: true, level: body.level });
	}


	// GET /api/stats —— 会话聚合指标（轮/步/输入输出/缓存 + 计时基线+实时增量）
	if (pathname === "/api/stats" && req.method === "GET") {
		const messages = reg!.harness.snapshotMessages();
		let turns = 0;
		let steps = 0;
		let inTok = 0;
		let outTok = 0;
		let cacheRead = 0;
		for (const m of messages) {
			const mm = m as { role?: string; usage?: { input?: number; output?: number; cacheRead?: number } };
			if (mm.role === "user") turns++;
			if (mm.role === "assistant") {
				steps++;
				inTok += mm.usage?.input ?? 0;
				outTok += mm.usage?.output ?? 0;
				cacheRead += mm.usage?.cacheRead ?? 0;
			}
		}
		const b = reg!.statsBaseline;
		const l = reg!.live;
		const ttftN = b.ttftN + l.ttftN;
		const genMs = b.genMs + l.genMs;
		const genOut = b.outTok + l.outTok;
		return json(res, 200, {
			turns,
			steps,
			inTok,
			outTok,
			cacheRead,
			llmMs: b.llmMs + l.llmMs,
			toolMs: b.toolMs + l.toolMs,
			ttftAvgMs: ttftN ? (b.ttftSum + l.ttftSum) / ttftN : 0,
			tokPerSec: genMs > 0 ? (genOut / genMs) * 1000 : 0,
			cacheHitPct: cacheRead + inTok > 0 ? (cacheRead / (cacheRead + inTok)) * 100 : 0,
		});
	}

	// GET /api/trace —— 轨迹：消息流展平为步骤（用户/助手/工具），附计时
	if (pathname === "/api/trace" && req.method === "GET") {
		const messages = reg!.harness.snapshotMessages();
		const steps: Record<string, unknown>[] = [];
		let turn = 0;
		let step = 0;
		const textOf = (content: unknown) => {
			if (typeof content === "string") return content;
			return (Array.isArray(content) ? content : [])
				.filter((b) => (b as { type?: string }).type === "text")
				.map((b) => String((b as { text?: string }).text ?? ""))
				.join("");
		};
		const results = new Map<string, Record<string, any>>();
		for (const m of messages) {
			const mm = m as { role?: string; toolCallId?: string; content?: unknown; timestamp?: number; isError?: boolean };
			if (mm.role === "toolResult") results.set(mm.toolCallId!, mm);
		}
		for (const m of messages) {
			const mm = m as { role?: string; content?: unknown; timestamp?: number; usage?: { totalTokens?: number } };
			if (mm.role === "user") {
				turn++;
				step = 0;
				steps.push({ kind: "user", turn, text: textOf(mm.content), ts: mm.timestamp });
				continue;
			}
		if (mm.role !== "assistant") continue;
		const blocks = (Array.isArray(mm.content) ? mm.content : []) as Array<Record<string, any>>;
		const thinking = blocks.filter((b) => b.type === "thinking").map((b) => String(b.thinking ?? "")).join("\n").trim();
		const text = blocks.filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("").trim();
		const calls = blocks.filter((b) => b.type === "toolCall");
		step++;
		steps.push({
			kind: "assistant",
			turn,
			step,
			text,
			thinking: thinking || undefined,
			model: (mm as { model?: string }).model,
			provider: (mm as { provider?: string }).provider,
			stopReason: (mm as { stopReason?: string }).stopReason,
			tokens: mm.usage?.totalTokens,
			timing: reg!.traceTiming.get(`a:${mm.timestamp}`),
			toolOnly: text === "" && calls.length > 0,
		});
		for (const c of calls) {
			step++;
			const r = results.get(String(c.id));
			const t = reg!.traceTiming.get(`t:${c.id}`) as { ms?: number; startTs?: number } | undefined;
			steps.push({
				kind: "tool",
				turn,
				step,
				name: c.name,
				args: c.arguments,
				toolCallId: c.id,
				resultText: r ? textOf(r.content) : undefined,
				isError: r ? (r as { isError?: boolean }).isError : undefined,
				ms: t?.ms,
				startTs: t?.startTs,
			});
		}
		}
		return json(res, 200, { steps });
	}


	// GET /api/messages —— 转屏/补快照
	if (pathname === "/api/messages" && req.method === "GET") {
		return json(res, 200, {
			sessionId: reg!.id,
			permissionMode: reg!.harness.permissionMode,
			cwd: reg!.harness.sessionStore?.metaSnapshot.cwd ?? process.cwd(),
			modelId: reg!.harness.modelId,
			thinkingLevel: reg!.harness.thinkingLevel,
			running: reg!.running,
			messages: reg!.harness.snapshotMessages(),
			seq: reg!.seq,
		});
	}

	// GET /api/events —— SSE（?since= 补放）
	if (pathname === "/api/events" && req.method === "GET") {
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});
		res.write(": connected\n\n");
		const since = Number(url.searchParams.get("since") ?? 0);
		for (const event of reg!.ring) {
			if (Number(event.seq) > since) res.write(`data: ${JSON.stringify(event)}\n\n`);
		}
		reg!.sseClients.add(res);
		req.on("close", () => reg!.sseClients.delete(res));
		const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
		req.on("close", () => clearInterval(heartbeat));
		return;
	}

	// POST /api/run {prompt}
	if (pathname === "/api/run" && req.method === "POST") {
		const prompt = String(body.prompt ?? "").trim();
		if (!prompt) return json(res, 400, { error: "prompt 为空" });
		if (reg!.running) return json(res, 409, { error: "上一轮还在跑" });
		reg!.running = true;
		emit(reg!, { type: "run_start" });
		// 异步跑：事件经常驻汇走环+SSE，接口立刻返回
		reg!
			.harness.run(prompt)
			.then((result) => {
				emit(reg!, { type: "run_end", textLength: result.text.length, messageCount: result.messages.length });
				void autoTitle(reg!);
				// 计时基线合并实时增量并持久化（跨进程累计）
				const b = reg!.statsBaseline;
				const l = reg!.live;
				const merged: SessionStats = {
					llmMs: b.llmMs + l.llmMs,
					toolMs: b.toolMs + l.toolMs,
					ttftSum: b.ttftSum + l.ttftSum,
					ttftN: b.ttftN + l.ttftN,
					genMs: b.genMs + l.genMs,
					outTok: b.outTok + l.outTok,
				};
				reg!.statsBaseline = merged;
				reg!.live = { ...ZERO_STATS };
				if (reg!.harness.sessionStore) {
					SessionStore.patchMeta(reg!.harness.sessionStore.dir, reg!.id, { stats: merged });
				}
			})
			.catch((err) => {
				emit(reg!, { type: "error", message: (err as Error).message });
			})
			.finally(() => {
				reg!.running = false;
			});
		return json(res, 200, { ok: true });
	}

	// POST /api/abort
	if (pathname === "/api/abort" && req.method === "POST") {
		reg!.harness.abort();
		return json(res, 200, { ok: true });
	}

	// POST /api/approve {requestId, grant}
	if (pathname === "/api/approve" && req.method === "POST") {
		const resolve = reg!.pendingApprovals.get(String(body.requestId));
		if (!resolve) return json(res, 404, { error: "审批请求不存在或已处理" });
		reg!.pendingApprovals.delete(String(body.requestId));
		const grant = body.grant === "always" ? "always" : body.grant === "allow" ? "allow" : "deny";
		resolve(grant);
		emit(reg!, { type: "permission_resolved", requestId: body.requestId, grant });
		return json(res, 200, { ok: true });
	}

	// POST /api/permission {mode}
	if (pathname === "/api/permission" && req.method === "POST") {
		const modes = ["readonly", "default", "acceptEdits", "bypass"];
		if (!modes.includes(body.mode)) return json(res, 400, { error: "非法模式" });
		reg!.harness.setPermissionMode(body.mode);
		return json(res, 200, { ok: true, mode: body.mode });
	}

	// POST /api/model {modelId} —— 切模型，下一条消息生效
	if (pathname === "/api/model" && req.method === "POST") {
		try {
			const provider = body.provider ? String(body.provider) : undefined;
			if (provider) reg!.harness.setProviderModel(provider, String(body.modelId ?? ""));
			else reg!.harness.setModel(String(body.modelId ?? ""));
			emit(reg!, {
				type: "model_changed",
				provider: reg!.harness.currentProvider,
				modelId: reg!.harness.modelId,
			});
			return json(res, 200, { ok: true, provider: reg!.harness.currentProvider, modelId: reg!.harness.modelId });
		} catch (err) {
			return json(res, 400, { error: (err as Error).message });
		}
	}

	// POST /api/sessions/rename {sessionId, title} —— 对未加载的会话同样有效
	if (pathname === "/api/sessions/rename" && req.method === "POST") {
		const title = String(body.title ?? "").trim().slice(0, 60);
		if (!title) return json(res, 400, { error: "标题为空" });
		const target = sessions.get(String(body.sessionId));
		if (target?.harness.sessionStore) {
			target.harness.sessionStore.setTitle(title, "user");
		} else {
			SessionStore.patchMeta(join(process.cwd(), ".nanmi/sessions"), String(body.sessionId), {
				title,
				titleSource: "user",
			});
		}
		emitIfLoaded(String(body.sessionId), { type: "sessions_changed" });
		return json(res, 200, { ok: true, title });
	}

	// POST /api/sessions/archive {sessionId, archived?}
	if (pathname === "/api/sessions/archive" && req.method === "POST") {
		const archived = body.archived !== false;
		const id = String(body.sessionId);
		const target = sessions.get(id);
		if (target?.harness.sessionStore) {
			target.harness.sessionStore.setArchived(archived);
		} else {
			SessionStore.patchMeta(join(process.cwd(), ".nanmi/sessions"), id, { archived });
		}
		return json(res, 200, { ok: true, archived });
	}

	json(res, 404, { error: "unknown api" });
}

/** 给未加载的会话也补发一条事件（当前只在内存会话里发，未加载的没有订阅者） */
function emitIfLoaded(sessionId: string, event: Record<string, unknown>): void {
	const reg = sessions.get(sessionId);
	if (reg) emit(reg, event);
}

/** 本地时区的 YYYY-MM-DD */
function localDate(ts: number): string {
	const d = new Date(ts);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 有活动日期的当前/最长连续天数 */
function streaks(sortedDates: string[]): { current: number; longest: number } {
	if (sortedDates.length === 0) return { current: 0, longest: 0 };
	const set = new Set(sortedDates);
	const day = 86_400_000;
	const today = localDate(Date.now());
	// 当前连续：从今天（或昨天，今天还没用）往前数
	let current = 0;
	let cursor = set.has(today) ? Date.now() : Date.now() - day;
	while (set.has(localDate(cursor))) {
		current++;
		cursor -= day;
	}
	// 最长连续：排序遍历
	let longest = 0;
	let run = 0;
	let prev: number | undefined;
	for (const date of sortedDates) {
		const ts = new Date(`${date}T00:00:00`).getTime();
		run = prev !== undefined && ts - prev === day ? run + 1 : 1;
		if (run > longest) longest = run;
		prev = ts;
	}
	return { current, longest };
}

/** 首跑结束后生成概括标题：用户没重命名过才覆盖；失败静默（还有首条消息兜底标题） */
async function autoTitle(reg: SessionReg): Promise<void> {
	const store = reg.harness.sessionStore;
	if (!store || store.metaSnapshot.titleSource === "user") return;
	if (store.metaSnapshot.titleSource === "auto") return; // 只生成一次
	const firstUser = reg.harness
		.snapshotMessages()
		.find((m) => (m as { role?: string }).role === "user");
	if (!firstUser) return;
	const content = (firstUser as { content?: unknown }).content;
	const text =
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content.filter((b) => (b as { type?: string }).type === "text").map((b) => String((b as { text?: string }).text ?? "")).join(" ")
				: "";
	if (!text.trim()) return;
	try {
		const raw = await reg.harness.complete(
			`为下面的编码任务生成一个不超过 16 字的中文标题，概括意图即可。只输出标题本身：\n${text.slice(0, 200)}`,
		);
		const title = raw.replace(/^["'#\s]+|["'\s]+$/g, "").slice(0, 32);
		if (title) {
			store.setTitle(title, "auto");
			emit(reg, { type: "sessions_changed" });
		}
	} catch {
		// 标题生成失败不碍事：还有首条消息兜底
	}
}

// ── 启动 ────────────────────────────────────────────────────────────────────
server.listen(PORT, HOST, () => {
	console.log(`nanmi-harness web GUI: http://${HOST}:${PORT}`);
	console.log(`模型 ${PROVIDER}/${MODEL_ID} · 权限默认 ${PERMISSION_MODE} · 配置文件 nanmi.web.json 可覆盖`);
});
