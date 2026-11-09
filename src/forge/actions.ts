/**
 * Rovo actions. The same actions are exposed:
 *  - as tools of the `rovo:mcp` server (Claude Code, Cursor, any MCP client)
 *  - as actions of the Librarian `rovo:agent`
 *
 * Authorisation always comes from `context.accountId` / asUser calls, never
 * from inputs (an agent may hallucinate inputs).
 */
import { lessonsFor } from '../core/retrieve';
import { COUNTED_LABEL, REJECT_LABELS, evaluateTopic, explainDecision } from '../core/promote';
import { llmReranker } from './llm';
import { engine, requesterFor, store } from './runtime';
import { Lesson } from '../core/types';

interface ActionContext { accountId?: string }

const parseLanguages = (s?: string) => (s ? s.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean) : undefined);

export async function lessonsForAction(
  payload: { repo?: string; project?: string; task: string; languages?: string },
  _context: ActionContext,
) {
  const requester = await requesterFor();
  const result = await lessonsFor(
    await store.listLessons(),
    { repo: payload.repo, project: payload.project, languages: parseLanguages(payload.languages) },
    payload.task ?? '',
    requester,
    { limit: 5, reranker: llmReranker },
  );
  return {
    lessons: result.lessons.map((l) => ({
      id: l.id,
      rule: `${l.title}. ${l.rule}`,
      evidence: l.citations,
      seeded: !!l.seeded,
    })),
    permissionsVerified: requester.permissionsVerified,
    note: [
      requester.permissionsVerified
        ? ''
        : "Lorehive could not verify this user's access, so only seeded demo lessons can be returned. Real lessons may exist. The user may need to approve this app at https://id.atlassian.com/manage-profile/apps.",
      result.lessons.length
        ? 'Follow these organisation lessons. After finishing, call report_outcome with the lesson ids you applied.'
        : 'No lessons were found for this task.',
    ]
      .filter(Boolean)
      .join(' '),
  };
}

export async function reportOutcomeAction(
  payload: { lessonIds: string; outcome: string; repo?: string; details?: string },
  context: ActionContext,
) {
  const ids = String(payload.lessonIds ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const outcome = /fail|wrong|harm|conflict/i.test(payload.outcome) ? 'failed' : 'helped';
  // Outcome reports are measured, but are never promotion evidence.
  await engine().log('outcome.reported', ids.join(',') || 'none', {
    outcome,
    repo: payload.repo,
    reporter: context.accountId,
  });
  return `Recorded: ${ids.length} lesson(s) ${outcome}. Thank you.`;
}

function describe(l: Lesson) {
  return {
    id: l.id,
    title: l.title,
    rule: l.rule,
    status: l.status,
    rationale: l.rationale,
    validFrom: l.validFrom,
    validTo: l.validTo,
    supersededBy: l.supersededBy,
    supersedes: l.supersedes,
    retiredReason: l.retiredReason,
    evidence: l.citations,
    seeded: !!l.seeded,
  };
}

export async function listLessonsAction(payload: { query?: string; status?: string }) {
  const q = (payload.query ?? '').toLowerCase();
  const lessons = (await store.listLessons())
    .filter((l) => !payload.status || l.status === payload.status)
    .filter((l) => !q || `${l.title} ${l.rule} ${l.topic}`.toLowerCase().includes(q));
  return { lessons: lessons.slice(0, 20).map(describe) };
}

/** "Why did our agents start doing X?" - the full evidence chain for a lesson. */
export async function explainLessonAction(payload: { lessonId?: string; query?: string }) {
  const all = await store.listLessons();
  const q = (payload.query ?? '').toLowerCase();
  const lesson =
    all.find((l) => l.id === payload.lessonId) ??
    all.find((l) => q && `${l.title} ${l.rule} ${l.topic}`.toLowerCase().includes(q));
  if (!lesson) return 'No matching lesson found.';
  const evidence = await store.evidenceByTopic(lesson.topic, !!lesson.seeded);
  const decision = evaluateTopic(lesson.topic, evidence);
  return {
    lesson: describe(lesson),
    evidenceChain: evidence.map((e) => {
      const v = decision.verdicts.find((x) => x.evidenceId === e.id);
      return {
        when: e.occurredAt,
        what: e.summary,
        where: e.scope.repo ?? e.scope.project,
        link: e.url,
        counted: !!v?.counted,
        reason: v && !v.counted ? REJECT_LABELS[v.reason] : COUNTED_LABEL,
        seeded: !!e.seeded,
      };
    }),
    promotion: explainDecision(decision),
  };
}

/**
 * The Librarian can only *propose* a veto; an admin confirms it in the console.
 * One chat message must not be able to remove a lesson the quorum promoted.
 */
export async function proposeVetoAction(payload: { lessonId: string; reason: string }, context: ActionContext) {
  const lesson = await store.getLesson(payload.lessonId);
  if (!lesson) return `No lesson ${payload.lessonId}.`;
  await store.setMeta(
    `veto-proposal:${lesson.id}`,
    JSON.stringify({ by: context.accountId, reason: String(payload.reason ?? '').slice(0, 500), at: new Date().toISOString() }),
  );
  return `Veto proposed for "${lesson.title}". A Lorehive admin will review it in the console.`;
}
