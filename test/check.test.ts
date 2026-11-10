import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkEntries } from '../src/check.js';
import { factsFromPackument, type PackageFacts } from '../src/registry/facts.js';
import type { FactsResult, FactsSource, RepoResult } from '../src/registry/source.js';
import type { FindingId, ServerEntry, ServerResult } from '../src/types.js';
import { fixturePath } from './helpers/fixtures.js';

const NOW = new Date('2026-11-10T12:00:00.000Z');
const HOME = '/home/tester';

class StubSource implements FactsSource {
  mode: 'offline' | 'online' = 'offline';
  snapshotDate: string | null = '2026-11-10';
  pkgCalls: string[] = [];
  repoCalls: string[] = [];
  constructor(
    private pkg: (name: string, version?: string) => FactsResult = () => ({ kind: 'not-in-snapshot' }),
    private repo: (owner: string, repo: string) => RepoResult = () => ({ kind: 'not-in-snapshot' }),
  ) {}
  async packageFacts(name: string, version?: string): Promise<FactsResult> {
    this.pkgCalls.push(`${name}@${version ?? ''}`);
    return this.pkg(name, version);
  }
  async repoStatus(owner: string, repo: string): Promise<RepoResult> {
    this.repoCalls.push(`${owner}/${repo}`);
    return this.repo(owner, repo);
  }
}

const facts = (over: Partial<PackageFacts> = {}): PackageFacts => ({
  name: 'pkg', exists: true, resolvedVersion: '1.0.0', deprecated: null,
  lastPublish: '2026-11-01T00:00:00.000Z', lastPublishVersion: '1.0.0', repository: null,
  ...over,
});

const okFacts = (over: Partial<PackageFacts> = {}): FactsResult => ({ kind: 'ok', facts: facts(over) });

const entry = (over: Partial<ServerEntry> = {}): ServerEntry => ({
  client: 'claude-code', source: '/home/tester/.claude.json', name: 'srv',
  command: 'npx', args: ['-y', 'pkg'], envKeys: [], headerKeys: [], authHint: false, disabled: false,
  ...over,
});

const check = async (entries: ServerEntry[], src: FactsSource, verbose = false): Promise<ServerResult[]> =>
  checkEntries(entries, src, NOW, { home: HOME, verbose });

const ids = (r: ServerResult): FindingId[] => r.findings.map(f => f.id);
const only = (rs: ServerResult[]): ServerResult => {
  assert.equal(rs.length, 1);
  return rs[0];
};

test('DEPRECATED: blocked, message verbatim, includes snapshot date offline', async () => {
  const src = new StubSource(() => okFacts({ deprecated: 'Archived and unmaintained; see X' }));
  const r = only(await check([entry()], src));
  const f = r.findings.find(x => x.id === 'DEPRECATED');
  assert.ok(f);
  assert.equal(f.severity, 'blocked');
  assert.equal(f.evidence, 'Archived and unmaintained; see X');
  assert.match(f.message, /^npm marks pkg@1\.0\.0 deprecated \(as of snapshot 2026-11-10\)$/);
  assert.equal(r.verdict, 'REFUSE');
});

test('ARCHIVED: blocked, repo URL and last push as evidence', async () => {
  const src = new StubSource(
    () => okFacts({ repository: { owner: 'example-org', repo: 'archived-repo' } }),
    () => ({ kind: 'ok', archived: true, pushedAt: '2024-01-01T00:00:00Z', htmlUrl: 'https://github.com/example-org/archived-repo' }),
  );
  const r = only(await check([entry()], src));
  const f = r.findings.find(x => x.id === 'ARCHIVED');
  assert.ok(f);
  assert.equal(f.severity, 'blocked');
  assert.equal(f.evidence, 'https://github.com/example-org/archived-repo (last push 2024-01-01)');
  assert.equal(r.verdict, 'REFUSE');
});

test('ARCHIVED: a healthy repo produces no finding', async () => {
  const src = new StubSource(
    () => okFacts({ repository: { owner: 'example-org', repo: 'healthy-repo' } }),
    () => ({ kind: 'ok', archived: false, pushedAt: '2026-11-04T00:00:00Z', htmlUrl: 'https://github.com/example-org/healthy-repo' }),
  );
  const r = only(await check([entry()], src));
  assert.ok(!ids(r).includes('ARCHIVED'));
  assert.equal(r.verdict, 'OK');
});

test('VANISHED: package 404, unpublished document, and missing version are all blocked', async () => {
  const missing = only(await check([entry()], new StubSource(() => okFacts({ exists: false }))));
  assert.equal(missing.verdict, 'REFUSE');
  assert.equal(missing.findings.find(f => f.id === 'VANISHED')?.evidence, 'pkg');

  const unpublishedDoc = JSON.parse(readFileSync(fixturePath('registry', 'synthetic-unpublished.json'), 'utf8'));
  const unpublished = only(await check([entry()], new StubSource(() => ({ kind: 'ok', facts: factsFromPackument(unpublishedDoc, 'synthetic-unpublished') }))));
  assert.equal(unpublished.verdict, 'REFUSE');
  assert.ok(ids(unpublished).includes('VANISHED'));

  const versionMissing = only(await check(
    [entry({ args: ['-y', 'pkg@9.9.9'] })],
    new StubSource(() => okFacts({ versionMissing: true })),
  ));
  assert.equal(versionMissing.verdict, 'REFUSE');
  assert.match(versionMissing.findings.find(f => f.id === 'VANISHED')?.message ?? '', /^version 9\.9\.9 is not published$/);
});

test('STALE: warn when the newest publish is older than 365 days', async () => {
  const src = new StubSource(() => okFacts({ lastPublish: '2024-01-01T00:00:00.000Z', lastPublishVersion: '1.0.0' }));
  const r = only(await check([entry()], src));
  const f = r.findings.find(x => x.id === 'STALE');
  assert.ok(f);
  assert.equal(f.severity, 'warn');
  assert.equal(f.evidence, '1.0.0 published 2024-01-01');
  assert.equal(r.verdict, 'WARN');
});

test('STALE: exactly 365 days old is not stale', async () => {
  const src = new StubSource(() => okFacts({ lastPublish: '2025-11-10T12:00:00.000Z' }));
  const r = only(await check([entry()], src));
  assert.ok(!ids(r).includes('STALE'));
});

test('UNPINNED: info without a pin, absent with an exact pin and for explicit targets', async () => {
  const src = new StubSource(() => okFacts());
  const unpinned = only(await check([entry()], src));
  assert.equal(unpinned.findings.find(f => f.id === 'UNPINNED')?.severity, 'info');
  assert.equal(unpinned.verdict, 'OK');

  const pinned = only(await check([entry({ args: ['-y', 'pkg@1.0.0'] })], src));
  assert.ok(!ids(pinned).includes('UNPINNED'));

  const explicit = only(await check([entry({ client: 'explicit', source: '--package', args: ['pkg'] })], src));
  assert.ok(!ids(explicit).includes('UNPINNED'));
});

test('REMOTE-NO-AUTH: info, host-only evidence, never the URL', async () => {
  const e = entry({ command: undefined, args: [], url: 'https://u:pw-FAKE@mcp.example.com/mcp?token=qs-FAKE' });
  const r = only(await check([e], new StubSource()));
  const f = r.findings.find(x => x.id === 'REMOTE-NO-AUTH');
  assert.ok(f);
  assert.equal(f.severity, 'info');
  assert.equal(f.evidence, 'mcp.example.com');
  assert.ok(!JSON.stringify(r).includes('pw-FAKE'));
  assert.ok(!JSON.stringify(r).includes('qs-FAKE'));
  assert.equal(r.verdict, 'SKIPPED');
});

test('REMOTE-NO-AUTH: an auth header or token variable suppresses the finding', async () => {
  const withHeader = entry({ command: undefined, args: [], url: 'https://mcp.example.com/mcp', authHint: true, headerKeys: ['authorization'] });
  const r = only(await check([withHeader], new StubSource()));
  assert.deepEqual(r.findings, []);
});

test('BROKEN-PATH: missing local file warns; an existing file does not', async () => {
  const missing = only(await check([entry({ command: 'node', args: ['/home/tester/missing/index.js'] })], new StubSource()));
  const f = missing.findings.find(x => x.id === 'BROKEN-PATH');
  assert.ok(f);
  assert.equal(f.severity, 'warn');
  assert.equal(f.evidence, '~/missing/index.js');
  assert.equal(missing.verdict, 'WARN');

  const existing = only(await check([entry({ command: 'node', args: [fixturePath('configs', 'mcp.json')] })], new StubSource()));
  assert.ok(!ids(existing).includes('BROKEN-PATH'));
  assert.equal(existing.verdict, 'SKIPPED');
});

test('UNSUPPORTED-SOURCE: pypi, docker, unknown launcher and variable paths are info-only', async () => {
  const src = new StubSource();
  const pypi = only(await check([entry({ command: 'uvx', args: ['mcp-server-fetch'] })], src));
  assert.equal(pypi.verdict, 'SKIPPED');
  assert.equal(pypi.findings.find(f => f.id === 'UNSUPPORTED-SOURCE')?.severity, 'info');

  const docker = only(await check([entry({ command: 'docker', args: ['run', '-i', 'img/x'] })], src));
  assert.equal(docker.verdict, 'SKIPPED');

  const weird = only(await check([entry({ command: 'weird-launcher', args: [] })], src));
  assert.equal(weird.verdict, 'SKIPPED');
  assert.match(weird.findings[0].message, /not recognised/);

  const vars = only(await check([entry({ command: 'node', args: ['${HOME}/srv/index.js'] })], src));
  assert.equal(vars.findings[0].id, 'UNSUPPORTED-SOURCE');
  assert.match(vars.findings[0].message, /uses variables/);
});

test('NO-REPO: info when the package has no repository field', async () => {
  const r = only(await check([entry()], new StubSource(() => okFacts({ repository: null }))));
  const f = r.findings.find(x => x.id === 'NO-REPO');
  assert.ok(f);
  assert.equal(f.severity, 'info');
  assert.equal(r.verdict, 'OK');
});

test('REPO-NOT-FOUND: info, still OK', async () => {
  const src = new StubSource(
    () => okFacts({ repository: { owner: 'example-org', repo: 'missing-repo' } }),
    () => ({ kind: 'not-found' }),
  );
  const r = only(await check([entry()], src));
  assert.equal(r.findings.find(f => f.id === 'REPO-NOT-FOUND')?.severity, 'info');
  assert.equal(r.verdict, 'OK');
});

test('RANGE-NOT-RESOLVED: info when a range is checked against latest', async () => {
  const src = new StubSource(() => okFacts({ rangeNotResolved: true, resolvedVersion: '1.1.0' }));
  const r = only(await check([entry({ args: ['-y', 'pkg@^1.0.0'] })], src));
  const f = r.findings.find(x => x.id === 'RANGE-NOT-RESOLVED');
  assert.ok(f);
  assert.equal(f.severity, 'info');
  assert.match(f.message, /range "\^1\.0\.0" not resolved; checked 1\.1\.0/);
  assert.equal(r.verdict, 'OK');
});

test('NOT-IN-SNAPSHOT: unknown, names the snapshot date and --online', async () => {
  const r = only(await check([entry()], new StubSource(() => ({ kind: 'not-in-snapshot' }))));
  const f = r.findings.find(x => x.id === 'NOT-IN-SNAPSHOT');
  assert.ok(f);
  assert.equal(f.severity, 'unknown');
  assert.match(f.message, /not in the bundled snapshot \(2026-11-10\); run with --online to check it live/);
  assert.equal(r.verdict, 'UNKNOWN');
});

test('LOOKUP-FAILED: unknown on registry errors', async () => {
  const r = only(await check([entry()], new StubSource(() => ({ kind: 'error', reason: 'timeout' }))));
  const f = r.findings.find(x => x.id === 'LOOKUP-FAILED');
  assert.ok(f);
  assert.equal(f.severity, 'unknown');
  assert.equal(f.message, 'npm registry lookup failed: timeout');
  assert.equal(r.verdict, 'UNKNOWN');
});

test('ARCHIVED unknown on a GitHub rate limit — verdict UNKNOWN, never OK', async () => {
  const src = new StubSource(
    () => okFacts({ repository: { owner: 'example-org', repo: 'rate-limited-repo' } }),
    () => ({ kind: 'rate-limited' }),
  );
  const r = only(await check([entry()], src));
  const f = r.findings.find(x => x.id === 'ARCHIVED');
  assert.ok(f);
  assert.equal(f.severity, 'unknown');
  assert.equal(r.verdict, 'UNKNOWN');
});

test('ARCHIVED unknown when the snapshot has no repo status', async () => {
  const src = new StubSource(
    () => okFacts({ repository: { owner: 'example-org', repo: 'unchecked-repo' } }),
    () => ({ kind: 'not-in-snapshot' }),
  );
  const r = only(await check([entry()], src));
  assert.equal(r.verdict, 'UNKNOWN');
  assert.match(r.findings.find(f => f.id === 'ARCHIVED')?.message ?? '', /not in snapshot/);
});

test('already blocked: the GitHub lookup is skipped entirely', async () => {
  const src = new StubSource(
    () => okFacts({ deprecated: 'dead', repository: { owner: 'example-org', repo: 'archived-repo' } }),
    () => ({ kind: 'ok', archived: true, htmlUrl: 'https://github.com/example-org/archived-repo' }),
  );
  const r = only(await check([entry()], src));
  assert.equal(r.verdict, 'REFUSE');
  assert.deepEqual(src.repoCalls, []);

  const verbose = only(await check([entry()], src, true));
  assert.equal(verbose.findings.find(f => f.id === 'ARCHIVED')?.message, 'not checked: already refused');
});

test('identical packages are looked up once', async () => {
  const src = new StubSource(() => okFacts());
  const rs = await check([
    entry({ name: 'one' }),
    entry({ name: 'two' }),
    entry({ name: 'three' }),
    entry({ name: 'pinned', args: ['-y', 'pkg@1.0.0'] }),
  ], src);
  assert.equal(rs.length, 4);
  // three unpinned entries collapse to one lookup; the pinned spec is a different key
  assert.deepEqual(src.pkgCalls, ['pkg@', 'pkg@1.0.0']);
});

test('a disabled server is still checked and reported', async () => {
  const src = new StubSource(() => okFacts({ deprecated: 'dead' }));
  const r = only(await check([entry({ disabled: true })], src));
  assert.equal(r.disabled, true);
  assert.equal(r.verdict, 'REFUSE');
});

test('env values are never in the result, only names and state', async () => {
  const e = entry({ envKeys: [{ key: 'GITHUB_TOKEN', state: 'set' }, { key: 'OTHER', state: 'ref' }] });
  const r = only(await check([e], new StubSource(() => okFacts())));
  assert.deepEqual(r.env, ['GITHUB_TOKEN=<set>', 'OTHER=<ref>']);
});
