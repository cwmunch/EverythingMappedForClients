// What happens when text, files and saved data are hostile, huge or damaged: nothing is lost without
// a message, nothing breaks the page, and nothing in the pack is something the library would refuse.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';
import { parseFile } from '../../skill/everything-mapped/scripts/lib/index.mjs';
import { isPackFile } from '../../skill/everything-mapped/scripts/lib/util.mjs';
import { unzip } from '../cli/unzip.mjs';
import {
  FakeDocument,
  byTag,
  createBrokenStorage,
  createFakeWindow,
  createMemoryStorage,
  fakeFile,
  findAll,
  readableStrings,
  textOf,
} from './fake-dom.mjs';
import {
  NOW,
  RESPONDENT,
  TODAY,
  blobBytes,
  extractScripts,
  interviewerTree,
  loadBrowserScript,
  plain,
  readFormHtml,
  sampleInputs,
  schema,
  textOfEntry,
  unzipPack,
} from './helpers.mjs';

const { emfc, engine, data } = loadBrowserScript();
const library = emfc.library;
const KEY = data.storageKey;

const char = (code) => String.fromCharCode(code);
// The characters the page must never put into a pack, as a string.
const CONTROLS = `${char(0x0b)}${char(0x0c)}${char(0x85)}${char(0x1b)}${char(0x07)}${char(0)}`;
const SPOOFING = `${char(0x202e)}${char(0x200b)}${char(0xfeff)}`;

function fill(template, params = {}) {
  return template.replace(/\{(\w+)\}/g, (whole, name) => (name in params ? String(params[name]) : whole));
}

function text(lang, key, params) {
  assert.ok(Object.hasOwn(data.dictionaries[lang], key), `missing text ${key}`);
  return fill(data.dictionaries[lang][key], params);
}

async function packOf(state, options = {}) {
  return engine.buildPack(state, { now: NOW, today: TODAY, ...options });
}

function newState(language = 'en') {
  return engine.newState({ language, now: NOW });
}

function openForm(options = {}) {
  const instance = options.emfc ?? emfc;
  const doc = new FakeDocument();
  const root = doc.createElement('div');
  root.setAttribute('id', 'app');
  doc.body.appendChild(root);
  const fake = createFakeWindow(options);
  const app = instance.startForm(doc, fake.win, options.data ?? data);
  return { app, doc, root, fake };
}

function typeInto(field, value) {
  field.value = value;
  field.fire('input');
}

function inputsOf(root, type) {
  return findAll(root, (element) => element.localName === 'input' && element.getAttribute('type') === type);
}

function part(page, id) {
  return page.app.parts.get(id);
}

async function until(condition, what) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function longestLine(content) {
  return Math.max(...content.split('\n').map((line) => line.length));
}

// ---------------------------------------------------------------------------------------------
// Text that cannot be saved is cleaned, and what is cut is said

test('lines are one line, names lose what the library refuses, blocks keep their line breaks', () => {
  assert.equal(library.cleanLine(`a${CONTROLS}b\r\nc\td${char(0x2028)}e`, 100), 'ab c d e');
  assert.equal(library.cleanName(`Anna${char(0x202e)}${char(0x200b)}${char(0xad)}${char(0xfeff)} Jensen${String.fromCodePoint(0xe0041)}`, 100), `Anna${char(0xad)} Jensen`, 'the soft hyphen is text and stays');
  assert.equal(library.cleanBlock(`one${CONTROLS}\r\ntwo${char(0x2029)}three\n${char(0x202e)}four`, 100), 'one\ntwo\nthree\nfour');
  assert.equal(library.cleanBlock(`a${char(0xd800)}b${char(0xdc00)}c😀`, 100), 'abc😀', 'lone surrogates go, a whole pair stays');
  assert.equal(library.cleanLine(123, 10), '');
  assert.equal(library.cleanLine('x'.repeat(50), 10).length, 10);
  assert.equal(library.cleanLine(`${'x'.repeat(9)}😀`, 10), 'x'.repeat(9), 'a pair is never cut in two');
});

test('long lines in a text are broken so that no line of a pack file gets near the limit', () => {
  const word = 'ord ';
  const wrapped = library.cleanBlock(word.repeat(5000), 50000);
  assert.ok(longestLine(wrapped) <= library.WRAP_WIDTH);
  assert.equal(wrapped.replace(/\n/g, ' ').trim(), word.repeat(5000).trim().replace(/ +$/, ''), 'nothing is lost but the break');
  const solid = library.cleanBlock('x'.repeat(30000), 50000);
  assert.ok(longestLine(solid) <= library.WRAP_WIDTH);
  assert.equal(solid.replace(/\n/g, ''), 'x'.repeat(30000));
  assert.equal(library.cleanBlock('😀'.repeat(5000), 50000).replace(/\n/g, ''), '😀'.repeat(5000), 'no emoji is cut in two');
});

test('an answer with characters the library refuses is kept without them', async () => {
  const state = newState();
  engine.record(state, 'A.business').text = `Nordlys Cykler${CONTROLS} sælger cykler${char(0x202e)} i Aarhus.`;
  engine.record(state, 'A.metrics').items = [{ text: `Leads${CONTROLS}`, note: 'now' }];
  Object.assign(engine.record(state, 'I.domain'), { unknown: true, owner: 'other', ownerName: `Peter${CONTROLS} Holm`, tbdNote: `Ask${CONTROLS} IT` });
  const analysis = engine.analyze(state, { now: NOW });
  assert.equal(analysis.problems.length, 0);
  assert.equal(analysis.report.questions['A.business'].status, 'partial', 'short, but kept');
  const entries = unzipPack((await packOf(state)).bytes);
  const brief = textOfEntry(entries, 'docs/00-brief.md');
  assert.ok(brief.includes('Nordlys Cykler sælger cykler i Aarhus.'));
  assert.ok(brief.includes('- Leads\n'), 'a plain list keeps no note');
  assert.ok(textOfEntry(entries, 'docs/05-technical-and-compliance.md').includes('owner:Peter-Holm'));
  for (const content of entries.values()) assert.ok(!new RegExp(`[${CONTROLS}${char(0x202e)}]`).test(content.toString('utf8')));
});

test('a line of 20 001 characters, and a text of 100 000 characters, are not dropped from the pack', async () => {
  const state = newState();
  engine.record(state, 'A.business').text = `${'a'.repeat(20001)} end`;
  engine.record(state, 'A.goal').text = 'word '.repeat(20000);
  const analysis = engine.analyze(state, { now: NOW });
  assert.equal(analysis.problems.length, 0);
  assert.equal(analysis.report.questions['A.business'].status, 'complete');
  const brief = textOfEntry(unzipPack((await packOf(state)).bytes), 'docs/00-brief.md');
  assert.ok(brief.includes('q:A.business status:complete'));
  assert.ok(longestLine(brief) < 20000);
  assert.ok(brief.length < 204800 * 2);
  const goal = analysis.entries['A.goal'].body;
  assert.ok(goal.length <= library.LIMITS.block.max + 100, 'the text is cut at its limit (and a note said so, see below)');
});

test('every field that is too long is cut, and the question says so', () => {
  const state = newState();
  const hint = (id) => plain(engine.hints(engine.byId.get(id), state, engine.analyze(state, { now: NOW }).report));
  engine.record(state, 'A.business').text = 'x'.repeat(library.LIMITS.block.max + 5000);
  assert.deepEqual(hint('A.business').filter((item) => item.key === 'ui.form.hint.atLimit'), [{ key: 'ui.form.hint.atLimit', params: { max: library.LIMITS.block.max } }]);
  engine.record(state, 'A.budget').text = 'y'.repeat(library.LIMITS.line.max);
  assert.equal(hint('A.budget')[0].key, 'ui.form.hint.atLimit');
  engine.record(state, 'A.metrics').items = [{ text: 'z'.repeat(library.LIMITS.item.max), note: '' }];
  assert.equal(hint('A.metrics')[0].params.max, library.LIMITS.item.max);
  engine.record(state, 'I.domain').tbdNote = 'n'.repeat(library.LIMITS.note.max);
  engine.record(state, 'I.domain').unknown = true;
  assert.equal(hint('I.domain')[0].params.max, library.LIMITS.note.max, 'also while the question is marked as unknown');
  engine.record(state, 'A.deadline').note = 'short';
  assert.deepEqual(hint('A.deadline'), [{ key: 'ui.form.hint.noteLost', params: {} }], 'a note without a date is said to be left out');
  engine.record(state, 'A.deadline').date = '2026-12-01';
  assert.deepEqual(hint('A.deadline'), []);
});

test('nothing in the respondent, the owner or the files can make a line of a pack file too long', async () => {
  const state = newState();
  state.respondent = { name: 'N'.repeat(30000), role: 'R'.repeat(30000) };
  state.recipient = 'X'.repeat(30000);
  engine.record(state, 'A.goal').text = 'En tekst om målet med hjemmesiden, der er lang nok.';
  Object.assign(engine.record(state, 'I.domain'), { unknown: true, owner: 'other', ownerName: 'O'.repeat(30000), tbdNote: 'n'.repeat(30000) });
  const asset = engine.addAsset(state, 'B.logo', { name: 'a.png', data: new Uint8Array(3) });
  Object.assign(asset, { what: 'w'.repeat(30000), owner: 'o'.repeat(30000), rights: 'r'.repeat(30000), restrictions: 'x'.repeat(30000) });
  engine.record(state, 'A.existing-site').items = [{ text: '<a'.repeat(30000), note: '|'.repeat(30000) }];
  engine.record(state, 'A.project-kind').choice = ['redesign'];
  const pack = await packOf(state);
  const entries = unzipPack(pack.bytes);
  for (const [name, content] of entries) {
    if (name.startsWith('docs/assets/')) continue;
    const body = content.toString('utf8');
    assert.ok(longestLine(body) < 20000, `${name}: longest line ${longestLine(body)}`);
    if (name.endsWith('.md') && name !== 'docs/assets.md' && name !== 'docs/07-risks-and-open-questions.md') {
      assert.doesNotThrow(() => parseFile(body, schema), name);
    }
  }
  const manifest = JSON.parse(textOfEntry(entries, 'docs/intake-manifest.json'));
  assert.ok(manifest.respondents[0].name.length <= library.LIMITS.person.max);
  assert.ok(JSON.parse(textOfEntry(entries, 'docs/intake-state.json')).recipient.length <= library.LIMITS.recipient.max);
});

test('the respondent is cleaned, written like the interviewer writes it, and read back from the manifest', async (t) => {
  const state = newState('da');
  state.respondent = { name: `Anna & Bo <b>Jensen${CONTROLS}${char(0x202e)}`, role: 'R&D; leder' };
  engine.record(state, 'A.goal').text = 'At få flere henvendelser fra private kunder, så vi kan fylde kalenderen.';
  const entries = unzipPack((await packOf(state)).bytes);
  const brief = textOfEntry(entries, 'docs/00-brief.md');
  assert.ok(brief.includes('respondent: "Anna &amp; Bo &lt;b>Jensen, R&amp;D, leder"'), brief.split('\n')[4]);
  assert.ok(!/&(?!amp;|lt;)/.test(brief.split('\n')[4]), 'no raw ampersand in the respondent line');
  const manifest = JSON.parse(textOfEntry(entries, 'docs/intake-manifest.json'));
  assert.deepEqual(manifest.respondents.map(({ name, role }) => ({ name, role })), [{ name: 'Anna & Bo <b>Jensen', role: 'R&D, leder' }]);

  const expected = interviewerTree(t, [{ id: 'A.goal', status: 'complete', text: 'At få flere henvendelser fra private kunder, så vi kan fylde kalenderen.' }], {
    language: 'da',
    depth: 'standard',
    respondent: { name: 'Anna & Bo <b>Jensen', role: 'R&D; leder' },
  });
  assert.equal(textOfEntry(entries, 'docs/00-brief.md'), expected.get('docs/00-brief.md').toString('utf8'), 'the same line as the interviewer');
  assert.deepEqual(JSON.parse(expected.get('docs/intake-manifest.json')).respondents.map(({ name, role }) => ({ name, role })), manifest.respondents.map(({ name, role }) => ({ name, role })));
});

// ---------------------------------------------------------------------------------------------
// Names of attached files

test('file names lose paths, hidden and temporary names, invisible and direction characters, and device names', () => {
  const taken = new Set();
  const safe = (name) => {
    const result = library.safeAssetName(name, taken);
    taken.add(result.toLowerCase());
    return result;
  };
  assert.equal(safe(`invoice${char(0x202e)}fdp.exe`), 'invoicefdp.exe');
  assert.equal(safe(`a${char(0x200b)}b${char(0x200d)}c${char(0xfeff)}.txt`), 'abc.txt');
  assert.equal(safe(`x${char(0x85)}y${char(0x9f)}.txt`), 'xy.txt');
  assert.equal(safe('COM\u00b9.txt'), '_COM\u00b9.txt');
  assert.equal(safe('LPT\u00b3'), '_LPT\u00b3');
  assert.equal(safe('com\u00b2.png'), '_com\u00b2.png');
  assert.equal(safe('CONIN$'), '_CONIN$');
  assert.equal(safe('conout$.txt'), '_conout$.txt');
  assert.equal(safe('NUL.png'), '_NUL.png');
  assert.equal(safe('.env'), 'env');
  assert.equal(safe('.hidden/.deeper/.file.txt'), 'file.txt');
  assert.equal(safe('report.tmp'), 'report-tmp');
  assert.equal(safe('Doc.TMP'), 'Doc-tmp');
  assert.equal(safe('C:\\Users\\x\\..\\..\\secret.txt'), 'secret.txt');
  assert.equal(safe('a'.repeat(300)).length, 100);
  for (const name of taken) assert.ok(isPackFile(`docs/assets/${name}`), name);
});

test('a file name is cut by characters and bytes, never in the middle of an emoji, and two cut names stay different', () => {
  const taken = new Set();
  const cut = library.safeAssetName(`${'😀'.repeat(150)}.png`, taken);
  assert.ok(cut.isWellFormed());
  assert.ok(Array.from(cut).length <= 100);
  assert.ok(library.encodeUtf8(cut).length <= 200);
  assert.ok(cut.endsWith('.png'));
  taken.add(cut.toLowerCase());
  const again = library.safeAssetName(`${'😀'.repeat(150)}.png`, taken);
  assert.notEqual(again, cut);
  assert.ok(again.isWellFormed() && again.endsWith('.png'));

  const lone = new Set();
  const first = library.safeAssetName(`x${char(0xd800)}`, lone);
  lone.add(first.toLowerCase());
  const second = library.safeAssetName(`x${char(0xdc00)}`, lone);
  assert.deepEqual([first, second], ['x', 'x-2'], 'two names that differ only in a lone surrogate become two names');
  assert.ok(first.isWellFormed() && second.isWellFormed());
});

test('the zip refuses names with direction, control or broken-text characters', async () => {
  for (const bad of [`docs/a${char(0x202e)}b`, `docs/a${char(0x85)}b`, `docs/a${char(0x200b)}b`, `docs/a${char(0xd800)}`, `docs/a${char(0xdc00)}`, `docs/a${char(0x2028)}b`]) {
    await assert.rejects(() => library.createZipBytes([{ name: bad, data: 'x' }]), /Invalid zip entry name/, JSON.stringify(bad));
  }
  const names = new Set(['docs/ok.txt', 'docs/Ærø.txt']);
  const bytes = await library.createZipBytes([...names].map((name) => ({ name, data: 'x' })));
  assert.deepEqual([...unzip(Buffer.from(bytes)).keys()].sort(), [...names].sort());
});

test('a B.logo answer with a strange file name is kept, with the name cleaned', async () => {
  const state = newState();
  engine.record(state, 'A.goal').text = 'Et mål';
  const asset = engine.addAsset(state, 'B.logo', { name: `logo${char(0x85)}${char(0x202e)}gnp.exe`, data: new Uint8Array([1, 2, 3]) });
  asset.rights = 'Ejes af os';
  assert.equal(asset.name, 'logognp.exe');
  assert.equal(asset.renamedFrom, 'logo<U+0085><U+202E>gnp.exe', 'the name as given, with the hidden characters made visible');
  const analysis = engine.analyze(state, { now: NOW });
  assert.equal(analysis.problems.length, 0);
  assert.equal(analysis.report.questions['B.logo'].status, 'complete');
  const entries = unzipPack((await packOf(state)).bytes);
  assert.ok(entries.has('docs/assets/logognp.exe'));
  assert.ok(textOfEntry(entries, 'docs/assets.md').includes('| assets/logognp.exe |'));
  assert.ok(!analysis.report.flags.some((flag) => flag.id === 'assets.unlisted' || flag.id === 'assets.missingFile'));
});

// ---------------------------------------------------------------------------------------------
// Only what is in scope goes into the pack

function scopedState() {
  const state = newState();
  state.depth = 'full';
  engine.record(state, 'A.goal').text = 'At få flere henvendelser fra private kunder, så vi kan fylde kalenderen to måneder frem.';
  engine.record(state, 'A.failure').text = 'Hvis ingen kan finde os.';
  engine.record(state, 'A.budget').text = '150.000 kr.';
  engine.addAsset(state, 'B.logo', { name: 'payroll.xlsx', data: new Uint8Array([1, 2, 3]) }).rights = 'unknown';
  return state;
}

test('answers and files of questions outside the chosen depth stay out of the pack and are counted', async () => {
  const state = scopedState();
  let pack = await packOf(state);
  assert.deepEqual(plain(pack.leftOut), { answers: 0, files: 0 });
  let entries = unzipPack(pack.bytes);
  assert.ok(textOfEntry(entries, 'docs/00-brief.md').includes('Hvis ingen kan finde os.'));
  assert.ok(entries.has('docs/assets/payroll.xlsx'));

  state.depth = 'essentials';
  pack = await packOf(state);
  assert.deepEqual(plain(pack.leftOut), { answers: 3, files: 1 }, 'A.failure, A.budget and B.logo; one file');
  entries = unzipPack(pack.bytes);
  const brief = textOfEntry(entries, 'docs/00-brief.md');
  assert.ok(!brief.includes('Hvis ingen kan finde os.') && !brief.includes('150.000 kr.'));
  assert.ok(brief.includes('q:A.failure status:missing'), 'written as not answered, like any question');
  assert.ok(!entries.has('docs/assets/payroll.xlsx'));
  assert.ok(![...entries.values()].some((content) => content.toString('utf8').includes('payroll')), 'the file is not named anywhere');
  const manifest = JSON.parse(textOfEntry(entries, 'docs/intake-manifest.json'));
  assert.ok(!manifest.files.some((file) => file.path.includes('payroll')));
  assert.ok(brief.includes('q:A.goal status:complete'));

  state.depth = 'full';
  entries = unzipPack((await packOf(state)).bytes);
  assert.ok(textOfEntry(entries, 'docs/00-brief.md').includes('Hvis ingen kan finde os.'), 'switching back brings the answers back');
  assert.ok(entries.has('docs/assets/payroll.xlsx'));
});

test('an answer to a question that another answer switches off is left out and counted', async () => {
  const state = newState();
  state.depth = 'full';
  engine.record(state, 'A.goal').text = 'At få flere henvendelser fra private kunder, så vi kan fylde kalenderen.';
  engine.record(state, 'A.project-kind').choice = ['landing-page'];
  engine.record(state, 'A.existing-site').items = [{ text: 'https://example.com', note: '' }];
  const pack = await packOf(state);
  assert.deepEqual(plain(pack.leftOut), { answers: 1, files: 0 });
  assert.ok(![...unzipPack(pack.bytes).values()].some((content) => content.toString('utf8').includes('example.com')));
  engine.record(state, 'A.project-kind').choice = ['redesign'];
  assert.deepEqual(plain((await packOf(state)).leftOut), { answers: 0, files: 0 });
});

test('the review step says how many answers and files are left out, and that a fuller level brings them back', () => {
  for (const lang of ['da', 'en']) {
    const page = openForm({ language: lang });
    const choose = (depth) => {
      const radio = inputsOf(page.root, 'radio').find((input) => input.getAttribute('name') === 'depth' && input.value === depth);
      radio.checked = true;
      radio.fire('change');
    };
    choose('full');
    typeInto(part(page, 'A.failure').focus(), 'Hvis ingen kan finde os.');
    const logo = inputsOf(part(page, 'B.logo').root, 'file')[0];
    page.app.engine.addAsset(page.app.state, 'B.logo', { name: 'payroll.xlsx', data: new Uint8Array(2) });
    choose('essentials');
    page.app.navItems.get('finish').button.click();
    const note = page.app.refs.finish.leftOut;
    assert.equal(note.hidden, false);
    assert.equal(note.textContent, text(lang, 'ui.form.finish.leftOut', { answers: 2, files: 1 }));
    assert.match(note.textContent, lang === 'da' ? /fuldere niveau/ : /fuller level/);
    assert.ok(logo);
    choose('full');
    assert.equal(page.app.refs.finish.leftOut.hidden, true);
    assert.equal(page.app.refs.finish.leftOut.textContent, '');
  }
});

// ---------------------------------------------------------------------------------------------
// Answers that cannot be kept are shown, and the download waits

function libraryWithLimit(limit) {
  const original = readFormHtml();
  const scripts = extractScripts(original);
  const main = scripts[scripts.length - 1];
  assert.ok(main.includes('const MAX_LINE_CHARS = 20000;'));
  const html = original.replace(main, main.replace('const MAX_LINE_CHARS = 20000;', `const MAX_LINE_CHARS = ${limit};`));
  return loadBrowserScript({ html });
}

test('an answer the library would drop is shown on its question and in the review, and blocks the download', async () => {
  const strict = libraryWithLimit(300);
  for (const lang of ['da', 'en']) {
    const page = openForm({ language: lang, emfc: strict.emfc, data: strict.data });
    typeInto(part(page, 'A.business').focus(), 'a'.repeat(350));
    typeInto(part(page, 'A.goal').focus(), 'Et mål, der er langt nok til at være et rigtigt svar på spørgsmålet.');
    page.app.flush();
    assert.equal(page.app.analysis.problems.length, 1);
    const hint = part(page, 'A.business').hint;
    assert.equal(hint.hidden, false);
    assert.equal(hint.className, 'hint warn');
    assert.ok(hint.textContent.startsWith(text(lang, 'ui.form.hint.dropped', { reason: '' })));
    assert.ok(hint.textContent.includes(text(lang, 'ui.form.problem.tooLong')));
    assert.equal(part(page, 'A.business').status.textContent, '', 'it is not an answer in the pack');
    page.app.navItems.get('finish').button.click();
    const checks = textOf(page.app.refs.finish.checksList);
    assert.ok(checks.includes(text(lang, 'ui.form.finish.problemLine', { label: text(lang, 'q.A.business.label'), reason: text(lang, 'ui.form.problem.tooLong') })));
    page.app.refs.finish.download.click();
    await until(() => page.app.refs.finish.notices.alert.textContent !== '', 'the message');
    assert.equal(page.app.refs.finish.notices.alert.textContent, text(lang, 'ui.form.err.dropped', { count: 1, questions: text(lang, 'q.A.business.label') }));
    assert.equal(page.doc.downloads.length, 0);
    typeInto(part(page, 'A.business').focus(), 'Kort nok.');
    page.app.flush();
    assert.equal(page.app.analysis.problems.length, 0);
    page.app.refs.finish.download.click();
    await until(() => page.doc.downloads.length === 1, 'the download once the answer is fixed');
  }
});

test('an answer file over 2 MB is refused with the name of the file', async () => {
  const original = readFormHtml();
  const main = extractScripts(original).at(-1);
  assert.ok(main.includes('const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;'));
  const small = loadBrowserScript({ html: original.replace(main, main.replace('const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;', 'const MAX_TEXT_FILE_BYTES = 3000;')) });
  const state = small.engine.newState({ language: 'en', now: NOW });
  small.engine.record(state, 'A.business').text = 'word '.repeat(1000);
  await assert.rejects(
    () => small.engine.buildPack(state, { now: NOW, today: TODAY }),
    (error) => error.key === 'ui.form.err.fileTooLarge' && error.params.file === 'docs/00-brief.md' && error.params.limit === '2 MB',
  );
});

// ---------------------------------------------------------------------------------------------
// The page when saved data or a loaded file is wrong

function hugeCells(extra = {}, language = 'en') {
  const base = engine.serializeState(newState(language));
  return JSON.parse(JSON.stringify({ ...base, ...extra }));
}

test('a loaded file with 7 000 characters in each file field loads, with the cells cut, and says so', async () => {
  const saved = hugeCells({
    respondent: { name: 'N'.repeat(7000), role: 'R'.repeat(7000) },
    answers: { 'A.goal': { text: 'Et mål, der er langt nok til at være et rigtigt svar på spørgsmålet.' } },
    assets: [{ qid: 'B.logo', name: 'a.png', what: 'w'.repeat(7000), owner: 'o'.repeat(7000), rights: 'r'.repeat(7000), restrictions: 's'.repeat(7000), data: 'AQID' }],
  });
  const page = openForm({ language: 'en' });
  await page.app.importFile(fakeFile('saved.json', JSON.stringify(saved)));
  assert.equal(page.app.refs.top.alert.textContent, '');
  assert.ok(page.app.refs.top.status.textContent.startsWith(text('en', 'ui.form.import.done')));
  assert.ok(page.app.refs.top.status.textContent.includes(text('en', 'ui.form.import.cleaned', { count: 6 })));
  assert.equal(page.app.state.assets[0].what.length, library.LIMITS.asset.max);
  assert.equal(page.app.state.respondent.name.length, library.LIMITS.person.max);
  page.app.navItems.get('finish').button.click();
  page.app.refs.finish.download.click();
  await until(() => page.doc.downloads.length === 1, 'the download');
  assert.equal(page.app.refs.finish.notices.alert.textContent, '');
  assert.ok(!readableStrings(page.root).join('\n').match(/ui\.check\.err|ui\.form\./));
});

test('a loaded file that is damaged changes nothing and says why', async () => {
  const page = openForm({ language: 'da' });
  typeInto(part(page, 'A.budget').focus(), '150.000 kr.');
  page.app.flush();
  const before = JSON.stringify(plain(page.app.state));
  const stateObject = page.app.state;
  const damaged = [
    JSON.stringify({ ...hugeCells({}, 'da'), answers: { 'A.goal': 'oops' } }),
    JSON.stringify({ ...hugeCells({}, 'da'), assets: [{ qid: 'B.logo', name: 'a.png', data: '@@@@' }] }),
    JSON.stringify({ ...hugeCells({}, 'da'), respondent: [] }),
  ];
  for (const content of damaged) {
    await page.app.importFile(fakeFile('saved.json', content));
    assert.equal(page.app.refs.top.alert.textContent, text('da', 'ui.form.err.importInvalid'));
    assert.equal(page.app.state, stateObject, 'the very same state');
    assert.equal(JSON.stringify(plain(page.app.state)), before);
    assert.equal(part(page, 'A.budget').focus().value, '150.000 kr.');
  }
  await page.app.importFile(fakeFile('saved.json', 'not json'));
  assert.equal(page.app.refs.top.alert.textContent, text('da', 'ui.form.err.importRead'));
  await page.app.importFile({ name: 'big.json', size: 401 * 1024 * 1024, text: async () => assert.fail('a file that big must not be read') });
  assert.equal(page.app.refs.top.alert.textContent, text('da', 'ui.form.err.importTooLarge'));
  assert.equal(page.app.state, stateObject);
});

test('typing or pasting too much into any field cuts it at the limit, and nothing breaks', async () => {
  const page = openForm({ language: 'en' });
  const huge = 'x'.repeat(20001);
  const enormous = 'x'.repeat(60001);
  const name = inputsOf(page.root, 'text').find((input) => input.id === 'respondent-name');
  assert.equal(name.getAttribute('maxlength'), String(library.LIMITS.person.max));
  typeInto(name, huge);
  assert.equal(page.app.state.respondent.name.length, library.LIMITS.person.max);
  assert.equal(name.value.length, library.LIMITS.person.max, 'the field shows what is kept');
  typeInto(inputsOf(page.root, 'text').find((input) => input.id === 'respondent-role'), huge);
  typeInto(inputsOf(page.root, 'text').find((input) => input.id === 'recipient'), huge);
  assert.ok(page.root.children.some((element) => textOf(element).includes(text('en', 'ui.form.hint.atLimit', { max: library.LIMITS.person.max }))));
  typeInto(part(page, 'A.goal').focus(), 'Et mål, der er langt nok til at være et rigtigt svar på spørgsmålet.');
  typeInto(part(page, 'A.business').focus(), enormous);
  assert.equal(page.app.state.answers['A.business'].text.length, library.LIMITS.block.max);
  const domain = part(page, 'I.domain');
  domain.toggle.checked = true;
  domain.toggle.fire('change');
  const owners = inputsOf(domain.tbd, 'radio');
  owners[2].checked = true;
  owners[2].fire('change');
  typeInto(domain.ownerName, huge);
  assert.equal(page.app.state.answers['I.domain'].ownerName.length, library.LIMITS.owner.max);
  typeInto(byTag(domain.tbd, 'textarea')[0], huge);
  const logo = inputsOf(part(page, 'B.logo').root, 'file')[0];
  logo.files = [fakeFile('logo.svg', '<svg/>')];
  logo.fire('change');
  await until(() => page.app.state.assets.length === 1, 'the file');
  const card = findAll(part(page, 'B.logo').root, (element) => element.className === 'asset')[0];
  for (const field of byTag(card, 'input')) typeInto(field, huge);
  assert.equal(page.app.state.assets[0].what.length, library.LIMITS.asset.max);
  assert.ok(textOf(card).includes(text('en', 'ui.form.hint.atLimit', { max: library.LIMITS.asset.max })));
  page.app.flush();
  assert.equal(page.app.refs.top.alert.textContent, '');
  assert.ok(part(page, 'A.business').hint.textContent.includes(text('en', 'ui.form.hint.atLimit', { max: library.LIMITS.block.max })));
  page.app.navItems.get('finish').button.click();
  page.app.refs.finish.download.click();
  await until(() => page.doc.downloads.length === 1, 'the download');
  assert.equal(page.app.refs.finish.notices.alert.textContent, '');
  assert.ok(!/ui\.check\.err|lineTooLong/.test(readableStrings(page.root).join('\n')));
});

test('saved data that cannot be used is put aside, the form starts empty, and the data can be downloaded', () => {
  const unreadable = [
    'not json at all',
    JSON.stringify({ format: library.FORM_FORMAT, answers: 'oops' }),
    JSON.stringify({ format: library.FORM_FORMAT, assets: [{ qid: 'B.logo', name: 'a', data: '@@@@' }] }),
    JSON.stringify({ format: 'something-else' }),
  ];
  for (const content of unreadable) {
    const storage = createMemoryStorage();
    storage.setItem(KEY, content);
    const page = openForm({ language: 'da', storage });
    assert.equal(page.app.state.answers['A.goal'], undefined);
    assert.equal(page.app.state.language, 'da');
    assert.equal(storage.getItem(KEY), null, 'the unreadable data is out of the way');
    assert.equal(storage.getItem(`${KEY}.broken`), content, 'and a copy is kept');
    assert.equal(page.app.refs.top.alert.textContent, text('da', 'ui.form.save.broken'));
    const button = findAll(page.root, (element) => element.localName === 'button' && element.textContent === text('da', 'ui.form.privacy.downloadBroken'))[0];
    button.click();
    assert.equal(blobBytes(page.fake.blobs.get(page.doc.downloads[0].href)).toString('utf8'), content);
    assert.match(page.doc.downloads[0].name, /^everything-mapped-form-unreadable-\d{4}-\d{2}-\d{2}\.txt$/);

    const again = openForm({ language: 'da', storage });
    assert.equal(again.app.refs.top.alert.textContent, '', 'the next visit does not repeat it');
    assert.ok(findAll(again.root, (element) => element.textContent === text('da', 'ui.form.privacy.downloadBroken')).length > 0, 'but the copy can still be downloaded');

    again.app.clearSaved();
    assert.equal(storage.getItem(`${KEY}.broken`), null);
    assert.equal(findAll(again.root, (element) => element.textContent === text('da', 'ui.form.privacy.downloadBroken')).length, 0);
  }
});

test('saved data with huge cells is cleaned on load and the page works', () => {
  const storage = createMemoryStorage();
  const saved = hugeCells({
    answers: { 'A.goal': { text: `${'g'.repeat(90000)}` } },
    assets: [{ qid: 'B.logo', name: 'a.png', what: 'w'.repeat(7000), rights: 'r'.repeat(7000), data: 'AQID' }],
  });
  storage.setItem(KEY, JSON.stringify(saved));
  const page = openForm({ language: 'en', storage });
  assert.equal(page.app.state.answers['A.goal'].text.length, library.LIMITS.block.max);
  assert.ok(page.app.refs.top.status.textContent.includes(text('en', 'ui.form.save.restored')));
  assert.ok(page.app.refs.top.status.textContent.includes(text('en', 'ui.form.import.cleaned', { count: 3 })));
  assert.equal(page.app.refs.top.alert.textContent, '');
});

test('the saved data lives under a key named after the schema version, and data under other keys is not read or written over', () => {
  assert.equal(KEY, `emfc.${schema.schema}.form`);
  const storage = createMemoryStorage();
  storage.setItem('emfc.form.v1', JSON.stringify(hugeCells({ answers: { 'A.budget': { text: 'old' } } })));
  storage.setItem(`${KEY}.other`, 'x');
  const page = openForm({ language: 'en', storage });
  assert.equal(page.app.state.answers['A.budget'], undefined);
  typeInto(part(page, 'A.budget').focus(), '10');
  page.fake.runTimers();
  assert.ok(storage.getItem(KEY));
  assert.equal(JSON.parse(storage.getItem(KEY)).answers['A.budget'].text, '10');
  assert.equal(JSON.parse(storage.getItem('emfc.form.v1')).answers['A.budget'].text, 'old', 'saving leaves other keys alone; only clearing and removing take the key of an earlier version away (see hardening.test.mjs)');
});

test('when the page cannot be refreshed it says so, and the way out is still on the page', () => {
  const page = openForm({ language: 'en' });
  page.app.engine.analyze = () => {
    throw new Error('boom');
  };
  const silent = console.error;
  console.error = () => {};
  try {
    typeInto(part(page, 'A.budget').focus(), '10');
    page.app.flush();
  } finally {
    console.error = silent;
  }
  assert.equal(page.app.refs.top.alert.textContent, text('en', 'ui.form.err.refresh'));
  assert.ok(findAll(page.root, (element) => element.localName === 'button' && element.textContent === text('en', 'ui.form.privacy.clear')).length > 0);
  assert.ok(findAll(page.root, (element) => element.localName === 'button' && element.textContent === text('en', 'ui.form.finish.export')).length > 0);
});

test('an error from the library is never shown as its key', async () => {
  const page = openForm({ language: 'en' });
  typeInto(part(page, 'A.budget').focus(), '10');
  page.app.flush();
  const silent = console.error;
  console.error = () => {};
  try {
    page.app.engine.buildPack = async () => {
      const error = new Error('ui.check.err.lineTooLong');
      error.key = 'ui.check.err.lineTooLong';
      throw error;
    };
    page.app.navItems.get('finish').button.click();
    page.app.refs.finish.download.click();
    await until(() => page.app.refs.finish.notices.alert.textContent !== '', 'the message');
  } finally {
    console.error = silent;
  }
  assert.equal(page.app.refs.finish.notices.alert.textContent, text('en', 'ui.form.err.build'));
  assert.ok(!readableStrings(page.root).join('\n').includes('lineTooLong'));
  assert.equal(page.app.t('ui.form.nothing.like.this'), text('en', 'ui.form.err.unexpected'), 'a missing text is replaced, not shown as a key');
});

test('the button that clears saved data works even when the form cannot start', () => {
  const html = readFormHtml();
  const rescue = extractScripts(html)[0];
  const doc = new FakeDocument();
  const config = doc.createElement('script');
  config.setAttribute('id', 'emfc-config');
  config.textContent = JSON.stringify({ storageKey: KEY });
  const failed = doc.createElement('div');
  failed.setAttribute('id', 'emfc-failed');
  failed.hidden = true;
  const button = doc.createElement('button');
  button.className = 'btn emfc-discard';
  failed.appendChild(button);
  doc.body.appendChild(config);
  doc.body.appendChild(failed);
  const storage = createMemoryStorage();
  storage.setItem(KEY, 'broken');
  storage.setItem(`${KEY}.broken`, 'older');
  storage.setItem('emfc.form.v1', 'an earlier version');
  storage.setItem('something-else', 'kept');
  const fake = createFakeWindow({ storage });
  fake.win.document = doc;
  vm.runInNewContext(rescue, { document: doc, window: fake.win });
  fake.fire('load');
  assert.equal(failed.hidden, false, 'no form started, so the message is shown');
  button.click();
  assert.equal(storage.getItem(KEY), null);
  assert.equal(storage.getItem(`${KEY}.broken`), null);
  assert.equal(storage.getItem('emfc.form.v1'), null, 'the key of an earlier version goes too');
  assert.equal(storage.getItem('something-else'), 'kept');
  assert.equal(fake.win.reloads, 1);

  failed.hidden = true;
  fake.win.__emfc = { app: {} };
  fake.fire('load');
  assert.equal(failed.hidden, true, 'a form that started leaves the message hidden');

  const noStorage = createFakeWindow({ storage: createBrokenStorage() });
  const spare = new FakeDocument();
  vm.runInNewContext(rescue, { document: spare, window: noStorage.win });
  assert.doesNotThrow(() => noStorage.fire('load'));
});

// ---------------------------------------------------------------------------------------------
// Attached files: names shown, sizes refused, memory kept low

test('a file that is renamed is shown with the name it got and why; a file that is too big is not read', async () => {
  const page = openForm({ language: 'en' });
  const input = inputsOf(part(page, 'B.logo').root, 'file')[0];
  const big = { name: 'huge.mov', size: 499 * 1024 * 1024, arrayBuffer: async () => assert.fail('a file that big must not be read') };
  input.files = [fakeFile('../..//.secret.TMP', 'abc'), big, fakeFile(`logo${char(0x202e)}.png`, 'def'), fakeFile('plain.png', 'ghi')];
  input.fire('change');
  await until(() => page.app.state.assets.length === 3, 'the three small files');
  assert.deepEqual(plain(page.app.state.assets.map((asset) => asset.name)), ['secret-tmp', 'logo.png', 'plain.png']);
  const cards = findAll(part(page, 'B.logo').root, (element) => element.className === 'asset');
  assert.ok(textOf(cards[0]).includes(text('en', 'ui.form.files.renamed', { from: '../..//.secret.TMP', name: 'secret-tmp' })));
  assert.ok(textOf(cards[1]).includes(text('en', 'ui.form.files.renamed', { from: 'logo<U+202E>.png', name: 'logo.png' })), 'a hidden character is made visible in the old name');
  assert.ok(!textOf(cards[2]).includes(text('en', 'ui.form.files.renamed', { from: 'plain.png', name: 'plain.png' })), 'a name that did not change is not remarked on');
  assert.equal(page.app.state.assets[2].renamedFrom, '');
  assert.equal(part(page, 'B.logo').notices.alert.textContent, text('en', 'ui.form.files.tooBig', { name: 'huge.mov', limit: '497 MB' }));
});

test('no more files than a pack can hold are accepted', () => {
  const state = newState();
  state.assets = Array.from({ length: library.PACK_MAX_ENTRIES - 10 }, (unused, index) => ({ id: `a${index + 1}`, qid: 'B.logo', name: `f${index}.txt`, what: '', owner: '', rights: '', restrictions: '', size: 1, data: null }));
  assert.deepEqual(plain(engine.attachmentProblem(state, { name: 'one-more.txt', size: 1 })), { key: 'ui.form.files.tooMany', params: { name: 'one-more.txt', max: library.PACK_MAX_ENTRIES - 10 } });
  state.assets.pop();
  assert.equal(engine.attachmentProblem(state, { name: 'last.txt', size: 1 }), null);
  const room = 497 * 1024 * 1024;
  assert.equal(engine.attachmentProblem(state, { name: 'big.bin', size: room }), null, 'a pack needs 3 MB for its own files and what is not known at attaching; the rest is for attached files');
  assert.equal(engine.attachmentProblem(state, { name: 'bigger.bin', size: room + 1 }).key, 'ui.form.files.tooBig');
  assert.equal(engine.attachmentProblem(state, { name: 'whole.bin', size: 500 * 1024 * 1024 }).key, 'ui.form.files.tooBig', 'a file of 500 MB can never fit in a pack');
});

test('attaching a file tells the person right away that files are not kept in the browser', async () => {
  const storage = createMemoryStorage();
  const page = openForm({ language: 'da', storage });
  const input = inputsOf(part(page, 'B.logo').root, 'file')[0];
  input.files = [fakeFile('photo.jpg', new Uint8Array(16))];
  input.fire('change');
  await until(() => page.app.state.assets.length === 1, 'the file');
  assert.equal(part(page, 'B.logo').notices.status.textContent, text('da', 'ui.form.files.notSaved'));
  assert.equal(part(page, 'B.logo').notices.alert.textContent, '');
  input.files = [fakeFile('small.txt', 'x'), { name: 'huge.bin', size: 600 * 1024 * 1024, arrayBuffer: async () => assert.fail('not read') }];
  input.fire('change');
  await until(() => page.app.state.assets.length === 2, 'the second file');
  assert.equal(part(page, 'B.logo').notices.status.textContent, text('da', 'ui.form.files.notSaved'));
  assert.equal(part(page, 'B.logo').notices.alert.textContent, text('da', 'ui.form.files.tooBig', { name: 'huge.bin', limit: '497 MB' }));
});

// ---------------------------------------------------------------------------------------------
// Memory and the rules of the reader

test('base64 is made in pieces and agrees with node for big files', () => {
  const bytes = new Uint8Array(crypto.randomBytes(5 * 1024 * 1024 + 7));
  const parts = library.base64Parts(bytes);
  assert.ok(parts.length > 10, 'many pieces');
  assert.ok(parts.every((piece) => piece.length <= 4 * 65536));
  assert.equal(parts.join(''), Buffer.from(bytes).toString('base64'));
  assert.deepEqual(Buffer.from(library.base64ToBytes(parts.join(''))), Buffer.from(bytes));
});

test('the form data is exported in pieces that make the same JSON as the saved state', async () => {
  const state = newState('da');
  engine.record(state, 'A.goal').text = 'Et mål';
  const big = new Uint8Array(crypto.randomBytes(3 * 1024 * 1024));
  engine.addAsset(state, 'B.logo', { name: 'big.bin', data: big }).what = 'Stor';
  engine.addAsset(state, 'B.logo', { name: 'small.bin', data: new Uint8Array([1, 2]) });
  state.assets[1].data = null;
  const parts = await engine.exportParts(state, '2026-10-23T12:00:00Z');
  assert.ok(parts.length > 15, 'the file is in many pieces');
  assert.ok(parts.every((piece) => typeof piece === 'string' && piece.length <= 4 * 65536 + 400), 'no piece is a huge string');
  const joined = JSON.parse(parts.join(''));
  assert.deepEqual(plain(joined), plain(engine.serializeState(state, { files: true, savedAt: '2026-10-23T12:00:00Z' })));
  assert.equal(Buffer.from(engine.restoreState(joined).state.assets[0].data).equals(Buffer.from(big)), true);
});

test('an export that fails says that the data is too large, in the chosen language', async () => {
  const page = openForm({ language: 'da' });
  page.app.engine.exportPlan = () => {
    throw new RangeError('Invalid string length');
  };
  const silent = console.error;
  console.error = () => {};
  try {
    await page.app.exportData();
  } finally {
    console.error = silent;
  }
  assert.equal(page.app.refs.finish.notices.alert.textContent, text('da', 'ui.form.err.exportTooLarge'));
  assert.equal(page.doc.downloads.length, 0);
});

test('the pack is handed over in pieces and a stored file is the very same array, not a copy', async () => {
  const state = newState();
  engine.record(state, 'A.goal').text = 'Et mål';
  const random = new Uint8Array(crypto.randomBytes(1024 * 1024));
  const asset = engine.addAsset(state, 'B.logo', { name: 'random.bin', data: random });
  asset.rights = 'Ejes af os';
  const pack = await packOf(state);
  assert.ok(Array.isArray(pack.parts) && pack.parts.length > 20);
  assert.ok(pack.parts.some((piece) => piece === asset.data), 'incompressible data goes in as it is');
  assert.equal(pack.size, pack.parts.reduce((sum, piece) => sum + piece.length, 0));
  const entries = unzipPack(pack.bytes);
  assert.deepEqual(entries.get('docs/assets/random.bin'), Buffer.from(random));
  const page = openForm({ language: 'en' });
  typeInto(part(page, 'A.goal').focus(), 'Et mål');
  page.app.navItems.get('finish').button.click();
  page.app.refs.finish.download.click();
  await until(() => page.doc.downloads.length === 1, 'the download');
  const blob = page.fake.blobs.get(page.doc.downloads[0].href);
  assert.ok(blob.parts.length > 5, 'the page gives the browser the pieces');
  assert.equal(blob.type, 'application/zip');
});

test('the hash of a file is made without copying it, and agrees with node', () => {
  for (const length of [0, 1, 63, 64, 65, 119, 120, 128, 1000003]) {
    const bytes = new Uint8Array(crypto.randomBytes(length));
    assert.equal(library.sha256Hex(bytes), crypto.createHash('sha256').update(bytes).digest('hex'), `${length} bytes`);
    const view = bytes.subarray(Math.min(1, length));
    assert.equal(library.sha256Hex(view), crypto.createHash('sha256').update(view).digest('hex'), `${length} bytes, a view`);
  }
});

test('an entry that compresses more than 200 to 1 is stored, so the pack never breaks the reader limit', async () => {
  const zeros = new Uint8Array(20 * 1024 * 1024);
  const { parts, size } = await library.createZipParts([{ name: 'docs/assets/zeros.bin', data: zeros }, { name: 'docs/notes.txt', data: Array.from({ length: 300 }, (unused, index) => `line ${index} of plain text`).join('\n') }], { date: NOW });
  const entries = unzip(Buffer.from(library.joinParts(parts, size)));
  assert.equal(entries.get('docs/assets/zeros.bin').method, 0, 'stored');
  assert.equal(entries.get('docs/assets/zeros.bin').data.length, zeros.length);
  assert.equal(entries.get('docs/notes.txt').method, 8, 'ordinary text is still deflated');
  for (const [name, entry] of entries) {
    assert.ok(entry.data.length <= library.PACK_MAX_RATIO * Math.max(1, entry.compressedSize), `${name}: ratio`);
  }
});

test('a pack that would break the limits is refused before anything is hashed: the sizes count every entry', async () => {
  const withBig = (length) => {
    const state = newState();
    engine.record(state, 'A.goal').text = 'Et mål';
    const asset = engine.addAsset(state, 'B.logo', { name: 'big.bin', data: new Uint8Array(1) });
    asset.data = { length };
    asset.rights = 'Ejes af os';
    return state;
  };
  const refuse = (state) =>
    assert.rejects(
      () => packOf(state),
      (error) => error.key === 'ui.form.err.tooLarge',
    );
  await refuse(withBig(library.PACK_MAX_BYTES));
  await refuse(withBig(library.PACK_MAX_BYTES - 1000), 'the text files and the manifest count too');
  await refuse(withBig(library.PACK_MAX_BYTES - 1024 * 1024));
  const state = withBig(10);
  state.assets[0].data = new Uint8Array(10);
  assert.ok((await packOf(state)).size > 0);
});
