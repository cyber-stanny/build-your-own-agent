# 05 · 工具系统：定义、注册、选择、执行、回填

> 主角文件：`runtime/tools/types.ts` + `runtime/tools/registry.ts`（加起来不到 70 行），以及 `core/loop.ts:365` 的 `executeTool`。
> 工具 = agent 的「手」：**名字 + 给模型看的说明 + zod 入参校验 + run() 返回观察结果字符串**。

## 一个工具长什么样

`tools/types.ts:19-24`：

```ts
export interface Tool<I = any> {
  name: string;
  description: string;              // 会进「工具说明书」给模型，写清「什么时候用、参数啥意思」
  schema: z.ZodType<I>;             // 运行时校验模型给的入参（模型可能给错）
  run(input: I, ctx: ToolContext): Promise<string>;  // 返回 observation，会塞回历史给模型
}
```

`ToolContext`（`tools/types.ts:6-15`）：`workingDir`（工具执行目录）、`shellSandbox`（shell 写入边界）、`signal`（外部中止信号）。**工具拿到的只有 ctx 里给的能力**——这就是 runtime 边界的雏形。

## 注册：ToolRegistry

`tools/registry.ts:7-36`，一个 Map：

- `register(tool)`：链式注册（`registry.ts:11-15`），注册后清 schemaCache
- `get(name)` / `list()`
- `toSchemas()`（`registry.ts:26-35`）：把每个工具的 **zod schema → JSON Schema**（`zodToJsonSchema`），这就是 loop 每轮传给 `model.complete` 的第二参数。有缓存（`schemaCache`），因为 schema 不变时不必重复转换。

注册发生在入口装配时（**不是**全局魔法）：

- CLI：`apps/cli.ts:57-70`（12 个工具）
- Server：`apps/server.ts:68-84`（15 个工具，多了 analyzeImage 和 PR followup 工具）

「选择」分两层：**模型选择**（模型看 toolSchemas 自己决定调哪个）+ **白名单限制**（`LoopConfig.allowedTools`，`executeTool` 开头检查 `core/loop.ts:372-374`；followup 后台 agent 用它禁掉 deploy 等工具，见 `followups/agent.ts:90-96`）。

## 执行：executeTool 五关管线

`core/loop.ts:365-397`（详见 [02-agent-loop](02-agent-loop.md)）：

```
白名单 → registry.get → zod 校验 → 安全策略 checkToolCall → tool.run
```

任何一关失败都返回 `error: ...` 字符串给模型看，**不抛异常**。

## 结果回填

`core/loop.ts:280-282`：

```ts
events.log({ type: "tool_result", id: call.id, content: result.observation });
session.messages.push({ role: "tool", toolCallId: call.id, content: result.observation });
deps.checkpoint?.(session);
```

`toolCallId` 把结果对回 assistant 消息里的 `toolCalls[i].id`。provider 层负责把它翻成各家协议（OpenAI 的 `role:"tool"` / Anthropic 的 `tool_result` 块）。

## 全部工具盘点（按「危险面」组织）

安全设计思想（`policy/permissions.ts:1-3`）：**只读工具放行，把危险面收缩到少数工具**。

### 只读安全组（SAFE_TOOLS，直接放行）

| 工具 | 文件 | 亮点 |
|---|---|---|
| `readFile` | `tools/fileOps.ts:17` | `resolveInside` 路径锁死 workingDir（`:8-15`），防 `../` 逃逸 |
| `listDir` | `tools/fileOps.ts:67` | 同上 |
| `gitStatus` | `tools/gitOps.ts:14` | 空输出兜成 `(工作区干净)`，不给模型空字符串（`:21`） |
| `gitDiff` | `tools/gitOps.ts:25` | 为什么单列 runShell 能干的事？见 `gitOps.ts:5-12` 注释：高频 + 只读安全 → 可判 safe |

### 写操作组（workingDir 兜底）

| 工具 | 文件 | 亮点 |
|---|---|---|
| `writeFile` | `tools/fileOps.ts:26` | 自动建目录；返回 `wrote N chars`（确认性观察结果） |
| `editFile` | `tools/fileOps.ts:38` | 局部替换：oldText 必须精确唯一，否则报错让模型先 readFile；`split+join` 避开 `String.replace` 的 `$` 特殊解析（`:53`） |

### 命令执行组（危险面集中地）

| 工具 | 文件 | 亮点 |
|---|---|---|
| `runShell` | `tools/shell.ts:8` | 只跑「会自然结束」的命令；`looksLikeLongRunningCommand`（`:45-60`）识别 dev server 并引导改用 startProcess |
| `runCommand` | `tools/exec.ts:20` | **永不抛**：超时 SIGTERM→2 秒后 SIGKILL；abort 立即 SIGTERM→3 秒后 SIGKILL 杀整个进程组（`detached: true` + `killProcessGroup`） |
| `startProcess` 等 4 个 | `tools/process.ts:113` | 长期进程管理：`ProcessManager` 内存持有子进程、环形日志 40k 字符（`:100-102`）、自动从日志提取 URL（`:199-201`） |
| 沙箱 | `tools/sandbox.ts:12` | `readonly-root` 模式用 bubblewrap：`--ro-bind / /` 根只读 + 仅 workingDir 可写；非 Linux 或无 bwrap 时报错拒绝 |

### 特殊能力组

| 工具 | 文件 | 亮点 |
|---|---|---|
| `remember` | `tools/memory.ts:7` | **工厂函数模式**：闭包注入 `MemoryStore` 实例，工具本身无全局状态 |
| `deployMain` | `tools/deploy.ts:19` | 受控部署：只有 `prepare` / `reload-only` 两个模式；`reload-only` 需审批（`policy/permissions.ts:38-42`） |
| `analyzeImage` | `tools/analyzeImage.ts:34` | 工具内部再调**另一个模型**（多模态）——工具里嵌套 LLM 调用的实例 |
| `schedulePrReviewFollowup` | `tools/prReviewFollowup.ts` | 工具调用产生**后台副作用**：登记任务 + 唤醒调度器 |

## 工具设计的三条可复用经验

1. **观察结果写给模型看，不是写给人看**：exit_code/stdout/stderr 结构化返回；错误信息里带「下一步该怎么做」（`editFile` 说"请先 readFile 逐字确认原文"）。
2. **危险面收缩**：把所有写盘/执行能力收敛到少数几个工具，安全策略才有明确的拦截点（`policy/permissions.ts:4`）。
3. **工具永不抛异常到 loop**：错误=观察结果，模型看到会自己避开（`core/loop.ts:357-359`）。

## 工具相关测试

- `tools/registry.test.ts`、`tools/shell.test.ts`（长期进程识别）、`tools/exec.test.ts`（超时）、`tools/sandbox.test.ts`（bwrap 参数）、`tools/process.test.ts`、`tools/deploy.test.ts`

## 下一章

工具执行结果写进 `session.messages`，session 又如何持久化、memory 又是什么 → [06-session-memory.md](06-session-memory.md)
