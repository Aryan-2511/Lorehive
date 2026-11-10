/**
 * Week-1 check #8: are correction signals noisy?
 *
 * 30 hand-labelled human commits on agent PRs, the kind of event Lorehive
 * sees most. `correction` says whether a person was fixing the agent's
 * mistake (should become evidence) or doing something else (should not).
 * `topic` is the topic a correct harvest should produce, when it matters.
 */
import { describe, expect, it } from 'vitest';
import { CorrectionSignal, harvest, toActor } from '../../src/core/harvest';

interface Labelled {
  name: string;
  message: string;
  files: string[];
  removed: string[];
  added: string[];
  correction: boolean;
  topic?: string;
}

const CASES: Labelled[] = [
  // ---- real corrections ----
  { name: 'swap axios for org client', message: 'use @org/http instead of axios', files: ['src/fx.ts'], removed: ["import axios from 'axios'"], added: ["import { http } from '@org/http'"], correction: true, topic: 'avoid:axios' },
  { name: 'add missing timeout', message: 'fix: add the request timeout', files: ['src/fx.ts'], removed: ['await http.get(url)'], added: ['await http.get(url, { timeout: 5000 })'], correction: true, topic: 'require:timeout' },
  { name: 'add tenant check', message: 'add tenant check the agent forgot', files: ['src/orders.ts'], removed: [], added: ['assertTenant(req.user, order.tenantId)'], correction: true },
  { name: 'remove moment', message: 'drop moment, we use date-fns', files: ['src/dates.ts'], removed: ["import moment from 'moment'"], added: ["import { format } from 'date-fns'"], correction: true, topic: 'avoid:moment' },
  { name: 'python requests to httpx', message: 'switch to httpx', files: ['svc/client.py'], removed: ['import requests'], added: ['import httpx'], correction: true, topic: 'avoid:requests' },
  { name: 'sql injection fix', message: 'fix: parameterise query', files: ['src/db.ts'], removed: ['db.query(`SELECT * FROM t WHERE id = ${id}`)'], added: ["db.query('SELECT * FROM t WHERE id = ?', [id])"], correction: true },
  { name: 'wrong env var', message: 'wrong env var name', files: ['src/config.ts'], removed: ['process.env.DB_URL'], added: ['process.env.DATABASE_URL'], correction: true },
  { name: 'missing await', message: 'missing await', files: ['src/jobs.ts'], removed: ['queue.push(job)'], added: ['await queue.push(job)'], correction: true },
  { name: 'retries', message: 'add retries for upstream', files: ['src/upstream.ts'], removed: ['return fetchUpstream(req)'], added: ['return fetchUpstream(req, { retries: 3 })'], correction: true, topic: 'require:retries' },
  { name: 'log PII removed', message: 'do not log the email address', files: ['src/signup.ts'], removed: ['logger.info(`signup ${user.email}`)'], added: ['logger.info(`signup ${user.id}`)'], correction: true },
  { name: 'console.log to logger', message: 'use the logger instead of console', files: ['src/api.ts'], removed: ["console.log('created', id)"], added: ["logger.info('created', { id })"], correction: true },
  { name: 'lodash removed', message: 'remove lodash, use native', files: ['src/util.ts'], removed: ["import _ from 'lodash'", '_.uniq(xs)'], added: ['[...new Set(xs)]'], correction: true, topic: 'avoid:lodash' },
  { name: 'bad status code', message: 'should be 404 not 500', files: ['src/routes.ts'], removed: ['res.status(500)'], added: ['res.status(404)'], correction: true },
  { name: 'hardcoded secret', message: 'move key to env', files: ['src/stripe.ts'], removed: ["const key = 'sk_test_123'"], added: ['const key = process.env.STRIPE_KEY'], correction: true },
  { name: 'unbounded query', message: 'add a limit, this scans the table', files: ['src/search.ts'], removed: ['find({ owner })'], added: ['find({ owner }, { limit: 100 })'], correction: true, topic: 'require:limit' },

  // ---- not corrections: noise a naive harvester would count ----
  { name: 'merge main into branch', message: "Merge branch 'main' into agent/fx", files: ['src/other.ts'], removed: ['const a = 1'], added: ['const a = 2'], correction: false },
  { name: 'merge PR message', message: 'Merge pull request #12 from acme/agent-fx', files: ['src/fx.ts'], removed: ['x'], added: ['y'], correction: false },
  { name: 'prettier reformat', message: 'format', files: ['src/fx.ts'], removed: ["const r = await http.get(url,{timeout:5000})"], added: ['const r = await http.get(url, { timeout: 5000 })'], correction: false },
  { name: 'quote style', message: 'lint', files: ['src/a.ts'], removed: ['import x from "y"'], added: ["import x from 'y'"], correction: false },
  { name: 'lockfile only', message: 'update lockfile', files: ['package-lock.json'], removed: ['"version": "1.0.0"'], added: ['"version": "1.0.1"'], correction: false },
  { name: 'docs typo', message: 'docs: fix typo in README', files: ['README.md'], removed: ['teh client'], added: ['the client'], correction: false },
  { name: 'chore bump', message: 'chore(deps): bump axios to 1.7.4', files: ['package.json'], removed: ['"axios": "1.7.3"'], added: ['"axios": "1.7.4"'], correction: false },
  { name: 'adds tests only', message: 'test: add tests for fx client', files: ['src/fx.test.ts'], removed: [], added: ["it('works', () => {})"], correction: false },
  { name: 'feature addition', message: 'add currency list endpoint', files: ['src/routes.ts'], removed: [], added: ["router.get('/currencies', list)"], correction: false },
  { name: 'rename variable', message: 'refactor: rename rate to fxRate', files: ['src/fx.ts'], removed: ['const rate = res.data.rate'], added: ['const fxRate = res.data.rate'], correction: false },
  { name: 'snapshot update', message: 'update snapshots', files: ['src/__snapshots__/fx.test.ts.snap'], removed: ['old'], added: ['new'], correction: false },
  { name: 'ci config', message: 'ci: run tests on node 22', files: ['.github/workflows/ci.yml'], removed: ['node-version: 20'], added: ['node-version: 22'], correction: false },
  { name: 'whitespace only', message: 'tidy', files: ['src/fx.ts'], removed: ['  return x;'], added: ['    return x;'], correction: false },
  { name: 'trailing comma', message: 'style', files: ['src/fx.ts'], removed: ['  b: 2'], added: ['  b: 2,'], correction: false },
  { name: 'changelog', message: 'add changelog entry', files: ['CHANGELOG.md'], removed: [], added: ['- fx client'], correction: false },
];

const agent = toActor('claude[bot]');
const person = toActor('carol', { accountAgeDays: 800 });

function toSignal(c: Labelled, i: number): CorrectionSignal {
  return {
    type: 'commit_on_agent_pr',
    source: 'github',
    scope: { repo: 'github:acme/eval' },
    prAuthor: agent,
    committer: person,
    commitMessage: c.message,
    change: { files: c.files, removed: c.removed, added: c.added },
    url: `https://github.com/acme/eval/commit/${i}`,
    at: '2026-11-10T10:00:00Z',
  };
}

export function scoreHarvester() {
  let tp = 0, fp = 0, fn = 0, tn = 0, topicOk = 0, topicTotal = 0;
  const wrong: string[] = [];
  CASES.forEach((c, i) => {
    const e = harvest(toSignal(c, i));
    const got = !!e;
    if (got && c.correction) tp++;
    else if (got && !c.correction) { fp++; wrong.push(`false positive: ${c.name}`); }
    else if (!got && c.correction) { fn++; wrong.push(`missed: ${c.name}`); }
    else tn++;
    if (c.topic && e) {
      topicTotal++;
      if (e.topic === c.topic) topicOk++;
      else wrong.push(`topic for ${c.name}: ${e.topic} (expected ${c.topic})`);
    }
  });
  return {
    accuracy: (tp + tn) / CASES.length,
    precision: tp / Math.max(1, tp + fp),
    recall: tp / Math.max(1, tp + fn),
    topicAccuracy: topicTotal ? topicOk / topicTotal : 1,
    wrong,
  };
}

describe('harvester on 30 labelled events (week-1 check #8)', () => {
  it('has 30 labelled cases', () => expect(CASES).toHaveLength(30));

  it('classifies corrections accurately', () => {
    const s = scoreHarvester();
    console.log('harvester eval', JSON.stringify({ ...s, wrong: s.wrong }, null, 1));
    // Precision matters most: a false positive is fake evidence.
    expect(s.precision).toBeGreaterThanOrEqual(0.95);
    expect(s.recall).toBeGreaterThanOrEqual(0.9);
    expect(s.topicAccuracy).toBe(1);
  });
});
