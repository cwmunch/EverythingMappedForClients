// The texts of the form: ui-form.da.json and ui-form.en.json, and the texts of the other files
// that the form shows. Same keys in both languages, plain writing, and every key is used.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { SCHEMA_DIR, embeddedData, extractScript, readFormHtml } from './helpers.mjs';

const read = (lang) => JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, `ui-form.${lang}.json`), 'utf8'));
const da = read('da');
const en = read('en');
const script = extractScript(readFormHtml());
const { dictionaries } = embeddedData();

// The key prefixes of the other text files that the form puts on screen.
// Written as code points so this file has no dash of its own.
const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);

const SHOWN_PREFIXES = ['file.', 'module.', 'q.', 'choice.', 'status.', 'level.', 'depth.', 'area.', 'flag.'];

function placeholders(text) {
  return [...text.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]).sort();
}

test('Danish and English define exactly the same keys, all under ui.form', () => {
  assert.deepEqual(Object.keys(da), Object.keys(en), 'same keys in the same order');
  assert.ok(Object.keys(da).length > 100);
  for (const key of Object.keys(da)) assert.ok(key.startsWith('ui.form.'), key);
  assert.equal(new Set(Object.keys(da)).size, Object.keys(da).length);
});

test('no key of ui-form is defined in another text file', () => {
  for (const lang of ['da', 'en']) {
    for (const name of fs.readdirSync(SCHEMA_DIR).filter((file) => file.endsWith(`.${lang}.json`) && !file.startsWith('ui-form.'))) {
      const other = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, name), 'utf8'));
      for (const key of Object.keys(other)) assert.ok(!key.startsWith('ui.form.'), `${name}: ${key}`);
    }
  }
});

test('every text is plain: not empty, no padding, no em dash, no exclamation mark, no emoji', () => {
  for (const [lang, texts] of [['da', da], ['en', en]]) {
    for (const [key, value] of Object.entries(texts)) {
      const where = `${lang} ${key}`;
      assert.equal(typeof value, 'string', where);
      assert.ok(value.trim().length > 0, `${where}: empty`);
      assert.equal(value, value.trim(), `${where}: spaces at an end`);
      assert.ok(!value.includes(EM_DASH) && !value.includes(EN_DASH), `${where}: dash`);
      assert.ok(!value.includes('!'), `${where}: exclamation mark`);
      assert.ok(!/\p{Extended_Pictographic}/u.test(value), `${where}: emoji`);
      assert.ok(!/\s{2,}|\n/.test(value), `${where}: line break or double space`);
      assert.ok(!/<|>/.test(value), `${where}: markup`);
    }
  }
});

test('the word "gate" is in no text of the form, in either language', () => {
  for (const lang of ['da', 'en']) {
    const texts = Object.entries(dictionaries[lang]).filter(([key]) => key.startsWith('ui.form.') || SHOWN_PREFIXES.some((prefix) => key.startsWith(prefix)));
    assert.ok(texts.length > 500, `only ${texts.length} texts checked`);
    for (const [key, value] of texts) assert.ok(!/gate/i.test(value), `${lang} ${key}: ${value}`);
  }
});

test('a text has the same placeholders in both languages', () => {
  for (const key of Object.keys(da)) assert.deepEqual(placeholders(da[key]), placeholders(en[key]), key);
});

test('every ui.form key the page code asks for exists, and every key in the files is used', () => {
  const literal = new Set([...script.matchAll(/'(ui\.form\.[A-Za-z0-9.]+)'/g)].map((match) => match[1]));
  for (const key of literal) assert.ok(Object.hasOwn(da, key) && Object.hasOwn(en, key), `the code asks for ${key}`);
  const staticKeys = ['ui.form.noscript', 'ui.form.err.start', 'ui.form.title'];
  const unused = Object.keys(da).filter((key) => !literal.has(key) && !staticKeys.includes(key));
  assert.deepEqual(unused, [], 'keys that no code uses');
  assert.ok(script.includes("t(LANGUAGE_KEYS[lang])"), 'language names come through a map of literal keys');
});

test('the texts the code reads by pattern exist for every question, choice, module and level', () => {
  const { schema } = embeddedData();
  for (const lang of ['da', 'en']) {
    for (const level of schema.levels) assert.ok(dictionaries[lang][level === 'gate1' ? 'level.gate1.short' : `level.${level}`], `${lang} level ${level}`);
    for (const depth of Object.keys(schema.depths)) {
      assert.ok(dictionaries[lang][`depth.${depth}`] && dictionaries[lang][`depth.${depth}.desc`], `${lang} depth ${depth}`);
    }
    for (const status of ['complete', 'partial', 'tbd']) assert.ok(dictionaries[lang][`status.${status}`], `${lang} status ${status}`);
  }
});

test('the Danish texts are in Danish and speak to the person as "du", the English texts are not Danish', () => {
  const danishOnly = /\b(?:du|dit|din|dine|ikke|og|er|til|som|vil|kan)\b/i;
  const mostlyDanish = Object.values(da).filter((value) => danishOnly.test(value)).length;
  assert.ok(mostlyDanish > Object.keys(da).length * 0.35, `${mostlyDanish} of ${Object.keys(da).length}`);
  assert.ok(!/\b(?:Dem|Deres)\b/.test(Object.values(da).join(' ')), 'no formal address');
  assert.ok(Object.values(da).some((value) => /\bdu\b/.test(value)) && Object.values(da).some((value) => /\bdit\b|\bdin\b|\bdine\b/.test(value)));
  const leaked = Object.entries(en).filter(([, value]) => /\b(?:ikke|og|dit|din|dine|vil du)\b/i.test(value));
  assert.deepEqual(leaked, []);
  assert.ok(da['ui.form.privacy.text'].startsWith('Intet forlader din computer.'));
  assert.ok(en['ui.form.privacy.text'].startsWith('Nothing leaves your computer.'));
});

test('the privacy notice says what the brief asks for, in both languages', () => {
  assert.match(da['ui.form.privacy.text'], /Intet forlader din computer/);
  assert.match(da['ui.form.privacy.text'], /bygges her/);
  assert.match(da['ui.form.privacy.text'], /gemmes kun i denne browser/);
  assert.match(en['ui.form.privacy.text'], /Nothing leaves your computer/);
  assert.match(en['ui.form.privacy.text'], /built here/);
  assert.match(en['ui.form.privacy.text'], /stored only in this browser/);
  assert.ok(da['ui.form.privacy.clear'] && en['ui.form.privacy.clear']);
});

test('the privacy notice says where the data lives: in the page, in this browser only if kept, never the files, and in the files you save', () => {
  const english = en['ui.form.privacy.text'];
  assert.match(english, /only if you choose to keep them/);
  assert.match(english, /Attached files are never stored in the browser, only their names and descriptions/);
  assert.match(english, /The pack and the form data you save are files on your computer/);
  const danish = da['ui.form.privacy.text'];
  assert.match(danish, /kun hvis du v\u00e6lger at beholde dem/);
  assert.match(danish, /Vedh\u00e6ftede filer gemmes aldrig i browseren, kun deres navne og beskrivelser/);
  assert.match(danish, /Pakken og de formulardata, du gemmer, er filer p\u00e5 din computer/);
  assert.equal(en['ui.form.keep.labelFile'], 'Keep my answers in this browser. Other pages opened from this computer could read them.');
  assert.ok(da['ui.form.keep.labelFile'].includes('Andre sider, der \u00e5bnes fra denne computer, kan l\u00e6se dem'));
});

test('the texts about files are true whether the files fit or not', () => {
  // Saved in the browser: never the files. Saved to a file: the files, unless they are very big.
  assert.match(en['ui.form.files.notSaved'], /not kept in the browser/);
  assert.match(en['ui.form.files.notSaved'], /unless they are very big/);
  assert.match(en['ui.form.save.savedNoFiles'], /never kept in the browser/);
  assert.match(en['ui.form.finish.exportHint'], /If the files are very big, only their names are saved/);
  assert.match(da['ui.form.files.notSaved'], /ikke gemt i browseren/);
  assert.match(da['ui.form.files.notSaved'], /medmindre de er meget store/);
  assert.match(da['ui.form.save.savedNoFiles'], /aldrig gemt i browseren/);
  assert.match(da['ui.form.finish.exportHint'], /Er filerne meget store, bliver kun deres navne gemt/);
  for (const texts of [en, da]) {
    assert.doesNotMatch(texts['ui.form.files.notSaved'], /too large to be kept|for store til at blive gemt/);
  }
});

test('the texts the library needs for the pack files and the findings are in both embedded dictionaries', () => {
  const format = fs.readFileSync(path.join(SCHEMA_DIR, '..', '..', '..', 'docs', 'FORMAT.md'), 'utf8');
  const catalogue = format.slice(format.indexOf('## 14. Flag catalogue'), format.indexOf('## 15.'));
  const flagIds = [...catalogue.matchAll(/^\| `([A-Za-z.]+)` \|/gm)].map((match) => match[1]);
  assert.ok(flagIds.length >= 22);
  const keys = [
    ...flagIds.map((id) => `flag.${id}`),
    'ui.assets.title', 'ui.assets.intro', 'ui.assets.col.file', 'ui.assets.col.what', 'ui.assets.col.owner', 'ui.assets.col.rights', 'ui.assets.col.restrictions',
    'ui.openq.title', 'ui.openq.heading', 'ui.openq.intro', 'ui.openq.col.question', 'ui.openq.col.status', 'ui.openq.col.owner', 'ui.openq.col.due',
    'ui.openq.col.note', 'ui.openq.none', 'ui.openq.flagsHeading', 'ui.openq.noFlags', 'ui.openq.sev.block', 'ui.openq.sev.warn',
    'level.gate1.short', 'level.recommended', 'status.tbd', 'status.missing',
  ];
  for (const lang of ['da', 'en']) {
    for (const key of keys) assert.ok(Object.hasOwn(dictionaries[lang], key) && dictionaries[lang][key] !== '', `${lang} ${key}`);
  }
});
