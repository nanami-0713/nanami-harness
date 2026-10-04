# @nanmi/harness

基于 [pi-agent](https://github.com/earendil-works/pi-mono) 内核库化的个人 harness。不 fork：`pi-agent-core`（loop）+ `pi-ai`（provider）+ `pi-coding-agent`（只借工具工厂）当依赖，定制全部在本层。版本钉 exact `0.85.1`。

```sh
npm install --ignore-scripts
npm run smoke   # 构建并跑 M1-M3 集成测试（≈6 次 GLM 调用）
```

## 模块地图

| 模块 | 里程碑 | 职责 | 挂点（pi-agent-core 原生） |
|---|---|---|---|
| `index.ts` | — | 组装根：模型→上下文→工具→钩子链→压缩→会话 | `streamFn` / `beforeToolCall` / `prepareNextTurnWithContext` |
| `context.ts` | M·上下文 | AGENTS.md（全局+项目）注入 + 技能发现；`skill` 工具按需加载全文（渐进披露） | systemPrompt 组装 |
| `sandbox.ts` | M·沙箱 | Seatbelt/bwrap 策略 + 沙箱化 bash（写限工作区、可选拒网），硬层 | 自建工具 |
| `tools.ts` + `tools-todo.ts` | M1 | 内置七件（借 pi 工厂）+ 自建 `todo_write` | — |
| `tools-jev.ts` | — | `jev_decide`：TypeSafe System One 决策模型直调（noul/score/choice 类型化决策）；key 每次现读 | 自建工具 |
| `providers.ts` | M·多供应商 | 40 家内置 provider + `~/.nanmi/config.json` 自定义 OpenAI 兼容端点；凭据装 env | `streamFn` |
| `plugins.ts` | M·扩展 | MCP 配置文件双层合并 + 插件目录（五种贡献） | 装配期合并 |
| `tools-computer.ts` | M·电脑控制 | Codex 式视觉-动作回路：截图→视觉模型看图→坐标动作；macOS 后端 | 自建工具 |
| `permissions.ts` | M1 | 四档权限（readonly/default/acceptEdits/bypass），非交互 fail-closed | `beforeToolCall` |
| `session.ts` | M1/M·检查点 | **append-only 物理日志** + 压缩检查点（重放规则见文件头）+ sidecar 元数据 | — |
| `compaction.ts` | M2 | usage 阈值检测 + 子 Agent 通道摘要 + 安全切分 | `prepareNextTurnWithContext` |
| `subagent.ts` | M2 | 进程内只读子代理（深度 1，超时联动中止） | 自建工具 |
| `mcp.ts` | M3 | MCP 桥（stdio + streamable-http），命名 `mcp__<server>__<tool>` | 自建工具 |
| `hooks.ts` | M3 | 原生命令钩子（`bash -c`，exit 2 / JSON 裁决） | `beforeToolCall` / 事件泵 |
| `key.ts` | — | key 解析：env → `~/.dsh/.credentials.yaml`（绝不打印） | `getApiKey` |

## 用法

```ts
import { NanmiHarness } from "@nanmi/harness";

const harness = await NanmiHarness.create({
  provider: "zai-coding-cn",
  modelId: "glm-5.3-flash",
  systemPrompt: "…行为规范…",
  apiKey: "…",
  permission: { mode: "default" },          // 交互终端里会弹 y/n/a 审批
  session: {},                               // 开会话持久化；{resumeId} 恢复
  mcp: { myserver: { command: "…", args: [] } },
  hooks: { preToolCall: ["…"] },
});
const result = await harness.run("任务…", (event) => { /* 过程观察 */ });
await harness.dispose();
```

## Examples

`examples/` 下每个机制一个可跑脚本（最小对话 / 权限门 / hooks 拦截 / 会话恢复 / 压缩 / MCP / 子代理），独立零依赖，逐个演示公共 API。索引与成本见 [examples/README.md](examples/README.md)。

## 多供应商 / MCP 配置 / 插件 / 电脑控制（可交付四件套）

**M·多供应商**：40 家内置 provider（anthropic/openai/deepseek/google/zai…）全部免配置可用，
key 走各家约定 env（`ANTHROPIC_API_KEY`…），三个来源任选：

1. shell 环境变量（最直接）
2. `~/.nanmi/credentials.yaml`（一行一个：`ANTHROPIC_API_KEY: sk-…`，建议 600 权限；
   启动时装进 env，绝不打印）
3. `~/.nanmi/config.json` 的 `customProviders`：OpenAI 兼容端点

```json
{
  "defaultProvider": "zai-coding-cn",
  "defaultModel": "glm-5.3-flash",
  "customProviders": [{
    "id": "my-lab", "baseUrl": "https://lab.example.com/v1",
    "envVar": "MY_LAB_API_KEY",
    "models": [{ "id": "lab-1", "contextWindow": 64000 }]
  }]
}
```

GUI 模型下拉按 provider 分组、带"视觉"徽章与"未配 key"标注；会话内跨 provider 切模型
（压缩摘要器/子代理跟随切换，显式 apiKey 只归属配置时的 provider，切走自动让位 env 认证）。

**M·MCP 配置**（ZCode 风格双层，同名覆盖，`"disabled": true` 可关）：

- 用户层 `~/.nanmi/mcp.json`，项目层 `<cwd>/.nanmi/mcp.json`
- 格式：`{ "servers": { "echo": { "command": "node", "args": ["…"] }, "remote": { "url": "https://…" } } }`

**M·插件系统**（`~/.nanmi/plugins/<id>/plugin.json`，单个插件失败只降级自身）：

```json
{
  "name": "nanmi-example", "version": "0.1.0",
  "mcp": { "servers": { "…": {} } },
  "hooks": { "preToolCall": ["…"] },
  "skills": ["skills"],
  "tools": ["tools/index.mjs"],
  "systemPromptFragment": "追加到 system prompt 末尾"
}
```

工具模块 default 导出 `AgentTool[]`；`parameters` 是**纯 JSON Schema**（插件在
node_modules 之外，别 import typebox，直接写对象字面量）。MCP 名字带 `<插件id>__` 前缀
防碰撞。装机自带示例插件 `~/.nanmi/plugins/nanmi-example/`（harness_info 工具 + 示例
技能 + prompt 片段），不需要就整个目录删掉。

**M·电脑控制（Codex 式 computer use）**：`computer` 工具 = 截图驱动的视觉-动作回路 ——
模型调 `screenshot` 拿到 PNG（≤1280px 降采样）→ 在图像坐标系里推理 → `click/type/key/
scroll/drag…`（坐标按 retina 比例自动换算）→ 动作后自动附新截图验证。需视觉模型
（zai 系：glm-5.3-flash / glm-4.6v）。

系统要求（macOS TCC，须在系统设置里给宿主进程授权）：**屏幕录制**（截图）、
**辅助功能**（键入/点击）；精确点击与滚动依赖 `cliclick`（`brew install cliclick`，
未装时仅 move 有退化路径）。工具属非只读类，除 bypass 外任何权限模式首次调用都走审批卡。

## 踩坑记录

- `createModels()` 是空注册表，装全量内置 provider 用 `@earendil-works/pi-ai/providers/all` 的 `builtinModels()`。
- 裸调 `models.streamSimple()` 时手工构造 context 会在 adapter 内部炸（缺 loop 组装的契约字段）——直接走子 Agent 通道。
- `AgentLoopTurnUpdate.context` 的 `AgentContext` 在 dist 里要求 `systemPrompt`，换上下文时用 `{...ctx.context, messages}` 展开而不是手搓。
- 集成测试用的本地 MCP server 在 `test/mcp-echo-server.mjs`。

## 路线图

- ✅ M0 内核冒烟
- ✅ M1 工具面 + 权限 + 会话持久化
- ✅ M2 压缩 + 子代理
- ✅ M3 MCP 桥 + hooks
- ✅ M4 Web GUI（Codex/ZCode 风格）
- ✅ M·可交付四件套：多供应商 / MCP 配置文件 / 插件系统 / 电脑控制（Codex 式）
- ⬜ 演进项：Electron 壳；子代理嵌套深度

## 上下文 / 沙箱 / 会话 v2

- **上下文组装**：AGENTS.md（`~/.nanmi/AGENTS.md` 全局 + `cwd/AGENTS.md` 项目）创建时一次性
  注入 system prompt（前缀稳定=缓存友好）；技能走**渐进披露**——prompt 只放"名称+描述"目录，
  `skill` 工具按需加载 SKILL.md 全文。目录：`skills/`、`.nanmi/skills/`
- **沙箱（opt-in 硬层）**：`sandbox: { fs: "workspace", network: "deny" }` —— bash 经
  sandbox-exec(Seatbelt)/bwrap 包裹，写仅限工作区+系统临时目录、可选拒网；防意外不防逃逸，
  审批仍是人机主层；策略文件生成在 `cwd/.nanmi/sandbox.sb`
- **会话 append-only**：`<id>.jsonl` 只追加物理日志（消息条目 + 压缩检查点），压缩=追加摘要
  检查点而非重写历史（DSH 式"原日志保留、回放确定性"）；重放遇检查点视图重置为摘要；
  元数据在 sidecar `<id>.meta.json`；用量按物理口径（计费真实），喂模型按视图口径

## Web GUI

```sh
npm run web        # 构建 + 启动，打开 http://127.0.0.1:6110
npm start          # 跳过构建直接启动
```

界面（Codex 桌面端像素级画风，暖深灰，明暗双主题）：

- 空态 = 居中 hero（"我们要做什么？"）+ 悬浮双层 composer 卡；有消息后 composer 落底
- composer 上层：输入框 + 权限 chip（🖐 请求批准等四档热切）+ 模型下拉（下一条消息
  生效，`agent.state.model` 每次 run 重取）+ 圆形发送键（运行中变红停止键）
- composer 下层附卡：**创建项目弹窗**（项目名称 + 源文件夹服务端目录浏览器 + 记忆隔离
  下拉；隔离 = 会话数据物理存项目内）；侧栏"项目"区同步显示当前 cwd
- 侧栏：会话**按工作区分组**（文件夹图标双态展开/收起、缩进单行、显示更多），标题 +
  `···`（重命名/归档）；左下角点头像伸出抽屉（设置/切换主题）；**设置 = 弹窗**（常规/
  外观/模型/使用情况四 tab）
- **对话区顶部"对话 | 轨迹"双 tab**：轨迹 = 消息流展平（用户/助手/工具徽章 + 轮次分隔），
  详情含 概述（状态=stopReason 映射）/ 思考（CoT）/ 回复 / 参数结果 / **请求计时（开始
  时间/总时长/首 token 延迟/生成/吞吐量）** + **Token 用量（输入未缓存/缓存读取/缓存
  写入/输出/推理/合计/缓存命中）**；首 token 判定对齐 DSH —— 文本/思考/工具参数任何
  非空增量都算（纯工具轮次也有 TTFT）；计时记录 append-only 落盘 `<id>.trace`，
  重开会话不丢；轨迹页运行中事件驱动实时刷新（500ms 防抖）；meta.stats 跨进程累计
- **输入框下方指标条**：N 轮 · M 步 | LLM 时长 · 工具调用时长 | 首 token 平均 · tok/s |
  缓存命中 % | 输入/输出 tok
- 标题两级生成：首条用户消息兜底 → 首跑后子 Agent 生成 ≤16 字概括；重命名后不覆盖
- 消息流：流式 markdown、工具卡片、权限审批弹卡、运行中可停止

架构（与 DSH/ZCode 同构：Node 宿主 + 浏览器前端，Electron 只是可选的皮）：

- `src/web-server.ts` —— node:http 宿主：REST（发起/中止/审批/切模式/重命名/归档）+ SSE
  事件流（每会话一个带 seq 的事件环，断线 `?since=` 补放）；审批 = PermissionGate 注入
  webAsker，推 `permission_request` 挂起 Promise，`POST /api/approve` 兑现。
- `web/` —— 零框架前端（index.html + app.js + style.css），marked 渲染 markdown；
  转屏以 `/api/messages` 快照为权威，运行中按事件增量渲染，`run_end` 后全量重绘纠漂移。
- 可选配置 `nanmi.web.json`：`{provider, modelId, systemPrompt, mcp, permissionMode}`。

**PWA 安装（第三档，已实现）**：页面满足可安装条件——Chrome 系浏览器地址栏出现安装图标，
或抽屉里出现"安装到本机"（捕获 beforeinstallprompt）；Safari 用菜单"文件 → 添加到程序坞"。
安装后即独立窗口 + Dock 图标，随宿主刷新即更新。`web/sw.js` 刻意不拦截 fetch（SSE 流不能过 SW）。

Electron 壳（可选，未装依赖）：`npm i -D electron` 后 `npx electron desktop/main.js`。

## License

MIT —— 见 [LICENSE](./LICENSE)。
