export class ConfigParseError extends Error {
  constructor(public file: string, public line: number, public column: number, reason: string) {
    super(`${file}:${line}:${column}: ${reason}`);
    this.name = 'ConfigParseError';
  }
}

/** Replace comments and trailing commas with spaces. Offsets and newlines are preserved,
 *  so a JSON.parse error position maps 1:1 back to the original file. */
export function stripJsonc(src: string): string {
  const out: string[] = [];
  const n = src.length;
  let i = 0;
  let inStr = false;
  while (i < n) {
    const c = src[i];
    if (inStr) {
      out.push(c);
      if (c === '\\' && i + 1 < n) { out.push(src[i + 1]); i += 2; continue; }
      if (c === '"') inStr = false;
      i++; continue;
    }
    if (c === '\uFEFF' && i === 0) { out.push(' '); i++; continue; }
    if (c === '"') { inStr = true; out.push(c); i++; continue; }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') { out.push(' '); i++; }
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      out.push(' ', ' '); i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out.push(src[i] === '\n' ? '\n' : ' '); i++; }
      if (i >= n) throw new Error('unterminated block comment');
      out.push(' ', ' '); i += 2;
      continue;
    }
    out.push(c); i++;
  }
  // Second pass: blank out commas followed (after whitespace) by } or ].
  const s = out;
  inStr = false;
  for (let j = 0; j < s.length; j++) {
    const c = s[j];
    if (inStr) {
      if (c === '\\') { j++; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === ',') {
      let k = j + 1;
      while (k < s.length && /\s/.test(s[k])) k++;
      if (s[k] === '}' || s[k] === ']') s[j] = ' ';
    }
  }
  return s.join('');
}

function lineCol(src: string, pos: number): { line: number; column: number } {
  let line = 1, col = 1;
  for (let i = 0; i < pos && i < src.length; i++) {
    if (src[i] === '\n') { line++; col = 1; } else col++;
  }
  return { line, column: col };
}

export function parseJsonc(src: string, file: string): unknown {
  let cleaned: string;
  try { cleaned = stripJsonc(src); }
  catch (e) { const lc = lineCol(src, src.length); throw new ConfigParseError(file, lc.line, lc.column, (e as Error).message); }
  try { return JSON.parse(cleaned); }
  catch (e) {
    const msg = (e as Error).message;
    // V8 formats: "... in JSON at position 42" or "... (line 3 column 5)". Never echo file text.
    const lcm = /line (\d+) column (\d+)/.exec(msg);
    if (lcm) throw new ConfigParseError(file, Number(lcm[1]), Number(lcm[2]), 'invalid JSON');
    const pm = /position (\d+)/.exec(msg);
    const lc = lineCol(src, pm ? Number(pm[1]) : src.length);
    throw new ConfigParseError(file, lc.line, lc.column, 'invalid JSON');
  }
}
