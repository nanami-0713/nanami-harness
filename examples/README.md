# Examples

每个脚本演示一个机制，独立可跑，互不依赖。统一从仓库根目录运行（先 `npm run build`）：

```bash
npm run build
node examples/01-minimal.mjs
```

| # | 脚本 | 演示什么 | 网络/成本 |
|---|------|----------|-----------|
| 01 | `01-minimal.mjs` | 最小可用：创建 → run → 事件流打字机 | 1 次模型调用 |
| 02 | `02-permissions.mjs` | 权限门四档模式 + 非交互 fail-closed + 运行时切档 | 零成本，无需 key |
| 03 | `03-hooks.mjs` | preToolCall 钩子实时拦截 bash（观察者 + 拦截者两条命令） | ~2 次调用 |
| 04 | `04-session-resume.mjs` | 会话落盘 → 全新实例凭 resumeId 恢复记忆 | ~2 次调用 |
| 05 | `05-compaction.mjs` | 压缩器：头部摘要 + 尾部原样保留 | 1 次摘要调用 |
| 06 | `06-mcp.mjs` | MCP 桥：stdio server 编程接入，`mcp__<server>__<tool>` 命名 | ~2 次调用 |
| 07 | `07-subagent.mjs` | 主循环派 subagent + `complete()` 旁路小任务 | ~3 次调用 |

所有联网示例走 `zai-coding-cn/glm-5.3-flash`，key 解析顺序：环境变量 `ZAI_CODING_CN_API_KEY` → `~/.dsh/.credentials.yaml`。

两点预期行为：①启动日志的 `[nanmi:extensions]` 是 `~/.nanmi/plugins/` 用户插件被默认装配，非报错；②03/04 会在 `./.nanmi/sessions/` 留下会话文件。各脚本头部样板（key 解析等）故意重复，保证单个文件可独立拷走运行。

Web GUI 不是 example 而是应用入口：`npm run web`（见主 README「Web GUI」一节）。
