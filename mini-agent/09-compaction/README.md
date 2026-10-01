# 09 · Compaction —— 压缩历史本身

## 这个阶段是什么

`/compact` 的实现：保留「身份 system + 最近 N 个 user 轮原文」，中间的旧历史交给 LLM 压成一条**摘要 system 消息**，写回 transcript。transcript 永久变小，任务语义不丢。

## 与 04 阶段「裁剪」的区别（最容易混淆的点）

| | 04 裁剪（buildContext） | 本阶段 compaction |
|---|---|---|
| 改谁 | 只改「本轮发出什么」 | 直接改 transcript |
| 可逆性 | 每轮重建，transcript 完好 | 不可逆（原文丢了，只剩摘要） |
| 丢失什么 | 旧轮对模型暂时不可见 | 细节，但语义进了摘要 |
| 触发 | 每轮自动（超预算） | 用户主动 `/compact` |

## 相比上一阶段增加了什么

- `splitForCompact()`：三段切分（system / old / tail）
- LLM 摘要（mock 时走规则摘要兜底）+ 摘要作为第二条 system 消息
- 压缩前后 token 对比报告

## 运行

```bash
cd mini-agent/09-compaction
node agent.mjs
```

## 示例输出（mock 模式）

```
压缩前: 12 条消息，粗估 660 tokens
角色序列: system,user,assistant,tool,assistant,user,assistant,tool,user,assistant,user,assistant

压缩后: 6 条消息，粗估 49 tokens
角色序列: system,system,user,assistant,user,assistant

摘要 system 消息内容:
以下是此前对话的压缩摘要，用于继续执行当前任务：

## 目标
顺便把字体换成思源黑体
## 当前进度
旧历史中共 2 条用户输入（mock 规则摘要只提炼最后一条作为目标锚点，细节以保留的最近原文为准）

保留的最近轮原文:
  [user] 加一个设置页，能切换亮暗主题
  [assistant] 设置页完成，localStorage 记住选择。
  [user] 把用户的主题偏好同步到服务端
  [assistant] 方案：登录后 PUT /api/preferences。
```

（660 → 49 tokens：3000 字符的工具输出被压成摘要，最近 2 个 user 轮原文保留。）

## 对应原项目源码

| 本文件 | 原项目 |
|---|---|
| `splitForCompact` | `runtime/commands/compact.ts:80`（`findRecentUserTurnStart` `:93` 从后数第 N 个 user） |
| `COMPACT_PROMPT` | `compact.ts:12-25`（要求七段结构 + "不要编造"） |
| 摘要放 system | `compact.ts:74`——system 是裁剪锚点永不被丢（`context/builder.ts:185-187`），这是放 system 而不是 user 的原因 |
| mock 兜底 | `compact.ts:49-52`（mock 走 `fallbackSummary` `:119`） |
| `/compact` 命令化 | `apps/server.ts:331` → `runtime-store.ts:184`（作为 kind="compact" 的 run 管理） |

## 思考题

1. 为什么保留最近 2 轮**原文**而不是全部摘要？（细节语义比摘要准）
2. 压缩后 prompt cache 会发生什么？（前缀大变 → 必 miss 一次；省 token 与缓存命中是真实取舍）
3. 摘要会「编造」吗？原项目用什么约束？（COMPACT_PROMPT 明确要求"不确定就写不确定"；这是提示词级约束，不是机制级——值得讨论）
