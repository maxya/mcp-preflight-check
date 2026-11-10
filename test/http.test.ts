import test from 'node:test';
import assert from 'node:assert/strict';
import { HostNotAllowedError, httpGetJson } from '../src/net/http.js';
import { fakeFetch } from './helpers/fake-fetch.js';

test('rejects plain http even for an allowed host, before any fetch', async () => {
  const calls: string[] = [];
  const f = fakeFetch({}, calls);
  await assert.rejects(() => httpGetJson('http://registry.npmjs.org/left-pad', { fetch: f }), HostNotAllowedError);
  assert.deepEqual(calls, []);
});

test('rejects a non-allow-listed host before any fetch', async () => {
  const calls: string[] = [];
  const f = fakeFetch({}, calls);
  await assert.rejects(() => httpGetJson('https://example.com/x', { fetch: f }), HostNotAllowedError);
  assert.deepEqual(calls, []);
});

test('an off-list redirect throws before the off-list host is fetched', async () => {
  const calls: string[] = [];
  const f = fakeFetch({
    'https://registry.npmjs.org/pkg': { status: 302, headers: { location: 'https://evil.example/x' } },
  }, calls);
  await assert.rejects(() => httpGetJson('https://registry.npmjs.org/pkg', { fetch: f }), HostNotAllowedError);
  assert.deepEqual(calls, ['https://registry.npmjs.org/pkg']);
});

test('follows an allow-listed redirect and parses JSON', async () => {
  const calls: string[] = [];
  const f = fakeFetch({
    'https://api.github.com/a': { status: 301, headers: { location: 'https://api.github.com/b' } },
    'https://api.github.com/b': { status: 200, body: { ok: true } },
  }, calls);
  const r = await httpGetJson('https://api.github.com/a', { fetch: f });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
  assert.deepEqual(calls, ['https://api.github.com/a', 'https://api.github.com/b']);
});

test('too many redirects throws', async () => {
  const routes: Record<string, { status: number; headers: Record<string, string> }> = {};
  for (let i = 0; i < 6; i++) {
    routes[`https://api.github.com/${i}`] = { status: 302, headers: { location: `https://api.github.com/${i + 1}` } };
  }
  await assert.rejects(() => httpGetJson('https://api.github.com/0', { fetch: fakeFetch(routes) }), /too many redirects/);
});

test('sends a User-Agent without an @ (no email) and an accept header', async () => {
  const calls: string[] = [];
  const requests: { url: string; init?: RequestInit }[] = [];
  const f = fakeFetch({ 'https://registry.npmjs.org/x': { status: 200, body: {} } }, calls, requests);
  await httpGetJson('https://registry.npmjs.org/x', { fetch: f });
  const headers = requests[0].init?.headers as Record<string, string>;
  assert.match(headers['user-agent'], /^mcp-preflight-check\/\d+\.\d+\.\d+$/);
  assert.ok(!headers['user-agent'].includes('@'));
  assert.equal(headers.accept, 'application/json');
  assert.equal(requests[0].init?.redirect, 'manual');
});

test('a non-JSON body yields null instead of throwing', async () => {
  const f = fakeFetch({ 'https://registry.npmjs.org/x': { status: 200 } });
  // no body → null
  const r = await httpGetJson('https://registry.npmjs.org/x', { fetch: f });
  assert.equal(r.body, null);
});
