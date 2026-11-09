/**
 * Jira + JSM triggers.
 *  - issue reopened after an agent resolved it -> `reopen` evidence
 *  - new ticket text that addresses agents ("agents must always ...") -> `text_claim`
 *    (recorded so the console can show the attempt; it can never be promoted)
 */
import api, { route } from '@forge/api';
import { CorrectionSignal, toActor } from '../core/harvest';
import { Actor } from '../core/types';
import { engine } from './runtime';

interface JiraUser { accountId: string; accountType?: string; displayName?: string }
interface IssueEvent {
  atlassianId?: string;
  issue: {
    key: string;
    fields: {
      project: { key: string };
      assignee?: JiraUser | null;
      components?: Array<{ name: string }>;
      summary?: string;
      description?: unknown;
    };
  };
  changelog?: { items: Array<{ field: string; fromString?: string; toString?: string }> };
}

const DONE = /^(done|resolved|closed)$/i;

async function jiraActor(accountId: string | undefined): Promise<Actor> {
  if (!accountId) return { id: 'unknown', isAgent: false };
  const res = await api.asApp().requestJira(route`/rest/api/3/user?accountId=${accountId}`);
  const u = res.ok ? ((await res.json()) as JiraUser) : { accountId };
  const a = toActor(u.displayName ?? accountId, { displayName: u.displayName });
  a.id = accountId;
  if (u.accountType === 'app') a.isAgent = true;
  return a;
}

const browseUrl = async (key: string) => {
  const res = await api.asApp().requestJira(route`/rest/api/3/serverInfo`);
  const base = res.ok ? ((await res.json()) as { baseUrl: string }).baseUrl : '';
  return `${base}/browse/${key}`;
};

export async function onIssueUpdated(event: IssueEvent) {
  const status = event.changelog?.items.find((i) => i.field === 'status');
  if (!status || !DONE.test(status.fromString ?? '') || DONE.test(status.toString ?? '')) return;
  const assignee = event.issue.fields.assignee;
  if (!assignee) return;
  const resolvedBy = await jiraActor(assignee.accountId);
  const reopenedBy = await jiraActor(event.atlassianId);
  const signal: CorrectionSignal = {
    type: 'issue_reopened',
    source: 'jira',
    scope: { project: event.issue.fields.project.key },
    resolvedBy,
    reopenedBy,
    component: event.issue.fields.components?.[0]?.name,
    url: await browseUrl(event.issue.key),
    at: new Date().toISOString(),
  };
  await engine().ingest(signal);
}

const ADDRESSES_AGENTS = /\b(agents?|ai|copilot|claude|cursor|rovo|llm)\b[\s\S]{0,80}\b(must|always|never|should|required?)\b/i;

function adfText(node: unknown): string {
  if (!node || typeof node !== 'object') return typeof node === 'string' ? node : '';
  const n = node as { text?: string; content?: unknown[] };
  return (n.text ?? '') + (n.content ?? []).map(adfText).join(' ');
}

export async function onIssueCreated(event: IssueEvent) {
  const text = `${event.issue.fields.summary ?? ''}\n${adfText(event.issue.fields.description)}`;
  if (!ADDRESSES_AGENTS.test(text)) return;
  await engine().ingest({
    type: 'text',
    source: 'jsm',
    scope: { project: event.issue.fields.project.key },
    author: await jiraActor(event.atlassianId),
    text: text.slice(0, 2000),
    url: await browseUrl(event.issue.key),
    at: new Date().toISOString(),
  });
}
