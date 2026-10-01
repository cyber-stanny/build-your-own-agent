# Mini Agent —— 从零实现一个教学版 Agent

10 个阶段，每阶段一个目录：可独立运行、有 README、代码尽量小、默认 Mock LLM 可离线跑通（配置 `MINI_AGENT_API_KEY` / `MINI_AGENT_BASE_URL` / `MINI_AGENT_MODEL` 切换任意 OpenAI 兼容真实模型）。

## 阶段列表

| 阶段 | 主题 | 核心新概念 |
|---|---|---|
| [01-basic-chat](01-basic-chat/) | 最简单的 LLM 对话 | messages 数组、LLM 封装 |
| [02-agent-loop](02-agent-loop/) | Agent Loop 骨架 | 循环、三个停止条件 |
| [03-tools](03-tools/) | Tool Calling | 工具四件套、结果回填、错误=观察结果 |
| [04-context](04-context/) | Context 管理 | token 估算、截断、超预算裁剪 |
| [05-session](05-session/) | Session | 历史累积、落盘、恢复 |
| [06-memory](06-memory/) | Memory | 读=隐式注入、写=remember 工具 |
| [07-skills](07-skills/) | Skill | 两级渐进式披露、按需加载 |
| [08-subagent](08-subagent/) | Sub-agent | 派活工具、只回传结论 |
| [09-compaction](09-compaction/) | Compaction | 旧历史→摘要 system、保留最近原文 |
| [10-complete-agent](10-complete-agent/) | 完整总装 | 以上全部 + resume + 超预算裁剪 |

## 重要：阶段是「机制切片」，不是严格累计

为了"学生能看懂"，01–09 每个目录**只保留讲解该机制所需的最少代码**（例如 04 演示裁剪时不含工具，05 演示会话时不含工具循环）——它们是可以独立讲授的切片，**不是**逐层叠加的同一个程序。真正的逐层组合发生在 **10-complete-agent**：它把 loop、工具、context、session、memory、skills、sub-agent、compaction 全部装进一个 ~350 行的文件。

对应的源码阅读资料见 [case-study/guide/](../case-study/guide/)；10 个可用于课堂的专题 Demo 见 [patterns/](../COURSE_MAP.md)。

## 通用运行方式

```bash
cd mini-agent/<阶段目录>
node agent.mjs            # 大多数阶段：直接运行或带任务参数（见各自 README）
```

## 与真实项目（my-agent-runtime）的对应

每个阶段的 README 末尾都有「对应原项目源码」表。最核心的对照：

| Mini Agent | my-agent-runtime |
|---|---|
| 02 的 runLoop | `core/loop.ts:147` runTurn |
| 03 的 executeTool | `core/loop.ts:365` executeTool（原版多白名单/zod/安全策略三关） |
| 04 的 buildContext | `context/builder.ts:30` |
| 05 的 save/load | `sessions/store.ts:175` / `runtime-store.ts:285` |
| 06 的 memory 注入 | `core/loop.ts:178,346` + `memory/store.ts` |
| 07 的 skill 两级加载 | 原项目未实现（规划中的 v0.2 方向） |
| 09 的 compact | `commands/compact.ts:27` |
