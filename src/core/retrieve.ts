/**
 * Retrieval for `lessons_for(scope, task)`.
 *
 * Forge has no vector search, so: hard scope + permission filter, then a
 * BM25-style keyword score, then (optionally) an LLM rerank of the top N
 * through the `Reranker` interface.
 */
import { Lesson, Scope } from './types';

export interface Requester {
  /** repos/projects the requesting agent's user can currently access */
  accessibleRepos?: ReadonlySet<string>;
  accessibleProjects?: ReadonlySet<string>;
}

export interface Reranker {
  rerank(task: string, lessons: Lesson[]): Promise<Lesson[]>;
}

export function appliesTo(l: Lesson, scope: Scope): boolean {
  const a = l.appliesTo;
  if (a.repos.length && !(scope.repo && a.repos.includes(scope.repo))) return false;
  if (a.projects.length && !(scope.project && a.projects.includes(scope.project))) return false;
  if (a.teams.length && !(scope.team && a.teams.includes(scope.team))) return false;
  if (a.languages.length && scope.languages?.length && !a.languages.some((x) => scope.languages!.includes(x))) return false;
  return true;
}

/**
 * Permission filter: a lesson is visible only if the requester can access
 * every place its evidence came from (citations would otherwise leak).
 */
export function visibleTo(l: Lesson, r: Requester): boolean {
  const sources = l.canaryRepos ?? [];
  if (r.accessibleRepos && sources.some((s) => !r.accessibleRepos!.has(s))) return false;
  if (r.accessibleProjects && l.appliesTo.projects.some((p) => !r.accessibleProjects!.has(p))) return false;
  return true;
}

const STOP = new Set('a an the to of in on for and or with is are be this that it as at by from use using'.split(' '));

export function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9@/._-]+/)
    .flatMap((t) => [t, ...t.split(/[/._-]/)])
    .filter((t) => t.length > 1 && !STOP.has(t));
}

export function keywordScore(task: string, lessons: Lesson[]): Map<string, number> {
  const docs = lessons.map((l) => ({ id: l.id, toks: tokens(`${l.title} ${l.rule} ${l.topic}`) }));
  const N = docs.length || 1;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d.toks)) df.set(t, (df.get(t) ?? 0) + 1);
  const avg = docs.reduce((s, d) => s + d.toks.length, 0) / N || 1;
  const q = new Set(tokens(task));
  const k1 = 1.2;
  const b = 0.75;
  const scores = new Map<string, number>();
  for (const d of docs) {
    let s = 0;
    for (const t of q) {
      const tf = d.toks.filter((x) => x === t).length;
      if (!tf) continue;
      const idf = Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
      s += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * d.toks.length) / avg)));
    }
    scores.set(d.id, s);
  }
  return scores;
}

export interface LessonsForResult {
  lessons: Array<Pick<Lesson, 'id' | 'title' | 'rule' | 'citations' | 'seeded'>>;
  considered: number;
  filteredByPermission: number;
}

export async function lessonsFor(
  all: Lesson[],
  scope: Scope,
  task: string,
  requester: Requester,
  opts: { limit?: number; reranker?: Reranker } = {},
): Promise<LessonsForResult> {
  const limit = opts.limit ?? 5;
  const inScope = all.filter((l) => l.status === 'promoted' && appliesTo(l, scope));
  const visible = inScope.filter((l) => visibleTo(l, requester));
  const scores = keywordScore(task, visible);
  let ranked = [...visible].sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0) || b.evidenceIds.length - a.evidenceIds.length);
  if (opts.reranker && ranked.length > 1) ranked = await opts.reranker.rerank(task, ranked.slice(0, limit * 3));
  return {
    lessons: ranked.slice(0, limit).map(({ id, title, rule, citations, seeded }) => ({ id, title, rule, citations, seeded })),
    considered: inScope.length,
    filteredByPermission: inScope.length - visible.length,
  };
}
