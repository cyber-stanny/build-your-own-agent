# 07 · Skill / Extension / Plugin：这个项目怎么「扩展」

> 先给结论：**这个项目没有名字叫 Skill 的机制**。它靠四个明确的扩展点实现同等能力。
> 学习价值在于：看清一个真实项目里「扩展点」长什么样，以及 skill 系统被规划成了什么。

## 四个真实的扩展点

### 扩展点 1：加工具（最常用）

两步：实现 `Tool` 接口 → 入口注册。

```ts
// 1. 实现一个工具（tools/xxx.ts）
export const myTool: Tool<{ path: string }> = {
  name: "myTool",
  description: "什么时候用它……",   // 写给模型看的
  schema: z.object({ path: z.string() }),
  async run({ path }, ctx) { return "..."; },
};

// 2. 注册（apps/cli.ts:57 或 apps/server.ts:68 的链式调用）
registry.register(myTool);
```

已有先例：`analyzeImage` 就是后来加的（这个工具是 agent 自己添加并验证的）。带依赖的工具用**工厂函数**注入依赖，如 `createRememberTool(memory)`（`tools/memory.ts:7`）、`createProcessTools()`（`tools/process.ts:113`）。

### 扩展点 2：加事件 sink（观察/持久化/推送）

`core/events.ts:45-48` 定义 `EventSink` 接口（一个 `handle(ev)` 方法）；`EventBus.use()` 注册（`:54-57`）。loop 只调 `events.log()`，完全不关心有几个出口。

已有 sink：`ConsoleSink`（终端）、`JsonlSink`（文件回放）、`SessionPersistenceSink`（写 SQLite + 广播 ws，`sessions/runtime-store.ts:86-103`）。**加一个 Slack 通知 sink = 实现 handle + 一行 .use()，loop 不动**。

### 扩展点 3：换模型 / 加 provider

实现 `ModelClient` 接口（`model/types.ts:51`）→ 入口选择逻辑里加一个分支。详见 [04-llm](04-llm.md)。

### 扩展点 4：斜杠命令（用户层扩展）

`commands/registry.ts:13-19` 声明命令元数据；server 端 `commandHandlers` 表（`apps/server.ts:315-343`）注册处理器。`/new` `/sessions` `/session` `/compact` `/stop` 都走这条 路。

## 「Skill」在这里的真实对应物

这个项目的 agent 有一种**事实上的技能载体**：

1. **System prompt 里的行为规范**：`config.defaults.ts:23-24` 一句话定身份；followup agent 用多行 system prompt 规定工作守则（`followups/agent.ts:32-40`，包括"必须遵守目标仓库的 AGENTS.md"）
2. **仓库内的 AGENTS.md / 文档**：agent 干活时用 readFile 读到规则——**知识放仓库，agent 现场读**，而不是塞进 runtime
3. **工具描述即技能**：`editFile` 的 description 教模型"改代码用这个，不要 writeFile 整文件覆盖"（`tools/fileOps.ts:40-42`）——这是渐进式披露的最小形态

## 规划中的 Skill 系统（v0.2 方向）

skill 系统是原作者规划中的 v0.2 方向，v0.1 刻意不做。动因是：工具越加越多 → 每个工具的说明都占 system prompt → 需要"按需加载"的机制。这就是 skill 要解决的问题（也是 `mini-agent/07-skills` 教学版要演示的）。

## 本仓库给出的「扩展机制」教学资产

- `mini-agent/07-skills/`：从零实现的最小 skill 系统（skill = 带元数据的 markdown，按需加载）
- `mini-agent/08-subagent/`：最小 sub-agent（父 agent 派活、子 agent 带受限工具跑 loop）
- `reference/openclaw/`、`reference/claude-code/`：外部成熟项目的扩展机制参考

## 设计判断：为什么这四个点够用

个人版 v1 的扩展需求真实只有四类：让模型多一双手（工具）、让运行可观察（sink）、换脑子（provider）、让人快一点（命令）。每一类都有清晰的接口边界和现成样板。**扩展点不在多，在边界清楚。**
