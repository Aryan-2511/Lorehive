/**
 * Compile lessons into each vendor's native instruction file, inside a
 * hash-sealed managed block, within a size budget.
 *
 * Research ("Evaluating AGENTS.md", ICLR 2026) shows large context files hurt
 * agents, so static files carry only the highest-value lessons and point to
 * `lessons_for` for the rest.
 */
import { Lesson } from './types';
import { sha256 } from './hash';

export type TargetFormat = 'agents-md' | 'copilot' | 'claude' | 'cursor';

export interface Target {
  format: TargetFormat;
  path: string;
  /** byte budget for the managed block */
  budget: number;
}

export const TARGETS: Record<TargetFormat, Target> = {
  'agents-md': { format: 'agents-md', path: 'AGENTS.md', budget: 2000 },
  copilot: { format: 'copilot', path: '.github/copilot-instructions.md', budget: 1500 },
  claude: { format: 'claude', path: 'CLAUDE.md', budget: 2000 },
  cursor: { format: 'cursor', path: '.cursor/rules/lorehive.mdc', budget: 1500 },
};

export const BEGIN_RE = /<!-- lorehive:begin rev=(\d+) sha=([0-9a-f]{64}) -->\n/;
export const END_MARK = '<!-- lorehive:end -->';

export interface CompiledBlock {
  block: string;
  body: string;
  sha: string;
  included: string[]; // lesson ids
  omitted: string[];
  bytes: number;
  budget: number;
}

/** Ranking for the static file: more evidence and enforceable checks first. */
export function rankForStatic(lessons: Lesson[]): Lesson[] {
  return [...lessons].sort(
    (a, b) =>
      b.evidenceIds.length - a.evidenceIds.length ||
      Number(!!b.check) - Number(!!a.check) ||
      a.id.localeCompare(b.id),
  );
}

function line(l: Lesson): string {
  const cite = l.citations[0] ? ` ([evidence](${l.citations[0]}))` : '';
  return `- **${l.title}.** ${l.rule}${cite} \`${l.id}\``;
}

export function compileBlock(lessons: Lesson[], target: Target, rev: number): CompiledBlock {
  const active = rankForStatic(lessons.filter((l) => l.status === 'promoted'));
  const header =
    '## Lessons from your organisation\n' +
    '_Managed by Lorehive. Do not edit by hand: changes are blocked by a merge check. ' +
    'Ask the Librarian or use the `lessons_for` MCP tool for more._\n\n';
  const included: string[] = [];
  const omitted: string[] = [];
  let lines = '';
  // reserve room for the footer + markers (~200 bytes)
  const room = target.budget - Buffer.byteLength(header) - 200;
  for (const l of active) {
    const ln = line(l) + '\n';
    if (Buffer.byteLength(lines + ln) <= room) {
      lines += ln;
      included.push(l.id);
    } else {
      omitted.push(l.id);
    }
  }
  const footer = omitted.length
    ? `\n_${omitted.length} more lesson(s) available through \`lessons_for\`._\n`
    : '';
  const body = header + lines + footer;
  const sha = sha256(body);
  const block = `<!-- lorehive:begin rev=${rev} sha=${sha} -->\n${body}${END_MARK}`;
  return { block, body, sha, included, omitted, bytes: Buffer.byteLength(block), budget: target.budget };
}

export interface ParsedBlock {
  rev: number;
  declaredSha: string;
  body: string;
  start: number;
  end: number; // index after END_MARK
}

export function parseBlock(content: string): ParsedBlock | null {
  const m = BEGIN_RE.exec(content);
  if (!m || m.index === undefined) return null;
  const bodyStart = m.index + m[0].length;
  const endIdx = content.indexOf(END_MARK, bodyStart);
  if (endIdx < 0) return null;
  return {
    rev: Number(m[1]),
    declaredSha: m[2]!,
    body: content.slice(bodyStart, endIdx),
    start: m.index,
    end: endIdx + END_MARK.length,
  };
}

/** Insert or replace the managed block in a file, leaving human-written content intact. */
export function upsertBlock(existing: string | undefined, compiled: CompiledBlock, format: TargetFormat): string {
  if (format === 'cursor') {
    // Cursor rules: Lorehive owns the whole file.
    return `---\ndescription: Lessons from your organisation (Lorehive)\nalwaysApply: true\n---\n${compiled.block}\n`;
  }
  const src = existing ?? '';
  const parsed = parseBlock(src);
  if (parsed) return src.slice(0, parsed.start) + compiled.block + src.slice(parsed.end);
  const sep = src.length === 0 ? '' : src.endsWith('\n\n') ? '' : src.endsWith('\n') ? '\n' : '\n\n';
  return `${src}${sep}${compiled.block}\n`;
}
