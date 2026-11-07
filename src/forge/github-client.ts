/**
 * GitHub REST calls from Forge (egress allowed to api.github.com in the manifest).
 * Credentials come from Forge environment variables:
 *   GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY (PEM), GITHUB_WEBHOOK_SECRET
 */
import { fetch } from '@forge/api';
import { appJwt } from '../adapters/github';

const API = 'https://api.github.com';
const tokenCache = new Map<number, { token: string; exp: number }>();

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing Forge variable ${name}`);
  return name === 'GITHUB_APP_PRIVATE_KEY' ? v.replace(/\\n/g, '\n') : v;
}

async function installationToken(installationId: number): Promise<string> {
  const cached = tokenCache.get(installationId);
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const jwt = appJwt(env('GITHUB_APP_ID'), env('GITHUB_APP_PRIVATE_KEY'));
  const res = await fetch(`${API}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'User-Agent': 'lorehive-forge' },
  });
  if (!res.ok) throw new Error(`GitHub token exchange failed: ${res.status}`);
  const body = (await res.json()) as { token: string; expires_at: string };
  tokenCache.set(installationId, { token: body.token, exp: Date.parse(body.expires_at) });
  return body.token;
}

export class GitHub {
  constructor(private installationId: number) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await installationToken(this.installationId);
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'lorehive-forge',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`GitHub ${method} ${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  get<T>(path: string) {
    return this.request<T>('GET', path);
  }

  /** Read a file; undefined if it doesn't exist. */
  async readFile(repo: string, path: string, ref?: string): Promise<{ content: string; sha: string } | undefined> {
    try {
      const r = await this.get<{ content: string; sha: string }>(`/repos/${repo}/contents/${encodeURI(path)}${ref ? `?ref=${ref}` : ''}`);
      return { content: Buffer.from(r.content, 'base64').toString('utf8'), sha: r.sha };
    } catch (e) {
      if (String(e).includes('-> 404')) return undefined;
      throw e;
    }
  }

  /** Open (or update) the Lorehive auto-PR with the given file contents. */
  async openLessonPr(repo: string, files: Array<{ path: string; content: string }>, title: string, body: string) {
    const meta = await this.get<{ default_branch: string }>(`/repos/${repo}`);
    const base = meta.default_branch;
    const baseRef = await this.get<{ object: { sha: string } }>(`/repos/${repo}/git/ref/heads/${base}`);
    const branch = 'lorehive/lessons';
    try {
      await this.request('POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: baseRef.object.sha });
    } catch {
      await this.request('PATCH', `/repos/${repo}/git/refs/heads/${branch}`, { sha: baseRef.object.sha, force: true });
    }
    for (const f of files) {
      const existing = await this.readFile(repo, f.path, branch);
      await this.request('PUT', `/repos/${repo}/contents/${encodeURI(f.path)}`, {
        message: `lorehive: update ${f.path}`,
        content: Buffer.from(f.content, 'utf8').toString('base64'),
        branch,
        ...(existing ? { sha: existing.sha } : {}),
      });
    }
    const open = await this.get<Array<{ number: number; html_url: string }>>(`/repos/${repo}/pulls?head=${repo.split('/')[0]}:${branch}&state=open`);
    if (open[0]) return open[0];
    return this.request<{ number: number; html_url: string }>('POST', `/repos/${repo}/pulls`, { title, head: branch, base, body });
  }

  /** Post a check run (used for the guard and compiled lesson checks). */
  async checkRun(repo: string, headSha: string, ok: boolean, title: string, summary: string) {
    return this.request('POST', `/repos/${repo}/check-runs`, {
      name: 'Lorehive',
      head_sha: headSha,
      status: 'completed',
      conclusion: ok ? 'success' : 'failure',
      output: { title, summary },
    });
  }
}
