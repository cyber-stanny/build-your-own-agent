import { describe, expect, it } from "vitest";
import {
  approveFollowupGitPush,
  buildFollowupContextConfig,
  getFollowupAllowedTools,
  parseAgentFollowupOutcome,
} from "./agent";
import type { ToolRegistry } from "../tools/registry";

describe("background follow-up approval", () => {
  it("inherits the configured context strategy and pruning batch", () => {
    expect(
      buildFollowupContextConfig({
        contextStrategy: "legacy-window",
        recentTurns: 12,
        contextPruneBatchUserTurns: 3,
        maxToolResultChars: 4_000,
        maxContextTokens: 80_000,
      }),
    ).toEqual({
      strategy: "legacy-window",
      recentTurns: 12,
      pruneBatchUserTurns: 3,
      maxToolResultChars: 4_000,
      maxContextTokens: 80_000,
    });
  });

  it("only approves a standalone non-main git push", async () => {
    await expect(
      approveFollowupGitPush(
        {
          tool: "runShell",
          input: { command: "git -C agent-learning-taste push origin HEAD:refs/heads/agent/fix" },
        },
        "agent-learning-taste",
        "agent/fix",
      ),
    ).resolves.toBe(true);
    await expect(
      approveFollowupGitPush(
        { tool: "runShell", input: { command: "git push origin feature && npm test" } },
        "agent-learning-taste",
        "agent/fix",
      ),
    ).resolves.toBe(false);
    await expect(
      approveFollowupGitPush(
        { tool: "runShell", input: { command: "git push origin main" } },
        "agent-learning-taste",
        "agent/fix",
      ),
    ).resolves.toBe(false);
    await expect(
      approveFollowupGitPush(
        { tool: "deployMain", input: { mode: "prepare" } },
        "agent-learning-taste",
        "agent/fix",
      ),
    ).resolves.toBe(false);
  });

  it("does not expose deployment or unrestricted process-launch tools", () => {
    const registry = {
      list: () => ["readFile", "runShell", "startProcess", "deployMain", "schedulePrReviewFollowup"].map((name) => ({ name })),
    } as unknown as ToolRegistry;

    expect(getFollowupAllowedTools(registry)).toEqual(["readFile", "runShell"]);
  });
});

describe("parseAgentFollowupOutcome", () => {
  it("accepts plain or fenced JSON and fails closed", () => {
    expect(parseAgentFollowupOutcome('{"status":"fixed","summary":"done"}')).toEqual({
      status: "fixed",
      summary: "done",
    });
    expect(parseAgentFollowupOutcome('```json\n{"status":"skipped","summary":"P2 only"}\n```')).toMatchObject({
      status: "skipped",
    });
    expect(parseAgentFollowupOutcome("done").status).toBe("blocked");
  });
});
