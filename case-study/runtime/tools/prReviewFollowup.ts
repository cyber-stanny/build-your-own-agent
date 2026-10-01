import path from "node:path";
import { z } from "zod";
import type { Tool } from "./types";
import type { PrReviewFollowupStore } from "../followups/store";

export function createSchedulePrReviewFollowupTool(
  store: PrReviewFollowupStore,
  onScheduled?: () => void,
): Tool<{ repo: string; prNumber: number; workspacePath?: string; complexity?: "simple" | "complex" }> {
  return {
    name: "schedulePrReviewFollowup",
    description:
      "创建或唤醒一个 PR 的 Codex Review 自动跟进任务。创建 PR 或根据 Review push 新提交后调用；后台会读取 Review，并在需要时重新唤醒当前 coding agent。",
    schema: z.object({
      repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "格式应为 owner/repo"),
      prNumber: z.number().int().min(1),
      workspacePath: z.string().optional().describe("仓库在 AGENT_CWD 下的相对路径，例如 agent-learning-taste"),
      complexity: z.enum(["simple", "complex"]).optional(),
    }),
    async run(input, ctx) {
      const workspacePath = normalizeWorkspacePath(ctx.workingDir, input.workspacePath, input.repo);
      const task = store.schedule({ ...input, workspacePath });
      onScheduled?.();
      return JSON.stringify({
        taskId: task.id,
        state: task.state,
        repo: task.repo,
        prNumber: task.prNumber,
        message: "已登记。后台会自动等待 Codex Review；无需再手动提醒读取评论。",
      });
    },
  };
}

export function createGetPrReviewFollowupTool(store: PrReviewFollowupStore): Tool<{ taskId?: string }> {
  return {
    name: "getPrReviewFollowup",
    description: "查看 PR Codex Review 自动跟进任务的当前状态。taskId 留空时返回最近任务。",
    schema: z.object({ taskId: z.string().optional() }),
    async run({ taskId }) {
      const task = taskId ? store.get(taskId) : store.list()[0];
      return task ? JSON.stringify(task) : "(没有 PR Review 跟进任务)";
    },
  };
}

function normalizeWorkspacePath(root: string, value: string | undefined, repo: string): string {
  const candidate = value?.trim() || repo.split("/")[1];
  const resolved = path.resolve(root, candidate);
  const relative = path.relative(path.resolve(root), resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("workspacePath 必须位于 AGENT_CWD 内");
  }
  return relative || ".";
}
