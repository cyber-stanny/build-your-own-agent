# 12 · 阅读路线图：四天读懂这个项目

> 原则：**先跑起来，再顺着一条链读深，最后扫尾**。每天 2~3 小时。

## 第 0 天（30 分钟）：先跑，再读

```bash
cd runtime
npm run agent -- --mock "建一个 hello.js 并运行它"   # 看 loop 完整转一圈
npm run replay -- runs/<日志文件>.jsonl              # 重放刚才的事件
npm test                                             # 73 个测试全绿
```

读两篇背景：仓库根 `README.md`、`runtime/README.md`。带着问题开始：**「mock 模型按剧本返回，那真实循环里每一步发生在哪个文件？」**

## 第 1 天：主链路（最小闭环）

目标：能自己画出「用户消息 → 最终答案」的完整流程图。

| 顺序 | 文件 | 行数 | 重点 |
|---|---|---|---|
| 1 | `model/types.ts` | 55 | 中立类型。Message 四种角色、ModelClient 接口 |
| 2 | `model/mock.ts` | 43 | 剧本式 provider，理解「一轮=一个 ModelResponse」 |
| 3 | `tools/types.ts` + `tools/registry.ts` | 60 | Tool 四件套；zod → JSON Schema |
| 4 | `core/loop.ts` | 397 | **主战场**。runTurn 主循环、executeTool 五关、停止条件 |
| 5 | `apps/cli.ts` | 119 | 装配：所有零件怎么拼起来 |

验证理解：合上文档，说出「工具结果是怎么回到模型面前的」（答案在 `core/loop.ts:281` + 下轮 buildContext）。

## 第 2 天：状态与上下文

| 顺序 | 文件 | 配套文档 |
|---|---|---|
| 1 | `context/builder.ts` | [03-context](03-context.md)——cache-first 的裁剪单位为什么是「完整 user turn」 |
| 2 | `sessions/session.ts` + `sessions/store.ts` | [06](06-session-memory.md)——三张表各给谁用 |
| 3 | `memory/store.ts` + `tools/memory.ts` | 记忆「读隐式、写显式」的分工 |
| 4 | `core/events.ts` | 事件总线为什么让 loop 可观察、可回放 |
| 5 | `commands/compact.ts` | [09](09-context-compaction.md)——摘要为什么放 system |

动手：`npm run agent -- --mock --debug-context --max-context-tokens 300 ...` 观察裁剪决策。

## 第 3 天：安全、恢复与后台

| 顺序 | 文件 | 重点 |
|---|---|---|
| 1 | `policy/permissions.ts` | 三态决策；黑名单为什么只是「速度带」（见文件注释） |
| 2 | `tools/fileOps.ts:8-15` + `tools/sandbox.ts` | resolveInside 路径锁 + bwrap 沙箱 |
| 3 | `tools/exec.ts` | 永不抛 + 进程组两级杀 |
| 4 | `core/loop.ts:95-139,312-344` | abortToolLoop 三场景 + 配对修复 |
| 5 | `sessions/runtime-store.ts` | run 状态机、审批挂起、重启恢复、空闲回收 |
| 6 | `followups/agent.ts` + `service.ts` | [08](08-subagent.md)——命令级审批白名单；head oid 事实核查 |

## 第 4 天：对照与收尾

1. 读 `model/deepseek.ts` 与 `model/anthropic.ts` 的翻译函数，对照两家 tool-calling 协议差异
2. 读 `apps/server.ts`，把 CLI 和 server 两种装配的差异列成表
3. 回到 `mini-agent/` 对应阶段，对照源码列出教学版省掉了哪些工程细节、各自为什么必要
4. 自测四道综合题：
   - 用户在 web 点「停止」后，系统里发生哪 5 件事？
   - `/compact` 之后 prompt cache 会发生什么？为什么？
   - 为什么 `editFile` 要求 oldText 唯一？报错文案为什么那样写？
   - 给这个 agent 加一个「网页搜索」工具，要动哪几个文件？

## 按主题的文件索引

| 主题 | 必读 | 进阶 |
|---|---|---|
| Agent Loop | core/loop.ts | core/loop.test.ts |
| Context | context/builder.ts | context/cache-observability.ts、debugger.ts |
| LLM | model/types.ts、model/mock.ts | model/deepseek.ts、model/anthropic.ts |
| 工具 | tools/types.ts、registry.ts、fileOps.ts | shell.ts、exec.ts、process.ts、sandbox.ts |
| 安全 | policy/permissions.ts | tools/sandbox.ts、followups/agent.ts:132 |
| Session | sessions/session.ts | sessions/store.ts、runtime-store.ts、import-jsonl.ts |
| Memory | memory/store.ts | tools/memory.ts |
| Compaction | commands/compact.ts | runtime-store.ts:184 |
| 事件/回放 | core/events.ts、evals/replay.ts | evals/deepseek-cache-ab.ts |
| 后台任务 | followups/service.ts、agent.ts | followups/scheduler.ts、store.ts、github.ts、types.ts |
| 配置 | config.defaults.ts | config.ts |
| 入口 | apps/cli.ts | apps/server.ts |

## 配套实践

读完第 1 天后，建议平行做 `mini-agent/`（从零写一个教学版 agent）。**读一遍源码 + 从零写一遍 = 真正掌握**。课程化练习见 `COURSE_MAP.md`。
