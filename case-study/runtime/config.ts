import { defaultConfig } from "./config.defaults";
import type { ContextStrategy } from "./context/builder";
import path from "node:path";

try {
  process.loadEnvFile();
} catch {
  /* .env is optional */
}

function numberOverride(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function boolOverride(name: string): boolean | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  return raw === "1" || raw.toLowerCase() === "true";
}

function shellSandboxOverride(): "off" | "readonly-root" | undefined {
  const raw = process.env.AGENT_SHELL_SANDBOX;
  if (!raw) return undefined;
  if (raw === "off" || raw === "readonly-root") return raw;
  throw new Error(`Invalid AGENT_SHELL_SANDBOX: ${raw}`);
}

function contextStrategyOverride(): ContextStrategy | undefined {
  const raw = process.env.AGENT_CONTEXT_STRATEGY;
  if (!raw) return undefined;
  if (raw === "cache-first" || raw === "legacy-window") return raw;
  throw new Error(`Invalid AGENT_CONTEXT_STRATEGY: ${raw}`);
}

export const appConfig = {
  server: {
    ...defaultConfig.server,
    port: numberOverride("PORT") ?? defaultConfig.server.port,
    webPassword: process.env.WEB_PASSWORD ?? defaultConfig.server.webPassword,
    authSecret: process.env.AUTH_SECRET ?? process.env.WEB_PASSWORD ?? defaultConfig.server.authSecret,
    tokenTtlMs: numberOverride("AUTH_TOKEN_TTL_MS") ?? defaultConfig.server.tokenTtlMs,
  },
  agent: {
    ...defaultConfig.agent,
    workingDir: process.env.AGENT_CWD ?? defaultConfig.agent.workingDir,
    shellSandbox: shellSandboxOverride() ?? (defaultConfig.agent.shellSandbox as "off"),
    memoryFile: process.env.MEMORY_FILE ?? defaultConfig.agent.memoryFile,
    sessionDbFile: process.env.SESSION_DB_FILE ?? defaultConfig.agent.sessionDbFile,
    sessionRuntimeIdleTtlMs:
      numberOverride("SESSION_RUNTIME_IDLE_TTL_MS") ?? defaultConfig.agent.sessionRuntimeIdleTtlMs,
    maxTurns: numberOverride("AGENT_MAX_TURNS") ?? defaultConfig.agent.maxTurns,
    contextStrategy: contextStrategyOverride() ?? defaultConfig.agent.contextStrategy,
    recentTurns: numberOverride("AGENT_RECENT_TURNS") ?? defaultConfig.agent.recentTurns,
    contextPruneBatchUserTurns:
      numberOverride("AGENT_CONTEXT_PRUNE_BATCH_USER_TURNS") ?? defaultConfig.agent.contextPruneBatchUserTurns,
    modelContextTokens: numberOverride("AGENT_MODEL_CONTEXT_TOKENS") ?? defaultConfig.agent.modelContextTokens,
    maxContextTokens: numberOverride("AGENT_MAX_CONTEXT_TOKENS") ?? defaultConfig.agent.maxContextTokens,
    maxToolResultChars: numberOverride("AGENT_MAX_TOOL_RESULT_CHARS") ?? defaultConfig.agent.maxToolResultChars,
    maxOutputTokens: numberOverride("AGENT_MAX_OUTPUT_TOKENS") ?? defaultConfig.agent.maxOutputTokens,
    compactKeepRecentUserTurns:
      numberOverride("AGENT_COMPACT_KEEP_RECENT_USER_TURNS") ?? defaultConfig.agent.compactKeepRecentUserTurns,
    systemPrompt: process.env.AGENT_SYSTEM_PROMPT ?? defaultConfig.agent.systemPrompt,
  },
  model: {
    ...defaultConfig.model,
    deepseekApiKey: process.env.DEEPSEEK_API_KEY ?? defaultConfig.model.deepseekApiKey,
    deepseekModel: process.env.DEEPSEEK_MODEL ?? defaultConfig.model.deepseekModel,
    deepseekDebugLog: boolOverride("DEEPSEEK_DEBUG_LOG") ?? defaultConfig.model.deepseekDebugLog,
    deepseekDebugLogDir: process.env.DEEPSEEK_DEBUG_LOG_DIR ?? defaultConfig.model.deepseekDebugLogDir,
  },
  siliconflow: {
    ...defaultConfig.siliconflow,
    apiKey: process.env.SILICONFLOW_API_KEY ?? defaultConfig.siliconflow.apiKey,
    baseUrl: process.env.SILICONFLOW_BASE_URL ?? defaultConfig.siliconflow.baseUrl,
    model: process.env.SILICONFLOW_MODEL ?? defaultConfig.siliconflow.model,
  },
  followups: {
    ...defaultConfig.followups,
    enabled: boolOverride("PR_REVIEW_FOLLOWUP_ENABLED") ?? defaultConfig.followups.enabled,
    pollIntervalMs:
      numberOverride("PR_REVIEW_FOLLOWUP_INTERVAL_MS") ?? defaultConfig.followups.pollIntervalMs,
    reviewTimeoutMs:
      numberOverride("PR_REVIEW_FOLLOWUP_REVIEW_TIMEOUT_MS") ?? defaultConfig.followups.reviewTimeoutMs,
    ciTimeoutMs: numberOverride("PR_REVIEW_FOLLOWUP_CI_TIMEOUT_MS") ?? defaultConfig.followups.ciTimeoutMs,
    maxConsecutiveErrors:
      numberOverride("PR_REVIEW_FOLLOWUP_MAX_ERRORS") ?? defaultConfig.followups.maxConsecutiveErrors,
    stateFile:
      process.env.PR_REVIEW_FOLLOWUP_FILE ??
      path.join(process.env.AGENT_CWD ?? defaultConfig.agent.workingDir, ".agent-runtime", "pr-review-followups.json"),
  },
} as const;
