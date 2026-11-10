import { join } from 'node:path';
import { parseCliArgs, USAGE } from './args.js';
import { checkEntries } from './check.js';
import { discoverAll, loadExplicit, type ConfigInfo } from './discover/index.js';
import { parsePackageSpec } from './extract/index.js';
import { GitHubClient } from './github/client.js';
import { exitCode } from './grade.js';
import { fetchPackageFacts } from './registry/client.js';
import type { FactsSource } from './registry/source.js';
import { renderCi, renderHuman } from './report/human.js';
import { renderJson } from './report/json.js';
import { SnapshotSource } from './snapshot.js';
import type { ScanError, ServerEntry, Report } from './types.js';
import { cacheDir } from './util/paths.js';
import { VERSION } from './version.js';

export interface Io { stdout(s: string): void; stderr(s: string): void; isTTY: boolean }

export interface Deps {
  fetch: typeof fetch;
  env: NodeJS.ProcessEnv;
  cwd: string;
  home: string;
  platform: NodeJS.Platform;
  now: Date;
  snapshotPath?: string;
}

export async function run(argv: string[], io: Io, deps: Deps): Promise<number> {
  const parsed = parseCliArgs(argv);
  if (!parsed.ok) {
    io.stderr(`${parsed.message}\n\n${USAGE}`);
    return 1;
  }
  const args = parsed.args;

  if (args.command === 'help') {
    io.stdout(USAGE);
    return 0;
  }
  if (args.command === 'version') {
    io.stdout(`${VERSION}\n`);
    return 0;
  }

  const cacheHits: string[] = [];
  let source: FactsSource;
  let snapshotDate: string | null = null;

  try {
    if (args.online) {
      const http = { fetch: deps.fetch };
      const cacheFile = join(cacheDir(deps.env, deps.platform, deps.home), 'github.json');
      const github = new GitHubClient({
        http,
        cacheFile,
        now: deps.now,
        token: deps.env.GITHUB_TOKEN || undefined,
        onCacheHit: key => cacheHits.push(key),
      });
      // In offline mode this branch is never taken and deps.fetch is never handed to anything.
      source = {
        mode: 'online',
        snapshotDate: null,
        packageFacts: (name, version) => fetchPackageFacts(name, version, http),
        repoStatus: (owner, repo) => github.repoStatus(owner, repo),
      };
    } else {
      const snapshot = SnapshotSource.fromFile(deps.snapshotPath);
      snapshotDate = snapshot.snapshotDate;
      source = snapshot;
    }
  } catch (e) {
    io.stderr(`mcp-preflight-check: cannot load the offline snapshot: ${(e as Error).message}\n`);
    return 1;
  }

  const entries: ServerEntry[] = [];
  const configs: ConfigInfo[] = [];
  const errors: ScanError[] = [];
  let searched: string[] = [];

  try {
    if (args.paths.length > 0) {
      const loaded = await loadExplicit(args.paths, deps.cwd);
      entries.push(...loaded.entries);
      configs.push(...loaded.configs);
      errors.push(...loaded.errors);
      searched = loaded.searched;
    } else if (args.packages.length === 0) {
      const found = await discoverAll({ home: deps.home, cwd: deps.cwd, platform: deps.platform, env: deps.env });
      entries.push(...found.entries);
      configs.push(...found.configs);
      errors.push(...found.errors);
      searched = found.searched;
    }
  } catch (e) {
    io.stderr(`mcp-preflight-check: discovery failed: ${(e as Error).message}\n`);
    return 1;
  }

  for (const spec of args.packages) {
    entries.push({
      client: 'explicit',
      source: '--package',
      name: parsePackageSpec(spec)?.name ?? spec,
      command: 'npx',
      args: [spec],
      envKeys: [],
      headerKeys: [],
      authHint: false,
      disabled: false,
    });
  }

  let servers;
  try {
    servers = await checkEntries(entries, source, deps.now, { verbose: args.verbose, home: deps.home });
  } catch (e) {
    io.stderr(`mcp-preflight-check: check failed: ${(e as Error).message}\n`);
    return 1;
  }

  const build = (list: typeof servers) => ({
    checked: list.length,
    refused: list.filter(s => s.verdict === 'REFUSE').length,
    warned: list.filter(s => s.verdict === 'WARN').length,
    unknown: list.filter(s => s.verdict === 'UNKNOWN').length,
    ok: list.filter(s => s.verdict === 'OK').length,
    skipped: list.filter(s => s.verdict === 'SKIPPED').length,
  });

  const report: Report = {
    schema: 1,
    tool: 'mcp-preflight-check',
    version: VERSION,
    offline: !args.online,
    snapshotDate,
    configs,
    servers,
    errors,
    summary: build(servers),
  };

  const code = exitCode(report, args.failOn);
  const color = io.isTTY && deps.env.NO_COLOR == null && !args.noColor && !args.ci;

  if (args.json) {
    io.stdout(renderJson(report));
  } else if (args.ci) {
    io.stdout(renderCi(report, { color: false, verbose: args.verbose, home: deps.home, failOn: args.failOn, exit: code }));
  } else {
    io.stdout(renderHuman(report, {
      color,
      verbose: args.verbose,
      home: deps.home,
      failOn: args.failOn,
      exit: code,
      searched,
    }));
  }

  if (args.verbose && cacheHits.length > 0) {
    for (const key of cacheHits) io.stderr(`github cache hit: ${key}\n`);
  }

  return code;
}
