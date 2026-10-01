import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { TimestampedEvent } from "../core/events";
import type { Message, ModelClient, ModelResponse, ToolSchema } from "../model/types";
import { ToolRegistry } from "../tools/registry";
import type { Tool } from "../tools/types";
import { SessionBusyError, SessionRuntimeStore, type SessionRuntimeStoreOptions } from "./runtime-store";
import { SessionStore, type StoredSessionRun } from "./store";

type ApprovalRequestEvent = Extract<TimestampedEvent, { type: "approval_request" }>;

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

class DeferredModel implements ModelClient {
  name = "deferred";
  private resolveStarted!: () => void;
  private resolveResponse!: (response: ModelResponse) => void;
  readonly started = new Promise<void>((resolve) => {
    this.resolveStarted = resolve;
  });

  async complete(_messages: Message[], _tools: ToolSchema[]): Promise<ModelResponse> {
    this.resolveStarted();
    return new Promise<ModelResponse>((resolve) => {
      this.resolveResponse = resolve;
    });
  }

  finish(response: ModelResponse): void {
    this.resolveResponse(response);
  }
}

class DeferredApprovalModel implements ModelClient {
  name = "deferred-approval";
  private callCount = 0;
  private resolveStarted!: () => void;
  private resolveFirst!: (response: ModelResponse) => void;
  readonly started = new Promise<void>((resolve) => {
    this.resolveStarted = resolve;
  });

  async complete(_messages: Message[], _tools: ToolSchema[]): Promise<ModelResponse> {
    this.callCount++;
    if (this.callCount === 1) {
      this.resolveStarted();
      return new Promise<ModelResponse>((resolve) => {
        this.resolveFirst = resolve;
      });
    }
    return { text: "审批后继续完成。", toolCalls: [] };
  }

  requestApproval(): void {
    this.resolveFirst({
      text: "准备重启服务。",
      toolCalls: [{ id: "call_reload", name: "deployMain", input: { mode: "reload-only" } }],
    });
  }
}

describe("SessionRuntimeStore", () => {
  it("loads only attached sessions and evicts idle completed runtimes", () => {
    const harness = createHarness();
    for (let index = 0; index < 3; index++) createStoredSession(harness.store, `sess_${index}`);

    expect(harness.runtime.activeRuntimeCount).toBe(0);
    expect(harness.runtime.listMetas()).toHaveLength(3);

    harness.runtime.attach("sess_1", "conn_1");
    harness.runtime.attach("sess_1", "conn_2");
    expect(harness.runtime.activeRuntimeCount).toBe(1);

    harness.runtime.detach("sess_1", "conn_1");
    expect(harness.runtime.evictIdle(0)).toEqual([]);
    harness.runtime.detach("sess_1", "conn_2");
    expect(harness.runtime.evictIdle(0)).toEqual(["sess_1"]);
    expect(harness.runtime.activeRuntimeCount).toBe(0);

    harness.runtime.attach("sess_1", "conn_2");
    expect(harness.runtime.activeRuntimeCount).toBe(1);
    harness.close();
  });

  it("keeps a run alive without connections and reattaches to the same runtime", async () => {
    const events: TimestampedEvent[] = [];
    const harness = createHarness({ broadcastEvent: (_sessionId, event) => events.push(event) });
    const session = harness.runtime.createSession();
    harness.runtime.attach(session.id, "conn_old");
    const model = new DeferredModel();

    const started = harness.runtime.startAgentRun(session.id, "继续后台任务", model);
    await model.started;
    harness.runtime.detach(session.id, "conn_old");

    expect(harness.runtime.evictIdle(0)).toEqual([]);
    const resumed = harness.runtime.attach(session.id, "conn_new");
    expect(resumed.run).toMatchObject({ id: started.run.id, status: "running" });

    model.finish({ text: "后台任务完成。", toolCalls: [] });
    await started.done;
    expect(events.some((event) => event.type === "final_answer" && event.content === "后台任务完成。")).toBe(true);
    expect(harness.runtime.snapshot(session.id).run).toBeUndefined();
    harness.close();
  });

  it("cancels a queued run before it reaches the model", async () => {
    const queueGate = deferred<void>();
    let modelCalls = 0;
    const model: ModelClient = {
      name: "counting",
      async complete() {
        modelCalls++;
        return { text: "should not run", toolCalls: [] };
      },
    };
    const harness = createHarness({
      runExclusive: async <T>(task: () => Promise<T>) => {
        await queueGate.promise;
        return task();
      },
    });
    const session = harness.runtime.createSession();

    const started = harness.runtime.startAgentRun(session.id, "queued task", model);
    expect(harness.store.getRun(started.run.id)?.status).toBe("queued");
    expect(harness.runtime.cancel(session.id)).toBe(true);
    expect(harness.runtime.snapshot(session.id).run).toBeUndefined();
    expect(harness.store.getRun(started.run.id)?.status).toBe("cancelled");

    queueGate.resolve(undefined);
    await started.done;
    expect(modelCalls).toBe(0);
    harness.close();
  });

  it("rejects a second run in the same session while the first is active", async () => {
    const harness = createHarness();
    const session = harness.runtime.createSession();
    const model = new DeferredModel();
    const started = harness.runtime.startAgentRun(session.id, "first", model);
    await model.started;

    expect(() => harness.runtime.startAgentRun(session.id, "second", new DeferredModel())).toThrow(SessionBusyError);

    model.finish({ text: "done", toolCalls: [] });
    await started.done;
    harness.close();
  });

  it("restores an approval created after the original connection disconnects", async () => {
    const approvalCreated = deferred<ApprovalRequestEvent>();
    let deployCalls = 0;
    const deployMain: Tool<{ mode: "reload-only" }> = {
      name: "deployMain",
      description: "reload",
      schema: z.object({ mode: z.literal("reload-only") }),
      async run() {
        deployCalls++;
        return "reloaded";
      },
    };
    const harness = createHarness({
      registry: new ToolRegistry().register(deployMain),
      broadcastEvent: (_sessionId, event) => {
        if (event.type === "approval_request") approvalCreated.resolve(event);
      },
    });
    const session = harness.runtime.createSession();
    harness.runtime.attach(session.id, "conn_old");
    const model = new DeferredApprovalModel();

    const started = harness.runtime.startAgentRun(session.id, "重新加载服务", model);
    await model.started;
    harness.runtime.detach(session.id, "conn_old");
    model.requestApproval();

    const approvalEvent = await approvalCreated.promise;
    const resumed = harness.runtime.attach(session.id, "conn_new");
    expect(resumed.run?.status).toBe("waiting_approval");
    expect(resumed.pendingApproval).toMatchObject({ id: approvalEvent.id, tool: "deployMain" });

    expect(harness.runtime.resolveApproval(session.id, approvalEvent.id!, true)).toBe(true);
    await started.done;
    expect(deployCalls).toBe(1);
    expect(harness.store.getRun(started.run.id)?.status).toBe("completed");
    harness.close();
  });

  it("marks persisted in-flight runs interrupted without loading every session", () => {
    const harness = createHarness();
    createStoredSession(harness.store, "sess_interrupted", [
      { role: "system", content: "sys" },
      { role: "user", content: "reload" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_reload", name: "deployMain", input: { mode: "reload-only" } }],
      },
    ]);
    const run: StoredSessionRun = {
      id: "run_interrupted",
      sessionId: "sess_interrupted",
      kind: "task",
      status: "waiting_approval",
      input: "reload",
      startedAt: "2026-08-01T10:00:00.000Z",
      updatedAt: "2026-08-01T10:01:00.000Z",
      pendingApproval: {
        id: "appr_1",
        tool: "deployMain",
        input: { mode: "reload-only" },
        requestedAt: "2026-08-01T10:01:00.000Z",
      },
    };
    harness.store.createRun(run);

    expect(harness.runtime.recoverInterruptedRuns()).toBe(1);
    expect(harness.runtime.activeRuntimeCount).toBe(0);
    expect(harness.store.getRun(run.id)).toMatchObject({ status: "interrupted", pendingApproval: undefined });
    expect(harness.store.get("sess_interrupted")?.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "tool", toolCallId: "call_reload" })]),
    );
    expect(harness.store.getTimeline("sess_interrupted")).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "run_interrupted", runId: run.id })]),
    );
    harness.close();
  });
});

function createHarness(overrides: Partial<SessionRuntimeStoreOptions> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "session-runtime-store-"));
  tempDirs.push(dir);
  mkdirSync(path.join(dir, "workspace"), { recursive: true });
  const store = new SessionStore(path.join(dir, "sessions.db"));
  const runtime = new SessionRuntimeStore({
    registry: new ToolRegistry(),
    systemPrompt: "sys",
    workingDir: path.join(dir, "workspace"),
    maxTurns: 4,
    context: {
      strategy: "cache-first",
      recentTurns: 32,
      pruneBatchUserTurns: 8,
      maxToolResultChars: 1_000,
      maxContextTokens: 4_000,
    },
    compactKeepRecentUserTurns: 2,
    runExclusive: (task) => task(),
    runLogDir: path.join(dir, "runs"),
    consoleEvents: false,
    ...overrides,
    sessionStore: store,
  });
  return {
    store,
    runtime,
    close() {
      runtime.close();
      store.close();
    },
  };
}

function createStoredSession(store: SessionStore, id: string, messages: Message[] = [{ role: "system", content: "sys" }]) {
  const now = "2026-08-01T10:00:00.000Z";
  store.create({
    meta: { id, title: id, createdAt: now, updatedAt: now, messageCount: 0 },
    messages,
    timeline: [],
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
