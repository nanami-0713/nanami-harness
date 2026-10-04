/**
 * 轨迹计时采集（从 web-server 拆出，M·结构）。
 *
 * DSH 对齐口径：
 * TTFT 判定 = 首个"非空增量"——text_delta / thinking_delta / toolcall_delta 任一
 * （对齐 DSH isTokenDelta：纯工具轮次也有首 token；start/end 块事件不算）；
 * gen = 首增量 → message_end；每请求记录完整 usage 分解（未缓存输入/缓存读/写/输出/推理）
 * 与单请求缓存命中率 = cacheRead / (input + cacheRead + cacheWrite)。
 * 记录同时落盘 <id>.trace（append-only，扩展名刻意不用 .jsonl——会话列表按 *.jsonl 枚举），
 * 重开会话轨迹不丢。
 */
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionStats } from "./types.js";

/** trackTiming 所需的会话注册表最小面（web-server 的 SessionReg 结构满足，避免循环依赖） */
export interface TimingReg {
	id: string;
	live: SessionStats;
	traceTiming: Map<string, Record<string, unknown>>;
	curLlmStart: number | null;
	curLlmFirstDelta: number | null;
	curToolStart: Map<string, number>;
	harness: { sessionStore?: { dir: string } | undefined };
}

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

export function trackTiming(reg: TimingReg, event: Record<string, any>): void {
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

/** 计时记录：进内存 Map（/api/trace 即时读）+ 追加落盘 <id>.trace（重开恢复） */
function recordTiming(reg: TimingReg, key: string, record: Record<string, unknown>): void {
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
export function loadTiming(store: { dir: string } | undefined, id: string): Map<string, Record<string, unknown>> {
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
