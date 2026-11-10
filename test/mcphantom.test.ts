import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { run, type Deps, type Io } from '../src/run.js';
import { fakeFetch, type Route } from './helpers/fake-fetch.js';
import { fixturePath } from './helpers/fixtures.js';
import { makeTmpDir } from './helpers/tmp-home.js';
import type { Report } from '../src/types.js';

const NOW = new Date('2026-11-10T12:00:00.000Z');
const MCPHANTOM = fixturePath('configs', 'mcphantom.json');

const MC = [
  'server-github', 'server-postgres', 'server-slack', 'server-puppeteer',
  'server-brave-search', 'server-google-maps', 'server-gitlab', 'server-gdrive',
  'server-redis', 'server-aws-kb-retrieval', 'server-everart', 'create-server',
].map(x => `@modelcontextprotocol/${x}`);

const safeName = (name: string) => name.replace('@', '').replace('/', '__') + '.json';
const registryUrl = (name: string) => `https://registry.npmjs.org/${name.replace('/', '%2F')}`;

function harness(overrides: Partial<Deps> = {}): { io: Io; deps: Deps; out(): string; err(): string } {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { stdout: s => out.push(s), stderr: s => err.push(s), isTTY: false };
  const deps: Deps = {
    fetch: (async () => { throw new Error('offline test made a network call'); }) as unknown as typeof fetch,
    env: {},
    cwd: process.cwd(),
    home: '/home/tester',
    platform: 'linux',
    now: NOW,
    ...overrides,
  };
  return { io, deps, out: () => out.join(''), err: () => err.join('') };
}

test('offline, real bundled snapshot: all 12 MCPhantom servers REFUSE via DEPRECATED', async () => {
  const h = harness({ snapshotPath: join(process.cwd(), 'data', 'deprecated.json') });
  const code = await run(['check', MCPHANTOM, '--json'], h.io, h.deps);
  assert.equal(code, 2);
  const r = JSON.parse(h.out()) as Report;
  assert.equal(r.offline, true);
  assert.equal(r.servers.length, 12);
  assert.equal(r.summary.refused, 12);
  for (const s of r.servers) {
    assert.equal(s.verdict, 'REFUSE', `${s.name} should be refused`);
    assert.ok(s.findings.some(f => f.id === 'DEPRECATED' && f.severity === 'blocked'), `${s.name} missing DEPRECATED`);
  }
});

test('online with recorded fixtures: all 12 REFUSE, server-filesystem stays OK', async () => {
  const tmp = await makeTmpDir();
  try {
    const routes: Record<string, Route> = {};
    for (const name of MC) {
      routes[registryUrl(name)] = {
        status: 200,
        body: JSON.parse(readFileSync(fixturePath('registry', safeName(name)), 'utf8')),
      };
    }
    routes[registryUrl('@modelcontextprotocol/server-filesystem')] = {
      status: 200,
      body: JSON.parse(readFileSync(fixturePath('registry', safeName('@modelcontextprotocol/server-filesystem')), 'utf8')),
    };
    routes['https://api.github.com/repos/modelcontextprotocol/servers'] = {
      status: 200,
      body: JSON.parse(readFileSync(fixturePath('github', 'healthy.json'), 'utf8')),
    };

    const config = join(tmp.dir, 'mixed.json');
    const servers: Record<string, unknown> = {};
    for (const name of MC) servers[name.replace('@modelcontextprotocol/', '')] = { command: 'npx', args: ['-y', name] };
    servers.filesystem = { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem@2.2.0'] };
    await writeFile(config, JSON.stringify({ mcpServers: servers }));

    const calls: string[] = [];
    const h = harness({
      fetch: fakeFetch(routes, calls),
      env: { MCP_PREFLIGHT_CHECK_CACHE_DIR: join(tmp.dir, 'cache') },
    });
    const code = await run(['check', config, '--online', '--json'], h.io, h.deps);
    assert.equal(code, 2, h.err());
    const r = JSON.parse(h.out()) as Report;
    assert.equal(r.offline, false);

    const mc = r.servers.filter(s => s.name !== 'filesystem');
    assert.equal(mc.length, 12);
    assert.equal(r.summary.refused, 12);
    for (const s of mc) {
      assert.equal(s.verdict, 'REFUSE', `${s.name}: ${JSON.stringify(s.findings)}`);
      assert.ok(s.findings.some(f => f.id === 'DEPRECATED'));
    }
    const fs = r.servers.find(s => s.name === 'filesystem');
    assert.ok(fs);
    assert.equal(fs.verdict, 'OK');
    assert.ok(calls.includes('https://api.github.com/repos/modelcontextprotocol/servers'));
  } finally {
    await tmp.cleanup();
  }
});
