import { join } from 'node:path';

export function cacheDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string {
  if (env.MCP_PREFLIGHT_CHECK_CACHE_DIR) return env.MCP_PREFLIGHT_CHECK_CACHE_DIR; // tests use this
  if (platform === 'win32') return join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'mcp-preflight-check', 'Cache');
  if (platform === 'darwin') return join(home, 'Library', 'Caches', 'mcp-preflight-check');
  return join(env.XDG_CACHE_HOME || join(home, '.cache'), 'mcp-preflight-check');
}

export const tildify = (p: string, home: string) => (p.startsWith(home) ? '~' + p.slice(home.length) : p);
