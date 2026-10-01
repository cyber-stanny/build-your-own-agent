import { randomUUID } from "node:crypto";
import path from "node:path";
import { compactMessages } from "../commands/compact";
import { ConsoleSink, EventBus, JsonlSink, type EventSink, type TimestampedEvent } from "../core/events";
import { repairInterruptedToolCalls, runTurn, type ApprovalRequest, type RunDeps } from "../core/loop";
import type { ModelClient } from "../model/types";
import type { ToolRegistry } from "../tools/registry";
import { createSession, type Session } from "./session";
import {
  SessionStore,
  type PendingApprovalSnapshot,
  type SessionMeta,
  type SessionRunKind,
  type SessionRunStatus,
  type StoredSessionRun,
  type StoredSessionState,
} from "./store";

export type SessionSnapshot = {
  session: SessionMeta;
  events: TimestampedEvent[];
  run?: StoredSessionRun;
  pendingApproval?: PendingApprovalSnapshot;
  lastEventSeq: number;
};

export type StartedSessionRun = {
  run: StoredSessionRun;
  done: Promise<void>;
};

type PendingApprovalRuntime = PendingApprovalSnapshot & {
  resolve: (allowed: boolean) => void;
};

type RunRuntime = {
  snapshot: StoredSessionRun;
  controller: AbortController;
  cancellable: boolean;
  pendingApproval?: PendingApprovalRuntime;
  done: Promise<void>;
};

type SessionRuntime = {
  meta: SessionMeta;
  session: Session;
  events: EventBus;
  currentRun?: RunRuntime;
  attachments: Set<string>;
  lastAccessAt: number;
};

export type SessionRuntimeStoreOptions = {
  sessionStore: SessionStore;
  registry: ToolRegistry;
  systemPrompt: string;
  workingDir: string;
  shellSandbox?: RunDeps["config"]["shellSandbox"];
  maxTurns: number;
  context: RunDeps["config"]["context"];
  memoryContext?: () => string;
  compactKeepRecentUserTurns: number;
  runExclusive: <T>(task: () => Promise<T>) => Promise<T>;
  broadcastEvent?: (sessionId: string, event: TimestampedEvent) => void;
  broadcastRunState?: (sessionId: string, run: StoredSessionRun) => void;
  onMetaChanged?: (meta: SessionMeta) => void;
  now?: () => Date;
  runLogDir?: string;
  consoleEvents?: boolean;
};

export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`session not found: ${sessionId}`);
    this.name = "SessionNotFoundError";
  }
}

export class SessionBusyError extends Error {
  constructor(readonly run: StoredSessionRun) {
    super(`session is busy: ${run.sessionId} (${run.status})`);
    this.name = "SessionBusyError";
  }
}

class SessionPersistenceSink implements EventSink {
  constructor(
    private sessionId: string,
    private store: SessionStore,
    private currentRunId: () => string | undefined,
    private broadcast?: (sessionId: string, event: TimestampedEvent) => void,
  ) {}

  handle(event: TimestampedEvent): void {
    const enriched: TimestampedEvent = {
      ...event,
      sessionId: this.sessionId,
      runId: this.currentRunId(),
    };
    const seq = this.store.appendEvent(this.sessionId, enriched);
    this.broadcast?.(this.sessionId, { ...enriched, seq });
  }
}

export class SessionRuntimeStore {
  private runtimes = new Map<string, SessionRuntime>();

  constructor(private options: SessionRuntimeStoreOptions) {}

  listMetas(): SessionMeta[] {
    return this.options.sessionStore.listMeta();
  }

  createSession(): SessionMeta {
    const id = `sess_${this.now().getTime()}_${randomUUID().slice(0, 6)}`;
    const now = this.nowIso();
    const state: StoredSessionState = {
      meta: {
        id,
        title: "新对话",
        createdAt: now,
        updatedAt: now,
        messageCount: 0,
      },
      messages: createSession(id, this.options.systemPrompt).messages,
    };
    this.options.sessionStore.create({ ...state, timeline: [] });
    const runtime = this.createRuntime(state);
    this.runtimes.set(id, runtime);
    return { ...runtime.meta };
  }

  attach(sessionId: string, connectionId: string): SessionSnapshot {
    const runtime = this.getOrLoad(sessionId);
    runtime.attachments.add(connectionId);
    this.touch(runtime);
    return this.snapshotOf(runtime);
  }

  detach(sessionId: string, connectionId: string): void {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return;
    runtime.attachments.delete(connectionId);
    this.touch(runtime);
  }

  snapshot(sessionId: string): SessionSnapshot {
    const runtime = this.getOrLoad(sessionId);
    this.touch(runtime);
    return this.snapshotOf(runtime);
  }

  startAgentRun(sessionId: string, input: string, model: ModelClient): StartedSessionRun {
    const runtime = this.getAvailableRuntime(sessionId);
    const trimmed = input.trim();
    if (!trimmed) throw new Error("task input is empty");

    if (runtime.meta.title === "新对话") runtime.meta.title = inferSessionTitle(trimmed);
    runtime.meta.updatedAt = this.nowIso();
    runtime.meta.messageCount += 1;
    this.persistMeta(runtime);

    return this.startManagedRun(runtime, "task", trimmed, true, async (run) => {
      const runDeps: RunDeps = {
        model,
        registry: this.options.registry,
        events: runtime.events,
        config: {
          maxTurns: this.options.maxTurns,
          workingDir: this.options.workingDir,
          shellSandbox: this.options.shellSandbox,
          context: this.options.context,
          memoryContext: this.options.memoryContext,
          signal: run.controller.signal,
        },
        approve: (request) => this.waitForApproval(runtime, run, request),
        checkpoint: (changedSession) =>
          this.options.sessionStore.saveMessages(runtime.meta.id, changedSession.messages),
      };
      await runTurn(runtime.session, trimmed, runDeps);
    });
  }

  startCompact(sessionId: string, model: ModelClient): StartedSessionRun {
    const runtime = this.getAvailableRuntime(sessionId);
    return this.startManagedRun(runtime, "compact", undefined, false, async () => {
      runtime.events.log({ type: "command_result", command: "/compact", content: "开始压缩当前对话历史..." });
      const result = await compactMessages(runtime.session.messages, model, {
        keepRecentUserTurns: this.options.compactKeepRecentUserTurns,
      });
      this.options.sessionStore.saveMessages(runtime.meta.id, runtime.session.messages);
      runtime.events.log({
        type: "command_result",
        command: "/compact",
        content: `压缩完成：messages ${result.beforeMessages}→${result.afterMessages}，粗估 tokens ${result.beforeTokens}→${result.afterTokens}`,
      });
    });
  }

  cancel(sessionId: string): boolean {
    const runtime = this.runtimes.get(sessionId);
    const run = runtime?.currentRun;
    if (!runtime || !run || !run.cancellable) return false;

    run.controller.abort();
    if (run.snapshot.status === "queued") {
      this.transitionRun(runtime, run, "cancelled");
      if (runtime.currentRun === run) runtime.currentRun = undefined;
      this.touch(runtime);
      return true;
    }
    if (run.pendingApproval) this.settleApproval(runtime, run, false);
    return true;
  }

  resolveApproval(sessionId: string, approvalId: string, allowed: boolean): boolean {
    const runtime = this.runtimes.get(sessionId);
    const run = runtime?.currentRun;
    if (!runtime || !run || run.pendingApproval?.id !== approvalId) return false;
    this.settleApproval(runtime, run, allowed);
    return true;
  }

  evictIdle(idleTtlMs: number): string[] {
    const cutoff = this.now().getTime() - Math.max(0, idleTtlMs);
    const evicted: string[] = [];
    for (const [sessionId, runtime] of this.runtimes) {
      if (runtime.attachments.size > 0 || runtime.currentRun || runtime.lastAccessAt > cutoff) continue;
      runtime.events.close();
      this.runtimes.delete(sessionId);
      evicted.push(sessionId);
    }
    return evicted;
  }

  recoverInterruptedRuns(): number {
    const now = this.nowIso();
    const interrupted = this.options.sessionStore.interruptIncompleteRuns(now);
    for (const run of interrupted) {
      const state = this.options.sessionStore.getState(run.sessionId);
      if (!state) continue;

      const repaired = repairInterruptedToolCalls(state.messages);
      if (repaired.length > 0) {
        this.options.sessionStore.saveMessages(run.sessionId, state.messages);
        for (const item of repaired) {
          this.options.sessionStore.appendEvent(run.sessionId, {
            ts: now,
            type: "tool_result",
            id: item.toolCallId,
            content: item.content,
            sessionId: run.sessionId,
            runId: run.id,
          });
        }
      }

      const input = run.input ? `：${run.input.slice(0, 120)}` : "";
      this.options.sessionStore.appendEvent(run.sessionId, {
        ts: now,
        type: "run_interrupted",
        content: `上次运行因服务进程重启中断${input}。可以继续发送消息恢复现场。`,
        sessionId: run.sessionId,
        runId: run.id,
      });
    }
    return interrupted.length;
  }

  close(): void {
    for (const runtime of this.runtimes.values()) runtime.events.close();
    this.runtimes.clear();
  }

  get activeRuntimeCount(): number {
    return this.runtimes.size;
  }

  private getAvailableRuntime(sessionId: string): SessionRuntime {
    const runtime = this.getOrLoad(sessionId);
    if (runtime.currentRun) throw new SessionBusyError(this.cloneRun(runtime.currentRun.snapshot));
    return runtime;
  }

  private getOrLoad(sessionId: string): SessionRuntime {
    const loaded = this.runtimes.get(sessionId);
    if (loaded) return loaded;

    const stored = this.options.sessionStore.getState(sessionId);
    if (!stored) throw new SessionNotFoundError(sessionId);
    const runtime = this.createRuntime(stored);
    this.runtimes.set(sessionId, runtime);
    return runtime;
  }

  private createRuntime(stored: StoredSessionState): SessionRuntime {
    const session = createSession(stored.meta.id, this.options.systemPrompt);
    session.messages.splice(0, session.messages.length, ...stored.messages);
    let runtime: SessionRuntime;
    const events = new EventBus().use(
      new SessionPersistenceSink(
        stored.meta.id,
        this.options.sessionStore,
        () => runtime?.currentRun?.snapshot.id,
        this.options.broadcastEvent,
      ),
    );
    if (this.options.consoleEvents !== false) events.use(new ConsoleSink());
    events.use(new JsonlSink(path.join(this.options.runLogDir ?? "runs", `${stored.meta.id}.jsonl`)));

    runtime = {
      meta: { ...stored.meta },
      session,
      events,
      attachments: new Set(),
      lastAccessAt: this.now().getTime(),
    };
    return runtime;
  }

  private startManagedRun(
    runtime: SessionRuntime,
    kind: SessionRunKind,
    input: string | undefined,
    cancellable: boolean,
    execute: (run: RunRuntime) => Promise<void>,
  ): StartedSessionRun {
    const now = this.nowIso();
    const snapshot: StoredSessionRun = {
      id: `run_${this.now().getTime()}_${randomUUID().slice(0, 6)}`,
      sessionId: runtime.meta.id,
      kind,
      status: "queued",
      input,
      startedAt: now,
      updatedAt: now,
    };
    const run: RunRuntime = {
      snapshot,
      controller: new AbortController(),
      cancellable,
      done: Promise.resolve(),
    };
    runtime.currentRun = run;
    this.options.sessionStore.createRun(snapshot);
    this.broadcastRun(runtime, run);

    run.done = this.options
      .runExclusive(async () => {
        if (run.controller.signal.aborted && run.snapshot.status === "cancelled") return;
        this.transitionRun(runtime, run, "running");
        await execute(run);
        this.transitionRun(runtime, run, run.controller.signal.aborted ? "cancelled" : "completed");
      })
      .catch((error: unknown) => {
        if (run.controller.signal.aborted || (error as Error).name === "AbortError") {
          this.transitionRun(runtime, run, "cancelled");
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        runtime.events.log({ type: "error", content: message });
        this.transitionRun(runtime, run, "failed", message);
      })
      .finally(() => {
        if (runtime.currentRun === run) runtime.currentRun = undefined;
        runtime.meta.updatedAt = this.nowIso();
        this.persistMeta(runtime);
        this.touch(runtime);
      });

    return { run: this.cloneRun(snapshot), done: run.done };
  }

  private waitForApproval(
    runtime: SessionRuntime,
    run: RunRuntime,
    request: ApprovalRequest,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const pending: PendingApprovalRuntime = {
        id: `appr_${this.now().getTime()}_${randomUUID().slice(0, 6)}`,
        tool: request.tool,
        input: request.input,
        reason: request.reason,
        requestedAt: this.nowIso(),
        resolve,
      };
      run.pendingApproval = pending;
      run.snapshot.pendingApproval = this.approvalSnapshot(pending);
      this.transitionRun(runtime, run, "waiting_approval");
      runtime.events.log({
        type: "approval_request",
        id: pending.id,
        tool: pending.tool,
        input: pending.input,
        reason: pending.reason,
      });
    });
  }

  private settleApproval(runtime: SessionRuntime, run: RunRuntime, allowed: boolean): void {
    const pending = run.pendingApproval;
    if (!pending) return;
    run.pendingApproval = undefined;
    run.snapshot.pendingApproval = undefined;
    if (!run.controller.signal.aborted) this.transitionRun(runtime, run, "running");
    else {
      run.snapshot.updatedAt = this.nowIso();
      this.options.sessionStore.updateRun(run.snapshot);
      this.broadcastRun(runtime, run);
    }
    runtime.events.log({
      type: "approval_resolved",
      id: pending.id,
      decision: allowed ? "allow" : "deny",
    });
    pending.resolve(allowed);
  }

  private transitionRun(
    runtime: SessionRuntime,
    run: RunRuntime,
    status: SessionRunStatus,
    error?: string,
  ): void {
    run.snapshot.status = status;
    run.snapshot.updatedAt = this.nowIso();
    run.snapshot.error = error;
    if (isTerminal(status)) {
      run.snapshot.finishedAt = run.snapshot.updatedAt;
      run.snapshot.pendingApproval = undefined;
      run.pendingApproval = undefined;
    }
    this.options.sessionStore.updateRun(run.snapshot);
    this.broadcastRun(runtime, run);
  }

  private broadcastRun(runtime: SessionRuntime, run: RunRuntime): void {
    this.options.broadcastRunState?.(runtime.meta.id, this.cloneRun(run.snapshot));
  }

  private persistMeta(runtime: SessionRuntime): void {
    this.options.sessionStore.updateMeta(runtime.meta);
    this.options.onMetaChanged?.({ ...runtime.meta });
  }

  private snapshotOf(runtime: SessionRuntime): SessionSnapshot {
    const events = this.options.sessionStore.getTimeline(runtime.meta.id);
    const run = runtime.currentRun ? this.cloneRun(runtime.currentRun.snapshot) : undefined;
    return {
      session: { ...runtime.meta },
      events,
      run,
      pendingApproval: run?.pendingApproval,
      lastEventSeq: events.at(-1)?.seq ?? 0,
    };
  }

  private cloneRun(run: StoredSessionRun): StoredSessionRun {
    return {
      ...run,
      pendingApproval: run.pendingApproval ? { ...run.pendingApproval } : undefined,
    };
  }

  private approvalSnapshot(pending: PendingApprovalRuntime): PendingApprovalSnapshot {
    return {
      id: pending.id,
      tool: pending.tool,
      input: pending.input,
      reason: pending.reason,
      requestedAt: pending.requestedAt,
    };
  }

  private touch(runtime: SessionRuntime): void {
    runtime.lastAccessAt = this.now().getTime();
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}

function isTerminal(status: SessionRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted";
}

function inferSessionTitle(input: string): string {
  const title = input.replace(/\s+/g, " ").trim().slice(0, 24);
  return title || "新对话";
}
