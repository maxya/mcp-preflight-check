import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ConfigParseError } from '../src/discover/jsonc.js';
import { parseTomlSubset } from '../src/discover/toml.js';
import { fixturePath } from './helpers/fixtures.js';

const fixture = readFileSync(fixturePath('configs', 'codex.toml'), 'utf8');

test('parses the Codex fixture: tables, inline env, quoted ids, sub-tables', () => {
  const doc = parseTomlSubset(fixture, 'codex.toml') as {
    mcp_servers: Record<string, Record<string, unknown>>;
    profiles?: unknown;
  };
  const servers = doc.mcp_servers;
  assert.deepEqual(Object.keys(servers).sort(), ['fetch', 'github', 'remote one']);
  assert.equal(servers.github.command, 'npx');
  assert.deepEqual(servers.github.args, ['-y', '@modelcontextprotocol/server-github']);
  assert.deepEqual(servers.github.env, { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_FAKE_SECRET_123' });
  assert.deepEqual(servers.github.env_vars, ['GITHUB_TOKEN']);
  assert.equal(servers.github.enabled, true);
  // `[mcp_servers.github.tools.dummy]` sub-table is kept as a nested table
  assert.deepEqual(servers.github.tools, { dummy: { setting: 'ignored' } });
  assert.equal(servers['remote one'].url, 'https://mcp.example.com/mcp');
  assert.equal(servers['remote one'].bearer_token_env_var, 'MCP_TOKEN');
  assert.deepEqual(servers['remote one'].http_headers, { 'X-Api-Key': 'key-FAKE-arg' });
  // [[profiles]] is parsed as an array table header and its body ignored
  assert.equal(doc.profiles, undefined);
});

test('a fake [mcp_servers.fake] line inside a triple-quoted string is not a table', () => {
  const src = `[mcp_servers.real]
command = "npx"
args = [
  "-y",
  "pkg",
]
notes = """
[mcp_servers.fake]
command = "evil"
"""
`;
  const doc = parseTomlSubset(src, 't.toml') as { mcp_servers: Record<string, Record<string, unknown>> };
  assert.deepEqual(Object.keys(doc.mcp_servers), ['real']);
  assert.deepEqual(doc.mcp_servers.real.args, ['-y', 'pkg']);
  assert.equal(doc.mcp_servers.real.notes, '[mcp_servers.fake]\ncommand = "evil"\n');
});

test('multi-line arrays with comments and trailing commas', () => {
  const src = `args = [
  "a", # one
  "b",
  "c",
]
flag = true
`;
  const doc = parseTomlSubset(src, 't.toml') as Record<string, unknown>;
  assert.deepEqual(doc.args, ['a', 'b', 'c']);
  assert.equal(doc.flag, true);
});

test('a sub-table defined before its parent is merged into the same table', () => {
  const src = `[mcp_servers.x.tools.y]
enabled = true

[mcp_servers.x]
command = "npx"
`;
  const doc = parseTomlSubset(src, 't.toml') as { mcp_servers: Record<string, Record<string, unknown>> };
  assert.equal(doc.mcp_servers.x.command, 'npx');
  assert.deepEqual(doc.mcp_servers.x.tools, { y: { enabled: true } });
});

test('dotted keys and inline tables', () => {
  const src = `mcp_servers.x.command = "npx"
mcp_servers.x.env = { TOKEN = "x", OTHER = "y" }
`;
  const doc = parseTomlSubset(src, 't.toml') as { mcp_servers: Record<string, Record<string, unknown>> };
  assert.equal(doc.mcp_servers.x.command, 'npx');
  assert.deepEqual(doc.mcp_servers.x.env, { TOKEN: 'x', OTHER: 'y' });
});

test('literal strings and escapes', () => {
  const src = `a = 'C:\\raw'
b = "line\\nnext"
c = 42
d = 2026-11-10T12:00:00Z
e = false
`;
  const doc = parseTomlSubset(src, 't.toml') as Record<string, unknown>;
  assert.equal(doc.a, 'C:\\raw');
  assert.equal(doc.b, 'line\nnext');
  assert.equal(doc.c, '42');
  assert.equal(doc.d, '2026-11-10T12:00:00Z');
  assert.equal(doc.e, false);
});

test('unexpected text after a bare value reports line:col', () => {
  assert.throws(() => parseTomlSubset('[x]\ncommand = npx -y\n', 'bad.toml'), (e: unknown) => {
    assert.ok(e instanceof ConfigParseError);
    assert.equal(e.line, 2);
    assert.equal(e.column, 15);
    assert.match(e.message, /^bad\.toml:2:15: unexpected text after value$/);
    return true;
  });
});

test('a missing comma in an array reports line:col', () => {
  assert.throws(() => parseTomlSubset('[x]\nargs = ["x" "y"]\n', 'bad.toml'), (e: unknown) => {
    assert.ok(e instanceof ConfigParseError);
    assert.equal(e.line, 2);
    assert.equal(e.column, 13);
    assert.match(e.message, /^bad\.toml:2:13: expected , or \] in array$/);
    return true;
  });
});

test('error messages never include file text', () => {
  assert.throws(() => parseTomlSubset('[x]\nkey = "SECRET" junk\n', 'bad.toml'), (e: unknown) => {
    assert.ok(e instanceof ConfigParseError);
    assert.ok(!e.message.includes('SECRET'));
    return true;
  });
});
