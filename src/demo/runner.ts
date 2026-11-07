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

export async function runFullDemo(store: Store, engine: Engine) {
  await store.clear();
  await store.setMeta('demo', 'on');
  for (const s of DEMO_STEPS) await runDemoStep(engine, s.id);
  const efficacy = await engine.measureAll(async (l) => seededActivity(l.topic));
  return { efficacy };
}
