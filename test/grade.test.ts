import test from 'node:test';
import assert from 'node:assert/strict';
import { exitCode, grade } from '../src/grade.js';
import type { Finding, Report, ServerResult, Verdict } from '../src/types.js';

const finding = (severity: Finding['severity'], id: Finding['id'] = 'DEPRECATED'): Finding => ({ id, severity, message: 'x' });

test('grade precedence: blocked > warn > unknown > OK', () => {
  assert.equal(grade('npm', [finding('warn'), finding('blocked')]), 'REFUSE');
  assert.equal(grade('npm', [finding('unknown'), finding('warn')]), 'WARN');
  assert.equal(grade('npm', [finding('unknown')]), 'UNKNOWN');
  assert.equal(grade('npm', [finding('info')]), 'OK');
  assert.equal(grade('npm', []), 'OK');
});

test('grade: non-npm servers are SKIPPED unless a blocked/warn finding applies', () => {
  assert.equal(grade('pypi', [finding('info', 'UNSUPPORTED-SOURCE')]), 'SKIPPED');
  assert.equal(grade('remote', []), 'SKIPPED');
  assert.equal(grade('local', [finding('warn', 'BROKEN-PATH')]), 'WARN');
  assert.equal(grade('docker', [finding('blocked')]), 'REFUSE');
  assert.equal(grade('local', [finding('unknown')]), 'SKIPPED');
});

const server = (verdict: Verdict, findings: Finding[] = []): ServerResult => ({
  name: 'srv', client: 'claude-code', source: '/x', disabled: false,
  package: null, target: 'npm', display: 'x', env: [], verdict, findings,
});

const report = (servers: ServerResult[], errors: Report['errors'] = []): Report => ({
  schema: 1, tool: 'mcp-preflight-check', version: '0.1.0', offline: true, snapshotDate: '2026-11-10',
  configs: [], servers, errors,
  summary: { checked: servers.length, refused: 0, warned: 0, unknown: 0, ok: 0, skipped: 0 },
});

test('exitCode 2 for a blocked finding at every --fail-on level', () => {
  const r = report([server('REFUSE', [finding('blocked')])]);
  assert.equal(exitCode(r, 'blocked'), 2);
  assert.equal(exitCode(r, 'warn'), 2);
  assert.equal(exitCode(r, 'any'), 2);
});

test('exitCode warn is 2 only from warn upward', () => {
  const r = report([server('WARN', [finding('warn', 'STALE')])]);
  assert.equal(exitCode(r, 'blocked'), 0);
  assert.equal(exitCode(r, 'warn'), 2);
  assert.equal(exitCode(r, 'any'), 2);
});

test('exitCode any fires on info-only findings', () => {
  const r = report([server('OK', [finding('info', 'UNPINNED')])]);
  assert.equal(exitCode(r, 'blocked'), 0);
  assert.equal(exitCode(r, 'warn'), 0);
  assert.equal(exitCode(r, 'any'), 2);
});

test('unknown never produces exit 2 at any level', () => {
  const r = report([server('UNKNOWN', [finding('unknown', 'NOT-IN-SNAPSHOT')])]);
  assert.equal(exitCode(r, 'blocked'), 0);
  assert.equal(exitCode(r, 'warn'), 0);
  assert.equal(exitCode(r, 'any'), 0);
});

test('a clean report is exit 0', () => {
  const r = report([server('OK', [])]);
  assert.equal(exitCode(r, 'any'), 0);
  assert.equal(exitCode(report([]), 'any'), 0);
});

test('a scan error forces exit 1 even when blocked findings exist', () => {
  const r = report([server('REFUSE', [finding('blocked')])], [{ source: '/x', message: 'x:1:1: invalid JSON' }]);
  assert.equal(exitCode(r, 'blocked'), 1);
  assert.equal(exitCode(r, 'any'), 1);
});
