import { describe, expect, it } from "vitest";
import { checkToolCall } from "./permissions";

describe("checkToolCall", () => {
  it("allows deploy prepare but requires approval for reload-only", () => {
    expect(checkToolCall("deployMain", { mode: "prepare" })).toMatchObject({ decision: "allow" });
    expect(checkToolCall("deployMain", { mode: "reload-only" })).toMatchObject({
      decision: "require_approval",
      reason: "确认执行 PM2 reload",
    });
  });

  it("allows git push with or without a -C working directory", () => {
    expect(checkToolCall("runShell", { command: "git push" }).decision).toBe("allow");
    expect(
      checkToolCall("runShell", {
        command: "git -C agent-learning-taste push origin HEAD:refs/heads/agent/fix",
      }).decision,
    ).toBe("allow");
  });

  it.each(["gh pr merge 12", "gh pr close 12", "pm2 reload agent-runtime", "scripts/deploy-server.sh"])(
    "requires approval for release-side command: %s",
    (command) => {
      expect(checkToolCall("runShell", { command }).decision).toBe("require_approval");
    },
  );
});
