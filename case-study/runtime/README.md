# my-agent-runtime（TypeScript / Node）

第 1 周成果：一个能调用工具、可观察、可回放的**最小 agent loop**。

## 上手
```bash
npm i                                        # 装依赖
npm run agent -- --mock "建一个 hello.js 并运行它"   # 假模型，无需 key，看 loop 机制
npm run replay -- runs/<某次>.jsonl                  # 回放某次 run
# 用真模型：
export ANTHROPIC_API_KEY=your_anthropic_api_key
npm run agent -- "把 workspace 里的 bug 修好"        # 不带 --mock 即走真模型
```

## 部署

（教学快照已移除原作者的服务器部署记录。）重点配置：

```bash
AGENT_CWD=/srv/my-agent-workspace
AGENT_SHELL_SANDBOX=readonly-root
```

`AGENT_CWD` 是允许写入的工作目录；`readonly-root` 会让 `runShell` 通过 Linux `bubblewrap(bwrap)` 运行，整个根文件系统只读，只有 `AGENT_CWD` 可写。

## Web 会话恢复

Web 服务会把会话写入 `sessions/sessions.db`（可用 `SESSION_DB_FILE` 改路径）：

- transcript 保存模型续聊需要的 system / user / assistant / tool 消息；
- timeline 保存网页回放需要的用户消息、工具调用与最终回答事件；
- `/sessions` 只读取轻量 metadata；`/session <sessionId>` 才按需加载 transcript，并恢复历史内容。
- 同一个 session 在服务端进程内只有一个 `SessionRuntime`。WebSocket 断开只会 detach 连接，不会取消正在执行或等待审批的 run；重新连接后会恢复真实 run 状态和待审批请求。
- 无连接、无 run、无待审批的 runtime 默认空闲 10 分钟后从内存驱逐，历史仍保留在 SQLite；可用 `SESSION_RUNTIME_IDLE_TTL_MS` 调整。
- 服务进程重启无法恢复原来的 Promise、模型请求或工具调用。启动时会把未完成 run 标记为 `interrupted`、修复未配对的 tool result，并允许继续发送新消息。

`runs/*.jsonl` 仍用于单次运行轨迹和 replay，不再承担会话索引与恢复职责。

## DeepSeek V4 context cache

Runtime 默认使用 `AGENT_CONTEXT_STRATEGY=cache-first`：

- 在 `AGENT_MAX_CONTEXT_TOKENS` 预算内保留完整 transcript，后续请求只追加消息，避免固定 32 轮窗口每轮移动起点。
- 超过预算后，以 `AGENT_CONTEXT_PRUNE_BATCH_USER_TURNS` 为单位移除最旧的完整 user turn；默认每批 8 个，因此只会低频改写一次前缀。
- `legacy-window` 保留旧的最近 N 个 assistant/tool 轮次算法，仅用于 A/B 或回退；此时 `AGENT_RECENT_TURNS` 才生效。
- Memory 未变化时属于稳定 system 前缀；调用 `remember` 改写 Memory 或执行 `/compact` 后，下一次请求会建立新前缀缓存。
- DeepSeek V4 thinking 工具轮次的 `reasoning_content` 会随 assistant 消息持久化并在后续请求中回传。

`context_built` 事件包含 `prompt_hash`、`prefix_hash`、`tools_hash`、`memory_hash` 和与上一请求共享的前缀估算；`model_usage` 显示 API 返回的 cache hit、cache miss 和命中率。

使用已配置的 `DEEPSEEK_API_KEY` 做一次小额真实 A/B：

```bash
npm run cache:ab
```

脚本会分别在第 32 轮边界测试 `cache-first` 与 `legacy-window`，并输出两组 `prompt_cache_hit_tokens / prompt_cache_miss_tokens`。

## PR Codex Review 自动跟进

Agent 创建 PR 或根据 Review push 新提交后，调用：

```text
schedulePrReviewFollowup({
  "repo": "owner/repo",
  "prNumber": 12,
  "workspacePath": "repo",
  "complexity": "simple"
})
```

后台会读取当前 PR head 对应的官方 Codex Review 和行内评论。有 P0/P1 或值得处理的 P2 时，它会重新运行现有 coding agent；Agent 自行修改、测试、commit 并 push 到原分支。没有 P0/P1 且 CI 通过后，任务进入 `ready`，但不会自动 merge 或 deploy。

任务默认写入 `AGENT_CWD/.agent-runtime/pr-review-followups.json`，服务重启后会继续。可以调用 `getPrReviewFollowup` 查看最近任务；轮询和超时参数见 `.env.example`。完整取舍见 [PR Review 自动跟进方案](../docs/plans/pr-review-followup.md)。

## 代码地图（建议按这个顺序读）
对照 harness 心智模型：**模型在中间，外面包 loop / tools / 可观察。**

| 顺序 | 文件 | 作用 | harness 的哪一块 |
|---|---|---|---|
| 1 | `model/types.ts` | 中立数据结构：Message / ToolCall / ModelResponse / ModelClient | 模型适配层的「契约」 |
| 2 | `tools/types.ts` | Tool 接口（名字+说明+zod schema+run） | 工具（agent 的手） |
| 3 | `tools/fileOps.ts` `tools/shell.ts` | 4 个具体工具 readFile/writeFile/listDir/runShell | 工具实现 |
| 4 | `tools/registry.ts` | 工具注册表 + 生成给模型的「说明书」 | 工具调度 |
| 5 | `model/mock.ts` | 假模型（按剧本返回工具调用）→ 先看它最容易懂 loop | 模型适配层 |
| 6 | **`core/loop.ts`** | ⭐ **agent loop 本体**——整个 harness 的心脏 | loop |
| 7 | `core/events.ts` | 事件 = 实时打印 + JSONL 持久化 | 可观察/可回放 |
| 8 | `apps/cli.ts` | 把各层装配起来跑一次 | 入口/装配 |
| 9 | `model/anthropic.ts` | 真模型 provider（中立类型 ↔ Anthropic API 互翻） | 模型适配层 |
| 10 | `evals/replay.ts` | 读 JSONL 重放 | 回放 |
| 11 | `followups/` | 等待 Codex Review、唤醒现有 Agent、等待 CI | PR 自动跟进 |

## 一次 run 的数据流
```
task → loop: [system,user] ─► model.complete(history, toolSchemas)
                                   │
            ┌──────────────────────┴───────────────────────┐
        有 toolCalls                                   无 toolCalls
            │                                               │
   执行工具→observation 塞回 history → 回到 complete      → final_answer，结束
```
每一步都过 `EventLogger`：① 打印到终端 ② 追加到 `runs/*.jsonl`。

## 自己动手验证理解（周末的「会写」检验）
1. 给 agent 加一个新工具（如 `deleteFile` 或 `appendFile`）：在 `tools/` 写一个 Tool，在 `cli.ts` 里 `.register()`。看模型会不会用。
2. 把 `--max-turns` 设成 1，观察它怎么被强制中断（看 `error` 事件）。
3. 配上 `ANTHROPIC_API_KEY`，在 `workspace/` 放一个有 bug 的 js，让真模型去修——对比真模型和 mock 的轨迹差异。
4. 删掉某个工具的 `description`，看模型 tool-calling 准确率怎么下降（体会「说明书」多重要）。
