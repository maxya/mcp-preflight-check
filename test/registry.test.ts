import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchPackageFacts } from '../src/registry/client.js';
import { fakeFetch } from './helpers/fake-fetch.js';
import { fixturePath } from './helpers/fixtures.js';

const packument = JSON.parse(readFileSync(fixturePath('registry', 'modelcontextprotocol__server-github.json'), 'utf8'));
const URL_GITHUB = 'https://registry.npmjs.org/@modelcontextprotocol%2Fserver-github';

test('200 maps to ok facts, using the full packument', async () => {
  const calls: string[] = [];
  const f = fakeFetch({ [URL_GITHUB]: { status: 200, body: packument } }, calls);
  const r = await fetchPackageFacts('@modelcontextprotocol/server-github', undefined, { fetch: f });
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.equal(r.facts.exists, true);
  assert.equal(r.facts.resolvedVersion, '2025.4.8');
  assert.ok(r.facts.deprecated);
  assert.deepEqual(calls, [URL_GITHUB]);
});

test('404 maps to ok with exists:false', async () => {
  const f = fakeFetch({ 'https://registry.npmjs.org/@modelcontextprotocol%2Fserver-sentry': { status: 404, body: { error: 'Not found' } } });
  const r = await fetchPackageFacts('@modelcontextprotocol/server-sentry', undefined, { fetch: f });
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.equal(r.facts.exists, false);
});

test('500 then 200 retries once and succeeds', async () => {
  let n = 0;
  const f = (async () => {
    n++;
    if (n === 1) return new Response('oops', { status: 500 });
    return new Response(JSON.stringify(packument), { status: 200 });
  }) as unknown as typeof fetch;
  const r = await fetchPackageFacts('@modelcontextprotocol/server-github', undefined, { fetch: f });
  assert.equal(r.kind, 'ok');
  assert.equal(n, 2);
});

test('500 twice maps to registry unavailable', async () => {
  const f = fakeFetch({ [URL_GITHUB]: { status: 500 } });
  const r = await fetchPackageFacts('@modelcontextprotocol/server-github', undefined, { fetch: f });
  assert.deepEqual(r, { kind: 'error', reason: 'registry unavailable' });
});

test('403 maps to an error without retrying', async () => {
  const f = fakeFetch({ [URL_GITHUB]: { status: 403 } });
  const r = await fetchPackageFacts('@modelcontextprotocol/server-github', undefined, { fetch: f });
  assert.deepEqual(r, { kind: 'error', reason: 'registry HTTP 403' });
});

test('a timeout maps to a short reason', async () => {
  const f = (async () => {
    const e = new Error('timed out');
    e.name = 'TimeoutError';
    throw e;
  }) as unknown as typeof fetch;
  const r = await fetchPackageFacts('@modelcontextprotocol/server-github', undefined, { fetch: f });
  assert.deepEqual(r, { kind: 'error', reason: 'timeout' });
});

test('a network error maps to a short reason without leaking the URL', async () => {
  const f = (async () => { throw new TypeError('fetch failed for https://registry.npmjs.org/x?token=qs-FAKE'); }) as unknown as typeof fetch;
  const r = await fetchPackageFacts('@modelcontextprotocol/server-github', undefined, { fetch: f });
  assert.deepEqual(r, { kind: 'error', reason: 'network error' });
});
