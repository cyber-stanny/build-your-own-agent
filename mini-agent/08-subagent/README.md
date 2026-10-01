# 08 · Sub-agent —— 派活的艺术

## 这个阶段是什么

父 agent 有一个新工具 `spawn_subagent`：把子任务交给一个**独立 loop、独立身份、受限工具**的子 agent；子 agent 的最终结论作为「观察结果」回到父上下文。

## 相比上一阶段增加了什么

| 增加 | 为什么 |
|---|---|
| `spawn_subagent` 工具 | 派活对模型来说就是一个普通工具调用 |
| `runSubagent()` 独立 loop | 子 agent 有自己的 system prompt 和消息数组，与父完全隔离 |
| 只回传最终结论 | **子 agent 的几十条中间消息被压缩成一条观察结果**——这是 sub-agent 最重要的上下文价值 |
| 受限工具集（教学版=无工具） | 原版 followup 禁掉 deploy 等；权限按角色分配 |

## 运行

```bash
cd mini-agent/08-subagent
node agent.mjs "调研：Node.js 和 Python 哪个更适合大一学生入门？"
```

## 示例输出（mock 模式）

```
    [子agent 启动] 任务: 列出 Node.js 和 Python 各 3 个优缺点（面向大一新生视角）
    [子agent 完成] 返回 102 字符结论（中间过程不带回父上下文）

最终答复: 根据子 agent 的调研：调研结论：Node.js 上手快（就学 JavaScript 一门语言、npm 生态活跃）；Python 语法最接近伪代码、数据科学资源多。建议：想做网页先 Node.js，想做数据处理选 Python。……综合建议：先想清楚你想做什么方向。
```

## 对应原项目源码

原项目没有「run 中途派生」的 sub-agent，但 `followups/` 是同构的后台 agent，机制一一对应：

| 本文件 | 原项目 |
|---|---|
| 子 agent 复用同一个 loop | `followups/agent.ts:26`（直接调 `runTurn`，同一套 registry） |
| 受限工具集 | `followups/agent.ts:90` 的 `getFollowupAllowedTools`（黑名单禁 deploy 等） |
| 结构化结果回传 | `followups/agent.ts:143`（只解析一行 JSON：fixed/skipped/blocked） |
| 派活触发 | 教学版=模型调工具；原版=外部事件 + 轮询调度（`followups/scheduler.ts`） |

## 思考题

1. 什么时候值得派子 agent，什么时候自己做？（独立、可并行、中间过程庞大的任务值得派；需要和用户反复确认的不适合）
2. 子 agent 会不会失控烧钱？（原版做法：轮数上限 + 结构化输出协议 + 外部事实核查——`followups/service.ts:123` 比对 PR head oid）
3. 如果两个子 agent 同时写同一个文件会怎样？（原版把所有工作区任务排进一条串行队列，见 `core/serial-queue.ts`）
