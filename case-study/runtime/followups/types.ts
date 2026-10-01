export type FollowupComplexity = "simple" | "complex";

export type FollowupState =
  | "waiting_review"
  | "repairing"
  | "waiting_ci"
  | "ready"
  | "blocked"
  | "cancelled";

export type ReviewSeverity = "P0" | "P1" | "P2" | "P3";

export type ReviewFinding = {
  severity: ReviewSeverity;
  body: string;
  path?: string;
  line?: number;
  url?: string;
};

export type TrustedReview = {
  completed: boolean;
  reviewId?: number;
  submittedAt?: string;
  summary?: string;
  findings: ReviewFinding[];
};

export type PullRequestSnapshot = {
  state: "open" | "closed";
  merged: boolean;
  headOid: string;
  headRefName: string;
  headRepository: string;
  url: string;
};

export type CheckSnapshot = {
  status: "pending" | "success" | "failure";
  summary: string;
};

export type AgentFollowupInput = {
  task: PrReviewFollowupTask;
  pullRequest: PullRequestSnapshot;
  review: TrustedReview;
};

export type AgentFollowupOutcome = {
  status: "fixed" | "skipped" | "blocked";
  summary: string;
};

export type PrReviewFollowupTask = {
  id: string;
  repo: string;
  prNumber: number;
  workspacePath?: string;
  complexity: FollowupComplexity;
  state: FollowupState;
  currentHeadOid?: string;
  reviewRequestHeadOid?: string;
  reviewRequestCommentId?: number;
  reviewRequestAttempts: number;
  reviewRequestedAt?: string;
  repairAttempts: number;
  ciWaitStartedAt?: string;
  consecutiveErrors: number;
  nextCheckAt: string;
  summary?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

export const TERMINAL_FOLLOWUP_STATES = new Set<FollowupState>(["ready", "blocked", "cancelled"]);

export function maxRepairAttempts(complexity: FollowupComplexity): number {
  return complexity === "complex" ? 5 : 3;
}
