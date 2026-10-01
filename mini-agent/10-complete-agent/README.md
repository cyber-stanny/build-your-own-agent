# 10 · Complete Agent —— 组合成完整 Mini Agent

## 这个阶段是什么

前 9 个阶段的总装：**Loop + Tools + Context（截断+超预算裁剪）+ Session（落盘+恢复）+ Memory + Skills + Sub-agent + Compaction**，全部装进一个 ~350 行的文件。没有抽象、没有框架，每个子系统就是一段 20~40 行的直白代码。

刻意**没有**集成：审批流、事件总线——这是与原项目的真实差距，留作扩展作业。

## 相比上一阶段（09）增加了什么

不再新增单一机制，而是**集成 + 补齐总装缺项**：

| 子系统 | 来自阶段 | 在本文件的位置 |
|---|---|---|
| LLM 封装（mock/真实，统一返回形状） | 01 | `createLLM()` |
| 工具表 + 执行兜错 | 03 | `TOOLS` + `executeTool()` |
| Context 截断 + **超预算裁剪** | 04 | `buildOutgoing()` |
| Session **落盘 + 恢复** | 05 | `saveSession()` / `loadSession()` + `resume` 模式 |
| Memory 注入 + remember 工具 | 06 | `memoryText()` + `TOOLS.remember` |
| Skill 目录 + load_skill | 07 | `skillCatalog()` + `TOOLS.load_skill` |
| **Sub-agent（spawn_subagent）** | 08 | `TOOLS.spawn_subagent`（子 agent 无工具，只回传结论） |
| /compact 压缩 | 09 | `compact()` |

## 运行

```bash
cd mini-agent/10-complete-agent

# 单任务模式
node agent.mjs "在 workspace 里建 notes.md，写一句话介绍你自己"

# REPL 模式（含压缩与子 agent：任务里带「调研」会触发 spawn_subagent）
node agent.mjs
你> 在 workspace 里建 todo.txt 写两件事
你> /compact
你> /exit

# 恢复历史会话（stdin 结束或 /exit 都会干净退出）
node agent.mjs resume sess_<id>
```

## 示例输出（mock 模式，三轮对话 + /compact）

```
  🔧 write_file({"path":"mock-output.md","content":"任务「第一轮」的产物（mock）"})
  📥 wrote 16 chars to mock-output.md
(mock) 任务完成。依据：wrote 16 chars to mock-output.md
…（第 2、3 轮）

压缩完成：10→6 条消息，粗估 86→87 tokens
```

子 agent 触发示例（任务含「调研」）：

```
  🔧 spawn_subagent({"task":"调研：…要不要用向量数据库"})
  📥 调研结论：任务可行。建议拆成三步：准备数据 → 实现核心逻辑 → 写验证。
(mock) 任务完成。依据：调研结论：任务可行。…
```

REPL 模式里可以继续验证：`ls workspace/` 看产物；`/compact` 打印压缩前后对比；`sessions/` 里有落盘 JSON；`node agent.mjs resume <id>` 恢复后历史还在。

## 对应原项目源码（总装对照表）

| Mini Agent | my-agent-runtime |
|---|---|
| `runTurn()` | `core/loop.ts:147` |
| `executeTool()` 五关中的两关（找不到/参数错） | `core/loop.ts:365`（原版还有白名单+zod+安全策略） |
| `TOOLS` + `load_skill` + `remember` + `spawn_subagent` | `tools/registry.ts` 注册的 15 个工具 |
| `buildOutgoing()`（截断 + cache-first 式裁剪） | `context/builder.ts:30` + `withMemoryContext`（loop.ts:346） |
| `saveSession()` / `loadSession()` | `sessions/store.ts:175` / `runtime-store.ts:285 getOrLoad` |
| `compact()` | `commands/compact.ts:27` |
| `spawn_subagent`（无工具子 agent） | `followups/agent.ts:26`（受限工具集 `:90`） |
| `/new` `/compact` | `apps/server.ts:315` 的 commandHandlers |

## 学生扩展作业（按难度递增）

1. **加工具**：写一个 `fetch_url` 工具抓取网页文本（提示：`fetch()` + 正则去 HTML 标签）
2. **加安全**：给 `write_file` 加「超过 100KB 拒绝写入」；给文件名加「禁止覆盖 .md 以外扩展名」策略
3. **加审批**：模仿 `core/loop.ts:386` 的 `require_approval`，对 `write_file` 先问用户 y/n 再执行
4. **加事件流**：所有 `console.log` 改成 event 对象，支持写 JSONL（对照 `core/events.ts` 的 EventSink）
5. **强化 sub-agent**：给子 agent 加受限工具集并支持并行派发（注意工作区写入的串行纪律，对照 `core/serial-queue.ts`）
6. **强化裁剪**：把一次性丢弃改成逐批尝试（对照 `context/builder.ts:38` 的 cache-first 完整实现）
