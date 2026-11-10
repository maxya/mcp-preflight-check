import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { run, type Deps, type Io } from '../src/run.js';
import { fixturePath } from './helpers/fixtures.js';
import { makeTmpDir, put } from './helpers/tmp-home.js';
import type { Report } from '../src/types.js';

const NOW = new Date('2026-11-10T12:00:00.000Z');
const SNAPSHOT = fixturePath('snapshot.json');

interface Harness {
  io: Io;
  deps: Deps;
  out(): string;
  err(): string;
}

function harness(overrides: Partial<Deps> = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { stdout: s => out.push(s), stderr: s => err.push(s), isTTY: false };
  const deps: Deps = {
    fetch: (async () => { throw new Error('network call in offline mode'); }) as unknown as typeof fetch,
    env: {},
    cwd: process.cwd(),
    home: '/home/tester',
    platform: 'linux',
    now: NOW,
    snapshotPath: SNAPSHOT,
    ...overrides,
  };
  return { io, deps, out: () => out.join(''), err: () => err.join('') };
}

test('clean run exits 0 and prints OK', async () => {
  const tmp = await makeTmpDir();
  try {
    const cfg = join(tmp.dir, 'clean.json');
    await writeFile(cfg, JSON.stringify({
      mcpServers: { fs: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem@2.2.0'] } },
    }));
    const h = harness();
    const code = await run(['check', cfg], h.io, h.deps);
    assert.equal(code, 0);
    assert.match(h.out(), /OK\s+fs/);
  } finally {
    await tmp.cleanup();
  }
});

test('a deprecated server exits 2 in human, ci and json modes', async () => {
  const cfg = fixturePath('configs', 'claude.json');
  for (const flags of [[], ['--ci'], ['--json']]) {
    const h = harness();
    const code = await run(['check', cfg, ...flags], h.io, h.deps);
    assert.equal(code, 2, `mode ${flags.join(' ')}`);
    if (flags.includes('--json')) {
      const r = JSON.parse(h.out()) as Report;
      assert.equal(r.servers.some(s => s.verdict === 'REFUSE'), true);
      assert.equal(h.err(), '');
    } else if (flags.includes('--ci')) {
      assert.match(h.out(), /^REFUSE /);
      assert.match(h.out(), /mcp-preflight-check: \d+ servers, \d+ refused/);
    } else {
      assert.match(h.out(), /REFUSE\s+github/);
      assert.match(h.out(), /DEPRECATED/);
    }
  }
});

test('a broken config exits 1 and reports file:line:col without file text', async () => {
  const h = harness();
  const code = await run(['check', fixturePath('configs', 'broken.json')], h.io, h.deps);
  assert.equal(code, 1);
  assert.match(h.out(), /broken\.json:3:\d+: invalid JSON/);
  assert.ok(!h.out().includes('x" "y'));
});

test('usage errors exit 1: unknown flag, --online --offline, bad --fail-on', async () => {
  const cases: string[][] = [
    ['check', '--nope'],
    ['check', '--online', '--offline'],
    ['check', '--fail-on', 'sometimes'],
  ];
  for (const argv of cases) {
    const h = harness();
    const code = await run(argv, h.io, h.deps);
    assert.equal(code, 1, argv.join(' '));
    assert.ok(h.err().length > 0);
    assert.match(h.err(), /Usage:/);
    assert.equal(h.out(), '');
  }
});

test('--help and --version exit 0', async () => {
  const help = harness();
  assert.equal(await run(['--help'], help.io, help.deps), 0);
  assert.match(help.out(), /Usage:/);
  assert.match(help.out(), /--fail-on/);

  const version = harness();
  assert.equal(await run(['--version'], version.io, version.deps), 0);
  assert.equal(version.out(), '0.1.0\n');
});

test('--package works offline and reports the raw spec', async () => {
  const h = harness();
  const code = await run(['check', '--package', '@modelcontextprotocol/server-github', '--json'], h.io, h.deps);
  assert.equal(code, 2);
  const r = JSON.parse(h.out()) as Report;
  assert.equal(r.servers.length, 1);
  assert.equal(r.servers[0].package, '@modelcontextprotocol/server-github');
  assert.equal(r.servers[0].verdict, 'REFUSE');
  assert.equal(r.offline, true);
});

test('--package without --json prints the REFUSE row, not "No MCP configs found."', async () => {
  const h = harness();
  const code = await run(['check', '--package', '@modelcontextprotocol/server-github'], h.io, h.deps);
  assert.equal(code, 2);
  assert.doesNotMatch(h.out(), /No MCP configs found\./);
  assert.match(h.out(), /REFUSE/);
  assert.match(h.out(), /DEPRECATED/);
});

test('a missing explicit config is a scan error (exit 1)', async () => {
  const h = harness();
  const code = await run(['check', '/definitely/not/here.json'], h.io, h.deps);
  assert.equal(code, 1);
  assert.match(h.out(), /1 config error/);
  assert.match(h.out(), /ENOENT/);
});

test('auto-discovery from a temp home works and finds the config', async () => {
  const home = await makeTmpDir('mpc-home-');
  const cwd = await makeTmpDir('mpc-cwd-');
  try {
    await put(home.dir, '.claude.json', 'claude.json');
    const h = harness({ home: home.dir, cwd: cwd.dir });
    const code = await run(['check'], h.io, h.deps);
    assert.equal(code, 2);
    assert.match(h.out(), /Claude Code · user/);
  } finally {
    await home.cleanup();
    await cwd.cleanup();
  }
});

test('no configs found exits 0; --verbose lists the searched paths', async () => {
  const home = await makeTmpDir('mpc-home-');
  const cwd = await makeTmpDir('mpc-cwd-');
  try {
    const plain = harness({ home: home.dir, cwd: cwd.dir });
    assert.equal(await run(['check'], plain.io, plain.deps), 0);
    assert.match(plain.out(), /No MCP configs found\./);

    const verbose = harness({ home: home.dir, cwd: cwd.dir });
    assert.equal(await run(['check', '--verbose'], verbose.io, verbose.deps), 0);
    assert.match(verbose.out(), /Searched:/);
    assert.match(verbose.out(), /\.claude\.json/);
  } finally {
    await home.cleanup();
    await cwd.cleanup();
  }
});

test('--verbose shows info findings; default hides them', async () => {
  const cfg = fixturePath('configs', 'claude.json');
  const plain = harness();
  await run(['check', cfg], plain.io, plain.deps);
  assert.ok(!plain.out().includes('NO-REPO'));

  const verbose = harness();
  await run(['check', cfg, '--verbose'], verbose.io, verbose.deps);
  assert.match(verbose.out(), /NO-REPO/);
});

test('colour is used only on a TTY and can be disabled', async () => {
  const cfg = fixturePath('configs', 'claude.json');
  const tty = harness();
  tty.io.isTTY = true;
  await run(['check', cfg], tty.io, tty.deps);
  assert.ok(tty.out().includes('\u001b['));

  const noColor = harness();
  noColor.io.isTTY = true;
  await run(['check', cfg, '--no-color'], noColor.io, noColor.deps);
  assert.ok(!noColor.out().includes('\u001b['));

  const envNoColor = harness({ env: { NO_COLOR: '1' } });
  envNoColor.io.isTTY = true;
  await run(['check', cfg], envNoColor.io, envNoColor.deps);
  assert.ok(!envNoColor.out().includes('\u001b['));
});
