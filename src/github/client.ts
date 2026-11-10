import { HostNotAllowedError, httpGetJson, type HttpDeps } from '../net/http.js';
import type { RepoResult } from '../registry/source.js';
import { isFresh, loadCache, saveCache, type CacheEntry, type CacheFile } from './cache.js';

export interface GitHubClientOptions {
  http: HttpDeps;
  token?: string;
  cacheFile: string;
  now: Date;
  onCacheHit?: (key: string) => void;
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function fromEntry(entry: CacheEntry, owner: string, repo: string): RepoResult {
  if (entry.status === 'not_found') return { kind: 'not-found' };
  return {
    kind: 'ok',
    archived: entry.archived === true,
    pushedAt: entry.pushedAt,
    htmlUrl: entry.htmlUrl ?? `https://github.com/${owner}/${repo}`,
  };
}

export class GitHubClient {
  private cache: CacheFile = { version: 1, entries: {} };
  private loaded = false;
  private tripped = false;

  constructor(private opts: GitHubClientOptions) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.cache = await loadCache(this.opts.cacheFile);
    this.loaded = true;
  }

  /** True when a rate-limit response has disabled further GitHub calls for this run. */
  get rateLimited(): boolean {
    return this.tripped;
  }

  async repoStatus(owner: string, repo: string): Promise<RepoResult> {
    const key = `${owner}/${repo}`.toLowerCase();
    await this.ensureLoaded();

    const cached = this.cache.entries[key];
    if (cached && isFresh(cached, this.opts.now)) {
      this.opts.onCacheHit?.(key);
      return fromEntry(cached, owner, repo);
    }

    // Circuit breaker: once GitHub says we are rate-limited, stop asking this run.
    if (this.tripped) return { kind: 'rate-limited' };

    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    };
    if (this.opts.token) headers.authorization = `Bearer ${this.opts.token}`;

    let r;
    try {
      r = await httpGetJson(`https://api.github.com/repos/${owner}/${repo}`, this.opts.http, headers);
    } catch (e) {
      if (e instanceof HostNotAllowedError) throw e;
      return { kind: 'error', reason: (e as Error).name === 'TimeoutError' ? 'timeout' : 'network error' };
    }

    const fetchedAt = this.opts.now.toISOString();

    if (r.status === 200 && isObj(r.body)) {
      const entry: CacheEntry = {
        fetchedAt,
        status: 'ok',
        archived: r.body.archived === true,
        ...(str(r.body.pushed_at) ? { pushedAt: str(r.body.pushed_at) } : {}),
        htmlUrl: str(r.body.html_url) ?? `https://github.com/${owner}/${repo}`,
      };
      this.cache.entries[key] = entry;
      await saveCache(this.opts.cacheFile, this.cache);
      return fromEntry(entry, owner, repo);
    }

    if (r.status === 404) {
      const entry: CacheEntry = { fetchedAt, status: 'not_found' };
      this.cache.entries[key] = entry;
      await saveCache(this.opts.cacheFile, this.cache);
      return { kind: 'not-found' };
    }

    if (r.status === 403 || r.status === 429) {
      const remaining = r.headers.get('x-ratelimit-remaining');
      const retryAfter = r.headers.get('retry-after');
      if (remaining === '0' || retryAfter !== null) {
        this.tripped = true;
        return { kind: 'rate-limited' };
      }
    }

    return { kind: 'error', reason: `GitHub HTTP ${r.status}` };
  }
}
