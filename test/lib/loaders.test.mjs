import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadI18n, loadSchema, resolveLanguage } from '../../skill/everything-mapped/scripts/lib/index.mjs';
import { SCHEMA_DIR, makeTempDir, writeText } from './helpers.mjs';

test('loadSchema loads the default schema and checks its shape', () => {
  const schema = loadSchema();
  assert.equal(schema.schema, 'everything-mapped-for-clients/1');
  assert.deepEqual(schema.moduleOrder, ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']);
  assert.deepEqual(loadSchema(path.join(SCHEMA_DIR, 'intake-schema.json')), schema);
});

test('loadSchema explains a missing file, bad JSON and a wrong shape', (t) => {
  const dir = makeTempDir(t);
  assert.throws(() => loadSchema(path.join(dir, 'none.json')), /Cannot read the schema/);
  writeText(dir, 'bad.json', '{ nope');
  assert.throws(() => loadSchema(path.join(dir, 'bad.json')), /Cannot read the schema/);
  writeText(dir, 'list.json', '[]');
  assert.throws(() => loadSchema(path.join(dir, 'list.json')), /not a JSON object/);
  writeText(dir, 'short.json', JSON.stringify({ schema: 'x', modules: [] }));
  assert.throws(() => loadSchema(path.join(dir, 'short.json')), /missing or has a wrong type for: languages, levels/);
});

test('loadI18n joins every file for the language in alphabetical order and ignores the other language', (t) => {
  const dir = makeTempDir(t);
  writeText(dir, 'b.da.json', JSON.stringify({ 'b.key': 'B {x}' }));
  writeText(dir, 'a.da.json', JSON.stringify({ 'a.key': 'A' }));
  writeText(dir, 'a.en.json', JSON.stringify({ 'only.en': 'E' }));
  writeText(dir, 'intake-schema.json', '{}');
  const i18n = loadI18n('da', dir);
  assert.deepEqual(i18n.keys(), ['a.key', 'b.key']);
  assert.equal(i18n.t('b.key', { x: 1 }), 'B 1');
  assert.deepEqual(loadI18n('en', dir).keys(), ['only.en']);
});

test('loadI18n refuses a key defined twice, a missing language and files that are not flat text objects', (t) => {
  const dir = makeTempDir(t);
  writeText(dir, 'a.da.json', JSON.stringify({ same: '1' }));
  writeText(dir, 'b.da.json', JSON.stringify({ same: '2' }));
  assert.throws(() => loadI18n('da', dir), /"same" is defined in both a\.da\.json and b\.da\.json/);
  assert.throws(() => loadI18n('en', dir), /No text files for the language "en"/);
  const other = makeTempDir(t);
  writeText(other, 'n.da.json', JSON.stringify({ nested: { a: 'b' } }));
  assert.throws(() => loadI18n('da', other), /non-text value for "nested"/);
  writeText(other, 'n.da.json', '[]');
  assert.throws(() => loadI18n('da', other), /one flat JSON object/);
  writeText(other, 'n.da.json', '{ broken');
  assert.throws(() => loadI18n('da', other), /Cannot read the text file/);
});

test('loadI18n reads a file with a byte order mark', (t) => {
  const dir = makeTempDir(t);
  fs.writeFileSync(path.join(dir, 'a.da.json'), `\uFEFF${JSON.stringify({ k: 'v' })}`);
  assert.equal(loadI18n('da', dir).t('k'), 'v');
});

test('resolveLanguage: --lang, then the pack, then LC_ALL or LANG starting with da, else English', () => {
  assert.equal(resolveLanguage({ lang: 'en', packLanguage: 'da', env: { LANG: 'da_DK.UTF-8' } }), 'en');
  assert.equal(resolveLanguage({ packLanguage: 'da', env: { LANG: 'en_US.UTF-8' } }), 'da');
  assert.equal(resolveLanguage({ packLanguage: null, env: { LANG: 'da_DK.UTF-8' } }), 'da');
  assert.equal(resolveLanguage({ env: { LC_ALL: 'da_DK.UTF-8', LANG: 'en_US.UTF-8' } }), 'da');
  assert.equal(resolveLanguage({ env: { LC_ALL: 'en_US.UTF-8', LANG: 'da_DK.UTF-8' } }), 'en');
  assert.equal(resolveLanguage({ env: { LANG: 'DA' } }), 'da');
  assert.equal(resolveLanguage({ packLanguage: 'fr', env: { LANG: 'fr_FR.UTF-8' } }), 'en');
  assert.equal(resolveLanguage({ env: {} }), 'en');
  assert.equal(resolveLanguage({}), 'en');
});
