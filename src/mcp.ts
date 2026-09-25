/**
 * MCP 桥（M3a）。pi 完全没有 MCP 支持；这里用官方 MCP TypeScript SDK
 * 把外部 server 的工具映射成本地 AgentTool：
 *   模型侧命名 mcp__<server>__<raw>（与 ZCode/Claude Code 的命名一致）
 *   schema 直接透传 server 的 JSON Schema（pi 的参数校验吃原生 JSON Schema）
 * 支持 stdio（子进程）与 streamable-http 两种 transport。
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerConfig } from "./types.js";

interface McpToolInfo {
	name: string; // server 上的原始名
	description?: string;
	inputSchema: Record<string, unknown>;
}

export class McpBridge {
	private readonly clients = new Map<string, Client>();

	/** 连接全部 server 并枚举工具；单个 server 失败不拖垮整体（记 stderr 继续走） */
	async connect(servers: Record<string, McpServerConfig>): Promise<AgentTool<any, any>[]> {
		const tools: AgentTool<any, any>[] = [];
		for (const [serverName, config] of Object.entries(servers)) {
			try {
				const client = await this.connectOne(serverName, config);
				const { tools: rawTools } = await client.listTools();
				for (const raw of rawTools) {
					tools.push(this.wrapTool(serverName, client, raw as McpToolInfo));
				}
			} catch (err) {
				console.error(`[nanmi:mcp] server "${serverName}" 连接失败，已跳过:`, (err as Error).message);
			}
		}
		return tools;
	}

	async dispose(): Promise<void> {
		for (const [name, client] of this.clients) {
			try {
				await client.close();
			} catch (err) {
				console.error(`[nanmi:mcp] server "${name}" 关闭失败:`, (err as Error).message);
			}
		}
		this.clients.clear();
	}

	private async connectOne(serverName: string, config: McpServerConfig): Promise<Client> {
		const client = new Client({ name: "nanmi-harness", version: "0.1.0" });
		const transport =
			"url" in config
				? new StreamableHTTPClientTransport(new URL(config.url))
				: new StdioClientTransport({
						command: config.command,
						args: config.args ?? [],
						env: { ...process.env, ...config.env } as Record<string, string>,
					});
		await client.connect(transport);
		this.clients.set(serverName, client);
		return client;
	}

	private wrapTool(serverName: string, client: Client, raw: McpToolInfo): AgentTool<any, any> {
		const qualifiedName = `mcp__${serverName}__${raw.name}`;
		return {
			name: qualifiedName,
			label: `MCP:${serverName}/${raw.name}`,
			description: raw.description ?? `(MCP 工具 ${qualifiedName}，server 未提供描述)`,
			// server 的 JSON Schema 原样透传 —— AgentTool 的 TSchema 是结构类型，可直接断言
			parameters: (raw.inputSchema ?? { type: "object" }) as unknown as TSchema,
			execute: async (_toolCallId, params) => {
				const result = (await client.callTool({
					name: raw.name,
					arguments: params as Record<string, unknown>,
				})) as { content?: Array<Record<string, unknown>>; isError?: boolean };

				const text = (result.content ?? [])
					.map((block) => {
						if (block.type === "text") return String(block.text ?? "");
						return `(${String(block.type)})`;
					})
					.join("\n");
				if (result.isError) throw new Error(text || `MCP 工具 ${qualifiedName} 返回错误`);

				return {
					content: [{ type: "text", text: text || "(空结果)" }],
					details: { server: serverName, tool: raw.name },
				};
			},
		};
	}
}
