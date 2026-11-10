import { ConfigParseError } from './jsonc.js';

type TomlValue = string | boolean | TomlValue[] | { [k: string]: TomlValue };
type Table = { [k: string]: TomlValue };

/**
 * Minimal TOML reader: enough to read Codex `config.toml` and keep the `mcp_servers` subtree.
 * Supports: [table] / [a."b c".d] headers, [[array-of-tables]] (skipped), dotted keys,
 * basic/literal strings incl. triple-quoted, arrays (multi-line), inline tables, booleans.
 * Numbers/dates are kept as raw strings. Anything else -> ConfigParseError(file, line, col).
 */
export function parseTomlSubset(src: string, file: string): Table {
  const root: Table = {};
  let i = 0;
  const n = src.length;
  let current: Table | null = root; // null = inside [[array table]] we ignore

  const fail = (reason: string): never => {
    let line = 1, col = 1;
    for (let k = 0; k < i && k < n; k++) { if (src[k] === '\n') { line++; col = 1; } else col++; }
    throw new ConfigParseError(file, line, col, reason);
  };
  const skipWs = () => { while (i < n && (src[i] === ' ' || src[i] === '\t')) i++; };
  const skipComment = () => { if (src[i] === '#') while (i < n && src[i] !== '\n') i++; };
  const skipWsNl = () => {
    for (;;) {
      skipWs(); skipComment();
      if (src[i] === '\n' || src[i] === '\r') { i++; continue; }
      return;
    }
  };
  const expectEol = () => {
    skipWs(); skipComment();
    if (i < n && src[i] !== '\n' && src[i] !== '\r') fail('unexpected text after value');
  };

  const parseBasicString = (): string => {
    if (src.startsWith('"""', i)) {
      i += 3; if (src[i] === '\n') i++; else if (src.startsWith('\r\n', i)) i += 2;
      let s = '';
      while (i < n && !src.startsWith('"""', i)) {
        if (src[i] === '\\') { s += unescape(); continue; }
        s += src[i++];
      }
      if (i >= n) fail('unterminated string');
      i += 3; return s;
    }
    i++; let s = '';
    while (i < n && src[i] !== '"') {
      if (src[i] === '\n') fail('newline in string');
      if (src[i] === '\\') { s += unescape(); continue; }
      s += src[i++];
    }
    if (i >= n) fail('unterminated string');
    i++; return s;
  };
  const unescape = (): string => {
    const e = src[i + 1]; i += 2;
    switch (e) {
      case 'n': return '\n'; case 't': return '\t'; case 'r': return '\r';
      case '"': return '"'; case '\\': return '\\'; case 'b': return '\b'; case 'f': return '\f';
      case 'u': case 'U': {
        const len = e === 'u' ? 4 : 8; const hex = src.slice(i, i + len); i += len;
        return String.fromCodePoint(parseInt(hex, 16));
      }
      case '\n': case '\r': while (i < n && /\s/.test(src[i])) i++; return ''; // line-ending backslash
      default: return fail('bad escape');
    }
  };
  const parseLiteralString = (): string => {
    if (src.startsWith("'''", i)) {
      i += 3; if (src[i] === '\n') i++;
      const end = src.indexOf("'''", i); if (end < 0) fail('unterminated string');
      const s = src.slice(i, end); i = end + 3; return s;
    }
    i++; const start = i;
    while (i < n && src[i] !== "'") { if (src[i] === '\n') fail('newline in string'); i++; }
    if (i >= n) fail('unterminated string');
    const s = src.slice(start, i); i++; return s;
  };
  const parseKeyPart = (): string => {
    if (src[i] === '"') return parseBasicString();
    if (src[i] === "'") return parseLiteralString();
    const start = i;
    while (i < n && /[A-Za-z0-9_-]/.test(src[i])) i++;
    if (i === start) fail('expected key');
    return src.slice(start, i);
  };
  const parseKeyPath = (): string[] => {
    const parts = [parseKeyPart()];
    for (;;) { skipWs(); if (src[i] !== '.') return parts; i++; skipWs(); parts.push(parseKeyPart()); }
  };
  const parseValue = (): TomlValue => {
    const c = src[i];
    if (c === '"') return parseBasicString();
    if (c === "'") return parseLiteralString();
    if (c === '[') {
      i++; const arr: TomlValue[] = [];
      for (;;) {
        skipWsNl();
        if (src[i] === ']') { i++; return arr; }
        arr.push(parseValue());
        skipWsNl();
        if (src[i] === ',') { i++; continue; }
        if (src[i] === ']') { i++; return arr; }
        fail('expected , or ] in array');
      }
    }
    if (c === '{') {
      i++; const t: Table = {};
      skipWs();
      if (src[i] === '}') { i++; return t; }
      for (;;) {
        skipWs(); const path = parseKeyPath(); skipWs();
        if (src[i] !== '=') fail('expected = in inline table');
        i++; skipWs(); setPath(t, path, parseValue()); skipWs();
        if (src[i] === ',') { i++; continue; }
        if (src[i] === '}') { i++; return t; }
        fail('expected , or } in inline table');
      }
    }
    // bare token: true/false/number/date — keep raw
    const start = i;
    while (i < n && !/[\s,\]}#]/.test(src[i])) i++;
    const raw = src.slice(start, i);
    if (raw === '') fail('expected value');
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return raw;
  };
  const setPath = (t: Table, path: string[], v: TomlValue) => {
    let o = t;
    for (const p of path.slice(0, -1)) {
      const next = o[p];
      if (next === undefined) { const nt: Table = {}; o[p] = nt; o = nt; }
      else if (typeof next === 'object' && !Array.isArray(next)) o = next as Table;
      else fail('key conflicts with a value');
    }
    o[path[path.length - 1]] = v;
  };
  const tableAt = (path: string[]): Table => {
    let o = root;
    for (const p of path) {
      const next = o[p];
      if (next === undefined) { const nt: Table = {}; o[p] = nt; o = nt; }
      else if (typeof next === 'object' && !Array.isArray(next)) o = next as Table;
      else fail('table conflicts with a value');
    }
    return o;
  };

  for (;;) {
    skipWsNl();
    if (i >= n) break;
    if (src.startsWith('[[', i)) {               // array of tables: parse header, ignore body
      i += 2; skipWs(); parseKeyPath(); skipWs();
      if (!src.startsWith(']]', i)) fail('expected ]]');
      i += 2; expectEol(); current = null; continue;
    }
    if (src[i] === '[') {
      i++; skipWs(); const path = parseKeyPath(); skipWs();
      if (src[i] !== ']') fail('expected ]');
      i++; expectEol(); current = tableAt(path); continue;
    }
    const path = parseKeyPath(); skipWs();
    if (src[i] !== '=') fail('expected =');
    i++; skipWs();
    const v = parseValue();
    expectEol();
    if (current) setPath(current, path, v);
  }
  return root;
}
