import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { extractTarget, type Target } from './extract/index.js';
import { grade } from './grade.js';
import type { PackageFacts } from './registry/facts.js';
import type { FactsResult, FactsSource, RepoResult } from './registry/source.js';
import type { Finding, ServerEntry, ServerResult } from './types.js';
import { tildify } from './util/paths.js';
import { pool } from './util/pool.js';

const STALE_DAYS = 365;
const DAY_MS = 86_400_000;

export interface CheckOptions {
  verbose?: boolean;
  home?: string;
}

export async function checkEntries(
  entries: ServerEntry[],
  src: FactsSource,
  now: Date,
  opts: CheckOptions = {},
): Promise<ServerResult[]> {
  const home = opts.home ?? homedir();
  const targets = entries.map(e => ({ e, t: extractTarget(e.command, e.args, e.url) }));
  const key = (n: string, v?: string) => `${n}@${v ?? ''}`;
  const uniq = new Map<string, { name: string; version?: string }>();
  for (const { t } of targets) {
    if (t.kind === 'npm') uniq.set(key(t.spec.name, t.spec.version), { name: t.spec.name, version: t.spec.version });
  }
  const facts = new Map<string, FactsResult>();
  await pool([...uniq.entries()], 4, async ([k, p]) => {
    facts.set(k, await src.packageFacts(p.name, p.version));
  });
  const repoMemo = new Map<string, Promise<RepoResult>>();

  const out: ServerResult[] = [];
  for (const { e, t } of targets) {
    const f: Finding[] = [];
    if (t.kind === 'npm') {
      if (!t.pinned && e.client !== 'explicit') {
        f.push({
          id: 'UNPINNED', severity: 'info',
          message: 'no exact version pin; runs whatever is newest at launch',
          evidence: t.display,
        });
      }
      const factsResult = facts.get(key(t.spec.name, t.spec.version));
      if (factsResult) f.push(...await npmFindings(factsResult, t, src, repoMemo, now, opts, home));
    } else if (t.kind === 'pypi') {
      f.push({
        id: 'UNSUPPORTED-SOURCE', severity: 'info',
        message: 'PyPI packages are not checked in v1 — no verdict', evidence: t.display,
      });
    } else if (t.kind === 'docker') {
      f.push({
        id: 'UNSUPPORTED-SOURCE', severity: 'info',
        message: 'container images are not checked in v1 — no verdict',
        evidence: t.image || '(no image found)',
      });
    } else if (t.kind === 'local') {
      f.push(...await localPathFindings(t.path, e, home));
    } else if (t.kind === 'remote') {
      if (!e.authHint) {
        f.push({
          id: 'REMOTE-NO-AUTH', severity: 'info',
          message: 'remote server with no auth header or token variable in config (the client may still use OAuth)',
          evidence: t.display,
        });
      }
    } else {
      f.push({ id: 'UNSUPPORTED-SOURCE', severity: 'info', message: t.reason, evidence: t.display });
    }
    out.push({
      name: e.name, client: e.client, source: e.source, scope: e.scope, disabled: e.disabled,
      package: t.kind === 'npm' ? t.spec.raw : null, target: t.kind, display: t.display,
      env: e.envKeys.map(k => `${k.key}=<${k.state}>`),
      verdict: grade(t.kind, f), findings: f,
    });
  }
  return out;
}

async function npmFindings(
  result: FactsResult,
  target: Extract<Target, { kind: 'npm' }>,
  src: FactsSource,
  repoMemo: Map<string, Promise<RepoResult>>,
  now: Date,
  opts: CheckOptions,
  home: string,
): Promise<Finding[]> {
  const out: Finding[] = [];
  const date = src.snapshotDate ?? 'unknown';
  const asOf = src.mode === 'offline' && src.snapshotDate ? ` (as of snapshot ${src.snapshotDate})` : '';

  if (result.kind === 'not-in-snapshot') {
    out.push({
      id: 'NOT-IN-SNAPSHOT', severity: 'unknown',
      message: `not in the bundled snapshot (${date}); run with --online to check it live`,
    });
    return out;
  }
  if (result.kind === 'error') {
    out.push({ id: 'LOOKUP-FAILED', severity: 'unknown', message: `npm registry lookup failed: ${result.reason}` });
    return out;
  }

  const facts: PackageFacts = result.facts;
  if (!facts.exists) {
    out.push({
      id: 'VANISHED', severity: 'blocked',
      message: `package ${target.spec.name} is not in the npm registry`,
      evidence: target.spec.raw,
    });
    return out;
  }
  if (facts.versionMissing) {
    out.push({
      id: 'VANISHED', severity: 'blocked',
      message: `version ${target.spec.version} is not published`,
      evidence: target.spec.raw,
    });
    return out;
  }
  if (facts.rangeNotResolved) {
    out.push({
      id: 'RANGE-NOT-RESOLVED', severity: 'info',
      message: `range "${target.spec.version}" not resolved; checked ${facts.resolvedVersion}`,
      evidence: target.display,
    });
  }
  if (facts.deprecated) {
    out.push({
      id: 'DEPRECATED', severity: 'blocked',
      message: `npm marks ${target.spec.name}@${facts.resolvedVersion} deprecated${asOf}`,
      evidence: facts.deprecated,
    });
  }
  if (facts.lastPublish) {
    const t = Date.parse(facts.lastPublish);
    if (Number.isFinite(t) && now.getTime() - t > STALE_DAYS * DAY_MS) {
      out.push({
        id: 'STALE', severity: 'warn',
        message: `newest publish is older than ${STALE_DAYS} days`,
        evidence: `${facts.lastPublishVersion} published ${facts.lastPublish.slice(0, 10)}`,
      });
    }
  }

  const repo = facts.repository;
  if (!repo) {
    out.push({
      id: 'NO-REPO', severity: 'info',
      message: 'no GitHub repository in package metadata; archive status not checkable',
    });
    return out;
  }

  // Save GitHub rate limit: a refused server cannot be un-refused by the archive check.
  if (out.some(x => x.severity === 'blocked')) {
    if (opts.verbose) out.push({ id: 'ARCHIVED', severity: 'info', message: 'not checked: already refused' });
    return out;
  }

  const repoKey = `${repo.owner}/${repo.repo}`.toLowerCase();
  let pending = repoMemo.get(repoKey);
  if (!pending) {
    pending = src.repoStatus(repo.owner, repo.repo);
    repoMemo.set(repoKey, pending);
  }
  const status = await pending;

  if (status.kind === 'ok') {
    if (status.archived) {
      const push = status.pushedAt ? `last push ${status.pushedAt.slice(0, 10)}` : 'last push unknown';
      out.push({
        id: 'ARCHIVED', severity: 'blocked',
        message: `repository ${repo.owner}/${repo.repo} is archived`,
        evidence: `${status.htmlUrl} (${push})`,
      });
    }
  } else if (status.kind === 'not-found') {
    out.push({
      id: 'REPO-NOT-FOUND', severity: 'info',
      message: `repository ${repo.owner}/${repo.repo} was not found on GitHub`,
    });
  } else if (status.kind === 'rate-limited') {
    out.push({
      id: 'ARCHIVED', severity: 'unknown',
      message: 'GitHub rate limit reached (60/hour without a token); archive status not checked',
    });
  } else if (status.kind === 'not-in-snapshot') {
    out.push({
      id: 'ARCHIVED', severity: 'unknown',
      message: 'archive status not in snapshot; run with --online',
    });
  } else {
    out.push({
      id: 'ARCHIVED', severity: 'unknown',
      message: `archive status check failed: ${status.reason}`,
    });
  }
  return out;
}

async function localPathFindings(path: string, e: ServerEntry, home: string): Promise<Finding[]> {
  if (/\$\{|\{env:/.test(path)) {
    return [{ id: 'UNSUPPORTED-SOURCE', severity: 'info', message: 'path uses variables; not checked', evidence: path }];
  }
  const resolved = isAbsolute(path) ? path : resolve(e.cwd ?? dirname(e.source), path);
  try {
    await stat(resolved);
    return [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [{
        id: 'BROKEN-PATH', severity: 'warn',
        message: 'local server path does not exist',
        evidence: tildify(resolved, home),
      }];
    }
    return [{
      id: 'UNSUPPORTED-SOURCE', severity: 'info',
      message: 'local server path could not be checked',
      evidence: tildify(resolved, home),
    }];
  }
}
