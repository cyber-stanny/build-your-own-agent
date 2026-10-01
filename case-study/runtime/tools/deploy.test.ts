import { describe, expect, it } from "vitest";
import { createDeployMainTool } from "./deploy";
import { ToolRegistry } from "./registry";

describe("deployMain tool", () => {
  it("runs the fixed prepare deployment script in the production directory", async () => {
    const calls: Array<{ command: string; cwd: string; timeoutMs: number }> = [];
    const tool = createDeployMainTool(async (command, cwd, timeoutMs) => {
      calls.push({ command, cwd, timeoutMs });
      return { exitCode: 0, stdout: "prepared", stderr: "" };
    });

    const result = await tool.run({ mode: "prepare" }, { workingDir: "/tmp/ignored" });

    expect(calls).toEqual([
      { command: "scripts/deploy-server.sh", cwd: "/srv/agent-runtime", timeoutMs: 600_000 },
    ]);
    expect(result).toContain("mode: prepare");
    expect(result).toContain("prepared");
  });

  it("schedules the fixed reload command in the background for reload-only mode", async () => {
    const calls: Array<{ command: string; cwd: string; timeoutMs: number }> = [];
    const tool = createDeployMainTool(async (command, cwd, timeoutMs) => {
      calls.push({ command, cwd, timeoutMs });
      return { exitCode: 0, stdout: "PM2 reload 已在后台排队执行", stderr: "" };
    });

    const result = await tool.run({ mode: "reload-only" }, { workingDir: "/tmp/ignored" });

    expect(calls).toHaveLength(1);
    expect(calls[0].cwd).toBe("/srv/agent-runtime");
    expect(calls[0].timeoutMs).toBe(60_000);
    expect(calls[0].command).toContain("scripts/deploy-server.sh --reload-only");
    expect(calls[0].command).toContain("nohup");
    expect(result).toContain("mode: reload-only");
    expect(result).toContain("后台排队执行");
  });

  it("emits a DeepSeek-compatible schema", () => {
    const registry = new ToolRegistry().register(createDeployMainTool());
    const schema = registry.toSchemas().find((item) => item.name === "deployMain")?.inputSchema;

    expect(schema).toMatchObject({
      type: "object",
      properties: {
        mode: { type: "string", enum: ["prepare", "reload-only"] },
      },
    });
  });
});
