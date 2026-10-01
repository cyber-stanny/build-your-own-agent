import { describe, expect, it } from "vitest";
import { runCommand } from "./exec";

describe("runCommand", () => {
  it("captures stdout for a completed command", async () => {
    const result = await runCommand("printf hello", process.cwd());

    expect(result).toEqual({ exitCode: 0, stdout: "hello", stderr: "" });
  });

  it("returns after timeout and reports the timeout", async () => {
    const started = Date.now();
    const result = await runCommand("sleep 10", process.cwd(), 100);

    expect(Date.now() - started).toBeLessThan(1_500);
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain("Command timed out after 100ms");
  });
});
