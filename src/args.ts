import { parseArgs } from 'node:util';
import type { FailOn } from './grade.js';

export interface CliArgs {
  command: 'check' | 'help' | 'version';
  paths: string[];
  packages: string[];
  online: boolean;
  json: boolean;
  ci: boolean;
  verbose: boolean;
  noColor: boolean;
  failOn: FailOn;
}

export type ParsedArgs = { ok: true; args: CliArgs } | { ok: false; message: string };

export const USAGE = `mcp-preflight-check — check MCP servers before you trust them.

Usage:
  mcp-preflight-check [check] [paths…]
  mcp-preflight-check check --package <spec>

Options:
  --package <spec>      check one npm package spec (repeatable), e.g. @scope/pkg@1.2.3
  --config <file>       check one config file (repeatable); same as a positional path
  --online              live npm registry + GitHub lookups (default: offline snapshot)
  --offline             explicit default; error when combined with --online
  --json                JSON report (schema 1) on stdout; nothing else on stdout
  --fail-on <level>     blocked | warn | any   (default: blocked)
  --ci                  plain output, one line per non-OK server + summary line
  --verbose             per-check evidence, cache hits, searched config paths
  --no-color            disable colour (also honoured: NO_COLOR, non-TTY stdout)
  -h, --help            show this help
  -v, --version         print the version

Exit codes: 0 clean · 1 usage error or scan error · 2 findings at/above --fail-on
`;

const FAIL_ON = new Set(['blocked', 'warn', 'any']);

export function parseCliArgs(argv: string[]): ParsedArgs {
  let values: {
    package?: string[];
    config?: string[];
    online?: boolean;
    offline?: boolean;
    json?: boolean;
    'fail-on'?: string;
    ci?: boolean;
    verbose?: boolean;
    'no-color'?: boolean;
    help?: boolean;
    version?: boolean;
  };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: true,
      options: {
        package: { type: 'string', multiple: true },
        config: { type: 'string', multiple: true },
        online: { type: 'boolean' },
        offline: { type: 'boolean' },
        json: { type: 'boolean' },
        'fail-on': { type: 'string' },
        ci: { type: 'boolean' },
        verbose: { type: 'boolean' },
        'no-color': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }

  if (values.help) return { ok: true, args: { command: 'help', paths: [], packages: [], online: false, json: false, ci: false, verbose: false, noColor: false, failOn: 'blocked' } };
  if (values.version) return { ok: true, args: { command: 'version', paths: [], packages: [], online: false, json: false, ci: false, verbose: false, noColor: false, failOn: 'blocked' } };

  if (values.online && values.offline) return { ok: false, message: '--online and --offline cannot be combined' };

  const failOnRaw = values['fail-on'];
  if (failOnRaw !== undefined && !FAIL_ON.has(failOnRaw)) {
    return { ok: false, message: `invalid --fail-on value "${failOnRaw}" (expected blocked | warn | any)` };
  }
  const failOn = (failOnRaw as FailOn | undefined) ?? 'blocked';

  const pos = [...positionals];
  if (pos[0] === 'check') pos.shift();
  const paths = [...pos, ...(values.config ?? [])];
  const packages = values.package ?? [];

  return {
    ok: true,
    args: {
      command: 'check',
      paths,
      packages,
      online: !!values.online,
      json: !!values.json,
      ci: !!values.ci,
      verbose: !!values.verbose,
      noColor: !!values['no-color'],
      failOn,
    },
  };
}
