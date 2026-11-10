import test from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotSource } from '../src/snapshot.js';
import { fixturePath } from './helpers/fixtures.js';

const source = () => SnapshotSource.fromFile(fixturePath('snapshot.json'));

test('snapshotDate is derived from generatedAt', () => {
  assert.equal(source().snapshotDate, '2026-11-10');
});

test('a package absent from the snapshot is not-in-snapshot (never OK)', async () => {
  assert.deepEqual(await source().packageFacts('not-there'), { kind: 'not-in-snapshot' });
});

test('exists:false yields facts with exists:false', async () => {
  const r = await source().packageFacts('gone-pkg');
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.equal(r.facts.exists, false);
});

test('deprecatedVersions:"*" marks latest and any exact version deprecated', async () => {
  const src = source();
  for (const spec of [undefined, 'latest', '2025.4.8', '0.5.1']) {
    const r = await src.packageFacts('@modelcontextprotocol/server-github', spec);
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') return;
    assert.match(r.facts.deprecated ?? '', /^Archived and unmaintained/, `spec=${spec}`);
  }
});

test('a deprecated-version array marks only the listed version', async () => {
  const src = source();
  const old = await src.packageFacts('deprecated-only-version', '1.0.0');
  assert.equal(old.kind, 'ok');
  if (old.kind !== 'ok') return;
  assert.ok(old.facts.deprecated);

  const latest = await src.packageFacts('deprecated-only-version');
  assert.equal(latest.kind, 'ok');
  if (latest.kind !== 'ok') return;
  assert.equal(latest.facts.deprecated, null);

  const newer = await src.packageFacts('deprecated-only-version', 'v1.1.0');
  assert.equal(newer.kind, 'ok');
  if (newer.kind !== 'ok') return;
  assert.equal(newer.facts.deprecated, null);
  assert.equal(newer.facts.resolvedVersion, '1.1.0');
});

test('a range sets rangeNotResolved; latest and dist-tags other than latest behave', async () => {
  const src = source();
  const range = await src.packageFacts('@modelcontextprotocol/server-filesystem', '^1.0.0');
  assert.equal(range.kind, 'ok');
  if (range.kind !== 'ok') return;
  assert.equal(range.facts.rangeNotResolved, true);
  assert.equal(range.facts.resolvedVersion, '2.2.0');

  const latest = await src.packageFacts('@modelcontextprotocol/server-filesystem', 'latest');
  assert.equal(latest.kind, 'ok');
  if (latest.kind !== 'ok') return;
  assert.equal(latest.facts.rangeNotResolved, false);

  const tag = await src.packageFacts('@modelcontextprotocol/server-filesystem', 'next');
  assert.equal(tag.kind, 'ok');
  if (tag.kind !== 'ok') return;
  assert.equal(tag.facts.rangeNotResolved, true);
});

test('lastPublish, resolvedVersion and repository are copied over', async () => {
  const r = await source().packageFacts('@modelcontextprotocol/server-filesystem');
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.equal(r.facts.resolvedVersion, '2.2.0');
  assert.equal(r.facts.lastPublish, '2026-11-04T21:36:25.725Z');
  assert.deepEqual(r.facts.repository, { owner: 'modelcontextprotocol', repo: 'servers' });
});

test('repoStatus uses the snapshot archived flag, case-insensitively', async () => {
  const r = await source().repoStatus('Example-Org', 'Archived-Repo');
  assert.deepEqual(r, {
    kind: 'ok', archived: true, pushedAt: '2024-01-01T00:00:00Z', htmlUrl: 'https://github.com/Example-Org/Archived-Repo',
  });
  const healthy = await source().repoStatus('modelcontextprotocol', 'servers');
  assert.equal(healthy.kind, 'ok');
  if (healthy.kind !== 'ok') return;
  assert.equal(healthy.archived, false);
});

test('repoStatus is not-in-snapshot when the repo was never checked', async () => {
  assert.deepEqual(await source().repoStatus('example-org', 'unchecked-repo'), { kind: 'not-in-snapshot' });
  assert.deepEqual(await source().repoStatus('example-org', 'unknown-repo'), { kind: 'not-in-snapshot' });
});

test('source mode is offline', () => {
  assert.equal(source().mode, 'offline');
});
