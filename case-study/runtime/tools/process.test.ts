import { describe, expect, it } from "vitest";
import { createProcessTools } from "./process";
import { ToolRegistry } from "./registry";

describe("process tools", () => {
  it("emits a DeepSeek-compatible schema for readProcessLog", () => {
    const registry = new ToolRegistry();
    for (const tool of createProcessTools()) registry.register(tool);
    const schema = registry.toSchemas().find((item) => item.name === "readProcessLog")?.inputSchema;
    const maxChars = (schema?.properties as Record<string, Record<string, unknown>> | undefined)?.maxChars;

    expect(maxChars).toMatchObject({ type: "integer", minimum: 1 });
    expect(maxChars).not.toHaveProperty("exclusiveMinimum");
  });

  it("starts, lists, reads logs, and stops a managed long-running process", async () => {
    const [startProcess, listProcesses, readProcessLog, stopProcess] = createProcessTools();
    const ctx = { workingDir: process.cwd() };
    const started = await startProcess.run(
      { command: "node -e \"console.log('ready'); setInterval(() => {}, 1000)\"", name: "test-process" },
      ctx,
    );
    const id = started.match(/id: (proc_\d+)/)?.[1];
    expect(id).toBeTruthy();
    expect(started).toContain("status: running");

    const listed = await listProcesses.run({}, ctx);
    expect(listed).toContain(id);
    expect(listed).toContain("test-process");

    const logs = await readProcessLog.run({ id: id! }, ctx);
    expect(logs).toContain("ready");

    const stopped = await stopProcess.run({ id: id! }, ctx);
    expect(stopped).toContain("status: stopped");
  });
});
