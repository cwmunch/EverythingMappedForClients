import assert from 'node:assert/strict';
import test from 'node:test';
import { makeI18n } from '../../skill/everything-mapped/scripts/lib/i18n-core.mjs';
import {
  escapePipes,
  isValidDate,
  localDate,
  normalizeNewlines,
  normalizeText,
  oneLine,
  parseArgv,
  slugify,
  splitPipes,
  toToken,
  uniq,
} from '../../skill/everything-mapped/scripts/lib/util.mjs';

test('normalizeNewlines turns CRLF and CR into LF and drops a byte order mark', () => {
  assert.equal(normalizeNewlines('\uFEFFa\r\nb\rc\nd'), 'a\nb\nc\nd');
});

test('normalizeText trims lines and the ends but keeps inner blank lines', () => {
  assert.equal(normalizeText('\n\n  first  \t\r\n\r\nsecond   \n\n'), 'first\n\nsecond');
  assert.equal(normalizeText(undefined), '');
});

test('oneLine collapses every run of white space', () => {
  assert.equal(oneLine('  a \n\n b\t c '), 'a b c');
});

test('toToken makes one token without spaces or marker-breaking characters', () => {
  assert.equal(toToken('Anna Jensen'), 'Anna-Jensen');
  assert.equal(toToken('  IT   afdelingen '), 'IT-afdelingen');
  assert.equal(toToken('a-->b'), 'a-b');
  assert.equal(toToken('<x>"y"'), 'xy');
  assert.equal(toToken(''), '');
});

test('slugify makes a plain lowercase slug', () => {
  assert.equal(slugify('Nordlys Cykler & Co.'), 'nordlys-cykler-co');
  assert.equal(slugify('Café Åben'), 'cafe-aben');
});

test('escapePipes and splitPipes round trip text with pipes and backslashes', () => {
  for (const text of ['a | b', 'a\\|b', 'ends with backslash\\', 'C:\\temp\\file', 'plain']) {
    assert.deepEqual(splitPipes(escapePipes(text)), [text]);
    assert.deepEqual(splitPipes(`${escapePipes(text)} | ${escapePipes(text)}`, 2), [`${text} `, ` ${text}`]);
  }
});

test('splitPipes splits at the first unescaped pipe only when maxParts is 2', () => {
  assert.deepEqual(splitPipes('a | b | c', 2), ['a ', ' b | c']);
  assert.deepEqual(splitPipes('a | b | c'), ['a ', ' b ', ' c']);
  assert.deepEqual(splitPipes('a \\| b | c', 2), ['a | b ', ' c']);
});

test('isValidDate accepts real dates written as YYYY-MM-DD only', () => {
  assert.equal(isValidDate('2026-12-01'), true);
  assert.equal(isValidDate('2028-02-29'), true);
  assert.equal(isValidDate('2026-02-29'), false);
  assert.equal(isValidDate('2026-13-01'), false);
  assert.equal(isValidDate('2026-1-1'), false);
  assert.equal(isValidDate('1. december 2026'), false);
  assert.equal(isValidDate(undefined), false);
});

test('localDate writes the local calendar date with leading zeros', () => {
  assert.equal(localDate(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
});

test('uniq keeps the first of each value', () => {
  assert.deepEqual(uniq(['a', 'b', 'a', 'c', 'b']), ['a', 'b', 'c']);
});

test('parseArgv reads strings, booleans, = forms and reports problems', () => {
  const spec = { root: 'string', json: 'boolean', count: 'string' };
  const good = parseArgv(['--root', 'x y', '--json', '--count=3', 'extra'], spec);
  assert.deepEqual(good.values, { root: 'x y', json: true, count: '3' });
  assert.deepEqual(good.positionals, ['extra']);
  assert.deepEqual(good.problems, []);

  const bad = parseArgv(['--nope', '--root', '--json=1'], spec);
  assert.deepEqual(
    bad.problems.map((problem) => problem.key),
    ['ui.check.err.unknownOption', 'ui.check.err.missingValue', 'ui.check.err.unexpectedValue'],
  );
  assert.equal(bad.problems[0].params.option, '--nope');
});

test('parseArgv takes a lone dash and a name that is not an option name as values', () => {
  const result = parseArgv(['--from', '-', '--toString'], { from: 'string' });
  assert.equal(result.values.from, '-');
  assert.equal(result.problems[0].key, 'ui.check.err.unknownOption');
});

test('makeI18n fills placeholders, returns the key for a missing key and lists keys', () => {
  const i18n = makeI18n({ 'a.b': 'Hello {name}, {count} left, {unknown}', 'c': 'plain' }, 'en');
  assert.equal(i18n.lang, 'en');
  assert.equal(i18n.t('a.b', { name: 'Anna', count: 0 }), 'Hello Anna, 0 left, {unknown}');
  assert.equal(i18n.t('a.b'), 'Hello {name}, {count} left, {unknown}');
  assert.equal(i18n.t('missing.key'), 'missing.key');
  assert.equal(i18n.has('c'), true);
  assert.equal(i18n.has('nope'), false);
  assert.deepEqual(i18n.keys(), ['a.b', 'c']);
});

test('makeI18n does not expand placeholders inside values it substituted', () => {
  const i18n = makeI18n({ k: 'x {a}' }, 'da');
  assert.equal(i18n.t('k', { a: '{a}' }), 'x {a}');
});
