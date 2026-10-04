/**
 * computer（M-D）：Codex 式电脑控制 —— 截图驱动的视觉-动作回路。
 *
 * 工作方式（对齐 Codex computer use 的形态）：
 *   模型调 computer({action:"screenshot"}) → 工具返回 PNG 图片块（视觉模型看到屏幕）
 *   → 模型在图像坐标系里推理 → 下一个动作（click/type/key/scroll…，坐标按截图像素给）
 *   → 工具执行后再附一张新截图 → 循环直到任务完成。
 *
 * macOS 后端（零依赖优先）：
 *   截图   screencapture -x（PNG）→ sips 降采样到 ≤ maxWidth（token 经济）
 *   分辨率 Finder desktop bounds = 逻辑点；截图是物理像素 → 点击坐标按比例换算（retina 安全）
 *   鼠标   cliclick（brew，存在则用）；退化 osascript "System Events"
 *   键入   osascript keystroke / key code（组合键支持 cmd/ctrl/alt/shift）
 *   滚轮   cliclick scroll；未装则报错并提示装法
 *
 * 权限现实（TCC，须在系统设置里给宿主进程授权，缺了对应能力会失败/拿黑图）：
 *   屏幕录制（Screen Recording）——截到别的 App 窗口
 *   辅助功能（Accessibility）——键入/点击/滚动
 *
 * 权限门语义：computer 属非只读工具，任何模式（除 bypass）首次调用都走审批。
 */
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

const execFileAsync = promisify(execFile);
const CLICLICK = "/opt/homebrew/bin/cliclick";

/** macOS virtual key codes（osascript "key code N"） */
const KEY_CODES: Record<string, number> = {
	return: 36, enter: 76, tab: 48, escape: 53, esc: 53, space: 49,
	delete: 51, backspace: 51, forwarddelete: 117,
	left: 123, right: 124, down: 125, up: 126,
	home: 115, end: 119, pageup: 116, pagedown: 121,
	f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
};
const MODIFIERS = new Set(["cmd", "command", "ctrl", "control", "alt", "option", "shift"]);

export interface ComputerConfig {
	/** 截图最长边（px），缺省 1280 —— 越小越省 token，定位精度也越低 */
	maxDimension?: number;
	/** 动作后自动附新截图（Codex 式回路的默认行为）；关掉则只有 screenshot 返回图 */
	screenshotAfterAction?: boolean;
}

/** 单屏逻辑分辨率（点）：JXA+CoreGraphics（CGRectGet* 返回标量可桥接；Finder AppleEvent 在后台进程下会超时） */
async function screenPointSize(): Promise<{ width: number; height: number }> {
	const { stdout } = await execFileAsync("osascript", [
		"-l", "JavaScript",
		"-e",
		'ObjC.import("CoreGraphics"); const id = $.CGMainDisplayID(); $.CGRectGetWidth($.CGDisplayBounds(id)) + "x" + $.CGRectGetHeight($.CGDisplayBounds(id))',
	]);
	const [w, h] = stdout.trim().split("x").map(Number);
	if (!w || !h) throw new Error(`无法读取屏幕分辨率: ${stdout.trim()}`);
	return { width: w, height: h };
}

interface CapturedShot {
	data: string;
	width: number;
	height: number;
	scale: number; // 点/px：模型坐标 × scale = 真实点击坐标
}

/** 截主屏 → 降采样 → base64。scale 由（降采样后宽 × 已知点宽）倒推。 */
async function capture(maxDimension: number): Promise<CapturedShot> {
	const dir = mkdtempSync(join(tmpdir(), "nanami-computer-"));
	const raw = join(dir, "raw.png");
	const out = join(dir, "out.png");
	try {
		const pts = await screenPointSize();
		await execFileAsync("screencapture", ["-x", "-t", "png", "-m", raw]);
		const dim = await execFileAsync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", raw]);
		const w = Number(/pixelWidth: (\d+)/.exec(dim.stdout)?.[1] ?? 0);
		const h = Number(/pixelHeight: (\d+)/.exec(dim.stdout)?.[1] ?? 0);
		if (!w || !h) throw new Error(`截图尺寸解析失败: ${dim.stdout.trim()}`);
		const longest = Math.max(w, h);
		if (longest > maxDimension) {
			await execFileAsync("sips", ["-Z", String(maxDimension), raw]);
			const dim2 = await execFileAsync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", raw]);
			const w2 = Number(/pixelWidth: (\d+)/.exec(dim2.stdout)?.[1] ?? w);
			// sips -Z 后缀不改名，直接用原文件
			const shot = readFileSync(raw);
			return { data: shot.toString("base64"), width: w2, height: Math.round((h * w2) / w), scale: pts.width / w2 };
		}
		const shot = readFileSync(raw);
		return { data: shot.toString("base64"), width: w, height: h, scale: pts.width / w };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function haveCliclick(): boolean {
	try {
		readFileSync(CLICLICK);
		return true;
	} catch {
		return false;
	}
}

/** 鼠标动作：cliclick 优先（精确），退化 System Events */
async function mouse(action: string, x: number, y: number, button: string): Promise<string> {
	if (haveCliclick()) {
		// cliclick 坐标即屏幕点；button 仅 click 族有意义
		const map: Record<string, string> = {
			click: "c", double_click: "dc", right_click: "rc", move: "m",
		};
		const cmd = map[action] ?? "c";
		await execFileAsync(CLICLICK, [`${cmd}:${Math.round(x)},${Math.round(y)}`]);
		return `cliclick ${cmd} @(${Math.round(x)},${Math.round(y)})`;
	}
	// 退化路径：System Events 没有"click at 全局坐标"的稳定 API，只支持移动 + 点击当前位置
	if (action === "move") {
		await execFileAsync("osascript", [
			"-e", `tell application "System Events" to set position of the mouse to {${Math.round(x)}, ${Math.round(y)}}`,
		]);
		return `mouse moved to (${Math.round(x)},${Math.round(y)})`;
	}
	throw new Error(
		`精确 ${action} 需要 cliclick（brew install cliclick）；未安装时仅支持 move 退化路径`,
	);
}

/** 键入文本（System Events keystroke，转义引号与反斜杠） */
async function typeText(text: string): Promise<string> {
	const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	await execFileAsync("osascript", [
		"-e", `tell application "System Events" to keystroke "${escaped}"`,
	]);
	return `typed ${text.length} chars`;
}

/** 组合键："cmd+c" / "cmd+shift+t" / "return"；修饰键外的部分查 key code 表 */
async function pressKeys(combo: string): Promise<string> {
	const parts = combo.split("+").map((p) => p.trim().toLowerCase()).filter(Boolean);
	const modifiers = parts.filter((p) => MODIFIERS.has(p));
	const main = parts.filter((p) => !MODIFIERS.has(p));
	if (main.length !== 1) throw new Error(`组合键格式："<modifier+>key"，如 cmd+c、return、alt+tab；收到 ${combo}`);
	const key = main[0]!;
	const code = KEY_CODES[key];
	const using = modifiers.length
		? ` using {${[...new Set(modifiers)].map((m) => (m.startsWith("command") || m === "cmd" ? "command down" : m.startsWith("ctrl") ? "control down" : m.startsWith("alt") || m.startsWith("opt") ? "option down" : "shift down")).join(", ")}}`
		: "";
	if (code !== undefined) {
		await execFileAsync("osascript", [
			"-e", `tell application "System Events" to key code ${code}${using}`,
		]);
	} else if (key.length === 1) {
		await execFileAsync("osascript", [
			"-e", `tell application "System Events" to keystroke "${key}"${using}`,
		]);
	} else {
		throw new Error(`未知按键 "${key}"；单字符或 key code 表内：${Object.keys(KEY_CODES).join("/")}`);
	}
	return `pressed ${combo}`;
}

/** 滚轮：cliclick scroll dy:dx（正 dy=向下滚） */
async function scroll(dx: number, dy: number): Promise<string> {
	if (!haveCliclick()) throw new Error("滚动需要 cliclick（brew install cliclick）");
	await execFileAsync(CLICLICK, [`scroll:${Math.round(dy)},${Math.round(dx)}`]);
	return `scrolled dx=${dx} dy=${dy}`;
}

const computerSchema = Type.Object({
	action: Type.Union(
		[
			Type.Literal("screenshot"), Type.Literal("get_screen_size"),
			Type.Literal("click"), Type.Literal("double_click"), Type.Literal("right_click"),
			Type.Literal("move"), Type.Literal("drag"), Type.Literal("type"), Type.Literal("key"),
			Type.Literal("scroll"), Type.Literal("wait"),
		],
		{ description: "要执行的动作" },
	),
	x: Type.Optional(Type.Number({ description: "X 坐标（以最近一张截图的像素坐标系为准）" })),
	y: Type.Optional(Type.Number({ description: "Y 坐标（以最近一张截图的像素坐标系为准）" })),
	text: Type.Optional(Type.String({ description: "type 动作：要键入的文本" })),
	key: Type.Optional(Type.String({ description: "key 动作：组合键，如 cmd+c / cmd+shift+t / return" })),
	dx: Type.Optional(Type.Number({ description: "scroll 动作：水平滚动量（正=右）" })),
	dy: Type.Optional(Type.Number({ description: "scroll 动作：垂直滚动量（正=下）" })),
	to_x: Type.Optional(Type.Number({ description: "drag 动作：目标 X（截图像素坐标）" })),
	to_y: Type.Optional(Type.Number({ description: "drag 动作：目标 Y（截图像素坐标）" })),
	seconds: Type.Optional(Type.Number({ description: "wait 动作：秒数（默认 1，上限 10）" })),
});

export interface ComputerDetails {
	action: string;
	imageWidth?: number;
	imageHeight?: number;
	/** 截图像素坐标 → 屏幕逻辑点的换算系数 */
	scale?: number;
	note?: string;
}

const COMPUTER_DESC = `Control the computer GUI (macOS, main display). Vision-action loop, Codex computer-use style: call screenshot first, study the returned image, then act with coordinates in THAT image's pixel space (top-left origin). After each action a fresh screenshot is attached so you can verify the result and continue.

Actions: screenshot | get_screen_size | click(x,y) | double_click(x,y) | right_click(x,y) | move(x,y) | drag(x,y→to_x,to_y) | type(text) | key(combo like cmd+c, return, alt+tab) | scroll(dx,dy) | wait(seconds).

Workflow discipline:
1. ALWAYS screenshot before acting blind; verify each action's effect on the follow-up screenshot before the next step.
2. Coordinates are pixels in the most recent screenshot you received (not native screen points) — the harness rescales for retina automatically.
3. Prefer precise UI targets (button centers, input fields you can see). If unsure, screenshot again rather than guessing.
4. type only focuses-then-types: click the target input FIRST, then type. key combos use macOS names (cmd/ctrl/alt/shift + key).
5. This controls the user's real machine — be surgical, no destructive exploration, stop when the task is done.`;

export function createComputerTool(config?: ComputerConfig): AgentTool<typeof computerSchema, ComputerDetails> {
	const maxDimension = config?.maxDimension ?? 1280;
	const shotAfterAction = config?.screenshotAfterAction ?? true;

	return {
		name: "computer",
		label: "Computer",
		description: COMPUTER_DESC,
		parameters: computerSchema,
		execute: async (_toolCallId, params) => {
			const { action } = params;
			const needShot = action === "screenshot" || shotAfterAction;
			let note = "";
			let details: ComputerDetails = { action };

			switch (action) {
				case "screenshot":
					break; // 直接落到统一截图出口
				case "get_screen_size": {
					const pts = await screenPointSize();
					note = `screen ${pts.width}x${pts.height} points`;
					details = { action, note };
					return { content: [{ type: "text", text: note }], details };
				}
				case "wait": {
					const s = Math.min(Math.max(params.seconds ?? 1, 0.1), 10);
					await new Promise((r) => setTimeout(r, s * 1000));
					note = `waited ${s}s`;
					break;
				}
				case "type": {
					if (!params.text) throw new Error("type 需要 text");
					note = await typeText(params.text);
					break;
				}
				case "key": {
					if (!params.key) throw new Error("key 需要组合键，如 cmd+c");
					note = await pressKeys(params.key);
					break;
				}
				case "scroll": {
					note = await scroll(params.dx ?? 0, params.dy ?? 0);
					break;
				}
				case "drag": {
					if (params.x === undefined || params.y === undefined || params.to_x === undefined || params.to_y === undefined) {
						throw new Error("drag 需要 x,y 与 to_x,to_y");
					}
					const s = (await captureForScale(maxDimension)).scale;
					await mouse("move", params.x * s, params.y * s, "");
					if (!haveCliclick()) throw new Error("drag 需要 cliclick（brew install cliclick）");
					await execFileAsync(CLICLICK, [
						`dd:${Math.round(params.x * s)},${Math.round(params.y * s)}`,
						`dm:${Math.round(params.to_x * s)},${Math.round(params.to_y * s)}`,
						`du:${Math.round(params.to_x * s)},${Math.round(params.to_y * s)}`,
					]);
					note = `dragged (${params.x},${params.y})→(${params.to_x},${params.to_y})`;
					break;
				}
				case "click":
				case "double_click":
				case "right_click":
				case "move": {
					if (params.x === undefined || params.y === undefined) throw new Error(`${action} 需要 x,y`);
					const s = (await captureForScale(maxDimension)).scale;
					note = await mouse(action, params.x * s, params.y * s, "");
					break;
				}
				default:
					throw new Error(`未知动作: ${action}`);
			}

			// 统一出口：截图（动作后附新图，或 screenshot 本尊）
			if (needShot) {
				const shot = await capture(maxDimension);
				details = { action, imageWidth: shot.width, imageHeight: shot.height, scale: shot.scale, note };
				return {
					content: [
						{ type: "text", text: note ? `${note}\n(current screen:)` : "(current screen:)" },
						{ type: "image", data: shot.data, mimeType: "image/png" },
					],
					details,
				};
			}
			return { content: [{ type: "text", text: note }], details: { action, note } };
		},
	};
}

/** 只为拿 scale 的轻量截图（坐标换算用，图片内容弃掉） */
async function captureForScale(maxDimension: number): Promise<{ scale: number }> {
	const shot = await capture(maxDimension);
	return { scale: shot.scale };
}
