import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

const tempDirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) await stopChild(child);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("WebSocket server session lifecycle", () => {
  it("withholds session data before auth and shares one session across connections", async () => {
    const port = await getFreePort();
    const dir = mkdtempSync(path.join(tmpdir(), "agent-server-integration-"));
    tempDirs.push(dir);
    const child = startServer(port, dir);
    children.push(child);
    await waitForOutput(child, "agent ws server:");

    const first = await connect(port);
    const firstHello = await first.messages.waitFor("hello");
    expect(firstHello).toMatchObject({ authRequired: true, allowMock: true });
    expect(first.messages.items.some((message) => message.type === "ready")).toBe(false);

    first.ws.send(JSON.stringify({ type: "command", command: "/sessions" }));
    expect(await first.messages.waitFor("auth_required")).toMatchObject({ reason: "请先完成认证" });

    first.ws.send(JSON.stringify({ type: "auth", mode: "mock" }));
    expect(await first.messages.waitFor("auth_ok")).toMatchObject({ model: "mock" });
    const firstReady = await first.messages.waitFor("ready");
    const sessionId = (firstReady.session as { id: string }).id;
    expect(firstReady.events).toEqual([]);

    const second = await connect(port);
    await second.messages.waitFor("hello");
    second.ws.send(JSON.stringify({ type: "auth", mode: "mock" }));
    await second.messages.waitFor("auth_ok");
    const secondReady = await second.messages.waitFor("ready");
    expect((secondReady.session as { id: string }).id).toBe(sessionId);

    first.ws.send(JSON.stringify({ type: "task", task: "执行 mock 任务" }));
    await first.messages.waitFor("user_message");
    first.ws.close();

    const finalAnswer = await second.messages.waitFor("final_answer", 10_000);
    expect(finalAnswer.content).toContain("完成");
    await waitForCondition(
      () => second.messages.items.some((message) => message.type === "run_state" && message.run?.status === "completed"),
      5_000,
    );
    expect(second.messages.items.some((message) => message.type === "run_state" && message.run?.status === "completed")).toBe(true);
    second.ws.close();
  }, 20_000);
});

function startServer(port: number, dir: string): ChildProcess {
  const runtimeDir = path.resolve(".");
  return spawn(
    process.execPath,
    [path.join(runtimeDir, "node_modules/tsx/dist/cli.mjs"), path.join(runtimeDir, "apps/server.ts")],
    {
      cwd: dir,
      env: {
        ...process.env,
        PORT: String(port),
        WEB_PASSWORD: "",
        AUTH_SECRET: "",
        DEEPSEEK_API_KEY: "",
        DEEPSEEK_DEBUG_LOG: "false",
        PR_REVIEW_FOLLOWUP_ENABLED: "false",
        AGENT_CWD: path.join(dir, "workspace"),
        MEMORY_FILE: path.join(dir, "memory.json"),
        SESSION_DB_FILE: path.join(dir, "sessions.db"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

async function connect(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages = new MessageCollector(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return { ws, messages };
}

class MessageCollector {
  readonly items: Array<Record<string, any>> = [];
  private listeners = new Set<() => void>();

  constructor(ws: WebSocket) {
    ws.on("message", (raw) => {
      this.items.push(JSON.parse(raw.toString()) as Record<string, any>);
      for (const listener of this.listeners) listener();
    });
  }

  async waitFor(type: string, timeoutMs = 5_000): Promise<Record<string, any>> {
    const existing = this.items.find((message) => message.type === type);
    if (existing) return existing;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(check);
        reject(new Error(`Timed out waiting for ${type}. Seen: ${this.items.map((item) => item.type).join(", ")}`));
      }, timeoutMs);
      const check = () => {
        const message = this.items.find((item) => item.type === type);
        if (!message) return;
        clearTimeout(timer);
        this.listeners.delete(check);
        resolve(message);
      };
      this.listeners.add(check);
    });
  }
}

async function getFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitForOutput(child: ChildProcess, needle: string): Promise<void> {
  let output = "";
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Server did not start. Output: ${output}`)), 10_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (!output.includes(needle)) return;
      clearTimeout(timeout);
      resolve();
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Server exited early with ${code}. Output: ${output}`));
    });
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) =>
      setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2_000),
    ),
  ]);
}

async function waitForCondition(check: () => boolean, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
