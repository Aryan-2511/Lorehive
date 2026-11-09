/**
 * Lorehive domain model.
 *
 * Everything in src/core is pure (no Forge imports) so it can be unit tested
 * and reused by demo mode, the Forge handlers and any future CLI.
 */

export type Vendor = 'copilot' | 'claude' | 'cursor' | 'rovo' | 'rovo-dev' | 'other';

export type SourceSystem = 'github' | 'bitbucket' | 'jira' | 'jsm' | 'confluence' | 'mcp';

/**
 * Evidence kinds. Only *action* kinds can ever count towards promotion.
 * `text_claim` exists so that instructions written in tickets/comments are
 * recorded (and visible) but structurally unable to become a lesson.
 */
export type EvidenceKind =
  | 'revert' // a human reverted an agent's change
  | 'fixup' // a human pushed a corrective commit onto an agent PR
  | 'reopen' // a ticket an agent resolved was reopened by a human
  | 'human_edit' // a human edited an agent's comment/answer
  | 'review_finding' // a reviewer agent flagged an issue and a human accepted the fix
  | 'outcome_report' // an agent reported (via MCP) that following a lesson worked / failed
  | 'text_claim'; // free text asserting a rule; never counts

export const ACTION_KINDS: ReadonlySet<EvidenceKind> = new Set([
  'revert',
  'fixup',
  'reopen',
  'human_edit',
  'review_finding',
]);

/** A scope is where something happened or where a lesson applies. */
export interface Scope {
  /** e.g. "github:acme/payments-api" or "bitbucket:acme/web" */
  repo?: string;
  /** Jira project key, e.g. "PAY" */
  project?: string;
  /** Owning team id (Teamwork Graph team or configured team) */
  team?: string;
  /** Languages/frameworks, e.g. ["typescript"] */
  languages?: string[];
}

/** Structured change that a correction made. The LLM only ever sees this, never raw ticket text. */
export interface ChangeSummary {
  files: string[];
  /** Lines the human removed from the agent's work */
  removed: string[];
  /** Lines the human added */
  added: string[];
}

export interface Actor {
  id: string; // account id / login
  displayName?: string;
  /** true when this account is a known agent/bot */
  isAgent: boolean;
  vendor?: Vendor;
  /** account age in days, when known (new accounts are not trusted) */
  accountAgeDays?: number;
  /** explicitly distrusted / suspected compromised */
  flagged?: boolean;
}

export interface Evidence {
  id: string;
  kind: EvidenceKind;
  source: SourceSystem;
  scope: Scope;
  /** The human (or accepting human) whose action this evidence is. */
  actor: Actor;
  /** The agent whose behaviour was corrected. */
  subjectAgent?: Actor;
  /** For review_finding: the reviewer agent that raised it. */
  reviewerAgent?: Actor;
  /** Link to the PR / commit / issue. Lessons cite these. */
  url: string;
  /** Short, system-generated description (never copied from user text into rules). */
  summary: string;
  change?: ChangeSummary;
  /** Free text (ticket body, comment). Stored for display only. */
  text?: string;
  /** Topic key that clusters evidence about the same mistake. */
  topic?: string;
  occurredAt: string; // ISO
  seeded?: boolean;
}

export type LessonStatus = 'candidate' | 'promoted' | 'retired' | 'superseded' | 'vetoed';

/** Optional machine-checkable rule compiled from a lesson (used by merge checks / GitHub checks). */
export interface LessonCheck {
  /** Regex (JS syntax) that must NOT appear in added lines of matching files. */
  forbid?: string;
  /** Glob-ish suffix filter for files, e.g. ".ts" */
  fileSuffix?: string[];
  message: string;
}

export interface Lesson {
  id: string;
  topic: string;
  title: string;
  /** Imperative rule text, e.g. "Use @org/http instead of axios; it sets timeouts and tenant headers." */
  rule: string;
  rationale: string;
  status: LessonStatus;
  /** Where the lesson applies. Empty arrays mean "all". */
  appliesTo: { repos: string[]; projects: string[]; languages: string[]; teams: string[] };
  evidenceIds: string[];
  citations: string[];
  check?: LessonCheck;
  /** Bi-temporal: when the lesson is true in the world ... */
  validFrom?: string;
  validTo?: string;
  /** ... and when Lorehive recorded it. */
  recordedAt: string;
  supersedes?: string;
  supersededBy?: string;
  /** Repos in the canary cohort (lesson delivered); the rest of the fleet is holdout. */
  canaryRepos?: string[];
  retiredReason?: string;
  seeded?: boolean;
}

export interface PromotionPolicy {
  /** distinct trusted humans required */
  minDistinctActors: number;
  /** distinct repos/projects required */
  minDistinctScopes: number;
  /** accounts younger than this are not trusted */
  minAccountAgeDays: number;
  /** a reviewer agent may not be the same vendor as the agent it reviewed */
  requireCrossVendorReview: boolean;
}

export const DEFAULT_POLICY: PromotionPolicy = {
  minDistinctActors: 2,
  minDistinctScopes: 2,
  minAccountAgeDays: 30,
  requireCrossVendorReview: true,
};
