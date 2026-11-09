import type { AsyncEvent } from '@forge/events';
import { handleGithubJob } from './github-handlers';
import { engine, repoConfigs, store } from './runtime';
import { GitHub } from './github-client';
import { TARGETS, TargetFormat } from '../core/compile';
import { RepoActivity } from '../core/efficacy';
import { Lesson } from '../core/types';
import { seededActivity } from '../demo/seed';

export async function harvestConsumer(event: AsyncEvent) {
  const body = event.body as { source: string };
  if (body.source === 'github') await handleGithubJob(body as Parameters<typeof handleGithubJob>[0]);
}

/** Recompile instruction files for every connected repo and open/update the Lorehive PR. */
export async function propagateConsumer(event: AsyncEvent) {
  const { reason, lessonId } = event.body as { reason: string; lessonId: string };
  const e = engine();
  for (const cfg of await repoConfigs()) {
    if (!cfg.autoPr || !cfg.repo.startsWith('github:') || !cfg.installationId) continue; // Bitbucket auto-PR: planned
    const repo = cfg.repo.slice('github:'.length);
    const gh = new GitHub(cfg.installationId);
    const current: Partial<Record<TargetFormat, string>> = {};
    for (const f of cfg.formats) current[f] = (await gh.readFile(repo, TARGETS[f].path))?.content;
    const { rev, files } = await e.compileRepo(cfg.repo, current, cfg.formats, { project: cfg.project });
    // compileRepo returns files in the same order as cfg.formats
    const changed = files.filter((f, i) => f.content !== current[cfg.formats[i]!]);
    if (!changed.length) continue;
    await gh.openLessonPr(
      repo,
      changed.map((f) => ({ path: f.path, content: f.content })),
      `Lorehive: lessons rev ${rev}`,
      [
        `Lorehive updated the managed lesson block (${reason} ${lessonId}).`,
        '',
        ...changed.map((f) => `- \`${f.path}\`: ${f.compiled.included.length} lessons, ${f.compiled.bytes}/${f.compiled.budget} bytes${f.compiled.omitted.length ? `, ${f.compiled.omitted.length} served via lessons_for` : ''}`),
        '',
        'Edits to the block outside this PR are blocked by the Lorehive check.',
      ].join('\n'),
    );
  }
}

/** Real (non-demo) activity: agent PR counters and new evidence on the topic since validFrom. */
async function liveActivity(l: Lesson): Promise<RepoActivity[]> {
  const evidence = (await store.evidenceByTopic(l.topic)).filter((e) => !l.validFrom || e.occurredAt > l.validFrom);
  const out: RepoActivity[] = [];
  for (const cfg of await repoConfigs()) {
    out.push({
      repo: cfg.repo,
      agentPrs: Number((await store.getMeta(`prs:${cfg.repo}`)) ?? '0'),
      recurrences: evidence.filter((e) => e.scope.repo === cfg.repo).length,
    });
  }
  return out;
}

/** Hourly: re-evaluate candidates (policy may have changed) and measure efficacy. */
export async function scheduledDistil() {
  const demo = (await store.getMeta('demo')) === 'on';
  const e = engine({ demo });
  for (const l of await store.listLessons()) if (l.status === 'candidate') await e.evaluate(l.topic);
  await e.measureAll(async (l) => (l.seeded ? seededActivity(l.topic) : liveActivity(l)));
}
