import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { GitHubClient } from '../src/github/client.js';
import { cacheDir } from '../src/util/paths.js';
import { fakeFetch } from './helpers/fake-fetch.js';
import { fixturePath } from './helpers/fixtures.js';
import { makeTmpDir } from './helpers/tmp-home.js';

const NOW = new Date('2026-11-10T12:00:00.000Z');
const gh = (file: string) => JSON.parse(readFileSync(fixturePath('github', file), 'utf8'));
const ARCHIVED_URL = 'https://api.github.com/repos/example-org/archived-repo';
const HEALTHY_URL = 'https://api.github.com/repos/example-org/healthy-repo';
const MISSING_URL = 'https://api.github.com/repos/example-org/missing-repo';
const LIMIT_URL = 'https://api.github.com/repos/example-org/rate-limited-repo';

async function cacheFileFor(root: string): Promise<string> {
  return join(cacheDir({ MCP_PREFLIGHT_CHECK_CACHE_DIR: root }, 'linux', '/home/tester'), 'github.json');
}

async function writeCache(file: string, entries: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ version: 1, entries }, null, 2));
}

test('200 archived and not archived map to RepoResult.ok', async () => {
  const tmp = await makeTmpDir();
  try {
    const cacheFile = await cacheFileFor(tmp.dir);
    const calls: string[] = [];
    const f = fakeFetch({
      [ARCHIVED_URL]: { status: 200, body: gh('archived.json') },
      [HEALTHY_URL]: { status: 200, body: gh('healthy.json') },
    }, calls);
    const client = new GitHubClient({ http: { fetch: f }, cacheFile, now: NOW });

    const a = await client.repoStatus('example-org', 'archived-repo');
    assert.deepEqual(a, {
      kind: 'ok', archived: true, pushedAt: '2024-01-01T00:00:00Z', htmlUrl: 'https://github.com/example-org/archived-repo',
    });
    const h = await client.repoStatus('example-org', 'healthy-repo');
    assert.equal(h.kind, 'ok');
    if (h.kind !== 'ok') return;
    assert.equal(h.archived, false);
    assert.equal(calls.length, 2);
  } finally {
    await tmp.cleanup();
  }
});

test('404 → not-found and is cached', async () => {
  const tmp = await makeTmpDir();
  try {
    const cacheFile = await cacheFileFor(tmp.dir);
    const f = fakeFetch({ [MISSING_URL]: { status: 404, body: gh('not-found.json') } });
    const client = new GitHubClient({ http: { fetch: f }, cacheFile, now: NOW });
    assert.deepEqual(await client.repoStatus('example-org', 'missing-repo'), { kind: 'not-found' });
    const raw = JSON.parse(await readFile(cacheFile, 'utf8'));
    assert.equal(raw.entries['example-org/missing-repo'].status, 'not_found');
  } finally {
    await tmp.cleanup();
  }
});

test('403 with x-ratelimit-remaining: 0 trips the circuit breaker — the next repo makes no fetch', async () => {
  const tmp = await makeTmpDir();
  try {
    const cacheFile = await cacheFileFor(tmp.dir);
    const calls: string[] = [];
    const f = fakeFetch({
      [LIMIT_URL]: { status: 403, body: gh('rate-limit.json'), headers: { 'x-ratelimit-remaining': '0' } },
      [HEALTHY_URL]: { status: 200, body: gh('healthy.json') },
    }, calls);
    const client = new GitHubClient({ http: { fetch: f }, cacheFile, now: NOW });
    assert.deepEqual(await client.repoStatus('example-org', 'rate-limited-repo'), { kind: 'rate-limited' });
    assert.deepEqual(await client.repoStatus('example-org', 'healthy-repo'), { kind: 'rate-limited' });
    assert.equal(calls.length, 1, 'second lookup must not hit GitHub');
    assert.equal(client.rateLimited, true);
  } finally {
    await tmp.cleanup();
  }
});

test('429 with retry-after also trips the breaker', async () => {
  const tmp = await makeTmpDir();
  try {
    const cacheFile = await cacheFileFor(tmp.dir);
    const calls: string[] = [];
    const f = fakeFetch({
      [LIMIT_URL]: { status: 429, body: gh('rate-limit.json'), headers: { 'retry-after': '60' } },
    }, calls);
    const client = new GitHubClient({ http: { fetch: f }, cacheFile, now: NOW });
    assert.deepEqual(await client.repoStatus('example-org', 'rate-limited-repo'), { kind: 'rate-limited' });
    assert.deepEqual(await client.repoStatus('example-org', 'healthy-repo'), { kind: 'rate-limited' });
    assert.equal(calls.length, 1);
  } finally {
    await tmp.cleanup();
  }
});

test('a cache hit within 7 days makes zero fetch calls', async () => {
  const tmp = await makeTmpDir();
  try {
    const cacheFile = await cacheFileFor(tmp.dir);
    await writeCache(cacheFile, {
      'example-org/archived-repo': {
        fetchedAt: '2026-11-08T12:00:00.000Z',
        status: 'ok',
        archived: true,
        pushedAt: '2024-01-01T00:00:00Z',
        htmlUrl: 'https://github.com/example-org/archived-repo',
      },
    });
    const calls: string[] = [];
    const hits: string[] = [];
    const f = fakeFetch({}, calls);
    const client = new GitHubClient({ http: { fetch: f }, cacheFile, now: NOW, onCacheHit: k => hits.push(k) });
    const r = await client.repoStatus('Example-Org', 'Archived-Repo');
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') return;
    assert.equal(r.archived, true);
    assert.deepEqual(calls, []);
    assert.deepEqual(hits, ['example-org/archived-repo']);
  } finally {
    await tmp.cleanup();
  }
});

test('an expired cache entry is refetched', async () => {
  const tmp = await makeTmpDir();
  try {
    const cacheFile = await cacheFileFor(tmp.dir);
    await writeCache(cacheFile, {
      'example-org/archived-repo': {
        fetchedAt: '2026-10-01T12:00:00.000Z',
        status: 'ok',
        archived: true,
        htmlUrl: 'https://github.com/example-org/archived-repo',
      },
    });
    const calls: string[] = [];
    const f = fakeFetch({ [ARCHIVED_URL]: { status: 200, body: gh('healthy.json') } }, calls);
    const client = new GitHubClient({ http: { fetch: f }, cacheFile, now: NOW });
    const r = await client.repoStatus('example-org', 'archived-repo');
    assert.equal(calls.length, 1);
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') return;
    assert.equal(r.archived, false);
  } finally {
    await tmp.cleanup();
  }
});

test('a corrupt cache file is ignored, not fatal', async () => {
  const tmp = await makeTmpDir();
  try {
    const cacheFile = await cacheFileFor(tmp.dir);
    await writeCache(cacheFile, {});
    await writeFile(cacheFile, '{ this is not json');
    const calls: string[] = [];
    const f = fakeFetch({ [ARCHIVED_URL]: { status: 200, body: gh('archived.json') } }, calls);
    const client = new GitHubClient({ http: { fetch: f }, cacheFile, now: NOW });
    const r = await client.repoStatus('example-org', 'archived-repo');
    assert.equal(r.kind, 'ok');
    assert.equal(calls.length, 1);
  } finally {
    await tmp.cleanup();
  }
});

test('a cache file with the wrong schema version is ignored', async () => {
  const tmp = await makeTmpDir();
  try {
    const cacheFile = await cacheFileFor(tmp.dir);
    await mkdir(dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, JSON.stringify({ version: 2, entries: { 'example-org/archived-repo': { fetchedAt: NOW.toISOString(), status: 'ok', archived: true } } }));
    const calls: string[] = [];
    const f = fakeFetch({ [ARCHIVED_URL]: { status: 200, body: gh('healthy.json') } }, calls);
    const client = new GitHubClient({ http: { fetch: f }, cacheFile, now: NOW });
    const r = await client.repoStatus('example-org', 'archived-repo');
    assert.equal(calls.length, 1);
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') return;
    assert.equal(r.archived, false);
  } finally {
    await tmp.cleanup();
  }
});

test('the token is sent only when set, and is never written to the cache file', async () => {
  const tmp = await makeTmpDir();
  try {
    const cacheFile = await cacheFileFor(tmp.dir);
    const requests: { url: string; init?: RequestInit }[] = [];
    const f = fakeFetch({ [ARCHIVED_URL]: { status: 200, body: gh('archived.json') } }, [], requests);
    const client = new GitHubClient({ http: { fetch: f }, cacheFile, now: NOW, token: 'ghp_FAKE_SECRET_123' });
    await client.repoStatus('example-org', 'archived-repo');

    const headers = requests[0].init?.headers as Record<string, string>;
    assert.equal(headers.authorization, 'Bearer ghp_FAKE_SECRET_123');
    assert.equal(headers.accept, 'application/vnd.github+json');
    assert.equal(headers['x-github-api-version'], '2022-11-28');

    const raw = await readFile(cacheFile, 'utf8');
    assert.ok(!raw.includes('ghp_FAKE_SECRET_123'));
    assert.ok(!raw.toLowerCase().includes('authorization'));
  } finally {
    await tmp.cleanup();
  }
});

test('no authorization header when no token is configured', async () => {
  const tmp = await makeTmpDir();
  try {
    const cacheFile = await cacheFileFor(tmp.dir);
    const requests: { url: string; init?: RequestInit }[] = [];
    const f = fakeFetch({ [HEALTHY_URL]: { status: 200, body: gh('healthy.json') } }, [], requests);
    const client = new GitHubClient({ http: { fetch: f }, cacheFile, now: NOW });
    await client.repoStatus('example-org', 'healthy-repo');
    const headers = requests[0].init?.headers as Record<string, string>;
    assert.equal(headers.authorization, undefined);
  } finally {
    await tmp.cleanup();
  }
});

test('a network error becomes RepoResult.error and is not cached', async () => {
  const tmp = await makeTmpDir();
  try {
    const cacheFile = await cacheFileFor(tmp.dir);
    const f = (async () => { throw new TypeError('network'); }) as unknown as typeof fetch;
    const client = new GitHubClient({ http: { fetch: f }, cacheFile, now: NOW });
    assert.deepEqual(await client.repoStatus('example-org', 'archived-repo'), { kind: 'error', reason: 'network error' });
    const raw = JSON.parse(await readFile(cacheFile, 'utf8').catch(() => '{"entries":{}}'));
    assert.deepEqual(raw.entries, {});
  } finally {
    await tmp.cleanup();
  }
});
