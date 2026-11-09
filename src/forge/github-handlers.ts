/**
 * GitHub delivery path:
 *  - webhook (web trigger, 55 s limit): verify signature, enqueue, return 202
 *  - harvest consumer (async, up to 900 s): fetch details, emit evidence, guard PRs
 */
import type { WebTriggerRequest, WebTriggerResponse } from '@forge/api';
import { fixupSignal, GhFile, GhUser, isFixupCandidate, revertedPrNumber, revertSignal, verifySignature, changeFromFiles } from '../adapters/github';
import { identifyAgent } from '../core/harvest';
import { guardChanges, checkAddedLines } from '../core/guard';
import { TARGETS } from '../core/compile';
import { GitHub, LESSON_BRANCH } from './github-client';
import { engine, queues, registerGithubRepo, store } from './runtime';

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
  if (!secret || !verifySignature(secret, raw, header(req, 'x-hub-signature-256'))) {
    console.warn(`GitHub webhook rejected: ${secret ? 'signature does not match GITHUB_WEBHOOK_SECRET' : 'GITHUB_WEBHOOK_SECRET is not set'}`);
    return reply(401, 'bad signature');
  }

  const event = header(req, 'x-github-event') ?? 'unknown';
  console.log(`GitHub webhook: ${event} (delivery ${header(req, 'x-github-delivery') ?? '?'})`);
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
    sender: p.sender?.login,
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
  sender?: string;
  commits: string[];
}

type Pr = { number: number; state: string; html_url: string; title: string; body: string | null; user: GhUser; merged_by?: GhUser; merged_at: string | null; head: { sha: string; ref: string } };

/** Full profile, for account age. Webhook and PR payloads don't include created_at. */
async function fullUser(gh: GitHub, login: string): Promise<GhUser> {
  if (login.endsWith('[bot]')) return { login, type: 'Bot' };
  return gh.get<GhUser>(`/users/${encodeURIComponent(login)}`);
}

export async function handleGithubJob(job: GhJob) {
  console.log(`GitHub job: ${job.event}${job.action ? `/${job.action}` : ''} on ${job.repo}, ${job.commits.length} commit(s)`);
  const gh = new GitHub(job.installationId);
  const e = engine();
  await registerGithubRepo(job.repo, job.installationId);

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
        if (orig.head.ref === LESSON_BRANCH) return;
        const files = await gh.get<GhFile[]>(`/repos/${job.repo}/pulls/${job.prNumber}/files`);
        const mergedBy = pr.merged_by && (await fullUser(gh, pr.merged_by.login));
        const signal = revertSignal({ repoFullName: job.repo, revertPr: { ...pr, merged_by: mergedBy, merged_at: pr.merged_at }, originalPr: orig, files });
        if (signal) await e.ingest(signal);
      }
    }
  }

  if (job.event === 'push' && job.ref?.startsWith('refs/heads/') && job.sender) {
    const pusher = await fullUser(gh, job.sender);
    for (const sha of job.commits) {
      const pulls = await gh.get<Pr[]>(`/repos/${job.repo}/commits/${sha}/pulls`);
      // Lorehive's own lesson PR is opened by a bot too, but editing it doesn't correct an agent.
      const pr = pulls.find((p) => (identifyAgent(p.user.login) || p.user.login.endsWith('[bot]')) && p.head.ref !== LESSON_BRANCH);
      if (!pr) continue;
      const commit = await gh.get<{ sha: string; html_url: string; commit: { message: string; author: { date: string } }; author: GhUser | null; parents: unknown[]; files: GhFile[] }>(
        `/repos/${job.repo}/commits/${sha}`,
      );
      if (!commit.author || !isFixupCandidate(job.ref, pr, commit.parents.length)) continue;
      const reviews = await gh.get<Array<{ user: GhUser; path?: string }>>(`/repos/${job.repo}/pulls/${pr.number}/comments`);
      const signal = fixupSignal({
        repoFullName: job.repo,
        pr,
        commit: { sha, html_url: commit.html_url, message: commit.commit.message, author: commit.author, date: commit.commit.author.date, files: commit.files },
        reviews,
        pusher,
      });
      if (signal) await e.ingest(signal);
    }
  }
}

/** GitHub check run: Lorehive block integrity + compiled lesson checks. */
async function guardPr(gh: GitHub, repo: string, pr: Pr) {
  const files = await gh.get<Array<GhFile & { status: string }>>(`/repos/${repo}/pulls/${pr.number}/files`);
  const managed = new Set(Object.values(TARGETS).map((t) => t.path));
  const isLorehivePr = pr.head.ref === LESSON_BRANCH;
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

  const lessons = (await store.listLessons()).filter((l) => l.status === 'promoted' && l.check && !l.seeded);
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
