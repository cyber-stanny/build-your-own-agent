import { execFile } from "node:child_process";
import type {
  CheckSnapshot,
  PullRequestSnapshot,
  ReviewFinding,
  ReviewSeverity,
  TrustedReview,
} from "./types";

type GhRunner = (args: string[]) => Promise<string>;

type GithubUser = { login?: string };
type GithubReview = {
  id: number;
  user?: GithubUser;
  body?: string | null;
  commit_id?: string | null;
  submitted_at?: string | null;
};
type GithubReviewComment = {
  id: number;
  user?: GithubUser;
  body?: string | null;
  commit_id?: string | null;
  pull_request_review_id?: number | null;
  path?: string;
  line?: number | null;
  html_url?: string;
};

export interface ReviewGithub {
  getPullRequest(repo: string, prNumber: number): Promise<PullRequestSnapshot>;
  getTrustedReview(repo: string, prNumber: number, headOid: string): Promise<TrustedReview>;
  requestReview(repo: string, prNumber: number, taskId: string, headOid: string, attempt: number): Promise<number>;
  hasCleanReaction(repo: string, commentId: number): Promise<boolean>;
  getChecks(repo: string, headOid: string): Promise<CheckSnapshot>;
}

export class GhReviewGithub implements ReviewGithub {
  constructor(private runGh: GhRunner = defaultGhRunner) {}

  async getPullRequest(repo: string, prNumber: number): Promise<PullRequestSnapshot> {
    assertRepo(repo);
    const pr = await this.api<{
      state: "open" | "closed";
      merged: boolean;
      html_url: string;
      head: { sha: string; ref: string; repo: { full_name: string } | null };
    }>([`repos/${repo}/pulls/${prNumber}`]);
    if (!pr.head.repo) throw new Error("PR head repository is unavailable");
    return {
      state: pr.state,
      merged: pr.merged,
      headOid: pr.head.sha,
      headRefName: pr.head.ref,
      headRepository: pr.head.repo.full_name,
      url: pr.html_url,
    };
  }

  async getTrustedReview(repo: string, prNumber: number, headOid: string): Promise<TrustedReview> {
    assertRepo(repo);
    const reviews = await this.api<GithubReview[]>([`repos/${repo}/pulls/${prNumber}/reviews?per_page=100`]);
    const latest = reviews
      .filter((review) => isCodexBot(review.user?.login) && review.commit_id === headOid && review.submitted_at)
      .sort((a, b) => String(b.submitted_at).localeCompare(String(a.submitted_at)))[0];

    if (!latest) return { completed: false, findings: [] };

    const comments = await this.api<GithubReviewComment[]>([`repos/${repo}/pulls/${prNumber}/comments?per_page=100`]);
    const findings = comments
      .filter(
        (comment) =>
          comment.pull_request_review_id === latest.id &&
          comment.commit_id === headOid &&
          isCodexBot(comment.user?.login) &&
          Boolean(comment.body?.trim()),
      )
      .map(toFinding);

    const summary = latest.body?.trim() || undefined;
    const summarySeverity = summary ? extractSeverity(summary) : undefined;
    if (summary && summarySeverity) findings.unshift({ severity: summarySeverity, body: summary });

    return {
      completed: true,
      reviewId: latest.id,
      submittedAt: latest.submitted_at ?? undefined,
      summary,
      findings,
    };
  }

  async requestReview(repo: string, prNumber: number, taskId: string, headOid: string, attempt: number): Promise<number> {
    assertRepo(repo);
    const marker = `<!-- agent-review-followup:${taskId}:${headOid}:${attempt} -->`;
    const body = `@codex review\n\n请按仓库 AGENTS.md 的个人版规则审查当前提交。\n\n${marker}`;
    const comment = await this.api<{ id: number }>([
      `repos/${repo}/issues/${prNumber}/comments`,
      "--method",
      "POST",
      "--field",
      `body=${body}`,
    ]);
    return comment.id;
  }

  async hasCleanReaction(repo: string, commentId: number): Promise<boolean> {
    assertRepo(repo);
    const reactions = await this.api<Array<{ content: string; user?: GithubUser }>>([
      `repos/${repo}/issues/comments/${commentId}/reactions?per_page=100`,
    ]);
    return reactions.some((reaction) => reaction.content === "+1" && isCodexBot(reaction.user?.login));
  }

  async getChecks(repo: string, headOid: string): Promise<CheckSnapshot> {
    assertRepo(repo);
    const result = await this.api<{
      check_runs: Array<{ name: string; status: string; conclusion?: string | null }>;
    }>([`repos/${repo}/commits/${headOid}/check-runs?per_page=100`]);
    if (result.check_runs.length === 0) return { status: "pending", summary: "CI 尚未创建 check run" };

    const pending = result.check_runs.filter((check) => check.status !== "completed");
    if (pending.length > 0) {
      return { status: "pending", summary: `CI 运行中：${pending.map((check) => check.name).join(", ")}` };
    }

    const accepted = new Set(["success", "neutral", "skipped"]);
    const failed = result.check_runs.filter((check) => !accepted.has(check.conclusion ?? ""));
    if (failed.length > 0) {
      return {
        status: "failure",
        summary: `CI 未通过：${failed.map((check) => `${check.name}(${check.conclusion ?? "unknown"})`).join(", ")}`,
      };
    }
    return { status: "success", summary: `CI 已通过：${result.check_runs.map((check) => check.name).join(", ")}` };
  }

  private async api<T>(args: string[]): Promise<T> {
    const output = await this.runGh(["api", ...args]);
    return JSON.parse(output) as T;
  }
}

function defaultGhRunner(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

function assertRepo(repo: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error(`Invalid GitHub repository: ${repo}`);
}

function isCodexBot(login?: string): boolean {
  return login === "chatgpt-codex-connector[bot]" || login === "chatgpt-codex-connector";
}

function toFinding(comment: GithubReviewComment): ReviewFinding {
  const body = comment.body!.trim();
  return {
    severity: extractSeverity(body) ?? "P2",
    body,
    path: comment.path,
    line: comment.line ?? undefined,
    url: comment.html_url,
  };
}

export function extractSeverity(body: string): ReviewSeverity | undefined {
  const match = body.match(/(?:^|[\s\[(:])P([0-3])(?:\b|[\])：:])/i);
  return match ? (`P${match[1]}` as ReviewSeverity) : undefined;
}
