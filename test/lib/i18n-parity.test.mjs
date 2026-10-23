// Checks the text files in skill/everything-mapped/schema: Danish and English must match key for
// key, and (once the copywriter's texts exist) every part of the schema must have its texts.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadI18n } from '../../skill/everything-mapped/scripts/lib/index.mjs';
import { FLAG_IDS, LIB_DIR, SCHEMA_DIR, SCRIPTS_DIR, readJson, schema } from './helpers.mjs';

const LANGUAGES = ['da', 'en'];
const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;

function textFiles(lang) {
  return fs.readdirSync(SCHEMA_DIR).filter((name) => name.endsWith(`.${lang}.json`)).sort();
}

function stem(name, lang) {
  return name.slice(0, -`.${lang}.json`.length);
}

function keysByFile(lang) {
  return Object.fromEntries(textFiles(lang).map((name) => [stem(name, lang), Object.keys(readJson(path.join(SCHEMA_DIR, name)))]));
}

function dictionary(lang) {
  return Object.assign({}, ...textFiles(lang).map((name) => readJson(path.join(SCHEMA_DIR, name))));
}

test('Danish and English have the same text files', () => {
  assert.deepEqual(textFiles('da').map((name) => stem(name, 'da')), textFiles('en').map((name) => stem(name, 'en')));
  assert.ok(textFiles('da').includes('ui-check.da.json'));
});

test('Danish and English define exactly the same keys, file by file', () => {
  const da = keysByFile('da');
  const en = keysByFile('en');
  for (const name of Object.keys(da)) {
    assert.deepEqual([...da[name]].sort(), [...en[name]].sort(), `the keys of ${name} differ between da and en`);
  }
});

test('no key is defined twice, within a file or across files', () => {
  for (const lang of LANGUAGES) {
    const seen = new Map();
    for (const name of textFiles(lang)) {
      const text = fs.readFileSync(path.join(SCHEMA_DIR, name), 'utf8');
      const keysInOrder = [...text.matchAll(/^\s*"((?:[^"\\]|\\.)+)"\s*:/gm)].map((match) => match[1]);
      for (const key of keysInOrder) {
        assert.ok(!seen.has(key), `${lang}: "${key}" is defined in ${seen.get(key)} and in ${name}`);
        seen.set(key, name);
      }
    }
  }
});

test('loadI18n loads the union of the files for both languages', () => {
  for (const lang of LANGUAGES) {
    const i18n = loadI18n(lang);
    assert.deepEqual([...i18n.keys()].sort(), Object.keys(dictionary(lang)).sort());
    assert.equal(i18n.lang, lang);
  }
});

test('every text is a non-empty string with the same placeholders in both languages', () => {
  const da = dictionary('da');
  const en = dictionary('en');
  for (const key of Object.keys(da)) {
    for (const [lang, value] of [['da', da[key]], ['en', en[key]]]) {
      assert.equal(typeof value, 'string', `${lang} ${key}`);
      assert.ok(value.trim() !== '', `${lang} ${key} is empty`);
    }
    const placeholders = (text) => [...text.matchAll(PLACEHOLDER)].map((match) => match[1]).sort();
    assert.deepEqual(placeholders(da[key]), placeholders(en[key]), `placeholders of ${key}`);
  }
});

test('ui-check has a message for every flag of FORMAT.md section 14 and nothing else of the kind', () => {
  for (const lang of LANGUAGES) {
    const flagKeys = Object.keys(readJson(path.join(SCHEMA_DIR, `ui-check.${lang}.json`))).filter((key) => key.startsWith('flag.'));
    assert.deepEqual(flagKeys.sort(), FLAG_IDS.map((id) => `flag.${id}`).sort(), lang);
  }
});

test('ui-check follows the writing rules: no em dash, no exclamation mark, no emoji, no gate', () => {
  for (const lang of LANGUAGES) {
    for (const [key, value] of Object.entries(readJson(path.join(SCHEMA_DIR, `ui-check.${lang}.json`)))) {
      assert.ok(!value.includes('\u2014') && !value.includes('\u2013'), `${lang} ${key}: dash`);
      assert.ok(!value.includes('!'), `${lang} ${key}: exclamation mark`);
      assert.ok(!/\p{Extended_Pictographic}/u.test(value), `${lang} ${key}: emoji`);
      assert.ok(!/\bgate\b/i.test(value), `${lang} ${key}: the word gate`);
    }
  }
});

// The text keys the code asks for must exist, and the keys of ui-check must all be in use.
const OWN_PREFIXES = ['ui.check.', 'ui.next.', 'ui.answer.', 'ui.assets.', 'ui.openq.', 'ui.nameReason.'];

function sourceFiles() {
  const names = [
    ...fs.readdirSync(SCRIPTS_DIR).filter((name) => ['check.mjs', 'next.mjs', 'answer.mjs', 'assets.mjs'].includes(name)).map((name) => path.join(SCRIPTS_DIR, name)),
    ...fs.readdirSync(LIB_DIR).filter((name) => name.endsWith('.mjs') && name !== 'zip.mjs').map((name) => path.join(LIB_DIR, name)),
  ];
  return names.map((name) => fs.readFileSync(name, 'utf8'));
}

function keysUsedInCode() {
  const used = new Set();
  for (const text of sourceFiles()) {
    for (const match of text.matchAll(/'(ui\.[A-Za-z0-9.]+)'/g)) used.add(match[1]);
  }
  return [...used].filter((key) => OWN_PREFIXES.some((prefix) => key.startsWith(prefix)));
}

test('every text key used in the code is defined in both languages', () => {
  const used = keysUsedInCode();
  assert.ok(used.length > 60);
  for (const lang of LANGUAGES) {
    const defined = dictionary(lang);
    for (const key of used) assert.ok(Object.hasOwn(defined, key), `${lang}: ${key} is used but not defined`);
  }
});

test('every ui-check text is used by the code', () => {
  const used = new Set(keysUsedInCode());
  for (const key of Object.keys(readJson(path.join(SCHEMA_DIR, 'ui-check.da.json')))) {
    if (key.startsWith('flag.')) continue;
    assert.ok(used.has(key), `${key} is defined but not used`);
  }
});

// ---- the texts of the copywriter ------------------------------------------------------------

const TEXTS_PRESENT = ['da', 'en'].map((lang) => fs.existsSync(path.join(SCHEMA_DIR, `texts.${lang}.json`)));
const TEXTS_SKIP = TEXTS_PRESENT.some(Boolean)
  ? false
  : 'texts.da.json and texts.en.json do not exist yet; the rules for the question texts are not checked';

test('texts.da.json and texts.en.json exist together or not at all', () => {
  assert.equal(TEXTS_PRESENT[0], TEXTS_PRESENT[1], 'only one of texts.da.json and texts.en.json exists');
});

function requiredTextKeys() {
  const keys = [];
  for (const file of schema.files) keys.push(`file.${file.id}.title`, `file.${file.id}.intro`);
  for (const entry of schema.modules) {
    keys.push(`module.${entry.id}.title`, `module.${entry.id}.intro`);
    for (const question of entry.questions) {
      keys.push(`q.${question.id}.label`, `q.${question.id}.ask`, `q.${question.id}.help`, `q.${question.id}.example`);
      for (const choice of question.choices ?? []) keys.push(`choice.${question.id}.${choice}`);
    }
  }
  for (const status of Object.keys(schema.statusScores)) keys.push(`status.${status}`);
  for (const level of schema.levels) keys.push(`level.${level}`);
  for (const depth of Object.keys(schema.depths)) keys.push(`depth.${depth}`);
  for (const area of schema.areas) keys.push(`area.${area}`);
  return keys;
}

test('texts: every file, module, question, choice, status, level, depth and area has its texts in both languages', { skip: TEXTS_SKIP }, () => {
  const required = requiredTextKeys();
  assert.ok(required.length > 400);
  for (const lang of LANGUAGES) {
    const defined = dictionary(lang);
    const missing = required.filter((key) => typeof defined[key] !== 'string' || defined[key].trim() === '');
    assert.deepEqual(missing, [], `${lang}: missing texts`);
  }
});

test('texts: da and en define the same keys in the text files', { skip: TEXTS_SKIP }, () => {
  assert.deepEqual(Object.keys(dictionary('da')).sort(), Object.keys(dictionary('en')).sort());
});
