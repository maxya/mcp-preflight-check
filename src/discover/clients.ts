import { join } from 'node:path';
import type { ClientId } from '../types.js';

export type MapLocator =
  | { kind: 'json'; key: 'mcpServers' | 'servers'; scope?: string }
  | { kind: 'claude-json' }                 // mcpServers + projects.*.mcpServers
  | { kind: 'vscode-settings' }             // settings.json -> mcp.servers
  | { kind: 'opencode' }                    // mcp.servers (v2) or mcp.<name> (v1)
  | { kind: 'codex-toml' };

export interface Candidate { client: ClientId; path: string; locate: MapLocator; scope?: string }

export interface Env { home: string; cwd: string; platform: NodeJS.Platform; env: NodeJS.ProcessEnv }

export function candidates({ home, cwd, platform, env }: Env): Candidate[] {
  const appData = env.APPDATA ?? join(home, 'AppData', 'Roaming');
  const macSupport = join(home, 'Library', 'Application Support');
  const vscodeUserDirs = ['Code', 'Code - Insiders'].map(product =>
    platform === 'win32' ? join(appData, product, 'User')
    : platform === 'darwin' ? join(macSupport, product, 'User')
    : join(home, '.config', product, 'User'));
  const claudeDesktop =
    platform === 'win32' ? join(appData, 'Claude', 'claude_desktop_config.json')
    : platform === 'darwin' ? join(macSupport, 'Claude', 'claude_desktop_config.json')
    : join(home, '.config', 'Claude', 'claude_desktop_config.json');
  const codexHome = env.CODEX_HOME ?? join(home, '.codex');
  const copilotHome = env.COPILOT_HOME ?? join(home, '.copilot');

  const j = (key: 'mcpServers' | 'servers'): MapLocator => ({ kind: 'json', key });
  return [
    { client: 'claude-code', path: join(home, '.claude.json'), locate: { kind: 'claude-json' } },
    { client: 'mcp-json', path: join(cwd, '.mcp.json'), locate: j('mcpServers'), scope: 'project' },
    { client: 'claude-desktop', path: claudeDesktop, locate: j('mcpServers'), scope: 'user' },
    { client: 'cursor', path: join(home, '.cursor', 'mcp.json'), locate: j('mcpServers'), scope: 'user' },
    { client: 'cursor', path: join(cwd, '.cursor', 'mcp.json'), locate: j('mcpServers'), scope: 'project' },
    { client: 'vscode', path: join(cwd, '.vscode', 'mcp.json'), locate: j('servers'), scope: 'project' },
    ...vscodeUserDirs.flatMap((d): Candidate[] => [
      { client: 'vscode', path: join(d, 'mcp.json'), locate: j('servers'), scope: 'user' },
      { client: 'vscode', path: join(d, 'settings.json'), locate: { kind: 'vscode-settings' }, scope: 'user' },
    ]),
    { client: 'copilot', path: join(copilotHome, 'mcp-config.json'), locate: j('mcpServers'), scope: 'user' },
    { client: 'devin', path: join(cwd, '.devin', 'mcp_config.json'), locate: j('mcpServers'), scope: 'project' },
    { client: 'devin', path: join(cwd, '.devin', 'mcp_config.local.json'), locate: j('mcpServers'), scope: 'local' },
    { client: 'devin', path: join(home, '.config', 'devin', 'mcp_config.json'), locate: j('mcpServers'), scope: 'user' },
    { client: 'windsurf', path: join(home, '.codeium', 'windsurf', 'mcp_config.json'), locate: j('mcpServers'), scope: 'user' },
    { client: 'gemini', path: join(home, '.gemini', 'settings.json'), locate: j('mcpServers'), scope: 'user' },
    { client: 'gemini', path: join(cwd, '.gemini', 'settings.json'), locate: j('mcpServers'), scope: 'project' },
    { client: 'codex', path: join(codexHome, 'config.toml'), locate: { kind: 'codex-toml' }, scope: 'user' },
    { client: 'codex', path: join(cwd, '.codex', 'config.toml'), locate: { kind: 'codex-toml' }, scope: 'project' },
    ...['opencode.json', 'opencode.jsonc'].flatMap((f): Candidate[] => [
      { client: 'opencode', path: join(cwd, f), locate: { kind: 'opencode' }, scope: 'project' },
      { client: 'opencode', path: join(home, '.config', 'opencode', f), locate: { kind: 'opencode' }, scope: 'user' },
    ]),
  ];
}
