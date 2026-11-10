import type { Finding, Report, Severity, Verdict } from './types.js';

export function grade(kind: string, f: Finding[]): Verdict {
  if (f.some(x => x.severity === 'blocked')) return 'REFUSE';
  if (f.some(x => x.severity === 'warn')) return 'WARN';
  if (kind !== 'npm') return 'SKIPPED';
  if (f.some(x => x.severity === 'unknown')) return 'UNKNOWN';
  return 'OK';
}

export type FailOn = 'blocked' | 'warn' | 'any';

const RANK: Record<Severity, number> = { blocked: 3, warn: 2, info: 1, unknown: 0 };
const THRESHOLD: Record<FailOn, number> = { blocked: 3, warn: 2, any: 1 };

export function exitCode(r: Report, failOn: FailOn): 0 | 1 | 2 {
  if (r.errors.length > 0) return 1;
  const hit = r.servers.some(s => s.findings.some(x => x.severity !== 'unknown' && RANK[x.severity] >= THRESHOLD[failOn]));
  return hit ? 2 : 0;
}
