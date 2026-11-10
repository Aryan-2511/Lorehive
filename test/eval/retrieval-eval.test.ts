/**
 * Week-1 check #9: Forge has no vector search. Is scope filter + keyword
 * ranking good enough on a realistic library of 50 lessons?
 *
 * Each query is a task an agent might pass to lessons_for, labelled with the
 * lesson that should come back (or none, when nothing applies). Phrasing is
 * deliberately not copied from the lesson text.
 */
import { describe, expect, it } from 'vitest';
import { lessonsFor } from '../../src/core/retrieve';
import { Lesson } from '../../src/core/types';

const L = (id: string, title: string, rule: string, topic = `t:${id}`): Lesson => ({
  id, topic, title, rule, rationale: '', status: 'promoted',
  appliesTo: { repos: [], projects: [], languages: [], teams: [] },
  evidenceIds: ['a', 'b'], citations: [], recordedAt: '2026-11-01',
});

const LIBRARY: Lesson[] = [
  L('http', 'Use @org/http instead of axios', 'Do not import `axios`. Use `@org/http` instead; it sets timeouts and tenant headers.', 'avoid:axios'),
  L('timeout', 'Always set `timeout`', 'Always set `timeout` explicitly on outbound HTTP calls.', 'require:timeout'),
  L('retries', 'Always set `retries`', 'Set `retries` on calls to upstream services.', 'require:retries'),
  L('tenant', 'Check for missing tenant check', 'Before opening a PR, check every query and handler for a tenant check (assertTenant).', 'review:missing-tenant-check'),
  L('moment', 'Use date-fns instead of moment', 'Do not import `moment`. Use `date-fns` for date formatting and parsing.', 'avoid:moment'),
  L('lodash', "Don't use lodash", 'Do not import `lodash`; use native array and object methods.', 'avoid:lodash'),
  L('sqlparam', 'Parameterise SQL queries', 'Never interpolate values into SQL strings; pass them as query parameters.'),
  L('envname', 'Database URL variable is DATABASE_URL', 'Read the database connection string from DATABASE_URL, not DB_URL.'),
  L('await', 'Await queue pushes', 'Always await queue.push; unawaited jobs are lost when the function returns.'),
  L('pii', "Don't log personal data", 'Never log emails, names or phone numbers; log the user id instead.'),
  L('logger', 'Use the logger, not console', 'Use `logger` from @org/log instead of console.log in services.'),
  L('404', 'Return 404 for missing records', 'When a record is not found, return 404, not 500.'),
  L('secrets', 'No secrets in code', 'Never hardcode API keys or tokens; read them from environment variables or the secret store.'),
  L('limit', 'Always set `limit` on queries', 'Every find() on a large collection must set a limit.', 'require:limit'),
  L('requests', 'Use httpx instead of requests', 'In Python services, do not import `requests`. Use `httpx` with a timeout.', 'avoid:requests'),
  L('feature-flags', 'Gate new endpoints behind a flag', 'New API endpoints must be wrapped in a feature flag from @org/flags.'),
  L('migrations', 'Migrations must be reversible', 'Every database migration needs a down step.'),
  L('index', 'Add an index for new query columns', 'When filtering on a new column, add a database index in the same PR.'),
  L('money', 'Use integer cents for money', 'Represent money as integer cents with a currency code, never floats.'),
  L('dates-utc', 'Store timestamps in UTC', 'Store and compare timestamps in UTC; convert to local time only for display.'),
  L('i18n', 'No hardcoded user-facing strings', 'User-facing text goes through t() from @org/i18n.'),
  L('a11y', 'Buttons need accessible labels', 'Icon-only buttons need an aria-label.'),
  L('react-keys', 'Stable keys in lists', 'Use stable ids as React list keys, not array indexes.'),
  L('useeffect', 'Clean up effects', 'useEffect subscriptions and timers must return a cleanup function.'),
  L('css', 'Use design tokens', 'Use colour and spacing tokens from @org/tokens, not raw hex values.'),
  L('graphql-n1', 'Batch GraphQL resolvers', 'Use a DataLoader in GraphQL resolvers that load related records to avoid N+1 queries.'),
  L('pagination', 'Cursor pagination for lists', 'List endpoints use cursor pagination, not offset.'),
  L('idempotency', 'Payment calls need idempotency keys', 'Every call to the payment provider must send an Idempotency-Key header.'),
  L('webhook-verify', 'Verify webhook signatures', 'Verify the HMAC signature of incoming webhooks before parsing the body.'),
  L('csrf', 'Forms need CSRF tokens', 'Server-rendered forms must include a CSRF token.'),
  L('cors', "Don't use wildcard CORS", "Never set Access-Control-Allow-Origin to * on authenticated APIs."),
  L('jwt', 'Check JWT expiry and audience', 'When verifying JWTs, check exp and aud, not just the signature.'),
  L('rate-limit', 'Rate limit public endpoints', 'Public endpoints need the rateLimit middleware.'),
  L('docker-root', "Containers don't run as root", 'Dockerfiles must set a non-root USER.'),
  L('pin-images', 'Pin base image versions', 'Pin Docker base images to a digest or exact version, never latest.'),
  L('terraform-tags', 'Tag cloud resources', 'Every Terraform resource needs owner and cost-centre tags.'),
  L('s3-public', 'Buckets are private', 'S3 buckets must block public access.'),
  L('k8s-limits', 'Set Kubernetes resource limits', 'Every container in a Kubernetes manifest needs CPU and memory requests and limits.'),
  L('tests-db', 'Tests use the test database helper', 'Integration tests create data with createTestDb(), never the shared dev database.'),
  L('flaky-sleep', 'No sleeps in tests', 'Do not use sleep or setTimeout to wait in tests; wait for a condition.'),
  L('snapshots', 'Keep snapshots small', 'Avoid snapshot tests of whole pages; assert on specific elements.'),
  L('errors-wrap', 'Wrap errors with context', 'When rethrowing, wrap the error with context instead of losing the stack.'),
  L('no-any', "Don't use `any`", 'Avoid TypeScript any; use unknown and narrow.'),
  L('zod', 'Validate request bodies with zod', 'Validate incoming request bodies with a zod schema before use.'),
  L('kafka-keys', 'Kafka messages need a key', 'Produce Kafka messages with the tenant id as the key so ordering holds per tenant.'),
  L('cache-ttl', 'Caches need a TTL', 'Every Redis cache entry must be set with an expiry.'),
  L('jira-resolve', 'Confirm before resolving tickets', 'When resolving PAY tickets, confirm the fix with the reporter first.', 'reopen:PAY:general'),
  L('changelog', 'Update the changelog for API changes', 'Public API changes need a CHANGELOG entry.'),
  L('openapi', 'Keep the OpenAPI spec in sync', 'Changing an endpoint means updating openapi.yaml in the same PR.'),
  L('bulk-email', 'Use the email queue', 'Send email through the email queue, never directly from request handlers.'),
];

const QUERIES: Array<{ task: string; expect: string | null }> = [
  { task: 'add an HTTP client call to the FX rates service', expect: 'http' },
  { task: 'call the partner REST API to fetch exchange rates', expect: 'timeout' },
  { task: 'write a function that formats invoice dates for the PDF', expect: 'moment' },
  { task: 'add an endpoint returning orders for the current tenant', expect: 'tenant' },
  { task: 'query users by email address in postgres', expect: 'sqlparam' },
  { task: 'log when a user signs up', expect: 'pii' },
  { task: 'connect the reporting job to the database', expect: 'envname' },
  { task: 'enqueue a job to recalculate balances', expect: 'await' },
  { task: 'store the Stripe API key for the billing service', expect: 'secrets' },
  { task: 'add a Python script that calls the inventory API', expect: 'requests' },
  { task: 'handle the case where an invoice id does not exist', expect: '404' },
  { task: 'add a price field to the product model', expect: 'money' },
  { task: 'charge the customer card through the payment provider', expect: 'idempotency' },
  { task: 'receive webhooks from the shipping partner', expect: 'webhook-verify' },
  { task: 'write a Dockerfile for the worker', expect: 'docker-root' },
  { task: 'add an icon button to close the dialog', expect: 'a11y' },
  { task: 'render the list of transactions in React', expect: 'react-keys' },
  { task: 'cache exchange rates in Redis', expect: 'cache-ttl' },
  { task: 'publish order events to Kafka', expect: 'kafka-keys' },
  { task: 'add a migration that renames the status column', expect: 'migrations' },
  { task: 'deploy the service to Kubernetes', expect: 'k8s-limits' },
  { task: 'add pagination to the transactions list endpoint', expect: 'pagination' },
  { task: 'validate the JSON body of the create-order request', expect: 'zod' },
  { task: 'resolve the PAY ticket about duplicate refunds', expect: 'jira-resolve' },
  { task: 'translate the welcome banner text', expect: 'i18n' },
  // nothing in the library applies
  { task: 'rename the README title', expect: null },
  { task: 'bump the copyright year in the footer', expect: null },
];

describe('retrieval on 50 lessons (week-1 check #9)', () => {
  it('has 50 lessons', () => expect(LIBRARY).toHaveLength(50));

  it('ranks the right lesson in the top 3 and returns nothing when nothing applies', async () => {
    let hit1 = 0, hit3 = 0, emptyOk = 0, emptyTotal = 0;
    const misses: string[] = [];
    for (const q of QUERIES) {
      const r = await lessonsFor(LIBRARY, {}, q.task, {}, { limit: 3 });
      const ids = r.lessons.map((l) => l.id);
      if (q.expect === null) {
        emptyTotal++;
        if (ids.length === 0) emptyOk++;
        else misses.push(`"${q.task}" should return nothing, got ${ids.join(',')}`);
        continue;
      }
      if (ids[0] === q.expect) hit1++;
      if (ids.includes(q.expect)) hit3++;
      else misses.push(`"${q.task}" expected ${q.expect}, got ${ids.join(',') || 'nothing'}`);
    }
    const n = QUERIES.length - emptyTotal;
    const result = { hitAt1: hit1 / n, hitAt3: hit3 / n, emptyWhenIrrelevant: emptyOk / emptyTotal, misses };
    console.log('retrieval eval', JSON.stringify(result, null, 1));
    expect(result.hitAt3).toBeGreaterThanOrEqual(0.8);
    expect(result.emptyWhenIrrelevant).toBe(1);
  });
});
