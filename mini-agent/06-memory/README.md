# 06 · Memory —— 跨会话的持久事实

## 这个阶段是什么

最简单的记忆系统：一个 JSON 文件 + 两个通道——**读是隐式注入**（每轮渲染成 system 消息），**写是显式工具**（模型调 `remember`）。

## 相比上一阶段增加了什么

| 增加 | 为什么 |
|---|---|
| `memory.json` 持久文件 | 事实跨 run、跨进程存活（session 只属于一条对话线） |
| `remember` 工具 | 模型自己决定什么值得记——人不参与筛选 |
| 每圈重新读取 + 注入 system | run 中途刚写的记忆下一圈就生效 |
| 同 key 覆盖 + 上限 50 条 | 防止记忆无限膨胀和过期事实堆积 |

## Session vs Memory（一次讲清）

| | Session（05 阶段） | Memory（本阶段） |
|---|---|---|
| 存什么 | 完整对话历史 | 提炼后的 key/value 事实 |
| 活多久 | 一条对话线 | 跨所有对话 |
| 怎么进模型 | messages 数组本身 | 每轮注入的 system 消息 |

## 运行

```bash
cd mini-agent/06-memory
node agent.mjs demo
rm memory.json   # 清空记忆重来
```

## 示例输出（mock 模式）

```
── run 1：告诉它一件事实 ──
用户: 我叫小王
助手: 好的，我记下来。
  [工具] 已记住: user.name = 小王

memory.json: {
  "entries": [
    { "key": "user.name", "value": "小王", "updatedAt": "2026-..." }
  ]
}

── run 2：全新的 run（历史为空），但记忆还在 ──
用户: 我叫什么？
助手: (mock) 从记忆注入中看到：- user.name: 小王
```

## 对应原项目源码

| 本文件 | 原项目 |
|---|---|
| `loadMemory` / `remember` | `runtime/memory/store.ts:17`（还有 category 分类、上限 50、坏文件兜底） |
| `formatForContext` | `memory/store.ts:50`（引导语："如已过时请用 remember 更新"） |
| 每圈注入 | `core/loop.ts:178`（`config.memoryContext?.()`）+ `withMemoryContext` `:346-355`（插在身份 system 之后） |
| `remember` 工具 | `tools/memory.ts:7` 的 `createRememberTool`（工厂函数注入 store） |

## 思考题

1. 为什么记忆注入放在 `buildContext` **之前**？（原项目 `core/loop.ts:179`——这样记忆也参与裁剪和 token 估算，不会偷偷超预算）
2. 记忆写错了怎么办？（模型下一轮看到 system 里的引导语，可以调 remember 用同 key 覆盖——自我修正）
3. 这种「全量注入每轮」的记忆有什么局限？什么时候需要检索式记忆（RAG）？（50 条以内全量够用；上千条后注入成本会压垮 context——那是检索的领地）
