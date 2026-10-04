/**
 * nanami/harness Web GUI 前端 v3（Codex 像素级画风）。
 *
 * v3 新增：模型下拉（/api/models，写 state.model 下一条消息生效）、
 * 工作文件夹选择（/api/folders + 新会话绑定 cwd）、左下角设置弹层、
 * 侧栏"项目"区显示当前 cwd。
 * 数据流不变：REST + SSE；快照权威、事件增量、run_end 全量重绘。
 */
"use strict";

const state = {
	sessionId: null,
	provider: null,
	permissionMode: "default",
	cwd: null,
	running: false,
	messages: [],
	lastSeq: 0,
	tools: new Map(),
	streamEl: null,
	streamBuf: "",
	approval: null,
	es: null,
	renderTimer: null,
	menuFor: null,
	themeMode: localStorage.getItem("nanami-theme-mode") ?? "system",
	stick: true, // 贴底跟随：用户滚离底部时置 false，流式更新不再拽动视口
	pendingImages: [], // 待发送图片：{data(base64), mimeType, name?, loading?}
	runStartTs: 0, // 本轮 run 起始时刻（客户端口径，驱动"已运行 xx 秒"）
	runTimerId: null,
	runArtifacts: new Map(), // 本轮 write/edit 产出：path → {path, op, add, del}
	artifactsEl: null, // 流式期间的产出卡元素
	lastEventAt: 0, // 最近一次 SSE 事件/连接成功时刻（驱动假死看门狗）
};

const $ = (id) => document.getElementById(id);
// 输入法组合中（拼音候选、回车确认英文原文等）：忽略按键，避免误触发送。
// keyCode 229 兜底 Safari —— 其 compositionend 先于最后一次 keydown 触发，isComposing 已为 false。
const imeComposing = (e) => e.isComposing || e.keyCode === 229;
const el = (tag, cls, text) => {
	const node = document.createElement(tag);
	if (cls) node.className = cls;
	if (text != null) node.textContent = text;
	return node;
};

// ── 主题（三态：system / light / dark）────────────────────────────────────
function resolveTheme() {
	if (state.themeMode !== "system") return state.themeMode;
	return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
const ICON_MOON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>';
const ICON_SUN = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>';
const ICON_ALERT = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';
const ICON_BULB = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex:0 0 auto;margin-top:2px"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>';

function applyTheme() {
	document.documentElement.dataset.theme = resolveTheme();
	const dark = resolveTheme() !== "light";
	$("btn-theme").innerHTML = dark ? ICON_MOON : ICON_SUN;
	const drawerIcon = $("drawer-theme-icon");
	if (drawerIcon) drawerIcon.innerHTML = dark ? ICON_MOON : ICON_SUN;
	document.querySelectorAll("#theme-seg-modal button").forEach((b) =>
		b.classList.toggle("on", b.dataset.themeMode === state.themeMode),
	);
}
function setThemeMode(mode) {
	state.themeMode = mode;
	localStorage.setItem("nanami-theme-mode", mode);
	applyTheme();
}
matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
	if (state.themeMode === "system") applyTheme();
});

// ── API ─────────────────────────────────────────────────────────────────────
async function api(path, options) {
	const res = await fetch(path, options);
	const body = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(body.error || res.statusText);
	return body;
}
const post = (path, data) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data || {}) });

// ── markdown（marked + 轻量消毒）───────────────────────────────────────────
function md(text) {
	const html = marked.parse(text ?? "", { breaks: true, async: false });
	const tpl = document.createElement("template");
	tpl.innerHTML = html;
	tpl.content.querySelectorAll("script,style,iframe,object").forEach((n) => n.remove());
	tpl.content.querySelectorAll("*").forEach((n) => {
		for (const attr of [...n.attributes]) {
			const name = attr.name.toLowerCase();
			if (name.startsWith("on") || (name === "href" && attr.value.trim().toLowerCase().startsWith("javascript:"))) {
				n.removeAttribute(attr.name);
			}
		}
	});
	const div = el("div", "md");
	div.append(...tpl.content.childNodes);
	return div;
}

// ── 渲染：消息快照（权威态）─────────────────────────────────────────────────
function renderAll(forceScroll = true) {
	const stage = $("messages");
	stage.replaceChildren();
	stopRunElapsed(); // 指示器随消息区重建，计时器一并撤掉（重新运行时会重挂）
	state.tools.clear();
	state.streamEl = null;
	state.artifactsEl = null;
	state.runArtifacts = new Map();
	document.body.classList.toggle("empty", state.messages.length === 0);
	$("hero").classList.toggle("hidden", state.messages.length > 0);
	// 轮次感知：user 消息是分隔符；每轮的 write/edit 汇成"产出卡"插在轮末
	let map = new Map();
	let turnLast = null;
	for (const m of state.messages) {
		if (m.role === "user" && turnLast) {
			flushArtifacts(map, turnLast);
			map = new Map();
		}
		if (m.role === "assistant") {
			for (const b of m.content ?? []) {
				if (b.type === "toolCall") collectArtifact(map, b.name, b.arguments);
			}
		}
		renderMessage(m);
		if (stage.lastElementChild) turnLast = stage.lastElementChild;
	}
	if (turnLast) flushArtifacts(map, turnLast);
	scrollDown(forceScroll);
}

function renderMessage(m) {
	if (m.role === "user") {
		const wrap = el("div", "msg user");
		const text = typeof m.content === "string" ? m.content : blocksToText(m.content);
		if (text) wrap.append(el("div", "msg-user-text", text));
		appendUserImages(wrap, blocksToImages(m.content));
		if (wrap.childNodes.length) {
			wrap.append(msgActions("user", m, wrap));
			$("messages").append(wrap);
		}
		return;
	}
	if (m.role === "assistant") {
		const wrap = el("div", "msg assistant");
		for (const block of m.content ?? []) {
			if (block.type === "thinking" && String(block.thinking ?? "").trim()) wrap.append(cotBlock(block.thinking));
			if (block.type === "text" && block.text?.trim()) wrap.append(md(block.text));
			if (block.type === "toolCall") wrap.append(toolCard(block.id, block.name, block.arguments, null, false, null));
		}
		wrap.append(msgActions("assistant", m, wrap));
		$("messages").append(wrap);
		return;
	}
	if (m.role === "toolResult") {
		const entry = state.tools.get(m.toolCallId);
		const resultText = blocksToText(m.content);
		if (entry) entry.update(resultText, m.isError, blocksToImages(m.content));
		else $("messages").append(toolCard(m.toolCallId, m.toolName, null, resultText, m.isError, null, blocksToImages(m.content)));
	}
}

function blocksToText(content) {
	if (typeof content === "string") return content;
	return (content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

/** 工具结果里的图片块（computer 截图等）：渲染成可点击放大的缩略图 */
function blocksToImages(content) {
	if (typeof content === "string") return [];
	return (content ?? []).filter((b) => b.type === "image" && b.data).map((b) => ({ data: b.data, mimeType: b.mimeType ?? "image/png" }));
}

/** 用户气泡里的图片块渲染（发送的乐观气泡与历史快照共用） */
function appendUserImages(wrap, images) {
	for (const img of images) {
		const im = el("img", "tool-img user-img");
		im.src = `data:${img.mimeType};base64,${img.data}`;
		im.alt = "";
		im.onclick = () => window.open(im.src);
		wrap.append(im);
	}
}

// ── 图片附件（附件按钮 / 粘贴 / 拖入）──────────────────────────────────────
const IMAGE_MAX_EDGE = 1280; // 与电脑控制截图同参数
const IMAGE_MAX_COUNT = 6;

/** 当前模型是否支持视觉输入（反查 /api/models 已缓存的 input 字段） */
function currentModelSupportsImage() {
	const p = (state.modelProviders ?? []).find((pr) => pr.provider === state.provider);
	if (!p) return true; // 能力未知时不设卡
	const m = (p.models ?? []).find((mm) => mm.id === state.modelId);
	return !m || (m.input ?? []).includes("image");
}

/** 已完成编码、可随消息发送的图片 */
function readyImages() {
	return state.pendingImages.filter((img) => !img.loading && img.data);
}

/** 图片文件 → ImageContent：canvas 重编码（最长边 1280、JPEG q0.85，剥 EXIF；GIF 取首帧） */
function fileToImageContent(file) {
	return new Promise((resolve, reject) => {
		const url = URL.createObjectURL(file);
		const img = new Image();
		img.onload = () => {
			URL.revokeObjectURL(url);
			try {
				const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
				const w = Math.max(1, Math.round(img.naturalWidth * scale));
				const h = Math.max(1, Math.round(img.naturalHeight * scale));
				const canvas = document.createElement("canvas");
				canvas.width = w;
				canvas.height = h;
				canvas.getContext("2d").drawImage(img, 0, 0, w, h);
				const dataURL = canvas.toDataURL("image/jpeg", 0.85);
				resolve({ data: dataURL.slice(dataURL.indexOf(",") + 1), mimeType: "image/jpeg", name: file.name });
			} catch (err) {
				reject(err);
			}
		};
		img.onerror = () => {
			URL.revokeObjectURL(url);
			reject(new Error("图片解码失败"));
		};
		img.src = url;
	});
}

function addPendingImages(files) {
	const list = [...files].filter((f) => f.type.startsWith("image/"));
	if (!list.length) return;
	if (!currentModelSupportsImage()) {
		toast("当前模型不支持图片输入，请切到带「视觉」标签的模型");
		return;
	}
	for (const f of list) {
		if (state.pendingImages.length >= IMAGE_MAX_COUNT) {
			toast(`最多附带 ${IMAGE_MAX_COUNT} 张图片`);
			break;
		}
		const placeholder = { name: f.name, loading: true };
		state.pendingImages.push(placeholder);
		fileToImageContent(f)
			.then((img) => Object.assign(placeholder, img, { loading: false }))
			.catch((err) => {
				const i = state.pendingImages.indexOf(placeholder);
				if (i >= 0) state.pendingImages.splice(i, 1);
				toast(`${f.name}：${err.message}`);
			})
			.finally(renderAttachStrip);
	}
	renderAttachStrip();
}

function renderAttachStrip() {
	const strip = $("attach-strip");
	strip.classList.toggle("hidden", state.pendingImages.length === 0);
	strip.classList.toggle("warn", state.pendingImages.length > 0 && !currentModelSupportsImage());
	strip.replaceChildren();
	state.pendingImages.forEach((img, i) => {
		const cell = el("div", "attach-cell");
		if (img.loading) cell.append(el("div", "attach-thumb attach-loading"));
		else {
			const im = el("img", "attach-thumb");
			im.src = `data:${img.mimeType};base64,${img.data}`;
			im.alt = img.name ?? "";
			cell.append(im);
		}
		const x = el("button", "attach-x", "✕");
		x.title = "移除";
		x.onclick = () => {
			state.pendingImages.splice(i, 1);
			renderAttachStrip();
		};
		cell.append(x);
		strip.append(cell);
	});
	if (state.pendingImages.length) {
		const hint = currentModelSupportsImage() ? "" : " · 当前模型不支持图片";
		strip.append(el("span", "attach-hint", `${state.pendingImages.length} 张${hint}`));
	}
	updateSendEnabled();
}

function updateAttachVisibility() {
	$("btn-attach").classList.toggle("hidden", !currentModelSupportsImage());
}

function updateSendEnabled() {
	if (state.running) return;
	const blockedByGate = state.pendingImages.length > 0 && !currentModelSupportsImage();
	$("btn-send").disabled = blockedByGate || (!$("input").value.trim() && readyImages().length === 0);
}

// ── 消息 hover 操作条（复制 / 赞踩 / 分支）─────────────────────────────────
const ICON_COPY = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
const ICON_THUMB_UP = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/></svg>';
const ICON_THUMB_DOWN = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 14V2"/><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"/></svg>';
const ICON_BRANCH = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>';

function actionBtn(icon, title, onclick) {
	const b = el("button", "icon-btn msg-act");
	b.innerHTML = icon;
	b.title = title;
	b.onclick = (e) => {
		e.stopPropagation();
		onclick(b);
	};
	return b;
}

function feedbackKey(m) {
	return `nanami-fb:${state.sessionId}:${m.timestamp}`;
}

function paintFeedback(bar, m) {
	const cur = localStorage.getItem(feedbackKey(m)) ?? "";
	for (const b of bar.querySelectorAll("[data-fb]")) b.classList.toggle("fb-on", b.dataset.fb === cur);
}

function msgActions(kind, m, wrap) {
	const bar = el("div", `msg-actions act-${kind}`);
	if (kind === "user") {
		bar.append(
			actionBtn(ICON_COPY, "复制", () => {
				const t = wrap.querySelector(".msg-user-text");
				copyText((t ? t.textContent : wrap.textContent) ?? "", "已复制");
			}),
		);
		return bar;
	}
	bar.append(actionBtn(ICON_COPY, "复制", () => copyText(blocksToText(m.content), "已复制")));
	for (const [val, icon, label] of [["up", ICON_THUMB_UP, "赞"], ["down", ICON_THUMB_DOWN, "踩"]]) {
		const fbBtn = actionBtn(icon, label, () => {
			const key = feedbackKey(m);
			localStorage.setItem(key, localStorage.getItem(key) === val ? "" : val);
			paintFeedback(bar, m);
		});
		fbBtn.dataset.fb = val;
		bar.append(fbBtn);
	}
	paintFeedback(bar, m);
	bar.append(
		actionBtn(ICON_BRANCH, "以这条回复为终点创建分支会话", async () => {
			if (state.running) {
				toast("本轮运行结束后再分支");
				return;
			}
			try {
				const data = await post("/api/sessions/fork", { sessionId: state.sessionId, timestamp: m.timestamp });
				adopt(data);
				refreshSessions();
				toastMinor(`已分支到新会话 ${data.sessionId}`);
			} catch (err) {
				toast(err.message);
			}
		}),
	);
	return bar;
}

// ── 本轮产出/更改卡片（write/edit 工具汇总，ZCode 风）──────────────────────
function countLines(s) {
	return String(s ?? "").split("\n").filter((l) => l.trim() !== "").length;
}

/** 把一次 write/edit 工具调用并入产出汇总（同路径合并；write 以最后一次内容为准） */
function collectArtifact(map, name, args) {
	if (!args || (name !== "write" && name !== "edit")) return;
	const path = String(args.path ?? "");
	if (!path) return;
	const cur = map.get(path) ?? { path, op: "修改", add: 0, del: 0 };
	if (name === "write") {
		cur.op = "写入";
		cur.add = countLines(args.content);
		cur.del = 0;
	} else {
		for (const ed of args.edits ?? []) {
			cur.add += countLines(ed.newText);
			cur.del += countLines(ed.oldText);
		}
	}
	map.set(path, cur);
}

function artifactsCard(entries) {
	const card = el("div", "artifacts");
	const head = el("div", "artifacts-head");
	head.append(el("span", "caret", "▶"));
	const add = entries.reduce((s, e) => s + e.add, 0);
	const del = entries.reduce((s, e) => s + e.del, 0);
	const title = el("span", "artifacts-title", `${entries.length} 个文件已更改`);
	if (add) title.append(el("span", "diff-add", ` +${add}`));
	if (del) title.append(el("span", "diff-del", ` -${del}`));
	head.append(title);
	head.onclick = () => card.classList.toggle("open");
	card.append(head);
	const body = el("div", "artifacts-body");
	for (const e of entries) {
		const row = el("div", "artifacts-row");
		row.title = `${e.path}（点击复制路径）`;
		row.append(el("span", "artifacts-op", e.op));
		const p = el("span", "artifacts-path");
		const idx = e.path.lastIndexOf("/");
		if (idx >= 0) {
			p.append(el("span", "dim", e.path.slice(0, idx + 1)));
			p.append(el("span", null, e.path.slice(idx + 1)));
		} else {
			p.append(el("span", null, e.path));
		}
		row.append(p);
		const st = el("span", "artifacts-diff");
		if (e.add) st.append(el("span", "diff-add", `+${e.add}`));
		if (e.del) st.append(el("span", "diff-del", `-${e.del}`));
		row.append(st);
		row.onclick = () => copyText(e.path, "已复制路径");
		body.append(row);
	}
	card.append(body);
	return card;
}

/** 流式期间的实时产出卡（挂在流式气泡之后，run_end 重绘后由快照路径接管） */
function renderArtifactsLive() {
	const entries = [...state.runArtifacts.values()];
	if (!entries.length) return;
	const fresh = artifactsCard(entries);
	if (state.artifactsEl) state.artifactsEl.replaceWith(fresh);
	else if (state.streamEl) state.streamEl.after(fresh);
	else $("messages").append(fresh);
	state.artifactsEl = fresh;
}

/** 快照路径：把一轮的产出卡插到轮末锚点之后 */
function flushArtifacts(map, anchor) {
	const entries = [...map.values()];
	if (!entries.length || !anchor) return;
	const card = artifactsCard(entries);
	if (anchor.nextSibling) anchor.parentNode.insertBefore(card, anchor.nextSibling);
	else anchor.parentNode.append(card);
}

/** 思维链折叠块，默认展开（static 渲染与流式共用样式） */
function cotBlock(text, live) {
	const d = el("details", live ? "cot live" : "cot");
	d.open = true;
	d.append(el("summary", "cot-summary", live ? "思考中" : "思考过程"));
	d.append(el("div", "cot-body", String(text ?? "").trim()));
	return d;
}

function toolCard(callId, name, args, resultText, isError, running, resultImages) {
	const card = el("div", "tool-card");
	const head = el("div", "tool-head");
	head.append(el("span", "caret", "▶"));
	head.append(el("span", "tname", name));
	const argText = args ? compactArgs(name, args) : "";
	if (argText) head.append(el("span", "tpreview", argText));
	const status = el("span", "tstatus");
	head.append(status);
	const body = el("div", "tool-body");
	body.append(
		el("div", "lbl", "参数"),
		el("pre", null, args ? JSON.stringify(args, null, 2) : "(无参数)"),
		el("div", "lbl", "结果"),
		el("pre"),
	);
	const resultPre = body.querySelectorAll("pre")[1];
	const imgWrap = el("div", "tool-images");
	body.append(imgWrap);
	card.append(head, body);
	head.onclick = () => card.classList.toggle("open");

	function set(text, cls) {
		status.textContent = text;
		status.className = `tstatus ${cls}`;
	}
	function update(result, err, images) {
		resultPre.textContent = result || "(空)";
		imgWrap.replaceChildren();
		for (const img of images ?? []) {
			const im = el("img", "tool-img");
			im.src = `data:${img.mimeType};base64,${img.data}`;
			im.onclick = () => window.open(im.src, "_blank");
			imgWrap.append(im);
		}
		set(err ? "✗ 失败" : "✓ 完成", err ? "err" : "ok");
	}
	set(running ? "… 运行中" : "—", running ? "run" : "");
	if (resultText != null) update(resultText, isError, resultImages);

	state.tools.set(callId, { update, card });
	return card;
}

function compactArgs(name, args) {
	if (name === "bash" && typeof args.command === "string") return `$ ${args.command}`;
	if (name === "computer" && typeof args.action === "string") {
		const pos = args.x !== undefined ? ` ${args.x},${args.y}` : "";
		return `computer: ${args.action}${pos}`;
	}
	if (typeof args.path === "string") return args.path;
	if (typeof args.file_path === "string") return args.file_path;
	const s = JSON.stringify(args);
	return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}

// ── 流式 ────────────────────────────────────────────────────────────────────
function streamBegin() {
	state.streamBuf = "";
	state.thinkBuf = "";
	state.cotEl = null;
	state.cotBody = null;
	state.renderedUntil = 0;
	state.streamEl = el("div", "msg assistant streaming");
	state.streamText = el("div", "stream-text");
	state.cursorEl = el("span", "cursor");
	state.tailEl = el("div", "stream-tail");
	state.tailEl.append(state.cursorEl);
	state.streamText.append(state.tailEl);
	state.streamEl.append(state.streamText);
	$("messages").append(state.streamEl);
	scrollDown();
}

/** 流式思维链：delta 进 cot 折叠块（节流渲染），默认展开 */
function streamThinking(delta) {
	state.thinkBuf += delta;
	ensureCot();
	if (state.thinkTimer) return;
	state.thinkTimer = setTimeout(() => {
		state.thinkTimer = null;
		if (state.cotBody) {
			const b = state.cotBody;
			const follow = isNearBottom(b); // 用户在思考块内部上翻时不拽回
			b.textContent = state.thinkBuf;
			if (follow) b.scrollTop = b.scrollHeight;
			scrollDown();
		}
	}, 80);
}

function ensureCot() {
	if (state.cotEl) return;
	const d = el("details", "cot live");
	d.open = true;
	d.append(el("summary", "cot-summary", "思考中"));
	const body = el("div", "cot-body");
	d.append(body);
	state.streamEl.prepend(d);
	state.cotEl = d;
	state.cotBody = body;
}

/** 思考结束（首段正文开始）：固定标签、去掉 live 态；引用置空，后续步骤的思考另起新块 */
function settleCot() {
	if (!state.cotEl) return;
	state.cotEl.classList.remove("live");
	const s = state.cotEl.querySelector("summary");
	if (s) s.textContent = "思考过程";
	state.cotEl = null;
	state.cotBody = null;
}

function streamDelta(delta) {
	state.streamBuf += delta;
	settleCot();
	if (state.renderTimer) return;
	state.renderTimer = setTimeout(() => {
		state.renderTimer = null;
		if (!state.streamText) return;
		const buf = state.streamBuf;
		// 增量渲染：最后空行边界之前、且不在未闭合代码围栏内的内容定稿成块，此后不再重建
		let cut = buf.lastIndexOf("\n\n");
		while (cut > state.renderedUntil && fenceOpen(buf.slice(0, cut))) cut = buf.lastIndexOf("\n\n", cut - 1);
		if (cut > state.renderedUntil) {
			state.streamText.insertBefore(md(buf.slice(state.renderedUntil, cut)), state.tailEl);
			state.renderedUntil = cut;
		}
		// 未定稿尾部（通常仅当前段落）：小范围重渲染，光标挪到末尾
		const tail = md(buf.slice(state.renderedUntil));
		tail.append(state.cursorEl);
		state.tailEl.replaceChildren(tail);
		scrollDown();
	}, 80);
}

function streamEnd() {
	if (state.renderTimer) { clearTimeout(state.renderTimer); state.renderTimer = null; }
	if (state.thinkTimer) { clearTimeout(state.thinkTimer); state.thinkTimer = null; }
	if (state.cotEl && !state.thinkBuf.trim()) state.cotEl.remove();
	else settleCot();
	state.cotEl = null;
	state.cotBody = null;
	state.thinkBuf = "";
	state.streamEl = null;
	state.streamText = null;
	state.streamBuf = "";
	state.renderedUntil = 0;
	state.cursorEl?.remove(); // 避免运行结束后光标残留闪烁
	state.tailEl = null;
}

/** 代码围栏是否未闭合（行首 ``` 计数的奇偶）—— 流式定稿切割的安全判断 */
const fenceOpen = (s) => (s.match(/^[ \t]*```/gm) ?? []).length % 2 === 1;
/** 距底部不足 80px 视为贴底 */
function isNearBottom(elm) {
	return elm.scrollHeight - elm.scrollTop - elm.clientHeight < 80;
}
/** 贴底时跟随流式内容；force 时无视贴底状态强制回底（发消息、打开会话） */
function scrollDown(force) {
	const stream = $("stage");
	if (force) state.stick = true;
	if (!state.stick) return;
	stream.scrollTop = stream.scrollHeight;
}
// 用户拖拽/滚动 → 实时更新贴底状态，与模型生成完全解耦
$("stage").addEventListener("scroll", () => {
	state.stick = isNearBottom($("stage"));
});

// ── SSE（带自愈：onerror 重开 + 假死看门狗 + 断档对账）─────────────────────
let sseRetryTimer = null;
let sseFailures = 0;
let gapResyncTimer = null;

function openSSE() {
	state.es?.close();
	if (sseRetryTimer) { clearTimeout(sseRetryTimer); sseRetryTimer = null; }
	if (!state.sessionId) return;
	const es = new EventSource(`/api/events?sessionId=${state.sessionId}&since=${state.lastSeq}`);
	state.es = es;
	state.lastEventAt = Date.now();
	es.onopen = () => {
		sseFailures = 0;
		resync().catch(() => {}); // 连接(重)建成功即对账：校正 running 状态、补齐断线期间的消息
	};
	es.onmessage = (e) => {
		state.lastEventAt = Date.now();
		let evt;
		try { evt = JSON.parse(e.data); } catch { return; }
		if (evt.type === "ping") return;
		if (typeof evt.seq === "number") {
			if (evt.seq > state.lastSeq + 1) scheduleGapResync(); // 中间丢过事件(环溢出等)：拉权威快照补齐
			if (evt.seq <= state.lastSeq) return;
			state.lastSeq = evt.seq;
		}
		handleEvent(evt);
	};
	es.onerror = () => {
		// 浏览器对网络错误会自动重连(CONNECTING)，不用管；
		// 对 HTTP 错误(如服务端重启后 404)会永久放弃(CLOSED)——必须自己重开，
		// 服务端 /api/events 已支持自动复活会话，重开即自愈。
		if (es.readyState === EventSource.CLOSED) {
			sseFailures++;
			if (sseFailures > 6) {
				toast("与会话的连接已丢失且无法恢复，请刷新页面");
				return;
			}
			if (sseRetryTimer) clearTimeout(sseRetryTimer);
			sseRetryTimer = setTimeout(() => openSSE(), Math.min(1000 * sseFailures, 15_000));
		}
	};
}

/** 事件序号断档：说明中间丢过事件，防抖拉一次权威快照 */
function scheduleGapResync() {
	if (gapResyncTimer) return;
	gapResyncTimer = setTimeout(() => {
		gapResyncTimer = null;
		resync().catch(() => {});
	}, 800);
}

function handleEvent(evt) {
	switch (evt.type) {
		case "run_start":
			state.runArtifacts = new Map();
			state.artifactsEl = null;
			setRunning(true);
			break;
		case "agent":
			handleAgentEvent(evt.event ?? {});
			break;
		case "permission_request":
			setRunStatus("等待审批");
			showApproval(evt);
			break;
		case "permission_resolved":
			hideApproval();
			break;
		case "run_end":
			setRunning(false);
			resync();
			refreshSessions();
			loadMetrics();
			if (state.view === "trace") loadTrace();
			break;
		case "sessions_changed":
			refreshSessions();
			break;
		case "model_changed":
			if (evt.provider) state.provider = evt.provider;
			syncModelSelect(evt.modelId);
			break;
		case "error":
			toast(`出错了：${evt.message}`);
			setRunning(false);
			break;
	}
}

function handleAgentEvent(e) {
	switch (e.type) {
		case "message_end": {
			// 轨迹 tab 打开时，每个请求落地即刷新（防抖）
			scheduleTraceRefresh();
			break;
		}
		case "message_update": {
			const ev = e.assistantMessageEvent ?? {};
			if (ev.type === "thinking_start") {
				if (!state.streamEl) streamBegin();
				ensureCot();
				setRunStatus("深度思考中");
			} else if (ev.type === "thinking_delta") {
				if (!state.streamEl) streamBegin();
				streamThinking(ev.delta);
				setRunStatus("深度思考中");
			} else if (ev.type === "text_delta") {
				if (!state.streamEl) streamBegin();
				streamDelta(ev.delta);
				setRunStatus("生成回复");
			}
			break;
		}
		case "tool_execution_start": {
			if (!state.streamEl) streamBegin();
			state.cursorEl?.remove();
			state.streamEl.append(toolCard(e.toolCallId, e.toolName, e.args, null, null, true));
			const entry = state.tools.get(e.toolCallId);
			if (entry) entry.args = e.args; // 产出卡要用 write/edit 的路径与内容
			setRunStatus(`调用 ${e.toolName}`);
			scrollDown();
			break;
		}
		case "tool_execution_end": {
			state.tools.get(e.toolCallId)?.update(tryExtractText(e.result), e.isError, blocksToImages(e.result?.content));
			if (!e.isError) {
				collectArtifact(state.runArtifacts, e.toolName, state.tools.get(e.toolCallId)?.args);
				renderArtifactsLive();
			}
			setRunStatus("整合结果");
			scheduleTraceRefresh();
			break;
		}
		case "agent_end":
			streamEnd();
			scheduleTraceRefresh();
			break;
	}
}

function tryExtractText(result) {
	try {
		const content = result?.content;
		if (Array.isArray(content)) {
			return content.filter((c) => c.type === "text").map((c) => c.text).join("\n") || "(空)";
		}
	} catch { /* 保底走原始 JSON */ }
	return JSON.stringify(result);
}

// ── 审批卡 ──────────────────────────────────────────────────────────────────
function showApproval(evt) {
	state.approval = evt;
	const box = $("approval");
	box.replaceChildren();
	const head = el("div", "a-title");
	head.innerHTML = `${ICON_ALERT} 权限审批 · ${evt.toolName}`;
	box.append(head);
	box.append(el("div", "a-reason", evt.reason || "需要确认"));
	box.append(el("pre", null, JSON.stringify(evt.args ?? {}, null, 2)));
	const actions = el("div", "a-actions");
	const deny = el("button", "btn-ghost", "拒绝");
	const always = el("button", "btn-ghost", "总是允许");
	const allow = el("button", "btn-primary", "允许");
	allow.onclick = () => grant("allow");
	always.onclick = () => grant("always");
	deny.onclick = () => grant("deny");
	actions.append(deny, always, allow);
	box.append(actions);
	box.classList.remove("hidden");
}

async function grant(g) {
	if (!state.approval) return;
	try { await post("/api/approve", { sessionId: state.sessionId, requestId: state.approval.requestId, grant: g }); }
	catch (err) { toast(err.message); }
}

function hideApproval() {
	state.approval = null;
	$("approval").classList.add("hidden");
}

// ── 会话侧栏：按工作区分组（ZCode 式），文件夹图标切换展开/收起 ──────────────
const FOLDER_CLOSED = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>';
const FOLDER_OPEN = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 14l1.45-2.9A2 2 0 019.24 10H20a2 2 0 011.94 2.5l-1.55 6.2A2 2 0 0118.46 20H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h7a2 2 0 012 2v1"/></svg>';

const GROUP_SHOW_MAX = 5;
const state_sidebar = {
	folderCollapsed: new Set(JSON.parse(localStorage.getItem("nanami-folders-collapsed") ?? "[]")),
	folderMore: new Set(), // 点了"显示更多"的组（内存态即可）
};

function projectKeyOf(s) {
	return s.project || basename(s.cwd) || "未分组";
}

function recentTs(items) {
	return Math.max(...items.map((s) => new Date(s.updatedAt).getTime()));
}

function relTime(iso) {
	const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
	if (mins < 1) return "刚刚";
	if (mins < 60) return `${mins}分钟`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}小时`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}天`;
	const d = new Date(iso);
	return `${d.getMonth() + 1}月${d.getDate()}日`;
}

async function refreshSessions() {
	const { sessions } = await api("/api/sessions");
	const list = $("session-list");
	list.replaceChildren();
	if (sessions.length === 0) {
		list.append(el("div", "s-meta dim", "还没有会话"));
		return;
	}

	// 按工作区分组：项目名优先，未命名取 cwd 末段；组间按最新活动排序
	const groups = new Map();
	for (const s of sessions) {
		const key = projectKeyOf(s);
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(s);
	}
	const ordered = [...groups.entries()].sort((a, b) => recentTs(b[1]) - recentTs(a[1]));

	for (const [key, items] of ordered) {
		items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		const isOpen = !state_sidebar.folderCollapsed.has(key);
		list.append(groupHeader(key, items, isOpen));
		if (!isOpen) continue;
		const shown = state_sidebar.folderMore.has(key) ? items : items.slice(0, GROUP_SHOW_MAX);
		for (const s of shown) list.append(sessionRow(s));
		if (items.length > GROUP_SHOW_MAX) {
			const hidden = items.length - GROUP_SHOW_MAX;
			const more = el("button", "show-more", state_sidebar.folderMore.has(key) ? "收起" : `显示更多（${hidden}）`);
			more.onclick = () => {
				state_sidebar.folderMore.has(key) ? state_sidebar.folderMore.delete(key) : state_sidebar.folderMore.add(key);
				refreshSessions();
			};
			list.append(more);
		}
	}
}

function groupHeader(key, items, isOpen) {
	const head = el("button", "group-head");
	head.innerHTML = isOpen ? FOLDER_OPEN : FOLDER_CLOSED;
	head.append(el("span", "g-name", key));
	head.title = "点击展开 / 收起";
	head.onclick = () => {
		if (state_sidebar.folderCollapsed.has(key)) state_sidebar.folderCollapsed.delete(key);
		else state_sidebar.folderCollapsed.add(key);
		localStorage.setItem("nanami-folders-collapsed", JSON.stringify([...state_sidebar.folderCollapsed]));
		refreshSessions();
	};
	return head;
}

function sessionRow(s) {
	const item = el("div", "session-item" + (s.id === state.sessionId ? " active" : ""));
	item.append(el("div", "s-title", s.title || s.id));
	item.append(el("span", "s-time dim", relTime(s.updatedAt)));
	const more = el("button", "s-more", "⋯");
	more.title = "重命名 / 归档";
	more.onclick = (e) => { e.stopPropagation(); openRowMenu(s, more); };
	item.onclick = () => openSession(s.id);
	item.append(more);
	return item;
}

function openRowMenu(session, anchor) {
	closeRowMenu();
	state.menuFor = session.id;
	const menu = $("row-menu");
	menu.replaceChildren();
	menu.className = "popover menu";
	const rename = el("button", null, "重命名");
	rename.onclick = () => { closeRowMenu(); openRenameModal(session); };
	const archive = el("button", "danger", "归档");
	archive.onclick = () => { closeRowMenu(); archiveSession(session); };
	menu.append(rename, archive);
	menu.classList.remove("hidden");
	const rect = anchor.getBoundingClientRect();
	menu.style.top = `${Math.min(rect.bottom + 4, innerHeight - 100)}px`;
	menu.style.left = `${Math.min(rect.left - 70, innerWidth - 160)}px`;
	anchor.closest(".session-item")?.classList.add("menu-open");
}

function closeRowMenu() {
	$("row-menu").classList.add("hidden");
	document.querySelectorAll(".session-item.menu-open").forEach((n) => n.classList.remove("menu-open"));
	state.menuFor = null;
}

function openRenameModal(session) {
	$("modal-input").value = session.title || session.id;
	$("modal").classList.remove("hidden");
	const input = $("modal-input");
	input.focus();
	input.select();
	$("modal-ok").onclick = async () => {
		const title = input.value.trim();
		if (!title) return;
		try {
			await post("/api/sessions/rename", { sessionId: session.id, title });
			$("modal").classList.add("hidden");
			refreshSessions();
		} catch (err) { toast(err.message); }
	};
}
$("modal-cancel").onclick = () => $("modal").classList.add("hidden");
$("modal-input").addEventListener("keydown", (e) => {
	if (imeComposing(e)) return;
	if (e.key === "Enter") $("modal-ok").click();
	if (e.key === "Escape") $("modal").classList.add("hidden");
});

async function archiveSession(session) {
	try {
		await post("/api/sessions/archive", { sessionId: session.id });
		if (session.id === state.sessionId) await newSession();
		refreshSessions();
		toastMinor(`已归档「${session.title || session.id}」`);
	} catch (err) { toast(err.message); }
}

// ── 模型下拉 ────────────────────────────────────────────────────────────────
async function loadModels() {
	const data = await api("/api/models");
	state.modelProviders = data.providers ?? [];
	return state.modelProviders;
}

function syncModelSelect(modelId) {
	if (!modelId) return;
	state.modelId = modelId;
	$("model-label").textContent = modelId;
	updateAttachVisibility();
	if (state.pendingImages.length) renderAttachStrip();
}



// ── 工作文件夹 ──────────────────────────────────────────────────────────────
function basename(p) {
	return p ? p.split("/").filter(Boolean).pop() : "";
}

function updateProjectUI() {
	const has = !!state.cwd;
	$("folder-label").textContent = has ? basename(state.cwd) : "选择文件夹";
}

async function openFolderPop() {
	// 旧 popover 已由"创建项目"弹窗接管
	await openProjectModal();
}

async function switchFolder(cwd) {
	try {
		const data = await post("/api/sessions", { cwd });
		adopt(data);
		toastMinor(`新会话已绑定 ${basename(cwd)}`);
	} catch (err) { toast(err.message); }
}

// ── 创建项目弹窗（名称 + 文件夹浏览器 + 记忆隔离）──────────────────────────
const pm = { path: null, selected: null };

async function openProjectModal() {
	closePops();
	$("project-modal").classList.remove("hidden");
	const input = $("pm-name");
	input.value = "";
	pm.selected = null;
	updatePmSelected();
	await browseTo(state.cwd ?? process.cwd());
	input.focus();
}

async function browseTo(path) {
	try {
		const data = await api(`/api/fs/browse?path=${encodeURIComponent(path)}`);
		pm.path = data.path;
		$("pm-path").textContent = data.path;
		const dirs = $("pm-dirs");
		dirs.replaceChildren();
		if (data.dirs.length === 0) dirs.append(el("div", "p-dir empty", "（没有子文件夹）"));
		for (const name of data.dirs) {
			const b = el("button", "p-dir", name);
			b.onclick = () => browseTo(`${data.path}/${name}`);
			dirs.append(b);
		}
	} catch (err) { toast(err.message); }
}

function updatePmSelected() {
	const sel = $("pm-selected");
	const browser = $("pm-browser");
	if (pm.selected) {
		sel.textContent = pm.selected;
		sel.classList.remove("hidden");
		browser.classList.add("hidden");
		$("pm-create").disabled = false;
	} else {
		sel.classList.add("hidden");
		browser.classList.remove("hidden");
		$("pm-create").disabled = true;
	}
}

async function createProject() {
	const name = $("pm-name").value.trim() || basename(pm.selected);
	const isolateMemory = $("pm-memory").value === "isolated";
	try {
		const data = await post("/api/sessions", {
			cwd: pm.selected,
			projectName: name,
			isolateMemory,
		});
		$("project-modal").classList.add("hidden");
		adopt(data);
		toastMinor(`已创建项目「${name}」${isolateMemory ? "（记忆隔离）" : ""}`);
	} catch (err) { toast(err.message); }
}

// ── 抽屉（点头像伸出）+ 设置弹窗 ────────────────────────────────────────────
function toggleDrawer(force) {
	const drawer = $("drawer");
	const overlay = $("drawer-overlay");
	const show = force ?? drawer.classList.contains("hidden");
	drawer.classList.toggle("hidden", !show);
	overlay.classList.toggle("hidden", !show);
}

async function openSettingsModal() {
	toggleDrawer(false);
	$("settings-modal").classList.remove("hidden");
	try {
		const settings = await api("/api/settings");
		$("set-default-perm").value = settings.defaultPermissionMode;
		if (!state.modelId) state.modelId = settings.defaultModelId;
		$("set-provider").textContent = `${state.provider ?? settings.defaultProvider} · ${settings.defaultModelId}`;
		$("set-url").textContent = settings.url;
		applyTheme();
	} catch (err) { toast(err.message); }
	if ((state.smTab ?? "general") === "model") renderProviders();
	switchSmTab(state.smTab ?? "general");
}

// ── 模型 tab：DSH 式服务商管理面板 ─────────────────────────────────────────
let provData = null;

async function renderProviders() {
	const box = $("provider-cards");
	box.replaceChildren(el("div", "s-meta dim", "加载中…"));
	try {
		provData = await api("/api/models");
	} catch (err) {
		box.replaceChildren(el("div", "s-meta dim", `加载失败：${err.message}`));
		return;
	}
	const { providers, current, files } = provData;
	$("pm-cred-path-inline").textContent = files.credentials.replace(/^\/Users\/[^/]+/, "~");
	// 可用优先；组内自定义在前、按显示名排序
	const sorted = [...providers].filter((p) => p.models.length).sort((a, b) => {
		if (a.available !== b.available) return a.available ? -1 : 1;
		if (a.source !== b.source) return a.source === "custom" ? -1 : 1;
		return (a.providerName || a.provider).localeCompare(b.providerName || b.provider);
	});
	box.replaceChildren();
	if (!sorted.length) box.append(el("div", "s-meta dim", "没有可用模型"));
	for (const p of sorted) box.append(provCard(p, current));
}

function provCard(p, current) {
	const card = el("div", "prov-card" + (p.available ? "" : " off"));
	const row = el("div", "prov-row");
	row.append(el("span", "prov-dot" + (p.available ? " ok" : "")));
	const main = el("div", "prov-main");
	const nameRow = el("div", "prov-name-row");
	nameRow.append(el("b", "prov-name", p.providerName || p.provider));
	nameRow.append(el("span", "prov-badge" + (p.source === "custom" ? " custom" : ""), p.source === "custom" ? "自定义" : "内置"));
	nameRow.append(el("span", "prov-count", `${p.models.length} 个模型`));
	main.append(nameRow);
	main.append(el("div", "prov-sub",
		p.available ? p.provider : `未配置密钥 · env ${p.envHint}`));
	row.append(main);
	const caret = el("span", "prov-caret", "▸");
	row.append(caret);
	card.append(row);

	const models = el("div", "prov-models");
	const isDefaultProv = current.provider === p.provider;
	for (const m of p.models) {
		const isDefault = isDefaultProv && current.modelId === m.id;
		const mrow = el("div", "pm-row" + (isDefault ? " on" : ""));
		mrow.append(el("span", "pm-check", isDefault ? "✓" : ""));
		mrow.append(el("span", "pm-id mono", m.id));
		const tags = el("span", "pm-tags");
		if ((m.input ?? []).includes("image")) tags.append(el("span", "pm-tag", "视觉"));
		tags.append(el("span", "pm-tag dim", `${Math.round((m.contextWindow ?? 0) / 1000)}k`));
		mrow.append(tags);
		mrow.title = p.available ? "设为新会话默认模型" : "该服务商未配置密钥，设置后新会话将无法运行";
		mrow.onclick = async (e) => {
			e.stopPropagation();
			if (!p.available) { toast(`${p.providerName} 未配置密钥：在 ${provData.files.credentials} 写入 ${p.envHint} 后重启服务`); return; }
			try {
				await post("/api/settings", { defaultProvider: p.provider, defaultModelId: m.id });
				current.provider = p.provider;
				current.modelId = m.id;
				renderProviders();
				toastMinor(`默认模型：${p.providerName}/${m.id}`);
			} catch (err) { toast(err.message); }
		};
		models.append(mrow);
	}
	card.append(models);
	row.onclick = () => {
		const open = card.classList.toggle("open");
		caret.classList.toggle("rot", open);
	};
	return card;
}

function copyText(text, label) {
	navigator.clipboard.writeText(text).then(() => toastMinor(`已复制${label ?? ""}`), () => toast("复制失败"));
}

function revealInFinder(target) {
	post("/api/reveal", { target }).catch((e) => toast(e.message));
}

function switchSmTab(tab) {
	state.smTab = tab;
	document.querySelectorAll(".sm-tab").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
	document.querySelectorAll(".sm-pane").forEach((p) => p.classList.toggle("on", p.id === `pane-${tab}`));
	if (tab === "usage") loadUsage();
	if (tab === "model") renderProviders();
}

function closeSettingsModal() {
	$("settings-modal").classList.add("hidden");
}

async function loadUsage() {
	const box = $("usage-stats");
	box.replaceChildren(el("div", "s-meta dim", "统计中…"));
	try {
		const u = await api("/api/usage");
		state.usageData = u;
		// 五张统计卡（对齐 ZCode）：累计 / 峰值(单日) / 最长聊天时长 / 当前连续 / 最长连续
		box.replaceChildren();
		for (const [num, label] of [
			[fmtTokens(u.tokens), "累计 Token 数"],
			[fmtTokens(u.peakTokens), "峰值 Token 数"],
			[fmtDuration(u.maxDurationMs), "最长聊天时长"],
			[`${u.currentStreak} 天`, "当前连续天数"],
			[`${u.longestStreak} 天`, "最长连续天数"],
		]) {
			const card = el("div", "stat-card");
			card.append(el("div", "stat-num", String(num)), el("div", "stat-label", label));
			box.append(card);
		}
		renderHeatmap(u.daily);
		renderTrend(u.daily);
		const table = $("usage-table");
		table.replaceChildren();
		if (u.per.length === 0) table.append(el("div", "s-meta dim", "暂无数据"));
		for (const row of u.per) {
			const line = el("div", "usage-row");
			line.append(el("span", "u-title", row.title));
			line.append(el("span", "u-meta", `${row.messages} 条`));
			line.append(el("span", "u-meta", fmtTokens(row.tokens)));
			table.append(line);
		}
	} catch (err) {
		box.replaceChildren(el("div", "s-meta dim", `加载失败：${err.message}`));
	}
}

const MODEL_COLORS = ["#4a8dff", "#34c759", "#ff9f0a", "#bf5af2"];

function fmtDuration(ms) {
	if (!ms || ms < 60_000) return "0 分钟";
	const mins = Math.round(ms / 60_000);
	if (mins < 60) return `${mins} 分钟`;
	return `${Math.floor(mins / 60)} 小时 ${mins % 60} 分钟`;
}

function localDate(ts) {
	const d = new Date(ts);
	const pad = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Token 活动 heatmap：近 12 周，GitHub 贡献图式 */
function renderHeatmap(daily) {
	const grid = $("usage-heatmap");
	const months = $("heatmap-months");
	const byDate = new Map(daily.map((d) => [d.date, d.total]));
	const max = Math.max(...daily.map((d) => d.total), 1);
	const days = 84;
	const day = 86_400_000;
	grid.replaceChildren();
	months.replaceChildren();
	let lastMonth = -1;
	for (let i = 0; i < days; i++) {
		const ts = Date.now() - (days - 1 - i) * day;
		const d = new Date(ts);
		const key = localDate(ts);
		const total = byDate.get(key) ?? 0;
		const cell = el("div", "cell");
		if (total > 0) {
			const ratio = total / max;
			cell.classList.add(ratio > 0.75 ? "l4" : ratio > 0.5 ? "l3" : ratio > 0.25 ? "l2" : "l1");
		}
		cell.title = `${key} · ${fmtTokens(total)} tokens`;
		grid.append(cell);
		if (i % 7 === 0) {
			const m = d.getMonth();
			if (m !== lastMonth) {
				const label = el("span", null, `${m + 1}月`);
				label.style.width = "58px";
				label.style.flex = "0 0 auto";
				months.append(label);
				lastMonth = m;
			}
		}
	}
}

/** 每日 Token 趋势：近 7/30 日，按模型分色的 SVG 折线 */
function renderTrend(daily) {
	const days = state.usageRange ?? 7;
	const byDate = new Map(daily.map((d) => [d.date, d]));
	const day = 86_400_000;
	const window = [];
	for (let i = days - 1; i >= 0; i--) {
		const key = localDate(Date.now() - i * day);
		window.push({ date: key, total: byDate.get(key)?.total ?? 0, byModel: byDate.get(key)?.byModel ?? {} });
	}
	const totals = new Map();
	for (const d of window) for (const [m, t] of Object.entries(d.byModel)) totals.set(m, (totals.get(m) ?? 0) + t);
	const top = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
	const ymax = Math.max(...window.map((d) => d.total), 1);

	const legend = $("usage-legend");
	legend.replaceChildren();
	top.forEach(([model], i) => {
		const item = el("span");
		const sw = el("span", "sw");
		sw.style.background = MODEL_COLORS[i % MODEL_COLORS.length];
		item.append(sw, document.createTextNode(model));
		legend.append(item);
	});

	const W = 700, H = 220, L = 46, R = 12, T = 12, B = 26;
	const iw = W - L - R, ih = H - T - B;
	const x = (i) => L + (days === 1 ? iw / 2 : (i / (days - 1)) * iw);
	const y = (v) => T + ih - (v / ymax) * ih;
	let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">`;
	for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
		const gy = y(ymax * frac);
		svg += `<line class="axis" x1="${L}" y1="${gy}" x2="${W - R}" y2="${gy}"/>`;
		svg += `<text class="grid-label" x="${L - 6}" y="${gy}" text-anchor="end">${fmtTokens(ymax * frac)}</text>`;
	}
	for (const i of [0, Math.floor((days - 1) / 2), days - 1]) {
		svg += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${window[i].date.slice(5).replace("-", "/")}</text>`;
	}
	top.forEach(([model], si) => {
		const color = MODEL_COLORS[si % MODEL_COLORS.length];
		const pts = window.map((d, i) => `${x(i)},${y(d.byModel[model] ?? 0)}`).join(" ");
		svg += `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`;
	});
	svg += "</svg>";
	$("usage-trend").replaceChildren();
	$("usage-trend").innerHTML = svg;
}

function fmtTokens(n) {
	n = n ?? 0;
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

function closePops() {
	closeRowMenu();
}
document.addEventListener("click", (e) => {
	const t = e.target;
	if (state.menuFor && !t.closest?.("#row-menu") && !t.closest?.(".s-more")) closeRowMenu();
});
document.addEventListener("keydown", (e) => {
	if (e.key === "Escape") {
		closePops();
		$("project-modal").classList.add("hidden");
		if (!$("settings-modal").classList.contains("hidden")) closeSettingsModal();
		toggleDrawer(false);
	}
});

// ── 视图切换（对话 | 轨迹）──────────────────────────────────────────────────
function switchView(view) {
	state.view = view;
	document.body.classList.toggle("trace", view === "trace");
	$("trace-view").classList.toggle("hidden", view !== "trace");
	document.querySelectorAll("#view-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
	if (view === "trace") loadTrace();
}

/** 轨迹视图实时刷新：事件驱动 + 500ms 防抖（只在 trace tab 可见时拉取） */
let traceRefreshTimer = null;
function scheduleTraceRefresh() {
	if (state.view !== "trace") return;
	if (traceRefreshTimer) return;
	traceRefreshTimer = setTimeout(() => {
		traceRefreshTimer = null;
		loadTrace().catch(() => {});
	}, 500);
}

async function loadTrace() {
	const list = $("trace-list");
	list.replaceChildren(el("div", "s-meta dim", "加载中…"));
	try {
		const { steps } = await api(`/api/trace?sessionId=${state.sessionId}`);
		state.traceSteps = steps;
		list.replaceChildren();
		if (steps.length === 0) {
			list.append(el("div", "s-meta dim", "还没有可显示的步骤"));
			$("trace-detail").replaceChildren(el("div", "td-empty", "选择左侧步骤查看详情"));
			return;
		}
		let lastTurn = -1;
		for (const s of steps) {
			if (s.turn !== lastTurn) {
				lastTurn = s.turn;
				list.append(el("div", "trace-turn", `第 ${s.turn} 轮`));
			}
			list.append(traceRow(s));
		}
		// 默认选中最后一条助手/工具步骤
		const last = [...steps].reverse().find((s) => s.kind !== "user") ?? steps[steps.length - 1];
		selectTraceStep(steps.indexOf(last));
	} catch (err) {
		list.replaceChildren(el("div", "s-meta dim", `加载失败：${err.message}`));
	}
}

const TRACE_BADGE = { user: "用户", assistant: "助手", tool: "工具" };

function tracePreview(s) {
	if (s.kind === "user") return s.text || "(空)";
	if (s.kind === "assistant") return s.toolOnly ? "（仅工具调用）" : s.text || s.thinking || "(空)";
	return `${s.name}  ${oneLine(JSON.stringify(s.args ?? {}))}  →  ${oneLine(s.resultText ?? "(无结果)")}`;
}

function oneLine(s, max = 90) {
	s = String(s ?? "").replace(/\s+/g, " ").trim();
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

function traceRow(s, index) {
	const row = el("div", "trace-row");
	row.dataset.index = String(index);
	const badge = el("span", `trace-badge ${s.kind}`, TRACE_BADGE[s.kind]);
	const prev = el("div", "trace-preview");
	prev.append(el("div", "trace-text" + (s.isError ? " err" : ""), tracePreview(s)));
	const metas = [];
	if (s.kind === "assistant" && s.timing?.ttftMs > 0) metas.push(`首token ${(s.timing.ttftMs / 1000).toFixed(1)}s`);
	if (s.kind === "assistant" && s.timing?.tokPerSec > 0) metas.push(`${s.timing.tokPerSec} tok/s`);
	if (s.kind === "assistant" && s.tokens) metas.push(`${fmtTokens(s.tokens)} tok`);
	if (s.kind === "tool" && s.ms != null) metas.push(`${(s.ms / 1000).toFixed(1)}s`);
	if (metas.length) prev.append(el("div", "trace-meta", metas.join(" · ")));
	row.append(badge, prev);
	row.onclick = () => {
		document.querySelectorAll(".trace-row.sel").forEach((r) => r.classList.remove("sel"));
		row.classList.add("sel");
		renderTraceDetail(s);
	};
	return row;
}

function selectTraceStep(index) {
	const row = document.querySelectorAll(".trace-row")[index];
	if (row) row.click();
}

/** stopReason → 状态文案（对齐 DSH 的每步状态打印） */
const STOP_REASON_CN = {
	stop: "已完成", toolUse: "工具调用", length: "长度截断", error: "错误", aborted: "已中止", deferred: "挂起", pending: "进行中",
};

function renderTraceDetail(s) {
	const d = $("trace-detail");
	d.replaceChildren();
	const head = el("div", "td-head");
	head.append(el("span", `trace-badge ${s.kind}`, TRACE_BADGE[s.kind]));
	head.append(el("span", "td-turn", `第 ${s.turn} 轮${s.step ? ` · 步骤 ${s.step}` : ""}`));
	d.append(head);

	// 概述
	const overview = el("div", "td-section");
	overview.append(el("div", "td-label", "概述"));
	const status = s.kind === "tool"
		? (s.isError ? "错误" : "已完成")
		: (STOP_REASON_CN[s.stopReason] ?? "已完成");
	for (const [k, v] of [
		["状态", status],
		["模型", s.kind === "assistant" ? `${s.provider ? s.provider + "/" : ""}${s.model ?? "—"}` : (s.model ?? "—")],
		["Token", s.tokens ? fmtTokens(s.tokens) : "—"],
		["耗时", s.kind === "tool"
			? (s.ms != null ? `${(s.ms / 1000).toFixed(1)} 秒` : "—")
			: (s.timing?.llmMs != null ? `${(s.timing.llmMs / 1000).toFixed(1)} 秒` : "—")],
	]) {
		const kv = el("div", "td-kv");
		kv.append(el("span", null, k), el("span", null, String(v)));
		overview.append(kv);
	}
	d.append(overview);

	// 思考（CoT）
	if (s.thinking) {
		const sec = el("div", "td-section");
		sec.append(el("div", "td-label", "思考（CoT）"));
		sec.append(el("div", "td-thinking", s.thinking));
		d.append(sec);
	}

	// 内容
	if (s.kind === "user" || s.kind === "assistant") {
		const sec = el("div", "td-section");
		sec.append(el("div", "td-label", s.kind === "user" ? "输入" : "回复"));
		sec.append(el("div", "td-text", s.text || (s.kind === "assistant" && s.toolOnly ? "（仅工具调用）" : "（空）")));
		d.append(sec);
	}

	// 工具参数与结果
	if (s.kind === "tool") {
		const sec = el("div", "td-section");
		sec.append(el("div", "td-label", "参数"));
		sec.append(el("div", "td-code", JSON.stringify(s.args ?? {}, null, 2)));
		sec.append(el("div", "td-label", "结果"));
		sec.append(el("div", "td-code" + (s.isError ? " err" : ""), s.resultText || "(空)"));
		d.append(sec);
	}

	// 计时（assistant = 请求计时；工具 = 调用计时；缺失字段优雅回退 —）
	const timing = el("div", "td-section");
	timing.append(el("div", "td-label", s.kind === "tool" ? "调用计时" : "请求计时"));
	const t = s.kind === "tool" ? { startTs: s.startTs, llmMs: s.ms } : (s.timing ?? {});
	const kvRow = (k, v) => {
		const kv = el("div", "td-kv");
		kv.append(el("span", null, k), el("span", null, String(v)));
		timing.append(kv);
	};
	kvRow("开始时间", t.startTs ? new Date(t.startTs).toLocaleString("zh-CN", { hour12: false }) : "—");
	kvRow("总时长", t.llmMs > 0 ? `${(t.llmMs / 1000).toFixed(1)} 秒` : "—");
	if (s.kind !== "tool") {
		kvRow("首 token 延迟", t.ttftMs > 0 ? `${(t.ttftMs / 1000).toFixed(2)} 秒` : "—");
		kvRow("生成", t.genMs > 0 ? `${(t.genMs / 1000).toFixed(1)} 秒` : "—");
		kvRow("吞吐量", t.tokPerSec > 0 ? `${t.tokPerSec} tok/s` : "—");
	}
	d.append(timing);

	// Token 用量（assistant 专属，DSH 式分解；旧记录无数据整段显示 —）
	if (s.kind === "assistant") {
		const usage = el("div", "td-section");
		usage.append(el("div", "td-label", "Token 用量"));
		const has = t.inTok != null || t.outTok != null || t.cacheRead != null || t.totalTokens != null;
		if (!has) {
			usage.append(el("div", "td-kv", "此请求早于计量升级，无用量分解"));
		} else {
			for (const [k, v] of [
				["输入（未缓存）", t.inTok != null ? fmtTokens(t.inTok) : "—"],
				["缓存读取", t.cacheRead != null ? fmtTokens(t.cacheRead) : "—"],
				["缓存写入", t.cacheWrite != null ? fmtTokens(t.cacheWrite) : "—"],
				["输出", t.outTok != null ? fmtTokens(t.outTok) : "—"],
				["推理", t.reasoningTok ? fmtTokens(t.reasoningTok) : "—"],
				["合计", t.totalTokens != null ? fmtTokens(t.totalTokens) : "—"],
				["缓存命中", t.cacheHitPct > 0 ? `${t.cacheHitPct}%` : (t.cacheRead ? "0%" : "—")],
			]) {
				const kv = el("div", "td-kv");
				kv.append(el("span", null, k), el("span", null, String(v)));
				usage.append(kv);
			}
		}
		d.append(usage);
	}
}

// ── 指标条（输入框下方，DSH 式聚合）────────────────────────────────────────
async function loadMetrics() {
	if (!state.sessionId) { $("metrics-bar").classList.add("hidden"); return; }
	try {
		const m = await api(`/api/stats?sessionId=${state.sessionId}`);
		const bar = $("metrics-bar");
		if (m.turns === 0) { bar.classList.add("hidden"); return; }
		bar.replaceChildren();
		const parts = [
			`<b>${m.turns}</b> 轮 · <b>${m.steps}</b> 步`,
			`LLM <b>${fmtDur(m.llmMs)}</b> · 工具调用 <b>${fmtDur(m.toolMs)}</b>`,
			m.ttftAvgMs ? `首 token 平均 <b>${(m.ttftAvgMs / 1000).toFixed(1)} 秒</b> · <b>${m.tokPerSec.toFixed(0)} tok/s</b>` : null,
			m.cacheRead > 0 ? `缓存命中 <b>${m.cacheHitPct.toFixed(0)}%</b>` : null,
			`输入 <b>${fmtTokens(m.inTok)}</b> tok · 输出 <b>${fmtTokens(m.outTok)}</b> tok`,
		].filter(Boolean);
		bar.innerHTML = parts.join('<span class="sep">|</span>');
		bar.classList.remove("hidden");
	} catch { /* 指标条失败不影响主流程 */ }
}

function fmtDur(ms) {
	const s = Math.round((ms ?? 0) / 1000);
	if (s < 60) return `${s} 秒`;
	const mins = Math.floor(s / 60), secs = s % 60;
	if (mins < 60) return secs ? `${mins}分${secs}秒` : `${mins}分`;
	return `${Math.floor(mins / 60)}小时${mins % 60}分`;
}

// ── 权限/模型/推理强度 富菜单（ZCode 式：图标+名称+描述+当前项✓）────────────
const PERM_ITEMS = [
	{ mode: "readonly", title: "只读", desc: "仅读取和搜索，不修改", icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>' },
	{ mode: "default", title: "请求批准", desc: "改文件和跑命令前先问我", icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 00-4 0v5M14 10V4a2 2 0 00-4 0v6M10 10.5V6a2 2 0 00-4 0v8"/><path d="M18 8a2 2 0 114 0v6a8 8 0 01-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 012.83-2.82L7 15"/></svg>' },
	{ mode: "acceptEdits", title: "自动批准编辑", desc: "自动编辑文件", icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>' },
	{ mode: "bypass", title: "自动批准", desc: "减少确认次数，完全访问", icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>' },
];

const THINK_LEVELS = [
	{ level: "off", title: "关闭" },
	{ level: "low", title: "低" },
	{ level: "medium", title: "中" },
	{ level: "high", title: "高" },
	{ level: "max", title: "最高" },
];

function openRichMenu(anchor, build) {
	closeRichMenu();
	const menu = $("cmenu");
	menu.replaceChildren(build(menu));
	menu.classList.remove("hidden");
	const rect = anchor.getBoundingClientRect();
	menu.style.visibility = "hidden";
	menu.classList.remove("hidden");
	// 菜单向上弹出（composer 在页面底部）
	const top = rect.top - menu.offsetHeight - 8;
	menu.style.top = `${Math.max(12, top)}px`;
	menu.style.left = `${Math.min(Math.max(12, rect.left), innerWidth - menu.offsetWidth - 12)}px`;
	menu.style.visibility = "visible";
	state.menuAnchor = anchor;
}
function closeRichMenu() {
	$("cmenu").classList.add("hidden");
	state.menuAnchor = null;
}
document.addEventListener("click", (e) => {
	if (state.menuAnchor && !e.target.closest?.("#cmenu") && !e.target.closest?.(".chip-btn")) closeRichMenu();
});

function menuHead(text, badge) {
	const head = el("div", "menu2-head");
	head.append(el("span", null, text));
	if (badge) head.append(el("span", "menu2-badge", badge));
	return head;
}

function openPermMenu() {
	openRichMenu($("perm-chip"), () => {
		const frag = document.createDocumentFragment();
		for (const item of PERM_ITEMS) {
			const row = el("button", "menu2-item");
			const ic = el("span", "m2-ic");
			ic.innerHTML = item.icon; // SVG 必须走 innerHTML，textContent 会把标签当文本显示
			row.append(ic);
			const main = el("span", "m2-main");
			main.append(el("span", "m2-title", item.title));
			main.append(el("span", "m2-desc", item.desc));
			row.append(main);
			if (state.permissionMode === item.mode) row.append(el("span", "m2-check", "✓"));
			row.onclick = async () => {
				closeRichMenu();
				try {
					await post("/api/permission", { sessionId: state.sessionId, mode: item.mode });
					state.permissionMode = item.mode;
					$("perm-label").textContent = item.title;
					$("perm-ic").innerHTML = item.icon;
				} catch (err) { toast(err.message); }
			};
			frag.append(row);
		}
		return frag;
	});
}

async function openModelMenu() {
	const data = await api("/api/models");
	state.modelProviders = data.providers ?? [];
	openRichMenu($("model-chip"), () => {
		const frag = document.createDocumentFragment();
		const available = (state.modelProviders ?? []).filter((p) => p.models.length);
		for (const p of available) {
			frag.append(menuHead(p.providerName || p.provider, p.available ? null : "未配 key"));
			for (const m of p.models) {
				const row = el("button", "menu2-item");
				const main = el("span", "m2-main");
				const titleRow = el("span", "m2-title-row");
				titleRow.append(el("span", null, m.name));
				if ((m.input ?? []).includes("image")) titleRow.append(el("span", "menu2-badge", "视觉"));
				main.append(titleRow);
				row.append(main);
				const selected = state.modelId === m.id && (state.provider ?? data.current?.provider) === p.provider;
				if (selected) row.append(el("span", "m2-check", "✓"));
				row.title = p.available
					? `${p.provider}/${m.id} · ctx ${Math.round((m.contextWindow ?? 0) / 1000)}k`
					: `该 provider 未配置 key（~/.nanami/credentials.yaml 或环境变量），仍可切换`;
				row.onclick = async () => {
					closeRichMenu();
					try {
						await post("/api/model", { sessionId: state.sessionId, provider: p.provider, modelId: m.id });
						state.modelId = m.id;
						state.provider = p.provider;
						$("model-label").textContent = m.id;
						toastMinor(`模型已切到 ${p.provider}/${m.id}（下一条消息生效）`);
					} catch (err) { toast(err.message); }
				};
				frag.append(row);
			}
		}
		// 底部管理入口：跳设置弹窗的服务商面板
		frag.append(el("div", "menu2-sep"));
		const mgr = el("button", "menu2-item m2-manage");
		mgr.append(el("span", "m2-main", "管理模型提供商…"));
		mgr.onclick = () => {
			closeRichMenu();
			openSettingsModal();
			switchSmTab("model");
		};
		frag.append(mgr);
		return frag;
	});
}

function openThinkMenu() {
	openRichMenu($("think-chip"), () => {
		const frag = document.createDocumentFragment();
		frag.append(menuHead("推理强度", null));
		for (const lv of THINK_LEVELS) {
			const row = el("button", "menu2-item");
			const main = el("span", "m2-main");
			main.append(el("span", "m2-title", lv.title));
			row.append(main);
			if ((state.thinkingLevel || "") === lv.level) row.append(el("span", "m2-check", "✓"));
			row.onclick = async () => {
				closeRichMenu();
				try {
					await post("/api/thinking", { sessionId: state.sessionId, level: lv.level });
					state.thinkingLevel = lv.level;
					$("think-label").textContent = lv.title;
					toastMinor(`推理强度：${lv.title}（下一条消息生效）`);
				} catch (err) { toast(err.message); }
			};
			frag.append(row);
		}
		return frag;
	});
}

const THINK_CN = { off: "关闭", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高" };
function syncThinkLabel(level) {
	state.thinkingLevel = level || "";
	$("think-label").textContent = THINK_CN[level] || "默认";
}

// ── 会话切换 ────────────────────────────────────────────────────────────────
async function newSession() {
	const data = await post("/api/sessions", { cwd: state.cwd ?? undefined });
	adopt(data);
}

async function openSession(id) {
	const data = await post("/api/sessions", { resumeId: id });
	adopt(data);
}

function adopt(data) {
	state.sessionId = data.sessionId;
	state.permissionMode = data.permissionMode;
	state.cwd = data.cwd;
	state.modelId = data.modelId;
	state.messages = data.messages;
	state.lastSeq = data.seq;
	state.running = false;
	const permItem = PERM_ITEMS.find((p) => p.mode === data.permissionMode);
	$("perm-label").textContent = permItem?.title ?? data.permissionMode;
	$("perm-ic").innerHTML = permItem?.icon ?? "";
	syncModelSelect(data.modelId);
	syncThinkLabel(data.thinkingLevel);
	$("session-badge").textContent = data.resumed ? data.sessionId : "";
	$("input").disabled = false;
	setRunning(false);
	hideApproval();
	closePops();
	// 切换目标所在组自动展开（新会话可见）
	const adoptKey = data.project || basename(data.cwd) || "未分组";
	state_sidebar.folderCollapsed.delete(adoptKey);
	localStorage.setItem("nanami-folders-collapsed", JSON.stringify([...state_sidebar.folderCollapsed]));
	renderAll();
	updateProjectUI();
	openSSE();
	refreshSessions();
	loadMetrics();
	if (state.view === "trace") loadTrace();
}

async function resync() {
	if (!state.sessionId) return;
	const data = await api(`/api/messages?sessionId=${state.sessionId}`);
	state.messages = data.messages;
	state.cwd = data.cwd;
	state.lastSeq = Math.max(state.lastSeq, data.seq);
	// 运行状态对账：SSE 断线/服务端重启可能让我们错过 run_end/run_start
	if (typeof data.running === "boolean" && data.running !== state.running) setRunning(data.running);
	streamEnd();
	renderAll(false); // run 结束：只刷新数据，不拽动用户当前视口
	updateProjectUI();
}

function setRunning(run) {
	state.running = run;
	const btn = $("btn-send");
	btn.classList.toggle("stop", run);
	btn.title = run ? "停止" : "发送";
	if (run) btn.disabled = false;
	else updateSendEnabled();
	$("icon-send").classList.toggle("hidden", run);
	$("icon-stop").classList.toggle("hidden", !run);
	$("input").disabled = false;
	if (run) {
		if (!$("run-ind")) {
			const ind = el("div", "run-indicator");
			ind.id = "run-ind";
			ind.append(el("span", "run-dot"));
			const dots = el("span", "run-ellipsis");
			dots.append(el("i"), el("i"), el("i"));
			ind.append(el("span", "run-text", "运行中"), dots);
			const elapsed = el("span", "run-elapsed");
			elapsed.id = "run-elapsed";
			ind.append(elapsed);
			$("messages").append(ind);
			scrollDown();
		}
		setRunStatus("运行中");
		startRunElapsed();
	} else {
		stopRunElapsed();
		$("run-ind")?.remove();
	}
}

/** 运行指示器的实时状态文案（思考/调用工具/生成/等审批） */
function setRunStatus(text) {
	const t = document.querySelector("#run-ind .run-text");
	if (t) t.textContent = text;
}

/** 已运行计时：每秒刷新一次，给用户对耗时的即时感知 */
function startRunElapsed() {
	stopRunElapsed();
	state.runStartTs = Date.now();
	const paint = () => {
		const t = $("run-elapsed");
		if (t) t.textContent = formatRunElapsed(Date.now() - state.runStartTs);
	};
	paint();
	state.runTimerId = setInterval(paint, 1000);
}

function stopRunElapsed() {
	if (state.runTimerId) {
		clearInterval(state.runTimerId);
		state.runTimerId = null;
	}
}

function formatRunElapsed(ms) {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `已运行 ${s} 秒`;
	return `已运行 ${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

// ── 发送 / 停止 ─────────────────────────────────────────────────────────────
async function send() {
	const input = $("input");
	const prompt = input.value.trim();
	const images = readyImages();
	if (state.running) {
		// 运行状态可能因 SSE 断线错过 run_end 而卡住：对账一次而不是静默丢弃输入
		resync().catch(() => {});
		toast("上一轮还在运行，已为你刷新状态");
		return;
	}
	if (!prompt && images.length === 0) return;
	if (images.length > 0 && !currentModelSupportsImage()) {
		toast("当前模型不支持图片输入，请切到带「视觉」标签的模型");
		return;
	}
	input.value = "";
	autoGrow();
	const sent = [...state.pendingImages];
	state.pendingImages = [];
	renderAttachStrip();
	// 乐观气泡：文本 + 缩略图（run_end 后由权威快照重绘接管）
	const bubble = el("div", "msg user");
	if (prompt) bubble.append(el("div", "msg-user-text", prompt));
	appendUserImages(bubble, images);
	$("messages").append(bubble);
	scrollDown(true); // 用户主动发送：强制回到底部
	try {
		await post("/api/run", { sessionId: state.sessionId, prompt, images: images.map(({ data, mimeType }) => ({ data, mimeType })) });
	} catch (err) {
		toast(err.message);
		// 发送失败：图文退还，不丢内容
		state.pendingImages.push(...sent);
		renderAttachStrip();
		input.value = prompt;
		autoGrow();
	}
}

function autoGrow() {
	const input = $("input");
	input.style.height = "auto";
	input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
}

function toast(message) {
	const t = $("toast");
	t.style.background = "";
	t.style.color = "";
	t.textContent = message;
	t.classList.remove("hidden");
	setTimeout(() => t.classList.add("hidden"), 4000);
}
function toastMinor(message) {
	const t = $("toast");
	t.style.background = "var(--panel-2)";
	t.style.color = "var(--text)";
	t.textContent = message;
	t.classList.remove("hidden");
	setTimeout(() => {
		t.classList.add("hidden");
		t.style.background = "";
		t.style.color = "";
	}, 2400);
}

// ── 启动 ────────────────────────────────────────────────────────────────────
async function boot() {
	applyTheme();
	try {
		const health = await api("/api/health");
		$("health").classList.add("ok");
		$("health").title = `${health.provider} 已连接`;
		document.querySelectorAll(".health-dot").forEach((d) => d.classList.add("ok"));
		$("set-provider").textContent = health.provider;
		$("set-url").textContent = location.origin;
	} catch {
		$("health-text")?.replaceChildren("后端未连接");
	}
		await loadModels();
		syncModelSelect(state.modelId);
	await refreshSessions();
	const items = await api("/api/sessions");
	if (items.sessions.length > 0) await openSession(items.sessions[0].id);

	$("btn-theme").onclick = () => setThemeMode(resolveTheme() === "light" ? "dark" : "light");
	document.querySelectorAll("#view-tabs button").forEach((b) => (b.onclick = () => switchView(b.dataset.view)));
	document.querySelectorAll("#theme-seg button").forEach((b) => (b.onclick = () => setThemeMode(b.dataset.themeMode)));
	$("btn-new").onclick = () => newSession().catch(toast);
	$("btn-send").onclick = () => (state.running ? post("/api/abort", { sessionId: state.sessionId }).catch(toast) : send());
	$("input").addEventListener("keydown", (e) => {
		if (imeComposing(e)) return;
		if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
	});
	$("input").addEventListener("input", () => {
		autoGrow();
		if (!state.running) updateSendEnabled();
	});
	// 图片附件：按钮 / 粘贴 / 拖入
	$("btn-attach").onclick = () => $("attach-file").click();
	$("attach-file").addEventListener("change", () => {
		addPendingImages($("attach-file").files);
		$("attach-file").value = "";
	});
	$("input").addEventListener("paste", (e) => {
		const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
		if (files.length) {
			e.preventDefault();
			addPendingImages(files);
		}
	});
	const card = $("composer-card");
	card.addEventListener("dragover", (e) => {
		e.preventDefault();
		card.classList.add("dragging");
	});
	card.addEventListener("dragleave", () => card.classList.remove("dragging"));
	card.addEventListener("drop", (e) => {
		e.preventDefault();
		card.classList.remove("dragging");
		if (e.dataTransfer?.files?.length) addPendingImages(e.dataTransfer.files);
	});
	// SSE 假死看门狗：连接显示 OPEN 但 50 秒没有任何事件（心跳停了）→ 主动重开
	setInterval(() => {
		if (state.es && state.es.readyState === 1 && Date.now() - (state.lastEventAt || 0) > 50_000) openSSE();
	}, 10_000);
	// 切回前台（合盖唤醒/切标签回来）即对账一次：补运行状态与漏掉的消息
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible" && state.sessionId) resync().catch(() => {});
	});
	$("perm-chip").onclick = (e) => { e.stopPropagation(); openPermMenu(); };
	$("model-chip").onclick = (e) => { e.stopPropagation(); openModelMenu().catch(toast); };
	$("think-chip").onclick = (e) => { e.stopPropagation(); openThinkMenu(); };
	$("btn-folder").onclick = openProjectModal;
	// 抽屉 + 设置弹窗
	$("btn-user").onclick = () => toggleDrawer();
	$("drawer-overlay").onclick = () => toggleDrawer(false);
	$("drawer-theme").onclick = () => setThemeMode(resolveTheme() === "light" ? "dark" : "light");
	$("drawer-settings").onclick = () => { openSettingsModal().catch(toast); };
	document.querySelectorAll(".sm-tab").forEach((b) => (b.onclick = () => switchSmTab(b.dataset.tab)));
	$("sm-close").onclick = closeSettingsModal;
	$("settings-modal").onclick = (e) => { if (e.target === $("settings-modal")) closeSettingsModal(); };
	document.querySelectorAll("#theme-seg-modal button").forEach((b) => (b.onclick = () => setThemeMode(b.dataset.themeMode)));
	$("set-default-perm").onchange = async (e) => {
		try {
			await post("/api/settings", { defaultPermissionMode: e.target.value });
			toastMinor(`新会话默认权限：${e.target.selectedOptions[0].textContent}`);
		} catch (err) { toast(err.message); }
	};
	// 模型 tab：服务商面板 + 配置文件区 + 添加自定义提供商帮助块
	$("pmf-btn").onclick = () => {
		const panel = $("pm-files");
		if (!panel.classList.contains("hidden")) { panel.classList.add("hidden"); return; }
		if (!provData?.files || panel.childElementCount) { panel.classList.remove("hidden"); return; }
		const { config, credentials, credentialsExists } = provData.files;
		const tilde = (p) => p.replace(/^\/Users\/[^/]+/, "~");
		const pathRow = (label, path, target, extra) => {
			const row = el("div", "pmf-row");
			row.append(el("span", "pmf-label", label));
			row.append(el("span", "pmf-path mono", tilde(path)));
			if (extra) row.append(extra);
			const copy = el("button", "pmf-btn", "复制");
			copy.onclick = () => copyText(path, label);
			const show = el("button", "pmf-btn", "Finder 中显示");
			show.onclick = () => revealInFinder(target);
			row.append(copy, show);
			return row;
		};
		panel.append(pathRow("凭据文件", credentials, "credentials",
			credentialsExists ? undefined : el("span", "pmf-missing", "未创建")));
		panel.append(pathRow("用户配置", config, "config"));
		panel.append(el("div", "pmf-note", "凭据格式：一行一个 <ENV_VAR_NAME>: <key>（建议 600 权限）；改动后重启服务生效"));
		panel.classList.remove("hidden");
	};
	$("prov-add").onclick = () => {
		const help = $("prov-add-help");
		if (!help.classList.contains("hidden")) { help.classList.add("hidden"); return; }
		if (!help.childElementCount) {
			const template = JSON.stringify({
				customProviders: [{
					id: "my-lab", name: "My Lab", baseUrl: "https://api.example.com/v1",
					envVar: "MY_LAB_API_KEY",
					models: [{ id: "model-a", contextWindow: 128000 }],
				}],
			}, null, 2);
			help.append(el("div", "pmf-note",
				`OpenAI 兼容端点写入 ${provData ? provData.files.config.replace(/^\/Users\/[^/]+/, "~") : "~/.nanami/config.json"} 的 customProviders，key 写入凭据文件的 envVar；保存后重启服务。`));
			const pre = el("pre", "pmf-template mono", template);
			help.append(pre);
			const copy = el("button", "pmf-btn", "复制模板");
			copy.onclick = () => copyText(template, "配置模板");
			help.append(copy);
		}
		help.classList.remove("hidden");
	};
	document.querySelectorAll("#usage-range button").forEach((b) => {
		b.onclick = () => {
			state.usageRange = Number(b.dataset.range);
			document.querySelectorAll("#usage-range button").forEach((x) => x.classList.toggle("on", x === b));
			if (state.usageData) renderTrend(state.usageData.daily);
		};
	});
	// 创建项目弹窗
	$("pm-close").onclick = () => $("project-modal").classList.add("hidden");
	$("project-modal").onclick = (e) => { if (e.target === $("project-modal")) $("project-modal").classList.add("hidden"); };
	$("pm-up").onclick = () => {
		const parent = $("pm-path").textContent.trim();
		if (parent && parent !== "/") browseTo(parent);
	};
	$("pm-pick").onclick = () => {
		pm.selected = $("pm-path").textContent.trim();
		updatePmSelected();
		$("pm-name").value = $("pm-name").value || basename(pm.selected);
	};
	$("pm-selected").onclick = () => { // 已选中后可点回去改
		pm.selected = null;
		updatePmSelected();
		if (state.cwd) browseTo(state.cwd);
	};
	$("pm-create").onclick = createProject;
	$("pm-name").addEventListener("keydown", (e) => { if (!imeComposing(e) && e.key === "Enter") createProject(); });
}

boot();
