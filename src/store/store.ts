/**
 * Storage port. `SqlStore` (Forge SQL) is the production implementation;
 * `MemoryStore` backs tests and is the reference behaviour.
 */
import { Evidence, Lesson } from '../core/types';
import { LedgerEntry } from '../core/ledger';

export interface Store {
  /** returns false when the evidence id already exists (idempotent harvest) */
  addEvidence(e: Evidence): Promise<boolean>;
  evidenceByTopic(topic: string): Promise<Evidence[]>;
  getEvidence(ids: string[]): Promise<Evidence[]>;
  listEvidence(limit?: number): Promise<Evidence[]>;

  getLesson(id: string): Promise<Lesson | undefined>;
  listLessons(): Promise<Lesson[]>;
  saveLesson(l: Lesson): Promise<void>;

  lastLedger(): Promise<LedgerEntry | undefined>;
  appendLedger(e: LedgerEntry): Promise<void>;
  listLedger(limit?: number): Promise<LedgerEntry[]>;

  addIssuedSha(repo: string, sha: string): Promise<void>;
  issuedShas(repo: string): Promise<Set<string>>;

  getMeta(key: string): Promise<string | undefined>;
  setMeta(key: string, value: string): Promise<void>;

  /** wipe everything (demo reset) */
  clear(): Promise<void>;
}

export class MemoryStore implements Store {
  evidence = new Map<string, Evidence>();
  lessons = new Map<string, Lesson>();
  ledger: LedgerEntry[] = [];
  shas = new Map<string, Set<string>>();
  meta = new Map<string, string>();

  async addEvidence(e: Evidence) {
    if (this.evidence.has(e.id)) return false;
    this.evidence.set(e.id, structuredClone(e));
    return true;
  }
  async evidenceByTopic(topic: string) {
    return [...this.evidence.values()].filter((e) => e.topic === topic).map((e) => structuredClone(e));
  }
  async getEvidence(ids: string[]) {
    return ids.map((id) => this.evidence.get(id)).filter((e): e is Evidence => !!e);
  }
  async listEvidence(limit = 200) {
    return [...this.evidence.values()].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, limit);
  }
  async getLesson(id: string) {
    const l = this.lessons.get(id);
    return l && structuredClone(l);
  }
  async listLessons() {
    return [...this.lessons.values()].map((l) => structuredClone(l));
  }
  async saveLesson(l: Lesson) {
    this.lessons.set(l.id, structuredClone(l));
  }
  async lastLedger() {
    return this.ledger[this.ledger.length - 1];
  }
  async appendLedger(e: LedgerEntry) {
    this.ledger.push(e);
  }
  async listLedger(limit = 200) {
    return this.ledger.slice(-limit).reverse();
  }
  async addIssuedSha(repo: string, sha: string) {
    if (!this.shas.has(repo)) this.shas.set(repo, new Set());
    this.shas.get(repo)!.add(sha);
  }
  async issuedShas(repo: string) {
    return new Set(this.shas.get(repo) ?? []);
  }
  async getMeta(k: string) {
    return this.meta.get(k);
  }
  async setMeta(k: string, v: string) {
    this.meta.set(k, v);
  }
  async clear() {
    this.evidence.clear();
    this.lessons.clear();
    this.ledger = [];
    this.shas.clear();
    this.meta.clear();
  }
}
