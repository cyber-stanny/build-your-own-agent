import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  TERMINAL_FOLLOWUP_STATES,
  type FollowupComplexity,
  type PrReviewFollowupTask,
} from "./types";

export type ScheduleFollowupInput = {
  repo: string;
  prNumber: number;
  workspacePath?: string;
  complexity?: FollowupComplexity;
};

export class PrReviewFollowupStore {
  private tasks: PrReviewFollowupTask[];

  constructor(private filePath: string) {
    this.tasks = this.read();
    this.recoverInterruptedTasks();
  }

  schedule(input: ScheduleFollowupInput, now = new Date()): PrReviewFollowupTask {
    const nowIso = now.toISOString();
    const existing = this.tasks.find(
      (task) => task.repo === input.repo && task.prNumber === input.prNumber && !TERMINAL_FOLLOWUP_STATES.has(task.state),
    );

    if (existing) {
      existing.workspacePath = input.workspacePath ?? existing.workspacePath;
      existing.complexity = input.complexity ?? existing.complexity;
      existing.nextCheckAt = nowIso;
      existing.updatedAt = nowIso;
      this.write();
      return { ...existing };
    }

    const task: PrReviewFollowupTask = {
      id: `prf_${randomUUID()}`,
      repo: input.repo,
      prNumber: input.prNumber,
      workspacePath: input.workspacePath,
      complexity: input.complexity ?? "simple",
      state: "waiting_review",
      reviewRequestAttempts: 0,
      repairAttempts: 0,
      consecutiveErrors: 0,
      nextCheckAt: nowIso,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.tasks.push(task);
    this.write();
    return { ...task };
  }

  get(id: string): PrReviewFollowupTask | undefined {
    const task = this.tasks.find((item) => item.id === id);
    return task ? { ...task } : undefined;
  }

  list(): PrReviewFollowupTask[] {
    return this.tasks.map((task) => ({ ...task })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  listDue(now = new Date()): PrReviewFollowupTask[] {
    const nowIso = now.toISOString();
    return this.list().filter(
      (task) => !TERMINAL_FOLLOWUP_STATES.has(task.state) && task.nextCheckAt <= nowIso,
    );
  }

  save(task: PrReviewFollowupTask): PrReviewFollowupTask {
    const index = this.tasks.findIndex((item) => item.id === task.id);
    if (index < 0) throw new Error(`PR follow-up task not found: ${task.id}`);
    this.tasks[index] = { ...task };
    this.write();
    return { ...task };
  }

  private recoverInterruptedTasks(): void {
    let changed = false;
    const nowIso = new Date().toISOString();
    for (const task of this.tasks) {
      if (task.state !== "repairing") continue;
      task.state = "waiting_review";
      task.nextCheckAt = nowIso;
      task.updatedAt = nowIso;
      task.lastError = "服务在 Agent 修复期间重启，已按 GitHub 当前 head 重新检查。";
      changed = true;
    }
    if (changed) this.write();
  }

  private read(): PrReviewFollowupTask[] {
    if (!existsSync(this.filePath)) return [];
    const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
    if (!Array.isArray(parsed)) throw new Error(`Invalid PR follow-up store: ${this.filePath}`);
    return parsed as PrReviewFollowupTask[];
  }

  private write(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(this.tasks, null, 2)}\n`, "utf8");
    renameSync(tempPath, this.filePath);
  }
}
