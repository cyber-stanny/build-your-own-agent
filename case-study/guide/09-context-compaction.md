# 09 · Context Compaction：/compact 压缩历史

> 主角文件：`runtime/commands/compact.ts`（160 行）。
> 定位：compaction 与 [03-context](03-context.md) 的裁剪是**互补的两层**——
> 裁剪是「每轮临时少发一点」（transcript 不变）；compaction 是「把 transcript 本身改小」（不可逆替换，有摘要兜底）。

## 两层上下文管理的分工

```mermaid
flowchart TD
    A[transcript 越来越长] --> B{超预算了吗}
    B -- 快超/已超 --> C[被动裁剪 buildContext<br/>cache-first 丢最旧 user turn<br/>transcript 本身不动，下一轮照旧]
    B -- 用户主动 --> D[/compact 命令<br/>旧历史 → LLM 摘要，写回 transcript]
    C --> E[临时省 token]
    D --> F[永久变小 + 保留任务语义]
```

为什么需要 compaction：裁剪只是让旧 turn 在**单轮请求**里不可见（transcript 本身还在，每轮重新构建）；但只要任务持续超预算，早期轮次会**一直**被裁掉，任务做很久后「最初的约定/决定」等于持续失联。compaction 用摘要把这些**语义**留在 context 里。

## 入口：用户敲 /compact

- 命令解析：`commands/registry.ts:21`（`parseCommand`），命令表 `:13-19`
- server 端处理器：`apps/server.ts:331-337` → `runtimeStore.startCompact(...)`
- `SessionRuntimeStore.startCompact`（`sessions/runtime-store.ts:184-198`）：把压缩也当作一个 run（kind="compact"）纳入统一的状态机管理（可停止、有状态记录、与任务 run 互斥）

## 核心：compactMessages（commands/compact.ts:27-47）

```ts
export async function compactMessages(messages, model, { keepRecentUserTurns }): Promise<CompactResult>
```

四步：

### 1. 切分：splitForCompact（compact.ts:80-91）

```
[system(身份)] + [旧历史...] + [最近 N 个 user turn 及其后文]
     原样保留         送去总结           原样保留
```

`findRecentUserTurnStart`（`:93-104`）从后往前数第 N 个 user 消息的位置。`keepRecentUserTurns` 默认 2（`config.defaults.ts:22`）。

### 2. 摘要：summarize（compact.ts:49-62）

- 用 **COMPACT_PROMPT**（`:12-25`）调同一个 `model.complete`（注意：**不带工具**，第二个参数传 `[]`）要求结构化输出：目标 / 当前进度 / 关键文件、命令 / 已确认的决定 / 失败过的尝试 / 未完成事项 / 下一步建议
- mock 模型直接走规则摘要 `fallbackSummary`（`:119-140`）——注意它的实际行为：只把**最后一条 user 输入**放进「目标」、附最近 8 条消息原文；摘要文本里那句「保留全部用户输入作为任务锚点」是文案的自我描述，并非实际保证。读代码时要区分「摘要说了什么」和「摘要真的含什么」。

### 3. 替换：replaceOldHistoryWithSummary（compact.ts:70-78）

```ts
[原 system] + [新 system: "以下是此前对话的压缩摘要…" + summary] + [最近的 tail]
```

摘要作为**system 消息**插在身份 system 之后——之后每轮 buildContext 都会带上它（system 是锚点永不被裁，`context/builder.ts:185-187`）。

### 4. 原地写回 + 持久化

`compact.ts:38`：`messages.splice(0, messages.length, ...compacted)` 直接改写 session.messages 数组；
`runtime-store.ts:191`：`saveMessages` 落 SQLite。
返回 `CompactResult`（`:4-10`）包含压缩前后消息数与 token 估算，server 会 emit 成 `command_result` 事件（`runtime-store.ts:195`）显示给用户。

## 与 loop 的配合细节

- compaction 改的是 transcript；loop 下一次 `buildContext` 自然看到新形状，**loop 代码零改动**
- 压缩后紧跟的下一轮请求前缀变化很大（旧消息没了）→ prompt cache 必然 miss 一次，`cache-observability` 的事件会显示出来。这是「省 token」与「缓存命中」之间的真实取舍
- `repairInterruptedToolCalls`（`core/loop.ts:312`）对压缩后的 transcript 依然安全：tail 原样保留，配对关系不变

## 设计取舍记录

原作者在迭代中做过两个取舍：为什么保留最近 N 轮原始轮次（细节语义比摘要更准）、为什么摘要放 system 而不是 user。教学版实现见 `mini-agent/09-compaction/`。

## 动手验证

```bash
cd runtime && npm run server
# 网页连接后发几轮消息把历史撑长，然后敲：/compact
# 观察事件流里 command_result: 压缩完成：messages X→Y，粗估 tokens A→B
```
