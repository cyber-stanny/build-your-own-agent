# 03 · Tools —— 给 Agent 装上「手」

## 这个阶段是什么

Tool Calling 完整闭环：模型返回**结构化的 `tool_calls`** → 我们执行工具 → 把结果作为 `role:"tool"` 消息塞回历史 → 模型下一轮基于结果继续。

## 相比上一阶段增加了什么

| 增加 | 为什么 |
|---|---|
| 工具四件套：name + description + parameters + run | description 给模型看（它据此选择），run 真正干活 |
| 停止信号升级为结构化 `tool_calls` | 不再靠 `<DONE>` 文本约定——「没有 tool_calls = 最终答案」 |
| `executeTool()`：错误当结果 | 工具报错不抛异常，返回 `error: ...` 字符串让模型自己纠正 |
| 结果回填 `role:"tool"` 消息 | **工具结果进入上下文的唯一通道**，靠 `tool_call_id` 配对 |

## 运行

```bash
cd mini-agent/03-tools
echo "Mini Agent 的学习笔记：今天理解了 tool calling" > notes.txt
node agent.mjs "帮我看看 notes.txt 里写了什么"
```

## 示例输出（mock 模式）

```
[turn 1] 模型: 我先看看目录里有什么。
[turn 1]   调用 list_dir({})
[turn 1]   结果: agent.mjs
notes.txt
README.md
[turn 2] 模型: 找到了，读取内容。
[turn 2]   调用 read_file({"path":"notes.txt"})
[turn 2]   结果: Mini Agent 的学习笔记：今天理解了 tool calling
[turn 3] 模型: notes.txt 的内容是：Mini Agent 的学习笔记：今天理解了 tool calling

最终答复: notes.txt 的内容是：Mini Agent 的学习笔记：今天理解了 tool calling
```

## 对应原项目源码

| 本文件 | 原项目 |
|---|---|
| 工具四件套 | `runtime/tools/types.ts:19` 的 `Tool` 接口 |
| 工具表 `TOOLS` | `runtime/tools/registry.ts:7` 的 `ToolRegistry`（原版还有 zod→JSON Schema 转换） |
| `executeTool()` | `runtime/core/loop.ts:365`（原版多白名单、zod 校验、安全策略三关） |
| 结果回填 | `core/loop.ts:281` |
| mock 三步剧本 | `runtime/model/mock.ts:12-42` |

## 思考题

1. 把 `messages.push({role:"assistant", tool_calls})` 删掉只回填结果，API 会报什么错？（大多数实现要求声明与结果配对出现——原项目 `repairInterruptedToolCalls` 就是在修这种断裂）
2. 如果模型调了一个不存在的工具名，会发生什么？（本版返回 `error: unknown tool`，模型下轮会看到并改道）
3. description 写得好坏对工具选择影响有多大？试着把 `read_file` 的 description 改成 "a tool"，再问一次。
