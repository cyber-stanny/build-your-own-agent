import { describe, expect, it } from "vitest";
import { GhReviewGithub, extractSeverity } from "./github";

describe("GhReviewGithub", () => {
  it("only returns official Codex findings attached to the current head and latest review", async () => {
    const runner = async (args: string[]) => {
      const endpoint = args[1];
      if (endpoint.includes("/reviews")) {
        return JSON.stringify([
          {
            id: 1,
            user: { login: "chatgpt-codex-connector[bot]" },
            commit_id: "old-head",
            submitted_at: "2026-07-31T10:00:00Z",
            body: "old",
          },
          {
            id: 2,
            user: { login: "chatgpt-codex-connector[bot]" },
            commit_id: "new-head",
            submitted_at: "2026-07-31T10:01:00Z",
            body: "reviewed",
          },
        ]);
      }
      if (endpoint.includes("/comments?")) {
        return JSON.stringify([
          {
            id: 10,
            user: { login: "chatgpt-codex-connector[bot]" },
            pull_request_review_id: 2,
            commit_id: "new-head",
            body: "[P1] normal-path failure",
            path: "runtime/a.ts",
            line: 12,
          },
          {
            id: 11,
            user: { login: "someone" },
            pull_request_review_id: 2,
            commit_id: "new-head",
            body: "[P0] forged",
          },
        ]);
      }
      throw new Error(`unexpected: ${args.join(" ")}`);
    };
    const github = new GhReviewGithub(runner);

    const review = await github.getTrustedReview("owner/repo", 3, "new-head");

    expect(review.completed).toBe(true);
    expect(review.reviewId).toBe(2);
    expect(review.findings).toEqual([
      expect.objectContaining({ severity: "P1", path: "runtime/a.ts", line: 12 }),
    ]);
  });

  it("treats an official +1 reaction as clean but not eyes", async () => {
    const positive = new GhReviewGithub(async () =>
      JSON.stringify([
        { content: "eyes", user: { login: "chatgpt-codex-connector[bot]" } },
        { content: "+1", user: { login: "chatgpt-codex-connector[bot]" } },
      ]),
    );
    const eyesOnly = new GhReviewGithub(async () =>
      JSON.stringify([{ content: "eyes", user: { login: "chatgpt-codex-connector[bot]" } }]),
    );

    await expect(positive.hasCleanReaction("owner/repo", 1)).resolves.toBe(true);
    await expect(eyesOnly.hasCleanReaction("owner/repo", 1)).resolves.toBe(false);
  });

  it("classifies check runs without requiring every optional check to say success", async () => {
    const github = new GhReviewGithub(async () =>
      JSON.stringify({
        check_runs: [
          { name: "Runtime", status: "completed", conclusion: "success" },
          { name: "Optional", status: "completed", conclusion: "skipped" },
        ],
      }),
    );

    await expect(github.getChecks("owner/repo", "head")).resolves.toMatchObject({ status: "success" });
  });
});

describe("extractSeverity", () => {
  it.each([
    ["[P0] stop", "P0"],
    ["![P1 Badge](https://example.com) normal path", "P1"],
    ["P1 normal path", "P1"],
    ["Finding (P2): improve", "P2"],
    ["建议优化", undefined],
  ])("extracts %s", (body, expected) => {
    expect(extractSeverity(body)).toBe(expected);
  });
});
