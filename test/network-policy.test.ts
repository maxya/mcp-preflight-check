import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';

const FORBIDDEN_MODULES = [
  'node:http', 'node:https', 'node:net', 'node:tls', 'node:dgram', 'node:dns',
  'node:child_process', 'node:worker_threads',
];
const FORBIDDEN_GLOBALS = ['XMLHttpRequest', 'WebSocket'];

export function scanSource(text: string, file: string): string[] {
  const violations: string[] = [];
  for (const mod of FORBIDDEN_MODULES) {
    if (text.includes(mod)) violations.push(`${file}: forbidden module ${mod}`);
  }
  for (const global of FORBIDDEN_GLOBALS) {
    if (new RegExp(`\\b${global}\\b`).test(text)) violations.push(`${file}: forbidden global ${global}`);
  }
  const fetchCalls = text.match(/\bfetch\s*\(/g) ?? [];
  const normalized = file.replaceAll('\\', '/');
  if (fetchCalls.length > 0 && normalized !== 'src/net/http.ts' && !normalized.endsWith('/src/net/http.ts')) {
    violations.push(`${file}: fetch() outside src/net/http.ts`);
  }
  return violations;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

test('src/**/*.ts uses no forbidden network module and only net/http.ts calls fetch', () => {
  const root = process.cwd();
  const files = walk(join(root, 'src'));
  assert.ok(files.length > 15, 'expected to scan the source tree');
  const violations: string[] = [];
  for (const file of files) {
    violations.push(...scanSource(readFileSync(file, 'utf8'), relative(root, file)));
  }
  assert.deepEqual(violations, []);
});

test('the scanner has a positive control', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mpc-scan-'));
  try {
    const file = join(dir, 'bad.ts');
    writeFileSync(file, "import https from 'node:https';\nfetch('https://example.com');\n");
    const found = scanSource(readFileSync(file, 'utf8'), 'bad.ts');
    assert.ok(found.some(v => v.includes('node:https')));
    assert.ok(found.some(v => v.includes('fetch() outside')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
