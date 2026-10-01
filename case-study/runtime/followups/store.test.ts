import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PrReviewFollowupStore } from "./store";
import type { PrReviewFollowupTask } from "./types";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "pr-followups-"));
  tempDirs.push(dir);
  return path.join(dir, "tasks.json");
}

describe("PrReviewFollowupStore", () => {
  it("deduplicates active tasks for the same PR and persists them", () => {
    const file = tempFile();
    const store = new PrReviewFollowupStore(file);
    const first = store.schedule({ repo: "owner/repo", prNumber: 1, complexity: "simple" });
    const second = store.schedule({ repo: "owner/repo", prNumber: 1, complexity: "complex" });
    const third = store.schedule({ repo: "owner/repo", prNumber: 1 });

    expect(second.id).toBe(first.id);
    expect(third.complexity).toBe("complex");
    expect(new PrReviewFollowupStore(file).list()).toHaveLength(1);
  });

  it("recovers an interrupted Agent run as waiting_review", () => {
    const file = tempFile();
    const task: PrReviewFollowupTask = {
      id: "prf_1",
      repo: "owner/repo",
      prNumber: 1,
      complexity: "simple",
      state: "repairing",
      reviewRequestAttempts: 1,
      repairAttempts: 0,
      consecutiveErrors: 0,
      nextCheckAt: "2026-07-31T10:00:00.000Z",
      createdAt: "2026-07-31T10:00:00.000Z",
      updatedAt: "2026-07-31T10:00:00.000Z",
    };
    writeFileSync(file, JSON.stringify([task]));

    const restored = new PrReviewFollowupStore(file).get("prf_1");

    expect(restored?.state).toBe("waiting_review");
    expect(restored?.lastError).toContain("重启");
  });
});
