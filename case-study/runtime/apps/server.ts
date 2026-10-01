import { mkdirSync, writeFileSync } from "node:fs";
import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import path from "node:path";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { ToolRegistry } from "../tools/registry";
import { readFile, writeFile, editFile, listDir } from "../tools/fileOps";
import { runShell } from "../tools/shell";
import { createProcessTools } from "../tools/process";
import { gitStatus, gitDiff } from "../tools/gitOps";
import { analyzeImage } from "../tools/analyzeImage";
import { createRememberTool } from "../tools/memory";
import { createDeployMainTool } from "../tools/deploy";
import { SessionStore } from "../sessions/store";
import {
  SessionBusyError,
  SessionNotFoundError,
  SessionRuntimeStore,
  type SessionSnapshot,
} from "../sessions/runtime-store";
import { importLegacyJsonlSessions } from "../sessions/import-jsonl";
import { MockModelClient } from "../model/mock";
import { DeepseekModelClient } from "../model/deepseek";
import { MemoryStore } from "../memory/store";
import { appConfig } from "../config";
import { COMMANDS, parseCommand, type ParsedCommand } from "../commands/registry";
import { PrReviewFollowupStore } from "../followups/store";
import { GhReviewGithub } from "../followups/github";
import { PrReviewFollowupService } from "../followups/service";
import { PrReviewFollowupScheduler } from "../followups/scheduler";
import { createExistingAgentFollowup } from "../followups/agent";
import {
  createGetPrReviewFollowupTool,
  createSchedulePrReviewFollowupTool,
} from "../tools/prReviewFollowup";
import { SerialTaskQueue } from "../core/serial-queue";

// WebSocket 只拥有连接状态；session/run 生命周期由全局 SessionRuntimeStore 持有。

const { server, agent, model: modelConfig, followups: followupConfig } = appConfig;

// ⚠️ 软门：密码走明文 ws，仅适合 localhost / 受信网络；公网部署须套 HTTPS/WSS。

// 「记住一周」：解锁后签发一个带过期时间的凭证（HMAC 签名，无状态——服务器重启也认；改密码即失效）。
function signExp(exp: string): string {
  return createHmac("sha256", server.authSecret).update(exp).digest("hex");
}
function makeToken(): string {
  const exp = String(Date.now() + server.tokenTtlMs);
  return `${exp}.${signExp(exp)}`;
}
function verifyToken(token: string): boolean {
  const dot = token.indexOf(".");
  if (dot < 0) return false;
  const mac = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(signExp(token.slice(0, dot)));
  if (mac.length !== expected.length) return false;
  return timingSafeEqual(mac, expected) && Number(token.slice(0, dot)) > Date.now();
}

const memory = new MemoryStore(agent.memoryFile);
const sessionStore = new SessionStore(agent.sessionDbFile);
const followupStore = new PrReviewFollowupStore(followupConfig.stateFile);
const workspaceRuns = new SerialTaskQueue();
let wakeFollowupScheduler = () => {};
const importedLegacySessions = importLegacyJsonlSessions(sessionStore, "runs", agent.systemPrompt);
if (importedLegacySessions > 0) console.log(`已导入 ${importedLegacySessions} 条旧 JSONL 会话`);
const processTools = createProcessTools();
const registry = new ToolRegistry()
  .register(readFile)
  .register(writeFile)
  .register(editFile)
  .register(listDir)
  .register(runShell)
  .register(processTools[0])
  .register(processTools[1])
  .register(processTools[2])
  .register(processTools[3])
  .register(gitStatus)
  .register(gitDiff)
  .register(createRememberTool(memory))
  .register(createDeployMainTool())
  .register(createSchedulePrReviewFollowupTool(followupStore, () => wakeFollowupScheduler()))
  .register(createGetPrReviewFollowupTool(followupStore))
  .register(analyzeImage);
mkdirSync(agent.workingDir, { recursive: true });

type ClientMessage = {
  type?: string;
  command?: string;
  task?: string;
  id?: string;
  decision?: string;
  password?: string;
  token?: string;
  data?: unknown;
  name?: string;
  mode?: string;
};

type ConnectionContext = {
  id: string;
  ws: WebSocket;
  activeSessionId: string;
  authenticated: boolean;
  modelMode: "mock" | "deepseek";
};

type CommandHandler = (parsed: ParsedCommand, ctx: ConnectionContext) => void;

const connections = new Map<string, ConnectionContext>();

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function broadcastSession(sessionId: string, payload: unknown): void {
  for (const connection of connections.values()) {
    if (connection.authenticated && connection.activeSessionId === sessionId) sendJson(connection.ws, payload);
  }
}

const deepseekModel = modelConfig.deepseekApiKey
  ? new DeepseekModelClient(modelConfig.deepseekApiKey, modelConfig.deepseekModel)
  : undefined;

const runtimeStore = new SessionRuntimeStore({
  sessionStore,
  registry,
  systemPrompt: agent.systemPrompt,
  workingDir: agent.workingDir,
  shellSandbox: agent.shellSandbox,
  maxTurns: agent.maxTurns,
  context: {
    strategy: agent.contextStrategy,
    recentTurns: agent.recentTurns,
    pruneBatchUserTurns: agent.contextPruneBatchUserTurns,
    maxToolResultChars: agent.maxToolResultChars,
    maxContextTokens: agent.maxContextTokens,
  },
  memoryContext: () => memory.formatForContext(),
  compactKeepRecentUserTurns: agent.compactKeepRecentUserTurns,
  runExclusive: (task) => workspaceRuns.run(task),
  broadcastEvent: broadcastSession,
  broadcastRunState: (sessionId, run) => {
    broadcastSession(sessionId, { type: "run_state", sessionId, run });
  },
  onMetaChanged: (meta) => {
    const sessions = runtimeStore.listMetas();
    for (const connection of connections.values()) {
      if (connection.authenticated) sendJson(connection.ws, { type: "session_meta", session: meta, sessions });
    }
  },
});

const recoveredRuns = runtimeStore.recoverInterruptedRuns();
if (recoveredRuns > 0) console.log(`session runtime: recovered ${recoveredRuns} interrupted run(s)`);
const runtimeEvictionTimer = setInterval(() => {
  const evicted = runtimeStore.evictIdle(agent.sessionRuntimeIdleTtlMs);
  if (evicted.length > 0) console.log(`session runtime: evicted ${evicted.length} idle session(s)`);
}, Math.min(60_000, Math.max(1_000, agent.sessionRuntimeIdleTtlMs)));
runtimeEvictionTimer.unref();

function createConnectionContext(ws: WebSocket): ConnectionContext {
  return {
    id: `conn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    ws,
    activeSessionId: "",
    authenticated: false,
    modelMode: "mock",
  };
}

function modelFor(ctx: ConnectionContext) {
  if (ctx.modelMode === "deepseek" && deepseekModel) return deepseekModel;
  return new MockModelClient();
}

function attachInitialSession(ctx: ConnectionContext): SessionSnapshot {
  const first = runtimeStore.listMetas()[0] ?? runtimeStore.createSession();
  ctx.activeSessionId = first.id;
  return runtimeStore.attach(first.id, ctx.id);
}

function sendHello(ctx: ConnectionContext): void {
  sendJson(ctx.ws, {
    type: "hello",
    connection: ctx.id,
    authRequired: true,
    allowMock: !server.webPassword,
  });
}

function sendReady(ctx: ConnectionContext, snapshot = runtimeStore.snapshot(ctx.activeSessionId)): void {
  console.log(`+ 连接 ${ctx.id}`);
  sendJson(ctx.ws, {
    ts: new Date().toISOString(),
    type: "ready",
    connection: ctx.id,
    session: snapshot.session,
    sessions: runtimeStore.listMetas(),
    events: snapshot.events,
    run: snapshot.run,
    pendingApproval: snapshot.pendingApproval,
    lastEventSeq: snapshot.lastEventSeq,
    commands: COMMANDS,
    followups: followupStore.list(),
  });
}

function sendSessionSnapshot(ctx: ConnectionContext, type: "session_switched", snapshot: SessionSnapshot): void {
  sendJson(ctx.ws, {
    ts: new Date().toISOString(),
    type,
    session: snapshot.session,
    sessions: runtimeStore.listMetas(),
    events: snapshot.events,
    run: snapshot.run,
    pendingApproval: snapshot.pendingApproval,
    lastEventSeq: snapshot.lastEventSeq,
  });
}

function parseClientMessage(raw: RawData): ClientMessage {
  try {
    return JSON.parse(raw.toString());
  } catch {
    return { task: raw.toString() };
  }
}

function handleClientMessage(raw: RawData, ctx: ConnectionContext): void {
  const msg = parseClientMessage(raw);

  if (msg.type === "auth") {
    handleAuthMessage(msg, ctx);
    return;
  }

  if (!ctx.authenticated) {
    sendJson(ctx.ws, { type: "auth_required", reason: "请先完成认证" });
    return;
  }

  if (msg.type === "approval") {
    handleApprovalMessage(msg, ctx);
    return;
  }

  if (msg.type === "command" || msg.command) {
    handleCommandMessage(msg, ctx);
    return;
  }

  if (msg.type === "upload_image") {
    handleUploadImage(msg, ctx);
    return;
  }

  handleTaskMessage(msg, ctx);
}

function handleAuthMessage(msg: ClientMessage, ctx: ConnectionContext): void {
  const mockAllowed = msg.mode === "mock" && !server.webPassword;
  const realAuthOk = msg.token
    ? Boolean(server.authSecret) && verifyToken(msg.token)
    : Boolean(server.webPassword) && msg.password === server.webPassword;

  if (mockAllowed || (realAuthOk && deepseekModel)) {
    ctx.authenticated = true;
    ctx.modelMode = mockAllowed ? "mock" : "deepseek";
    sendJson(ctx.ws, {
      type: "auth_ok",
      model: ctx.modelMode,
      token: mockAllowed ? undefined : makeToken(),
    });
    const snapshot = ctx.activeSessionId ? runtimeStore.snapshot(ctx.activeSessionId) : attachInitialSession(ctx);
    sendReady(ctx, snapshot);
    console.log(`  ${ctx.id} 已解锁（${mockAllowed ? "mock" : msg.token ? "凭证" : "密码"}）`);
    return;
  }

  const reason = msg.mode === "mock" && server.webPassword
    ? "服务器已启用密码，不能跳过认证"
    : !modelConfig.deepseekApiKey
    ? "服务器未配置 DEEPSEEK_API_KEY"
    : !server.webPassword
      ? "服务器未配置 WEB_PASSWORD"
      : msg.token
        ? "登录已过期，请重新输入密码"
        : "密码错误";
  sendJson(ctx.ws, { type: "auth_fail", reason });
}

function handleApprovalMessage(msg: ClientMessage, ctx: ConnectionContext): void {
  if (!msg.id || !ctx.activeSessionId) return;
  const resolved = runtimeStore.resolveApproval(ctx.activeSessionId, msg.id, msg.decision === "allow");
  if (!resolved) sendJson(ctx.ws, { type: "command_error", content: "审批已失效或不属于当前会话" });
}

function handleCommandMessage(msg: ClientMessage, ctx: ConnectionContext): void {
  const parsed = parseCommand(msg.command ?? msg.task ?? "");
  const handler = commandHandlers[parsed.name];
  if (handler) {
    handler(parsed, ctx);
    return;
  }

  sendJson(ctx.ws, {
    ts: new Date().toISOString(),
    type: "command_error",
    content: `未知命令：${parsed.raw}`,
  });
}

const commandHandlers: Record<string, CommandHandler> = {
  "/new": (_parsed, ctx) => {
    const session = runtimeStore.createSession();
    switchToSession(ctx, session.id);
  },
  "/sessions": (_parsed, ctx) => {
    sendJson(ctx.ws, { type: "sessions", activeSessionId: ctx.activeSessionId, sessions: runtimeStore.listMetas() });
  },
  "/session": (parsed, ctx) => {
    const sessionId = parsed.args[0];
    if (!sessionId) {
      sendJson(ctx.ws, { ts: new Date().toISOString(), type: "command_error", content: "用法：/session <sessionId>" });
      return;
    }
    switchToSession(ctx, sessionId);
  },
  "/compact": (_parsed, ctx) => {
    try {
      runtimeStore.startCompact(ctx.activeSessionId, modelFor(ctx));
    } catch (error) {
      sendRuntimeError(ctx, error);
    }
  },
  "/stop": (_parsed, ctx) => {
    if (!runtimeStore.cancel(ctx.activeSessionId)) {
      sendJson(ctx.ws, { type: "command_error", content: "当前会话没有可终止的任务" });
    }
  },
};

function handleTaskMessage(msg: ClientMessage, ctx: ConnectionContext): void {
  const input = (msg.task ?? "").trim();
  if (!input) return;
  try {
    runtimeStore.startAgentRun(ctx.activeSessionId, input, modelFor(ctx));
  } catch (error) {
    sendRuntimeError(ctx, error);
  }
}

function sendRuntimeError(ctx: ConnectionContext, error: unknown): void {
  if (error instanceof SessionBusyError) {
    sendJson(ctx.ws, { type: "session_busy", sessionId: ctx.activeSessionId, run: error.run });
    return;
  }
  sendJson(ctx.ws, {
    type: "command_error",
    content: error instanceof Error ? error.message : String(error),
  });
}

function handleUploadImage(msg: ClientMessage, ctx: ConnectionContext): void {
  // 接收前端粘贴的图片（base64），保存到 workspace/uploads/ 目录，返回路径
  const rawData = msg.data as string | undefined;
  const fileName = (msg.name as string) || "clipboard.png";
  if (!rawData) {
    sendJson(ctx.ws, { ts: new Date().toISOString(), type: "image_upload_error", error: "no image data" });
    return;
  }

  // 去掉可能的 data:image/xxx;base64, 前缀
  const base64Data = rawData.includes(",") ? rawData.split(",")[1] : rawData;
  const buffer = Buffer.from(base64Data, "base64");

  // 创建 uploads 目录（相对于 workspace）
  const dirPath = path.join(agent.workingDir, "uploads");
  mkdirSync(dirPath, { recursive: true });

  // 生成唯一文件名，保留原扩展名
  const ext = path.extname(fileName) || ".png";
  const savedName = `${randomUUID()}${ext}`;
  const savePath = path.join(dirPath, savedName);
  writeFileSync(savePath, buffer);

  const relativePath = `uploads/${savedName}`;
  sendJson(ctx.ws, {
    ts: new Date().toISOString(),
    type: "image_uploaded",
    path: relativePath,
    name: savedName,
  });
}

function switchToSession(ctx: ConnectionContext, sessionId: string): void {
  try {
    const snapshot = runtimeStore.attach(sessionId, ctx.id);
    const previousSessionId = ctx.activeSessionId;
    ctx.activeSessionId = sessionId;
    if (previousSessionId && previousSessionId !== sessionId) runtimeStore.detach(previousSessionId, ctx.id);
    sendSessionSnapshot(ctx, "session_switched", snapshot);
  } catch (error) {
    const content = error instanceof SessionNotFoundError ? `找不到会话：${sessionId}` : String(error);
    sendJson(ctx.ws, { ts: new Date().toISOString(), type: "command_error", content });
  }
}

function closeConnection(ctx: ConnectionContext): void {
  connections.delete(ctx.id);
  if (ctx.activeSessionId) runtimeStore.detach(ctx.activeSessionId, ctx.id);
  console.log(`- 断开 ${ctx.id}`);
}

const wss = new WebSocketServer({ port: server.port });
const runExistingFollowupAgent = modelConfig.deepseekApiKey
  ? createExistingAgentFollowup({
      model: new DeepseekModelClient(modelConfig.deepseekApiKey, modelConfig.deepseekModel),
      registry,
      workingDir: agent.workingDir,
      shellSandbox: agent.shellSandbox,
      maxTurns: agent.maxTurns,
      contextStrategy: agent.contextStrategy,
      recentTurns: agent.recentTurns,
      contextPruneBatchUserTurns: agent.contextPruneBatchUserTurns,
      maxToolResultChars: agent.maxToolResultChars,
      maxContextTokens: agent.maxContextTokens,
      memoryContext: () => memory.formatForContext(),
    })
  : async () => {
      throw new Error("服务器未配置 DEEPSEEK_API_KEY，无法执行 PR Review 自动修复");
    };
const followupAgent = runExistingFollowupAgent;
const followupService = new PrReviewFollowupService(
  followupStore,
  new GhReviewGithub(),
  followupAgent,
  {
    pollIntervalMs: followupConfig.pollIntervalMs,
    reviewTimeoutMs: followupConfig.reviewTimeoutMs,
    ciTimeoutMs: followupConfig.ciTimeoutMs,
    maxConsecutiveErrors: followupConfig.maxConsecutiveErrors,
    runExclusive: (task) => workspaceRuns.run(task),
  },
  (task) => {
    console.log(`PR follow-up ${task.id}: ${task.state} · ${task.summary ?? ""}`);
    for (const connection of connections.values()) {
      if (connection.authenticated) sendJson(connection.ws, { type: "pr_review_followup", task });
    }
  },
);
const followupScheduler = new PrReviewFollowupScheduler(
  followupStore,
  followupService,
  followupConfig.pollIntervalMs,
);
wakeFollowupScheduler = () => followupScheduler.wake();
if (followupConfig.enabled) followupScheduler.start();
console.log(
  `agent ws server: ws://localhost:${server.port}  （默认 mock；输对密码用真实 key=${modelConfig.deepseekApiKey ? "已配置" : "未配置!"}，目录: ${agent.workingDir}，记忆: ${agent.memoryFile}，会话: ${agent.sessionDbFile}，PR Review 跟进: ${followupConfig.enabled ? "开启" : "关闭"}）`,
);

wss.on("connection", (ws) => {
  const ctx = createConnectionContext(ws);
  connections.set(ctx.id, ctx);
  sendHello(ctx);
  ws.on("message", (raw) => handleClientMessage(raw, ctx));
  ws.on("close", () => closeConnection(ctx));
});
