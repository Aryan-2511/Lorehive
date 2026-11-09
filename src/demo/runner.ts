import { Engine } from '../core/engine';
import { Store } from '../store/store';
import { DEMO_STEPS, seededActivity } from './seed';

export async function runDemoStep(engine: Engine, stepId: string) {
  const step = DEMO_STEPS.find((s) => s.id === stepId);
  if (!step) throw new Error(`Unknown demo step ${stepId}`);
  const results = [];
  for (const signal of step.signals) results.push(await engine.ingest(signal, true));
  return { step, results };
}

/** Clearing also wipes the ledger and repo config, so it's only allowed while everything is seeded. */
export async function resetDemo(store: Store) {
  const repos = JSON.parse((await store.getMeta('config:repos')) ?? '[]') as unknown[];
  const real = (await store.listEvidence(1000)).some((e) => !e.seeded);
  if (repos.length || real) {
    throw new Error('Reset is disabled because this site has connected repos or real evidence. You can still play the demo steps.');
  }
  await store.clear();
}

export async function runFullDemo(store: Store, engine: Engine) {
  await resetDemo(store);
  await store.setMeta('demo', 'on');
  for (const s of DEMO_STEPS) await runDemoStep(engine, s.id);
  const efficacy = await engine.measureAll(async (l) => seededActivity(l.topic));
  return { efficacy };
}
