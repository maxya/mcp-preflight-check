import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface CacheEntry {
  fetchedAt: string;
  status: 'ok' | 'not_found';
  archived?: boolean;
  pushedAt?: string;
  htmlUrl?: string;
}

export interface CacheFile {
  version: 1;
  entries: Record<string, CacheEntry>;
}

export const CACHE_TTL_MS = 7 * 86_400_000;

const empty = (): CacheFile => ({ version: 1, entries: {} });

/** Load the GitHub cache. A missing, corrupt or wrong-version file is treated as empty. */
export async function loadCache(file: string): Promise<CacheFile> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object') return empty();
    const doc = raw as Partial<CacheFile>;
    if (doc.version !== 1 || !doc.entries || typeof doc.entries !== 'object') return empty();
    const entries: Record<string, CacheEntry> = {};
    for (const [key, value] of Object.entries(doc.entries)) {
      if (!value || typeof value !== 'object') continue;
      const e = value as Partial<CacheEntry>;
      if (typeof e.fetchedAt !== 'string') continue;
      if (e.status !== 'ok' && e.status !== 'not_found') continue;
      entries[key] = {
        fetchedAt: e.fetchedAt,
        status: e.status,
        ...(typeof e.archived === 'boolean' ? { archived: e.archived } : {}),
        ...(typeof e.pushedAt === 'string' ? { pushedAt: e.pushedAt } : {}),
        ...(typeof e.htmlUrl === 'string' ? { htmlUrl: e.htmlUrl } : {}),
      };
    }
    return { version: 1, entries };
  } catch {
    return empty();
  }
}

export function isFresh(entry: CacheEntry, now: Date): boolean {
  const t = Date.parse(entry.fetchedAt);
  if (!Number.isFinite(t)) return false;
  return Math.abs(now.getTime() - t) <= CACHE_TTL_MS;
}

/** Write atomically: tmp file, then rename. Never stores headers or tokens. */
export async function saveCache(file: string, cache: CacheFile): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(cache, null, 2) + '\n', 'utf8');
  await rename(tmp, file);
}
