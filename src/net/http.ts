import { VERSION } from '../version.js';

export const ALLOWED_HOSTS: ReadonlySet<string> = new Set(['registry.npmjs.org', 'api.github.com']);
export class HostNotAllowedError extends Error {
  constructor(host: string) { super(`refusing request to non-allow-listed host: ${host}`); }
}
export interface HttpDeps { fetch: typeof fetch; timeoutMs?: number }
export interface HttpResult { status: number; headers: Headers; body: unknown }

function assertAllowed(u: URL) {
  if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname)) throw new HostNotAllowedError(u.hostname);
}

/** GET JSON from an allow-listed host. Redirects are followed manually, max 3, only to allow-listed hosts. */
export async function httpGetJson(url: string, deps: HttpDeps, headers: Record<string, string> = {}): Promise<HttpResult> {
  let u = new URL(url);
  for (let hop = 0; hop <= 3; hop++) {
    assertAllowed(u);
    const res = await deps.fetch(u, {
      redirect: 'manual',
      headers: { 'user-agent': `mcp-preflight-check/${VERSION}`, accept: 'application/json', ...headers },
      signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      u = new URL(res.headers.get('location')!, u);
      continue;
    }
    const text = await res.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return { status: res.status, headers: res.headers, body };
  }
  throw new Error('too many redirects');
}
