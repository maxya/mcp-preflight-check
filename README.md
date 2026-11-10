# mcp-preflight-check

**Check an MCP server before you trust it.**

A local-first CLI that reads your coding agents' MCP configs, resolves every server to the npm
package it launches, and refuses the dead ones: packages npm has deprecated, packages whose GitHub
repo is archived, and packages that vanished from the registry. It also warns about servers nobody
has published in over a year, and flags unpinned launches, remote servers with no auth in config,
and local server paths that no longer exist.

It runs entirely on your machine, never starts a server, never edits a config, and never prints a
secret. Offline by default from a bundled snapshot; `--online` opts in to live lookups against
exactly two hosts.

## Quick start

```bash
npx mcp-preflight-check check                 # scan every MCP config it can find (offline)
npx mcp-preflight-check check --online        # live npm registry + GitHub lookups
npx mcp-preflight-check check --json          # machine-readable report (schema 1)
```

CI fails on dead servers:

```bash
npx mcp-preflight-check@0.1.0 check .mcp.json --ci
```

## What it checks

| ID | Severity | Rule |
|---|---|---|
| `DEPRECATED` | blocked | npm marks the resolved version deprecated (`versions[v].deprecated`) |
| `ARCHIVED` | blocked | the package's GitHub repository is archived |
| `VANISHED` | blocked | the package (or the pinned version) is not in the registry |
| `STALE` | warn | the newest publish across all versions is older than 365 days |
| `UNPINNED` | info | config entry launched with `npx`/`bunx` without an exact version (not emitted for explicit `--package` checks) |
| `REMOTE-NO-AUTH` | info | remote URL server with no auth header or token variable in config |
| `BROKEN-PATH` | warn | local script server (`node`, `python`, `deno`, `bun`, `tsx`, `ts-node`, or a path command) whose file does not exist |
| `UNSUPPORTED-SOURCE` | info | PyPI, container image, unrecognised launcher, non-registry npm spec, or a path containing variables — no verdict |
| `NO-REPO` | info | package metadata has no GitHub repository; archive status not checkable |
| `REPO-NOT-FOUND` | info | the repository named in package metadata does not exist on GitHub |
| `RANGE-NOT-RESOLVED` | info | a semver range was checked against `latest` (no resolver in v1) |
| `NOT-IN-SNAPSHOT` | unknown | offline and the package is not in the bundled snapshot |
| `LOOKUP-FAILED` | unknown | an online registry lookup could not complete |

Per-server verdict: **REFUSE** (any blocked finding) → **WARN** (any warn finding) → **UNKNOWN**
(a core check could not run) → **OK**. Non-npm servers are **SKIPPED** unless they carry a
warn/blocked finding of their own. Information findings never change the verdict.

An honest verdict matters more than a green one: a failed core lookup (registry unreachable, package
absent from the offline snapshot, GitHub rate-limited) is `UNKNOWN`, never `OK` and never `REFUSE`.
Findings that are merely not applicable — such as `NO-REPO` — stay informational.

## Verdicts and exit codes

| Verdict | Meaning |
|---|---|
| `REFUSE` | at least one blocked finding — remove the server or switch to a maintained one |
| `WARN` | something needs attention (stale, broken path) |
| `UNKNOWN` | a check could not run; this never fails a run |
| `OK` | every applicable check passed |
| `SKIPPED` | not an npm package; only transport-level checks applied |

| Exit code | Meaning |
|---|---|
| `0` | no findings at or above `--fail-on` (`UNKNOWN` findings do not fail) |
| `1` | usage error or scan error (unreadable/unparseable config); this wins over `2` |
| `2` | findings at or above `--fail-on` (default: `blocked`) |

## Supported clients

Discovery looks for these files. Missing files are skipped silently; a file that exists but cannot
be parsed is a scan error (exit 1), and the other configs are still scanned.

| Client | Files | Server map |
|---|---|---|
| Claude Code | `~/.claude.json` (user scope **and** `projects["<abs path>"].mcpServers` local scopes) | `mcpServers` |
| Shared project file | `<cwd>/.mcp.json` | `mcpServers` |
| Claude Desktop | macOS `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows `%APPDATA%\Claude\…`, Linux `~/.config/Claude/…` (best effort) | `mcpServers` |
| Cursor | `~/.cursor/mcp.json`, `<cwd>/.cursor/mcp.json` | `mcpServers` |
| VS Code | `<cwd>/.vscode/mcp.json`, user-profile `mcp.json` (Code and Code - Insiders) | **`servers`** |
| VS Code (legacy) | user-profile `settings.json` | `mcp.servers` |
| GitHub Copilot | `$COPILOT_HOME/mcp-config.json` (default `~/.copilot/…`) | `mcpServers` |
| Devin Local | `<cwd>/.devin/mcp_config.json`, `<cwd>/.devin/mcp_config.local.json`, `~/.config/devin/mcp_config.json` | `mcpServers` |
| Windsurf (legacy) | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` |
| Gemini CLI | `~/.gemini/settings.json`, `<cwd>/.gemini/settings.json` | `mcpServers` |
| Codex | `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`), `<cwd>/.codex/config.toml` | `[mcp_servers.<id>]` |
| OpenCode | `<cwd>/opencode.json[c]`, `~/.config/opencode/opencode.json[c]` | v2 `mcp.servers`, legacy v1 `mcp.<name>` |

Project files are looked up in the current directory only; v1 does not walk up to a git root.
JSON configs may contain comments and trailing commas (JSONC).

You can also point at specific files (`check <path…>` or `--config <file>`) and check a package by
name with `--package <spec>`.

## Offline vs online

**Offline (default).** The scan uses only your config files plus the bundled snapshot
`data/deprecated.json`. It makes **zero network connections**. The report header names the snapshot
date. A package that is not in the snapshot is `UNKNOWN` and says so.

**Online (`--online`).** Live lookups against exactly two hosts:

- `registry.npmjs.org` — full packument per package (needed for per-version `deprecated` and
  per-version publish times).
- `api.github.com` — repository `archived` flag and `pushed_at`.

`--offline` is accepted as an explicit spelling of the default; combining it with `--online` is a
usage error.

**GitHub rate limits.** Unauthenticated GitHub allows 60 requests/hour. Set `GITHUB_TOKEN` to raise
it; the token is sent only in online mode, is never printed, and is never written to cache. When the
limit is hit, archive status becomes `UNKNOWN` for the rest of the run (the process does not fail).
The dataset builder also reads `GITHUB_TOKEN`; without it, snapshot archive coverage is limited (see
Known limits).

**Cache.** GitHub results are cached for 7 days in one JSON file. Nothing else is cached, and
offline mode neither reads nor writes the cache. Set `MCP_PREFLIGHT_CHECK_CACHE_DIR` to override the
cache directory (the test suite uses this).

| Platform | Cache location |
|---|---|
| Linux | `$XDG_CACHE_HOME/mcp-preflight-check/github.json` (default `~/.cache/…`) |
| macOS | `~/Library/Caches/mcp-preflight-check/github.json` |
| Windows | `%LOCALAPPDATA%\mcp-preflight-check\Cache\github.json` |

## Options

```
mcp-preflight-check [check] [paths…]
mcp-preflight-check check --package <spec>

  --package <spec>      check one npm package spec (repeatable), e.g. @scope/pkg@1.2.3
  --config <file>       check one config file (repeatable); same as a positional path
  --online              live npm registry + GitHub lookups (default: offline snapshot)
  --offline             explicit default; error when combined with --online
  --json                JSON report (schema 1) on stdout; nothing else on stdout
  --fail-on <level>     blocked | warn | any   (default: blocked)
  --ci                  plain output, one line per non-OK server + summary line
  --verbose             per-check evidence, cache hits, searched config paths
  --no-color            disable colour (also honoured: NO_COLOR, non-TTY stdout)
  -h, --help            show help
  -v, --version         print the version
```

Examples:

```bash
npx mcp-preflight-check check                      # auto-discover
npx mcp-preflight-check check .mcp.json .cursor/mcp.json
npx mcp-preflight-check check --config ~/.codex/config.toml --verbose
npx mcp-preflight-check check --package @modelcontextprotocol/server-github
npx mcp-preflight-check check .mcp.json --fail-on warn
```

## CI example

```yaml
name: mcp-preflight
on: [push, pull_request]
jobs:
  preflight:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 26
          check-latest: true
      - run: npx --yes mcp-preflight-check@0.1.0 check .mcp.json --ci
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}   # optional; raises GitHub's rate limit
```

The step fails on a blocked finding (exit 2). Use `--fail-on warn` if you also want stale packages
to fail the build. `UNKNOWN` never fails a run.

## Privacy and guarantees

- **No secrets in output.** Environment values print as `<set>`, `<ref>` or `<empty>`; header
  values are never printed; server arguments are masked (flags keep their names, values become
  `<arg>`/`<value>`); remote URLs print as host only; parse errors print `file:line:col`, never the
  offending line.
- **Read-only.** It never writes, edits or creates a config, and never installs, starts or removes a
  server. The only file it writes is its own GitHub lookup cache, in online mode only.
- **No telemetry, update check, account or model calls.** No install scripts.
- **Two hosts only.** All HTTP goes through one allow-listed client. Tests fail if `fetch(` appears
  anywhere else in `src/`, and a zero-socket test proves the offline path opens no connections.

## Known limits (v1)

- **npm only.** PyPI packages, container images and unrecognised launchers get transport findings
  and `SKIPPED`, never a deprecation/archive verdict.
- **Semver ranges are not resolved.** `pkg@^1.2.0` checks `latest` and emits `RANGE-NOT-RESOLVED`
  (info).
- **Monorepo packages** only see the repository-level archived flag; a package inside an active
  monorepo can still be abandoned.
- **TOML support is a subset** — enough for Codex `config.toml`: tables, dotted keys, quoted keys,
  basic/literal strings (including triple-quoted), arrays, inline tables and booleans. Numbers and
  dates are kept as raw strings; duplicate keys are not rejected.
- **Offline freshness** is the snapshot's `generatedAt`. Rebuild it with `npm run dataset` on every
  release; a package absent from the snapshot is `UNKNOWN`, not `OK`.
- **`time.modified` is ignored** when computing "last published": deprecating a package bumps it.
  The newest real publish is `max(time[version])` over versions that still exist.
- **No user-level `.mcp.json`.** Claude Code has no such file; only the project one is read.
- **Offline archive status is only as good as the snapshot.** A package whose repository status was
  not recorded when the snapshot was built reports `ARCHIVED` as `UNKNOWN`, not `OK`. Rebuild with
  `GITHUB_TOKEN=… npm run dataset` to populate archive data.
- **Archive lookups are skipped for servers already refused** by `DEPRECATED` or `VANISHED`; the
  refusal is final and this preserves GitHub's rate limit. `--verbose` says so explicitly.
- **Project configs are not searched upward** from nested directories.
- **`settings.json` contents are never printed.** Only the `mcp.servers` map is read.

## Why this exists

On 2026-11-02, Glow Labs published **MCPhantom**, a report about coding agents installing
deprecated and archived MCP servers from training-data memory. Their figures: 17,352,267 npm
downloads since 2025-07-10 across 12 `@modelcontextprotocol/*` packages (11 servers plus the
`create-server` scaffolder); four high-severity flaws in those servers, including an unpatched
Puppeteer RCE via prompt injection. The reference servers were archived in May 2025 and no patch is
coming.

Caveats, stated plainly: this is a single-vendor report with undisclosed methodology; its "98%"
figure is scoped to sessions in which a deprecated server was actually installed, not all sessions;
no CVEs were published and no exploitation is known. Not all 12 packages have a known flaw.

The point stands regardless: a package can be deprecated or archived and still be one `npx` away.
Rival scanners focus on secrets, prompt injection and CVEs. This one refuses dead packages, works
offline, and never runs the server it is judging.

## Development

```bash
npm install
npm run build        # tsc → dist/
npm test             # build + compile tests + node --test (hermetic, no network)
npm run typecheck
npm run dataset      # maintainer-only: regenerate data/deprecated.json (network)
npm run fixtures -- @scope/pkg   # maintainer-only: re-record registry fixtures (network)
```

Zero runtime dependencies. Requires Node `>= 22`. Development is pinned to Node 26 via
`.node-version`; CI tests Node 22, 24 and 26. Use `GITHUB_TOKEN=… npm run dataset` to populate
archive status in the snapshot.

## License

MIT © 2026 Maxim
