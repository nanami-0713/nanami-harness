/**
 * 本地 stdio MCP 测试 server：暴露一个 echo 工具 + 一个 add 工具。
 * 用来验证 harness 的 MCP 桥（M3a），不依赖任何外部服务。
 * 启动方式：node test/mcp-echo-server.mjs（由 StdioClientTransport 作为子进程拉起）
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "nanami-test-echo", version: "0.1.0" });

server.registerTool(
	"echo",
	{
		description: "原样返回输入的 text，用于连通性验证",
		inputSchema: { text: z.string().describe("要回显的文本") },
	},
	async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
);

server.registerTool(
	"add",
	{
		description: "两个整数相加",
		inputSchema: { a: z.number().int(), b: z.number().int() },
	},
	async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }),
);

await server.connect(new StdioServerTransport());
