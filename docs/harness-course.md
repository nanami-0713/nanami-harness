# Agent Harness 补课 —— 对着 @nanmi/harness 讲

> 2026-09-23。每个概念都给出三方对应：通用原理 → pi 源码锚点 → 我们内核里的位置。
> 配合阅读：`src/index.ts`（内核 120 行）、`src/smoke.ts`（冒烟）。

## 第 0 讲：一张总图与核心命题

```
 你看到的世界                harness 内核                      模型世界
┌──────────┐          ┌──────────────────────────┐      ┌─────────────┐
│ TUI/Web/ │ ←────────│  会话持久化 · 权限 · 压缩  │      │ LLM = 一个  │
│ CLI/无人 │  事件流   │  ┌────────────────────┐  │ 请求  │ 无状态函数  │
│ 值班外壳  │          │  │     agent loop     │──┼─────→│ f(消息)→消息│
└──────────┘          │  │  组上下文→调模型→   │ ←┼──────│ 无手 无眼   │
                      │  │  执行工具→回灌→循环 │  │ 响应  │ 无记忆      │
                      │  └────────────────────┘  │      └─────────────┘
                      │   工具面: bash/read/edit │
                      │   外挂: MCP/subagent/skill│
                      └──────────────────────────┘
```

**核心命题：LLM 只是一个无状态函数**——输入一叠消息，输出一条消息。它没有记忆（上下文窗口就是全部）、没有手（工具结果靠 harness 喂回）、没有眼（一切都是文本）。所谓 harness，就是给这个函数装上身体的那一层：记忆管理、手脚（工具）、规则（权限/提示词）、皮肤（UI）。

用你已有的四层执行栈心智模型（tool-call → 宿主 → Bash/原生工具 → syscall）定位：harness 就是"宿主"那一层的全部职责。ZCode 是一个 harness，DSH 是一个 harness 工厂，nanami-harness 是你自己的——`src/index.ts` 那 120 行就是这个身体的最小骨架。

## 第 1 讲：Agent Loop —— 领域 80% 的本质是一个 while 循环

```
messages = [system, ...history, user]
loop:
  resp = model(messages)             # 调一次 LLM
  messages.append(resp)
  if resp 没有 tool_calls: break      # 模型认为事办完了 → 终止
  for call in resp.tool_calls:       # （可并行）执行工具
    messages.append( execute(call) ) # 结果回灌
  continue                           # 带着结果再问模型
```

工程难点全在循环边缘：终止条件（end_turn / 轮数上限 / stop hook）、并行工具的提交顺序、执行中用户插话（steering 队列）、错误不炸循环（工具错误作为结果回灌而非抛异常）。

- pi：`packages/agent/src/agent-loop.ts:162`（runLoop；内层=推理+工具，外层=follow-up 队列）
- 我们：`NanmiHarness.run()` 就是给这个循环套的一轮壳。冒烟时"6 条消息"就是循环留下的脚印：用户 → 助手(tool_call) → 工具结果 → 助手(tool_call) → 工具结果 → 助手(收工)
- DSH：`dsh-agent-loop` 的 ReactLoopAgent，同名异构

## 第 2 讲：上下文窗口是唯一记忆 —— 上下文工程四件套

模型每轮都"失忆"，harness 必须每次把该带的递过去；但窗口有限且每 token 每轮都重算（你的"缓存重读税"审计就是这一讲的经济学）。四种手段，按侵入性排序：

1. **truncate** — 单条工具输出截断（pi bash 工具：超限落盘 temp 文件，回灌截断版+路径）
2. **prune** — 老工具结果剪头留尾（DSH tool-result-pruner：8192 阈值、头 4096 尾 1024）
3. **compact** — 旧历史整段替换为摘要，保留近端（第 4 讲展开）
4. **externalize** — 大产物落盘，上下文只留路径

- pi 挂点：`transformContext` 钩子（每次调用前改写消息数组）——我们 M1+ 的位置
- ZCode 的 auto-compact = 手段 3 的产品化

## 第 3 讲：工具系统 —— "错误即结果"是自愈的关键

Tool = name + JSON Schema 参数 + execute。模型只产出"名字 + 参数 JSON"，校验和执行全在 harness（TypeBox 校验失败也当结果回灌）。

最重要的设计原则：**工具失败不是异常，是一条普通 tool result**。"file not found" 回给模型，模型自己换路径——异常一抛循环就断，错误一回灌 agent 就能自愈。这是 agent 区别于传统程序的本质。

- pi：`AgentTool` 接口（`packages/agent/src/types.ts:406`；execute 收 toolCallId/params/onUpdate，返回 content+details）
- 我们：M0 的 `createBashTool(cwd)` 借的生产实现，自带 truncate+externalize（手段 1、4 内建）
- `beforeToolCall` 是执行前拦截点 → 第 6 讲权限挂这

## 第 4 讲：Compaction —— 记忆折叠

- 触发：tokens > contextWindow − reserve（pi 默认 reserve 16384）
- 动作：较旧的一段历史交給模型写摘要，**替换**原文；保留近端约 20k token 原文（对话局部性强，近端保真价值高）
- 兜底：真溢出（API 报 context length error）→ 强制压缩后重试一次

- pi：`compaction/compaction.ts:250` shouldCompact + `prepareNextTurn` 钩子（M2 挂点）
- DSH compaction-basic 的 0.55/0.2 是你实测的折叠节奏；ZCode 的 "Context low" 提示就是这机制在响

## 第 5 讲：会话持久化 —— 事件溯源

存储形态：JSONL append-only（一条一事件：消息/工具结果/元数据）。为什么：崩溃安全（追加写不坏旧数据）、可回放（resume = 重放重建状态）、可审计（你审计 ZCode rollout 就是在读别人 harness 的事件日志）。进阶：每条带 id/parentId → 会话成树 → fork/branch 随意开。

- pi：公共导出 `@earendil-works/pi-agent-core/harness/session`（M1 直接用）；coding-agent 存 `~/.pi/agent/sessions/<cwd编码>/<时间>_<id>.jsonl`，SessionManager 有 branch/branchWithSummary
- DSH：zstd 压缩 JSONL + 单写者 lease + v0→v3 迁移链

## 第 6 讲：权限与沙箱 —— 三层防线

1. **审批流**：beforeToolCall 拦截 → allow/ask/deny；非交互必须 fail-closed（不能问人就拒绝，绝不默认放行——pi 官方 permission-gate.ts 示例即此语义）
2. **模式预设**：read-only / workspace-write / danger-full-access 三档，工具行为随档位变
3. **进程沙箱**：bash 在受限环境跑（Linux landlock/bwrap、macOS sandbox、Windows restricted token）；越权要带 justification 走审批升级

pi 官方立场：不内置、只给接缝（beforeToolCall）+ 容器化文档 → 这是 M1 我们要自建的第一大件。DSH 的 tools/pre-execute waterfall 是同一职责的重型实现。

## 第 7 讲：子代理 —— 用上下文隔离换并行与整洁

动因：主会话上下文是稀缺资源，广搜 90% 的中间产物不该污染主线。

- **spawn**：全新空上下文的独立 agent，干完交一份 report
- **fork**：继承父历史前缀开分支（KV cache 友好、便宜），适合"从当前状态分头试"
- 父子通信：一次性 report vs 持续 send_message / wait

M2 我们用进程内 `new Agent`（同一个 streamFn）实现 spawn——内核库化路线的红利：子代理不需要新协议，就是再实例化一次自己的内核。DSH 的 subagent/fork 工具、ZCode 的 Agent/Explore 是同构物。

## 第 8 讲：扩展生态五件套

| 机制 | 谁用 | 时机 | 形态 |
|---|---|---|---|
| hooks | 规则/审计 | 事件前后 | 配置文件+脚本，进程外 |
| extensions/plugins | 开发者 | 装载期注册 | 代码包，进程内 |
| skills | 模型自己 | 需要时加载 | SKILL.md，渐进披露 |
| MCP | 外部世界 | 装载期桥接 | 跨进程协议 |
| slash 命令 | 人 | 显式调用 | 不产生模型消息 |

skills 的渐进披露值得单说：system prompt 只放 name+description（几十 token），正文模型判断需要时才 read 加载——上下文工程在生态层的应用。

M3 我们要做：MCP 桥（server 工具 → `mcp__<server>__<tool>` 普通工具）+ hooks.json 兼容器。参照系：pi extension 35 事件（进程内方案）、你在 DSH 的 10 个插件、ZCode 五组件（你解剖过 app.asar，同构）。

## 第 9 讲：Provider 层 —— 39 家厂商一个抽象

统一两层：API 协议（openai-completions / anthropic-messages / google-genai…）与事件流（text_delta / tool_call 增量 / usage → 统一 AssistantMessageEventStream）。坑在 tool call 编码各家不同；OpenAI-compat 是事实标准（GLM 的 zai-coding-cn 就走它）。

- pi-ai 内置 39 家；我们内核唯一接缝 `streamFn: (m,c,o) => models.streamSimple(m,c,o)`——provider 层可整层替换而 loop 无感
- DSH 的 dsh-llm-pi-ai 直接依赖 pi-ai：两家框架在这层是同一块代码

## 第 10 讲：外壳 —— 内核与皮分离

同一内核 + 不同皮：TUI（人的主入口）、headless（一次性任务/无人值班——你 02:00 夜窗的形态）、RPC（loop 搬到别的进程，UI 随便写）、Web。判据：M0-M3 内核期皮越少越好，M4 才碰。

- M4 计划：headless 先行 → pi-tui 组件搭 TUI
- 参照：`pi --mode rpc`（官方皮）、DSH web profile（React 皮）、ZCode Desktop（Electron 皮）

## 你现在的位置（M0-M4 对应课程坐标）

| 里程碑 | 内容 | 课程 |
|---|---|---|
| M0 ✅ | loop + provider + 工具 + 事件泵，冒烟通过 | 第 1/3/9 讲 |
| M1 | 权限 + 会话持久化 | 第 6/5 讲 |
| M2 | 压缩 + 子代理 | 第 4/7 讲 |
| M3 | MCP 桥 + hooks 兼容 | 第 8 讲 |
| M4 | headless / TUI 外壳 | 第 10 讲 |

十个概念你已经在代码里摸过五个（loop、工具、事件、provider、persona 参数位），剩下五个每个都有现成挂点。
