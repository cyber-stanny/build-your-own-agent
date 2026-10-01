import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { TimestampedEvent } from "../core/events";
import type { Message } from "../model/types";

export type SessionMeta = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
};

export type StoredSession = {
  meta: SessionMeta;
  messages: Message[];
  timeline: TimestampedEvent[];
};

export type StoredSessionState = Omit<StoredSession, "timeline">;

export type SessionRunKind = "task" | "compact";

export type SessionRunStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type PendingApprovalSnapshot = {
  id: string;
  tool: string;
  input: unknown;
  reason?: string;
  requestedAt: string;
};

export type StoredSessionRun = {
  id: string;
  sessionId: string;
  kind: SessionRunKind;
  status: SessionRunStatus;
  input?: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  pendingApproval?: PendingApprovalSnapshot;
  error?: string;
};

type SessionRow = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  messages_json: string;
};

type EventRow = { seq: number; event_json: string };

type RunRow = {
  id: string;
  session_id: string;
  kind: SessionRunKind;
  status: SessionRunStatus;
  input: string | null;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
  pending_approval_json: string | null;
  error: string | null;
};

// SQLite 是 session 的 durable source of truth：
// messages_json 给模型恢复 transcript，session_events 给网页恢复完整 timeline。
export class SessionStore {
  private db: Database.Database;

  constructor(filePath: string) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        message_count INTEGER NOT NULL,
        messages_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        event_json TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_session_events_session
        ON session_events(session_id, seq);
      CREATE TABLE IF NOT EXISTS session_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        input TEXT,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        pending_approval_json TEXT,
        error TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_session_runs_session
        ON session_runs(session_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_session_runs_status
        ON session_runs(status);
    `);
  }

  create(session: StoredSession): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, title, created_at, updated_at, message_count, messages_json)
         VALUES (@id, @title, @createdAt, @updatedAt, @messageCount, @messagesJson)`,
      )
      .run({ ...session.meta, messagesJson: JSON.stringify(session.messages) });
    for (const event of session.timeline) this.appendEvent(session.meta.id, event);
  }

  list(): StoredSession[] {
    const rows = this.db.prepare("SELECT * FROM sessions ORDER BY updated_at DESC").all() as SessionRow[];
    return rows.map((row) => this.fromRow(row));
  }

  listMeta(): SessionMeta[] {
    const rows = this.db
      .prepare("SELECT id, title, created_at, updated_at, message_count FROM sessions ORDER BY updated_at DESC")
      .all() as Omit<SessionRow, "messages_json">[];
    return rows.map((row) => this.metaFromRow(row));
  }

  get(sessionId: string): StoredSession | undefined {
    const state = this.getState(sessionId);
    return state ? { ...state, timeline: this.getTimeline(sessionId) } : undefined;
  }

  getState(sessionId: string): StoredSessionState | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as SessionRow | undefined;
    if (!row) return undefined;
    return {
      meta: this.metaFromRow(row),
      messages: JSON.parse(row.messages_json) as Message[],
    };
  }

  has(sessionId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(sessionId));
  }

  updateMeta(meta: SessionMeta): void {
    this.db
      .prepare(
        `UPDATE sessions
         SET title = @title, updated_at = @updatedAt, message_count = @messageCount
         WHERE id = @id`,
      )
      .run(meta);
  }

  saveMessages(sessionId: string, messages: Message[]): void {
    this.db.prepare("UPDATE sessions SET messages_json = ? WHERE id = ?").run(JSON.stringify(messages), sessionId);
  }

  getTimeline(sessionId: string): TimestampedEvent[] {
    const rows = this.db
      .prepare("SELECT seq, event_json FROM session_events WHERE session_id = ? ORDER BY seq")
      .all(sessionId) as EventRow[];
    return rows.map((item) => ({ ...JSON.parse(item.event_json), seq: item.seq }) as TimestampedEvent);
  }

  appendEvent(sessionId: string, event: TimestampedEvent): number {
    const result = this.db
      .prepare("INSERT INTO session_events (session_id, event_json) VALUES (?, ?)")
      .run(sessionId, JSON.stringify(event));
    return Number(result.lastInsertRowid);
  }

  createRun(run: StoredSessionRun): void {
    this.db
      .prepare(
        `INSERT INTO session_runs (
           id, session_id, kind, status, input, started_at, updated_at, finished_at, pending_approval_json, error
         ) VALUES (
           @id, @sessionId, @kind, @status, @input, @startedAt, @updatedAt, @finishedAt, @pendingApprovalJson, @error
         )`,
      )
      .run(this.toRunParams(run));
  }

  updateRun(run: StoredSessionRun): void {
    this.db
      .prepare(
        `UPDATE session_runs
         SET status = @status,
             updated_at = @updatedAt,
             finished_at = @finishedAt,
             pending_approval_json = @pendingApprovalJson,
             error = @error
         WHERE id = @id`,
      )
      .run(this.toRunParams(run));
  }

  getRun(runId: string): StoredSessionRun | undefined {
    const row = this.db.prepare("SELECT * FROM session_runs WHERE id = ?").get(runId) as RunRow | undefined;
    return row ? this.runFromRow(row) : undefined;
  }

  interruptIncompleteRuns(now = new Date().toISOString()): StoredSessionRun[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM session_runs
         WHERE status IN ('queued', 'running', 'waiting_approval')
         ORDER BY started_at`,
      )
      .all() as RunRow[];
    if (rows.length === 0) return [];

    const interrupt = this.db.transaction(() => {
      const statement = this.db.prepare(
        `UPDATE session_runs
         SET status = 'interrupted', updated_at = ?, finished_at = ?, pending_approval_json = NULL
         WHERE id = ?`,
      );
      for (const row of rows) statement.run(now, now, row.id);
    });
    interrupt();

    return rows.map((row) =>
      this.runFromRow({
        ...row,
        status: "interrupted",
        updated_at: now,
        finished_at: now,
        pending_approval_json: null,
      }),
    );
  }

  close(): void {
    this.db.close();
  }

  private fromRow(row: SessionRow): StoredSession {
    return {
      meta: this.metaFromRow(row),
      messages: JSON.parse(row.messages_json) as Message[],
      timeline: this.getTimeline(row.id),
    };
  }

  private metaFromRow(row: Omit<SessionRow, "messages_json">): SessionMeta {
    return {
      id: row.id,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messageCount: row.message_count,
    };
  }

  private toRunParams(run: StoredSessionRun): Record<string, unknown> {
    return {
      ...run,
      input: run.input ?? null,
      finishedAt: run.finishedAt ?? null,
      pendingApprovalJson: run.pendingApproval ? JSON.stringify(run.pendingApproval) : null,
      error: run.error ?? null,
    };
  }

  private runFromRow(row: RunRow): StoredSessionRun {
    return {
      id: row.id,
      sessionId: row.session_id,
      kind: row.kind,
      status: row.status,
      input: row.input ?? undefined,
      startedAt: row.started_at,
      updatedAt: row.updated_at,
      finishedAt: row.finished_at ?? undefined,
      pendingApproval: row.pending_approval_json
        ? (JSON.parse(row.pending_approval_json) as PendingApprovalSnapshot)
        : undefined,
      error: row.error ?? undefined,
    };
  }
}
