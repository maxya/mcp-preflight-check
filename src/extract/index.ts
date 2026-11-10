export interface PackageSpec { name: string; version?: string; raw: string }
export type Target =
  | { kind: 'npm'; launcher: string; spec: PackageSpec; pinned: boolean; display: string }
  | { kind: 'pypi'; launcher: string; name: string; display: string }
  | { kind: 'docker'; image: string; display: string }
  | { kind: 'local'; path: string; display: string }
  | { kind: 'remote'; url: string; display: string }
  | { kind: 'unsupported'; reason: string; display: string };

const NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const EXACT_SEMVER = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** "@scope/pkg@1.2.3" -> {name:"@scope/pkg", version:"1.2.3"}; null if not a registry name. */
export function parsePackageSpec(raw: string): PackageSpec | null {
  if (raw.startsWith('npm:')) raw = raw.slice(4);
  const at = raw.indexOf('@', raw.startsWith('@') ? 1 : 0);
  const name = at < 0 ? raw : raw.slice(0, at);
  const version = at < 0 ? undefined : raw.slice(at + 1) || undefined;
  if (!NPM_NAME.test(name)) return null; // github:, git+https:, file:, tarball URLs, paths
  return { name, version, raw };
}
export const isExactVersion = (v?: string) => !!v && EXACT_SEMVER.test(v);

function base(cmd: string): string {
  const b = cmd.split(/[\\/]/).pop() ?? cmd;
  return b.toLowerCase().replace(/\.(cmd|exe|bat|ps1)$/, '');
}

/** Host only, never path/query/userinfo. */
export function safeHost(url: string): string {
  try { return new URL(url).host || '<unparsed url>'; } catch { return '<unparsed url>'; }
}

/** Mask every server argument: flags keep their name, values and positionals become <arg>. */
export function maskArgs(args: string[]): string[] {
  return args.map(a => {
    if (/^--?[A-Za-z][\w-]*$/.test(a)) return a;
    const m = /^(--?[A-Za-z][\w-]*)=/.exec(a);
    if (m) return `${m[1]}=<value>`;
    return '<arg>';
  });
}

const NPX_VALUE_FLAGS = new Set(['-p', '--package', '-c', '--call', '--registry', '--cache', '--userconfig', '-w', '--workspace']);
const NPX_BOOL_FLAGS = new Set(['-y', '--yes', '--no', '--no-install', '-q', '--quiet', '--prefer-offline', '--prefer-online', '--ignore-existing']);

function fromNpmLauncher(launcher: string, args: string[]): Target {
  let pkgFromFlag: string | undefined;
  const kept: string[] = [];
  let k = 0;
  for (; k < args.length; k++) {
    const a = args[k];
    if (a === '--') { k++; break; }
    if (NPX_BOOL_FLAGS.has(a)) { kept.push(a); continue; }
    const eq = /^(--package|--registry|--cache|--userconfig|--workspace)=(.*)$/.exec(a);
    if (eq) { if (eq[1] === '--package') pkgFromFlag ??= eq[2]; kept.push(eq[1] === '--package' ? a : `${eq[1]}=<value>`); continue; }
    if (NPX_VALUE_FLAGS.has(a)) {
      const v = args[k + 1] ?? '';
      if (a === '-p' || a === '--package') { pkgFromFlag ??= v; kept.push(a, v); } else kept.push(a, '<value>');
      k++; continue;
    }
    if (a.startsWith('-')) { kept.push(a); continue; }
    break;
  }
  const positional = args[k];
  const rawSpec = pkgFromFlag ?? positional;
  const rest = pkgFromFlag ? args.slice(k) : args.slice(k + 1);
  const shown = pkgFromFlag ? maskArgs(rest) : [positional, ...maskArgs(rest)].filter(Boolean);
  const display = [launcher, ...kept, ...shown].join(' ');
  if (!rawSpec) return { kind: 'unsupported', reason: `${launcher} with no package`, display };
  const spec = parsePackageSpec(rawSpec);
  if (!spec) return { kind: 'unsupported', reason: 'not an npm registry package (git/URL/path spec)', display };
  return { kind: 'npm', launcher, spec, pinned: isExactVersion(spec.version), display };
}

export function extractTarget(command: string | undefined, args: string[] = [], url?: string): Target {
  if (!command && url) return { kind: 'remote', url, display: safeHost(url) };
  if (!command) return { kind: 'unsupported', reason: 'no command and no url', display: '' };
  const b = base(command);
  if (b === 'cmd' && /^\/c$/i.test(args[0] ?? '') && args[1]) return extractTarget(args[1], args.slice(2), url);
  if (b === 'npx' || b === 'bunx') return fromNpmLauncher(b, args);
  if ((b === 'npm' && (args[0] === 'exec' || args[0] === 'x')) || ((b === 'pnpm' || b === 'yarn') && args[0] === 'dlx') || (b === 'bun' && args[0] === 'x'))
    return fromNpmLauncher(`${b} ${args[0]}`, args.slice(1));
  if (b === 'uvx' || (b === 'uv' && args[0] === 'tool' && args[1] === 'run') || (b === 'pipx' && args[0] === 'run')) {
    const rest = b === 'uvx' ? args : b === 'pipx' ? args.slice(1) : args.slice(2);
    const fromIdx = rest.indexOf('--from');
    const name = fromIdx >= 0 ? rest[fromIdx + 1] : rest.find(a => !a.startsWith('-'));
    return { kind: 'pypi', launcher: b, name: name ?? '', display: `${b} ${name ?? ''}`.trim() };
  }
  if (b === 'docker' || b === 'podman') {
    const runIdx = args.indexOf('run');
    const VALUE = new Set(['-e', '--env', '-v', '--volume', '--name', '-p', '--publish', '--network', '--env-file', '-w', '--workdir', '--entrypoint', '-u', '--user', '--mount', '--platform']);
    let image = '';
    for (let k = runIdx + 1; runIdx >= 0 && k < args.length; k++) {
      const a = args[k];
      if (VALUE.has(a)) { k++; continue; }
      if (a.startsWith('-')) continue;
      image = a; break;
    }
    return { kind: 'docker', image, display: `${b} run … ${image}` };
  }
  if (['node', 'python', 'python3', 'deno', 'bun', 'tsx', 'ts-node'].includes(b)) {
    const file = args.find(a => !a.startsWith('-') && a !== 'run');
    if (file) return { kind: 'local', path: file, display: `${b} ${file}` };
  }
  if (/[\\/]/.test(command)) return { kind: 'local', path: command, display: command };
  return { kind: 'unsupported', reason: `launcher "${b}" not recognised`, display: b };
}
