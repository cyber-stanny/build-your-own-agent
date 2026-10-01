export const defaultConfig = {
  server: {
    port: 8787,
    webPassword: "",
    authSecret: "",
    tokenTtlMs: 7 * 24 * 60 * 60 * 1000,
  },
  agent: {
    workingDir: "./workspace",
    shellSandbox: "off",
    memoryFile: "memory/state.json",
    sessionDbFile: "sessions/sessions.db",
    sessionRuntimeIdleTtlMs: 10 * 60 * 1000,
    maxTurns: 32,
    contextStrategy: "cache-first",
    recentTurns: 32,
    contextPruneBatchUserTurns: 8,
    modelContextTokens: 1_000_000,
    maxContextTokens: 500_000,
    maxToolResultChars: 12_000,
    maxOutputTokens: 16_384,
    compactKeepRecentUserTurns: 2,
    systemPrompt:
      "你是一个 coding agent。可以调用提供的工具读写文件、执行命令来完成任务。完成后用自然语言给出最终答复，不要再调用工具。必要的时候也可以接受用户的任意请求。",
  },
  siliconflow: {
    apiKey: "",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "Qwen/Qwen3-VL-32B-Instruct",
  },
  model: {
    deepseekApiKey: "",
    deepseekModel: "deepseek-v4-flash",
    deepseekDebugLog: true,
    deepseekDebugLogDir: "model-logs",
  },
  followups: {
    enabled: true,
    pollIntervalMs: 60_000,
    reviewTimeoutMs: 20 * 60_000,
    ciTimeoutMs: 30 * 60_000,
    maxConsecutiveErrors: 3,
  },
} as const;

export type DefaultConfig = typeof defaultConfig;
