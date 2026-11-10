export type ClientId =
  | 'claude-code' | 'mcp-json' | 'claude-desktop' | 'cursor' | 'vscode' | 'copilot'
  | 'devin' | 'windsurf' | 'gemini' | 'codex' | 'opencode' | 'explicit';

export interface EnvKey { key: string; state: 'set' | 'ref' | 'empty' }

/** One MCP server as written in one config file. Holds NO secret values. */
export interface ServerEntry {
  client: ClientId;
  source: string;          // absolute config path (or "--package")
  scope?: string;          // e.g. "user", "project", "local:/path/to/project"
  name: string;
  command?: string;
  args: string[];          // raw args — only extract/ may read them; never print raw
  url?: string;            // raw url — never print raw; host only
  cwd?: string;
  envKeys: EnvKey[];       // names + state only, values are dropped at normalize time
  headerKeys: string[];    // header names only
  authHint: boolean;       // auth header / token variable / oauth configured
  disabled: boolean;
}

export type Severity = 'blocked' | 'warn' | 'unknown' | 'info';
export type FindingId =
  | 'DEPRECATED' | 'ARCHIVED' | 'VANISHED' | 'STALE' | 'UNPINNED' | 'REMOTE-NO-AUTH'
  | 'BROKEN-PATH' | 'UNSUPPORTED-SOURCE' | 'NO-REPO' | 'REPO-NOT-FOUND'
  | 'RANGE-NOT-RESOLVED' | 'NOT-IN-SNAPSHOT' | 'LOOKUP-FAILED';

export interface Finding { id: FindingId; severity: Severity; message: string; evidence?: string }

export type Verdict = 'REFUSE' | 'WARN' | 'UNKNOWN' | 'OK' | 'SKIPPED';

export interface ServerResult {
  name: string;
  client: ClientId;
  source: string;
  scope?: string;
  disabled: boolean;
  package: string | null;           // npm spec as written (e.g. "@scope/x@1.2.3"), null if not npm
  target: 'npm' | 'pypi' | 'docker' | 'local' | 'remote' | 'unsupported';
  display: string;                  // masked, printable
  env: string[];                    // ["GITHUB_TOKEN=<set>"]
  verdict: Verdict;
  findings: Finding[];
}

export interface ScanError { source: string; message: string } // message must not contain file text

export interface ConfigInfo { path: string; client: ClientId; servers: number }

export interface Report {
  schema: 1;
  tool: 'mcp-preflight-check';
  version: string;
  offline: boolean;
  snapshotDate: string | null;      // data/deprecated.json generatedAt (YYYY-MM-DD)
  configs: ConfigInfo[];
  servers: ServerResult[];
  errors: ScanError[];
  summary: { checked: number; refused: number; warned: number; unknown: number; ok: number; skipped: number };
}
