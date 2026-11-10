import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { run, type Deps, type Io } from '../src/run.js';
import { fixturePath } from './helpers/fixtures.js';

const SECRETS = ['FAKE_SECRET', 'hunter2', 'sk-FAKE', 'pw-FAKE', 'qs-FAKE', 'key-FAKE'];
const NOW = new Date('2026-11-10T12:00:00.000Z');

function harness(): { io: Io; deps: Deps; out(): string; err(): string } {
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
    snapshotPath: fixturePath('snapshot.json'),
  };
  return { io, deps, out: () => out.join(''), err: () => err.join('') };
}

test('the fixture really contains every fake secret (positive control)', () => {
  const raw = readFileSync(fixturePath('configs', 'secrets.json'), 'utf8');
  for (const secret of SECRETS) assert.ok(raw.includes(secret), `fixture is missing ${secret}`);
});

test('no fake secret appears in human, verbose, ci or json output', async () => {
  const config = fixturePath('configs', 'secrets.json');
  const modes: string[][] = [[], ['--verbose'], ['--ci'], ['--json'], ['--json', '--verbose']];
  for (const flags of modes) {
    const h = harness();
    const code = await run(['check', config, ...flags], h.io, h.deps);
    const combined = h.out() + h.err();
    for (const secret of SECRETS) {
      assert.ok(!combined.includes(secret), `${secret} leaked in mode ${flags.join(' ') || 'human'}`);
    }
    assert.ok(code === 0 || code === 2, `unexpected exit ${code}`);
  }
});

test('masked output still shows the server and the env variable names', async () => {
  const h = harness();
  await run(['check', fixturePath('configs', 'secrets.json'), '--json'], h.io, h.deps);
  const report = JSON.parse(h.out());
  const secrets = report.servers.find((s: { name: string }) => s.name === 'secrets');
  assert.ok(secrets);
  assert.equal(secrets.env.includes('GITHUB_PERSONAL_ACCESS_TOKEN=<set>'), true);
  assert.equal(secrets.env.includes('PASSWORD=<set>'), true);
  assert.match(secrets.display, /--api-key=<value>/);
  assert.match(secrets.display, /<arg>/);
  const remote = report.servers.find((s: { name: string }) => s.name === 'remote');
  assert.equal(remote.display, 'mcp.example.com');
});
