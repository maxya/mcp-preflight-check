import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { factsFromPackument, parseGitHubRepo } from '../src/registry/facts.js';
import { fixturePath } from './helpers/fixtures.js';

const packument = (file: string) =>
  JSON.parse(readFileSync(fixturePath('registry', file), 'utf8')) as Parameters<typeof factsFromPackument>[0];

test('server-github: latest resolves, per-version deprecation, time.modified ignored', () => {
  const doc = packument('modelcontextprotocol__server-github.json');
  assert.equal((doc.time as Record<string, unknown>).modified, '2026-11-05T04:13:31.223Z');
  const f = factsFromPackument(doc, '@modelcontextprotocol/server-github');
  assert.equal(f.exists, true);
  assert.equal(f.resolvedVersion, '2025.4.8');
  assert.equal(f.deprecated, 'Archived and unmaintained; no security guarantees. See https://github.com/modelcontextprotocol/servers-archived');
  assert.equal(f.lastPublish, '2025-04-08T10:08:59.978Z');
  assert.equal(f.lastPublishVersion, '2025.4.8');
  assert.equal(f.repository, null);
  assert.equal(f.versionMissing, false);
  assert.equal(f.rangeNotResolved, false);
});

test('server-github@0.5.1 uses that version and its deprecation', () => {
  const f = factsFromPackument(packument('modelcontextprotocol__server-github.json'), '@modelcontextprotocol/server-github', '0.5.1');
  assert.equal(f.resolvedVersion, '0.5.1');
  assert.match(f.deprecated ?? '', /^Archived and unmaintained/);
});

test('a version that was never published is flagged, not silently resolved to latest', () => {
  const f = factsFromPackument(packument('modelcontextprotocol__server-github.json'), '@modelcontextprotocol/server-github', '9.9.9');
  assert.equal(f.versionMissing, true);
});

test('server-filesystem: healthy, repository parsed, recent publish', () => {
  const f = factsFromPackument(packument('modelcontextprotocol__server-filesystem.json'), '@modelcontextprotocol/server-filesystem');
  assert.equal(f.deprecated, null);
  assert.deepEqual(f.repository, { owner: 'modelcontextprotocol', repo: 'servers' });
  assert.ok(f.lastPublish?.startsWith('2026-11-04'), `lastPublish=${f.lastPublish}`);
});

test('create-server is deprecated and exists', () => {
  const f = factsFromPackument(packument('modelcontextprotocol__create-server.json'), '@modelcontextprotocol/create-server');
  assert.equal(f.exists, true);
  assert.ok(f.deprecated);
});

test('a document with only time.unpublished has exists:false', () => {
  const f = factsFromPackument(packument('synthetic-unpublished.json'), 'synthetic-unpublished');
  assert.equal(f.exists, false);
});

test('a semver range is not resolved: latest is checked and rangeNotResolved is set', () => {
  const f = factsFromPackument(packument('synthetic-range.json'), 'synthetic-range', '^1.0.0');
  assert.equal(f.rangeNotResolved, true);
  assert.equal(f.versionMissing, false);
  assert.equal(f.resolvedVersion, '1.1.0');
});

test('dist-tag aliases resolve through dist-tags', () => {
  const f = factsFromPackument(packument('synthetic-range.json'), 'synthetic-range', 'latest');
  assert.equal(f.resolvedVersion, '1.1.0');
  assert.equal(f.rangeNotResolved, false);
});

test('STALE fixture: only version publish times count, never time.modified', () => {
  const f = factsFromPackument(packument('synthetic-stale.json'), 'synthetic-stale');
  assert.equal(f.lastPublish, '2020-01-01T00:00:00.000Z');
  assert.equal(f.lastPublishVersion, '1.0.0');
});

test('synthetic-archived resolves its GitHub repository', () => {
  const f = factsFromPackument(packument('synthetic-archived.json'), 'synthetic-archived');
  assert.deepEqual(f.repository, { owner: 'example-org', repo: 'archived-repo' });
  assert.equal(f.repositoryRaw, 'git+https://github.com/example-org/archived-repo.git');
});

test('parseGitHubRepo handles the documented repository forms', () => {
  assert.deepEqual(parseGitHubRepo('git+https://github.com/o/r.git'), { owner: 'o', repo: 'r' });
  assert.deepEqual(parseGitHubRepo('github:o/r'), { owner: 'o', repo: 'r' });
  assert.deepEqual(parseGitHubRepo('o/r'), { owner: 'o', repo: 'r' });
  assert.deepEqual(parseGitHubRepo('git@github.com:o/r.git'), { owner: 'o', repo: 'r' });
  assert.deepEqual(parseGitHubRepo('https://github.com/o/r/tree/main/packages/x'), { owner: 'o', repo: 'r' });
  assert.deepEqual(parseGitHubRepo({ url: 'git+ssh://git@github.com/O/R.js.git' }), { owner: 'O', repo: 'R.js' });
  assert.equal(parseGitHubRepo('https://gitlab.com/o/r'), null);
  assert.equal(parseGitHubRepo(null), null);
  assert.equal(parseGitHubRepo({}), null);
});
