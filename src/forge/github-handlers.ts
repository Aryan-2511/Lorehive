/**
 * GitHub delivery path:
 *  - webhook (web trigger, 55 s limit): verify signature, enqueue, return 202
 *  - harvest consumer (async, up to 900 s): fetch details, emit evidence, guard PRs
 */
import type { WebTriggerRequest, WebTriggerResponse } from '@forge/api';
import { fixupSignal, GhFile, GhUser, revertedPrNumber, revertSignal, verifySignature, changeFromFiles } from '../adapters/github';
import { identifyAgent } from '../core/harvest';
import { guardChanges, checkAddedLines } from '../core/guard';
import { TARGETS } from '../core/compile';
import { GitHub } from './github-client';
import { engine, queues, store } from './runtime';

const header = (req: WebTriggerRequest, name: string) => {
  const h = req.headers?.[name.toLowerCase()];
  return Array.isArray(h) ? h[0] : (h as string | undefined);
};

const reply = (statusCode: number, body: string): WebTriggerResponse => ({
  statusCode,
  headers: { 'Content-Type': ['text/plain'] },
  body,
});

export async function githubWebhook(req: WebTriggerRequest): Promise<WebTriggerResponse> {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
  if (!secret || !verifySignature(secret, raw, header(req, 'x-hub-signature-256'))) return reply(401, 'bad signature');

  const event = header(req, 'x-github-event') ?? 'unknown';
  if (!['pull_request', 'push', 'ping'].includes(event)) return reply(202, 'ignored');
  if (event === 'ping') return reply(200, 'pong');

  const p = JSON.parse(raw);
  // Keep the queued body small: only what the consumer needs.
  const body = {
    source: 'github',
    event,
    installationId: p.installation?.id,
    repo: p.repository?.full_name,
    action: p.action,
    prNumber: p.pull_request?.number,
    ref: p.ref,
    commits: (p.commits ?? []).map((c: { id: string }) => c.id).slice(0, 20),
  };
  await queues.harvest.push({ body });
  return reply(202, 'queued');
}

interface GhJob {
  source: 'github';
  event: string;
  installationId: number;
  repo: string;
  action?: string;
  prNumber?: number;
  ref?: string;
  commits: string[];
}

type Pr = { number: number; html_url: string; title: string; body: string | null; user: GhUser; merged_by?: GhUser; merged_at: string | null; head: { sha: string; ref: string } };

export async function handleGithubJob(job: GhJob) {
  const gh = new GitHub(job.installationId);
  const e = engine();

  if (job.event === 'pull_request' && job.prNumber) {
    const pr = await gh.get<Pr>(`/repos/${job.repo}/pulls/${job.prNumber}`);

    if (job.action === 'opened' && identifyAgent(pr.user.login)) {
      const k = `prs:github:${job.repo}`;
      await store.setMeta(k, String(Number((await store.getMeta(k)) ?? '0') + 1));
    }

    if (['opened', 'synchronize', 'reopened'].includes(job.action ?? '')) await guardPr(gh, job.repo, pr);

    if (job.action === 'closed' && pr.merged_at) {
      const original = revertedPrNumber(pr.title, pr.body);
      if (original) {
        const orig = await gh.get<Pr>(`/repos/${job.repo}/pulls/${original}`);
        const files = await gh.get<GhFile[]>(`/repos/${job.repo}/pulls/${job.prNumber}/files`);
        const signal = revertSignal({ repoFullName: job.repo, revertPr: { ...pr, merged_at: pr.merged_at }, originalPr: orig, files });
        if (signal) await e.ingest(signal);
      }
    }
  }

  if (job.event === 'push' && job.ref?.startsWith('refs/heads/')) {
    for (const sha of job.commits) {
      const pulls = await gh.get<Pr[]>(`/repos/${job.repo}/commits/${sha}/pulls`);
      const pr = pulls.find((p) => identifyAgent(p.user.login) || p.user.login.endsWith('[bot]'));
      if (!pr) continue;
      const commit = await gh.get<{ sha: string; html_url: string; commit: { message: string; author: { date: string } }; author: GhUser | null; files: GhFile[] }>(
        `/repos/${job.repo}/commits/${sha}`,
      );
      if (!commit.author) continue;
      const reviews = await gh.get<Array<{ user: GhUser; path?: string }>>(`/repos/${job.repo}/pulls/${pr.number}/comments`);
      const signal = fixupSignal({
        repoFullName: job.repo,
        pr,
        commit: { sha, html_url: commit.html_url, message: commit.commit.message, author: commit.author, date: commit.commit.author.date, files: commit.files },
        reviews,
      });
      if (signal) await e.ingest(signal);
    }
  }
}

/** GitHub check run: Lorehive block integrity + compiled lesson checks. */
async function guardPr(gh: GitHub, repo: string, pr: Pr) {
  const files = await gh.get<Array<GhFile & { status: string }>>(`/repos/${repo}/pulls/${pr.number}/files`);
  const managed = new Set(Object.values(TARGETS).map((t) => t.path));
  const isLorehivePr = pr.head.ref === 'lorehive/lessons';
  const changed = files.filter((f) => managed.has(f.filename));
  const repoKey = `github:${repo}`;

  const guardInputs = await Promise.all(
    changed.map(async (f) => ({
      path: f.filename,
      before: (await gh.readFile(repo, f.filename))?.content,
      after: f.status === 'removed' ? undefined : (await gh.readFile(repo, f.filename, pr.head.sha))?.content,
    })),
  );
  const guard = guardChanges(guardInputs, await store.issuedShas(repoKey));

  const lessons = (await store.listLessons()).filter((l) => l.status === 'promoted' && l.check);
  const violations = checkAddedLines(
    files.map((f) => ({ path: f.filename, added: changeFromFiles([f]).added })),
    lessons.map((l) => ({ lessonId: l.id, ...l.check! })),
  );

  const ok = guard.ok && violations.length === 0;
  const summary = [
    guard.message + (isLorehivePr ? ' (Lorehive PR)' : ''),
    ...violations.map((v) => `- \`${v.path}\`: ${v.message} [${v.lessonId}]`),
  ].join('\n');
  await gh.checkRun(repo, pr.head.sha, ok, ok ? 'Lorehive: OK' : guard.ok ? 'Lorehive lesson violated' : 'Unmanaged edit to Lorehive block', summary);
  if (!guard.ok) await engine().log('guard.blocked', repoKey, { pr: pr.html_url, message: guard.message });
}
