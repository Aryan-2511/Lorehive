/**
 * Forge SQL implementation of the Store port.
 *
 * Indexed columns for the queries we run; the full record is kept as JSON in
 * `doc` so the domain model can evolve without a migration per field.
 * Lessons are bi-temporal: valid_from/valid_to (world time) and recorded_at
 * (Lorehive time).
 */
import { migrationRunner, sql } from '@forge/sql';
import { Evidence, Lesson } from '../core/types';
import { LedgerEntry } from '../core/ledger';
import { Store } from './store';

const MIGRATIONS: Array<[string, string]> = [
  [
    'v001_evidence',
    `CREATE TABLE IF NOT EXISTS evidence (
      id VARCHAR(32) PRIMARY KEY,
      topic VARCHAR(255),
      kind VARCHAR(32) NOT NULL,
      scope_key VARCHAR(255),
      actor VARCHAR(255),
      occurred_at VARCHAR(32) NOT NULL,
      seeded BOOLEAN DEFAULT FALSE,
      doc TEXT NOT NULL,
      KEY idx_evidence_topic (topic),
      KEY idx_evidence_time (occurred_at)
    )`,
  ],
  [
    'v002_lessons',
    `CREATE TABLE IF NOT EXISTS lessons (
      id VARCHAR(32) PRIMARY KEY,
      topic VARCHAR(255) NOT NULL,
      status VARCHAR(16) NOT NULL,
      valid_from VARCHAR(32),
      valid_to VARCHAR(32),
      recorded_at VARCHAR(32) NOT NULL,
      superseded_by VARCHAR(32),
      seeded BOOLEAN DEFAULT FALSE,
      doc TEXT NOT NULL,
      KEY idx_lessons_status (status)
    )`,
  ],
  [
    'v003_ledger',
    `CREATE TABLE IF NOT EXISTS ledger (
      seq BIGINT PRIMARY KEY,
      at VARCHAR(32) NOT NULL,
      type VARCHAR(32) NOT NULL,
      subject VARCHAR(255) NOT NULL,
      payload TEXT NOT NULL,
      prev_hash CHAR(64) NOT NULL,
      hash CHAR(64) NOT NULL
    )`,
  ],
  [
    'v004_seals',
    `CREATE TABLE IF NOT EXISTS issued_seals (
      repo VARCHAR(255) NOT NULL,
      sha CHAR(64) NOT NULL,
      PRIMARY KEY (repo, sha)
    )`,
  ],
  ['v005_meta', `CREATE TABLE IF NOT EXISTS meta (k VARCHAR(255) PRIMARY KEY, v TEXT NOT NULL)`],
];

let migrated = false;

export async function migrate(): Promise<string[]> {
  let runner = migrationRunner;
  for (const [name, ddl] of MIGRATIONS) runner = runner.enqueue(name, ddl);
  const applied = await runner.run();
  migrated = true;
  return applied;
}

async function ensure() {
  if (!migrated) await migrate();
}

const parse = <T>(rows: Array<{ doc: string }>): T[] => rows.map((r) => JSON.parse(r.doc) as T);

export class SqlStore implements Store {
  async addEvidence(e: Evidence) {
    await ensure();
    const res = await sql
      .prepare(
        `INSERT IGNORE INTO evidence (id, topic, kind, scope_key, actor, occurred_at, seeded, doc) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bindParams(e.id, e.topic ?? null, e.kind, e.scope.repo ?? e.scope.project ?? null, e.actor.id, e.occurredAt, !!e.seeded, JSON.stringify(e))
      .execute();
    return ((res.rows as unknown as { affectedRows?: number }).affectedRows ?? 0) > 0;
  }

  async evidenceByTopic(topic: string) {
    await ensure();
    const res = await sql.prepare<{ doc: string }>(`SELECT doc FROM evidence WHERE topic = ? ORDER BY occurred_at`).bindParams(topic).execute();
    return parse<Evidence>(res.rows);
  }

  async getEvidence(ids: string[]) {
    if (!ids.length) return [];
    await ensure();
    const res = await sql
      .prepare<{ doc: string }>(`SELECT doc FROM evidence WHERE id IN (${ids.map(() => '?').join(',')})`)
      .bindParams(...ids)
      .execute();
    return parse<Evidence>(res.rows);
  }

  async listEvidence(limit = 200) {
    await ensure();
    const res = await sql.prepare<{ doc: string }>(`SELECT doc FROM evidence ORDER BY occurred_at DESC LIMIT ?`).bindParams(limit).execute();
    return parse<Evidence>(res.rows);
  }

  async getLesson(id: string) {
    await ensure();
    const res = await sql.prepare<{ doc: string }>(`SELECT doc FROM lessons WHERE id = ?`).bindParams(id).execute();
    return parse<Lesson>(res.rows)[0];
  }

  async listLessons() {
    await ensure();
    const res = await sql.prepare<{ doc: string }>(`SELECT doc FROM lessons ORDER BY recorded_at`).execute();
    return parse<Lesson>(res.rows);
  }

  async saveLesson(l: Lesson) {
    await ensure();
    await sql
      .prepare(
        `INSERT INTO lessons (id, topic, status, valid_from, valid_to, recorded_at, superseded_by, seeded, doc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE status = VALUES(status), valid_from = VALUES(valid_from), valid_to = VALUES(valid_to),
           superseded_by = VALUES(superseded_by), doc = VALUES(doc)`,
      )
      .bindParams(l.id, l.topic, l.status, l.validFrom ?? null, l.validTo ?? null, l.recordedAt, l.supersededBy ?? null, !!l.seeded, JSON.stringify(l))
      .execute();
  }

  async lastLedger() {
    await ensure();
    const res = await sql
      .prepare<{ seq: number; at: string; type: string; subject: string; payload: string; prev_hash: string; hash: string }>(
        `SELECT * FROM ledger ORDER BY seq DESC LIMIT 1`,
      )
      .execute();
    const r = res.rows[0];
    return r && toEntry(r);
  }

  async appendLedger(e: LedgerEntry) {
    await ensure();
    await sql
      .prepare(`INSERT INTO ledger (seq, at, type, subject, payload, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bindParams(e.seq, e.at, e.type, e.subject, JSON.stringify(e.payload), e.prevHash, e.hash)
      .execute();
  }

  async listLedger(limit = 200) {
    await ensure();
    const res = await sql.prepare<LedgerRow>(`SELECT * FROM ledger ORDER BY seq DESC LIMIT ?`).bindParams(limit).execute();
    return res.rows.map(toEntry);
  }

  async addIssuedSha(repo: string, sha: string) {
    await ensure();
    await sql.prepare(`INSERT IGNORE INTO issued_seals (repo, sha) VALUES (?, ?)`).bindParams(repo, sha).execute();
  }

  async issuedShas(repo: string) {
    await ensure();
    const res = await sql.prepare<{ sha: string }>(`SELECT sha FROM issued_seals WHERE repo = ?`).bindParams(repo).execute();
    return new Set(res.rows.map((r) => r.sha));
  }

  async getMeta(k: string) {
    await ensure();
    const res = await sql.prepare<{ v: string }>(`SELECT v FROM meta WHERE k = ?`).bindParams(k).execute();
    return res.rows[0]?.v;
  }

  async setMeta(k: string, v: string) {
    await ensure();
    await sql.prepare(`INSERT INTO meta (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)`).bindParams(k, v).execute();
  }

  async clear() {
    await ensure();
    for (const t of ['evidence', 'lessons', 'ledger', 'issued_seals', 'meta']) await sql.prepare(`DELETE FROM ${t}`).execute();
  }
}

type LedgerRow = { seq: number; at: string; type: string; subject: string; payload: string; prev_hash: string; hash: string };

function toEntry(r: LedgerRow): LedgerEntry {
  return {
    seq: Number(r.seq),
    at: r.at,
    type: r.type as LedgerEntry['type'],
    subject: r.subject,
    payload: JSON.parse(r.payload),
    prevHash: r.prev_hash,
    hash: r.hash,
  };
}
