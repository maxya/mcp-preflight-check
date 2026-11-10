export interface PackageFacts {
  name: string;
  exists: boolean;
  resolvedVersion?: string;
  versionMissing?: boolean;
  rangeNotResolved?: boolean;
  deprecated: string | null;
  lastPublish?: string;
  lastPublishVersion?: string;
  repository: { owner: string; repo: string } | null;
  repositoryRaw?: string;
}

export function parseGitHubRepo(repository: unknown): { owner: string; repo: string } | null {
  let url: string | undefined;
  if (typeof repository === 'string') url = repository;
  else if (repository && typeof repository === 'object' && typeof (repository as { url?: unknown }).url === 'string')
    url = (repository as { url: string }).url;
  if (!url) return null;
  url = url.trim();
  const short = /^(?:github:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(url); // "o/r", "github:o/r"
  if (short && (url.startsWith('github:') || !url.includes(':'))) return { owner: short[1], repo: short[2] };
  const m = /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/#?].*)?$/i.exec(url);
  return m ? { owner: m[1], repo: m[2] } : null;
}

type Packument = {
  name?: string;
  'dist-tags'?: Record<string, string>;
  versions?: Record<string, { deprecated?: unknown; repository?: unknown }>;
  time?: Record<string, unknown>;
  repository?: unknown;
};

/** Pure: registry packument (full document, NOT the abbreviated install format) -> facts. */
export function factsFromPackument(doc: Packument, name: string, versionSpec?: string): PackageFacts {
  const versions = doc.versions ?? {};
  const names = Object.keys(versions);
  if (names.length === 0) return { name, exists: false, deprecated: null, repository: null }; // unpublished
  const tags = doc['dist-tags'] ?? {};
  let resolved = tags.latest ?? names[names.length - 1];
  let versionMissing = false, rangeNotResolved = false;
  if (versionSpec) {
    const v = versionSpec.replace(/^v/, '');
    if (tags[versionSpec]) resolved = tags[versionSpec];
    else if (versions[v]) resolved = v;
    else if (/^\d+\.\d+\.\d+/.test(v)) versionMissing = true;
    else rangeNotResolved = true; // ^1.2, ~1, >=… : zero-deps v1 checks latest and says so
  }
  const man = versions[resolved] ?? {};
  const dep = typeof man.deprecated === 'string' && man.deprecated.trim() !== '' ? man.deprecated : null;
  let lastPublish: string | undefined, lastPublishVersion: string | undefined;
  for (const [k, t] of Object.entries(doc.time ?? {})) {
    if (!(k in versions) || typeof t !== 'string') continue; // skips created/modified/unpublished + removed versions
    if (!lastPublish || t > lastPublish) { lastPublish = t; lastPublishVersion = k; }
  }
  const repoField = man.repository ?? doc.repository;
  return {
    name, exists: true, resolvedVersion: resolved, versionMissing, rangeNotResolved,
    deprecated: dep, lastPublish, lastPublishVersion,
    repository: parseGitHubRepo(repoField),
    repositoryRaw: typeof repoField === 'string' ? repoField : (repoField as { url?: string } | undefined)?.url,
  };
}
