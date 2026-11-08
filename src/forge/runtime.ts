/** Shared wiring for Forge handlers. */
import { Queue } from '@forge/events';
import api, { route } from '@forge/api';
import { Engine } from '../core/engine';
import { SqlStore } from '../store/sql';
import { llmWriter } from './llm';
import { buildRequester } from '../core/retrieve';

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

/** Jira projects the user can browse, or undefined if that can't be checked. */
async function browsableProjects(): Promise<Set<string> | undefined> {
  try {
    const res = await api.asUser().requestJira(route`/rest/api/3/project/search?maxResults=100`);
    if (!res.ok) {
      console.warn(`Could not check the user's Jira projects: ${res.status}`);
      return undefined;
    }
    const body = (await res.json()) as { values: Array<{ key: string }> };
    return new Set(body.values.map((p) => p.key));
  } catch (err) {
    // External MCP clients can land here until the user has an app consent entry.
    console.warn("Could not check the user's Jira projects", err);
    return undefined;
  }
}

/**
 * What the requesting user can see right now: Jira projects they can browse
 * (asked as the user), repos owned by those projects, and seeded demo data.
 */
export async function requesterFor() {
  const demo = (await store.getMeta('demo')) === 'on';
  const seeded = demo ? await import('../demo/seed') : undefined;
  return buildRequester(
    await browsableProjects(),
    await repoConfigs(),
    seeded && { repos: seeded.DEMO_REPOS, projects: seeded.DEMO_PROJECTS },
  );
}
