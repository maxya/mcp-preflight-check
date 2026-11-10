import { HostNotAllowedError, httpGetJson, type HttpDeps } from '../net/http.js';
import { factsFromPackument } from './facts.js';
import type { FactsResult } from './source.js';

export async function fetchPackageFacts(
  name: string,
  versionSpec: string | undefined,
  deps: HttpDeps,
): Promise<FactsResult> {
  const url = `https://registry.npmjs.org/${name.replace('/', '%2F')}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await httpGetJson(url, deps);
      if (r.status === 404) return { kind: 'ok', facts: { name, exists: false, deprecated: null, repository: null } };
      if (r.status === 200 && r.body && typeof r.body === 'object') {
        return { kind: 'ok', facts: factsFromPackument(r.body as never, name, versionSpec) };
      }
      if (r.status < 500) return { kind: 'error', reason: `registry HTTP ${r.status}` };
    } catch (e) {
      if (e instanceof HostNotAllowedError) throw e;
      if (attempt === 1) return { kind: 'error', reason: (e as Error).name === 'TimeoutError' ? 'timeout' : 'network error' };
    }
  }
  return { kind: 'error', reason: 'registry unavailable' };
}
