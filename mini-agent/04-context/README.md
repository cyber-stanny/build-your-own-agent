# 04 · Context —— transcript 与「发出什么」是两回事

## 这个阶段是什么

Context 管理三件套：**token 估算 → 超长工具结果截断 → 超预算整轮丢弃**。核心认知：transcript 全量保存、永不修改；每轮发给模型的 context 按需裁剪。

## 相比上一阶段增加了什么

| 增加 | 为什么 |
|---|---|
| `estimateTokens()`（chars/4 粗估） | 不需要精确分词，先有量级感 |
| `truncateMiddle()` 工具结果截断 | 工具输出是最大的 token 吞金兽；保留头尾（关键信息常在两端） |
| `buildContext()` 超预算裁剪 | 成批丢弃最旧的**完整 user 轮**，绝不拆轮 |
| 决策记录 `omitted` | 裁剪必须可审计——不然模型答错时分不清是「没给够」还是「模型不行」 |

## 运行

```bash
cd mini-agent/04-context
node agent.mjs
```

## 示例输出（mock 环境，纯本地演示）

```
transcript: 16 条消息，粗估 662 tokens（全量保存，不动）

── 截断演示（单条工具结果）──
日志1: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
…[截断 431 字符]…
xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx 结束标记1

── 裁剪演示（预算 100 tokens）──
context: 4 条消息，粗估 30 tokens
roles: system, user, assistant, tool
决策记录:
  - 丢弃最旧 4 个完整 user turn（剩 3 条消息）
  - 裁剪后粗估 30 / 预算 100 tokens
```

（最后一个 user 轮引发 3 条消息，加上 system 共 4 条——**轮不会被拆开**。）

## 对应原项目源码

| 本文件 | 原项目 |
|---|---|
| `estimateTokens` | `runtime/context/builder.ts:219` |
| `truncateMiddle` | `builder.ts:232` |
| `buildContext` | `builder.ts:30`（入口）→ `buildCacheFirstContext` `:38-65`（逐批尝试，更精细） |
| system 永远保留 | `builder.ts:185-187` 锚点机制 |
| 决策审计 | `included`/`omitted` 字段 `:18-23` + `context/debugger.ts` |

## 思考题

1. 为什么「截断」而不是「丢弃」超长工具结果？（结果里可能有关键错误信息；头尾各留一段是最便宜的保真）
2. 为什么裁剪单位是「完整 user 轮」？如果只删一条旧 tool 消息会怎样？（tool_calls 与结果配对断裂，API 拒绝）
3. 这种裁剪对厂商 prompt cache 有什么影响？（前缀变了就 miss——原项目因此默认 cache-first：预算内不裁，见 `context/cache-observability.ts`）
