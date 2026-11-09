/**
 * The Lorehive pipeline, independent of Forge:
 *
 *   signal -> harvest -> record (ledger) -> evaluate quorum -> distil/promote
 *          -> supersede older lessons -> (caller) propagate + measure
 *
 * Handlers in src/forge call these functions with a SqlStore; tests and demo
 * mode call them with any Store.
 */
import { Store } from '../store/store';
import { CorrectionSignal, harvest } from './harvest';
import { evaluateTopic, PromotionDecision } from './promote';
import { distil, lessonIdFor, LessonWriter, supersededBy, templateWriter } from './distill';
import { DEFAULT_POLICY, Evidence, Lesson, PromotionPolicy } from './types';
import { LedgerType, nextEntry } from './ledger';
import { compileBlock, TARGETS, TargetFormat, upsertBlock } from './compile';
import { appliesTo } from './retrieve';
import { measure, RepoActivity } from './efficacy';

export interface EngineOptions {
  policy?: PromotionPolicy;
  writer?: LessonWriter;
  now?: () => string;
  /** called for every ledger entry, e.g. to publish a Realtime event */
  onEvent?: (type: LedgerType, subject: string, payload: Record<string, unknown>) => Promise<void> | void;
}

export class Engine {
  constructor(private store: Store, private opts: EngineOptions = {}) {}

  private now() {
    return this.opts.now?.() ?? new Date().toISOString();
  }

  async log(type: LedgerType, subject: string, payload: Record<string, unknown>) {
    // Queue consumers run concurrently: if another writer takes this seq, rebuild on top of it.
    for (let attempt = 0; attempt < 10; attempt++) {
      const prev = await this.store.lastLedger();
      if (await this.store.appendLedger(nextEntry(prev, type, subject, payload, this.now()))) {
        await this.opts.onEvent?.(type, subject, payload);
        return;
      }
    }
    throw new Error(`Could not append ${type} to the ledger: too many concurrent writers`);
  }

  /** Harvest and record a signal. Returns the evidence (or null if the signal isn't evidence). */
  async ingest(signal: CorrectionSignal, seeded = false): Promise<{ evidence: Evidence | null; decision?: PromotionDecision; lesson?: Lesson }> {
    const evidence = harvest(signal, seeded);
    if (!evidence) return { evidence: null };
    return { evidence, ...(await this.record(evidence)) };
  }

  async record(evidence: Evidence): Promise<{ decision?: PromotionDecision; lesson?: Lesson }> {
    const fresh = await this.store.addEvidence(evidence);
    if (fresh) {
      await this.log('evidence.recorded', evidence.id, {
        kind: evidence.kind,
        topic: evidence.topic,
        scope: evidence.scope.repo ?? evidence.scope.project,
        actor: evidence.actor.id,
        url: evidence.url,
        seeded: !!evidence.seeded,
      });
    }
    // Still evaluate a repeat: a queue retry may follow a failure after the evidence was saved.
    if (!evidence.topic || evidence.kind === 'text_claim') return {};
    return this.evaluate(evidence.topic);
  }

  /** Re-evaluate a topic (also run by the scheduled distiller). */
  async evaluate(topic: string): Promise<{ decision: PromotionDecision; lesson?: Lesson }> {
    const evidence = await this.store.evidenceByTopic(topic);
    const decision = evaluateTopic(topic, evidence, this.opts.policy ?? DEFAULT_POLICY);
    const id = lessonIdFor(topic);
    const existing = await this.store.getLesson(id);

    // Retired / vetoed / superseded topics are never re-promoted automatically.
    if (existing && existing.status !== 'candidate') return { decision, lesson: existing };

    const counted = decision.verdicts.filter((v) => v.counted).map((v) => v.evidenceId);
    // Candidates use the template: the LLM is only billed for lessons that get promoted.
    const writer = decision.promote ? (this.opts.writer ?? templateWriter) : templateWriter;
    const draft = await distil(topic, evidence, counted, writer, this.now());

    if (!decision.promote) {
      const candidate: Lesson = { ...draft, status: 'candidate', citations: draft.citations };
      await this.store.saveLesson(candidate);
      if (!existing) await this.log('lesson.rejected', id, { topic, missing: decision.missing, counted: counted.length });
      return { decision, lesson: candidate };
    }

    await this.store.saveLesson(draft);
    await this.log('lesson.promoted', draft.id, {
      topic,
      title: draft.title,
      actors: decision.distinctActors,
      scopes: decision.distinctScopes,
      citations: draft.citations,
    });

    for (const old of supersededBy(draft, await this.store.listLessons())) {
      await this.store.saveLesson({ ...old, status: 'superseded', validTo: draft.validFrom, supersededBy: draft.id });
      await this.store.saveLesson({ ...draft, supersedes: old.id });
      draft.supersedes = old.id;
      await this.log('lesson.superseded', old.id, { by: draft.id });
    }
    return { decision, lesson: draft };
  }

  async veto(lessonId: string, by: string, reason: string) {
    const l = await this.store.getLesson(lessonId);
    if (!l) throw new Error(`No lesson ${lessonId}`);
    await this.store.saveLesson({ ...l, status: 'vetoed', validTo: this.now(), retiredReason: reason });
    await this.log('lesson.vetoed', lessonId, { by, reason });
  }

  /** Measure every promoted lesson and retire harmful ones. */
  async measureAll(activityFor: (l: Lesson) => Promise<RepoActivity[]>) {
    const out: Array<{ lesson: Lesson; result: ReturnType<typeof measure> }> = [];
    for (const l of await this.store.listLessons()) {
      if (l.status !== 'promoted') continue;
      const result = measure(l.canaryRepos ?? [], await activityFor(l));
      if (result.verdict === 'harmful') {
        await this.store.saveLesson({ ...l, status: 'retired', validTo: this.now(), retiredReason: 'Recurrence rose in canary repos' });
        await this.log('lesson.retired', l.id, { lift: result.lift, canaryRate: result.canaryRate, holdoutRate: result.holdoutRate });
      }
      out.push({ lesson: l, result });
    }
    return out;
  }

  /** Build the new contents of every instruction file for a repo and remember the issued seals. */
  async compileRepo(
    repo: string,
    current: Partial<Record<TargetFormat, string>>,
    formats: TargetFormat[],
    opts: { project?: string; includeSeeded?: boolean } = {},
  ) {
    // Seeded demo lessons must never be written into a real repo.
    const lessons = (await this.store.listLessons()).filter(
      (l) => l.status === 'promoted' && (opts.includeSeeded || !l.seeded) && appliesTo(l, { repo, project: opts.project }),
    );
    const rev = Number((await this.store.getMeta(`rev:${repo}`)) ?? '0') + 1;
    const files = [];
    for (const f of formats) {
      const target = TARGETS[f];
      const compiled = compileBlock(lessons, target, rev);
      files.push({ path: target.path, content: upsertBlock(current[f], compiled, f), compiled });
      await this.store.addIssuedSha(repo, compiled.sha);
    }
    await this.store.setMeta(`rev:${repo}`, String(rev));
    await this.log('lesson.propagated', repo, { rev, files: files.map((f) => ({ path: f.path, bytes: f.compiled.bytes, budget: f.compiled.budget, included: f.compiled.included.length, omitted: f.compiled.omitted.length })) });
    return { rev, files };
  }
}
