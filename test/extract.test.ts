import test from 'node:test';
import assert from 'node:assert/strict';
import { extractTarget, isExactVersion, maskArgs, parsePackageSpec, safeHost } from '../src/extract/index.js';

test('npx -y @scope/pkg → npm, unpinned', () => {
  const t = extractTarget('npx', ['-y', '@modelcontextprotocol/server-github']);
  assert.equal(t.kind, 'npm');
  if (t.kind !== 'npm') return;
  assert.deepEqual(t.spec, { name: '@modelcontextprotocol/server-github', version: undefined, raw: '@modelcontextprotocol/server-github' });
  assert.equal(t.pinned, false);
  assert.equal(t.display, 'npx -y @modelcontextprotocol/server-github');
});

test('positional args are masked, including a postgres URL with a password', () => {
  const t = extractTarget('npx', ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://admin:hunter2@db/prod']);
  assert.equal(t.display, 'npx -y @modelcontextprotocol/server-postgres <arg>');
});

test('npx --package with an exact pin, values and flags masked', () => {
  const t = extractTarget('npx', ['--yes', '--package=@acme/mcp@1.2.3', 'acme-mcp', '--token', 'SECRET']);
  assert.equal(t.kind, 'npm');
  if (t.kind !== 'npm') return;
  assert.equal(t.spec.name, '@acme/mcp');
  assert.equal(t.spec.version, '1.2.3');
  assert.equal(t.pinned, true);
  assert.equal(t.display, 'npx --yes --package=@acme/mcp@1.2.3 <arg> --token <arg>');
});

test('a Windows npx.cmd path is normalized, @latest is a tag and not pinned', () => {
  const t = extractTarget('C:\\Program Files\\nodejs\\npx.cmd', ['-y', 'server@latest', '--api-key=SECRET']);
  assert.equal(t.kind, 'npm');
  if (t.kind !== 'npm') return;
  assert.equal(t.spec.name, 'server');
  assert.equal(t.spec.version, 'latest');
  assert.equal(t.pinned, false);
  assert.equal(t.display, 'npx -y server@latest --api-key=<value>');
});

test('cmd /c npx is unwrapped', () => {
  const t = extractTarget('cmd', ['/c', 'npx', '-y', '@scope/pkg@2.0.0']);
  assert.equal(t.kind, 'npm');
  if (t.kind !== 'npm') return;
  assert.equal(t.pinned, true);
});

test('pnpm dlx resolves an npm package', () => {
  const t = extractTarget('pnpm', ['dlx', 'some-mcp']);
  assert.equal(t.kind, 'npm');
  if (t.kind !== 'npm') return;
  assert.equal(t.spec.name, 'some-mcp');
  assert.equal(t.display, 'pnpm dlx some-mcp');
});

test('uvx → pypi', () => {
  const t = extractTarget('uvx', ['--from', 'mcp-server-git', 'mcp-server-git', '--repository', '/x']);
  assert.equal(t.kind, 'pypi');
  if (t.kind !== 'pypi') return;
  assert.equal(t.name, 'mcp-server-git');
});

test('docker run → docker image', () => {
  const t = extractTarget('docker', ['run', '-i', '--rm', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'ghcr.io/github/github-mcp-server']);
  assert.equal(t.kind, 'docker');
  if (t.kind !== 'docker') return;
  assert.equal(t.image, 'ghcr.io/github/github-mcp-server');
});

test('node <path> → local', () => {
  const t = extractTarget('node', ['/home/u/srv/index.js']);
  assert.equal(t.kind, 'local');
  if (t.kind !== 'local') return;
  assert.equal(t.path, '/home/u/srv/index.js');
});

test('a git spec is unsupported and carries a reason', () => {
  const t = extractTarget('npx', ['-y', 'github:user/repo']);
  assert.equal(t.kind, 'unsupported');
  if (t.kind !== 'unsupported') return;
  assert.match(t.reason, /not an npm registry package/);
});

test('remote url display is host only and never leaks userinfo, path, query or fragment', () => {
  const t = extractTarget(undefined, [], 'https://u:pw-FAKE@mcp.example.com/mcp?token=qs-FAKE#x');
  assert.equal(t.kind, 'remote');
  if (t.kind !== 'remote') return;
  assert.equal(t.display, 'mcp.example.com');
  assert.ok(!t.display.includes('pw-FAKE'));
  assert.ok(!t.display.includes('qs-FAKE'));
  assert.ok(!t.display.includes('/mcp'));
});

test('an unparseable remote url degrades to a placeholder, not the raw string', () => {
  assert.equal(safeHost('not a url ?token=qs-FAKE'), '<unparsed url>');
});

test('maskArgs keeps flag names and masks values', () => {
  assert.deepEqual(maskArgs(['--token', 'x', '--api-key=y', 'positional', '-y']), ['--token', '<arg>', '--api-key=<value>', '<arg>', '-y']);
});

test('parsePackageSpec handles scopes, versions and npm: prefixes', () => {
  assert.deepEqual(parsePackageSpec('@a/b@1.0.0'), { name: '@a/b', version: '1.0.0', raw: '@a/b@1.0.0' });
  assert.deepEqual(parsePackageSpec('npm:pkg'), { name: 'pkg', version: undefined, raw: 'pkg' });
  assert.equal(parsePackageSpec('git+https://github.com/o/r.git'), null);
  assert.equal(parsePackageSpec('./local/path'), null);
});

test('isExactVersion only accepts exact semver', () => {
  assert.equal(isExactVersion('1.2.3'), true);
  assert.equal(isExactVersion('v1.2.3'), true);
  assert.equal(isExactVersion('1.2'), false);
  assert.equal(isExactVersion('^1.2.3'), false);
  assert.equal(isExactVersion('latest'), false);
  assert.equal(isExactVersion(undefined), false);
});
