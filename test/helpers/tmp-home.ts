import { mkdtemp, mkdir, copyFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fixturePath } from './fixtures.js';

export interface TmpDir {
  dir: string;
  cleanup(): Promise<void>;
}

export async function makeTmpDir(prefix = 'mpc-'): Promise<TmpDir> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Copy a fixture config into `root/rel` (creating parent directories). */
export async function put(root: string, rel: string, fixture: string): Promise<string> {
  const dest = join(root, rel);
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(fixturePath('configs', fixture), dest);
  return dest;
}

export async function putText(root: string, rel: string, text: string): Promise<string> {
  const dest = join(root, rel);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, text, 'utf8');
  return dest;
}
