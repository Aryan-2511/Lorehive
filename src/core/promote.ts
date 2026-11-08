/**
 * Promotion: the security gate.
 *
 * A topic becomes a promoted lesson only when a quorum of *independent,
 * trusted, action-based* evidence agrees. Every evidence item gets an explicit
 * verdict so the console can show exactly why something was or wasn't promoted.
 */
import { ACTION_KINDS, DEFAULT_POLICY, Evidence, PromotionPolicy } from './types';

export type EvidenceVerdict =
  | { counted: true; evidenceId: string }
  | { counted: false; evidenceId: string; reason: RejectReason };

export type RejectReason =
  | 'text_only' // free text can never count
  | 'not_an_action' // e.g. outcome reports
  | 'actor_is_agent' // agents can't vouch for themselves or each other alone
  | 'actor_flagged'
  | 'actor_too_new'
  | 'actor_is_subject' // the correcting account is the agent being corrected
  | 'same_vendor_review' // reviewer agent and subject agent from the same vendor
  | 'duplicate_actor'; // this actor already contributed; one vote per account

export interface PromotionDecision {
  topic: string;
  promote: boolean;
  verdicts: EvidenceVerdict[];
  distinctActors: string[];
  distinctScopes: string[];
  /** human readable explanation of what is missing */
  missing: string[];
}

export function scopeKey(e: Evidence): string {
  return e.scope.repo ?? (e.scope.project ? `jira:${e.scope.project}` : 'unknown');
}

export function evaluateTopic(
  topic: string,
  evidence: Evidence[],
  policy: PromotionPolicy = DEFAULT_POLICY,
): PromotionDecision {
  const verdicts: EvidenceVerdict[] = [];
  const actors = new Set<string>();
  const scopes = new Set<string>();

  // Oldest first, so that the first contribution of an actor is the one that counts.
  const sorted = [...evidence].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));

  for (const e of sorted) {
    const reject = (reason: RejectReason) => verdicts.push({ counted: false, evidenceId: e.id, reason });

    if (e.kind === 'text_claim') { reject('text_only'); continue; }
    if (!ACTION_KINDS.has(e.kind)) { reject('not_an_action'); continue; }
    if (e.actor.isAgent) { reject('actor_is_agent'); continue; }
    if (e.actor.flagged) { reject('actor_flagged'); continue; }
    if (e.actor.accountAgeDays !== undefined && e.actor.accountAgeDays < policy.minAccountAgeDays) {
      reject('actor_too_new');
      continue;
    }
    if (e.subjectAgent && e.subjectAgent.id === e.actor.id) { reject('actor_is_subject'); continue; }
    if (
      e.kind === 'review_finding' &&
      policy.requireCrossVendorReview &&
      e.reviewerAgent?.vendor &&
      e.reviewerAgent.vendor === e.subjectAgent?.vendor
    ) {
      reject('same_vendor_review');
      continue;
    }
    if (actors.has(e.actor.id)) { reject('duplicate_actor'); continue; }

    actors.add(e.actor.id);
    scopes.add(scopeKey(e));
    verdicts.push({ counted: true, evidenceId: e.id });
  }

  const missing: string[] = [];
  if (actors.size < policy.minDistinctActors) {
    missing.push(`needs ${policy.minDistinctActors - actors.size} more independent trusted person(s)`);
  }
  if (scopes.size < policy.minDistinctScopes) {
    missing.push(`needs evidence from ${policy.minDistinctScopes - scopes.size} more repo(s)/project(s)`);
  }

  return {
    topic,
    promote: missing.length === 0,
    verdicts,
    distinctActors: [...actors],
    distinctScopes: [...scopes],
    missing,
  };
}

export const REJECT_LABELS: Record<RejectReason, string> = {
  text_only: 'Text only: instructions in tickets never become evidence',
  not_an_action: 'Not a correcting action',
  actor_is_agent: 'Made by an agent, not a person',
  actor_flagged: 'Account is flagged',
  actor_too_new: 'Account too new to be trusted',
  actor_is_subject: 'Correcting account is the agent itself',
  same_vendor_review: 'Reviewer agent is the same vendor as the author',
  duplicate_actor: 'Same person already counted (one vote per account)',
};

export const COUNTED_LABEL = 'Counted: a correcting action by a trusted person, and their first vote on this topic';

/**
 * The promotion rule and result in plain words. The Librarian quotes these, so
 * "why was this promoted?" is answered by the rule rather than a model's guess.
 */
export function explainDecision(decision: PromotionDecision, policy: PromotionPolicy = DEFAULT_POLICY) {
  const people = decision.distinctActors.length;
  const places = decision.distinctScopes.length;
  const counts =
    `${people} of ${policy.minDistinctActors} required people (${decision.distinctActors.join(', ') || 'none'}), ` +
    `${places} of ${policy.minDistinctScopes} required places (${decision.distinctScopes.join(', ') || 'none'})`;
  return {
    rule:
      `A lesson is promoted only when at least ${policy.minDistinctActors} different trusted people correct agents ` +
      `in at least ${policy.minDistinctScopes} different repos or projects. Each account counts once, and text in tickets never counts.`,
    result: decision.promote ? `Quorum met: ${counts}.` : `Quorum not met: ${counts}.`,
    missing: decision.missing,
  };
}
