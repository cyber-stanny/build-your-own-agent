# AGENTS.md

这是一个单用户、个人自用并持续迭代的 `my-agent-runtime`（TypeScript/Node）项目：浏览器连接云服务器上的 agent runtime，由 agent 读写工作区、执行工具、提交 PR，并通过 CI 与 Codex Review 做质量把关。当前优先完成够用、可验证的 v1，不按多租户或无人值守生产系统的标准扩大需求。

## 项目结构
- TypeScript/Node。常用：`npm run agent -- --mock "<任务>"`、`npm run replay -- runs/<x>.jsonl`、`npm run typecheck`。
- provider 在 `model/`（mock / anthropic / deepseek）；loop 在 `core/loop.ts`；工具在 `tools/`。
- runtime 结构见 [runtime/README.md](runtime/README.md)。

## PR 工作流

创建 PR 或根据 Codex Review 修复后，如果需要等待复审，调用 `schedulePrReviewFollowup` 登记一次后续检查。后台调度器会稍后读取当前 PR head 对应的 Codex Review 和行内评论，再唤醒同一个 coding agent 继续处理。

## Code Review Rules

代码审查重点关注：PR 是否解决了它描述的问题，以及正常个人使用路径下是否存在实际风险。

- P0/P1 仅用于必须阻止合并的问题，例如正常使用可触发的崩溃、数据丢失、凭据泄露、错误修改生产代码，或明显破坏 agent loop、tools、session、memory 等核心边界。
- P2 用于有现实影响但不阻止个人版 v1 使用的问题；P3 用于可选改进。P2/P3 默认不阻止结束 Review，由 Agent 结合当前需求、实现复杂度和正常使用概率判断是否继续修改。
- 当前不要求覆盖恶意模型、恶意仓库贡献者、多租户攻击、极端并发、理论上的 TOCTOU、罕见符号链接攻击或异常 Git 参数组合，除非它们在本项目正常工作流中可直接触发。
- 如果存在更简单、更稳妥且符合仓库现有模式的方案，可以提出；不要把最佳实践建议升级成阻塞问题，也不要为了 Review 扩大 PR 范围。
- 如果 PR 已覆盖当前问题、没有 P0/P1、验证匹配风险等级，应当通过。不要为了 Review 而强行提出额外工作。

## Review 修复结束条件

- Agent 必须修完所有 P0/P1。
- 对 P2，Agent 自行判断：只有会影响当前个人使用、造成明显错误，且修复不会显著扩大范围时才继续修改；其他 P2 记录在结果中并结束。
- P3 不在当前循环中修复，留作后续迭代。
- 简单 PR 默认最多进行 3 轮“修复、push、重新 Review”。复杂 PR 最多 5 轮，但第 3 轮后必须确认问题正在收敛；若核心方案仍反复变化，应停止补丁式修复并标记 blocked。
- CI 通过且没有 P0/P1，并且 Agent 判断剩余 P2 不影响当前个人使用时，可以结束，不要求所有评论清零。
- 涉及定时器、重试、外部 API 或后台任务等复杂状态时，编码前先写清主要状态、转换和失败恢复；方案明确后再实现，不要求为个人版补齐生产级极端场景。

## 提交
改完一块能跑的东西就 commit（留痕）。提交信息末尾保留 Co-Authored-By 行。
