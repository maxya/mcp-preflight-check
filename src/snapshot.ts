import { existsSync, readFileSync } from 'node:fs';
import { isExactVersion } from './extract/index.js';
import { parseGitHubRepo } from './registry/facts.js';
import type { FactsResult, FactsSource, RepoResult } from './registry/source.js';

export interface SnapshotPackage {
  exists: boolean;
  latest: string | null;
  deprecated: string | null;
  deprecatedVersions: '*' | string[];
  lastPublish: string | null;
  lastPublishVersion: string | null;
  repository: string | null;
  repoArchived: boolean | null;
  repoPushedAt: string | null;
  checkedAt: string;
}

export interface SnapshotFile {
  schema: 1;
  tool: 'mcp-preflight-check';
  generatedAt: string;
  packages: Record<string, SnapshotPackage>;
}

function defaultSnapshotPath(): URL | string {
  const candidates = [
    new URL('../data/deprecated.json', import.meta.url),
    new URL('../../data/deprecated.json', import.meta.url),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return candidates[0];
}

export function readSnapshot(path?: string | URL): SnapshotFile {
  const file = path ?? defaultSnapshotPath();
  const doc = JSON.parse(readFileSync(file, 'utf8')) as SnapshotFile;
  if (!doc || typeof doc !== 'object' || !doc.packages || typeof doc.packages !== 'object') {
    throw new Error('snapshot file has no packages map');
  }
  return doc;
}

export class SnapshotSource implements FactsSource {
  readonly mode = 'offline' as const;
  readonly snapshotDate: string | null;
  private readonly packages: Record<string, SnapshotPackage>;
  private readonly repoIndex = new Map<string, SnapshotPackage>();

  constructor(private readonly doc: SnapshotFile) {
    this.packages = doc.packages;
    this.snapshotDate = typeof doc.generatedAt === 'string' ? doc.generatedAt.slice(0, 10) : null;
    for (const p of Object.values(this.packages)) {
      if (p.repository) this.repoIndex.set(p.repository.toLowerCase(), p);
    }
  }

  static fromFile(path?: string | URL): SnapshotSource {
    return new SnapshotSource(readSnapshot(path));
  }

  async packageFacts(name: string, versionSpec?: string): Promise<FactsResult> {
    const entry = this.packages[name];
    if (!entry) return { kind: 'not-in-snapshot' };
    if (!entry.exists) {
      return { kind: 'ok', facts: { name, exists: false, deprecated: null, repository: null } };
    }

    let resolvedVersion = entry.latest ?? undefined;
    let deprecated = entry.deprecated;
    let rangeNotResolved = false;

    if (versionSpec && versionSpec !== 'latest') {
      const v = versionSpec.replace(/^v/, '');
      if (isExactVersion(v)) {
        resolvedVersion = v;
        const list = entry.deprecatedVersions;
        const isDeprecated = list === '*' || (Array.isArray(list) && list.includes(v));
        deprecated = isDeprecated ? (entry.deprecated ?? 'deprecated on npm') : null;
      } else if (v !== resolvedVersion) {
        // tags other than latest and semver ranges: v1 has no resolver, latest is checked
        rangeNotResolved = true;
      }
    }

    return {
      kind: 'ok',
      facts: {
        name,
        exists: true,
        resolvedVersion,
        versionMissing: false,
        rangeNotResolved,
        deprecated: deprecated ?? null,
        lastPublish: entry.lastPublish ?? undefined,
        lastPublishVersion: entry.lastPublishVersion ?? undefined,
        repository: entry.repository ? parseGitHubRepo(entry.repository) : null,
        repositoryRaw: entry.repository ?? undefined,
      },
    };
  }

  async repoStatus(owner: string, repo: string): Promise<RepoResult> {
    const entry = this.repoIndex.get(`${owner}/${repo}`.toLowerCase());
    if (!entry) return { kind: 'not-in-snapshot' };
    if (entry.repoArchived === true || entry.repoArchived === false) {
      return {
        kind: 'ok',
        archived: entry.repoArchived,
        pushedAt: entry.repoPushedAt ?? undefined,
        htmlUrl: `https://github.com/${owner}/${repo}`,
      };
    }
    return { kind: 'not-in-snapshot' };
  }
}
