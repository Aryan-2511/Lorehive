/**
 * Harvest: turn normalised platform events into Evidence.
 *
 * Platform adapters (GitHub webhook, Bitbucket trigger, Jira trigger) convert
 * their payloads into `CorrectionSignal`s; this module decides what kind of
 * evidence (if any) each signal is. Lessons are learned from actions, so a
 * signal is only action evidence when an agent's work was changed by a human.
 */
import { Actor, ChangeSummary, Evidence, Scope, SourceSystem, Vendor } from './types';
import { topicFor } from './topic';
import { hashId } from './hash';

/** Known agent accounts across systems. Extendable via config. */
const AGENT_PATTERNS: Array<{ re: RegExp; vendor: Vendor }> = [
  { re: /^copilot(-swe-agent)?(\[bot\])?$|^copilot-pull-request-reviewer/i, vendor: 'copilot' },
  { re: /^claude(\[bot\])?$|claude-code/i, vendor: 'claude' },
  { re: /^cursor(\[bot\])?$|cursor-agent/i, vendor: 'cursor' },
  { re: /rovo-dev/i, vendor: 'rovo-dev' },
  { re: /^rovo(\b|-agent)/i, vendor: 'rovo' },
];

export function identifyAgent(login: string, extra: Record<string, Vendor> = {}): Vendor | undefined {
  if (extra[login]) return extra[login];
  return AGENT_PATTERNS.find((p) => p.re.test(login))?.vendor;
}

export function toActor(login: string, opts: Partial<Actor> = {}, extra: Record<string, Vendor> = {}): Actor {
  const vendor = identifyAgent(login, extra);
  return { id: login, isAgent: vendor !== undefined || /\[bot\]$/.test(login), vendor, ...opts };
}

export type CorrectionSignal =
  | {
      type: 'commit_on_agent_pr';
      source: SourceSystem;
      scope: Scope;
      prAuthor: Actor;
      committer: Actor;
      commitMessage: string;
      change: ChangeSummary;
      url: string;
      at: string;
    }
  | {
      type: 'revert_of_agent_change';
      source: SourceSystem;
      scope: Scope;
      originalAuthor: Actor;
      reverter: Actor;
      change: ChangeSummary; // the revert's own diff: `removed` = the agent's lines
      url: string;
      at: string;
    }
  | {
      type: 'review_finding_fixed';
      source: SourceSystem;
      scope: Scope;
      reviewer: Actor; // reviewer agent
      prAuthor: Actor; // authoring agent
      acceptedBy: Actor; // human who accepted/applied the fix
      findingCategory: string; // structured category, e.g. "missing-tenant-check"
      change: ChangeSummary;
      url: string;
      at: string;
    }
  | {
      type: 'issue_reopened';
      source: SourceSystem;
      scope: Scope;
      resolvedBy: Actor;
      reopenedBy: Actor;
      component?: string;
      url: string;
      at: string;
    }
  | {
      type: 'agent_comment_edited';
      source: SourceSystem;
      scope: Scope;
      author: Actor;
      editor: Actor;
      change: ChangeSummary;
      url: string;
      at: string;
    }
  | {
      type: 'text';
      source: SourceSystem;
      scope: Scope;
      author: Actor;
      text: string;
      url: string;
      at: string;
    };

/** Words in a commit message that mark it as a corrective fix-up. */
const FIXUP_RE = /\b(fix(es|ed)?|fixup|correct(s|ed)?|revert|wrong|broken|regress|should|instead|missing|forgot)\b/i;

export function harvest(signal: CorrectionSignal, seeded = false): Evidence | null {
  const base = { source: signal.source, scope: signal.scope, url: signal.url, occurredAt: signal.at, seeded };
  const id = (kind: string) => hashId(`${kind}|${signal.url}|${signal.at}`);

  switch (signal.type) {
    case 'revert_of_agent_change': {
      if (!signal.originalAuthor.isAgent || signal.reverter.isAgent) return null;
      const topic = topicFor(signal.change);
      return {
        ...base,
        id: id('revert'),
        kind: 'revert',
        actor: signal.reverter,
        subjectAgent: signal.originalAuthor,
        change: signal.change,
        topic,
        summary: `${signal.reverter.id} reverted a ${vendorName(signal.originalAuthor)} change`,
      };
    }
    case 'commit_on_agent_pr': {
      if (!signal.prAuthor.isAgent || signal.committer.isAgent) return null;
      if (!FIXUP_RE.test(signal.commitMessage) && signal.change.removed.length === 0) return null;
      return {
        ...base,
        id: id('fixup'),
        kind: 'fixup',
        actor: signal.committer,
        subjectAgent: signal.prAuthor,
        change: signal.change,
        topic: topicFor(signal.change),
        summary: `${signal.committer.id} fixed up a ${vendorName(signal.prAuthor)} PR`,
      };
    }
    case 'review_finding_fixed': {
      if (!signal.reviewer.isAgent || !signal.prAuthor.isAgent || signal.acceptedBy.isAgent) return null;
      return {
        ...base,
        id: id('review'),
        kind: 'review_finding',
        actor: signal.acceptedBy,
        subjectAgent: signal.prAuthor,
        reviewerAgent: signal.reviewer,
        change: signal.change,
        topic: `review:${signal.findingCategory}`,
        summary: `${vendorName(signal.reviewer)} review flagged ${signal.findingCategory} in a ${vendorName(
          signal.prAuthor,
        )} PR; ${signal.acceptedBy.id} applied the fix`,
      };
    }
    case 'issue_reopened': {
      if (!signal.resolvedBy.isAgent || signal.reopenedBy.isAgent) return null;
      return {
        ...base,
        id: id('reopen'),
        kind: 'reopen',
        actor: signal.reopenedBy,
        subjectAgent: signal.resolvedBy,
        topic: `reopen:${signal.scope.project ?? 'unknown'}:${signal.component ?? 'general'}`,
        summary: `${signal.reopenedBy.id} reopened a ticket ${vendorName(signal.resolvedBy)} had resolved`,
      };
    }
    case 'agent_comment_edited': {
      if (!signal.author.isAgent || signal.editor.isAgent) return null;
      return {
        ...base,
        id: id('edit'),
        kind: 'human_edit',
        actor: signal.editor,
        subjectAgent: signal.author,
        change: signal.change,
        topic: topicFor(signal.change),
        summary: `${signal.editor.id} corrected an answer from ${vendorName(signal.author)}`,
      };
    }
    case 'text':
      // Recorded for transparency; can never be promoted (see promote.ts).
      return {
        ...base,
        id: id('text'),
        kind: 'text_claim',
        actor: signal.author,
        text: signal.text,
        topic: `text:${hashId(signal.text).slice(0, 8)}`,
        summary: `Text claim from ${signal.author.id} (recorded, never counted as evidence)`,
      };
  }
}

export function vendorName(a: Actor): string {
  const names: Record<Vendor, string> = {
    copilot: 'Copilot',
    claude: 'Claude',
    cursor: 'Cursor',
    rovo: 'Rovo',
    'rovo-dev': 'Rovo Dev',
    other: 'an agent',
  };
  return a.vendor ? names[a.vendor] : a.id;
}
