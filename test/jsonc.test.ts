import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfigParseError, parseJsonc, stripJsonc } from '../src/discover/jsonc.js';

test('strips line and block comments but keeps strings intact', () => {
  const src = `{
  // a line comment
  "a": "http://x/*not a comment*/", /* block\n comment */
  "b": [1, 2,],
  "c": "esc \\" , ]"
}`;
  const doc = parseJsonc(src, 'ok.json') as Record<string, unknown>;
  assert.deepEqual(doc, { a: 'http://x/*not a comment*/', b: [1, 2], c: 'esc " , ]' });
});

test('keeps offsets and newlines so error positions map back to the original', () => {
  const src = '{\n  "a": 1\n  "b": "SECRET"\n}';
  assert.throws(() => parseJsonc(src, 'bad.json'), (e: unknown) => {
    assert.ok(e instanceof ConfigParseError);
    assert.equal(e.line, 3);
    assert.equal(e.column, 3);
    assert.match(e.message, /^bad\.json:3:3: invalid JSON$/);
    assert.ok(!e.message.includes('SECRET'));
    return true;
  });
});

test('strips a leading BOM', () => {
  const doc = parseJsonc('\uFEFF{"a":1}', 'bom.json');
  assert.deepEqual(doc, { a: 1 });
});

test('trailing commas in nested arrays and objects are removed', () => {
  const doc = parseJsonc('{"a": [1, {"b": 2,},],}', 'trailing.json');
  assert.deepEqual(doc, { a: [1, { b: 2 }] });
});

test('a comma inside a string is never treated as a trailing comma', () => {
  const doc = parseJsonc('{"a": "x,]", "b": 1}', 'str.json');
  assert.deepEqual(doc, { a: 'x,]', b: 1 });
});

test('unterminated block comment reports the end of the file', () => {
  assert.throws(() => parseJsonc('{"a":1} /* nope', 'c.json'), (e: unknown) => {
    assert.ok(e instanceof ConfigParseError);
    assert.match(e.message, /c\.json:1:\d+: unterminated block comment/);
    return true;
  });
});

test('stripJsonc preserves the length of the input', () => {
  const src = '{\n// x\n"a": [1,2,],\n}';
  assert.equal(stripJsonc(src).length, src.length);
});
