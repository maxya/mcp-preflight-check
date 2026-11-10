import type { ClientId, Finding, Report, ServerResult, Verdict } from '../types.js';
import type { FailOn } from '../grade.js';
import { tildify } from '../util/paths.js';

export interface HumanOptions {
  color: boolean;
  verbose: boolean;
  home: string;
  failOn: FailOn;
  exit: number;
  searched?: string[];
}

const LABELS: Record<ClientId, string> = {
  'claude-code': 'Claude Code',
  'mcp-json': '.mcp.json shared',
  'claude-desktop': 'Claude Desktop',
  cursor: 'Cursor',
  vscode: 'VS Code',
  copilot: 'GitHub Copilot',
  devin: 'Devin Local',
  windsurf: 'Windsurf (legacy)',
  gemini: 'Gemini CLI',
  codex: 'Codex',
  opencode: 'OpenCode',
  explicit: 'explicit',
};

const ANSI = {
  reset: '\u001b[0m',
  red: '\u001b[31m',
  yellow: '\u001b[33m',
  magenta: '\u001b[35m',
  green: '\u001b[32m',
  dim: '\u001b[2m',
};

const VERDICT_COLOR: Record<Verdict, string> = {
  REFUSE: ANSI.red,
  WARN: ANSI.yellow,
  UNKNOWN: ANSI.magenta,
  OK: ANSI.green,
  SKIPPED: ANSI.dim,
};

const SYMBOL: Record<Finding['severity'], string> = {
  blocked: '✖',
  warn: '▲',
  unknown: '?',
  info: '·',
};

const FIND_INDENT = '             ';

const paint = (s: string, code: string, on: boolean) => (on ? `${code}${s}${ANSI.reset}` : s);

function visibleFindings(s: ServerResult, verbose: boolean): Finding[] {
  return s.findings.filter(f =>
    f.severity !== 'info' ||
    verbose ||
    (s.verdict === 'SKIPPED' && f.id === 'UNSUPPORTED-SOURCE'),
  );
}

function header(report: Report): string {
  const mode = report.offline
    ? `offline${report.snapshotDate ? ` · snapshot ${report.snapshotDate}` : ''}`
    : 'online';
  return `mcp-preflight-check ${report.version} · ${mode}`;
}

function exitReason(exit: number, failOn: FailOn): string {
  if (exit === 1) return 'exit 1: config error';
  if (exit === 2) return `exit 2: findings at/above ${failOn}`;
  return 'exit 0';
}

function summaryLine(report: Report, opts: HumanOptions): string {
  const s = report.summary;
  const configCount = report.configs.length;
  const errCount = report.errors.length;
  const parts = [`${s.checked} server${s.checked === 1 ? '' : 's'}`];
  if (configCount > 0 || s.checked === 0) {
    parts.push(`in ${configCount} config${configCount === 1 ? '' : 's'}`);
  }
  if (errCount > 0) parts.push(`(+${errCount} config error${errCount === 1 ? '' : 's'})`);
  const counts = `${s.refused} refused · ${s.warned} warned · ${s.unknown} unknown · ${s.ok} ok · ${s.skipped} skipped`;
  return `${parts.join(' ')} — ${counts}   (fail-on: ${opts.failOn} → ${exitReason(opts.exit, opts.failOn)})`;
}

export function renderHuman(report: Report, opts: HumanOptions): string {
  const lines: string[] = [header(report)];

  if (report.servers.length === 0 && report.configs.length === 0 && report.errors.length === 0) {
    lines.push('');
    lines.push('No MCP configs found.');
    if (opts.verbose && opts.searched?.length) {
      lines.push('');
      lines.push('Searched:');
      for (const p of opts.searched) lines.push(`  ${tildify(p, opts.home)}`);
    }
    return lines.join('\n') + '\n';
  }

  let lastGroup = '';
  for (const s of report.servers) {
    const group = `${s.source}|${s.scope ?? ''}`;
    if (group !== lastGroup) {
      lastGroup = group;
      const scope = s.scope ? ` · ${s.scope}` : '';
      lines.push('');
      lines.push(`${tildify(s.source, opts.home)}  [${LABELS[s.client]}${scope}]`);
    }
    const verdict = paint(s.verdict.padEnd(8), VERDICT_COLOR[s.verdict], opts.color);
    const suffix = s.disabled ? ' (disabled)' : '';
    lines.push(`  ${verdict} ${s.name.padEnd(10)} ${s.display}${suffix}`.trimEnd());
    for (const f of visibleFindings(s, opts.verbose)) {
      const sym = SYMBOL[f.severity];
      const id = f.id.padEnd(18);
      lines.push(`${FIND_INDENT}${sym} ${id} ${f.message}`.trimEnd());
      if (f.evidence) {
        lines.push(`${FIND_INDENT}  ${' '.repeat(19)}${f.evidence}`.trimEnd());
      }
    }
    if (s.env.length > 0) lines.push(`${FIND_INDENT}env: ${s.env.join(', ')}`);
  }

  if (report.servers.length === 0) {
    lines.push('');
    lines.push(`No MCP servers found in ${report.configs.length} config${report.configs.length === 1 ? '' : 's'}.`);
  }

  if (opts.verbose && opts.searched?.length) {
    lines.push('');
    lines.push('Searched:');
    for (const p of opts.searched) lines.push(`  ${tildify(p, opts.home)}`);
  }

  if (report.errors.length > 0) {
    lines.push('');
    lines.push(report.errors.length === 1 ? '1 config error:' : `${report.errors.length} config errors:`);
    for (const e of report.errors) lines.push(`  ${tildify(e.message, opts.home)}`);
  }

  lines.push('');
  lines.push(summaryLine(report, opts));
  if (report.summary.refused > 0) {
    lines.push('Refused servers: remove them or switch to the service\'s own maintained MCP server.');
  }
  return lines.join('\n') + '\n';
}

function ciFindingIds(s: ServerResult): string {
  const relevant = s.findings.filter(f => f.severity !== 'info');
  if (relevant.length > 0) return relevant.map(f => f.id).join('+');
  const first = s.findings[0];
  return first ? first.id : '';
}

export function renderCi(report: Report, opts: HumanOptions): string {
  const lines: string[] = [];
  for (const s of report.servers) {
    if (s.verdict === 'OK') continue;
    const pkg = s.package ?? s.display;
    const ids = ciFindingIds(s);
    lines.push([s.verdict, tildify(s.source, opts.home), s.name, pkg, ids].filter(Boolean).join(' '));
  }
  for (const e of report.errors) lines.push(`ERROR ${tildify(e.message, opts.home)}`);
  const s = report.summary;
  const mode = report.offline
    ? `offline${report.snapshotDate ? `, snapshot ${report.snapshotDate}` : ''}`
    : 'online';
  const result = opts.exit === 2 ? 'FAIL' : opts.exit === 1 ? 'ERROR' : 'OK';
  lines.push(
    `mcp-preflight-check: ${s.checked} servers, ${s.refused} refused, ${s.warned} warned, ` +
    `${s.unknown} unknown, ${s.ok} ok, ${s.skipped} skipped ` +
    `(${mode}, fail-on ${opts.failOn}) -> ${result}`,
  );
  return lines.join('\n') + '\n';
}
