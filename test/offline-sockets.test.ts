import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = process.cwd();
const CLI = join(ROOT, 'dist', 'cli.js');
const DENY = join(ROOT, 'test', 'helpers', 'deny-network.mjs');
const MCPHANTOM = join(ROOT, 'test', 'fixtures', 'configs', 'mcphantom.json');
const MARK = 'NETWORK-ATTEMPT-BLOCKED';

function runCli(extra: string[] = []) {
  return spawnSync(
    process.execPath,
    ['--import', DENY, CLI, 'check', MCPHANTOM, ...extra],
    {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, NO_COLOR: '1', MCP_PREFLIGHT_CHECK_CACHE_DIR: join(ROOT, 'build-test', '.cache-offline-test') },
    },
  );
}

test('offline run opens zero sockets (and still exits 2 on the MCPhantom config)', () => {
  const r = runCli(['--offline']);
  assert.equal(r.error, undefined);
  assert.equal(r.status, 2, `stderr: ${r.stderr}`);
  assert.ok(!r.stderr.includes(MARK), `unexpected network attempt:\n${r.stderr}`);
  assert.match(r.stdout, /REFUSE/);
});

test('positive control: --online triggers the network guard without crashing', () => {
  const r = runCli(['--online']);
  assert.equal(r.error, undefined);
  assert.ok(r.stderr.includes(MARK), 'the guard must fire in online mode');
  assert.equal(r.status, 0, `all lookups should degrade to UNKNOWN; stderr: ${r.stderr}`);
  assert.match(r.stdout, /UNKNOWN|not in|lookup failed/i);
});
