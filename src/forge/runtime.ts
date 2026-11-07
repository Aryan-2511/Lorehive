/** Shared wiring for Forge handlers. */
import { Queue } from '@forge/events';
import api, { route } from '@forge/api';
import { Engine } from '../core/engine';
import { SqlStore } from '../store/sql';
import { llmWriter } from './llm';
import { Requester } from '../core/retrieve';

export const store = new SqlStore();

export const queues = {
  harvest: new Queue({ key: 'lorehive-harvest' }),
  propagate: new Queue({ key: 'lorehive-propagate' }),
};

export function engine(opts: { demo?: boolean } = {}) {
  return new Engine(store, {
    // Demo mode uses the deterministic writer so the scripted story is repeatable.
    writer: opts.demo ? undefined : llmWriter,
    onEvent: async (type, subject) => {
      if (type === 'lesson.promoted' || type === 'lesson.superseded' || type === 'lesson.retired' || type === 'lesson.vetoed') {
        await queues.propagate.push({ body: { reason: type, lessonId: subject } });
      }
    },
  });
}

export interface RepoConfig {
  repo: string; // "github:owner/name" | "bitbucket:workspace/name"
  installationId?: number; // GitHub App installation
  project?: string; // owning Jira project, used for permission filtering
  formats: Array<'agents-md' | 'copilot' | 'claude' | 'cursor'>;
}

export async function repoConfigs(): Promise<RepoConfig[]> {
  const raw = await store.getMeta('config:repos');
  return raw ? (JSON.parse(raw) as RepoConfig[]) : [];
}

/**
 * What the requesting user can see right now: Jira projects they can browse
 * (asked as the user), and repos whose owning project is one of those.
 */
export async function requesterFor(): Promise<Requester> {
  const res = await api.asUser().requestJira(route`/rest/api/3/project/search?maxResults=100`);
  if (!res.ok) return { accessibleProjects: new Set(), accessibleRepos: new Set() };
  const body = (await res.json()) as { values: Array<{ key: string }> };
  const projects = new Set(body.values.map((p) => p.key));
  const repos = (await repoConfigs()).filter((r) => !r.project || projects.has(r.project)).map((r) => r.repo);
  const demo = (await store.getMeta('demo')) === 'on';
  // In demo mode seeded repos are visible to everyone.
  if (demo) {
    const { DEMO_REPOS } = await import('../demo/seed');
    DEMO_REPOS.forEach((r) => repos.push(r));
  }
  return { accessibleProjects: demo ? undefined : projects, accessibleRepos: new Set(repos) };
}
