# pi-agent-core 契约源码（阅读用副本）

本目录是 `@earendil-works/pi-agent-core@0.85.1` 的**逐字源码副本**，仅供对照精读——
运行时走 npm 包的 dist，这些副本不参与编译（因此其中的 import 在本项目中不可解析，属正常）。

| 文件 | 上游路径 | 内容 |
|---|---|---|
| `types.ts` | `packages/agent/src/types.ts`（463 行） | **契约的主体**：AgentEvent / AgentTool / AgentToolResult / BeforeToolCallContext·Result / AgentLoopTurnUpdate / AgentState / ShouldStopAfterTurnContext / StreamFn 引用 / ToolExecutionMode |
| `agent.ts` | `packages/agent/src/agent.ts`（607 行） | Agent 类 + **AgentOptions**（全部钩子参数）+ AgentInitialState；`:464` 每次 run 从 state 重取 model（模型/推理强度"下一条消息生效"的依据） |
| `stream-fn.ts` | `packages/agent/src/stream-fn.ts`（20 行） | 默认 streamFn 的注册机制（不设就抛错——这就是 index.ts 必须显式传 streamFn 的原因） |
| `LICENSE.pi` | 仓库根 LICENSE | 上游 MIT 许可（Mario Zechner / earendil-works），分发本项目时须随附 |

## 阅读地图：契约 ↔ 本项目的五条接缝

读类型时对着 `src/index.ts` 找落点，一一对应：

| pi 契约类型 | 落在 index.ts 的位置 | 本项目谁在用它 |
|---|---|---|
| `StreamFn`（types.ts） | `streamFn` 字段 | 转发 `models.streamSimple` —— L1↔L0 唯一接缝，换路由只改这行 |
| `BeforeToolCallContext/Result` | `beforeToolCall` 钩子 | hooks.preToolCall → PermissionGate.authorize 裁决链 |
| `AgentLoopTurnUpdate` + `ShouldStopAfterTurnContext` | `prepareNextTurnWithContext` | Compactor（压缩：换 context 并写回 state 防重压） |
| `AgentEvent`（types.ts:448 起） | `run()` 事件泵 / `attachEventSink` | Web 宿主的计时测量（TTFT/生成/工具时长）+ SSE |
| `AgentTool`/`AgentToolResult`（types.ts:406/383） | 所有工具的形状 | tools.ts 工厂 / tools-todo / subagent / mcp |
| `AgentOptions`（agent.ts:113 起） | `new Agent({...})` | 组装根的全部选项面 |

## 建议阅读顺序

1. `types.ts` 的 `AgentEvent`（:448）与 `AgentTool`（:406）——事件与工具是两大主线
2. `agent.ts` 的 `AgentOptions`（:113）与 `:464`（model 每轮重取）
3. `types.ts` 的 `BeforeToolCallContext`（:103）与 `AgentLoopTurnUpdate`（:143）——权限与压缩的挂点
4. `stream-fn.ts` 全文——20 行读完"provider 可替换"的机制

版本提醒：副本对应 **0.85.1**（本项目钉死版本）。升级 pi 时，用 `diff` 对比本目录与新版本的
`packages/agent/src/{types,agent}.ts`，即可快速看出契约面变化——这正是把契约源码放进项目的原因之一。
