#!/usr/bin/env node
import { homedir } from 'node:os';
import { run } from './run.js';

process.exitCode = await run(process.argv.slice(2), {
  stdout: s => process.stdout.write(s),
  stderr: s => process.stderr.write(s),
  isTTY: !!process.stdout.isTTY,
}, {
  fetch: globalThis.fetch,
  env: process.env,
  cwd: process.cwd(),
  home: homedir(),
  platform: process.platform,
  now: new Date(),
});
