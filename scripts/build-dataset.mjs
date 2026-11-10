#!/usr/bin/env node
// Maintainer-only (network). Regenerates data/deprecated.json. Hosts: registry.npmjs.org, api.github.com.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { factsFromPackument } from '../dist/registry/facts.js';

const OUT = new URL('../data/deprecated.json', import.meta.url);
mkdirSync(new URL('../data/', import.meta.url), { recursive: true });
const UA = { 'user-agent': 'mcp-preflight-check-dataset' };
const CURATED = [ // MCPhantom set (Glow Labs, 2026-11-02) — all deprecated on npm as of 2026-11-10
  '@modelcontextprotocol/server-github', '@modelcontextprotocol/server-postgres',
  '@modelcontextprotocol/server-slack', '@modelcontextprotocol/server-puppeteer',
  '@modelcontextprotocol/server-brave-search', '@modelcontextprotocol/server-google-maps',
  '@modelcontextprotocol/server-gitlab', '@modelcontextprotocol/server-gdrive',
  '@modelcontextprotocol/server-redis', '@modelcontextprotocol/server-aws-kb-retrieval',
  '@modelcontextprotocol/server-everart', '@modelcontextprotocol/create-server',
];
const ORGS = ['modelcontextprotocol'];
const SEARCHES = ['keywords:mcp-server', 'keywords:modelcontextprotocol', 'keywords:mcp', 'mcp server'];
const SEARCH_LIMIT = Number(process.env.SEARCH_LIMIT ?? 1000);   // per query; search hides deprecated pkgs
const TOKEN = process.env.GITHUB_TOKEN;                           // strongly recommended: 5000/h vs 60/h

const getJson = async (url, headers = {}) => {
  const r = await fetch(url, { headers: { ...UA, ...headers } });
  return { status: r.status, headers: r.headers, body: r.status === 204 ? null : await r.json().catch(() => null) };
};

let prev = { packages: {} };
try { prev = JSON.parse(readFileSync(OUT, 'utf8')); } catch {}
const names = new Set([...CURATED, ...Object.keys(prev.packages)]);   // never drop a name
for (const org of ORGS) {
  const r = await getJson(`https://registry.npmjs.org/-/org/${org}/package`);
  if (r.status === 200) Object.keys(r.body).forEach(n => names.add(n));
}
for (const q of SEARCHES) {
  for (let from = 0; from < SEARCH_LIMIT; from += 250) {
    const r = await getJson(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(q)}&size=250&from=${from}`);
    const objs = r.body?.objects ?? [];
    objs.forEach(o => names.add(o.package.name));
    if (objs.length < 250) break;
  }
}

const now = new Date().toISOString();
const out = {};
const list = [...names].sort();
let i = 0;
async function worker() {
  while (i < list.length) {
    const name = list[i++];
    const r = await getJson(`https://registry.npmjs.org/${name.replace('/', '%2F')}`);
    if (r.status !== 200 && r.status !== 404) { if (prev.packages[name]) out[name] = prev.packages[name]; continue; }
    const doc = r.status === 404 ? {} : r.body;
    const f = factsFromPackument(doc, name);
    const vers = Object.entries(doc.versions ?? {});
    const depVers = vers.filter(([, m]) => typeof m.deprecated === 'string' && m.deprecated.trim()).map(([v]) => v);
    out[name] = {
      exists: f.exists, latest: f.resolvedVersion ?? null, deprecated: f.deprecated,
      deprecatedVersions: vers.length && depVers.length === vers.length ? '*' : depVers,
      lastPublish: f.lastPublish ?? null, lastPublishVersion: f.lastPublishVersion ?? null,
      repository: f.repository ? `${f.repository.owner}/${f.repository.repo}` : null,
      repoArchived: prev.packages[name]?.repoArchived ?? null, repoPushedAt: prev.packages[name]?.repoPushedAt ?? null,
      checkedAt: now,
    };
  }
}
await Promise.all(Array.from({ length: 4 }, worker));

// GitHub: with a token check every repo; without one, only up to 50 (unauthenticated limit is 60/h).
const repos = [...new Set(Object.values(out).map(p => p.repository).filter(Boolean))];
const budget = TOKEN ? Infinity : 50;
const status = {};
for (const repo of repos.slice(0, budget)) {
  const r = await getJson(`https://api.github.com/repos/${repo}`, {
    accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
    ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
  });
  if (r.status === 200) status[repo] = { archived: !!r.body.archived, pushedAt: r.body.pushed_at };
  else if (r.status === 403 || r.status === 429) { console.warn('GitHub rate limit hit; remaining repos keep previous values'); break; }
}
for (const p of Object.values(out)) if (p.repository && status[p.repository]) {
  p.repoArchived = status[p.repository].archived; p.repoPushedAt = status[p.repository].pushedAt;
}

const sorted = Object.fromEntries(Object.keys(out).sort().map(k => [k, out[k]]));
const file = { schema: 1, tool: 'mcp-preflight-check', generatedAt: now, packages: sorted };
writeFileSync(new URL('deprecated.json.tmp', OUT), JSON.stringify(file, null, 2) + '\n');
renameSync(new URL('deprecated.json.tmp', OUT), OUT);

const dep = Object.entries(sorted).filter(([, p]) => p.deprecated).map(([n]) => n);
const arch = Object.entries(sorted).filter(([, p]) => p.repoArchived).map(([n]) => n);
const unchecked = Object.values(sorted).filter(p => p.repository && p.repoArchived === null).length;
console.log(`packages: ${list.length} · deprecated: ${dep.length} · archived repos: ${arch.length} · repo status unknown: ${unchecked}`);
const newDep = dep.filter(n => !prev.packages[n]?.deprecated);
if (newDep.length) console.log('newly deprecated:\n  ' + newDep.join('\n  '));
