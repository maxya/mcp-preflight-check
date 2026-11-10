#!/usr/bin/env node
// Maintainer-only (network). Records trimmed packuments into test/fixtures/registry/.
import { writeFileSync, mkdirSync } from 'node:fs';
const NAMES = process.argv.slice(2);
const dir = new URL('../test/fixtures/registry/', import.meta.url);
mkdirSync(dir, { recursive: true });
for (const name of NAMES) {
  const res = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2F')}`, { headers: { 'user-agent': 'mcp-preflight-check-fixtures' } });
  if (res.status === 404) { console.log(`404 ${name}`); continue; }
  const d = await res.json();
  const versions = Object.fromEntries(Object.entries(d.versions ?? {}).map(([v, m]) => [v, { deprecated: m.deprecated, repository: m.repository }]));
  const trimmed = { name: d.name, 'dist-tags': d['dist-tags'], time: d.time, repository: d.repository, versions };
  const file = name.replace('@', '').replace('/', '__') + '.json';
  writeFileSync(new URL(file, dir), JSON.stringify(trimmed, null, 2) + '\n');
  console.log(`ok  ${name} -> ${file}`);
}
