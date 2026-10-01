import { describe, expect, it } from "vitest";
import { looksLikeLongRunningCommand, runShell } from "./shell";

describe("looksLikeLongRunningCommand", () => {
  it("detects common dev server commands", () => {
    expect(looksLikeLongRunningCommand("npm run dev")?.reason).toBe("前端开发服务器");
    expect(looksLikeLongRunningCommand("cd app && npx vite --host 0.0.0.0 2>&1")?.reason).toBe("Vite 开发服务器");
    expect(looksLikeLongRunningCommand("python3 -m http.server 8000")?.reason).toBe("Python 静态 HTTP 服务");
  });

  it("detects wrapped dev server commands", () => {
    expect(looksLikeLongRunningCommand("nohup npx vite --port 5174 > /tmp/vite.log 2>&1 &")?.reason).toBe(
      "Vite 开发服务器",
    );
    expect(looksLikeLongRunningCommand("screen -dmS test-web bash -c 'cd app && npx vite --port 5174'")?.reason).toBe(
      "Vite 开发服务器",
    );
  });

  it("does not flag short commands or help/build variants", () => {
    expect(looksLikeLongRunningCommand("npm install")).toBeNull();
    expect(looksLikeLongRunningCommand("npm run build")).toBeNull();
    expect(looksLikeLongRunningCommand("npx vite --help")).toBeNull();
    expect(looksLikeLongRunningCommand("npx vite build")).toBeNull();
  });
});

describe("runShell", () => {
  it("rejects long-running commands before executing them", async () => {
    const result = await runShell.run({ command: "npm run dev" }, { workingDir: process.cwd() });

    expect(result).toContain("exit_code: -1");
    expect(result).toContain("长期进程");
    expect(result).toContain("不适合用 runShell 执行");
  });

  it("still runs bounded shell commands", async () => {
    const result = await runShell.run({ command: "printf ok" }, { workingDir: process.cwd() });

    expect(result).toBe("exit_code: 0\nstdout:\nok");
  });

  it("refuses readonly-root sandbox when the host cannot provide it", async () => {
    const result = await runShell.run(
      { command: "printf ok" },
      { workingDir: process.cwd(), shellSandbox: "readonly-root" },
    );

    if (process.platform !== "linux") {
      expect(result).toContain("只能在 Linux 上使用");
    } else {
      expect(result === "exit_code: 0\nstdout:\nok" || result.includes("需要先安装 bubblewrap")).toBe(true);
    }
  });
});
