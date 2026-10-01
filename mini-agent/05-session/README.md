# 05 · Session —— 多轮对话与持久化

## 这个阶段是什么

`Session = { id, messages }`：历史跨 run 累积、每次变化落盘 JSON、重启后可恢复继续聊。这是「多轮」与「重启不丢」的机制。

## 相比上一阶段增加了什么

| 增加 | 为什么 |
|---|---|
| `createSession(id, systemPrompt)` | system 只在建会话时放一次，之后所有 run 共用这条历史 |
| `saveSession()` 每次变化落盘 | 等价于原项目 loop 里的 `checkpoint` 回调——随时崩溃都不丢 |
| `loadSession()` / `resume` | 内存是缓存，磁盘是真相 |
| 三种模式 chat / demo / resume | 分别对应：交互多轮、自动验证持久化、断点续聊 |

## 运行

```bash
cd mini-agent/05-session
node agent.mjs demo                      # 非交互演示（推荐先跑这个）
node agent.mjs chat                      # 交互多轮，exit 退出
node agent.mjs resume sess_<id>          # 恢复某个会话继续聊
```

## 示例输出（`demo`，mock 模式）

```
── 第一次运行（会话 sess_1788708359664）──
用户: 我叫小王，最喜欢蓝色
助手: (mock) 这是本次对话的第 1 条用户消息，我记住了之前的全部 2 条历史。
用户: 我喜欢什么颜色？
助手: (mock) 这是本次对话的第 2 条用户消息，我记住了之前的全部 4 条历史。

── 模拟进程重启：内存清空，从磁盘恢复 ──
从 sessions/sess_1788708359664.json 恢复 5 条消息
用户: （新进程）我叫什么名字？
助手: (mock) 这是本次对话的第 3 条用户消息，我记住了之前的全部 6 条历史。

已保存的会话: sess_1788708359664.json
```

（5 条 = system + 前 4 条对话。恢复后的会话带着之前的全部历史——这就是持久化的意义。）

## 对应原项目源码

| 本文件 | 原项目 |
|---|---|
| `createSession` | `runtime/sessions/session.ts:16`（system 只放一次的注释 `:18-19`） |
| `saveSession` | `runtime/sessions/store.ts:175` 的 `saveMessages`（原项目 SQLite + WAL，还存事件与 run 状态三张表 `:88-122`） |
| 每步落盘时机 | `runtime/core/loop.ts` 的 `deps.checkpoint?.(session)`（每次 push 后都调） |
| `resume` | `runtime/sessions/runtime-store.ts:285` 的 `getOrLoad` |
| 会话列表 | `store.ts:141` 的 `listMeta()` |

## 思考题

1. 为什么每次 `messages.push` 之后立刻保存，而不是对话结束时保存一次？
2. Session 和 Memory（下一阶段）的区别是什么？（Session=这条对话的完整历史；Memory=跨对话的提炼事实）
3. 如果两个进程同时写同一个 session 文件会怎样？（原项目用 `SerialTaskQueue` 串行化所有工作区任务，见 `core/serial-queue.ts`）
