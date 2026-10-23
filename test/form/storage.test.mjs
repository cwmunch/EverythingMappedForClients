// What the page keeps in the browser's storage and when: no file contents ever, nothing at all on a
// page opened from a file until the person says yes, no silent overwriting between two windows, and
// a save before the page is left.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrokenStorage, createMemoryStorage, fakeFile, findAll, textOf } from './fake-dom.mjs';
import { LOGO_SVG } from './helpers.mjs';
import {
  KEY,
  answerGoal,
  buttonByText,
  data,
  hasButton,
  inputsOf,
  openForm,
  openTwo,
  part,
  saved,
  savedText,
  tellOthers,
  text,
  typeInto,
  until,
} from './page-helpers.mjs';

const KEEP_KEY = `${KEY}.keep`;
const GOAL = 'At få flere henvendelser fra private kunder.';

function keepBox(page) {
  return page.app.refs.keepBox;
}

function tick(box, on) {
  box.checked = on;
  box.fire('change');
}

function saveLine(page) {
  return page.app.refs.panel.save.textContent;
}

// ---------------------------------------------------------------------------------------------
// M1: a page opened from a file shares its storage with every other page opened from a file

test('on a page opened from a file nothing is saved until the person ticks the box', () => {
  const storage = createMemoryStorage();
  const page = openForm({ language: 'en', storage, protocol: 'file:' });
  assert.equal(page.app.keep, false);
  const box = keepBox(page);
  assert.ok(box, 'the box is there');
  assert.equal(box.checked, false, 'and not ticked');
  assert.ok(textOf(page.root).includes(text('en', 'ui.form.keep.labelFile')), 'the label says who could read the answers');
  assert.ok(!textOf(page.root).includes(text('en', 'ui.form.keep.label') + ' '), 'not the plain label');
  assert.equal(saveLine(page), text('en', 'ui.form.save.off'));

  answerGoal(page, GOAL);
  page.fake.runTimers();
  assert.equal(storage.data.size, 0, 'not a key was written, not even the probe or the choice');
  page.fake.fire('pagehide');
  assert.equal(storage.data.size, 0, 'also not when the page is left');

  tick(box, true);
  assert.equal(page.app.keep, true);
  assert.equal(saved(storage).answers['A.goal'].text, GOAL, 'ticking saves what is there');
  assert.equal(storage.getItem(KEEP_KEY), '1');
  assert.match(saveLine(page), /^Saved in this browser at /);

  typeInto(part(page, 'A.budget').focus(), '10');
  page.fake.runTimers();
  assert.equal(saved(storage).answers['A.budget'].text, '10', 'and from then on it saves');
});

test('on a page opened from a file the choice is kept for the next visit, and without it nothing is read', () => {
  const storage = createMemoryStorage();
  const first = openForm({ language: 'en', storage, protocol: 'file:' });
  tick(keepBox(first), true);
  answerGoal(first, GOAL);
  first.fake.runTimers();

  const second = openForm({ language: 'en', storage, protocol: 'file:' });
  assert.equal(second.app.keep, true);
  assert.equal(keepBox(second).checked, true);
  assert.equal(second.app.state.answers['A.goal'].text, GOAL, 'the next visit continues');

  // Another page from a file that never chose: the stored text is there, but it is not read.
  const stranger = createMemoryStorage();
  stranger.setItem(KEY, storage.getItem(KEY));
  const third = openForm({ language: 'en', storage: stranger, protocol: 'file:' });
  assert.equal(third.app.keep, false);
  assert.equal(third.app.state.answers['A.goal'], undefined, 'saved answers are not read without the choice');
  assert.equal(third.app.restored, false);
});

test('unticking the box removes what is stored and stops saving, and the page keeps what it shows', () => {
  const storage = createMemoryStorage();
  const page = openForm({ language: 'en', storage, protocol: 'file:' });
  tick(keepBox(page), true);
  answerGoal(page, GOAL);
  page.fake.runTimers();
  assert.ok(savedText(storage));
  tick(keepBox(page), false);
  assert.equal(savedText(storage), null, 'the answers are gone from the storage');
  assert.equal(storage.getItem(KEEP_KEY), '0');
  assert.equal(page.app.state.answers['A.goal'].text, GOAL, 'the page keeps them');
  assert.equal(page.app.refs.top.status.textContent, text('en', 'ui.form.keep.removed'));
  assert.equal(saveLine(page), text('en', 'ui.form.save.off'));
  typeInto(part(page, 'A.budget').focus(), '10');
  page.fake.runTimers();
  assert.equal(savedText(storage), null, 'and nothing is saved again');
  const next = openForm({ language: 'en', storage, protocol: 'file:' });
  assert.equal(next.app.keep, false);
  assert.equal(next.app.state.answers['A.goal'], undefined);
});

test('on a web address saving stays on by default, and the person can turn it off there too', () => {
  const storage = createMemoryStorage();
  const page = openForm({ language: 'en', storage, protocol: 'https:' });
  assert.equal(page.app.keep, true);
  assert.equal(keepBox(page).checked, true);
  assert.ok(textOf(page.root).includes(text('en', 'ui.form.keep.label')));
  assert.ok(!textOf(page.root).includes('could read them'), 'the warning is for pages opened from a file');
  answerGoal(page, GOAL);
  page.fake.runTimers();
  assert.equal(saved(storage).answers['A.goal'].text, GOAL);
  tick(keepBox(page), false);
  assert.equal(savedText(storage), null);
  const next = openForm({ language: 'en', storage, protocol: 'https:' });
  assert.equal(next.app.keep, false, 'the choice holds for the next visit');
  const http = openForm({ language: 'en', storage: createMemoryStorage(), protocol: 'http:' });
  assert.equal(http.app.keep, true);
});

test('without storage there is no box to tick, and the page says that nothing is kept', () => {
  for (const storage of [null, createBrokenStorage()]) {
    const page = openForm({ language: 'en', storage, protocol: 'file:' });
    assert.equal(keepBox(page), null);
    assert.equal(saveLine(page), text('en', 'ui.form.save.unavailable'));
  }
});

test('nothing in the storage holds the content of a file, whatever its size', async () => {
  const storage = createMemoryStorage();
  const page = openForm({ language: 'en', storage });
  const input = inputsOf(part(page, 'B.logo').root, 'file')[0];
  const bytes = new Uint8Array(4096).fill(97);
  input.files = [fakeFile('logo.svg', LOGO_SVG), fakeFile('notes.txt', bytes)];
  input.fire('change');
  await until(() => page.app.state.assets.length === 2, 'the files');
  answerGoal(page, GOAL);
  page.fake.runTimers();
  const all = [...storage.data.values()].join('\n');
  assert.ok(!all.includes(Buffer.from(LOGO_SVG).toString('base64')));
  assert.ok(!all.includes(Buffer.from(bytes).toString('base64').slice(0, 200)));
  assert.ok(!all.includes('"data"'), 'no data field in anything stored');
  assert.deepEqual(saved(storage).assets.map((asset) => [asset.name, asset.size]), [['logo.svg', LOGO_SVG.length], ['notes.txt', 4096]]);
});

test('after a download the person can remove the saved answers from this browser', async () => {
  const storage = createMemoryStorage();
  const page = openForm({ language: 'en', storage });
  const finish = page.app.refs.finish;
  assert.equal(finish.afterDownload.hidden, true, 'not offered before a download');
  answerGoal(page, GOAL);
  page.fake.runTimers();
  page.app.navItems.get('finish').button.click();
  finish.download.click();
  await until(() => page.doc.downloads.length === 1, 'the download');
  assert.equal(finish.afterDownload.hidden, false, 'offered once a pack is downloaded');
  assert.ok(hasButton(finish.afterDownload, text('en', 'ui.form.finish.removeSaved')));
  assert.ok(textOf(finish.afterDownload).includes(text('en', 'ui.form.finish.removeSavedHint')));
  assert.ok(savedText(storage));

  buttonByText(finish.afterDownload, text('en', 'ui.form.finish.removeSaved')).click();
  assert.equal(savedText(storage), null, 'the answers are gone from the storage');
  assert.equal(storage.getItem(`${KEY}.broken`), null);
  assert.equal(page.app.keep, false);
  assert.equal(keepBox(page).checked, false);
  assert.equal(finish.afterDownload.hidden, true);
  assert.equal(finish.notices.status.textContent, text('en', 'ui.form.keep.removed'));
  assert.equal(page.app.state.answers['A.goal'].text, GOAL, 'the page keeps what it shows');
  typeInto(part(page, 'A.budget').focus(), '10');
  page.fake.runTimers();
  assert.equal(savedText(storage), null, 'and does not save it again');
});

test('on a page opened from a file the button after a download is not offered when nothing is saved', async () => {
  const page = openForm({ language: 'en', storage: createMemoryStorage(), protocol: 'file:' });
  answerGoal(page, GOAL);
  page.app.navItems.get('finish').button.click();
  page.app.refs.finish.download.click();
  await until(() => page.doc.downloads.length === 1, 'the download');
  assert.equal(page.app.refs.finish.afterDownload.hidden, true);
});

// ---------------------------------------------------------------------------------------------
// M2: two windows

test('a second window does not overwrite the first one\'s answers: it asks', () => {
  const { storage, first, second } = openTwo({ language: 'en' });
  assert.equal(second.app.refs.sync.element.hidden, true, 'no notice before there is something to ask'); 
  answerGoal(first, GOAL);
  first.fake.runTimers();
  const firstCopy = savedText(storage);
  assert.equal(saved(storage).revision, 1);
  assert.match(saved(storage).writeId, /^[0-9a-f]+$/);

  typeInto(part(second, 'A.budget').focus(), '150.000 kr.');
  second.fake.runTimers();
  assert.equal(savedText(storage), firstCopy, 'the storage is exactly what the first window wrote');
  assert.equal(second.app.conflict, true);
  assert.equal(second.app.refs.sync.element.hidden, false, 'the notice is shown');
  const notice = textOf(second.app.refs.sync.element);
  assert.ok(notice.includes(text('en', 'ui.form.sync.changed')));
  assert.ok(hasButton(second.app.refs.sync.element, text('en', 'ui.form.sync.show')));
  assert.ok(hasButton(second.app.refs.sync.element, text('en', 'ui.form.sync.keep')));
  assert.equal(saveLine(second), text('en', 'ui.form.save.paused'));
  assert.equal(second.app.state.answers['A.budget'].text, '150.000 kr.', 'what was typed stays on the page');

  typeInto(part(second, 'A.budget').focus(), '160.000 kr.');
  second.fake.runTimers();
  assert.equal(savedText(storage), firstCopy, 'still not written while the choice is open');
});

test('"Show the other window\'s answers" loads what the storage holds and goes on from there', () => {
  const { storage, first, second } = openTwo({ language: 'en' });
  answerGoal(first, GOAL);
  first.fake.runTimers();
  typeInto(part(second, 'A.budget').focus(), '150.000 kr.');
  second.fake.runTimers();
  buttonByText(second.app.refs.sync.element, text('en', 'ui.form.sync.show')).click();
  assert.equal(second.app.conflict, false);
  assert.equal(second.app.refs.sync.element.hidden, true);
  assert.equal(second.app.state.answers['A.goal'].text, GOAL, 'the other window\'s answers');
  assert.equal(second.app.state.answers['A.budget'], undefined, 'not what was only in this window');
  assert.equal(second.app.refs.top.status.textContent, text('en', 'ui.form.sync.shown'));

  typeInto(part(second, 'A.budget').focus(), '200.000 kr.');
  second.fake.runTimers();
  assert.equal(saved(storage).answers['A.budget'].text, '200.000 kr.', 'now this window saves again');
  assert.equal(saved(storage).revision, 2);
  assert.equal(second.app.conflict, false);

  // The first window is now the one that is behind.
  typeInto(part(first, 'A.budget').focus(), '1');
  first.fake.runTimers();
  assert.equal(first.app.conflict, true);
  assert.equal(saved(storage).answers['A.budget'].text, '200.000 kr.');
});

test('"Keep what is in this window" overwrites the stored answers, on purpose', () => {
  const { storage, first, second } = openTwo({ language: 'en' });
  answerGoal(first, GOAL);
  first.fake.runTimers();
  typeInto(part(second, 'A.budget').focus(), '150.000 kr.');
  second.fake.runTimers();
  assert.equal(second.app.conflict, true);
  buttonByText(second.app.refs.sync.element, text('en', 'ui.form.sync.keep')).click();
  assert.equal(second.app.conflict, false);
  assert.equal(second.app.refs.sync.element.hidden, true);
  const copy = saved(storage);
  assert.equal(copy.answers['A.budget'].text, '150.000 kr.');
  assert.equal(copy.answers['A.goal'], undefined, 'the first window\'s answers are replaced');
  assert.equal(copy.revision, 2, 'and the copy is newer than the one the first window knows');
  assert.equal(second.app.refs.top.status.textContent, text('en', 'ui.form.sync.kept'));
  assert.match(saveLine(second), /^Saved in this browser at /);

  typeInto(part(second, 'A.budget').focus(), '151.000 kr.');
  second.fake.runTimers();
  assert.equal(saved(storage).revision, 3);
  typeInto(part(first, 'A.budget').focus(), '1');
  first.fake.runTimers();
  assert.equal(first.app.conflict, true, 'the first window is asked in its turn');
  assert.equal(saved(storage).answers['A.budget'].text, '151.000 kr.');
});

test('an open window notices at once when another window saves, without typing', () => {
  const { first, second } = openTwo({ language: 'en' });
  answerGoal(first, GOAL);
  first.fake.runTimers();
  assert.equal(second.app.conflict, false);
  tellOthers(second);
  assert.equal(second.app.conflict, true);
  assert.equal(second.app.refs.sync.element.hidden, false);
  assert.equal(saveLine(second), text('en', 'ui.form.save.paused'));
  assert.equal(first.app.conflict, false, 'the window that saved is not told about its own save');
  tellOthers(first);
  assert.equal(first.app.conflict, false, 'it holds the copy it wrote');
});

test('a storage event about another key, or from a window that wrote nothing new, changes nothing', () => {
  const { storage, first, second } = openTwo({ language: 'en' });
  answerGoal(first, GOAL);
  first.fake.runTimers();
  second.fake.fire('storage', { key: 'something.else' });
  assert.equal(second.app.conflict, false);
  buttonByText(second.app.refs.sync.element, text('en', 'ui.form.sync.show')).click();
  assert.equal(second.app.conflict, false);
  tellOthers(second);
  assert.equal(second.app.conflict, false, 'the window has the copy that is stored');
  assert.ok(savedText(storage));
});

test('when another window removes the saved answers, this one is asked before it writes them back', () => {
  const { storage, first, second } = openTwo({ language: 'en', confirm: () => true });
  answerGoal(first, GOAL);
  first.fake.runTimers();
  tellOthers(second);
  assert.equal(second.app.conflict, true, 'first the second window learns of the copy');
  buttonByText(second.app.refs.sync.element, text('en', 'ui.form.sync.show')).click();
  assert.equal(second.app.state.answers['A.goal'].text, GOAL);

  // The first window clears everything (the privacy button) and removes the copy.
  buttonByText(first.root, text('en', 'ui.form.privacy.clear')).click();
  assert.equal(savedText(storage), null);
  tellOthers(second);
  assert.equal(second.app.conflict, true, 'the second window is asked');
  typeInto(part(second, 'A.budget').focus(), '10');
  second.fake.runTimers();
  assert.equal(savedText(storage), null, 'nothing is written back');
  buttonByText(second.app.refs.sync.element, text('en', 'ui.form.sync.show')).click();
  assert.equal(second.app.state.answers['A.goal'], undefined, 'it shows what the storage holds: nothing');
  assert.equal(second.app.conflict, false);
});

test('"Show the other window\'s answers" keeps the files this window has attached', async () => {
  const { storage, first, second } = openTwo({ language: 'en' });
  const input = inputsOf(part(second, 'B.logo').root, 'file')[0];
  input.files = [fakeFile('logo.svg', LOGO_SVG)];
  input.fire('change');
  await until(() => second.app.state.assets.length === 1, 'the file');
  second.fake.runTimers();
  assert.equal(saved(storage).assets[0].name, 'logo.svg');
  // The first window saves the same list (it read it) and one more answer.
  tellOthers(first);
  buttonByText(first.app.refs.sync.element, text('en', 'ui.form.sync.show')).click();
  assert.equal(first.app.state.assets[0].data, null, 'the stored copy has no content');
  answerGoal(first, GOAL);
  first.fake.runTimers();
  tellOthers(second);
  assert.equal(second.app.conflict, true);
  buttonByText(second.app.refs.sync.element, text('en', 'ui.form.sync.show')).click();
  assert.equal(second.app.state.answers['A.goal'].text, GOAL);
  assert.equal(second.app.state.assets.length, 1);
  assert.equal(Buffer.from(second.app.state.assets[0].data).toString(), LOGO_SVG, 'the file this window has stays attached');
});

test('a window that was not keeping answers asks before it writes over what is stored', () => {
  const storage = createMemoryStorage();
  const stored = openForm({ language: 'en', storage, protocol: 'file:' });
  tick(keepBox(stored), true);
  answerGoal(stored, GOAL);
  stored.fake.runTimers();
  // A page with its own choice cleared: it did not read the copy, so it must not replace it blindly.
  storage.removeItem(KEEP_KEY);
  const later = openForm({ language: 'en', storage, protocol: 'file:' });
  assert.equal(later.app.keep, false);
  typeInto(part(later, 'A.budget').focus(), '10');
  tick(keepBox(later), true);
  assert.equal(later.app.conflict, true);
  assert.equal(saved(storage).answers['A.goal'].text, GOAL, 'the stored answers are untouched');
});

// ---------------------------------------------------------------------------------------------
// L4: the last half second of typing

test('leaving the page saves what was typed in the last moments', () => {
  const storage = createMemoryStorage();
  const page = openForm({ language: 'en', storage });
  answerGoal(page, GOAL);
  assert.equal(savedText(storage), null, 'the debounced save has not run yet');
  page.fake.fire('pagehide');
  assert.equal(saved(storage).answers['A.goal'].text, GOAL);
  assert.equal(saved(storage).revision, 1);
  page.fake.fire('pagehide');
  assert.equal(saved(storage).revision, 1, 'nothing more to save, nothing written');
});

test('putting the page away in a hidden tab saves, and showing it again does not', () => {
  const storage = createMemoryStorage();
  const page = openForm({ language: 'en', storage });
  answerGoal(page, GOAL);
  page.doc.fire('visibilitychange', { visibilityState: 'visible' });
  assert.equal(savedText(storage), null, 'visible: no save');
  page.doc.fire('visibilitychange', { visibilityState: 'hidden' });
  assert.equal(saved(storage).answers['A.goal'].text, GOAL);
});

test('leaving the page writes nothing when the answers are not kept or another copy is waiting', () => {
  const storage = createMemoryStorage();
  const off = openForm({ language: 'en', storage, protocol: 'file:' });
  answerGoal(off, GOAL);
  off.fake.fire('pagehide');
  off.doc.fire('visibilitychange', { visibilityState: 'hidden' });
  assert.equal(storage.data.size, 0);

  const { storage: shared, first, second } = openTwo({ language: 'en' });
  answerGoal(first, GOAL);
  first.fake.fire('pagehide');
  const copy = savedText(shared);
  typeInto(part(second, 'A.budget').focus(), '10');
  second.fake.fire('pagehide');
  assert.equal(savedText(shared), copy, 'the second window does not overwrite on its way out');
  assert.equal(second.app.conflict, true, 'it asks instead');
});

test('the texts of this behaviour are defined in both languages', () => {
  for (const lang of ['da', 'en']) {
    for (const key of ['keep.label', 'keep.labelFile', 'keep.removed', 'save.off', 'save.paused', 'sync.changed', 'sync.show', 'sync.keep', 'sync.shown', 'sync.kept', 'finish.removeSaved']) {
      assert.ok(data.dictionaries[lang][`ui.form.${key}`], `${lang} ${key}`);
    }
  }
  assert.equal(data.dictionaries.en['ui.form.keep.labelFile'], 'Keep my answers in this browser. Other pages opened from this computer could read them.');
});

test('every button of the notice is reachable and named', () => {
  const { first, second } = openTwo({ language: 'da' });
  answerGoal(first, 'x');
  first.fake.runTimers();
  tellOthers(second);
  const buttons = findAll(second.app.refs.sync.element, (element) => element.localName === 'button');
  assert.deepEqual(buttons.map((button) => button.textContent), [text('da', 'ui.form.sync.show'), text('da', 'ui.form.sync.keep')]);
  assert.equal(second.app.refs.sync.element.getAttribute('role'), 'alert');
});
