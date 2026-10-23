import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fillPlaceholders, loadText } from '../../cli/text.mjs';
import { helpText } from '../../cli/help.mjs';
import { REPO_ROOT } from './helpers.mjs';

const schemaDir = path.join(REPO_ROOT, 'skill', 'everything-mapped', 'schema');
const readTexts = (lang) => JSON.parse(fs.readFileSync(path.join(schemaDir, `ui-cli.${lang}.json`), 'utf8'));
const da = readTexts('da');
const en = readTexts('en');

const SOURCE_FILES = [
  path.join(REPO_ROOT, 'bin', 'cli.mjs'),
  ...fs.readdirSync(path.join(REPO_ROOT, 'cli')).map((name) => path.join(REPO_ROOT, 'cli', name)),
  path.join(REPO_ROOT, 'skill', 'everything-mapped', 'scripts', 'pack.mjs'),
];
const sources = SOURCE_FILES.map((file) => fs.readFileSync(file, 'utf8')).join('\n');

// Figure dash, en dash, em dash, horizontal bar and minus sign, by code point.
const DASH_CODE_POINTS = [0x2012, 0x2013, 0x2014, 0x2015, 0x2212];

const placeholdersOf = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

test('Danish and English define exactly the same keys, without duplicates in the files', () => {
  assert.deepEqual(Object.keys(da).sort(), Object.keys(en).sort());
  for (const lang of ['da', 'en']) {
    const raw = fs.readFileSync(path.join(schemaDir, `ui-cli.${lang}.json`), 'utf8');
    const written = [...raw.matchAll(/^\s*"([^"]+)":/gm)].map((match) => match[1]);
    assert.equal(new Set(written).size, written.length, `${lang}: a key is written twice`);
  }
});

test('every key is in the ui.cli, ui.install or ui.pack group', () => {
  for (const key of Object.keys(en)) assert.match(key, /^ui\.(cli|install|pack)\./, key);
});

test('both languages use the same placeholders for every key', () => {
  for (const key of Object.keys(en)) {
    assert.deepEqual(placeholdersOf(da[key]), placeholdersOf(en[key]), key);
  }
});

test('no key collides with a key from another text file in the schema folder', () => {
  for (const lang of ['da', 'en']) {
    const owners = new Map();
    for (const name of fs.readdirSync(schemaDir).filter((file) => file.endsWith(`.${lang}.json`)).sort()) {
      for (const key of Object.keys(JSON.parse(fs.readFileSync(path.join(schemaDir, name), 'utf8')))) {
        assert.ok(!owners.has(key), `${key} is in both ${owners.get(key)} and ${name}`);
        owners.set(key, name);
      }
    }
  }
});

test('writing rules: plain text, no dashes used as punctuation, no exclamation marks, no emoji, no "gate"', () => {
  for (const [lang, texts] of [['da', da], ['en', en]]) {
    for (const [key, value] of Object.entries(texts)) {
      const where = `${lang} ${key}`;
      assert.equal(typeof value, 'string', where);
      assert.ok(value.trim().length > 0, `${where}: empty`);
      assert.ok(![...value].some((character) => DASH_CODE_POINTS.includes(character.codePointAt(0))), `${where}: em or en dash`);
      assert.doesNotMatch(value, /!/, `${where}: exclamation mark`);
      assert.doesNotMatch(value, /\p{Extended_Pictographic}/u, `${where}: emoji`);
      assert.doesNotMatch(value, /gate/i, `${where}: the word gate`);
      assert.doesNotMatch(value, /  /, `${where}: double space`);
      if (key !== 'ui.install.prompt.question') assert.equal(value, value.trim(), `${where}: surrounding space`);
    }
  }
});

test('Danish texts are really Danish: most differ from English and several use æ, ø or å', () => {
  const different = Object.keys(en).filter((key) => da[key] !== en[key]);
  assert.ok(different.length > Object.keys(en).length * 0.9);
  assert.ok(Object.values(da).filter((value) => /[æøåÆØÅ]/.test(value)).length >= 10);
});

test('every text key the code uses exists, and every key in the files is used', () => {
  const literal = new Set([...sources.matchAll(/'(ui\.(?:cli|install|pack)\.[A-Za-z0-9_.]+)'/g)].map((match) => match[1]));
  const prefixes = [...sources.matchAll(/`(ui\.(?:cli|install|pack)\.[A-Za-z0-9_.]*)\$\{/g)].map((match) => match[1]);

  assert.ok(prefixes.length >= 5, 'the dynamic key families were not found');
  for (const key of literal) assert.ok(Object.hasOwn(en, key), `used in code but missing in the text files: ${key}`);
  for (const prefix of prefixes) {
    assert.ok(Object.keys(en).some((key) => key.startsWith(prefix)), `no key for the family ${prefix}`);
  }

  const unused = Object.keys(en).filter(
    (key) => !literal.has(key) && !prefixes.some((prefix) => key.startsWith(prefix)),
  );
  assert.deepEqual(unused, [], 'keys that no code uses');
});

test('the dynamic key families are complete', () => {
  const expected = [
    ...['install', 'uninstall', 'check', 'next', 'answer', 'assets', 'pack', 'version', 'help'].map((name) => `ui.cli.help.cmd.${name}`),
    ...['claude', 'codex', 'global', 'local', 'dir', 'dryRun', 'force', 'lang', 'root', 'out', 'json'].map((name) => `ui.cli.help.opt.${name}`),
    ...['install', 'installGlobal', 'installBoth', 'pack'].map((name) => `ui.cli.help.example.${name}`),
    'ui.install.scope.project',
    'ui.install.scope.user',
    'ui.install.remove.scope.project',
    'ui.install.remove.scope.user',
    'ui.install.summary.project',
    'ui.install.summary.user',
    'ui.install.next.claude',
    'ui.install.next.codex',
    ...['tooManyEntries', 'tooLarge', 'badName', 'nameTooLong', 'duplicateName', 'needsNewerNode', 'fileChanged'].map((code) => `ui.pack.error.zip.${code}`),
  ];
  for (const key of expected) assert.ok(Object.hasOwn(en, key), key);
});

test('the next-step texts carry the exact commands', () => {
  assert.match(en['ui.install.next.claude'], /claude.*\/everything-mapped/);
  assert.match(en['ui.install.next.codex'], /codex.*\$everything-mapped/);
  assert.match(da['ui.install.next.claude'], /claude.*\/everything-mapped/);
  assert.match(da['ui.install.next.codex'], /codex.*\$everything-mapped/);
});

test('loadText fills placeholders, leaves unknown ones, and returns the key for a missing text', () => {
  const { t, has, keys } = loadText('en');
  assert.equal(t('ui.cli.version', { version: '9.9.9' }), 'everything-mapped 9.9.9');
  assert.equal(t('ui.cli.error.unknownCommand', {}), 'Unknown command: {command}');
  assert.equal(t('ui.nope.missing'), 'ui.nope.missing');
  assert.equal(has('ui.cli.version'), true);
  assert.equal(keys().length, Object.keys(en).length);
});

test('placeholder values containing $ patterns are inserted literally', () => {
  assert.equal(fillPlaceholders('Path {path}', { path: "$& $' $1 $$" }), "Path $& $' $1 $$");
});

test('help text has every command and option in both languages and no empty lines of text', () => {
  for (const lang of ['da', 'en']) {
    const text = helpText(loadText(lang).t);
    for (const command of ['install', 'uninstall', 'check', 'next', 'answer', 'assets', 'pack', 'version', 'help']) {
      assert.match(text, new RegExp(`^  ${command}\\s`, 'm'), `${lang} ${command}`);
    }
    for (const option of ['--claude', '--codex', '-g', '--global', '--user', '--local', '--dir', '--dry-run', '--force', '--lang', '--root', '--out', '--json']) {
      assert.ok(text.includes(option), `${lang} ${option}`);
    }
    assert.doesNotMatch(text, /ui\.cli\./, `${lang}: an unresolved key in the help`);
  }
});
