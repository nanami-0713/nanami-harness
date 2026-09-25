/**
 * 会话持久化（v2：append-only 物理 日志 + 压缩检查点 + sidecar 元数据）。
 *
 * 文件布局：
 *   <dir>/<id>.jsonl        —— 只追加的物理日志，每行一条：
 *                              {"k":"msg","m":{...AgentMessage}}      消息条目
 *                              {"k":"ckpt","m":{...摘要消息}}          压缩检查点
 *   <dir>/<id>.meta.json    —— 可变元数据（title/project/archived/stats/...），原子重写
 *
 * 语义（对照 DSH 的"原日志保留、回放确定性"）：
 *  - 压缩不再重写历史，而是**追加一条检查点**（内容=摘要消息）。重放规则：
 *    顺序累积消息，遇到检查点 → 视图重置为该摘要消息。于是：
 *      视图（logical）= 最近检查点之后的对话（喂给模型的内容）
 *      物理（physical）= 全部消息条目（含被摘要替换的史前史，计费/审计口径）
 *  - 兼容 v1 旧文件（首行 meta + 纯消息行，无 ckpt/sidecar）：可读；首次 sync 会原地升级。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionStats } from "./types.js";

export type { SessionStats } from "./types.js";

export interface SessionMeta {
	id: string;
	provider: string;
	modelId: string;
	cwd: string;
	createdAt: string;
	updatedAt: string;
	messageCount: number;
	/** 视图内消息数（喂给模型的逻辑口径） */
	viewCount?: number;
	/** 物理消息条目数（计费/审计口径） */
	physicalCount?: number;
	title?: string;
	titleSource?: "user" | "auto";
	project?: string;
	archived?: boolean;
	stats?: SessionStats;
}

export interface SessionLoad {
	meta: SessionMeta;
	/** 逻辑视图（最近检查点之后的对话，喂模型用） */
	view: AgentMessage[];
	/** 物理消息条目（含被检查点替换的史前史，计费/审计用） */
	physical: AgentMessage[];
}

type Entry = { k: "msg"; m: AgentMessage } | { k: "ckpt"; m: AgentMessage };

export class SessionStore {
	private constructor(
		readonly dir: string,
		readonly id: string,
		private meta: SessionMeta,
	) {}

	/** 当前逻辑视图（与文件重放结果一致） */
	private view: AgentMessage[] = [];
	/** 已落库的物理消息条目数 */
	private physicalCount = 0;

	static create(dir: string, provider: string, modelId: string, cwd: string): SessionStore {
		mkdirSync(dir, { recursive: true });
		const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		const meta: SessionMeta = {
			id,
			provider,
			modelId,
			cwd,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			messageCount: 0,
			viewCount: 0,
			physicalCount: 0,
		};
		const store = new SessionStore(dir, id, meta);
		store.writeMeta();
		return store;
	}

	static list(dir: string): SessionMeta[] {
		if (!existsSync(dir)) return [];
		const metas: SessionMeta[] = [];
		for (const name of readdirSync(dir)) {
			// 排除轨迹计时副车（<id>.trace.jsonl，早期命名）等非会话文件
			if (!name.endsWith(".jsonl") || name.endsWith(".trace.jsonl")) continue;
			try {
				metas.push(readMeta(dir, name.slice(0, -6)));
			} catch {
				// 损坏文件跳过，不做恢复
			}
		}
		return metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	static latest(dir: string): SessionMeta | undefined {
		return SessionStore.list(dir)[0];
	}

	static reopen(dir: string, meta: SessionMeta): SessionStore {
		mkdirSync(dir, { recursive: true });
		const store = new SessionStore(dir, meta.id, meta);
		const loaded = SessionStore.load(dir, meta.id);
		if (loaded) {
			store.view = loaded.view;
			store.physicalCount = loaded.physical.length;
		}
		return store;
	}

	/**
	 * 读取会话：重放物理日志得到逻辑视图。
	 * 兼容 v1 旧文件（首行 meta + 纯消息行，无 ckpt/sidecar）。
	 */
	static load(dir: string, id: string): SessionLoad | undefined {
		const file = join(dir, `${id}.jsonl`);
		if (!existsSync(file)) return undefined;
		const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "");
		// v1 旧文件首行是 meta（无 k 字段）；v2 首行是条目（有 k），meta 在 sidecar
		const firstParsed = JSON.parse(lines[0]!) as Entry & { id?: string };
		const legacy = firstParsed.k === undefined;
		const meta = readMeta(dir, id, lines);
		const view: AgentMessage[] = [];
		const physical: AgentMessage[] = [];
	for (const line of lines.slice(legacy ? 1 : 0)) {
		const parsed = JSON.parse(line) as Entry & Record<string, unknown>;
		// v1 行是裸 AgentMessage（无 k 包装），v2 行是 {k,m} —— 上次回归的根因，勿删这段兼容
		const isCkpt = (parsed as Entry).k === "ckpt";
		const msg = isCkpt || parsed.k === "msg" ? (parsed as Entry).m! : (parsed as unknown as AgentMessage);
		if (isCkpt) {
			view.length = 0;
			view.push(msg);
			continue;
		}
		view.push(msg);
		physical.push(msg);
	}
		return { meta, view, physical };
	}

	/** 直接修补元数据（rename/archive/stats），写入 sidecar */
	static patchMeta(dir: string, id: string, patch: Partial<SessionMeta>): SessionMeta | undefined {
		const loaded = SessionStore.load(dir, id);
		if (!loaded) return undefined;
		const merged: SessionMeta = { ...loaded.meta, ...patch, updatedAt: new Date().toISOString() };
		const file = join(dir, `${id}.meta.json`);
		const tmp = `${file}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`);
		renameSync(tmp, file);
		return merged;
	}

	/**
	 * 与文件同步当前消息视图（append-only 的核心）：
	 *  - 视图是文件重放的前缀延伸 → 只追加新增部分；
	 *  - 视图头部被替换（压缩）→ 追加一条检查点（携带摘要消息），再追加其余消息。
	 * 物理史前史永不删除。
	 */
	sync(all: AgentMessage[]): void {
		const common = commonPrefix(this.view, all);
		if (common < all.length) {
			if (common === this.view.length) {
				this.appendEntries(all.slice(common).map((m) => ({ k: "msg" as const, m })));
			} else {
				// 头部被替换：压缩检查点（携带摘要消息），其余消息照常追加
				this.appendEntries([{ k: "ckpt" as const, m: all[0] }]);
				this.appendEntries(all.slice(1).map((m) => ({ k: "msg" as const, m })));
			}
		}
		this.view = all.slice();
		this.meta.updatedAt = new Date().toISOString();
		this.meta.messageCount = all.length;
		this.meta.viewCount = all.length;
		this.meta.physicalCount = this.physicalCount;
		this.writeMeta();
	}

	setTitle(title: string, source: "user" | "auto"): void {
		this.meta.title = title;
		this.meta.titleSource = source;
		this.writeMeta();
	}

	setArchived(archived: boolean): void {
		this.meta.archived = archived;
		this.writeMeta();
	}

	setStats(stats: SessionStats): void {
		this.meta.stats = stats;
		this.writeMeta();
	}

	setProject(project: string): void {
		this.meta.project = project;
		this.writeMeta();
	}

	get metaSnapshot(): SessionMeta {
		return { ...this.meta };
	}

	private appendEntries(entries: Entry[]): void {
		if (entries.length === 0) return;
		const file = join(this.dir, `${this.id}.jsonl`);
		const prev = existsSync(file) ? readFileSync(file, "utf8") : "";
		const lines = entries.map((e) => JSON.stringify(e)).join("\n");
		const tmp = `${file}.tmp`;
		writeFileSync(tmp, prev + (prev && !prev.endsWith("\n") ? "\n" : "") + lines + "\n");
		renameSync(tmp, file);
		for (const e of entries) {
			if (e.k === "msg") {
				this.physicalCount++;
				this.view.push(e.m);
			} else {
				this.view.length = 0;
				this.view.push(e.m);
			}
		}
	}

	private writeMeta(): void {
		this.meta.updatedAt = new Date().toISOString();
		const file = join(this.dir, `${this.id}.meta.json`);
		const tmp = `${file}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(this.meta, null, 2)}\n`);
		renameSync(tmp, file);
	}
}

// ── 内部工具 ────────────────────────────────────────────────────────────────

function readMeta(dir: string, id: string, lines?: string[]): SessionMeta {
	const sidecar = join(dir, `${id}.meta.json`);
	if (existsSync(sidecar)) return JSON.parse(readFileSync(sidecar, "utf8")) as SessionMeta;
	// v1 兼容：首行就是 meta
	const first = (lines ?? readFileSync(join(dir, `${id}.jsonl`), "utf8").split("\n"))[0]!;
	const parsed = JSON.parse(first) as SessionMeta & { k?: string };
	if (parsed.k !== undefined) {
		// v2 文件但 sidecar 丢失：合成最小 meta
		return { id, provider: "?", modelId: "?", cwd: "?", createdAt: "", updatedAt: "", messageCount: 0 };
	}
	return parsed;
}

function commonPrefix(a: AgentMessage[], b: AgentMessage[]): number {
	let i = 0;
	const limit = Math.min(a.length, b.length);
	while (i < limit && sameMessage(a[i], b[i])) i++;
	return i;
}

/**
 * 语义相等：只比较 role/content/toolCallId。
 * timestamp 这类易变字段必须排除——否则调用方重建等价消息（新时间戳）会被误判为
 * "头部被替换"，制造多余压缩检查点。
 */
function sameMessage(x: AgentMessage, y: AgentMessage): boolean {
	const sig = (m: AgentMessage) => {
		const mm = m as { role?: string; content?: unknown; toolCallId?: string };
		return JSON.stringify([mm.role, mm.content, mm.toolCallId ?? null]);
	};
	return sig(x) === sig(y);
}
