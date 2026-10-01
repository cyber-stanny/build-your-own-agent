import { describe, expect, it } from "vitest";
import { buildShellSpawn, validateShellSandbox } from "./sandbox";

describe("buildShellSpawn", () => {
  it("runs normal shell commands without sandbox wrapping", () => {
    const spec = buildShellSpawn("printf ok", "/tmp/project", "off");

    expect(spec).toMatchObject({
      file: "printf ok",
      args: [],
      cwd: "/tmp/project",
      shell: true,
    });
  });

  it("wraps shell commands in a readonly-root bubblewrap sandbox", () => {
    const spec = buildShellSpawn("printf ok", "/tmp/project", "readonly-root");

    expect(spec.file).toBe("bwrap");
    expect(spec.shell).toBe(false);
    expect(spec.args).toContain("--ro-bind");
    expect(spec.args).toContain("--bind");
    expect(spec.args).toContain("/tmp/project");
    expect(spec.args.slice(-3)).toEqual(["/bin/sh", "-lc", "printf ok"]);
  });
});

describe("validateShellSandbox", () => {
  it("accepts the default off mode everywhere", () => {
    expect(validateShellSandbox("off")).toBeNull();
  });
});
