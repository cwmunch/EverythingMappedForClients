// A second round of review: files that are not on the page, the caret, numbers of copies at their
// edges, loaded data that is hostile or huge, a build that goes on while the page changes, the old
// storage key, and the texts that must say what the page does.

import assert from 'node:assert/strict';
import crypto, { webcrypto } from 'node:crypto';
import test from 'node:test';
import { createMemoryStorage, fakeFile, same } from './fake-dom.mjs';
import { NOW, TODAY, blobBytes, loadBrowserScript, plain, textOfEntry, unzipPack } from './helpers.mjs';
import {
  KEY,
  answerGoal,
  buttonByText,
  data,
  engine,
  inputsOf,
  library,
  openForm,
  part,
  saved,
  savedText,
  text,
  typeInto,
  until,
} from './page-helpers.mjs';

const MIB = 1024 * 1024;
const GOAL = 'At få flere henvendelser fra private kunder.';

function newState(language = 'en') {
  return engine.newState({ language, now: NOW });
}

// ---------------------------------------------------------------------------------------------
// 5: files that are on the list but not on the page

async function pageWithLackingFile() {
  const page = openForm({ language: 'en' });
  answerGoal(page, GOAL);
  const input = inputsOf(part(page, 'B.logo').root, 'file')[0];
  input.files = [fakeFile('logo.svg', '<svg/>'), fakeFile('kort.png', 'png')];
  input.fire('change');
  await until(() => page.app.state.assets.length === 2, 'the files');
  for (const asset of page.app.state.assets) asset.rights = 'Ejes af os';
  page.app.state.assets[1].data = null;
  page.app.navItems.get('finish').button.click();
  return page;
}

test('files that are not on the page are named on the review step, and the button says what it leaves out', async () => {
  const page = await pageWithLackingFile();
  const finish = page.app.refs.finish;
  assert.equal(finish.lacking.hidden, false);
  assert.equal(finish.lacking.textContent, text('en', 'ui.form.finish.lacking', { names: 'kort.png' }));
  assert.equal(finish.download.textContent, text('en', 'ui.form.finish.downloadWithout'));
  finish.download.click();
  await until(() => page.doc.downloads.length === 1, 'the download');
  assert.equal(finish.notices.status.textContent, text('en', 'ui.form.finish.doneWithout', { name: page.doc.downloads[0].name, size: finish.notices.status.textContent.match(/\(([^)]+)\)/)[1], names: 'kort.png' }));
  const entries = unzipPack(blobBytes(page.fake.blobs.get(page.doc.downloads[0].href)));
  assert.ok(entries.has('docs/assets/logo.svg'));
  assert.ok(!entries.has('docs/assets/kort.png'), 'and it is not in the pack');
  assert.ok(!textOfEntry(entries, 'docs/assets.md').includes('kort.png'));

  // Attached again: nothing is left out, and the button says as before.
  const asset = page.app.state.assets[1];
  asset.data = new Uint8Array([1]);
  page.app.refresh();
  assert.equal(finish.lacking.hidden, true);
  assert.equal(finish.download.textContent, text('en', 'ui.form.finish.download'));
});

test('a file that is left out is only named when its question is in the pack, and a file of no bytes is not left out', () => {
  const state = newState();
  engine.addAsset(state, 'B.logo', { name: 'a.png', data: new Uint8Array(1) }).data = null;
  state.depth = 'essentials';
  assert.deepEqual(plain(engine.analyze(state).lacking), [], 'the question is not in this level');
  state.depth = 'standard';
  assert.deepEqual(plain(engine.analyze(state).lacking), ['a.png']);
  const raw = engine.serializeState(state, { files: false });
  raw.assets.push({ ...raw.assets[0], name: 'empty.txt', size: 0 });
  const back = engine.restoreState(JSON.parse(JSON.stringify(raw)));
  assert.deepEqual(plain(back.notes.reattach), ['a.png'], 'a file of no bytes comes back by itself');
  assert.deepEqual(plain(engine.analyze(back.state).lacking), ['a.png']);
});

test('the file list of form data does not ask for a file of no bytes to be attached again', async () => {
  const state = newState();
  engine.addAsset(state, 'B.logo', { name: 'empty.txt', data: new Uint8Array(0) });
  engine.addAsset(state, 'B.logo', { name: 'film.mov', data: { length: 300 * MIB } });
  const plan = await engine.exportPlan(state, '2026-10-23T12:00:00Z');
  assert.equal(plan.withFiles, false);
  assert.deepEqual(plain(plan.reattach), ['film.mov']);
  const back = engine.restoreState(JSON.parse(plan.parts.join('')));
  assert.deepEqual(plain(back.notes.reattach), ['film.mov']);
  assert.equal(back.state.assets[0].data.length, 0, 'the empty file is whole');
});

// ---------------------------------------------------------------------------------------------
// 8: the caret stays where the person was typing

function withCaret(page, field, value, caret) {
  field.value = value;
  field.selectionStart = caret;
  field.selectionEnd = caret;
  field.selectionDirection = 'none';
  field.setSelectionRange = (from, to) => {
    field.selectionStart = from;
    field.selectionEnd = to;
    field.setRange = [from, to];
  };
  page.doc.activeElement = field;
  field.fire('input');
}

test('when cleaning changes the text of a field the caret stays where it was in the text', () => {
  const page = openForm({ language: 'en' });
  const field = part(page, 'A.goal').focus();
  withCaret(page, field, `Hello${String.fromCharCode(0x200b)}World and more`, 6);
  assert.equal(field.value, 'HelloWorld and more');
  assert.deepEqual(field.setRange, [5, 5], 'the character before the caret went, so the caret moves one back');
  withCaret(page, field, `Hello World${String.fromCharCode(0x200b)} and more`, 5);
  assert.deepEqual(field.setRange, [5, 5], 'a character after the caret does not move it');
  withCaret(page, field, `a${String.fromCharCode(0x202e)}b${String.fromCharCode(0x200b)}c${String.fromCharCode(0xfeff)}d`, 7);
  assert.equal(field.value, 'abcd');
  assert.deepEqual(field.setRange, [4, 4], 'three before the caret, and it ends at the end');
});

test('a selection keeps both its ends, and a field that is not focused is left alone', () => {
  const page = openForm({ language: 'en' });
  const field = part(page, 'A.goal').focus();
  field.value = `ab${String.fromCharCode(0x200b)}cd${String.fromCharCode(0x200b)}ef`;
  field.selectionStart = 3;
  field.selectionEnd = 6;
  field.setSelectionRange = (from, to) => {
    field.setRange = [from, to];
  };
  page.doc.activeElement = field;
  field.fire('input');
  assert.equal(field.value, 'abcdef');
  assert.deepEqual(field.setRange, [2, 4], 'from after "ab" to after "cd"');
  field.setRange = null;
  page.doc.activeElement = null;
  field.value = `x${String.fromCharCode(0x200b)}y`;
  field.fire('input');
  assert.equal(field.value, 'xy');
  assert.equal(field.setRange, null, 'no caret is set for a field that does not have the focus');
});

test('a line that is broken at the limit keeps the caret in the text', () => {
  const page = openForm({ language: 'en' });
  const field = part(page, 'A.business').focus();
  const word = 'x'.repeat(4500);
  withCaret(page, field, word, 10);
  assert.equal(field.value.includes('\n'), true, 'the long line was broken');
  assert.deepEqual(field.setRange, [10, 10], 'a caret before the break stays');
  withCaret(page, field, word, 4400);
  assert.deepEqual(field.setRange, [4401, 4401], 'one for the line break that came before it');
});

test('a field that has no caret to set (the browser refuses) is cleaned all the same', () => {
  const page = openForm({ language: 'en' });
  const field = part(page, 'A.goal').focus();
  field.value = `a${String.fromCharCode(0x200b)}b`;
  field.selectionStart = 1;
  field.selectionEnd = 1;
  field.setSelectionRange = () => {
    throw new Error('no caret');
  };
  page.doc.activeElement = field;
  field.fire('input');
  assert.equal(field.value, 'ab');
});

// ---------------------------------------------------------------------------------------------
// 9: the numbers of the copies

test('the number of the next copy never leaves what can be counted, and starts again after the largest', () => {
  assert.equal(engine.nextRevision(0), 1);
  assert.equal(engine.nextRevision(0x7fffffff), 0x80000000, 'past 2^31 it goes on');
  assert.equal(engine.nextRevision(2 ** 40), 2 ** 40 + 1);
  assert.equal(engine.nextRevision(Number.MAX_SAFE_INTEGER - 1), Number.MAX_SAFE_INTEGER);
  assert.equal(engine.nextRevision(Number.MAX_SAFE_INTEGER), 1, 'and starts again');
  for (const bad of [-1, 1.5, NaN, Infinity, '7', null, undefined]) assert.equal(engine.nextRevision(bad), 1, String(bad));
  assert.equal(engine.copyOf({ revision: 0x80000000, writeId: 'ab' }).revision, 0x80000000, 'a number past 2^31 is read as it is');
  assert.equal(engine.copyOf({ revision: Number.MAX_SAFE_INTEGER }).revision, Number.MAX_SAFE_INTEGER);
  for (const bad of [-1, 1.5, 2 ** 60, '5', null]) assert.equal(engine.copyOf({ revision: bad }).revision, 0, String(bad));
});

test('a copy whose number is at 2^31 does not make the next save a conflict', () => {
  for (const start of [0x7ffffffe, 0x7fffffff, 0x80000000, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER]) {
    const storage = createMemoryStorage();
    const seed = openForm({ language: 'en', storage });
    answerGoal(seed, GOAL);
    seed.fake.runTimers();
    const copy = saved(storage);
    copy.revision = start;
    storage.setItem(KEY, JSON.stringify(copy));
    const page = openForm({ language: 'en', storage });
    assert.equal(page.app.revision, start);
    for (let index = 0; index < 3; index += 1) {
      typeInto(part(page, 'A.budget').focus(), `${index}`);
      page.fake.runTimers();
      assert.equal(page.app.conflict, false, `save ${index + 1} from ${start}`);
      assert.equal(saved(storage).answers['A.budget'].text, `${index}`);
    }
    assert.match(page.app.refs.panel.save.textContent, /^Saved in this browser/);
  }
});

// ---------------------------------------------------------------------------------------------
// 10: room for what is not known when a file is attached

test('what the pack needs that is not known at attaching keeps a megabyte of room, and the build agrees', async () => {
  assert.equal(library.ATTACH_EXTRA_HEADROOM_BYTES, MIB);
  const state = newState();
  const room = 500 * MIB - 2 * MIB - MIB;
  assert.equal(engine.attachmentProblem(state, { name: 'a.bin', size: room }), null);
  assert.equal(engine.attachmentProblem(state, { name: 'a.bin', size: room + 1 }).key, 'ui.form.files.tooBig');
  assert.equal(engine.attachmentProblem(state, { name: 'a.bin', size: room + 1 }).params.limit, '497 MB');
  // A file that was let through is not refused by the build for its size: the build gets as far as
  // the long work (stopped there on purpose, so that nothing of 497 MB has to be read).
  engine.record(state, 'A.goal').text = GOAL;
  const asset = engine.addAsset(state, 'B.logo', { name: 'edge.bin', data: { length: room } });
  asset.rights = 'ours';
  const reached = new Error('the build reached the long work');
  await assert.rejects(
    () => engine.buildPack(state, { now: NOW, today: TODAY, beforeWork: async () => { throw reached; } }),
    (error) => error === reached,
  );
  // One byte more and the limits refuse it before that point.
  asset.data = { length: room + 4 * MIB };
  await assert.rejects(() => engine.buildPack(state, { now: NOW, today: TODAY, beforeWork: async () => { throw reached; } }), (error) => error.key === 'ui.form.err.tooLarge');
});

// ---------------------------------------------------------------------------------------------
// 11: loaded data

function rawState(extra = {}) {
  return { ...engine.serializeState(newState(), { files: false }), ...extra };
}

test('a time of creation that is not a time is not taken over', () => {
  const fresh = (value) => engine.restoreState(rawState({ createdAt: value })).state.createdAt;
  for (const bad of ['9999-99-99T:::...Z', '2026-13-01T10:00:00Z', '2026-02-31T10:00:00Z', '2026-10-23T25:00:00Z', '2026-10-23T10:00:00', 'yesterday', 20261023, null, {}]) {
    const result = fresh(bad);
    assert.notEqual(result, bad);
    assert.match(result, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.ok(!Number.isNaN(Date.parse(result)), String(bad));
  }
  assert.equal(fresh('2026-10-22T08:15:30Z'), '2026-10-22T08:15:30Z');
});

test('a value that is not text is dropped and counted, wherever it is', () => {
  const raw = rawState({
    recipient: 42,
    respondent: { name: { first: 'A' }, role: ['x'] },
    answers: { 'A.goal': { text: 42 }, 'A.budget': { text: true }, 'A.project-kind': { choice: ['redesign'], note: 7 }, 'A.metrics': { items: [{ text: 5, note: 6 }, { text: 'ok', note: 'n' }] } },
  });
  const result = engine.restoreState(JSON.parse(JSON.stringify(raw)));
  assert.equal(result.ok, true);
  assert.equal(result.notes.cleaned, 7, 'recipient, name, role, two texts, a note and the text of a row');
  assert.equal(result.state.answers['A.goal'].text, '');
  assert.equal(result.state.recipient, '');
  // Absent and null are not changes.
  const quiet = engine.restoreState(rawState({ recipient: null, answers: { 'A.goal': { text: 'ok', note: null } } }));
  assert.equal(quiet.notes.cleaned, 0);
});

test('an answer under an unknown question that is not an object is skipped and counted like the others', () => {
  const raw = rawState({ answers: { 'Z.nothing': 5, 'Y.nothing': 'text', 'X.nothing': null, 'W.nothing': [1], 'A.goal': { text: 'ok' } } });
  const result = engine.restoreState(JSON.parse(JSON.stringify(raw)));
  assert.equal(result.ok, true, 'the rest loads');
  assert.equal(result.notes.ignored, 4);
  assert.equal(result.state.answers['A.goal'].text, 'ok');
  assert.equal(engine.restoreState(rawState({ answers: { 'A.goal': 5 } })).ok, false, 'a known question with something that is not an answer is still damage');
  assert.equal(engine.parseSavedText(JSON.stringify(raw)).ok, true);
});

// ---------------------------------------------------------------------------------------------
// 12: hostile and huge data

test('a very long text is cut first, not wrapped first: eight million characters take a moment', () => {
  const huge = 'ab '.repeat(2_700_000);
  const started = Date.now();
  const block = library.cleanBlock(huge, library.LIMITS.block.max);
  const blockMs = Date.now() - started;
  assert.ok(blockMs < 400, `${blockMs} ms (wrapping 8 million characters first takes seconds)`);
  assert.ok(block.length <= library.LIMITS.block.max);
  assert.ok(block.startsWith('ab ab ab'));
  const line = library.cleanLine(huge, library.LIMITS.line.max);
  assert.equal(line.length, library.LIMITS.line.max);
  // What is cut is still the first characters of the cleaned text.
  const hidden = `${String.fromCharCode(0x200b)}a`.repeat(30_000);
  assert.equal(library.cleanLine(hidden, 1000), 'a'.repeat(1000), 'removing characters does not leave less than the limit when there is more');
});

test('a loaded file is decoded once: the content is not read again when the files are put in', () => {
  const content = Buffer.from('the content of a file').toString('base64');
  let reads = 0;
  const record = { qid: 'B.logo', name: 'a.png', size: 21 };
  Object.defineProperty(record, 'data', {
    enumerable: true,
    get() {
      reads += 1;
      return reads <= 4 ? content : '@@@@';
    },
  });
  const result = engine.restoreState({ ...rawState(), assets: [record] });
  assert.equal(result.ok, true);
  assert.equal(Buffer.from(result.state.assets[0].data).toString(), 'the content of a file');
  assert.deepEqual(plain(result.notes.reattach), []);
});

test('content that is not base64 still makes the whole file damaged', () => {
  const raw = { ...rawState(), assets: [{ qid: 'B.logo', name: 'a.png', size: 3, data: 'AQID' }, { qid: 'B.logo', name: 'b.png', size: 3, data: '@@@@' }] };
  assert.equal(engine.restoreState(raw).ok, false);
});

test('the form data is made into text in slices, giving the page turns, with the same text', async () => {
  const state = newState();
  engine.record(state, 'A.goal').text = GOAL;
  engine.addAsset(state, 'B.logo', { name: 'big.bin', data: new Uint8Array(crypto.randomBytes(20 * MIB)) });
  let turns = 0;
  const slow = await engine.exportPlan(state, '2026-10-23T12:00:00Z', {
    yieldToPage: async () => {
      turns += 1;
    },
  });
  assert.ok(turns >= 2, `${turns} turns for 20 MB`);
  const quick = await engine.exportPlan(state, '2026-10-23T12:00:00Z');
  assert.equal(slow.parts.join(''), quick.parts.join(''));
  assert.equal(slow.bytes, quick.bytes);
});

// ---------------------------------------------------------------------------------------------
// 13: the focus goes somewhere sensible after each of these

test('after loading form data and after clearing, the focus is on the message at the top', async () => {
  const page = openForm({ language: 'en' });
  answerGoal(page, GOAL);
  const json = JSON.stringify(engine.serializeState(page.app.state, { files: false }));
  await page.app.importFile(fakeFile('form.json', json));
  same(page.doc.activeElement, page.app.refs.top.status);
  buttonByText(page.root, text('en', 'ui.form.privacy.clear')).click();
  same(page.doc.activeElement, page.app.refs.top.status);
  assert.equal(page.app.refs.top.status.getAttribute('tabindex'), '-1');
});

test('a message that is an alert takes the focus instead of the status line', async () => {
  const page = openForm({ language: 'en' });
  await page.app.importFile(fakeFile('x.json', 'not json'));
  assert.equal(page.app.refs.top.alert.textContent, text('en', 'ui.form.err.importRead'));
});

// ---------------------------------------------------------------------------------------------
// 16: the old key, a build that goes on while the page changes

test('the key of an earlier version is not read, and is cleared with the answers', async () => {
  const legacy = 'emfc.form.v1';
  const storage = createMemoryStorage();
  storage.setItem(legacy, JSON.stringify({ answers: { 'A.budget': { text: 'old' } } }));
  const page = openForm({ language: 'en', storage });
  assert.equal(page.app.state.answers['A.budget'], undefined, 'not read');
  typeInto(part(page, 'A.budget').focus(), '10');
  page.fake.runTimers();
  assert.ok(storage.getItem(legacy), 'saving leaves it alone');
  buttonByText(page.root, text('en', 'ui.form.privacy.clear')).click();
  assert.equal(storage.getItem(legacy), null, '"Clear saved data" removes it');
  assert.equal(savedText(storage), null);

  storage.setItem(legacy, 'x');
  typeInto(part(page, 'A.budget').focus(), '10');
  page.fake.runTimers();
  page.app.navItems.get('finish').button.click();
  page.app.refs.finish.download.click();
  await until(() => page.doc.downloads.length === 1, 'the download');
  buttonByText(page.app.refs.finish.afterDownload, text('en', 'ui.form.finish.removeSaved')).click();
  assert.equal(storage.getItem(legacy), null, '"Remove my saved answers" removes it');

  storage.setItem(legacy, 'x');
  openForm({ language: 'en', storage });
  assert.equal(storage.getItem(legacy), null, 'and so does starting after keeping was turned off');
});

test('a pack is made from what was there when the build began, also when the page changes in the middle of it', async () => {
  const holder = { change: () => {} };
  const loader = loadBrowserScript({
    crypto: {
      subtle: {
        digest: async (...args) => {
          holder.change();
          return webcrypto.subtle.digest(...args);
        },
      },
    },
  });
  const state = loader.engine.newState({ language: 'da', now: NOW });
  state.recipient = 'Peter Holm';
  state.depth = 'standard';
  loader.engine.record(state, 'A.goal').text = GOAL;
  loader.engine.record(state, 'A.business').text = 'Vi sælger cykler i Aarhus og vil gerne have flere private kunder.';
  state.respondent = { name: 'Anna Jensen', role: 'Marketing' };
  holder.change = () => {
    state.language = 'en';
    state.depth = 'full';
    state.recipient = 'Someone Else';
    state.createdAt = '2001-01-01T00:00:00Z';
  };
  const pack = await loader.engine.buildPack(state, { now: NOW, today: TODAY });
  const entries = unzipPack(pack.bytes);
  const stateFile = JSON.parse(textOfEntry(entries, 'docs/intake-state.json'));
  assert.equal(stateFile.language, 'da');
  assert.equal(stateFile.depth, 'standard');
  assert.equal(stateFile.recipient, 'Peter Holm');
  const manifest = JSON.parse(textOfEntry(entries, 'docs/intake-manifest.json'));
  assert.equal(manifest.language, 'da');
  assert.equal(manifest.depth, 'standard');
  assert.notEqual(manifest.createdAt, '2001-01-01T00:00:00Z');
  assert.ok(textOfEntry(entries, 'docs/00-brief.md').includes('language: da'));
  assert.ok(textOfEntry(entries, 'docs/07-risks-and-open-questions.md').length > 100);
});

test('while a pack is being built no second build starts, and the page that is drawn again in the middle of it stays consistent', async () => {
  const page = openForm({ language: 'en' });
  answerGoal(page, GOAL);
  const input = inputsOf(part(page, 'B.logo').root, 'file')[0];
  input.files = [fakeFile('random.bin', new Uint8Array(crypto.randomBytes(9 * MIB)))];
  input.fire('change');
  await until(() => page.app.state.assets.length === 1, 'the file');
  page.app.state.assets[0].rights = 'Ejes af os';
  page.app.navItems.get('finish').button.click();
  let builds = 0;
  const build = page.app.engine.buildPack;
  page.app.engine.buildPack = (...args) => {
    builds += 1;
    return build(...args);
  };
  const seen = [];
  // The work gives the page turns; in the first of them the person changes the language and presses the button again.
  page.app.yieldToPage = async () => {
    if (seen.length > 0) return;
    seen.push('turn');
    page.app.setLanguage('da');
    assert.equal(page.app.refs.finish.download.disabled, true, 'the new button is off');
    page.app.refs.finish.download.click();
    page.app.state.depth = 'full';
    page.app.state.recipient = 'Someone Else';
  };
  page.app.refs.finish.download.click();
  page.app.refs.finish.download.click();
  await until(() => page.doc.downloads.length === 1, 'the download');
  await until(() => page.app.refs.finish.download.disabled === false, 'the button back on');
  assert.deepEqual(seen, ['turn']);
  assert.equal(builds, 1, 'one build only');
  const entries = unzipPack(blobBytes(page.fake.blobs.get(page.doc.downloads[0].href)));
  const state = JSON.parse(textOfEntry(entries, 'docs/intake-state.json'));
  assert.equal(state.language, 'en', 'the pack is the one that was asked for');
  assert.equal(state.depth, 'standard');
  assert.equal(state.recipient, '');
  assert.ok(textOfEntry(entries, 'docs/00-brief.md').includes('language: en'));
  assert.ok(page.app.refs.finish.notices.status.textContent.includes('intake-pack-'), 'and the message is on the page that is showing');
});

test('a pack is made from the page as it was when the button was pressed, also when it changes while the frame is awaited', async () => {
  const page = openForm({ language: 'en' });
  answerGoal(page, GOAL);
  page.app.state.recipient = 'Peter Holm';
  page.app.navItems.get('finish').button.click();
  const frame = page.fake.win.requestAnimationFrame;
  page.fake.win.requestAnimationFrame = (callback) => {
    page.app.state.language = 'da';
    page.app.state.depth = 'full';
    page.app.state.recipient = 'Someone Else';
    return frame(callback);
  };
  page.app.refs.finish.download.click();
  await until(() => page.doc.downloads.length === 1, 'the download');
  const entries = unzipPack(blobBytes(page.fake.blobs.get(page.doc.downloads[0].href)));
  const state = JSON.parse(textOfEntry(entries, 'docs/intake-state.json'));
  assert.deepEqual([state.language, state.depth, state.recipient], ['en', 'standard', 'Peter Holm']);
});

test('the form data is not saved twice at once either', async () => {
  const page = openForm({ language: 'en' });
  answerGoal(page, GOAL);
  page.app.navItems.get('finish').button.click();
  const first = page.app.exportData();
  const second = page.app.exportData();
  await Promise.all([first, second]);
  assert.equal(page.doc.downloads.length, 1);
  assert.equal(page.app.refs.finish.exportButton.disabled, false);
});

// ---------------------------------------------------------------------------------------------
// Texts that must say what the page does

test('the texts do not promise what the page does not do', () => {
  const en = data.dictionaries.en;
  const da = data.dictionaries.da;
  // The privacy text: where answers live, what is kept by default, who can read them.
  assert.match(en['ui.form.privacy.text'], /only while the box below is ticked/);
  assert.match(en['ui.form.privacy.text'], /Opened from a file, the page starts with the box unticked/);
  assert.match(en['ui.form.privacy.text'], /Opened from a web address, it starts ticked, unless you turned it off, and saves your answers as you type/);
  assert.match(en['ui.form.privacy.text'], /every page on the same web site could read them/);
  assert.doesNotMatch(en['ui.form.privacy.text'], /only if you choose to keep them/);
  assert.match(da['ui.form.privacy.text'], /kun så længe feltet nedenfor er afkrydset/);
  assert.match(da['ui.form.privacy.text'], /starter den med hak, medmindre du har slået det fra, og gemmer dine svar, mens du skriver/);
  assert.match(da['ui.form.privacy.text'], /alle sider på samme websted kan læse dem/);
  // Removing: another open window does not write the answers back.
  assert.match(en['ui.form.keep.removed'], /no other open window of this page saves them again/);
  assert.match(da['ui.form.keep.removed'], /ingen andre åbne vinduer/);
  assert.match(en['ui.form.finish.removeSavedHint'], /other pages on this computer can read what is saved too/);
  assert.match(da['ui.form.finish.removeSavedHint'], /andre sider på computeren også læse/);
  // Changed and removed are told apart.
  assert.match(en['ui.form.sync.removed'], /removed in another window/);
  assert.match(en['ui.form.sync.changed'], /different from the ones in this window/);
  assert.match(en['ui.form.save.pausedRemoved'], /removed/);
  // A renamed file: the real reasons.
  assert.match(en['ui.form.files.renamed'], /made safe for every computer/);
  assert.match(en['ui.form.files.renamed'], /spaces and special characters become a dash/);
  assert.match(da['ui.form.files.renamed'], /gøres sikre på alle computere/);
  // Clearing says answers; files are never stored.
  assert.doesNotMatch(en['ui.form.privacy.confirm'], /files/);
  assert.doesNotMatch(da['ui.form.privacy.confirm'], /filer/);
  // Too large: about 500 MB; and the answer-file message is neutral.
  assert.match(en['ui.form.err.tooLarge'], /about 500 MB/);
  assert.match(da['ui.form.err.tooLarge'], /omkring 500 MB/);
  assert.doesNotMatch(en['ui.form.err.fileTooLarge'], /The answers in/);
  assert.match(en['ui.form.err.fileTooLarge'], /answers or file descriptions/);
  assert.match(da['ui.form.err.fileTooLarge'], /svar eller filbeskrivelser/);
});

test('texts with names or a count have the same placeholders in both languages', () => {
  for (const key of ['ui.form.finish.lacking', 'ui.form.finish.doneWithout', 'ui.form.finish.exportedNoFiles', 'ui.form.finish.exportedMissing', 'ui.form.files.renamed', 'ui.form.err.fileTooLarge']) {
    const names = (value) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    assert.deepEqual(names(data.dictionaries.da[key]), names(data.dictionaries.en[key]), key);
  }
});

// ---------------------------------------------------------------------------------------------
// A question that is switched off keeps its answer on the page until the pack is built

test('an answer to a question that is switched off and on again within a session is kept, and is in the pack only while the question is on', async () => {
  const state = newState('da');
  engine.record(state, 'A.goal').text = GOAL;
  engine.record(state, 'A.project-kind').choice = ['redesign'];
  engine.record(state, 'A.existing-site').items = [{ text: 'https://nordlys.example', note: 'den gamle side' }];
  const inPack = async (current) => {
    const entries = unzipPack((await engine.buildPack(current, { now: NOW, today: TODAY })).bytes);
    return [...entries.values()].map((content) => content.toString('utf8')).join('\n').includes('https://nordlys.example');
  };
  assert.equal(await inPack(state), true, 'the question is on: its answer is in the pack');
  assert.equal(engine.analyze(state, { now: NOW }).leftOut.answers, 0);

  engine.record(state, 'A.project-kind').choice = ['new-site'];
  assert.equal(engine.analyze(state, { now: NOW }).leftOut.answers, 1, 'switched off: one answer is left out and counted');
  assert.deepEqual(plain(state.answers['A.existing-site'].items), [{ text: 'https://nordlys.example', note: 'den gamle side' }], 'but the page still holds it');
  assert.equal(await inPack(state), false, 'it is not in the pack while the question is off');

  engine.record(state, 'A.project-kind').choice = ['redesign'];
  assert.equal(engine.analyze(state, { now: NOW }).leftOut.answers, 0);
  assert.equal(await inPack(state), true, 'switched on again, the answer is back in the pack');

  // And the same in the saved copy and in form data: what is kept is what was typed.
  engine.record(state, 'A.project-kind').choice = ['new-site'];
  const back = engine.restoreState(JSON.parse(JSON.stringify(engine.serializeState(state, { files: false }))));
  assert.deepEqual(plain(back.state.answers['A.existing-site'].items), [{ text: 'https://nordlys.example', note: 'den gamle side' }]);
});

test('on the page, switching a question off and on again keeps what was typed in it, and the review says what is left out meanwhile', () => {
  const page = openForm({ language: 'en' });
  answerGoal(page, GOAL);
  const kinds = inputsOf(part(page, 'A.project-kind').root, 'radio');
  kinds[1].checked = true;
  kinds[1].fire('change');
  const row = inputsOf(part(page, 'A.existing-site').root, 'text')[0];
  typeInto(row, 'https://nordlys.example');
  page.app.flush();
  assert.equal(part(page, 'A.existing-site').root.hidden, false);
  kinds[0].checked = true;
  kinds[0].fire('change');
  assert.equal(part(page, 'A.existing-site').root.hidden, true, 'switched off: the question is gone from the page');
  assert.equal(page.app.analysis.leftOut.answers, 1);
  page.app.navItems.get('finish').button.click();
  assert.ok(page.app.refs.finish.leftOut.textContent.length > 20 && page.app.refs.finish.leftOut.hidden === false, 'the review says that an answer is left out');
  kinds[1].checked = true;
  kinds[1].fire('change');
  assert.equal(part(page, 'A.existing-site').root.hidden, false);
  assert.equal(inputsOf(part(page, 'A.existing-site').root, 'text')[0].value, 'https://nordlys.example', 'the answer is back in its field');
  assert.equal(page.app.analysis.leftOut.answers, 0);
});
