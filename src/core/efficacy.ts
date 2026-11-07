/**
 * Measure: does a lesson actually reduce the mistake it targets?
 *
 * Compare recurrence (new evidence on the lesson's topic per agent PR) in
 * canary repos (lesson delivered) against holdout repos (not yet delivered),
 * after the lesson's validFrom. Retire lessons that make things worse; widen
 * rollout for lessons that clearly help.
 */
export interface RepoActivity {
  repo: string;
  agentPrs: number; // agent PRs since validFrom
  recurrences: number; // new corrections on this topic since validFrom
}

export interface EfficacyResult {
  canaryRate: number;
  holdoutRate: number;
  canaryPrs: number;
  holdoutPrs: number;
  /** relative change in recurrence, negative is good */
  lift: number;
  verdict: 'insufficient_data' | 'effective' | 'no_effect' | 'harmful';
}

export interface EfficacyPolicy {
  minPrsPerArm: number;
  /** relative reduction needed to call a lesson effective, e.g. 0.3 = 30% lower */
  effectiveBelow: number;
  /** relative increase that marks a lesson harmful */
  harmfulAbove: number;
}

export const DEFAULT_EFFICACY: EfficacyPolicy = { minPrsPerArm: 10, effectiveBelow: 0.3, harmfulAbove: 0.2 };

export function measure(canaryRepos: string[], activity: RepoActivity[], policy = DEFAULT_EFFICACY): EfficacyResult {
  const canary = new Set(canaryRepos);
  const sum = (xs: RepoActivity[], k: 'agentPrs' | 'recurrences') => xs.reduce((s, x) => s + x[k], 0);
  const c = activity.filter((a) => canary.has(a.repo));
  const h = activity.filter((a) => !canary.has(a.repo));
  const canaryPrs = sum(c, 'agentPrs');
  const holdoutPrs = sum(h, 'agentPrs');
  const canaryRate = canaryPrs ? sum(c, 'recurrences') / canaryPrs : 0;
  const holdoutRate = holdoutPrs ? sum(h, 'recurrences') / holdoutPrs : 0;
  const lift = holdoutRate ? (canaryRate - holdoutRate) / holdoutRate : canaryRate > 0 ? 1 : 0;

  let verdict: EfficacyResult['verdict'];
  if (canaryPrs < policy.minPrsPerArm || holdoutPrs < policy.minPrsPerArm) verdict = 'insufficient_data';
  else if (lift >= policy.harmfulAbove) verdict = 'harmful';
  else if (lift <= -policy.effectiveBelow) verdict = 'effective';
  else verdict = 'no_effect';

  return { canaryRate, holdoutRate, canaryPrs, holdoutPrs, lift, verdict };
}
