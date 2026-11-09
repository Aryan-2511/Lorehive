/**
 * Guard: Lorehive's managed blocks have exactly one authorised writer.
 *
 * Used by the Bitbucket merge check and the GitHub check run. A change to a
 * managed block passes only if the new block is byte-for-byte one Lorehive
 * issued for this repo (its sha is in `issuedShas`) and its body still hashes
 * to the sha in its header.
 */
import { parseBlock } from './compile';
import { sha256 } from './hash';

export type GuardResult =
  | { ok: true; message: string }
  | { ok: false; code: 'unmanaged_edit' | 'block_removed' | 'tampered_seal' | 'unknown_revision'; message: string };

export function guardFile(
  path: string,
  before: string | undefined,
  after: string | undefined,
  issuedShas: ReadonlySet<string>,
): GuardResult {
  const b = before ? parseBlock(before) : null;
  const a = after ? parseBlock(after) : null;

  if (!b && !a) return { ok: true, message: `${path}: no Lorehive block` };
  if (b && !a) {
    return { ok: false, code: 'block_removed', message: `${path}: Lorehive block removed by an unmanaged edit` };
  }
  if (b && a && b.body === a.body && b.declaredSha === a.declaredSha) {
    return { ok: true, message: `${path}: Lorehive block unchanged` };
  }
  // block added or changed
  if (sha256(a!.body) !== a!.declaredSha) {
    return { ok: false, code: 'tampered_seal', message: `${path}: unmanaged edit to Lorehive block (seal does not match)` };
  }
  if (!issuedShas.has(a!.declaredSha)) {
    return { ok: false, code: 'unknown_revision', message: `${path}: unmanaged edit to Lorehive block (revision not issued by Lorehive)` };
  }
  return { ok: true, message: `${path}: Lorehive block rev ${a!.rev} verified` };
}

export function guardChanges(
  files: Array<{ path: string; before?: string; after?: string }>,
  issuedShas: ReadonlySet<string>,
): { ok: boolean; results: GuardResult[]; message: string } {
  const results = files.map((f) => guardFile(f.path, f.before, f.after, issuedShas));
  const failed = results.filter((r) => !r.ok);
  return {
    ok: failed.length === 0,
    results,
    message: failed.length ? failed.map((f) => f.message).join('; ') : 'Lorehive managed blocks verified',
  };
}

/** Run compiled lesson checks against added lines of a diff. */
export function checkAddedLines(
  files: Array<{ path: string; added: string[] }>,
  checks: Array<{ lessonId: string; forbid?: string; fileSuffix?: string[]; message: string }>,
): Array<{ lessonId: string; path: string; line: string; message: string }> {
  const out: Array<{ lessonId: string; path: string; line: string; message: string }> = [];
  for (const c of checks) {
    if (!c.forbid) continue;
    const re = new RegExp(c.forbid);
    for (const f of files) {
      if (c.fileSuffix && !c.fileSuffix.some((s) => f.path.endsWith(s))) continue;
      for (const line of f.added) if (re.test(line)) out.push({ lessonId: c.lessonId, path: f.path, line, message: c.message });
    }
  }
  return out;
}
