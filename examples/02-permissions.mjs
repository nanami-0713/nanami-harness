#!/usr/bin/env node
/**
 * 权限门四档模式：纯逻辑演示，零网络、零成本，不需要 API key。
 *
 * 运行：npm run build && node examples/02-permissions.mjs
 *
 * 四档语义对齐 ZCode/Claude Code 的习惯：
 *   readonly    只读工具放行，写/执行一律拒绝
 *   default     读放行，写/执行弹审批（ask）
 *   acceptEdits  cwd 内写放行，cwd 外与执行仍审批
 *   bypass      全放行
 */
import { PermissionGate } from "../dist/index.js";

const cwd = process.cwd();

const cases = [
	["readonly + read", "readonly", "read", {}],
	["readonly + bash", "readonly", "bash", { command: "ls" }],
	["default + bash", "default", "bash", { command: "ls" }],
	["acceptEdits + cwd 内 write", "acceptEdits", "write", { path: `${cwd}/a.txt` }],
	["acceptEdits + cwd 外 write", "acceptEdits", "write", { path: "/etc/hosts" }],
	["bypass + bash", "bypass", "bash", { command: "echo hi" }],
];
for (const [name, mode, tool, args] of cases) {
	const { decision } = new PermissionGate({ mode, interactive: false }, cwd).check(tool, args);
	const icon = decision === "allow" ? "✅ 放行" : decision === "deny" ? "⛔ 拒绝" : "❓ 审批";
	console.log(`${icon}  ${name}`);
}

// 非交互环境的兜底语义：没有终端可问答时，ask 降级为 deny（fail-closed）
const gate = new PermissionGate({ mode: "default", interactive: false }, cwd);
const denied = await gate.authorize("bash", { command: "ls" });
console.log(`\n非交互 authorize(bash) → ${denied ? `拦截（${denied}）` : "放行"}`);

// 运行时切档：Web GUI 的模式下拉框走的就是这个入口
gate.setMode("bypass");
const after = await gate.authorize("bash", { command: "ls" });
console.log(`setMode('bypass') 后 authorize(bash) → ${after ? "拦截" : "放行"}`);
