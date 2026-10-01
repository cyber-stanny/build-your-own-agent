# 01 · Basic Chat —— 最简单的 LLM 对话

## 这个阶段是什么

一组 `messages`，一次 API 调用，一个回答。**整个 Agent 世界的地基**：后面所有阶段都是在这一步的外面套东西。

## 相比上一阶段

（这是第一个阶段。）核心只有两个概念：

1. **messages 数组**：`[{role:"system",...}, {role:"user",...}]` —— 对话历史就是普通数组
2. **LLM 封装**：调用方只管「传 messages 拿文本」，背后是真实 API 还是 Mock 无所谓

## 运行

```bash
cd mini-agent/01-basic-chat

node agent.mjs "什么是 Agent Loop？"

# 有 API key 时切真实模型（OpenAI 兼容接口均可）
MINI_AGENT_API_KEY=sk-xxx node agent.mjs "你好"
# 可选：MINI_AGENT_BASE_URL / MINI_AGENT_MODEL
```

## 示例输出（无 key，mock 模式）

```
模型: mock
助手: (mock 回复) 你说：「什么是 Agent Loop？」。配置 MINI_AGENT_API_KEY 可切换真实模型。
```

## 对应原项目源码

| 本文件 | 原项目 |
|---|---|
| `messages` 数组结构 | `runtime/model/types.ts:15` 的 `Message` 类型 |
| `createLLM()` 的接口约定 | `runtime/model/types.ts:51` 的 `ModelClient` 接口 |
| 真实模型分支 | `runtime/model/deepseek.ts:27` 的 `complete()` |
| mock 分支 | `runtime/model/mock.ts:8` 的 `MockModelClient` |

## 思考题

1. 连续问两个问题，怎么让模型记得第一问？（答案就是下一阶段的 loop / 之后的 session：历史还在数组里）
2. 为什么 system 消息放最前面、且只放一次？
