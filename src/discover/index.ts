import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { ClientId, ScanError, ServerEntry } from '../types.js';
import { candidates, type Candidate, type Env, type MapLocator } from './clients.js';
import { ConfigParseError, parseJsonc } from './jsonc.js';
import { normalizeServer } from './normalize.js';
import { parseTomlSubset } from './toml.js';

export interface ConfigInfo { path: string; client: ClientId; servers: number }

export interface DiscoveryResult {
  entries: ServerEntry[];
  configs: ConfigInfo[];
  errors: ScanError[];
  searched: string[];
}

interface Block { scope?: string; servers: Record<string, unknown> }

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

function locateBlocks(doc: unknown, loc: MapLocator, defaultScope?: string): Block[] {
  if (!isObj(doc)) return [];
  switch (loc.kind) {
    case 'json': {
      const v = doc[loc.key];
      return isObj(v) ? [{ scope: loc.scope ?? defaultScope, servers: v }] : [];
    }
    case 'claude-json': {
      const out: Block[] = [];
      if (isObj(doc.mcpServers)) out.push({ scope: 'user', servers: doc.mcpServers });
      if (isObj(doc.projects)) {
        for (const [p, proj] of Object.entries(doc.projects)) {
          if (isObj(proj) && isObj(proj.mcpServers)) out.push({ scope: `local:${p}`, servers: proj.mcpServers });
        }
      }
      return out;
    }
    case 'vscode-settings': {
      const mcp = doc.mcp;
      return isObj(mcp) && isObj(mcp.servers) ? [{ scope: defaultScope, servers: mcp.servers }] : [];
    }
    case 'opencode': {
      const mcp = doc.mcp;
      if (!isObj(mcp)) return [];
      if (isObj(mcp.servers)) return [{ scope: defaultScope, servers: mcp.servers }];
      const servers: Record<string, unknown> = {};
      for (const [name, v] of Object.entries(mcp)) {
        if (isObj(v) && typeof v.type === 'string') servers[name] = v;
      }
      return Object.keys(servers).length > 0 ? [{ scope: defaultScope, servers }] : [];
    }
    case 'codex-toml': {
      const v = doc.mcp_servers;
      return isObj(v) ? [{ scope: defaultScope, servers: v }] : [];
    }
  }
}

function readFailure(e: unknown): string {
  const err = e as NodeJS.ErrnoException;
  return err.code ?? 'file could not be read';
}

async function readConfig(path: string): Promise<{ text: string } | { error: ScanError; missing: boolean }> {
  try {
    return { text: await readFile(path, 'utf8') };
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === 'ENOENT';
    return { error: { source: path, message: readFailure(e) }, missing };
  }
}

function parseDoc(text: string, path: string, toml: boolean): unknown {
  return toml ? parseTomlSubset(text, path) : parseJsonc(text, path);
}

function parseFailure(e: unknown, path: string): ScanError {
  if (e instanceof ConfigParseError) return { source: path, message: e.message };
  return { source: path, message: 'parse failed' };
}

const entryKey = (e: ServerEntry) => `${e.client}|${e.source}|${e.scope ?? ''}|${e.name}`;

/** Auto-discover every known client config on the machine. Missing files are skipped silently. */
export async function discoverAll(env: Env): Promise<DiscoveryResult> {
  const all = candidates(env);
  const byPath = new Map<string, Candidate[]>();
  const searched: string[] = [];
  for (const c of all) {
    const path = resolve(c.path);
    let list = byPath.get(path);
    if (!list) { list = []; byPath.set(path, list); searched.push(path); }
    list.push(c);
  }

  const entries: ServerEntry[] = [];
  const configs: ConfigInfo[] = [];
  const errors: ScanError[] = [];

  for (const [path, list] of byPath) {
    // Dedupe table rows that describe the same file + locator (e.g. cwd === home).
    const seenLocators = new Set<string>();
    const unique: Candidate[] = [];
    for (const c of list) {
      const key = `${c.client}|${JSON.stringify(c.locate)}`;
      if (seenLocators.has(key)) continue;
      seenLocators.add(key);
      unique.push(c);
    }

    const read = await readConfig(path);
    if ('error' in read) {
      if (!read.missing) errors.push(read.error);
      continue;
    }
    let doc: unknown;
    try {
      doc = parseDoc(read.text, path, unique.some(c => c.locate.kind === 'codex-toml'));
    } catch (e) {
      errors.push(parseFailure(e, path));
      continue;
    }

    let count = 0;
    for (const c of unique) {
      for (const block of locateBlocks(doc, c.locate, c.scope)) {
        for (const [name, raw] of Object.entries(block.servers)) {
          const entry = normalizeServer(c.client, path, block.scope, name, raw);
          if (!entry) continue;
          entries.push(entry);
          count++;
        }
      }
    }
    if (count > 0) configs.push({ path, client: unique[0].client, servers: count });
  }

  const deduped: ServerEntry[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const k = entryKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(e);
  }

  return { entries: deduped, configs, errors, searched };
}

function explicitLocators(doc: unknown, path: string): MapLocator[] {
  if (basename(path) === '.claude.json') return [{ kind: 'claude-json' }];
  if (path.endsWith('.toml')) return [{ kind: 'codex-toml' }];
  if (isObj(doc)) {
    if (isObj(doc.mcpServers)) return [{ kind: 'json', key: 'mcpServers' }];
    if (isObj(doc.servers)) return [{ kind: 'json', key: 'servers' }];
    if (isObj(doc.mcp)) return [{ kind: 'opencode' }];
  }
  return [];
}

/** Load config files given explicitly on the command line (or --config). */
export async function loadExplicit(paths: string[], cwd: string): Promise<DiscoveryResult> {
  const entries: ServerEntry[] = [];
  const configs: ConfigInfo[] = [];
  const errors: ScanError[] = [];
  const searched: string[] = [];
  const seen = new Set<string>();

  for (const raw of paths) {
    const path = resolve(cwd, raw);
    if (seen.has(path)) continue;
    seen.add(path);
    searched.push(path);

    const read = await readConfig(path);
    if ('error' in read) { errors.push(read.error); continue; }

    let doc: unknown;
    try {
      doc = parseDoc(read.text, path, path.endsWith('.toml'));
    } catch (e) {
      errors.push(parseFailure(e, path));
      continue;
    }

    let count = 0;
    for (const loc of explicitLocators(doc, path)) {
      for (const block of locateBlocks(doc, loc)) {
        for (const [name, rawValue] of Object.entries(block.servers)) {
          const entry = normalizeServer('explicit', path, block.scope, name, rawValue);
          if (!entry) continue;
          entries.push(entry);
          count++;
        }
      }
    }
    if (count > 0) configs.push({ path, client: 'explicit', servers: count });
  }

  return { entries, configs, errors, searched };
}
