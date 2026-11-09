/**
 * Append-only, hash-chained ledger of everything Lorehive decides
 * (evidence recorded, promotions, vetoes, retirements, propagations).
 * Any edit to a past entry breaks the chain, which `verifyChain` detects.
 */
import { sha256 } from './hash';

export type LedgerType =
  | 'evidence.recorded'
  | 'lesson.promoted'
  | 'lesson.rejected'
  | 'lesson.superseded'
  | 'lesson.retired'
  | 'lesson.vetoed'
  | 'lesson.propagated'
  | 'guard.blocked'
  | 'outcome.reported';

export interface LedgerEntry {
  seq: number;
  at: string;
  type: LedgerType;
  subject: string; // lesson / evidence id
  payload: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export const GENESIS = '0'.repeat(64);

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

export function entryHash(e: Omit<LedgerEntry, 'hash'>): string {
  return sha256(canonical({ seq: e.seq, at: e.at, type: e.type, subject: e.subject, payload: e.payload, prevHash: e.prevHash }));
}

export function nextEntry(
  prev: LedgerEntry | undefined,
  type: LedgerType,
  subject: string,
  payload: Record<string, unknown>,
  at = new Date().toISOString(),
): LedgerEntry {
  const base = { seq: (prev?.seq ?? 0) + 1, at, type, subject, payload, prevHash: prev?.hash ?? GENESIS };
  return { ...base, hash: entryHash(base) };
}

/**
 * Verifies the entries given. A partial list (the latest N) is checked from its
 * own first entry, so it can't detect changes to anything older than that.
 */
export function verifyChain(entries: LedgerEntry[]): { ok: boolean; brokenAt?: number } {
  const sorted = [...entries].sort((a, b) => a.seq - b.seq);
  const first = sorted[0];
  let prev = first && first.seq > 1 ? first.prevHash : GENESIS;
  for (const e of sorted) {
    if (e.prevHash !== prev || entryHash(e) !== e.hash) return { ok: false, brokenAt: e.seq };
    prev = e.hash;
  }
  return { ok: true };
}
