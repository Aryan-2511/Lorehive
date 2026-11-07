/**
 * GitHub adapter (pure parts): webhook signature check, app JWT, diff parsing
 * and turning fetched GitHub data into CorrectionSignals.
 * Network calls live in src/forge/github-client.ts.
 */
import { createHmac, createSign, timingSafeEqual } from 'node:crypto';
import { CorrectionSignal, identifyAgent, toActor } from '../core/harvest';
import { topicFor } from '../core/topic';
import { ChangeSummary } from '../core/types';

export function verifySignature(secret: string, rawBody: string, header: string | undefined): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = Buffer.from('sha256=' + createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex'));
  const got = Buffer.from(header);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/** GitHub App JWT (RS256), valid for 9 minutes. */
export function appJwt(appId: string, privateKeyPem: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: appId }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${b64url(signer.sign(privateKeyPem))}`;
}

export interface GhFile {
  filename: string;
  patch?: string;
}

export function changeFromFiles(files: GhFile[]): ChangeSummary {
  const removed: string[] = [];
  const added: string[] = [];
  for (const f of files) {
    for (const line of (f.patch ?? '').split('\n')) {
      if (line.startsWith('+++') || line.startsWith('---')) continue;
      if (line.startsWith('+')) added.push(line.slice(1));
      else if (line.startsWith('-')) removed.push(line.slice(1));
    }
  }
  return { files: files.map((f) => f.filename), removed: removed.slice(0, 200), added: added.slice(0, 200) };
}

export interface GhUser {
  login: string;
  type?: string; // "Bot" | "User"
  created_at?: string;
}

export function ghActor(u: GhUser, now = Date.now()) {
  const age = u.created_at ? Math.floor((now - Date.parse(u.created_at)) / 86_400_000) : undefined;
  const a = toActor(u.login, age !== undefined ? { accountAgeDays: age } : {});
  if (u.type === 'Bot') a.isAgent = true;
  return a;
}

/** "Reverts owner/repo#123" or "This reverts commit ..." */
export function revertedPrNumber(title: string, body: string | null | undefined): number | undefined {
  if (!/^Revert\s+"/.test(title)) return undefined;
  const m = /Reverts\s+[\w.-]+\/[\w.-]+#(\d+)/.exec(body ?? '');
  return m ? Number(m[1]) : undefined;
}

export interface FixupContext {
  repoFullName: string;
  pr: { number: number; html_url: string; user: GhUser };
  commit: { sha: string; html_url: string; message: string; author: GhUser; date: string; files: GhFile[] };
  /** reviews on this PR, used to detect agent-to-agent findings */
  reviews: Array<{ user: GhUser; path?: string }>;
  languages?: string[];
}

/** Human commit on an agent PR: a fix-up, or an accepted review finding if another vendor's reviewer flagged that file. */
export function fixupSignal(ctx: FixupContext): CorrectionSignal | null {
  const prAuthor = ghActor(ctx.pr.user);
  const committer = ghActor(ctx.commit.author);
  if (!prAuthor.isAgent || committer.isAgent) return null;
  const change = changeFromFiles(ctx.commit.files);
  const scope = { repo: `github:${ctx.repoFullName}`, languages: ctx.languages };
  const reviewer = ctx.reviews.find(
    (r) => identifyAgent(r.user.login) && identifyAgent(r.user.login) !== prAuthor.vendor && (!r.path || change.files.includes(r.path)),
  );
  if (reviewer) {
    return {
      type: 'review_finding_fixed',
      source: 'github',
      scope,
      reviewer: ghActor(reviewer.user),
      prAuthor,
      acceptedBy: committer,
      // category comes from the structured diff, never from the review comment text
      findingCategory: topicFor(change).replace(/[^a-zA-Z0-9@/._-]+/g, '-'),
      change,
      url: ctx.pr.html_url,
      at: ctx.commit.date,
    };
  }
  return {
    type: 'commit_on_agent_pr',
    source: 'github',
    scope,
    prAuthor,
    committer,
    commitMessage: ctx.commit.message,
    change,
    url: ctx.commit.html_url,
    at: ctx.commit.date,
  };
}

export interface RevertContext {
  repoFullName: string;
  revertPr: { html_url: string; merged_by?: GhUser; user: GhUser; merged_at: string };
  originalPr: { user: GhUser };
  files: GhFile[];
  languages?: string[];
}

export function revertSignal(ctx: RevertContext): CorrectionSignal | null {
  const original = ghActor(ctx.originalPr.user);
  const reverter = ghActor(ctx.revertPr.merged_by ?? ctx.revertPr.user);
  if (!original.isAgent || reverter.isAgent) return null;
  return {
    type: 'revert_of_agent_change',
    source: 'github',
    scope: { repo: `github:${ctx.repoFullName}`, languages: ctx.languages },
    originalAuthor: original,
    reverter,
    change: changeFromFiles(ctx.files),
    url: ctx.revertPr.html_url,
    at: ctx.revertPr.merged_at,
  };
}
