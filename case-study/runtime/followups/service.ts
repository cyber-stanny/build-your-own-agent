import type { PrReviewFollowupStore } from "./store";
import type { ReviewGithub } from "./github";
import {
  TERMINAL_FOLLOWUP_STATES,
  maxRepairAttempts,
  type AgentFollowupInput,
  type AgentFollowupOutcome,
  type PrReviewFollowupTask,
  type PullRequestSnapshot,
} from "./types";

export type FollowupServiceOptions = {
  pollIntervalMs: number;
  reviewTimeoutMs: number;
  ciTimeoutMs: number;
  maxConsecutiveErrors?: number;
  runExclusive?: <T>(task: () => Promise<T>) => Promise<T>;
};

export type FollowupAgent = (input: AgentFollowupInput) => Promise<AgentFollowupOutcome>;

export class PrReviewFollowupService {
  constructor(
    private store: PrReviewFollowupStore,
    private github: ReviewGithub,
    private runAgent: FollowupAgent,
    private options: FollowupServiceOptions,
    private onUpdate?: (task: PrReviewFollowupTask) => void,
    private now: () => Date = () => new Date(),
  ) {}

  async process(taskId: string): Promise<PrReviewFollowupTask | undefined> {
    const original = this.store.get(taskId);
    if (!original || TERMINAL_FOLLOWUP_STATES.has(original.state)) return original;

    try {
      const runExclusive = this.options.runExclusive ?? (async <T>(task: () => Promise<T>) => task());
      await runExclusive(() => this.processCurrent(original));
      const latest = this.store.get(taskId);
      if (latest && latest.consecutiveErrors > 0 && !TERMINAL_FOLLOWUP_STATES.has(latest.state)) {
        this.update(latest, { consecutiveErrors: 0, lastError: undefined });
      }
    } catch (error) {
      const latest = this.store.get(taskId);
      if (latest && !TERMINAL_FOLLOWUP_STATES.has(latest.state)) this.recordError(latest, error);
    }
    return this.store.get(taskId);
  }

  private async processCurrent(task: PrReviewFollowupTask): Promise<void> {
    const pullRequest = await this.github.getPullRequest(task.repo, task.prNumber);
    if (pullRequest.merged) {
      this.update(task, { state: "ready", summary: `PR 已合并：${pullRequest.url}` });
      return;
    }
    if (pullRequest.state === "closed") {
      this.update(task, { state: "cancelled", summary: `PR 已关闭：${pullRequest.url}` });
      return;
    }

    if (task.currentHeadOid !== pullRequest.headOid) {
      this.resetForHead(task, pullRequest.headOid);
      task = this.store.get(task.id)!;
    }

    if (task.state === "waiting_ci") {
      await this.processCi(task, pullRequest);
      return;
    }

    if (task.state === "repairing") {
      this.update(task, {
        state: "waiting_review",
        summary: "检测到未完成的修复状态，已按 GitHub 当前 head 重新检查。",
      });
      return;
    }

    await this.processReview(task, pullRequest);
  }

  private async processReview(task: PrReviewFollowupTask, pullRequest: PullRequestSnapshot): Promise<void> {
    let review = await this.github.getTrustedReview(task.repo, task.prNumber, pullRequest.headOid);
    if (
      !review.completed &&
      task.reviewRequestHeadOid === pullRequest.headOid &&
      task.reviewRequestCommentId &&
      (await this.github.hasCleanReaction(task.repo, task.reviewRequestCommentId))
    ) {
      review = { completed: true, findings: [], summary: "Codex 以 +1 reaction 确认本轮没有问题。" };
    }

    if (!review.completed) {
      await this.waitForReview(task, pullRequest);
      return;
    }

    const hardFindings = review.findings.filter((finding) => finding.severity === "P0" || finding.severity === "P1");
    const p2Findings = review.findings.filter((finding) => finding.severity === "P2");
    if (hardFindings.length === 0 && p2Findings.length === 0) {
      this.update(task, {
        state: "waiting_ci",
        ciWaitStartedAt: this.now().toISOString(),
        summary: review.findings.length > 0 ? "Codex 仅剩 P3，个人版不进入自动修复。" : "Codex Review 已通过。",
      });
      return;
    }

    if (task.repairAttempts >= maxRepairAttempts(task.complexity)) {
      this.update(task, {
        state: "blocked",
        summary: `已达到 ${maxRepairAttempts(task.complexity)} 次修复上限，仍有 ${hardFindings.length} 个 P0/P1、${p2Findings.length} 个 P2。`,
      });
      return;
    }

    this.update(task, {
      state: "repairing",
      summary: `正在处理 ${hardFindings.length} 个 P0/P1、${p2Findings.length} 个 P2。`,
    });

    const outcome = await this.runAgent({ task: this.store.get(task.id)!, pullRequest, review });
    const after = await this.github.getPullRequest(task.repo, task.prNumber);
    if (after.headOid !== pullRequest.headOid) {
      this.update(this.store.get(task.id)!, {
        state: "waiting_review",
        currentHeadOid: after.headOid,
        repairAttempts: task.repairAttempts + 1,
        reviewRequestHeadOid: undefined,
        reviewRequestCommentId: undefined,
        reviewRequestAttempts: 0,
        reviewRequestedAt: undefined,
        ciWaitStartedAt: undefined,
        summary: `${outcome.summary} 已检测到新提交，等待下一轮 Codex Review。`,
      });
      return;
    }

    if (outcome.status === "skipped" && hardFindings.length === 0) {
      this.update(this.store.get(task.id)!, {
        state: "waiting_ci",
        ciWaitStartedAt: this.now().toISOString(),
        summary: `${outcome.summary} 剩余 P2 已按个人版规则接受。`,
      });
      return;
    }

    this.update(this.store.get(task.id)!, {
      state: "blocked",
      summary:
        outcome.status === "fixed"
          ? `${outcome.summary} Agent 返回 fixed，但 GitHub PR head 没有变化。`
          : outcome.summary,
    });
  }

  private async waitForReview(task: PrReviewFollowupTask, pullRequest: PullRequestSnapshot): Promise<void> {
    const now = this.now();
    const requestedForHead = task.reviewRequestHeadOid === pullRequest.headOid && task.reviewRequestedAt;
    const elapsed = requestedForHead ? now.getTime() - new Date(task.reviewRequestedAt!).getTime() : 0;

    if (!requestedForHead || (elapsed >= this.options.reviewTimeoutMs && task.reviewRequestAttempts < 2)) {
      const attempt = requestedForHead ? task.reviewRequestAttempts + 1 : 1;
      const commentId = await this.github.requestReview(task.repo, task.prNumber, task.id, pullRequest.headOid, attempt);
      this.update(task, {
        reviewRequestHeadOid: pullRequest.headOid,
        reviewRequestCommentId: commentId,
        reviewRequestAttempts: attempt,
        reviewRequestedAt: now.toISOString(),
        summary: attempt === 1 ? "已请求 Codex Review。" : "Codex 首次等待超时，已补发一次 Review 请求。",
      });
      return;
    }

    if (elapsed >= this.options.reviewTimeoutMs && task.reviewRequestAttempts >= 2) {
      this.update(task, { state: "blocked", summary: "两次请求 Codex Review 均等待超时。" });
      return;
    }
    this.update(task, { summary: "等待 Codex Review 完成。" });
  }

  private async processCi(task: PrReviewFollowupTask, pullRequest: PullRequestSnapshot): Promise<void> {
    const checks = await this.github.getChecks(task.repo, pullRequest.headOid);
    if (checks.status === "success") {
      this.update(task, { state: "ready", summary: `${checks.summary} 可以由用户决定是否合并。` });
      return;
    }
    if (checks.status === "failure") {
      this.update(task, { state: "blocked", summary: checks.summary });
      return;
    }

    const startedAt = task.ciWaitStartedAt ?? this.now().toISOString();
    if (this.now().getTime() - new Date(startedAt).getTime() >= this.options.ciTimeoutMs) {
      this.update(task, { state: "blocked", ciWaitStartedAt: startedAt, summary: "等待 CI 超时。" });
      return;
    }
    this.update(task, { ciWaitStartedAt: startedAt, summary: checks.summary });
  }

  private resetForHead(task: PrReviewFollowupTask, headOid: string): void {
    this.update(task, {
      state: "waiting_review",
      currentHeadOid: headOid,
      reviewRequestHeadOid: undefined,
      reviewRequestCommentId: undefined,
      reviewRequestAttempts: 0,
      reviewRequestedAt: undefined,
      ciWaitStartedAt: undefined,
      summary: `开始检查 PR head ${headOid.slice(0, 8)}。`,
    });
  }

  private recordError(task: PrReviewFollowupTask, error: unknown): void {
    const consecutiveErrors = task.consecutiveErrors + 1;
    const maxErrors = this.options.maxConsecutiveErrors ?? 3;
    this.update(task, {
      state: consecutiveErrors >= maxErrors ? "blocked" : task.state === "repairing" ? "waiting_review" : task.state,
      consecutiveErrors,
      lastError: error instanceof Error ? error.message : String(error),
      summary:
        consecutiveErrors >= maxErrors
          ? `连续 ${consecutiveErrors} 次后台处理失败，已停止自动重试。`
          : `后台处理暂时失败，将自动重试（${consecutiveErrors}/${maxErrors}）。`,
    });
  }

  private update(task: PrReviewFollowupTask, patch: Partial<PrReviewFollowupTask>): PrReviewFollowupTask {
    const now = this.now();
    const next: PrReviewFollowupTask = {
      ...task,
      ...patch,
      updatedAt: now.toISOString(),
      nextCheckAt: TERMINAL_FOLLOWUP_STATES.has(patch.state ?? task.state)
        ? now.toISOString()
        : new Date(now.getTime() + this.options.pollIntervalMs).toISOString(),
    };
    const saved = this.store.save(next);
    this.onUpdate?.(saved);
    return saved;
  }
}
