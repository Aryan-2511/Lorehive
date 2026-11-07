/**
 * Resolver for the Lorehive console (Custom UI). The console is an admin page,
 * so only site admins can call the mutating functions.
 */
import Resolver from '@forge/resolver';
import { evaluateTopic, REJECT_LABELS } from '../core/promote';
import { measure } from '../core/efficacy';
import { verifyChain } from '../core/ledger';
import { compileBlock, TARGETS } from '../core/compile';
import { DEMO_PROJECTS, DEMO_REPOS, DEMO_STEPS, FLEET, seededActivity } from '../demo/seed';
import { runDemoStep, runFullDemo } from '../demo/runner';
import { engine, repoConfigs, store } from './runtime';

const resolver = new Resolver();

resolver.define('getState', async () => {
  const [lessons, evidence, ledger, demo, repos] = await Promise.all([
    store.listLessons(),
    store.listEvidence(100),
    store.listLedger(100),
    store.getMeta('demo'),
    repoConfigs(),
  ]);

  const enriched = await Promise.all(
    lessons.map(async (l) => {
      const ev = evidence.filter((e) => e.topic === l.topic);
      const decision = evaluateTopic(l.topic, await store.evidenceByTopic(l.topic));
      const vetoProposal = await store.getMeta(`veto-proposal:${l.id}`);
      return {
        ...l,
        quorum: { people: decision.distinctActors.length, places: decision.distinctScopes.length, missing: decision.missing },
        verdicts: decision.verdicts.map((v) => ({ ...v, label: v.counted ? 'Counted' : REJECT_LABELS[v.reason] })),
        efficacy: l.seeded && l.status !== 'candidate' ? measure(l.canaryRepos ?? [], seededActivity(l.topic)) : undefined,
        vetoProposal: vetoProposal ? JSON.parse(vetoProposal) : undefined,
        evidenceCount: ev.length,
      };
    }),
  );

  const promoted = lessons.filter((l) => l.status === 'promoted');
  const budgets = Object.values(TARGETS).map((t) => {
    const c = compileBlock(promoted, t, 0);
    return { path: t.path, bytes: c.bytes, budget: t.budget, included: c.included.length, omitted: c.omitted.length };
  });

  return {
    demo: demo === 'on',
    fleet: demo === 'on'
      ? { agents: FLEET.map((f) => ({ id: f.agent.id, label: f.label, vendor: f.agent.vendor, repos: f.repos, projects: f.projects ?? [] })), repos: [...DEMO_REPOS], projects: [...DEMO_PROJECTS] }
      : { agents: [], repos: repos.map((r) => r.repo), projects: [...new Set(repos.map((r) => r.project).filter(Boolean))] },
    lessons: enriched,
    evidence,
    ledger,
    ledgerOk: verifyChain(ledger).ok,
    budgets,
    steps: DEMO_STEPS.map(({ id, title, narration }) => ({ id, title, narration })),
  };
});

resolver.define('runDemoStep', async ({ payload }) => {
  await store.setMeta('demo', 'on');
  const { step, results } = await runDemoStep(engine({ demo: true }), String(payload.stepId));
  return { step: step.id, results: results.map((r) => ({ kind: r.evidence?.kind, promoted: r.decision?.promote ?? false, missing: r.decision?.missing ?? [] })) };
});

resolver.define('runFullDemo', async () => {
  await runFullDemo(store, engine({ demo: true }));
  return { ok: true };
});

resolver.define('resetDemo', async () => {
  await store.clear();
  return { ok: true };
});

resolver.define('measureNow', async () => {
  const results = await engine({ demo: true }).measureAll(async (l) => seededActivity(l.topic));
  return results.map((r) => ({ id: r.lesson.id, verdict: r.result.verdict }));
});

resolver.define('veto', async ({ payload, context }) => {
  await engine().veto(String(payload.lessonId), context.accountId ?? 'admin', String(payload.reason ?? 'Vetoed by admin'));
  return { ok: true };
});

resolver.define('previewFile', async ({ payload }) => {
  const target = TARGETS[payload.format as keyof typeof TARGETS] ?? TARGETS['agents-md'];
  const lessons = (await store.listLessons()).filter((l) => l.status === 'promoted');
  return compileBlock(lessons, target, 1);
});

resolver.define('saveRepoConfig', async ({ payload }) => {
  await store.setMeta('config:repos', JSON.stringify(payload.repos ?? []));
  return { ok: true };
});

export const handler = resolver.getDefinitions();
