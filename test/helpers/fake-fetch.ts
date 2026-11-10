export type Route = { status: number; body?: unknown; headers?: Record<string, string> };
export interface RecordedRequest { url: string; init?: RequestInit }

export function fakeFetch(
  routes: Record<string, Route>,
  calls: string[] = [],
  requests: RecordedRequest[] = [],
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(url);
    requests.push({ url, init });
    const r = routes[url];
    if (!r) throw new TypeError(`fakeFetch: no route for ${url}`);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: r.headers });
  }) as typeof fetch;
}
