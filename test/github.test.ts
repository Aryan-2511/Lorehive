import { describe, expect, it } from 'vitest';
import { createHmac, generateKeyPairSync, createVerify } from 'node:crypto';
import { appJwt, parsePrivateKey, changeFromFiles, fixupSignal, isFixupCandidate, revertedPrNumber, revertSignal, verifySignature } from '../src/adapters/github';
import { harvest } from '../src/core/harvest';

describe('github adapter', () => {
  it('verifies webhook signatures', () => {
    const body = '{"a":1}';
    const sig = 'sha256=' + createHmac('sha256', 's3cret').update(body).digest('hex');
    expect(verifySignature('s3cret', body, sig)).toBe(true);
    expect(verifySignature('wrong', body, sig)).toBe(false);
    expect(verifySignature('s3cret', body, undefined)).toBe(false);
  });

  it('signs a verifiable app JWT', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwt = appJwt('123', privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(), 1_000_000);
    const [h, p, s] = jwt.split('.');
    const v = createVerify('RSA-SHA256');
    v.update(`${h}.${p}`);
    expect(v.verify(publicKey, Buffer.from(s!, 'base64url'))).toBe(true);
    expect(JSON.parse(Buffer.from(p!, 'base64url').toString())).toMatchObject({ iss: '123', exp: 1_000_540 });
  });

  it('reads the private key as base64 or as PEM with \\n escapes', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const raw = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    const pem = raw.trim();
    expect(parsePrivateKey(Buffer.from(raw).toString('base64'))).toBe(pem);
    expect(parsePrivateKey(Buffer.from(pem).toString('base64'))).toBe(pem);
    expect(parsePrivateKey(pem.replace(/\n/g, '\\n'))).toBe(pem);
    expect(parsePrivateKey(pem)).toBe(pem);
    expect(() => parsePrivateKey('not a key')).toThrow('not a PEM private key');
  });

  it('parses patches into a change summary', () => {
    const c = changeFromFiles([{ filename: 'a.ts', patch: "@@ -1,2 +1,2 @@\n-import axios from 'axios'\n+import { http } from '@org/http'\n ctx" }]);
    expect(c).toEqual({ files: ['a.ts'], removed: ["import axios from 'axios'"], added: ["import { http } from '@org/http'"] });
  });

  it('detects revert PRs', () => {
    expect(revertedPrNumber('Revert "Add FX client"', 'Reverts acme/payments-api#212')).toBe(212);
    expect(revertedPrNumber('Add FX client', 'Reverts acme/payments-api#212')).toBeUndefined();
  });

  it('a human revert of a Copilot PR becomes revert evidence on avoid:axios', () => {
    const s = revertSignal({
      repoFullName: 'acme/payments-api',
      revertPr: { html_url: 'https://github.com/acme/payments-api/pull/213', user: { login: 'alice' }, merged_by: { login: 'alice' }, merged_at: '2026-11-10T09:00:00Z' },
      originalPr: { user: { login: 'Copilot', type: 'Bot' } },
      files: [{ filename: 'src/fx.ts', patch: "-import axios from 'axios'\n+import { http } from '@org/http'" }],
    });
    const e = harvest(s!);
    expect(e?.kind).toBe('revert');
    expect(e?.topic).toBe('avoid:axios');
    expect(e?.subjectAgent?.vendor).toBe('copilot');
  });

  it('a human commit on a Claude PR after a Copilot review on that file is a review finding', () => {
    const s = fixupSignal({
      repoFullName: 'acme/checkout-web',
      pr: { number: 5, html_url: 'https://github.com/acme/checkout-web/pull/5', user: { login: 'claude[bot]', type: 'Bot' } },
      commit: { sha: 'abc', html_url: 'https://x', message: 'add tenant check', author: { login: 'carol' }, date: '2026-11-11T10:00:00Z', files: [{ filename: 'src/api.ts', patch: '+assertTenant(user, order.tenantId)' }] },
      reviews: [{ user: { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' }, path: 'src/api.ts' }],
      pusher: { login: 'carol' },
    });
    expect(s?.type).toBe('review_finding_fixed');
    expect(harvest(s!)?.kind).toBe('review_finding');
  });

  it('agent commits on agent PRs are not evidence', () => {
    const s = fixupSignal({
      repoFullName: 'acme/x',
      pr: { number: 1, html_url: 'https://x', user: { login: 'claude[bot]', type: 'Bot' } },
      commit: { sha: 'a', html_url: 'https://x', message: 'fix', author: { login: 'cursor[bot]', type: 'Bot' }, date: '2026-11-11T10:00:00Z', files: [] },
      reviews: [],
      pusher: { login: 'cursor[bot]', type: 'Bot' },
    });
    expect(s).toBeNull();
  });

  const onAgentPr = (author: string, pusher: string) =>
    fixupSignal({
      repoFullName: 'acme/x',
      pr: { number: 1, html_url: 'https://x', user: { login: 'claude[bot]', type: 'Bot' } },
      commit: { sha: 'a', html_url: 'https://x', message: 'fix: use the right client', author: { login: author }, date: '2026-11-11T10:00:00Z', files: [{ filename: 'a.ts', patch: "-import axios from 'axios'" }] },
      reviews: [],
      pusher: { login: pusher },
    });

  it('the actor is the authenticated pusher, so a forged commit author is not a second person', () => {
    const s = onAgentPr('alice', 'mallory');
    expect(s?.type === 'commit_on_agent_pr' && s.committer.id).toBe('mallory');
  });

  it('a person pushing an agent-authored commit is not a correction', () => {
    expect(onAgentPr('claude[bot]', 'alice')).toBeNull();
  });

  it('only single-parent commits on an open PR head branch can be fix-ups', () => {
    const pr = { state: 'open', head: { ref: 'agent/fx' } };
    expect(isFixupCandidate('refs/heads/agent/fx', pr, 1)).toBe(true);
    expect(isFixupCandidate('refs/heads/main', pr, 1)).toBe(false);
    expect(isFixupCandidate('refs/heads/agent/fx', pr, 2)).toBe(false);
    expect(isFixupCandidate('refs/heads/agent/fx', { ...pr, state: 'closed' }, 1)).toBe(false);
  });
});
