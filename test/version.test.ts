import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VERSION } from '../src/version.js';

test('VERSION equals package.json version', () => {
  // npm runs tests at the repo root, so cwd is stable across src/ and build-test/.
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version: string };
  assert.equal(VERSION, pkg.version);
});
