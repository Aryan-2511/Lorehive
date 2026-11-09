/**
 * Distil: write a lesson from the *structured* fields of its evidence.
 *
 * The template writer below is deterministic and is what tests and demo mode
 * use. The Forge LLM writer (src/forge/llm.ts) implements the same
 * `LessonWriter` interface and receives only `LessonDraftInput` (topic, files,
 * removed/added lines, counts) - never free text from tickets or comments, so
 * a prompt hidden in an issue body has no path into lesson text.
 */
import { Evidence, Lesson, LessonCheck } from './types';
import { preferredReplacement } from './topic';
import { hashId } from './hash';

export interface LessonDraftInput {
  topic: string;
  files: string[];
  removed: string[];
  added: string[];
  preferred?: string;
  kinds: string[];
  vendors: string[];
  scopes: string[];
}

export interface LessonText {
  title: string;
  rule: string;
  rationale: string;
}

export interface LessonWriter {
  write(input: LessonDraftInput): Promise<LessonText>;
}

export function draftInput(topic: string, evidence: Evidence[]): LessonDraftInput {
  const files = new Set<string>();
  const removed: string[] = [];
  const added: string[] = [];
  const vendors = new Set<string>();
  const scopes = new Set<string>();
  let preferred: string | undefined;
  for (const e of evidence) {
    e.change?.files.forEach((f) => files.add(f));
    if (e.change) {
      removed.push(...e.change.removed.slice(0, 5));
      added.push(...e.change.added.slice(0, 5));
      preferred ??= preferredReplacement(e.change);
    }
    if (e.subjectAgent?.vendor) vendors.add(e.subjectAgent.vendor);
    scopes.add(e.scope.repo ?? e.scope.project ?? 'unknown');
  }
  return {
    topic,
    files: [...files].slice(0, 10),
    removed: removed.slice(0, 10),
    added: added.slice(0, 10),
    preferred,
    kinds: [...new Set(evidence.map((e) => e.kind))],
    vendors: [...vendors],
    scopes: [...scopes],
  };
}

export const templateWriter: LessonWriter = {
  async write(i) {
    const who = i.vendors.length ? i.vendors.join(', ') : 'agents';
    const where = `${i.scopes.length} place(s)`;
    const [kind, subject] = splitTopic(i.topic);
    switch (kind) {
      case 'avoid':
        return {
          title: i.preferred ? `Use ${i.preferred} instead of ${subject}` : `Don't use ${subject}`,
          rule: i.preferred
            ? `Do not import \`${subject}\`. Use \`${i.preferred}\` instead.`
            : `Do not import \`${subject}\` in this codebase.`,
          rationale: `People corrected ${who} for using ${subject} in ${where}.`,
        };
      case 'prefer':
        return {
          title: `Use ${subject}`,
          rule: `Use \`${subject}\` for this kind of change.`,
          rationale: `People added ${subject} to ${who} work in ${where}.`,
        };
      case 'require':
        return {
          title: `Always set \`${subject}\``,
          rule: `Always set \`${subject}\` explicitly; agents omitted it and people had to add it.`,
          rationale: `Corrected in ${where}.`,
        };
      case 'review':
        return {
          title: `Check for ${subject.replace(/-/g, ' ')}`,
          rule: `Before opening a PR, check for ${subject.replace(/-/g, ' ')}. A reviewer agent flagged it and a person fixed it.`,
          rationale: `Review findings on ${who} PRs, accepted by people in ${where}.`,
        };
      case 'reopen':
        return {
          title: `Tickets in ${subject} get reopened`,
          rule: `When resolving ${subject} tickets, confirm the fix with the reporter before resolving; agent resolutions were reopened.`,
          rationale: `Reopened in ${where}.`,
        };
      default:
        return {
          title: `Recurring correction (${i.topic})`,
          rule: `People repeatedly changed agent output like this: removed \`${i.removed[0] ?? '?'}\`, added \`${i.added[0] ?? '?'}\`.`,
          rationale: `Seen in ${where}.`,
        };
    }
  },
};

function splitTopic(topic: string): [string, string] {
  const idx = topic.indexOf(':');
  return idx < 0 ? [topic, ''] : [topic.slice(0, idx), topic.slice(idx + 1)];
}

/** An enforceable check for topics that can be checked mechanically. */
export function checkFor(topic: string, input: LessonDraftInput): LessonCheck | undefined {
  const [kind, subject] = splitTopic(topic);
  if (kind !== 'avoid' || !subject) return undefined;
  const esc = subject.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const exts = [...new Set(input.files.map((f) => f.slice(f.lastIndexOf('.'))).filter((x) => x.startsWith('.')))];
  return {
    forbid: `(from\\s+['"]${esc}['"]|require\\(\\s*['"]${esc}['"]\\s*\\))`,
    fileSuffix: exts.length ? exts : undefined,
    message: input.preferred ? `Use ${input.preferred} instead of ${subject} (Lorehive lesson)` : `${subject} is not allowed (Lorehive lesson)`,
  };
}

export async function distil(
  topic: string,
  evidence: Evidence[],
  countedIds: string[],
  writer: LessonWriter = templateWriter,
  now = new Date().toISOString(),
): Promise<Lesson> {
  const counted = evidence.filter((e) => countedIds.includes(e.id));
  const input = draftInput(topic, counted);
  const text = await writer.write(input);
  const repos = [...new Set(counted.map((e) => e.scope.repo).filter((r): r is string => !!r))];
  const projects = [...new Set(counted.map((e) => e.scope.project).filter((p): p is string => !!p))];
  const languages = [...new Set(counted.flatMap((e) => e.scope.languages ?? []))];
  return {
    id: lessonIdFor(topic),
    topic,
    ...text,
    status: 'promoted',
    // Lessons learned in code apply across the fleet for the same language;
    // repos the evidence came from are recorded as the canary cohort.
    appliesTo: { repos: [], projects: repos.length ? [] : projects, languages, teams: [] },
    evidenceIds: counted.map((e) => e.id),
    citations: counted.map((e) => e.url),
    check: checkFor(topic, input),
    validFrom: counted[counted.length - 1]?.occurredAt ?? now,
    recordedAt: now,
    canaryRepos: repos,
    seeded: counted.some((e) => e.seeded),
  };
}

/** The import a lesson tells agents to use, if any. */
export function recommends(lesson: Lesson): string | undefined {
  const m = /Use `([^`]+)` instead/.exec(lesson.rule) ?? /^Use `([^`]+)`/.exec(lesson.rule);
  return m?.[1];
}

/**
 * Lessons a newly promoted lesson supersedes: if the new lesson says "avoid X"
 * and an older promoted lesson recommends X, the old one is superseded (kept,
 * with validTo set) rather than deleted.
 */
export function supersededBy(newLesson: Lesson, existing: Lesson[]): Lesson[] {
  const [kind, subject] = splitTopic(newLesson.topic);
  if (kind !== 'avoid') return [];
  return existing.filter(
    (l) => l.status === 'promoted' && l.id !== newLesson.id && recommends(l) === subject,
  );
}

/** Lesson ids are stable per topic so a candidate and its promotion share an id. */
export function lessonIdFor(topic: string): string {
  return `L-${hashId(topic).slice(0, 8)}`;
}
