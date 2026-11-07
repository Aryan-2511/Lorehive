/**
 * Bitbucket merge check: blocks unmanaged edits to Lorehive blocks and code
 * that violates a compiled lesson check.
 */
import api, { route } from '@forge/api';
import { TARGETS } from '../core/compile';
import { checkAddedLines, guardChanges } from '../core/guard';
import { engine, store } from './runtime';

interface PRCheckEvent {
  workspace: { uuid: string };
  repository: { uuid: string };
  pullrequest: { id: number };
  trigger: { type: string };
}

async function bb<T>(path: ReturnType<typeof route>): Promise<T | undefined> {
  const res = await api.asApp().requestBitbucket(path);
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`Bitbucket ${res.status}`);
  const type = res.headers.get('content-type') ?? '';
  return (type.includes('json') ? await res.json() : await res.text()) as T;
}

export async function mergeCheck(event: PRCheckEvent) {
  const ws = event.workspace.uuid;
  const repo = event.repository.uuid;
  const pr = await bb<{
    source: { commit: { hash: string } };
    destination: { commit: { hash: string } };
    links: { html: { href: string } };
  }>(route`/2.0/repositories/${ws}/${repo}/pullrequests/${event.pullrequest.id}`);
  if (!pr) return { success: true, message: 'PR not found' };

  const repoInfo = await bb<{ full_name: string }>(route`/2.0/repositories/${ws}/${repo}`);
  const repoKey = `bitbucket:${repoInfo?.full_name ?? repo}`;
  const head = pr.source.commit.hash;
  const base = pr.destination.commit.hash;

  const managed = Object.values(TARGETS).map((t) => t.path);
  const inputs = await Promise.all(
    managed.map(async (path) => ({
      path,
      before: await bb<string>(route`/2.0/repositories/${ws}/${repo}/src/${base}/${path}`),
      after: await bb<string>(route`/2.0/repositories/${ws}/${repo}/src/${head}/${path}`),
    })),
  );
  const guard = guardChanges(inputs, await store.issuedShas(repoKey));
  if (!guard.ok) {
    await engine().log('guard.blocked', repoKey, { pr: pr.links.html.href, message: guard.message });
    return { success: false, message: guard.message };
  }

  const diff = (await bb<string>(route`/2.0/repositories/${ws}/${repo}/pullrequests/${event.pullrequest.id}/diff`)) ?? '';
  const files: Array<{ path: string; added: string[] }> = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) files.push({ path: line.slice(6), added: [] });
    else if (line.startsWith('+') && !line.startsWith('+++')) files[files.length - 1]?.added.push(line.slice(1));
  }
  const lessons = (await store.listLessons()).filter((l) => l.status === 'promoted' && l.check);
  const violations = checkAddedLines(files, lessons.map((l) => ({ lessonId: l.id, ...l.check! })));
  if (violations.length) {
    return { success: false, message: violations.map((v) => `${v.path}: ${v.message}`).join('; ').slice(0, 900) };
  }
  return { success: true, message: 'Lorehive: managed blocks verified, no lesson violations' };
}
