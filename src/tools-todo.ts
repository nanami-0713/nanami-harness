/**
 * todo_write（M1a 自建工具）：pi 没有任务清单工具，这是 harness 的第一批原生工具之一。
 * 语义对齐 ZCode：整表替换、单进行项（同一时刻最多一条 in_progress）、落盘 .nanami/todos.json。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

const todoSchema = Type.Object({
	todos: Type.Array(
		Type.Object({
			content: Type.String({ description: "任务内容（一句话）" }),
			status: Type.Union(
				[Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")],
				{ description: "pending=待办, in_progress=进行中, completed=已完成" },
			),
			priority: Type.Optional(
				Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")], {
					description: "优先级，缺省 medium",
				}),
			),
		}),
		{ description: "完整替换当前清单。单进行项：同一时刻最多一条 in_progress；已完成项要及时标记" },
	),
});

export interface TodoItem {
	content: string;
	status: "pending" | "in_progress" | "completed";
	priority?: "high" | "medium" | "low";
}

export function createTodoTool(cwd: string): AgentTool<typeof todoSchema, { count: number }> {
	const file = join(cwd, ".nanami", "todos.json");
	const save = (todos: TodoItem[]) => {
		mkdirSync(join(cwd, ".nanami"), { recursive: true });
		writeFileSync(file, `${JSON.stringify(todos, null, 2)}\n`);
	};
	return {
		name: "todo_write",
		label: "Todo",
		description:
			"维护多步任务的任务清单。对非平凡的多步工作使用：开工前建表，每完成一步立即更新状态；一次只保持一条 in_progress；过期条目及时移除。",
		parameters: todoSchema,
		execute: async (_toolCallId, params) => {
			save(params.todos);
			const inProgress = params.todos.filter((t) => t.status === "in_progress").length;
			return {
				content: [
					{
						type: "text",
						text:
							inProgress > 1
								? `已保存 ${params.todos.length} 条，但注意：当前有 ${inProgress} 条 in_progress，违反单进行项原则`
								: `已保存 ${params.todos.length} 条任务`,
					},
				],
				details: { count: params.todos.length },
			};
		},
	};
}

/** 读取落盘的任务清单（resume 场景下让新会话知道旧任务） */
export function loadTodos(cwd: string): TodoItem[] {
	try {
		return JSON.parse(readFileSync(file(cwd), "utf8")) as TodoItem[];
	} catch {
		return [];
	}
}

function file(cwd: string): string {
	return join(cwd, ".nanami", "todos.json");
}
