// What the page keeps in the browser's storage and when: no file contents ever; on a page that is not
// a web page nothing until the person ticks the box in this window, and never because the storage
// says so; "no" from any window is heard by every window; no silent overwriting between windows; and
// a save before the page is left.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrokenStorage, createMemoryStorage, fakeFile, findAll, same, textOf } from './fake-dom.mjs';
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

function banner(page) {
  return page.app.refs.sync.element;
}

function bannerText(page) {
  return textOf(banner(page).children[0]);
}

function bannerButtons(page) {
  return findAll(banner(page), (element) => element.localName === 'button').map((button) => button.textContent);
}

// A storage that has a saved copy in it, as an earlier visit left it.
function storageWithCopy(goal = GOAL) {
  const storage = createMemoryStorage();
  const earlier = openForm({ language: 'en', storage });
  answerGoal(earlier, goal);
  earlier.fake.runTimers();
  assert.ok(savedText(storage));
  return storage;
}

// ---------------------------------------------------------------------------------------------
// M1: a page that is not a web page shares its storage with every other such page

test('on a page opened from a file nothing is written until the person ticks the box, not even a probe', () => {
  const storage = createMemoryStorage();
  const writes = [];
  const setItem = storage.setItem;
  storage.setItem = (key, value) => {
    writes.push(key);
    return setItem(key, value);
  };
  const page = openForm({ language: 'en', storage, protocol: 'file:' });
  assert.equal(page.app.keep, false);
  assert.equal(keepBox(page).checked, false);
  assert.ok(textOf(page.root).includes(text('en', 'ui.form.keep.labelFile')), 'the label says who could read and change the answers');
  assert.equal(saveLine(page), text('en', 'ui.form.save.off'));
  answerGoal(page, GOAL);
  page.fake.runTimers();
  page.fake.fire('pagehide');
  page.doc.fire('visibilitychange', { visibilityState: 'hidden' });
  assert.deepEqual(writes, [], 'not a key was written');
  assert.equal(storage.data.size, 0);

  tick(keepBox(page), true);
  assert.equal(page.app.keep, true);
  assert.equal(saved(storage).answers['A.goal'].text, GOAL, 'ticking saves what is there');
  assert.match(saveLine(page), /^Saved in this browser at /);
  typeInto(part(page, 'A.budget').focus(), '10');
  page.fake.runTimers();
  assert.equal(saved(storage).answers['A.budget'].text, '10');
  assert.deepEqual([...new Set(writes)], [KEY], 'only the answers are written; ticking asks for no other key');
});

test('the label of the box says that other pages can read and change the answers, in both languages', () => {
  assert.equal(data.dictionaries.en['ui.form.keep.labelFile'], 'Keep my answers in this browser. Other pages opened from this computer could read and change them.');
  assert.match(data.dictionaries.da['ui.form.keep.labelFile'], /kan læse og ændre dem/);
  const page = openForm({ language: 'da', protocol: 'file:' });
  assert.ok(textOf(page.root).includes(text('da', 'ui.form.keep.labelFile')));
});

test('a stored yes is never taken as consent on a page that is not a web page', () => {
  const storage = storageWithCopy();
  storage.setItem(KEEP_KEY, '1');
  const page = openForm({ language: 'en', storage, protocol: 'file:' });
  assert.equal(page.app.keep, false, 'the storage cannot switch keeping on');
  assert.equal(keepBox(page).checked, false);
  assert.equal(page.app.state.answers['A.goal'], undefined, 'and the answers in it are not read');
  assert.equal(page.app.restored, false);
  answerGoal(page, 'Typed here.');
  page.fake.runTimers();
  assert.equal(saved(storage).answers['A.goal'].text, GOAL, 'nothing is written over them');

  // Another page writes a yes while this one is open: nothing changes.
  const other = openForm({ language: 'en', storage: createMemoryStorage(), protocol: 'file:' });
  other.app.storage.setItem(KEEP_KEY, '1');
  other.fake.fire('storage', { key: KEEP_KEY });
  assert.equal(other.app.keep, false);
  typeInto(part(other, 'A.budget').focus(), '10');
  other.fake.runTimers();
  assert.equal(savedText(other.app.storage), null);
});

test('every protocol that is not http or https is a page that is not a web page', () => {
  for (const protocol of ['file:', 'content:', 'about:', 'blob:', 'ftp:', 'chrome-extension:', 'moz-extension:', 'data:', '']) {
    const page = openForm({ language: 'en', storage: createMemoryStorage(), protocol });
    assert.equal(page.app.keep, false, protocol);
    assert.equal(keepBox(page).checked, false, protocol);
  }
  const noLocation = openForm({ language: 'en', storage: createMemoryStorage(), noLocation: true });
  assert.equal(noLocation.app.keep, false, 'a page that does not say what it is counts as one that is not a web page');
  for (const protocol of ['http:', 'https:']) {
    const page = openForm({ language: 'en', storage: createMemoryStorage(), protocol });
    assert.equal(page.app.keep, true, protocol);
  }
});

test('answers that are in the storage on such a page are offered, and read only when the person says so', () => {
  const storage = storageWithCopy();
  const page = openForm({ language: 'en', storage, protocol: 'file:' });
  assert.equal(page.app.state.answers['A.goal'], undefined);
  assert.equal(banner(page).hidden, false);
  assert.equal(page.app.syncMode, 'offer');
  assert.equal(bannerText(page), text('en', 'ui.form.offer.found'));
  assert.deepEqual(bannerButtons(page), [text('en', 'ui.form.offer.continue'), text('en', 'ui.form.offer.remove')]);
  assert.equal(page.app.conflict, false, 'it does not hold saving: nothing is kept anyway');

  buttonByText(banner(page), text('en', 'ui.form.offer.continue')).click();
  assert.equal(page.app.state.answers['A.goal'].text, GOAL);
  assert.equal(banner(page).hidden, true);
  assert.equal(page.app.keep, true, 'continuing is the person saying yes in this window');
  assert.equal(keepBox(page).checked, true);
  assert.ok(page.app.refs.top.status.textContent.startsWith(text('en', 'ui.form.save.restored')));
  same(page.doc.activeElement, page.app.refs.top.status, 'the focus is on the message');
  typeInto(part(page, 'A.budget').focus(), '10');
  page.fake.runTimers();
  assert.equal(saved(storage).answers['A.budget'].text, '10');
  assert.equal(saved(storage).answers['A.goal'].text, GOAL);
  assert.equal(saved(storage).revision, 2, 'the numbering goes on from the copy that was read');
});

test('"Remove it" deletes what an earlier visit saved, and the page keeps nothing', () => {
  const storage = storageWithCopy();
  storage.setItem(`${KEY}.broken`, 'old');
  const page = openForm({ language: 'en', storage, protocol: 'file:' });
  buttonByText(banner(page), text('en', 'ui.form.offer.remove')).click();
  assert.equal(savedText(storage), null);
  assert.equal(storage.getItem(`${KEY}.broken`), null);
  assert.equal(banner(page).hidden, true);
  assert.equal(page.app.keep, false);
  assert.equal(page.app.refs.top.status.textContent, text('en', 'ui.form.offer.removed'));
  same(page.doc.activeElement, page.app.refs.top.status);
  answerGoal(page, GOAL);
  page.fake.runTimers();
  assert.equal(savedText(storage), null);
});

test('saved answers that cannot be read are not written anywhere when the person continues, and stay until they are removed', () => {
  const storage = createMemoryStorage();
  const damaged = '{"format":"everything-mapped-form/1","answers":"broken';
  storage.setItem(KEY, damaged);
  const page = openForm({ language: 'en', storage, protocol: 'file:' });
  assert.equal(page.app.syncMode, 'offer');
  buttonByText(banner(page), text('en', 'ui.form.offer.continue')).click();
  assert.equal(page.app.refs.top.alert.textContent, text('en', 'ui.form.offer.unreadable'));
  assert.equal(savedText(storage), damaged, 'the data is where it was');
  assert.equal(storage.getItem(`${KEY}.broken`), null, 'no copy is written on a page that keeps nothing');
  assert.ok(hasButton(page.root, text('en', 'ui.form.privacy.downloadBroken')), 'but it can be downloaded');
  assert.equal(page.app.keep, false);
});

test('answers kept in one visit are offered in the next, and a choice not to keep is final', () => {
  const storage = createMemoryStorage();
  const first = openForm({ language: 'en', storage, protocol: 'file:' });
  tick(keepBox(first), true);
  answerGoal(first, GOAL);
  first.fake.runTimers();
  const second = openForm({ language: 'en', storage, protocol: 'file:' });
  assert.equal(second.app.syncMode, 'offer');
  tick(keepBox(first), false);
  assert.equal(savedText(storage), null);
  assert.equal(storage.getItem(KEEP_KEY), '0');
  const third = openForm({ language: 'en', storage, protocol: 'file:' });
  assert.equal(third.app.syncMode, null, 'nothing saved, nothing to offer');
  assert.equal(third.app.state.answers['A.goal'], undefined);
});

test('on a web address saving starts on, and turning it off is final until the box is ticked again', () => {
  const storage = createMemoryStorage();
  const page = openForm({ language: 'en', storage, protocol: 'https:' });
  assert.equal(page.app.keep, true);
  assert.equal(keepBox(page).checked, true);
  assert.ok(textOf(page.root).includes(text('en', 'ui.form.keep.label')));
  answerGoal(page, GOAL);
  page.fake.runTimers();
  assert.equal(saved(storage).answers['A.goal'].text, GOAL);
  tick(keepBox(page), false);
  assert.equal(savedText(storage), null);
  assert.equal(storage.getItem(KEEP_KEY), '0');
  const next = openForm({ language: 'en', storage, protocol: 'https:' });
  assert.equal(next.app.keep, false);
  assert.equal(keepBox(next).checked, false);
  tick(keepBox(next), true);
  assert.equal(storage.getItem(KEEP_KEY), null, 'ticking takes the no away');
  assert.equal(next.app.keep, true);
});

test('without storage there is no box to tick, and the page says that nothing is kept', () => {
  for (const storage of [null, createBrokenStorage()]) {
    const page = openForm({ language: 'en', storage, protocol: 'file:' });
    assert.equal(keepBox(page), null);
    assert.equal(saveLine(page), text('en', 'ui.form.save.unavailable'));
  }
});

test('a storage that refuses to write is found out when something is saved, and the page says so', () => {
  const storage = createMemoryStorage();
  storage.setItem = () => {
    throw new Error('the storage is full');
  };
  const page = openForm({ language: 'en', storage });
  assert.ok(keepBox(page), 'reading works, so the box is there');
  answerGoal(page, GOAL);
  page.fake.runTimers();
  assert.equal(saveLine(page), text('en', 'ui.form.save.failed'));
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

test('after a download the person can remove the saved answers from this browser, and no window writes them back', async () => {
  const { storage, first, second } = openTwo({ language: 'en' });
  const finish = first.app.refs.finish;
  assert.equal(finish.afterDownload.hidden, true, 'not offered before a download');
  answerGoal(first, GOAL);
  first.fake.runTimers();
  first.app.navItems.get('finish').button.click();
  finish.download.click();
  await until(() => first.doc.downloads.length === 1, 'the download');
  assert.equal(finish.afterDownload.hidden, false, 'offered once a pack is downloaded');
  assert.ok(textOf(finish.afterDownload).includes(text('en', 'ui.form.finish.removeSavedHint')));

  buttonByText(finish.afterDownload, text('en', 'ui.form.finish.removeSaved')).click();
  assert.equal(savedText(storage), null, 'the answers are gone from the storage');
  assert.equal(first.app.keep, false);
  assert.equal(keepBox(first).checked, false);
  assert.equal(finish.afterDownload.hidden, true);
  assert.equal(finish.notices.status.textContent, text('en', 'ui.form.keep.removed'));
  same(first.doc.activeElement, finish.notices.status, 'the focus is on the message');
  assert.equal(first.app.state.answers['A.goal'].text, GOAL, 'the page keeps what it shows');
  typeInto(part(first, 'A.budget').focus(), '10');
  first.fake.runTimers();
  assert.equal(savedText(storage), null, 'and does not save it again');

  // The other window, which had the same answers open, does not write them back either.
  typeInto(part(second, 'A.budget').focus(), '20');
  second.fake.runTimers();
  assert.equal(savedText(storage), null);
  assert.equal(second.app.keep, false);
  assert.equal(keepBox(second).checked, false);
});

test('on a page that keeps nothing the button after a download is not offered', async () => {
  const page = openForm({ language: 'en', storage: createMemoryStorage(), protocol: 'file:' });
  answerGoal(page, GOAL);
  page.app.navItems.get('finish').button.click();
  page.app.refs.finish.download.click();
  await until(() => page.doc.downloads.length === 1, 'the download');
  assert.equal(page.app.refs.finish.afterDownload.hidden, true);
});

// ---------------------------------------------------------------------------------------------
// "No" in one window is "no" in every window

test('turning keeping off before the other window has saved anything stops that window too', () => {
  const { storage, first, second } = openTwo({ language: 'en' });
  tick(keepBox(second), false);
  assert.equal(storage.getItem(KEEP_KEY), '0');
  // The first window is told at once ...
  tellOthers(first, KEEP_KEY);
  assert.equal(first.app.keep, false);
  assert.equal(keepBox(first).checked, false);
  assert.equal(first.app.refs.top.status.textContent, text('en', 'ui.form.keep.stopped'));
  assert.equal(saveLine(first), text('en', 'ui.form.save.off'));
  typeInto(part(first, 'A.goal').focus(), GOAL);
  first.fake.runTimers();
  assert.equal(savedText(storage), null);
});

test('and when it is not told, it still looks before every write and does not write', () => {
  const { storage, first, second } = openTwo({ language: 'en' });
  tick(keepBox(second), false);
  typeInto(part(first, 'A.goal').focus(), GOAL);
  first.fake.runTimers();
  assert.equal(savedText(storage), null, 'nothing written');
  assert.equal(first.app.keep, false);
  assert.equal(keepBox(first).checked, false);
  assert.equal(saveLine(first), text('en', 'ui.form.save.off'), 'and not a word about saving');
  first.fake.fire('pagehide');
  assert.equal(savedText(storage), null);
});

test('the notice\'s "Keep what is in this window" writes nothing when keeping was turned off meanwhile', () => {
  const { storage, first, second } = openTwo({ language: 'en' });
  answerGoal(first, GOAL);
  first.fake.runTimers();
  typeInto(part(second, 'A.budget').focus(), '150.000 kr.');
  second.fake.runTimers();
  assert.equal(second.app.syncMode, 'changed');
  // The first window turns keeping off; the second does not hear of it (no event is sent).
  tick(keepBox(first), false);
  assert.equal(savedText(storage), null);
  buttonByText(banner(second), text('en', 'ui.form.sync.keep')).click();
  assert.equal(savedText(storage), null, 'not written');
  assert.equal(second.app.keep, false);
  assert.equal(banner(second).hidden, true);
  assert.equal(second.app.refs.top.status.textContent, text('en', 'ui.form.keep.stopped'));
  assert.equal(second.app.state.answers['A.budget'].text, '150.000 kr.', 'the page keeps what it shows');
});

test('opening the page again does not leave answers behind in the storage', () => {
  for (const protocol of ['https:', 'file:']) {
    const storage = storageWithCopy();
    storage.setItem(`${KEY}.broken`, 'old');
    storage.setItem(KEEP_KEY, '0');
    const page = openForm({ language: 'en', storage, protocol });
    assert.equal(page.app.keep, false, protocol);
    assert.equal(page.app.state.answers['A.goal'], undefined, `${protocol}: the form is empty`);
    assert.equal(page.app.syncMode, null, `${protocol}: nothing to offer, the person said no`);
    assert.equal(savedText(storage), null, `${protocol}: the copy is gone`);
    assert.equal(storage.getItem(`${KEY}.broken`), null);
    assert.equal(storage.getItem(KEEP_KEY), '0', 'and the no stays');
  }
});

// ---------------------------------------------------------------------------------------------
// M2: two windows

test('a second window does not overwrite the first one\'s answers: it asks', () => {
  const { storage, first, second } = openTwo({ language: 'en' });
  assert.equal(banner(second).hidden, true, 'no notice before there is something to ask');
  answerGoal(first, GOAL);
  first.fake.runTimers();
  const firstCopy = savedText(storage);
  assert.equal(saved(storage).revision, 1);
  assert.match(saved(storage).writeId, /^[0-9a-f]+$/);

  typeInto(part(second, 'A.budget').focus(), '150.000 kr.');
  second.fake.runTimers();
  assert.equal(savedText(storage), firstCopy, 'the storage is exactly what the first window wrote');
  assert.equal(second.app.conflict, true);
  assert.equal(banner(second).hidden, false, 'the notice is shown');
  assert.equal(bannerText(second), text('en', 'ui.form.sync.changed'));
  assert.deepEqual(bannerButtons(second), [text('en', 'ui.form.sync.show'), text('en', 'ui.form.sync.keep')]);
  same(second.doc.activeElement, banner(second), 'the notice has the focus');
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
  buttonByText(banner(second), text('en', 'ui.form.sync.show')).click();
  assert.equal(second.app.conflict, false);
  assert.equal(banner(second).hidden, true);
  assert.equal(second.app.state.answers['A.goal'].text, GOAL, 'the other window\'s answers');
  assert.equal(second.app.state.answers['A.budget'], undefined, 'not what was only in this window');
  assert.equal(second.app.refs.top.status.textContent, text('en', 'ui.form.sync.shown'));
  same(second.doc.activeElement, second.app.refs.top.status, 'the focus is on the message');

  typeInto(part(second, 'A.budget').focus(), '200.000 kr.');
  second.fake.runTimers();
  assert.equal(saved(storage).answers['A.budget'].text, '200.000 kr.', 'now this window saves again');
  assert.equal(saved(storage).revision, 2);
  assert.equal(second.app.conflict, false);

  typeInto(part(first, 'A.budget').focus(), '1');
  first.fake.runTimers();
  assert.equal(first.app.conflict, true);
  assert.equal(saved(storage).answers['A.budget'].text, '200.000 kr.');
});

test('what is in a window is only replaced after the person has said yes to that', () => {
  const answers = [false, true];
  const asked = [];
  const confirm = (message) => {
    asked.push(message);
    return answers.shift();
  };
  const { storage, first, second } = openTwo({ language: 'en', confirm });
  answerGoal(first, GOAL);
  first.fake.runTimers();
  typeInto(part(second, 'A.budget').focus(), '150.000 kr.');
  second.fake.runTimers();
  buttonByText(banner(second), text('en', 'ui.form.sync.show')).click();
  assert.deepEqual(asked, [text('en', 'ui.form.sync.confirmShow')]);
  assert.equal(second.app.state.answers['A.budget'].text, '150.000 kr.', 'declined: nothing changed');
  assert.equal(second.app.conflict, true);
  buttonByText(banner(second), text('en', 'ui.form.sync.show')).click();
  assert.equal(second.app.state.answers['A.goal'].text, GOAL, 'accepted');
  assert.ok(savedText(storage));
});

test('"Keep what is in this window" overwrites the stored answers, on purpose', () => {
  const { storage, first, second } = openTwo({ language: 'en' });
  answerGoal(first, GOAL);
  first.fake.runTimers();
  typeInto(part(second, 'A.budget').focus(), '150.000 kr.');
  second.fake.runTimers();
  assert.equal(second.app.conflict, true);
  buttonByText(banner(second), text('en', 'ui.form.sync.keep')).click();
  assert.equal(second.app.conflict, false);
  assert.equal(banner(second).hidden, true);
  const copy = saved(storage);
  assert.equal(copy.answers['A.budget'].text, '150.000 kr.');
  assert.equal(copy.answers['A.goal'], undefined, 'the first window\'s answers are replaced');
  assert.equal(copy.revision, 2, 'and the copy is newer than the one the first window knows');
  assert.equal(second.app.refs.top.status.textContent, text('en', 'ui.form.sync.kept'));
  same(second.doc.activeElement, second.app.refs.top.status);
  assert.match(saveLine(second), /^Saved in this browser at /);

  typeInto(part(second, 'A.budget').focus(), '151.000 kr.');
  second.fake.runTimers();
  assert.equal(saved(storage).revision, 3);
  typeInto(part(first, 'A.budget').focus(), '1');
  first.fake.runTimers();
  assert.equal(first.app.conflict, true, 'the first window is asked in its turn');
  assert.equal(saved(storage).answers['A.budget'].text, '151.000 kr.');
});

test('a window with nothing typed since it last read the answers just follows the other window', () => {
  const { storage, first, second } = openedAfterSave();
  typeInto(part(first, 'A.budget').focus(), '150.000 kr.');
  first.fake.runTimers();
  const focused = second.doc.activeElement;
  tellOthers(second);
  assert.equal(second.app.conflict, false, 'no question: there was nothing to lose');
  assert.equal(banner(second).hidden, true);
  assert.equal(second.app.state.answers['A.goal'].text, GOAL);
  assert.equal(second.app.state.answers['A.budget'].text, '150.000 kr.');
  same(second.doc.activeElement, focused, 'the focus is not taken from where it was');
  typeInto(part(second, 'A.budget').focus(), '160.000 kr.');
  second.fake.runTimers();
  assert.equal(saved(storage).answers['A.budget'].text, '160.000 kr.', 'and it saves from there');
  assert.equal(saved(storage).revision, 3);
});

test('moving about the form is not a change: such a window still follows the other one', () => {
  const { first, second } = openedAfterSave();
  second.app.showModule('B', { focus: false });
  typeInto(part(first, 'A.budget').focus(), '10');
  first.fake.runTimers();
  tellOthers(second);
  assert.equal(second.app.conflict, false);
  assert.equal(second.app.state.answers['A.budget'].text, '10');
});

test('an open window notices at once when another window saves, without typing', () => {
  const { first, second } = openTwo({ language: 'en' });
  typeInto(part(second, 'A.budget').focus(), '1');
  answerGoal(first, GOAL);
  first.fake.runTimers();
  assert.equal(second.app.conflict, false);
  tellOthers(second);
  assert.equal(second.app.conflict, true, 'this window has something typed, so it is asked');
  assert.equal(banner(second).hidden, false);
  assert.equal(saveLine(second), text('en', 'ui.form.save.paused'));
  assert.equal(first.app.conflict, false, 'the window that saved is not told about its own save');
  tellOthers(first);
  assert.equal(first.app.conflict, false, 'it holds the copy it wrote');
});

test('a storage event about another key, or from a window that wrote nothing new, changes nothing', () => {
  const { storage, first, second } = openedAfterSave();
  typeInto(part(first, 'A.budget').focus(), '10');
  first.fake.runTimers();
  second.fake.fire('storage', { key: 'something.else' });
  assert.equal(second.app.state.answers['A.budget'], undefined, 'not even looked at');
  tellOthers(second);
  assert.equal(second.app.state.answers['A.budget'].text, '10');
  const before = second.app.state;
  tellOthers(second);
  assert.ok(second.app.state === before, 'the window has the copy that is stored');
  assert.ok(savedText(storage));
});

// ---------------------------------------------------------------------------------------------
// Answers removed in another window

function openedAfterSave() {
  const storage = createMemoryStorage();
  const first = openForm({ language: 'en', storage });
  answerGoal(first, GOAL);
  first.fake.runTimers();
  const second = openForm({ language: 'en', storage });
  assert.equal(second.app.state.answers['A.goal'].text, GOAL);
  return { storage, first, second };
}

test('answers removed in another window are said to be removed, never offered as an empty form', () => {
  const { storage, first, second } = openedAfterSave();
  buttonByText(first.root, text('en', 'ui.form.privacy.clear')).click();
  assert.equal(savedText(storage), null);
  tellOthers(second);
  assert.equal(second.app.syncMode, 'removed');
  assert.equal(second.app.conflict, true);
  assert.equal(bannerText(second), text('en', 'ui.form.sync.removed'));
  assert.deepEqual(bannerButtons(second), [text('en', 'ui.form.sync.keepHere'), text('en', 'ui.form.sync.close')]);
  assert.equal(saveLine(second), text('en', 'ui.form.save.pausedRemoved'));
  same(second.doc.activeElement, banner(second));
  assert.equal(second.app.state.answers['A.goal'].text, GOAL, 'nothing is wiped');
  typeInto(part(second, 'A.budget').focus(), '10');
  second.fake.runTimers();
  assert.equal(savedText(storage), null, 'nothing is written back while the choice is open');
  second.fake.fire('pagehide');
  assert.equal(savedText(storage), null);
});

test('a window that finds the copy gone when it tries to save says "removed", not "changed", and writes nothing', () => {
  const { storage, first, second } = openedAfterSave();
  buttonByText(first.root, text('en', 'ui.form.privacy.clear')).click();
  // No event is sent to the second window: it finds out by trying to save.
  typeInto(part(second, 'A.budget').focus(), '10');
  second.fake.runTimers();
  assert.equal(second.app.syncMode, 'removed');
  assert.equal(bannerText(second), text('en', 'ui.form.sync.removed'));
  assert.equal(saveLine(second), text('en', 'ui.form.save.pausedRemoved'));
  assert.equal(savedText(storage), null);
});

test('"Keep my answers here" saves this window\'s answers again, after the removal', () => {
  const { storage, first, second } = openedAfterSave();
  buttonByText(first.root, text('en', 'ui.form.privacy.clear')).click();
  tellOthers(second);
  buttonByText(banner(second), text('en', 'ui.form.sync.keepHere')).click();
  assert.equal(saved(storage).answers['A.goal'].text, GOAL);
  assert.equal(second.app.conflict, false);
  assert.equal(banner(second).hidden, true);
  assert.equal(second.app.refs.top.status.textContent, text('en', 'ui.form.sync.keptHere'));
  same(second.doc.activeElement, second.app.refs.top.status);
  typeInto(part(second, 'A.budget').focus(), '10');
  second.fake.runTimers();
  assert.equal(saved(storage).answers['A.budget'].text, '10');
});

test('"Close" respects the removal: this window stops keeping answers until the box is ticked', () => {
  const { storage, first, second } = openedAfterSave();
  buttonByText(first.root, text('en', 'ui.form.privacy.clear')).click();
  tellOthers(second);
  buttonByText(banner(second), text('en', 'ui.form.sync.close')).click();
  assert.equal(banner(second).hidden, true);
  assert.equal(second.app.keep, false);
  assert.equal(keepBox(second).checked, false);
  same(second.doc.activeElement, keepBox(second), 'the focus is on the box that can turn it on again');
  assert.equal(saveLine(second), text('en', 'ui.form.save.off'));
  assert.equal(second.app.state.answers['A.goal'].text, GOAL);
  typeInto(part(second, 'A.budget').focus(), '10');
  second.fake.runTimers();
  assert.equal(savedText(storage), null);
  tick(keepBox(second), true);
  assert.equal(saved(storage).answers['A.budget'].text, '10', 'ticking keeps them again');
});

test('a window that was opened empty does not replace saved answers with an empty form without asking', () => {
  const answers = [false, true];
  const asked = [];
  const confirm = (message) => {
    asked.push(message);
    return answers.shift();
  };
  const { storage, first, second } = openTwo({ language: 'en', confirm });
  answerGoal(first, GOAL);
  first.fake.runTimers();
  // The second window has an empty form with one thing changed that is not an answer.
  second.app.setLanguage('da');
  tellOthers(second);
  assert.equal(second.app.syncMode, 'changed', 'the language was changed here, so it is not a window without changes');
  buttonByText(banner(second), text('da', 'ui.form.sync.keep')).click();
  assert.deepEqual(asked, [text('da', 'ui.form.sync.confirmKeepEmpty')]);
  assert.equal(saved(storage).answers['A.goal'].text, GOAL, 'declined: the saved answers are still there');
  buttonByText(banner(second), text('da', 'ui.form.sync.keep')).click();
  assert.equal(saved(storage).answers['A.goal'], undefined, 'accepted: replaced, on purpose');
});

test('"Show the other window\'s answers" keeps the files this window has attached', async () => {
  const { storage, first, second } = openTwo({ language: 'en' });
  const input = inputsOf(part(second, 'B.logo').root, 'file')[0];
  input.files = [fakeFile('logo.svg', LOGO_SVG)];
  input.fire('change');
  await until(() => second.app.state.assets.length === 1, 'the file');
  second.fake.runTimers();
  assert.equal(saved(storage).assets[0].name, 'logo.svg');
  // The first window (it has read no copy yet) is asked, takes the other copy on a click, then saves one more answer.
  tellOthers(first);
  assert.equal(first.app.syncMode, 'changed');
  buttonByText(banner(first), text('en', 'ui.form.sync.show')).click();
  assert.equal(first.app.state.assets[0].data, null, 'the stored copy has no content');
  answerGoal(first, GOAL);
  first.fake.runTimers();
  typeInto(part(second, 'A.budget').focus(), '10');
  tellOthers(second);
  assert.equal(second.app.conflict, true);
  buttonByText(banner(second), text('en', 'ui.form.sync.show')).click();
  assert.equal(second.app.state.answers['A.goal'].text, GOAL);
  assert.equal(second.app.state.assets.length, 1);
  assert.equal(Buffer.from(second.app.state.assets[0].data).toString(), LOGO_SVG, 'the file this window has stays attached');
});

test('a window that was not keeping answers does not write over what is stored: it asks, with or without something typed', () => {
  const storage = storageWithCopy();
  const later = openForm({ language: 'en', storage, protocol: 'file:' });
  assert.equal(later.app.keep, false);
  typeInto(part(later, 'A.budget').focus(), '10');
  tick(keepBox(later), true);
  assert.equal(later.app.syncMode, 'changed', 'it has something typed, so it asks');
  assert.equal(saved(storage).answers['A.goal'].text, GOAL, 'the stored answers are untouched');

  const untouched = openForm({ language: 'en', storage, protocol: 'file:' });
  tick(keepBox(untouched), true);
  assert.equal(untouched.app.syncMode, 'changed', 'ticking the box does not read answers nobody asked to read: the person chooses');
  assert.equal(untouched.app.state.answers['A.goal'], undefined);
  buttonByText(banner(untouched), text('en', 'ui.form.sync.show')).click();
  assert.equal(untouched.app.state.answers['A.goal'].text, GOAL, 'after the click they are read');
  assert.equal(untouched.app.keep, true);
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

test('leaving the page writes nothing when another copy is waiting', () => {
  const { storage: shared, first, second } = openTwo({ language: 'en' });
  answerGoal(first, GOAL);
  first.fake.fire('pagehide');
  const copy = savedText(shared);
  typeInto(part(second, 'A.budget').focus(), '10');
  second.fake.fire('pagehide');
  assert.equal(savedText(shared), copy, 'the second window does not overwrite on its way out');
  assert.equal(second.app.conflict, true, 'it asks instead');
});

// ---------------------------------------------------------------------------------------------
// Answers that would be lost

function tryLeaving(page) {
  let prevented = false;
  page.fake.fire('beforeunload', { preventDefault: () => { prevented = true; }, returnValue: undefined });
  return prevented;
}

test('a page that keeps nothing asks before it is left while answers are not saved in a file', async () => {
  const page = openForm({ language: 'en', storage: createMemoryStorage(), protocol: 'file:' });
  assert.equal(page.fake.listenerCount('beforeunload'), 0, 'nothing answered, nothing at risk');
  assert.equal(tryLeaving(page), false);
  answerGoal(page, GOAL);
  page.fake.runTimers();
  assert.equal(page.fake.listenerCount('beforeunload'), 1, 'the guard is on while answers are at risk');
  assert.equal(tryLeaving(page), true);

  page.app.navItems.get('finish').button.click();
  page.app.refs.finish.download.click();
  await until(() => page.doc.downloads.length === 1, 'the download');
  assert.equal(tryLeaving(page), true, 'a pack cannot be opened here again, so it does not make the answers safe');
  await page.app.exportData();
  assert.equal(page.fake.listenerCount('beforeunload'), 0, 'form data in a file can');
  assert.equal(tryLeaving(page), false);
  page.app.showModule('A', {});
  page.fake.runTimers();
  assert.equal(page.fake.listenerCount('beforeunload'), 0, 'moving about is not a change');

  typeInto(part(page, 'A.budget').focus(), '10');
  page.fake.runTimers();
  assert.equal(page.fake.listenerCount('beforeunload'), 1, 'a change after the file was saved');
  assert.equal(tryLeaving(page), true);
});

test('saving the form data to a file takes the risk away too, and keeping the answers does', async () => {
  const page = openForm({ language: 'en', storage: createMemoryStorage(), protocol: 'file:' });
  answerGoal(page, GOAL);
  page.fake.runTimers();
  assert.equal(tryLeaving(page), true);
  page.app.navItems.get('finish').button.click();
  await page.app.exportData();
  assert.equal(page.fake.listenerCount('beforeunload'), 0);
  assert.equal(tryLeaving(page), false);
  typeInto(part(page, 'A.budget').focus(), '10');
  page.fake.runTimers();
  assert.equal(tryLeaving(page), true);
  tick(keepBox(page), true);
  assert.equal(page.fake.listenerCount('beforeunload'), 0, 'saved in the browser');
  assert.equal(tryLeaving(page), false);
});

test('where answers are saved as they are typed, the page is left without a question, even before the save has run', () => {
  const storage = createMemoryStorage();
  const page = openForm({ language: 'en', storage });
  answerGoal(page, GOAL);
  assert.equal(savedText(storage), null);
  page.app.flush();
  page.fake.runTimers();
  assert.equal(page.fake.listenerCount('beforeunload'), 0, 'saved');
  typeInto(part(page, 'A.budget').focus(), '10');
  page.fake.runTimers();
  assert.equal(page.fake.listenerCount('beforeunload'), 0, 'saved a moment later');
  typeInto(part(page, 'A.budget').focus(), '11');
  page.app.refresh();
  assert.equal(page.fake.listenerCount('beforeunload'), 1, 'the change is not saved yet, so the guard is on');
  assert.equal(tryLeaving(page), false, 'but leaving saves it first, so nothing is lost and nothing is asked');
  assert.equal(saved(storage).answers['A.budget'].text, '11');
  assert.equal(page.fake.listenerCount('beforeunload'), 0);
});

test('a save that fails, or waits for a choice, leaves answers at risk', () => {
  const full = createMemoryStorage();
  const page = openForm({ language: 'en', storage: full });
  full.setItem = () => {
    throw new Error('full');
  };
  answerGoal(page, GOAL);
  page.fake.runTimers();
  assert.equal(saveLine(page), text('en', 'ui.form.save.failed'));
  assert.equal(tryLeaving(page), true, 'a save that failed');

  const { first, second } = openTwo({ language: 'en' });
  answerGoal(first, GOAL);
  first.fake.runTimers();
  typeInto(part(second, 'A.budget').focus(), '10');
  second.fake.runTimers();
  assert.equal(second.app.conflict, true);
  assert.equal(tryLeaving(second), true, 'a save that waits');
});

test('the guard is not left on when the answers are gone, and a page with nothing answered is left freely', () => {
  const page = openForm({ language: 'en', storage: createMemoryStorage(), protocol: 'file:', confirm: () => true });
  answerGoal(page, GOAL);
  page.fake.runTimers();
  assert.equal(page.fake.listenerCount('beforeunload'), 1);
  buttonByText(page.root, text('en', 'ui.form.privacy.clear')).click();
  assert.equal(page.fake.listenerCount('beforeunload'), 0);
  assert.equal(tryLeaving(page), false);
});

// ---------------------------------------------------------------------------------------------
// The storage is read, not written, to find out whether it can be used

test('starting the page writes nothing to the storage, whatever the kind of page', () => {
  for (const protocol of ['https:', 'file:']) {
    const storage = createMemoryStorage();
    const writes = [];
    const setItem = storage.setItem;
    const removeItem = storage.removeItem;
    storage.setItem = (...args) => {
      writes.push(['set', args[0]]);
      return setItem(...args);
    };
    storage.removeItem = (...args) => {
      writes.push(['remove', args[0]]);
      return removeItem(...args);
    };
    openForm({ language: 'en', storage, protocol });
    assert.deepEqual(writes, [], protocol);
  }
});

// ---------------------------------------------------------------------------------------------
// Texts

test('the texts of this behaviour are defined in both languages', () => {
  for (const lang of ['da', 'en']) {
    for (const key of [
      'keep.label', 'keep.labelFile', 'keep.removed', 'keep.stopped', 'save.off', 'save.paused', 'save.pausedRemoved', 'sync.changed', 'sync.removed', 'sync.show', 'sync.keep',
      'sync.keepHere', 'sync.close', 'sync.shown', 'sync.kept', 'sync.keptHere', 'sync.confirmShow', 'sync.confirmKeepEmpty', 'offer.found', 'offer.continue', 'offer.remove', 'offer.removed',
      'finish.removeSaved', 'finish.removeSavedHint',
    ]) {
      assert.ok(data.dictionaries[lang][`ui.form.${key}`], `${lang} ${key}`);
    }
  }
  assert.notEqual(data.dictionaries.en['ui.form.save.paused'], data.dictionaries.en['ui.form.save.pausedRemoved']);
  assert.notEqual(data.dictionaries.en['ui.form.sync.changed'], data.dictionaries.en['ui.form.sync.removed']);
});

test('every button of the notice is reachable and named', () => {
  const { first, second } = openTwo({ language: 'da' });
  typeInto(part(second, 'A.budget').focus(), '1');
  answerGoal(first, 'x');
  first.fake.runTimers();
  tellOthers(second);
  const buttons = findAll(banner(second), (element) => element.localName === 'button');
  assert.deepEqual(buttons.map((button) => button.textContent), [text('da', 'ui.form.sync.show'), text('da', 'ui.form.sync.keep')]);
  assert.equal(banner(second).getAttribute('role'), 'alert');
  assert.equal(banner(second).getAttribute('tabindex'), '-1');
});

test('the notice is drawn again in the other language, with the same question', () => {
  const { first, second } = openTwo({ language: 'en' });
  typeInto(part(second, 'A.budget').focus(), '1');
  answerGoal(first, 'x');
  first.fake.runTimers();
  tellOthers(second);
  second.app.setLanguage('da');
  assert.equal(bannerText(second), text('da', 'ui.form.sync.changed'));
  assert.equal(banner(second).hidden, false);
});
