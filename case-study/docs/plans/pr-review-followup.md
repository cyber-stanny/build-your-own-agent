# PR Review 自动跟进方案（个人版 v1）

## 目标

线上 Agent 提交或更新 PR 后，不再依赖用户手动提醒它读取 Codex Review。服务端定时检查 Review；发现需要处理的问题时，重新调用现有 coding agent 完成修改、测试、提交和 push。没有阻塞问题且 CI 通过后，任务标记为 `ready`，仍由用户决定是否合并和部署。

## 设计取舍

- 复用现有 agent loop、模型、工具和 `AGENT_CWD`，不再创建一套独立的 Repair Agent。
- 调度器只负责持久化任务、读取可信 GitHub 状态和唤醒 Agent，不负责理解或修改代码。
- Agent 自己修改、测试、commit 并 push；服务端只用 PR head 是否变化确认修复是否真正提交。
- 自动流程不 merge、不 deploy，也不能修改生产运行目录。
- 这是单用户个人版。只覆盖正常工作流，不扩展到多租户、恶意模型、极端并发和理论攻击场景。

旧方案中独立 Repair Agent、临时 clone、bundle、服务端代 commit/push 等设计不再采用。它们增加了第二套 Git 和权限边界，已经超过当前需求。

## 完整流程

```text
Agent 创建或更新 PR
  -> 调用 schedulePrReviewFollowup
  -> 调度器读取 PR 当前 head
  -> 当前 head 尚无 Codex Review 时发送 @codex review
  -> 定时读取当前 head 的 review summary 与行内评论
  -> 有 P0/P1 或值得修的 P2：唤醒现有 Agent
  -> Agent 在 AGENT_CWD 修改、测试、commit、push 到原 PR 分支
  -> 调度器确认 PR head 已变化，再等待下一轮 Review
  -> 无 P0/P1 且 CI 通过：ready
  -> 用户手动 merge，之后再手动触发部署
```

## 状态

- `waiting_review`：等待当前 head 的 Codex Review。
- `repairing`：现有 Agent 正在处理可信 Review 意见。
- `waiting_ci`：Review 已满足个人版放行规则，等待 CI。
- `ready`：没有 P0/P1 且 CI 已通过，可以由用户决定合并。
- `blocked`：仍有 P0/P1 但已到修复上限，或 Agent 无法安全完成。
- `cancelled`：PR 已关闭且没有合并。

服务重启时，持久化任务继续轮询。若重启发生在 `repairing`，任务回到 `waiting_review`，并以 GitHub 当前 head 为准重新判断。

## 可信 Review

- 只信任官方 `chatgpt-codex-connector` Bot。
- Review 必须对应 PR 当前 head；旧 commit 的评论不能决定当前状态。
- 读取 review summary 和属于该 review 的行内评论。普通顶层评论缺少可靠的 commit 绑定，不作为修复依据。
- 如果当前 head 已有官方 review 且没有 P0/P1/P2，视为本轮 clean。
- 如果官方 Bot 只对本任务的 Review 请求留下 `+1` reaction，也可视为 clean；`eyes` 只表示已接收。

## 修复规则

- P0/P1 必须修复。
- P2 交给同一个 Agent 判断。只修正常个人使用会遇到、影响明确且不会显著扩大范围的问题；其余记录后跳过。
- P3 不进入自动修复。
- 简单 PR 最多 3 次真实修复 push；复杂 PR 最多 5 次。复杂 PR 到第 3 次后若核心方案仍反复变化，应停止并标记 `blocked`，不靠增加轮数掩盖设计问题。
- 等待 Review、等待 CI、临时 GitHub API 错误不消耗修复次数。
- Agent 返回 `fixed` 后，PR head 必须变化；否则不能把口头结果当成完成。

## 等待与失败

- 首次检查没有当前 head 的 Review 时，发送一次带任务标记的 `@codex review`。
- 每分钟轮询一次。单次等待 20 分钟后允许补发一次；第二次仍超时则 `blocked`。
- CI 最多等待 30 分钟。失败或超时后标记 `blocked`，不由 Agent 绕过。
- 连续 3 次 GitHub API/模型运行错误后标记 `blocked`，避免后台无限重试。

## Agent 运行边界

后台跟进仍使用项目现有 Agent，只为这一轮提供明确任务上下文：仓库、PR、当前 head、工作区位置和可信 findings。

Agent 可以使用正常 coding 工具并自行运行测试。`git push` 必须作为单独命令执行，后台只自动批准这一种窄范围操作。`deployMain` 和可执行任意长期命令的 `startProcess` 不提供给后台跟进任务；merge、PM2 reload、Nginx 和生产目录修改均不在此流程内。GitHub 状态读取、Agent 修复和 push 后确认共用同一个工作区串行队列，排队后会重新读取 head，不使用过期 Review。

Agent 最终返回：

```json
{"status":"fixed | skipped | blocked","summary":"本轮处理结果"}
```

最终是否 `ready` 仍由调度器重新读取 GitHub head、Review 和 CI 判断，不能只相信 Agent 的文字结论。

## 验收

- Agent 创建 PR 后可以登记任务，无需用户再次提醒。
- 当前 head 无 Review 时只发送一次请求；等待不会消耗修复次数。
- 能同时读取 Codex 外层 summary 和内层行内评论。
- 有 P1 时会唤醒现有 Agent；Agent push 后继续审查同一个 PR。
- 只有 P2 时 Agent 可以选择跳过并结束，不陷入清零所有评论的循环。
- CI 成功且无 P0/P1 时进入 `ready`；流程不会自动 merge 或 deploy。
- 服务重启后任务仍可继续。

## 已观察到的 Review 耗时

历史演练中，正常一轮 Codex Review 大约需要 4 到 8 分钟；曾有一次 15 分钟未回复，补发后约 5 分钟完成。因此 v1 使用 1 分钟轮询和 20 分钟单次等待上限，不用固定 5 分钟就假定 Review 已完成。
