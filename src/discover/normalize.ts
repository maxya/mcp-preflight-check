import type { ClientId, EnvKey, ServerEntry } from '../types.js';

const REF = /\$\{[^}]+\}|\{env:[^}]+\}/;              // ${VAR} ${env:X} ${input:x} {env:X}
const AUTH_HEADER = /^(authorization|proxy-authorization|x-api-key|api[-_]?key)$|token|secret/i;
const AUTH_ENV = /token|secret|api[-_]?key|password|auth/i;

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const strArr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

function envKeys(env: Record<string, unknown> | undefined): EnvKey[] {
  return Object.entries(env ?? {}).map(([key, v]) => ({
    key,
    state: v === '' || v == null ? 'empty' : typeof v === 'string' && REF.test(v) ? 'ref' : 'set',
  }));
}

export function normalizeServer(
  client: ClientId, source: string, scope: string | undefined, name: string, raw: unknown,
): ServerEntry | null {
  const r = obj(raw);
  if (!r) return null;
  let command = str(r.command);
  let args = strArr(r.args);
  if (Array.isArray(r.command)) {                 // OpenCode: command is [exe, ...args]
    const a = strArr(r.command); command = a[0]; args = [...a.slice(1), ...args];
  }
  const url = str(r.url) ?? str(r.serverUrl) ?? str(r.httpUrl);
  const env = obj(r.env) ?? obj(r.environment);
  const headers = { ...obj(r.headers), ...obj(r.http_headers) };
  const keys = envKeys(env);
  for (const k of strArr(r.env_vars)) keys.push({ key: k, state: 'ref' });   // Codex
  if (typeof r.envFile === 'string') keys.push({ key: 'envFile', state: 'set' });
  const headerKeys = [...Object.keys(headers), ...Object.keys(obj(r.env_http_headers) ?? {})];
  const authHint =
    headerKeys.some(h => AUTH_HEADER.test(h)) ||
    typeof r.bearer_token_env_var === 'string' ||
    (r.oauth !== undefined && r.oauth !== false) ||
    keys.some(k => AUTH_ENV.test(k.key));
  if (!command && !url) return null;              // e.g. Codex [mcp_servers.x.tools.y] only
  return {
    client, source, scope, name, command, args, url, cwd: str(r.cwd),
    envKeys: keys, headerKeys, authHint,
    disabled: r.disabled === true || r.enabled === false,
  };
}
