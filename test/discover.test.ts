import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { copyFile } from 'node:fs/promises';
import { discoverAll, loadExplicit } from '../src/discover/index.js';
import type { ClientId } from '../src/types.js';
import { fixturePath } from './helpers/fixtures.js';
import { makeTmpDir, put } from './helpers/tmp-home.js';

const FAKE_SECRETS = ['ghp_FAKE_SECRET_123', 'hunter2', 'sk-FAKE-TOKEN', 'pw-FAKE', 'qs-FAKE', 'key-FAKE-arg'];

test('auto-discovery finds every supported client from a temp home/cwd', async () => {
  const home = await makeTmpDir('mpc-home-');
  const cwd = await makeTmpDir('mpc-cwd-');
  try {
    await put(home.dir, '.claude.json', 'claude.json');
    await put(cwd.dir, '.mcp.json', 'mcp.json');
    await put(home.dir, '.config/Claude/claude_desktop_config.json', 'claude.json');
    await put(home.dir, '.cursor/mcp.json', 'cursor.json');
    await put(cwd.dir, '.cursor/mcp.json', 'cursor.json');
    await put(cwd.dir, '.vscode/mcp.json', 'vscode-mcp.json');
    await put(home.dir, '.config/Code/User/mcp.json', 'vscode-mcp.json');
    await put(home.dir, '.config/Code/User/settings.json', 'vscode-settings.json');
    await put(home.dir, '.copilot/mcp-config.json', 'copilot.json');
    await put(cwd.dir, '.devin/mcp_config.json', 'devin.json');
    await put(cwd.dir, '.devin/mcp_config.local.json', 'devin.json');
    await put(home.dir, '.config/devin/mcp_config.json', 'devin.json');
    await put(home.dir, '.codeium/windsurf/mcp_config.json', 'devin.json');
    await put(home.dir, '.gemini/settings.json', 'gemini.json');
    await put(cwd.dir, '.gemini/settings.json', 'gemini.json');
    await put(home.dir, '.codex/config.toml', 'codex.toml');
    await put(cwd.dir, '.codex/config.toml', 'codex.toml');
    await put(cwd.dir, 'opencode.json', 'opencode-v2.jsonc');
    await put(cwd.dir, 'opencode.jsonc', 'opencode-v1.json');
    await put(home.dir, '.config/opencode/opencode.json', 'opencode-v2.jsonc');

    const result = await discoverAll({ home: home.dir, cwd: cwd.dir, platform: 'linux', env: {} });
    assert.deepEqual(result.errors, []);

    const clients = new Set(result.entries.map(e => e.client));
    const expected: ClientId[] = [
      'claude-code', 'mcp-json', 'claude-desktop', 'cursor', 'vscode', 'copilot',
      'devin', 'windsurf', 'gemini', 'codex', 'opencode',
    ];
    for (const c of expected) assert.ok(clients.has(c), `missing client ${c}`);

    // Claude Code: user scope + one block per project
    const cc = result.entries.filter(e => e.client === 'claude-code');
    assert.deepEqual(cc.map(e => `${e.scope}:${e.name}`).sort(), [
      'local:/home/tester/work/api:pg',
      'local:/home/tester/work/web:fetch',
      'user:filesystem',
      'user:github',
    ]);

    // VS Code uses `servers`, and the legacy settings.json map is found too
    const vs = result.entries.filter(e => e.client === 'vscode');
    assert.ok(vs.some(e => e.name === 'github' && e.scope === 'project'));
    assert.ok(vs.some(e => e.name === 'everything' && e.scope === 'user'));

    // Remote URL may live in url / serverUrl / httpUrl
    const devin = result.entries.filter(e => e.client === 'devin');
    assert.ok(devin.some(e => e.name === 'remote' && e.url === 'https://mcp.example.com/mcp'));
    const gemini = result.entries.filter(e => e.client === 'gemini');
    assert.ok(gemini.some(e => e.name === 'http-remote' && e.url === 'https://mcp.example.com/mcp'));

    // OpenCode v2 command array + environment, v1 mcp.<name> with type
    const oc = result.entries.filter(e => e.client === 'opencode');
    const local = oc.find(e => e.name === 'local');
    assert.ok(local);
    assert.equal(local.command, 'npx');
    assert.deepEqual(local.args.slice(0, 2), ['-y', '@modelcontextprotocol/server-github@2025.4.8']);
    assert.deepEqual(local.envKeys.map(k => k.key), ['GITHUB_TOKEN']);
    assert.ok(oc.some(e => e.name === 'off' && e.disabled));
    assert.ok(oc.some(e => e.name === 'legacy'));
    assert.ok(oc.some(e => e.name === 'legacy-remote' && e.url === 'https://mcp.example.com/sse'));

    // Codex TOML, including env_vars and http_headers keys
    const codex = result.entries.filter(e => e.client === 'codex');
    const gh = codex.find(e => e.name === 'github' && e.scope === 'user');
    assert.ok(gh);
    assert.equal(gh.authHint, true);
    assert.deepEqual(gh.headerKeys, []);
    assert.ok(gh.envKeys.some(k => k.key === 'GITHUB_TOKEN' && k.state === 'ref'));
    assert.ok(codex.some(e => e.name === 'remote one' && e.authHint));

    // Disabled servers are still reported
    assert.ok(result.entries.some(e => e.disabled));

    // ServerEntry holds no secret values at all (env, headers, urls, args)
    const serialized = JSON.stringify(result.entries);
    for (const secret of FAKE_SECRETS) {
      assert.ok(!serialized.includes(secret), `entry serialization leaked ${secret}`);
    }
  } finally {
    await home.cleanup();
    await cwd.cleanup();
  }
});

test('a broken config becomes a ScanError and the other files are still returned', async () => {
  const home = await makeTmpDir('mpc-home-');
  const cwd = await makeTmpDir('mpc-cwd-');
  try {
    await put(home.dir, '.claude.json', 'claude.json');
    await put(home.dir, '.cursor/mcp.json', 'broken.json');
    const result = await discoverAll({ home: home.dir, cwd: cwd.dir, platform: 'linux', env: {} });
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].message, /mcp\.json:3:\d+: invalid JSON$/);
    assert.ok(!result.errors[0].message.includes('x" "y'));
    assert.ok(result.entries.some(e => e.client === 'claude-code'));
  } finally {
    await home.cleanup();
    await cwd.cleanup();
  }
});

test('missing files are skipped silently; no errors and no configs', async () => {
  const home = await makeTmpDir('mpc-home-');
  const cwd = await makeTmpDir('mpc-cwd-');
  try {
    const result = await discoverAll({ home: home.dir, cwd: cwd.dir, platform: 'linux', env: {} });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.entries, []);
    assert.deepEqual(result.configs, []);
    assert.ok(result.searched.length > 10);
  } finally {
    await home.cleanup();
    await cwd.cleanup();
  }
});

test('the same absolute path is read once even when cwd === home', async () => {
  const root = await makeTmpDir('mpc-same-');
  try {
    await put(root.dir, '.cursor/mcp.json', 'cursor.json');
    const result = await discoverAll({ home: root.dir, cwd: root.dir, platform: 'linux', env: {} });
    assert.equal(result.errors.length, 0);
    const cursor = result.entries.filter(e => e.client === 'cursor');
    assert.equal(cursor.length, 3, 'user and project rows for the same path must not duplicate');
    assert.equal(result.configs.filter(c => c.path.endsWith('mcp.json')).length, 1);
  } finally {
    await root.cleanup();
  }
});

test('loadExplicit loads each fixture with the expected server count', async () => {
  const cwd = process.cwd();
  const cases: [string, number][] = [
    ['claude.json', 2],           // without the .claude.json name only the top-level map applies
    ['mcp.json', 2],
    ['cursor.json', 3],
    ['vscode-mcp.json', 2],
    ['vscode-settings.json', 1],
    ['copilot.json', 1],
    ['devin.json', 2],
    ['gemini.json', 3],
    ['codex.toml', 3],
    ['opencode-v2.jsonc', 3],
    ['opencode-v1.json', 2],
    ['no-servers.json', 0],
  ];
  for (const [file, count] of cases) {
    const r = await loadExplicit([fixturePath('configs', file)], cwd);
    assert.deepEqual(r.errors, [], `${file} should not error`);
    assert.equal(r.entries.length, count, `${file} server count`);
    assert.ok(r.entries.every(e => e.client === 'explicit'));
  }
});

test('a file named .claude.json also yields projects.*.mcpServers blocks', async () => {
  const tmp = await makeTmpDir('mpc-explicit-');
  try {
    const dest = join(tmp.dir, '.claude.json');
    await copyFile(fixturePath('configs', 'claude.json'), dest);
    const r = await loadExplicit([dest], process.cwd());
    assert.deepEqual(r.errors, []);
    assert.equal(r.entries.length, 4);
    assert.deepEqual(r.entries.map(e => e.scope).sort(), [
      'local:/home/tester/work/api', 'local:/home/tester/work/web', 'user', 'user',
    ]);
  } finally {
    await tmp.cleanup();
  }
});

test('explicit paths: duplicate input deduped, missing file and bad files are ScanErrors', async () => {
  const cwd = process.cwd();
  const dup = await loadExplicit(
    [fixturePath('configs', 'mcp.json'), fixturePath('configs', 'mcp.json')],
    cwd,
  );
  assert.equal(dup.entries.length, 2);

  const missing = await loadExplicit([join(cwd, 'does-not-exist.json')], cwd);
  assert.equal(missing.errors.length, 1);
  assert.equal(missing.errors[0].message, 'ENOENT');

  const badJson = await loadExplicit([fixturePath('configs', 'broken.json')], cwd);
  assert.match(badJson.errors[0].message, /broken\.json:3:\d+: invalid JSON$/);

  const badToml = await loadExplicit([fixturePath('configs', 'broken.toml')], cwd);
  assert.match(badToml.errors[0].message, /broken\.toml:2:15: unexpected text after value$/);
});
