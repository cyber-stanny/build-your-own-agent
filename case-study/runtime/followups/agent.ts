import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventBus, ConsoleSink, JsonlSink } from "../core/events";
import { runTurn, type ApprovalRequest, type RunDeps } from "../core/loop";
import { createSession } from "../sessions/session";
import type { ContextConfig, ContextStrategy } from "../context/builder";
import type { ModelClient } from "../model/types";
import type { ToolRegistry } from "../tools/registry";
import type { ShellSandboxMode } from "../tools/types";
import type { AgentFollowupInput, AgentFollowupOutcome } from "./types";

export type ExistingAgentFollowupOptions = {
  model: ModelClient;
  registry: ToolRegistry;
  workingDir: string;
  shellSandbox?: ShellSandboxMode;
  maxTurns: number;
  contextStrategy: ContextStrategy;
  recentTurns: number;
  contextPruneBatchUserTurns: number;
  maxToolResultChars: number;
  maxContextTokens: number;
  memoryContext?: () => string;
};

export function createExistingAgentFollowup(options: ExistingAgentFollowupOptions) {
  return async (input: AgentFollowupInput): Promise<AgentFollowupOutcome> => {
    const runId = `followup_${input.task.id}_${randomUUID().slice(0, 8)}`;
    const events = new EventBus()
      .use(new ConsoleSink())
      .use(new JsonlSink(path.join(options.workingDir, ".agent-runtime", "followups", `${runId}.jsonl`)));
    const session = createSession(
      runId,
      [
        "你是这个项目现有 coding agent 的一次后台 PR Review 跟进运行。",
        "使用与日常开发相同的 loop、模型和 coding 工具，在 AGENT_CWD 内完成任务。",
        "必须遵守目标仓库的 AGENTS.md。不要 merge、deploy、reload PM2、修改 Nginx 或生产运行目录。",
        "修复后自行运行与风险匹配的检查，commit，并 push 到原 PR 分支。git push 必须作为一条独立命令执行。",
      ].join("\n"),
    );
    const allowedTools = getFollowupAllowedTools(options.registry);
    const deps: RunDeps = {
      model: options.model,
      registry: options.registry,
      events,
      config: {
        maxTurns: options.maxTurns,
        workingDir: options.workingDir,
        shellSandbox: options.shellSandbox,
        allowedTools,
        context: buildFollowupContextConfig(options),
        memoryContext: options.memoryContext,
      },
      approve: (request) =>
        approveFollowupGitPush(
          request,
          input.task.workspacePath ?? input.task.repo.split("/")[1],
          input.pullRequest.headRefName,
        ),
    };

    try {
      const answer = await runTurn(session, buildPrompt(input), deps);
      return parseAgentFollowupOutcome(answer);
    } finally {
      events.close();
    }
  };
}

export function buildFollowupContextConfig(
  options: Pick<
    ExistingAgentFollowupOptions,
    | "contextStrategy"
    | "recentTurns"
    | "contextPruneBatchUserTurns"
    | "maxToolResultChars"
    | "maxContextTokens"
  >,
): ContextConfig {
  return {
    strategy: options.contextStrategy,
    recentTurns: options.recentTurns,
    pruneBatchUserTurns: options.contextPruneBatchUserTurns,
    maxToolResultChars: options.maxToolResultChars,
    maxContextTokens: options.maxContextTokens,
  };
}

export function getFollowupAllowedTools(registry: ToolRegistry): string[] {
  const unavailable = new Set(["deployMain", "startProcess", "schedulePrReviewFollowup", "getPrReviewFollowup"]);
  return registry
    .list()
    .map((tool) => tool.name)
    .filter((name) => !unavailable.has(name));
}

function buildPrompt(input: AgentFollowupInput): string {
  const findings = input.review.findings.map((finding) => ({
    severity: finding.severity,
    path: finding.path,
    line: finding.line,
    body: finding.body,
    url: finding.url,
  }));
  return [
    `继续处理 GitHub PR：${input.pullRequest.url}`,
    `仓库：${input.task.repo}`,
    `PR：#${input.task.prNumber}`,
    `当前 head：${input.pullRequest.headOid}`,
    `PR 分支：${input.pullRequest.headRepository}:${input.pullRequest.headRefName}`,
    `AGENT_CWD 下的仓库路径：${input.task.workspacePath ?? input.task.repo.split("/")[1]}`,
    `这是第 ${input.task.repairAttempts + 1} 次自动修复，类型：${input.task.complexity}。`,
    "",
    "可信 Codex Review findings：",
    input.review.summary ?? "(没有外层 summary)",
    "",
    JSON.stringify(findings, null, 2),
    "",
    "处理要求：",
    "1. 先确认本地仓库确实是这个 PR 的分支和当前 head；只在 AGENT_CWD 内操作。",
    "2. 修完全部 P0/P1。P2 只有在正常个人使用会遇到、影响明确且不会扩大范围时才修；P3 跳过。",
    "3. 如果是复杂 PR 的第 4 次及以后修复，先判断问题是否收敛；核心方案仍反复变化时返回 blocked，不继续叠补丁。",
    "4. 自行检查 diff，运行必要测试并 commit；不要新建 PR。",
    `5. 最后用且只用这条独立命令 push：git -C ${input.task.workspacePath ?? input.task.repo.split("/")[1]} push origin HEAD:refs/heads/${input.pullRequest.headRefName}`,
    "6. 不要 merge，不要部署。",
    "7. 最后一条回复只输出一行 JSON，不要 Markdown：",
    '{"status":"fixed|skipped|blocked","summary":"简短说明本轮结果"}',
  ].join("\n");
}

export async function approveFollowupGitPush(
  request: ApprovalRequest,
  workspacePath: string,
  headRefName: string,
): Promise<boolean> {
  if (request.tool !== "runShell") return false;
  const command = String((request.input as { command?: unknown } | null)?.command ?? "").trim();
  if (!/^[A-Za-z0-9_./-]+$/.test(workspacePath) || !/^[A-Za-z0-9_./-]+$/.test(headRefName)) return false;
  return command === `git -C ${workspacePath} push origin HEAD:refs/heads/${headRefName}`;
}

export function parseAgentFollowupOutcome(answer: string): AgentFollowupOutcome {
  const fenced = answer.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? answer.slice(answer.indexOf("{"), answer.lastIndexOf("}") + 1);
  try {
    const parsed = JSON.parse(candidate.trim()) as Partial<AgentFollowupOutcome>;
    if (["fixed", "skipped", "blocked"].includes(parsed.status ?? "") && typeof parsed.summary === "string") {
      return parsed as AgentFollowupOutcome;
    }
  } catch {
    // The service still verifies whether the PR head changed before deciding.
  }
  return { status: "blocked", summary: `Agent 未返回有效的结构化结果：${answer.slice(0, 300)}` };
}
