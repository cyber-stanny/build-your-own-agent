# 01 · 项目结构：每个目录负责什么

> 这个项目有两个可运行包：`runtime/`（agent 运行时，本指南的主角）和 `web/`（浏览器前端）。
> `reference/` 下是外部参考项目源码，与 runtime 无关，不要混淆。

## runtime/ 目录逐个讲

### apps/ — 入口层（装配车间）

| 文件 | 职责 | 关键代码 |
|---|---|---|
| `apps/cli.ts` | 命令行入口：解析参数 → 选模型 → 注册工具 → 建 session → 跑 loop | `main` 全文，`apps/cli.ts:23-119` |
| `apps/server.ts` | WebSocket 服务入口：认证、session 管理、审批回传、followup 调度 | `handleClientMessage` `apps/server.ts:231`，工具注册 `:68-84` |

两个入口是「同一套零件的两种装法」：CLI 直接 new 一个 session 跑一次；server 通过 `SessionRuntimeStore` 管理多 session、多 run、审批与断线恢复。

### core/ — Agent 的心脏

| 文件 | 职责 | 关键函数 |
|---|---|---|
| `core/loop.ts` | **整个项目最核心的文件**：Agent 主循环 | `runTurn()` `core/loop.ts:147`，`executeTool()` `:365` |
| `core/events.ts` | 事件总线：loop 的每一步都 emit 事件，fan-out 给多个 sink | `EventBus` `core/events.ts:51`，`printEvent` `:90` |
| `core/serial-queue.ts` | 串行任务队列（12 行）：保证工作区任务不并发 | `SerialTaskQueue.run` `core/serial-queue.ts:4` |

### context/ — 上下文工程

| 文件 | 职责 | 关键函数 |
|---|---|---|
| `context/builder.ts` | 把完整 transcript 裁剪成这轮真正发出去的 context | `buildContext` `context/builder.ts:30` |
| `context/cache-observability.ts` | 给 prompt 算指纹、数相邻两次请求共享多少前缀（观测缓存命中） | `fingerprintPrompt` `context/cache-observability.ts:16` |
| `context/debugger.ts` | 把裁剪决策打印成人能读的框 | `formatContextDebug` `context/debugger.ts:6` |

### model/ — 模型适配层

| 文件 | 职责 | 关键代码 |
|---|---|---|
| `model/types.ts` | **中立数据结构**：`Message` / `ToolCall` / `ToolSchema` / `ModelResponse` / `ModelClient` 接口 | `Message` `model/types.ts:15`，`ModelClient` `:51` |
| `model/deepseek.ts` | DeepSeek provider（OpenAI 兼容格式 + 思考模式） | `toDeepseekMessages` `model/deepseek.ts:204` |
| `model/anthropic.ts` | Anthropic provider | `toAnthropic` `model/anthropic.ts:61` |
| `model/mock.ts` | 按剧本返回的假模型：无 key 可跑、测试可回归 | `MockModelClient` `model/mock.ts:8` |

### tools/ — Agent 的手

| 文件 | 工具/职责 | 特点 |
|---|---|---|
| `tools/types.ts` | `Tool` 接口：name + description + zod schema + run | `tools/types.ts:19` |
| `tools/registry.ts` | `ToolRegistry`：注册、查找、zod→JSON Schema | `toSchemas` `tools/registry.ts:26` |
| `tools/fileOps.ts` | readFile / writeFile / editFile / listDir | 路径锁死在 workingDir `fileOps.ts:8` |
| `tools/shell.ts` | runShell：跑一次性命令 | 长期进程识别 `shell.ts:45` |
| `tools/exec.ts` | `runCommand` 共享执行器：永不抛、超时、abort 杀进程组 | `exec.ts:20` |
| `tools/sandbox.ts` | bubblewrap 沙箱（Linux）：根只读、仅 workingDir 可写 | `buildShellSpawn` `sandbox.ts:12` |
| `tools/process.ts` | startProcess / listProcesses / readProcessLog / stopProcess | `ProcessManager` `process.ts:26` |
| `tools/gitOps.ts` | gitStatus / gitDiff：只读安全 | `gitOps.ts:14,25` |
| `tools/memory.ts` | remember：写持久记忆（工厂函数注入 MemoryStore） | `memory.ts:7` |
| `tools/deploy.ts` | deployMain：受控部署 | `deploy.ts:19` |
| `tools/analyzeImage.ts` | analyzeImage：多模态模型看图（硅基流动） | `analyzeImage.ts:34` |
| `tools/prReviewFollowup.ts` | schedule/get PR 跟进任务（给模型用的入口） | — |

### 其余目录

| 目录 | 职责 | 关键代码 |
|---|---|---|
| `policy/` | 安全策略：工具执行**前**判断 allow / deny / require_approval | `checkToolCall` `policy/permissions.ts:35` |
| `sessions/` | `session.ts` 内存对象；`store.ts` SQLite 持久化；`runtime-store.ts` run 生命周期状态机 | `SessionRuntimeStore` `runtime-store.ts:105` |
| `memory/` | 跨会话持久记忆（JSON 文件，key/value/category） | `MemoryStore` `memory/store.ts:17` |
| `commands/` | `/compact` `/new` `/stop` 等斜杠命令 | `compactMessages` `commands/compact.ts:27` |
| `followups/` | PR Review 后台跟进：无头后台 agent + 状态机 + 轮询调度 | `service.ts:22`，`agent.ts:26` |
| `evals/` | `replay.ts` 把 JSONL 事件重放；cache A/B 实验 | `evals/replay.ts` |
| `config.ts` + `config.defaults.ts` | 环境变量覆盖默认配置 → 全局 `appConfig` | `config.ts:38` |

## web/ 目录

React + Vite 前端（`web/src/App.tsx`），通过 WebSocket 连 `apps/server.ts`。协议：`auth` → `ready` → 发 `{task}` / `{command}` / `{type:"approval"}`，收事件流和 `run_state`。本指南不深入前端。

## 一次任务的文件变迁

```
用户输入
  → apps/cli.ts / apps/server.ts      （装配：model + registry + events + config）
  → core/loop.ts runTurn              （主循环）
      → context/builder.ts            （裁剪历史）
      → model/deepseek.ts             （翻译类型 → HTTP 调 API）
      → tools/registry.ts             （查工具、schema 校验）
      → policy/permissions.ts         （安全判断）
      → tools/fileOps.ts 等           （真正干活）
  → core/events.ts                    （每步 emit 事件 → console + runs/*.jsonl）
  → sessions/store.ts                 （transcript 每次 变化 checkpoint 到 SQLite）
```
