import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReviewGithub } from "./github";
import { PrReviewFollowupService, type FollowupAgent } from "./service";
import { PrReviewFollowupStore } from "./store";
import type { CheckSnapshot, PullRequestSnapshot, TrustedReview } from "./types";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

class FakeGithub implements ReviewGithub {
  pullRequest: PullRequestSnapshot = {
    state: "open",
    merged: false,
    headOid: "head-1",
    headRefName: "agent/fix",
    headRepository: "owner/repo",
    url: "https://github.com/owner/repo/pull/1",
  };
  review: TrustedReview = { completed: false, findings: [] };
  checks: CheckSnapshot = { status: "pending", summary: "pending" };
  cleanReaction = false;
  reviewRequests = 0;

  async getPullRequest(): Promise<PullRequestSnapshot> {
    return { ...this.pullRequest };
  }
  async getTrustedReview(): Promise<TrustedReview> {
    return { ...this.review, findings: this.review.findings.map((finding) => ({ ...finding })) };
  }
  async requestReview(): Promise<number> {
    this.reviewRequests += 1;
    return 100 + this.reviewRequests;
  }
  async hasCleanReaction(): Promise<boolean> {
    return this.cleanReaction;
  }
  async getChecks(): Promise<CheckSnapshot> {
    return { ...this.checks };
  }
}

function setup(complexity: "simple" | "complex" = "simple") {
  const dir = mkdtempSync(path.join(tmpdir(), "pr-followup-service-"));
  tempDirs.push(dir);
  const store = new PrReviewFollowupStore(path.join(dir, "tasks.json"));
  const task = store.schedule({ repo: "owner/repo", prNumber: 1, complexity });
  const github = new FakeGithub();
  const now = new Date("2026-07-31T12:00:00.000Z");
  return { store, task, github, now };
}

function createService(
  store: PrReviewFollowupStore,
  github: FakeGithub,
  agent: FollowupAgent = vi.fn(async () => ({ status: "blocked" as const, summary: "not configured" })),
  now = new Date("2026-07-31T12:00:00.000Z"),
  runExclusive?: <T>(task: () => Promise<T>) => Promise<T>,
) {
  return new PrReviewFollowupService(
    store,
    github,
    agent,
    { pollIntervalMs: 60_000, reviewTimeoutMs: 20 * 60_000, ciTimeoutMs: 30 * 60_000, runExclusive },
    undefined,
    () => now,
  );
}

describe("PrReviewFollowupService", () => {
  it("requests Codex once for a head that has no completed review", async () => {
    const { store, task, github, now } = setup();
    const service = createService(store, github, undefined, now);

    await service.process(task.id);
    await service.process(task.id);

    expect(github.reviewRequests).toBe(1);
    expect(store.get(task.id)).toMatchObject({
      state: "waiting_review",
      currentHeadOid: "head-1",
      reviewRequestAttempts: 1,
    });
  });

  it("runs the existing Agent for P1 and confirms a real push through the new PR head", async () => {
    const { store, task, github, now } = setup();
    github.review = {
      completed: true,
      findings: [{ severity: "P1", body: "normal path breaks" }],
    };
    const agent = vi.fn(async () => {
      github.pullRequest.headOid = "head-2";
      return { status: "fixed" as const, summary: "fixed and pushed" };
    });
    const service = createService(store, github, agent, now);

    await service.process(task.id);

    expect(agent).toHaveBeenCalledOnce();
    expect(store.get(task.id)).toMatchObject({
      state: "waiting_review",
      currentHeadOid: "head-2",
      repairAttempts: 1,
      reviewRequestAttempts: 0,
    });
  });

  it("reads the PR head only after entering the shared workspace queue", async () => {
    const { store, task, github, now } = setup();
    github.review = { completed: true, findings: [{ severity: "P1", body: "normal path breaks" }] };
    let agentHead = "";
    const agent = vi.fn(async (input) => {
      agentHead = input.pullRequest.headOid;
      github.pullRequest.headOid = "head-3";
      return { status: "fixed" as const, summary: "fixed current head" };
    });
    const runExclusive = async <T>(run: () => Promise<T>) => {
      github.pullRequest.headOid = "head-2";
      return run();
    };
    const service = createService(store, github, agent, now, runExclusive);

    await service.process(task.id);

    expect(agentHead).toBe("head-2");
    expect(store.get(task.id)).toMatchObject({ currentHeadOid: "head-3", repairAttempts: 1 });
  });

  it("lets the Agent skip a non-blocking P2 and becomes ready after CI", async () => {
    const { store, task, github, now } = setup();
    github.review = { completed: true, findings: [{ severity: "P2", body: "optional hardening" }] };
    github.checks = { status: "success", summary: "CI passed" };
    const agent = vi.fn(async () => ({ status: "skipped" as const, summary: "not needed for personal v1" }));
    const service = createService(store, github, agent, now);

    await service.process(task.id);
    expect(store.get(task.id)?.state).toBe("waiting_ci");
    await service.process(task.id);

    expect(store.get(task.id)).toMatchObject({ state: "ready", repairAttempts: 0 });
  });

  it("does not ask the Agent to clear P3 findings", async () => {
    const { store, task, github, now } = setup();
    github.review = { completed: true, findings: [{ severity: "P3", body: "nice to have" }] };
    const agent = vi.fn(async () => ({ status: "fixed" as const, summary: "unexpected" }));
    const service = createService(store, github, agent, now);

    await service.process(task.id);

    expect(agent).not.toHaveBeenCalled();
    expect(store.get(task.id)?.state).toBe("waiting_ci");
  });

  it("stops a simple PR after three real repair pushes", async () => {
    const { store, task, github, now } = setup("simple");
    const saved = store.get(task.id)!;
    saved.repairAttempts = 3;
    store.save(saved);
    github.review = { completed: true, findings: [{ severity: "P1", body: "still broken" }] };
    const agent = vi.fn(async () => ({ status: "fixed" as const, summary: "unexpected" }));
    const service = createService(store, github, agent, now);

    await service.process(task.id);

    expect(agent).not.toHaveBeenCalled();
    expect(store.get(task.id)).toMatchObject({ state: "blocked", repairAttempts: 3 });
  });

  it("allows a complex PR to continue after round three while keeping the five-round cap", async () => {
    const { store, task, github, now } = setup("complex");
    const saved = store.get(task.id)!;
    saved.repairAttempts = 3;
    store.save(saved);
    github.review = { completed: true, findings: [{ severity: "P1", body: "one remaining normal-path bug" }] };
    const agent = vi.fn(async () => {
      github.pullRequest.headOid = "head-4";
      return { status: "fixed" as const, summary: "converging" };
    });
    const service = createService(store, github, agent, now);

    await service.process(task.id);

    expect(agent).toHaveBeenCalledOnce();
    expect(store.get(task.id)).toMatchObject({ state: "waiting_review", repairAttempts: 4 });
  });

  it("blocks after two Codex requests each exceed the review timeout", async () => {
    const { store, task, github, now } = setup();
    const saved = store.get(task.id)!;
    saved.currentHeadOid = "head-1";
    saved.reviewRequestHeadOid = "head-1";
    saved.reviewRequestCommentId = 101;
    saved.reviewRequestAttempts = 2;
    saved.reviewRequestedAt = "2026-07-31T11:39:00.000Z";
    store.save(saved);
    const service = createService(store, github, undefined, now);

    await service.process(task.id);

    expect(github.reviewRequests).toBe(0);
    expect(store.get(task.id)?.state).toBe("blocked");
  });

  it("does not accept a fixed result when the PR head did not change", async () => {
    const { store, task, github, now } = setup();
    github.review = { completed: true, findings: [{ severity: "P1", body: "still broken" }] };
    const agent = vi.fn(async () => ({ status: "fixed" as const, summary: "claimed success" }));
    const service = createService(store, github, agent, now);

    await service.process(task.id);

    expect(store.get(task.id)?.state).toBe("blocked");
    expect(store.get(task.id)?.summary).toContain("head 没有变化");
  });
});
