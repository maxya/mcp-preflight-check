import { join } from 'node:path';

/** Absolute path into the *source* fixture tree (npm runs tests at the repo root). */
export function fixturePath(...parts: string[]): string {
  return join(process.cwd(), 'test', 'fixtures', ...parts);
}
