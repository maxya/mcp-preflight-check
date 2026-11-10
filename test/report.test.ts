import test from 'node:test';
import assert from 'node:assert/strict';
import { renderJson } from '../src/report/json.js';
import { renderCi, renderHuman } from '../src/report/human.js';
import type { Report } from '../src/types.js';

const report: Report = {
  schema: 1,
  tool: 'mcp-preflight-check',
  version: '0.1.0',
  offline: true,
  snapshotDate: '2026-11-10',
  configs: [{ path: '/home/me/.claude.json', client: 'claude-code', servers: 2 }],
  servers: [
    {
      name: 'github', client: 'claude-code', source: '/home/me/.claude.json', scope: 'user',
      disabled: false, package: '@modelcontextprotocol/server-github', target: 'npm',
      display: 'npx -y @modelcontextprotocol/server-github',
      env: ['GITHUB_PERSONAL_ACCESS_TOKEN=<set>'],
      verdict: 'REFUSE',
      findings: [
        {
          id: 'DEPRECATED', severity: 'blocked',
          message: 'npm marks @modelcontextprotocol/server-github@2025.4.8 deprecated (as of snapshot 2026-11-10)',
          evidence: 'Archived and unmaintained; no security guarantees.',
        },
        { id: 'UNPINNED', severity: 'info', message: 'no exact version pin; runs whatever is newest at launch' },
      ],
    },
    {
      name: 'fetch', client: 'claude-code', source: '/home/me/.claude.json', scope: 'user',
      disabled: true, package: null, target: 'pypi', display: 'uvx mcp-server-fetch', env: [],
      verdict: 'SKIPPED',
      findings: [{ id: 'UNSUPPORTED-SOURCE', severity: 'info', message: 'PyPI packages are not checked in v1 — no verdict' }],
    },
  ],
  errors: [],
  summary: { checked: 2, refused: 1, warned: 0, unknown: 0, ok: 0, skipped: 1 },
};

const opts = { color: false, verbose: false, home: '/home/me', failOn: 'blocked' as const, exit: 2 };

test('JSON output has every key of the report schema and parses as one document', () => {
  const text = renderJson(report);
  assert.ok(text.endsWith('\n'));
  const doc = JSON.parse(text);
  assert.equal(doc.schema, 1);
  for (const key of ['tool', 'version', 'offline', 'snapshotDate', 'configs', 'servers', 'errors', 'summary']) {
    assert.ok(key in doc, `missing ${key}`);
  }
  assert.deepEqual(Object.keys(doc.servers[0]).sort(), [
    'client', 'disabled', 'display', 'env', 'findings', 'name', 'package', 'scope', 'source', 'target', 'verdict',
  ]);
  assert.deepEqual(Object.keys(doc.summary).sort(), ['checked', 'ok', 'refused', 'skipped', 'unknown', 'warned']);
  assert.equal(doc.servers[0].findings[0].id, 'DEPRECATED');
});

test('human output shows the snapshot date, group header, findings, env and summary', () => {
  const text = renderHuman(report, opts);
  assert.match(text, /^mcp-preflight-check 0\.1\.0 · offline · snapshot 2026-11-10/);
  assert.match(text, /~\/\.claude\.json {2}\[Claude Code · user\]/);
  assert.match(text, /REFUSE\s+github\s+npx -y @modelcontextprotocol\/server-github/);
  assert.match(text, /DEPRECATED/);
  assert.match(text, /Archived and unmaintained/);
  assert.match(text, /env: GITHUB_PERSONAL_ACCESS_TOKEN=<set>/);
  assert.match(text, /2 servers in 1 config/);
  assert.match(text, /1 refused · 0 warned · 0 unknown · 0 ok · 1 skipped/);
  assert.match(text, /fail-on: blocked → exit 2: findings at\/above blocked/);
  assert.match(text, /Refused servers: remove them/);
  assert.match(text, /\(disabled\)/);
});

test('info findings are hidden unless --verbose, except UNSUPPORTED-SOURCE on a SKIPPED row', () => {
  const quiet = renderHuman(report, opts);
  assert.ok(!quiet.includes('UNPINNED'));
  assert.match(quiet, /UNSUPPORTED-SOURCE/);

  const verbose = renderHuman(report, { ...opts, verbose: true });
  assert.match(verbose, /UNPINNED/);
});

test('human output renders config errors with the file prefix and exit 1', () => {
  const withError: Report = {
    ...report,
    servers: [],
    configs: [],
    errors: [{ source: '/home/me/.cursor/mcp.json', message: '/home/me/.cursor/mcp.json:7:3: invalid JSON' }],
    summary: { checked: 0, refused: 0, warned: 0, unknown: 0, ok: 0, skipped: 0 },
  };
  const text = renderHuman(withError, { ...opts, exit: 1 });
  assert.match(text, /1 config error:/);
  assert.match(text, /~\/\.cursor\/mcp\.json:7:3: invalid JSON/);
  assert.match(text, /exit 1: config error/);
});

test('human output says "No MCP configs found." when nothing was discovered', () => {
  const empty: Report = {
    ...report, configs: [], servers: [],
    summary: { checked: 0, refused: 0, warned: 0, unknown: 0, ok: 0, skipped: 0 },
  };
  const text = renderHuman(empty, { ...opts, exit: 0 });
  assert.match(text, /No MCP configs found\./);
});

test('human output renders an explicit --package result without claiming no configs', () => {
  const explicit: Report = {
    ...report,
    configs: [],
    servers: [{
      ...report.servers[0],
      source: '--package',
      client: 'explicit',
      scope: undefined,
    }],
    summary: { checked: 1, refused: 1, warned: 0, unknown: 0, ok: 0, skipped: 0 },
  };
  const text = renderHuman(explicit, { ...opts, exit: 2 });
  assert.ok(!text.includes('No MCP configs found.'));
  assert.match(text, /--package {2}\[explicit\]/);
  assert.match(text, /REFUSE\s+github/);
  assert.match(text, /1 server — 1 refused/);
  assert.doesNotMatch(text, /in 0 configs/);
});

test('CI output is one line per non-OK server plus a summary line', () => {
  const text = renderCi(report, opts);
  const lines = text.trimEnd().split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0], 'REFUSE ~/.claude.json github @modelcontextprotocol/server-github DEPRECATED');
  assert.equal(lines[1], 'SKIPPED ~/.claude.json fetch uvx mcp-server-fetch UNSUPPORTED-SOURCE');
  assert.equal(
    lines[2],
    'mcp-preflight-check: 2 servers, 1 refused, 0 warned, 0 unknown, 0 ok, 1 skipped (offline, snapshot 2026-11-10, fail-on blocked) -> FAIL',
  );
  assert.ok(!text.includes('\u001b['));
});

test('CI output ends in OK for a clean run', () => {
  const clean: Report = {
    ...report,
    servers: [report.servers[1]],
    summary: { checked: 1, refused: 0, warned: 0, unknown: 0, ok: 0, skipped: 1 },
  };
  const text = renderCi(clean, { ...opts, exit: 0 });
  assert.match(text, /\(offline, snapshot 2026-11-10, fail-on blocked\) -> OK\n$/);
});
