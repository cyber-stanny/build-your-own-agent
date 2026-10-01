import { useEffect, useMemo, useRef, useState } from "react";
import { webConfig } from "./config";

// 与 server 推来的事件对齐（结构化 JSON）
type AgentEvent = {
  type: string;
  ts?: string;
  seq?: number;
  sessionId?: string;
  content?: string;
  text?: string;
  name?: string;
  input?: unknown;
  toolCalls?: { name: string }[];
  session?: string | SessionMeta;
  connection?: string;
  activeSessionId?: string;
  sessions?: SessionMeta[];
  events?: AgentEvent[];
  commands?: CommandMeta[];
  run?: SessionRun;
  pendingApproval?: PendingApproval;
  lastEventSeq?: number;
  allowMock?: boolean;
  // context_built
  messageCount?: number;
  builtMessageCount?: number;
  tokenEstimate?: number;
  strategy?: "cache-first" | "legacy-window";
  prompt?: {
    promptHash: string;
    prefixHash: string;
    toolsHash: string;
    memoryHash?: string;
    sharedPrefixMessages?: number;
    sharedPrefixTokenEstimate?: number;
  };
  included?: string[];
  omitted?: string[];
  // model_usage
  estimate?: number;
  usage?: {
    requestId?: string;
    model?: string;
    systemFingerprint?: string;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cachedInputTokens?: number;
    cacheMissInputTokens?: number;
    reasoningTokens?: number;
  };
  // approval_request
  id?: string;
  tool?: string;
  reason?: string;
  // auth
  model?: string;
  token?: string;
  command?: string;
  // image upload
  path?: string;
  error?: string;
};

type PendingApproval = {
  id: string;
  tool: string;
  input: unknown;
  reason?: string;
  requestedAt: string;
};

type SessionRun = {
  id: string;
  sessionId: string;
  kind: "task" | "compact";
  status: "queued" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled" | "interrupted";
  input?: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  pendingApproval?: PendingApproval;
  error?: string;
};

type SessionMeta = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
};

type CommandMeta = {
  command: string;
  label: string;
  usage?: string;
};

const TOKEN_KEY = "agent_token";
const FONT_SIZE_KEY = "agent_font_size";
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 20;

type Item = { kind: "event"; ev: AgentEvent };

const FALLBACK_COMMANDS: CommandMeta[] = [
  { command: "/new", label: "开启新对话" },
  { command: "/sessions", label: "查看/切换历史对话" },
  { command: "/session", label: "切换到指定会话", usage: "/session <sessionId>" },
  { command: "/compact", label: "压缩当前对话历史" },
  { command: "/stop", label: "终止当前任务" },
];

export default function App() {
  const [timelineItems, setTimelineItems] = useState<Item[]>([]);
  const [connected, setConnected] = useState(false);
  const [input, setInput] = useState("");
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [showSessions, setShowSessions] = useState(false);
  const [commands, setCommands] = useState<CommandMeta[]>(FALLBACK_COMMANDS);
  const [commandIndex, setCommandIndex] = useState(0);
  // 密码门
  const [authed, setAuthed] = useState(false);
  const [modelName, setModelName] = useState("mock");
  const [pw, setPw] = useState("");
  const [authError, setAuthError] = useState("");
  const [checkingToken, setCheckingToken] = useState(false); // 正在用上次凭证自动登录
  const [allowMock, setAllowMock] = useState(false);
  const [running, setRunning] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [fontSize, setFontSize] = useState(() => {
    const saved = localStorage.getItem(FONT_SIZE_KEY);
    const n = saved ? Number(saved) : 13;
    return n >= MIN_FONT_SIZE && n <= MAX_FONT_SIZE ? n : 13;
  });
  const pendingKind = useRef<"token" | "password" | "mock" | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  function changeFontSize(delta: number) {
    setFontSize((prev) => {
      const next = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, prev + delta));
      localStorage.setItem(FONT_SIZE_KEY, String(next));
      return next;
    });
  }

  function applySessionSnapshot(ev: AgentEvent) {
    setActiveSessionId(getSessionId(ev.session));
    setSessions(ev.sessions ?? []);
    setTimelineItems((ev.events ?? []).map((event) => ({ kind: "event", ev: event })));
    const active = isActiveRun(ev.run);
    setRunning(active);
    setCompacting(active && ev.run?.kind === "compact");
    setApproval(ev.pendingApproval ?? ev.run?.pendingApproval ?? null);
  }

  // WebSocket：事件流的消费者
  useEffect(() => {
    const ws = new WebSocket(webConfig.wsUrl);
    wsRef.current = ws;
    ws.onopen = () => {
      setConnected(true);
      // 同设备一周内免密：有存的凭证就先用它静默登录
      const saved = localStorage.getItem(TOKEN_KEY);
      if (saved) {
        pendingKind.current = "token";
        setCheckingToken(true);
        ws.send(JSON.stringify({ type: "auth", token: saved }));
      }
    };
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);
    ws.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data) as AgentEvent;
        switch (ev.type) {
          case "hello":
            setAllowMock(Boolean(ev.allowMock));
            return;
          case "auth_ok":
            if (ev.token) localStorage.setItem(TOKEN_KEY, ev.token); // 存一周凭证
            setModelName(ev.model ?? "deepseek");
            setCheckingToken(false);
            setAuthed(true);
            pendingKind.current = null;
            return;
          case "auth_required":
            setAuthed(false);
            setCheckingToken(false);
            return;
          case "auth_fail":
            setCheckingToken(false);
            if (pendingKind.current === "token") {
              localStorage.removeItem(TOKEN_KEY); // 凭证过期/失效 → 回到密码框（不报错）
            } else {
              setAuthError(ev.reason ?? "解锁失败");
            }
            pendingKind.current = null;
            return;
          case "ready":
            applySessionSnapshot(ev);
            setCommands(ev.commands ?? FALLBACK_COMMANDS);
            return;
          case "sessions":
            setSessions(ev.sessions ?? []);
            setShowSessions(true);
            return;
          case "session_switched":
            applySessionSnapshot(ev);
            setShowSessions(false);
            return;
          case "session_meta":
            setSessions(ev.sessions ?? []);
            return;
          case "image_uploaded":
            setUploadingImage(false);
            setInput((prev) => prev + `[图片已上传: ${ev.path}] `);
            return;
          case "image_upload_error":
            setUploadingImage(false);
            setInput((prev) => prev + `[图片上传失败: ${ev.error}] `);
            return;
          case "command_result":
            if (ev.command === "/compact" && ev.content?.startsWith("压缩完成")) {
              setRunning(false);
              setCompacting(false);
            }
            break;
          case "run_state": {
            const active = isActiveRun(ev.run);
            setRunning(active);
            setCompacting(active && ev.run?.kind === "compact");
            setApproval(ev.run?.pendingApproval ?? null);
            return;
          }
          case "session_busy":
            setRunning(isActiveRun(ev.run));
            setCompacting(isActiveRun(ev.run) && ev.run?.kind === "compact");
            setApproval(ev.run?.pendingApproval ?? null);
            return;
          case "user_message":
          case "model_request":
            if (ev.type === "model_request") return; // 不渲染
            break;
          case "approval_request":
            if (ev.id && ev.tool) {
              setApproval({
                id: ev.id,
                tool: ev.tool,
                input: ev.input,
                reason: ev.reason,
                requestedAt: ev.ts ?? new Date().toISOString(),
              });
            }
            break;
          case "approval_resolved":
            setApproval((current) => (current?.id === ev.id ? null : current));
            break;
          case "final_answer":
          case "run_interrupted":
            setRunning(false);
            setCompacting(false);
            break;
          case "error":
            break;
        }
        setTimelineItems((prev) => {
          if (ev.seq !== undefined && prev.some((item) => item.ev.seq === ev.seq)) return prev;
          return [...prev, { kind: "event", ev }];
        });
      } catch {
        /* 忽略非 JSON */
      }
    };
    return () => ws.close();
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [timelineItems, approval]);

  const runningToolIds = useMemo(() => {
    const active = new Set<string>();
    for (const item of timelineItems) {
      const ev = item.ev;
      if (ev.type === "tool_call" && ev.id) active.add(ev.id);
      if (ev.type === "tool_result" && ev.id) active.delete(ev.id);
      if (ev.type === "final_answer" || ev.type === "error") active.clear();
    }
    return active;
  }, [timelineItems]);

  useEffect(() => {
    if (runningToolIds.size === 0) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [runningToolIds.size]);

  function unlock() {
    const ws = wsRef.current;
    if (ws && pw) {
      setAuthError("");
      pendingKind.current = "password";
      ws.send(JSON.stringify({ type: "auth", password: pw }));
    }
  }

  function useMock() {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    setAuthError("");
    pendingKind.current = "mock";
    setCheckingToken(true);
    ws.send(JSON.stringify({ type: "auth", mode: "mock" }));
  }

  function send() {
    const text = input.trim();
    const ws = wsRef.current;
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
    const isCommand = text.startsWith("/");
    ws.send(JSON.stringify(isCommand ? { type: "command", command: text } : { type: "task", task: text }));
    setInput("");
    if (inputRef.current) inputRef.current.style.height = "auto";
    const isCompact = text.startsWith("/compact");
    setRunning(!isCommand || isCompact);
    setCompacting(isCompact);
  }

  function stopTask() {
    // compact 不支持中途取消（compactMessages 不检查 signal），
    // 直接忽略点击，由 compact 自行完成。等 command_result 到达时自然会更新 UI。
    if (compacting) return;
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "command", command: "/stop" }));
    }
    // 不在这里 setRunning(false)：以 server 发回的 run_state 终态为准，
    // 避免 stop 后立即发新消息时，本地状态先于真实 run 生命周期变化。
  }

  function respondApproval(decision: "allow" | "deny") {
    const ws = wsRef.current;
    if (approval?.id && ws) ws.send(JSON.stringify({ type: "approval", id: approval.id, decision }));
    setApproval(null);
  }

  function switchSession(id: string) {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "command", command: `/session ${id}` }));
  }

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const tokenUsage = useMemo(() => summarizeTokenUsage(timelineItems), [timelineItems]);
  const commandMatches = input.startsWith("/")
    ? commands.filter((item) => item.command.startsWith(input.trim()) || input.trim() === "/")
    : [];

  return (
    <div className="term" style={{ fontSize: fontSize + "px" }}>
      <div className="term-head">
        <span className="brand">my-agent-runtime</span>
        <span className={`dot ${connected ? "on" : "off"}`} aria-hidden="true" />
        <span className="connection-label">{connected ? "已连接" : "未连接"}</span>
        <button
          className="session-pill"
          onClick={() => wsRef.current?.send(JSON.stringify({ type: "command", command: "/sessions" }))}
        >
          {activeSession?.title ?? "新对话"}
        </button>
        <span className="model-tag">模型: {modelName}</span>
        <span className="token-tag" title={formatTokenUsageTitle(tokenUsage)}>
          Tokens: {formatTokenCount(tokenUsage.total)}
        </span>
        <button
          className="head-action"
          onClick={() => wsRef.current?.send(JSON.stringify({ type: "command", command: "/new" }))}
          title="开启新对话"
          aria-label="开启新对话"
        >
          +
        </button>
        <button
          className="head-action"
          onClick={() => changeFontSize(-1)}
          disabled={fontSize <= MIN_FONT_SIZE}
          title="缩小字号"
          aria-label="缩小字号"
        >
          A⁻
        </button>
        <button
          className="head-action"
          onClick={() => changeFontSize(1)}
          disabled={fontSize >= MAX_FONT_SIZE}
          title="放大字号"
          aria-label="放大字号"
        >
          A⁺
        </button>
        <button
          className="head-action"
          onClick={() => window.location.reload()}
          title="重新连接"
          aria-label="重新连接"
        >
          ↻
        </button>
      </div>

      <div className="term-body">
        {timelineItems.map((it, i) => (
          <EventRow key={i} ev={it.ev} isRunningTool={Boolean(it.ev.id && runningToolIds.has(it.ev.id))} now={now} />
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="term-input">
        {commandMatches.length > 0 && (
          <div className="command-menu">
            {commandMatches.map((item, index) => (
              <button
                key={item.command}
                className={`command-item ${index === commandIndex ? "active" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setInput(item.command);
                  setCommandIndex(index);
                  requestAnimationFrame(() => inputRef.current?.focus());
                }}
              >
                <span>{item.command}</span>
                <small>{item.usage ?? item.label}</small>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setCommandIndex(0);
            e.target.style.height = "auto";
            e.target.style.height = `${Math.min(e.target.scrollHeight, 132)}px`;
          }}
          onPaste={(e) => {
            const files = e.clipboardData.files;
            for (const file of files) {
              if (file.type.startsWith("image/")) {
                e.preventDefault();
                setUploadingImage(true);
                const reader = new FileReader();
                reader.onload = () => {
                  const base64 = reader.result as string;
                  wsRef.current?.send(JSON.stringify({
                    type: "upload_image",
                    data: base64,
                    name: file.name || "clipboard.png",
                  }));
                };
                reader.readAsDataURL(file);
                break;
              }
            }
          }}
          onKeyDown={(e) => {
            if (commandMatches.length > 0 && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
              e.preventDefault();
              setCommandIndex((prev) =>
                e.key === "ArrowDown"
                  ? (prev + 1) % commandMatches.length
                  : (prev - 1 + commandMatches.length) % commandMatches.length,
              );
              return;
            }
            if (commandMatches.length > 0 && e.key === "Tab") {
              e.preventDefault();
              setInput(commandMatches[commandIndex]?.command ?? input);
              return;
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (input.trim() === "/" && commandMatches[commandIndex]) {
                setInput(commandMatches[commandIndex].command);
                wsRef.current?.send(JSON.stringify({ type: "command", command: commandMatches[commandIndex].command }));
                setInput("");
                return;
              }
              send();
            }
          }}
          placeholder={!authed ? "请先解锁…" : connected ? "输入消息…" : "连接中…"}
          disabled={!connected || !authed || running}
          rows={1}
          aria-label="消息"
        />
        <button
          className={"send-button" + (running && !compacting ? " stop" : "")}
          onClick={running && !compacting ? stopTask : send}
          disabled={compacting ? true : !running && (!input.trim() || !connected || !authed)}
          title={compacting ? "正在压缩对话历史…" : running ? "终止任务" : "发送"}
          aria-label={compacting ? "压缩中" : running ? "终止任务" : "发送"}
        >
          {compacting ? "⏳" : running ? "⏹" : "↑"}
        </button>
        {uploadingImage && <span className="image-uploading">📤 正在上传图片…</span>}
      </div>

      {/* 密码门：连上、未解锁、且不在用凭证自动登录时弹出 */}
      {connected && !authed && !checkingToken && (
        <div className="modal-mask">
          <div className="modal">
            <div className="modal-title">🔑 输入密码，用你自己的 DeepSeek key 对话</div>
            <input
              className="pw"
              type="password"
              value={pw}
              autoFocus
              onChange={(e) => setPw(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && unlock()}
              placeholder="密码"
            />
            {authError && <div className="auth-error">{authError}</div>}
            <div className="modal-actions">
              {allowMock && (
                <button className="btn deny" onClick={useMock}>
                  跳过（用 mock）
                </button>
              )}
              <button className="btn allow" onClick={unlock}>
                解锁
              </button>
            </div>
          </div>
        </div>
      )}

      {showSessions && (
        <div className="modal-mask">
          <div className="modal sessions-modal">
            <div className="modal-title">历史对话</div>
            <div className="session-list">
              {sessions.map((session) => (
                <button
                  key={session.id}
                  className={`session-row ${session.id === activeSessionId ? "active" : ""}`}
                  onClick={() => switchSession(session.id)}
                >
                  <span className="session-title">{session.title}</span>
                  <span className="session-meta">
                    {formatTime(session.updatedAt)} · {session.messageCount} 条
                  </span>
                </button>
              ))}
            </div>
            <div className="modal-actions">
              <button className="btn deny" onClick={() => setShowSessions(false)}>
                关闭
              </button>
              <button
                className="btn allow"
                onClick={() => wsRef.current?.send(JSON.stringify({ type: "command", command: "/new" }))}
              >
                新对话
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 危险动作审批 */}
      {approval && (
        <div className="modal-mask">
          <div className="modal">
            <div className="modal-title">⏸ 需要你的批准</div>
            <div className="modal-reason">{approval.reason}</div>
            <pre className="modal-cmd">{JSON.stringify(approval.input)}</pre>
            <div className="modal-actions">
              <button className="btn deny" onClick={() => respondApproval("deny")}>
                拒绝
              </button>
              <button className="btn allow" onClick={() => respondApproval("allow")}>
                允许执行
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// 把一个事件渲染成对应的行（tool_result / context_built 可折叠，默认折叠）
function EventRow({ ev, isRunningTool, now }: { ev: AgentEvent; isRunningTool: boolean; now: number }) {
  switch (ev.type) {
    case "ready":
      return <Line icon="🔌" color="#7d8590" text={`已连接 · session ${getSessionId(ev.session)}`} />;
    case "user_message":
      return <Line icon="❯" color="#58a6ff" text={ev.content ?? ""} />;
    case "session_switched":
      return <Line icon="•" color="#7d8590" text={`已切换到：${getSessionTitle(ev.session)}`} />;
    case "command_error":
      return <Line icon="!" color="#f85149" text={ev.content ?? ""} />;
    case "command_result":
      return <Line icon="⌘" color="#58a6ff" text={`${ev.command ?? "命令"} · ${ev.content ?? ""}`} />;
    case "model_response": {
      const tools = ev.toolCalls?.map((t) => t.name).join(", ");
      const t = ev.text ?? "";
      if (!t && !tools) return null;
      return <Line icon="🤖" color="#e6edf3" text={t + (tools ? `   [想调用: ${tools}]` : "")} />;
    }
    case "tool_call":
      if (isRunningTool) return <RunningToolLine ev={ev} now={now} />;
      return <Line icon="🔧" color="#d29922" text={`${ev.name}(${JSON.stringify(ev.input)})`} />;
    case "tool_result": {
      const body = ev.content ?? "";
      const lines = body.split("\n").length;
      const head = body.split("\n")[0].slice(0, 60);
      return <Collapsible icon="📥" color="#8b949e" summary={`result · ${body.length} 字符 / ${lines} 行 · ${head}`} body={body} />;
    }
    case "context_built": {
      const omittedN = ev.omitted?.length ?? 0;
      const prompt = ev.prompt;
      const body = [
        `+ strategy ${ev.strategy ?? "?"}`,
        ...(ev.included ?? []).map((s) => `+ ${s}`),
        ...(prompt
          ? [
              `+ prompt_hash ${prompt.promptHash}`,
              `+ prefix_hash ${prompt.prefixHash}`,
              `+ tools_hash ${prompt.toolsHash}`,
              ...(prompt.memoryHash ? [`+ memory_hash ${prompt.memoryHash}`] : []),
              ...(prompt.sharedPrefixMessages !== undefined
                ? [`+ 与上次请求共享前缀 ${prompt.sharedPrefixMessages} 条消息 / ~${prompt.sharedPrefixTokenEstimate ?? 0} tokens`]
                : []),
            ]
          : []),
        ...(ev.omitted ?? []).map((s) => `- ${s}`),
      ].join("\n");
      return (
        <Collapsible
          icon="🧠"
          color="#a371f7"
          summary={`context · ${ev.builtMessageCount ?? ev.messageCount} / ${ev.messageCount} msgs · ~${ev.tokenEstimate} tokens${omittedN ? ` · ${omittedN} 项省略/截断` : ""}`}
          body={body}
        />
      );
    }
    case "model_usage": {
      const usage = ev.usage ?? {};
      const actual = usage.totalTokens ?? sumKnown(usage.inputTokens, usage.outputTokens);
      const delta =
        typeof actual === "number" && typeof ev.estimate === "number"
          ? ` · 偏差 ${actual - ev.estimate >= 0 ? "+" : ""}${actual - ev.estimate}`
          : "";
      const cache = formatCacheUsage(usage);
      const reasoning = usage.reasoningTokens ? ` · reasoning ${usage.reasoningTokens}` : "";
      const request = usage.requestId ? ` · request ${usage.requestId}` : "";
      return (
        <Line
          icon="◷"
          color="#79c0ff"
          text={`tokens · 估算 ~${ev.estimate ?? "?"} · 实际 ${actual ?? "?"} · input ${usage.inputTokens ?? "?"} · output ${usage.outputTokens ?? "?"}${reasoning}${cache}${request}${delta}`}
        />
      );
    }
    case "approval_request":
      return <Line icon="⏸" color="#d29922" text={`需要批准：${ev.tool} —— ${ev.reason ?? ""}`} />;
    case "run_interrupted":
      return <Line icon="■" color="#f85149" text={ev.content ?? "上次运行已中断"} />;
    case "final_answer":
      return <Line icon="✅" color="#3fb950" text={ev.content ?? ""} />;
    case "error":
      return <Line icon="❌" color="#f85149" text={ev.content ?? ""} />;
    default:
      return null;
  }
}

function RunningToolLine({ ev, now }: { ev: AgentEvent; now: number }) {
  const detail = formatToolInput(ev.input);
  const elapsed = formatElapsed(elapsedSeconds(ev.ts, now));
  return (
    <div className="line running-tool">
      <span className="icon">
        <span className="running-dot" />
      </span>
      <pre className="text">{`执行中 · ${ev.name ?? "tool"} · 已耗时 ${elapsed}${detail ? `\n${detail}` : ""}`}</pre>
    </div>
  );
}

function getSessionId(session: AgentEvent["session"]): string {
  return typeof session === "string" ? session : (session?.id ?? "");
}

function getSessionTitle(session: AgentEvent["session"]): string {
  return typeof session === "string" ? session : (session?.title ?? "新对话");
}

function isActiveRun(run: SessionRun | undefined): boolean {
  return run?.status === "queued" || run?.status === "running" || run?.status === "waiting_approval";
}

function sumKnown(a?: number, b?: number): number | undefined {
  return typeof a === "number" && typeof b === "number" ? a + b : undefined;
}

type TokenUsageSummary = {
  input: number;
  output: number;
  total: number;
  reasoning: number;
  cachedInput: number;
  cacheMissInput: number;
  calls: number;
};

function summarizeTokenUsage(items: Item[]): TokenUsageSummary {
  const summary: TokenUsageSummary = {
    input: 0,
    output: 0,
    total: 0,
    reasoning: 0,
    cachedInput: 0,
    cacheMissInput: 0,
    calls: 0,
  };
  for (const item of items) {
    const ev = item.ev;
    if (ev.type !== "model_usage" || !ev.usage) continue;
    const total = ev.usage.totalTokens ?? sumKnown(ev.usage.inputTokens, ev.usage.outputTokens);
    if (typeof total !== "number") continue;
    summary.calls += 1;
    summary.total += total;
    summary.input += ev.usage.inputTokens ?? 0;
    summary.output += ev.usage.outputTokens ?? 0;
    summary.reasoning += ev.usage.reasoningTokens ?? 0;
    const cachedInput = ev.usage.cachedInputTokens ?? 0;
    summary.cachedInput += cachedInput;
    summary.cacheMissInput +=
      ev.usage.cacheMissInputTokens ??
      (ev.usage.cachedInputTokens !== undefined ? Math.max(0, (ev.usage.inputTokens ?? cachedInput) - cachedInput) : 0);
  }
  return summary;
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1_000)}k`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function formatTokenUsageTitle(usage: TokenUsageSummary): string {
  if (usage.calls === 0) return "当前会话还没有真实 token 用量";
  const cacheInput = usage.cachedInput + usage.cacheMissInput;
  const cacheRatio = cacheInput > 0 ? `${((usage.cachedInput / cacheInput) * 100).toFixed(1)}%` : "";
  return [
    `当前会话 ${usage.calls} 次模型调用`,
    `总计 ${usage.total} tokens`,
    `输入 ${usage.input}`,
    `输出 ${usage.output}`,
    usage.reasoning ? `推理 ${usage.reasoning}` : "",
    cacheInput ? `缓存命中 ${usage.cachedInput}/${cacheInput} (${cacheRatio})` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function formatCacheUsage(usage: NonNullable<AgentEvent["usage"]>): string {
  if (usage.cachedInputTokens === undefined && usage.cacheMissInputTokens === undefined) return "";
  const hit = usage.cachedInputTokens ?? 0;
  const miss = usage.cacheMissInputTokens ?? Math.max(0, (usage.inputTokens ?? hit) - hit);
  const cacheInput = hit + miss;
  const ratio = cacheInput > 0 ? ((hit / cacheInput) * 100).toFixed(1) : "0.0";
  return ` · cache hit ${hit}/${cacheInput} (${ratio}%) · miss ${miss}`;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function elapsedSeconds(value: string | undefined, now: number): number {
  const startedAt = value ? new Date(value).getTime() : now;
  if (Number.isNaN(startedAt)) return 0;
  return Math.max(0, Math.floor((now - startedAt) / 1_000));
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}分${String(rest).padStart(2, "0")}秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours}时${String(minutes % 60).padStart(2, "0")}分`;
}

function formatToolInput(input: unknown): string {
  if (typeof input === "object" && input && "command" in input && typeof input.command === "string") {
    return input.command;
  }
  if (input == null) return "";
  return JSON.stringify(input);
}

function Line({ icon, color, text }: { icon: string; color: string; text: string }) {
  return (
    <div className="line" style={{ color }}>
      <span className="icon">{icon}</span>
      <pre className="text">{text}</pre>
    </div>
  );
}

// 可折叠行：默认只显示一行 summary，点击展开 body
function Collapsible({ icon, color, summary, body }: { icon: string; color: string; summary: string; body: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="line" style={{ color }}>
      <span className="icon">{icon}</span>
      <div className="text">
        <button className="toggle" onClick={() => setOpen((v) => !v)}>
          {open ? "▾" : "▸"} {summary}
        </button>
        {open && <pre className="body">{body}</pre>}
      </div>
    </div>
  );
}
