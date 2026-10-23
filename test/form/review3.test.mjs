// A third round of review. Windows that must wait for the person, answers that must not be lost
// without a question, typed text that must not vanish, files attached again, and the many small
// things around them. Written before the code that makes them pass.

import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';
import { createMemoryStorage, fakeFile, findAll, same, textOf } from './fake-dom.mjs';
import { NOW, TODAY, loadBrowserScript, plain } from './helpers.mjs';
import {
  KEY,
  answerGoal,
  buttonByText,
  data,
  engine,
  hasButton,
  inputsOf,
  library,
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

// Addresses are made when the test runs, so that no address is written in the repository.
const mail = (name, site) => [name, site].join('@');
const GOAL = 'At få flere henvendelser fra private kunder.';
const MIB = 1024 * 1024;
const KEEP_KEY = `${KEY}.keep`;

function banner(page) {
  return page.app.refs.sync.element;
}

function bannerText(page) {
  return textOf(banner(page).children[0]);
}

function tick(box, on) {
  box.checked = on;
  box.fire('change');
}

function keepBox(page) {
  return page.app.refs.keepBox;
}

function tryLeaving(page) {
  let prevented = false;
  page.fake.fire('beforeunload', { preventDefault: () => { prevented = true; }, returnValue: undefined });
  return prevented;
}

// A saved copy, a window that read it (revision above 0) and a second one that wrote it.
function openedAfterSave() {
  const storage = createMemoryStorage();
  const first = openForm({ language: 'en', storage });
  answerGoal(first, GOAL);
  first.fake.runTimers();
  const second = openForm({ language: 'en', storage });
  assert.equal(second.app.state.answers['A.goal'].text, GOAL);
  return { storage, first, second };
}

function storageWithCopy(goal = GOAL) {
  const storage = createMemoryStorage();
  const earlier = openForm({ language: 'en', storage });
  answerGoal(earlier, goal);
  earlier.fake.runTimers();
  return storage;
}

// ---------------------------------------------------------------------------------------------
// M1: what a window shows is only replaced when the person says so

test('a window that shows "removed" keeps its answers when another window writes again, and waits for the person', () => {
  const { storage, first, second } = openedAfterSave();
  buttonByText(second.root, text('en', 'ui.form.privacy.clear')).click();
  tellOthers(first);
  assert.equal(first.app.syncMode, 'removed');
  typeInto(part(second, 'A.budget').focus(), 'Bob');
  second.fake.runTimers();
  assert.ok(savedText(storage), 'the second window has written a copy');
  tellOthers(first);
  assert.equal(first.app.syncMode, 'changed', 'the notice asks about the new copy; nothing was taken over');
  assert.equal(first.app.state.answers['A.goal'].text, GOAL, 'the answers of this window are still there');
  assert.equal(first.app.state.answers['A.budget'], undefined);
  assert.equal(bannerText(first), text('en', 'ui.form.sync.changed'));
  assert.equal(banner(first).hidden, false);
  typeInto(part(first, 'A.business').focus(), 'More');
  first.fake.runTimers();
  assert.equal(saved(storage).answers['A.budget'].text, 'Bob', 'and nothing is written over the other copy');
});

test('the same on a page that is not a web page: "Remove it" in one window, a new copy from another', () => {
  const storage = storageWithCopy();
  const keeper = openForm({ language: 'en', storage, protocol: 'file:' });
  buttonByText(banner(keeper), text('en', 'ui.form.offer.continue')).click();
  assert.equal(keeper.app.state.answers['A.goal'].text, GOAL);
  const other = openForm({ language: 'en', storage, protocol: 'file:' });
  buttonByText(banner(other), text('en', 'ui.form.offer.remove')).click();
  tellOthers(keeper);
  assert.equal(keeper.app.syncMode, 'removed');
  tick(keepBox(other), true);
  typeInto(part(other, 'A.budget').focus(), 'Bob');
  other.fake.runTimers();
  assert.equal(saved(storage).answers['A.budget'].text, 'Bob');
  tellOthers(keeper);
  assert.equal(keeper.app.syncMode, 'changed');
  assert.equal(keeper.app.state.answers['A.goal'].text, GOAL, 'nothing was taken over without a click');
});

test('a window that has not read any copy (number 0 or none) asks, and does not take another copy by itself', () => {
  const { first, second } = openTwo({ language: 'en' });
  answerGoal(first, GOAL);
  first.fake.runTimers();
  tellOthers(second);
  assert.equal(second.app.syncMode, 'changed');
  assert.equal(second.app.state.answers['A.goal'], undefined);
});

test('a window that read a copy and has nothing typed still follows the other window quietly', () => {
  const { storage, first, second } = openedAfterSave();
  typeInto(part(first, 'A.budget').focus(), '150.000 kr.');
  first.fake.runTimers();
  assert.ok(savedText(storage));
  tellOthers(second);
  assert.equal(second.app.syncMode, null);
  assert.equal(second.app.state.answers['A.budget'].text, '150.000 kr.');
});

// ---------------------------------------------------------------------------------------------
// M2: answers that exist only in this window are guarded

test('after keeping is turned off the page asks before it is left, until the answers are exported', async () => {
  const storage = createMemoryStorage();
  const page = openForm({ language: 'en', storage });
  answerGoal(page, GOAL);
  page.fake.runTimers();
  assert.equal(tryLeaving(page), false, 'saved in the browser');
  tick(keepBox(page), false);
  assert.equal(savedText(storage), null);
  assert.equal(page.fake.listenerCount('beforeunload'), 1);
  assert.equal(tryLeaving(page), true, 'now they exist only in this window');
  page.app.navItems.get('finish').button.click();
  await page.app.exportData();
  assert.equal(tryLeaving(page), false, 'the form data file holds them');
  tick(keepBox(page), true);
  assert.equal(tryLeaving(page), false);
  tick(keepBox(page), false);
  assert.equal(tryLeaving(page), false, 'the file still holds them: turning keeping off does not make them lost');
});

test('after another window cleared, turned keeping off or removed the copy, this one asks before it is left', () => {
  const { first, second } = openedAfterSave();
  buttonByText(second.root, text('en', 'ui.form.privacy.clear')).click();
  tellOthers(first);
  assert.equal(first.app.syncMode, 'removed');
  assert.equal(tryLeaving(first), true, 'the copy is gone');

  const again = openedAfterSave();
  tick(keepBox(again.second), false);
  tellOthers(again.first, KEEP_KEY);
  assert.equal(again.first.app.keep, false);
  assert.equal(tryLeaving(again.first), true, 'keeping was stopped by the other window');

  const offered = storageWithCopy();
  const keeper = openForm({ language: 'en', storage: offered, protocol: 'file:' });
  buttonByText(banner(keeper), text('en', 'ui.form.offer.continue')).click();
  assert.equal(tryLeaving(keeper), false);
  const remover = openForm({ language: 'en', storage: offered, protocol: 'file:' });
  buttonByText(banner(remover), text('en', 'ui.form.offer.remove')).click();
  tellOthers(keeper);
  assert.equal(tryLeaving(keeper), true, '"Remove it" in another window');
});

test('closing the notice about removed answers leaves them guarded', () => {
  const { first, second } = openedAfterSave();
  buttonByText(second.root, text('en', 'ui.form.privacy.clear')).click();
  tellOthers(first);
  buttonByText(banner(first), text('en', 'ui.form.sync.close')).click();
  assert.equal(first.app.keep, false);
  assert.equal(tryLeaving(first), true);
});

test('answers that were loaded from a file are safe where the file is, also after keeping is turned off', async () => {
  const page = openForm({ language: 'en', storage: createMemoryStorage() });
  const source = openForm({ language: 'en' });
  answerGoal(source, GOAL);
  const json = JSON.stringify(engine.serializeState(source.app.state, { files: false }));
  await page.app.importFile(fakeFile('form.json', json));
  tick(keepBox(page), false);
  assert.equal(tryLeaving(page), false, 'the file that was loaded still holds them');
});

// ---------------------------------------------------------------------------------------------
// M3: nothing typed disappears without a word

function lost(page, id) {
  return part(page, id).hint.textContent;
}

test('a note without an answer, a date that is not a date and a row with only a note are said to be left out', () => {
  const page = openForm({ language: 'en' });
  // A note on a choice that is not chosen.
  typeInto(findAll(part(page, 'A.project-kind').root, (element) => element.localName === 'textarea')[0], 'Siden er fra 2014.');
  page.app.flush();
  assert.ok(lost(page, 'A.project-kind').includes(text('en', 'ui.form.hint.noteLost')), lost(page, 'A.project-kind'));
  // A note on a date without a date, and a date that is not valid.
  typeInto(findAll(part(page, 'A.deadline').root, (element) => element.localName === 'textarea')[0], 'Før julesalget');
  page.app.flush();
  assert.ok(lost(page, 'A.deadline').includes(text('en', 'ui.form.hint.noteLost')));
  const date = inputsOf(part(page, 'A.deadline').root, 'date')[0];
  date.value = '20266-03-01';
  date.fire('change');
  assert.ok(lost(page, 'A.deadline').includes(text('en', 'ui.form.hint.dateInvalid')), lost(page, 'A.deadline'));
  date.value = '0999-03-01';
  date.fire('change');
  assert.ok(lost(page, 'A.deadline').includes(text('en', 'ui.form.hint.dateInvalid')));
  date.value = '2026-12-01';
  date.fire('change');
  assert.ok(!lost(page, 'A.deadline').includes(text('en', 'ui.form.hint.noteLost')), 'with a date the note goes in');
  assert.ok(!lost(page, 'A.deadline').includes(text('en', 'ui.form.hint.dateInvalid')));
  // A link list row with a note and no link.
  const rows = findAll(part(page, 'E.like').root, (element) => element.localName === 'input' && element.getAttribute('type') === 'text');
  typeInto(rows[1], 'because of the colours');
  page.app.flush();
  assert.ok(lost(page, 'E.like').includes(text('en', 'ui.form.hint.rowLost')), lost(page, 'E.like'));
  typeInto(rows[0], 'https://example.com');
  page.app.flush();
  assert.ok(!lost(page, 'E.like').includes(text('en', 'ui.form.hint.rowLost')));
});

test('what is left out is also listed at the end, under what to check, and no longer when it is fixed', () => {
  const page = openForm({ language: 'en' });
  typeInto(findAll(part(page, 'A.project-kind').root, (element) => element.localName === 'textarea')[0], 'Siden er fra 2014.');
  page.app.navItems.get('finish').button.click();
  const checks = textOf(page.app.refs.finish.checksList);
  assert.ok(checks.includes(text('en', 'q.A.project-kind.label')));
  assert.ok(checks.includes(text('en', 'ui.form.hint.noteLost')), checks);
  const kinds = inputsOf(part(page, 'A.project-kind').root, 'radio');
  kinds[1].checked = true;
  kinds[1].fire('change');
  assert.ok(!textOf(page.app.refs.finish.checksList).includes(text('en', 'ui.form.hint.noteLost')));
});

test('a due date that is not a date is said to be left out too, and a hidden question says nothing', () => {
  const page = openForm({ language: 'en' });
  const toggle = part(page, 'A.stakeholders').toggle;
  toggle.checked = true;
  toggle.fire('change');
  const due = findAll(part(page, 'A.stakeholders').root, (element) => element.localName === 'input' && element.getAttribute('type') === 'date')[0];
  due.value = '20266-03-01';
  due.fire('change');
  assert.ok(lost(page, 'A.stakeholders').includes(text('en', 'ui.form.hint.dateInvalid')), lost(page, 'A.stakeholders'));
  assert.deepEqual(plain(engine.unusedInputs(page.app.state, page.app.analysis.report).filter((entry) => entry.id === 'A.stakeholders').map((entry) => entry.kind)), ['date']);
});

test('the engine names every kind of typed text that the pack leaves out', () => {
  const state = engine.newState({ language: 'en', now: NOW });
  engine.record(state, 'A.project-kind').note = 'a note';
  engine.record(state, 'A.deadline').note = 'another note';
  engine.record(state, 'A.deadline').date = '20266-03-01';
  engine.record(state, 'E.like').items = [{ text: '', note: 'only a note' }, { text: 'https://example.com', note: '' }];
  const report = engine.analyze(state, { now: NOW }).report;
  const kinds = plain(engine.unusedInputs(state, report).map((entry) => `${entry.id}:${entry.kind}`)).sort();
  assert.deepEqual(kinds, ['A.deadline:date', 'A.deadline:note', 'A.project-kind:note', 'E.like:row']);
  engine.record(state, 'A.project-kind').choice = ['redesign'];
  engine.record(state, 'A.deadline').date = '2026-12-01';
  engine.record(state, 'E.like').items = [{ text: 'https://example.com', note: 'only a note' }];
  assert.deepEqual(plain(engine.unusedInputs(state, engine.analyze(state, { now: NOW }).report)), []);
});

// ---------------------------------------------------------------------------------------------
// L1: a file attached again fills the entry that has no content

test('a file attached again takes the place of the entry without content, with its description', async () => {
  const storage = createMemoryStorage();
  const first = openForm({ language: 'en', storage });
  const input = inputsOf(part(first, 'B.logo').root, 'file')[0];
  input.files = [fakeFile('logo.png', 'png bytes')];
  input.fire('change');
  await until(() => first.app.state.assets.length === 1, 'the file');
  first.app.state.assets[0].what = 'Hovedlogo';
  first.fake.runTimers();
  const next = openForm({ language: 'en', storage });
  assert.equal(next.app.state.assets[0].data, null);
  const again = inputsOf(part(next, 'B.logo').root, 'file')[0];
  again.files = [fakeFile('logo.png', 'png bytes')];
  again.fire('change');
  await until(() => next.app.state.assets[0].data !== null, 'the content');
  assert.equal(next.app.state.assets.length, 1, 'no second card');
  assert.equal(next.app.state.assets[0].name, 'logo.png', 'not logo-2.png');
  assert.equal(next.app.state.assets[0].what, 'Hovedlogo', 'the description is kept');
  assert.equal(next.app.state.assets[0].renamedFrom, '');
  assert.deepEqual(plain(next.app.analysis.lacking), []);
  assert.equal(findAll(part(next, 'B.logo').root, (element) => element.className === 'asset').length, 1);
});

test('a file of another size is a different file, and the entry without content stays until it is dealt with', async () => {
  const state = engine.newState({ language: 'en', now: NOW });
  const old = engine.addAsset(state, 'B.logo', { name: 'logo.png', data: new Uint8Array(5) });
  old.data = null;
  const same5 = engine.addAsset(state, 'B.logo', { name: 'logo.png', data: new Uint8Array(5) });
  assert.equal(same5, old, 'the same name and size fills the entry');
  assert.equal(state.assets.length, 1);
  const bigger = engine.addAsset(state, 'B.logo', { name: 'logo.png', data: new Uint8Array(9) });
  assert.notEqual(bigger, old);
  assert.equal(bigger.name, 'logo-2.png');
  const other = engine.addAsset(state, 'A.goal'.replace('A.goal', 'B.logo'), { name: 'LOGO.PNG', data: new Uint8Array(5) });
  assert.notEqual(other, old, 'an entry that already has its content is never filled again');
});

test('after loading form data that was made without the files, attaching them fills the entries', async () => {
  const state = engine.newState({ language: 'en', now: NOW });
  const asset = engine.addAsset(state, 'B.logo', { name: 'film.mov', data: { length: 300 * MIB } });
  asset.what = 'Film';
  const plan = await engine.exportPlan(state, '2026-10-23T12:00:00Z');
  const page = openForm({ language: 'en' });
  await page.app.importFile(fakeFile('form.json', plan.parts.join('')));
  assert.equal(page.app.state.assets[0].data, null);
  const elsewhere = engine.addAsset(page.app.state, 'B.logo', { name: 'film.mov', data: new Uint8Array(3) });
  assert.notEqual(elsewhere, page.app.state.assets[0], 'a file of another size is another file');
  assert.equal(page.app.state.assets.length, 2);
  const filled = engine.addAsset(page.app.state, 'B.logo', { name: 'FILM.mov', data: { length: 300 * MIB } });
  assert.equal(filled, page.app.state.assets[0], 'the same name (also in other letters) and size fills the entry');
  assert.equal(filled.what, 'Film');
  assert.equal(page.app.state.assets.length, 2);
});

// ---------------------------------------------------------------------------------------------
// L2: nothing is taken over by ticking the box, and a loaded recipient is checked

test('ticking the box on a page that is not a web page does not take over a copy that was not offered a click', () => {
  const storage = createMemoryStorage();
  const planted = {
    ...engine.serializeState(engine.newState({ language: 'en', now: NOW }), { files: false, savedAt: '2026-10-23T12:00:00Z', revision: 4, writeId: 'abc123' }),
    recipient: mail('payments', 'attacker.example'),
  };
  storage.setItem(KEY, JSON.stringify(planted));
  const page = openForm({ language: 'en', storage, protocol: 'file:' });
  assert.equal(page.app.syncMode, 'offer');
  tick(keepBox(page), true);
  assert.equal(page.app.state.recipient, '', 'the recipient of a copy nobody asked for is not taken');
  assert.equal(page.app.syncMode, 'changed', 'the person is asked');
  assert.equal(saved(storage).recipient, mail('payments', 'attacker.example'), 'and nothing is written over it');
});

test('a recipient that comes from saved or loaded data is shown at the end to be checked, once', async () => {
  const storage = storageWithCopy();
  const saved1 = JSON.parse(savedText(storage));
  saved1.recipient = mail('team', 'example.org');
  storage.setItem(KEY, JSON.stringify(saved1));
  const page = openForm({ language: 'en', storage });
  page.app.navItems.get('finish').button.click();
  const finish = page.app.refs.finish;
  assert.equal(finish.recipientCheck.hidden, false);
  assert.ok(finish.recipientCheck.textContent.includes(text('en', 'ui.form.finish.checkRecipient', { recipient: mail('team', 'example.org') })));
  assert.ok(hasButton(finish.recipientCheck, text('en', 'ui.form.finish.recipientRight')));
  buttonByText(finish.recipientCheck, text('en', 'ui.form.finish.recipientRight')).click();
  assert.equal(finish.recipientCheck.hidden, true);
  page.app.showModule('A', {});
  page.app.navItems.get('finish').button.click();
  assert.equal(page.app.refs.finish.recipientCheck.hidden, true, 'it stays confirmed');

  const typed = openForm({ language: 'en' });
  answerGoal(typed);
  typeInto(findAll(typed.root, (element) => element.id === 'recipient')[0], mail('me', 'example.org'));
  typed.app.navItems.get('finish').button.click();
  assert.equal(typed.app.refs.finish.recipientCheck.hidden, true, 'what the person typed here is not asked about');

  const imported = openForm({ language: 'en' });
  const json = JSON.stringify({ ...engine.serializeState(engine.newState({ language: 'en', now: NOW }), { files: false }), recipient: mail('boss', 'example.org') });
  await imported.app.importFile(fakeFile('form.json', json));
  imported.app.navItems.get('finish').button.click();
  assert.equal(imported.app.refs.finish.recipientCheck.hidden, false);
  typeInto(findAll(imported.root, (element) => element.id === 'recipient')[0], mail('other', 'example.org'));
  imported.app.flush();
  assert.equal(imported.app.refs.finish.recipientCheck.hidden, true, 'a new recipient typed here is the person\'s own');
});

// ---------------------------------------------------------------------------------------------
// L3: copies are only set aside when they are damaged, not when the engine fails

test('saved answers that are fine are left alone when the engine fails on them, and the page offers them', () => {
  const storage = storageWithCopy();
  const copy = savedText(storage);
  // The page fails when it looks at the files of the schema, from the moment the saved copy is read.
  const failing = JSON.parse(JSON.stringify(data));
  const files = failing.schema.files;
  let armed = false;
  Object.defineProperty(failing.schema, 'files', { get() { if (armed) throw new Error('the page fails here'); return files; }, enumerable: true });
  const getItem = storage.getItem;
  storage.getItem = (key) => {
    if (key === KEY) armed = true;
    return getItem(key);
  };
  const silent = console.error;
  console.error = () => {};
  let page;
  try {
    page = openForm({ language: 'en', storage, data: failing });
  } finally {
    console.error = silent;
  }
  assert.equal(savedText(storage), copy, 'the copy is where it was');
  assert.equal(storage.getItem(`${KEY}.broken`), null, 'and nothing was set aside');
  assert.equal(page.app.keep, false, 'nothing is written over it');
  assert.equal(page.app.syncMode, 'offer');
  armed = false;
  typeInto(part(page, 'A.budget').focus(), '10');
  page.fake.runTimers();
  assert.equal(savedText(storage), copy);
});

test('saved answers that are damaged are still set aside', () => {
  const storage = createMemoryStorage();
  storage.setItem(KEY, '{"format":"everything-mapped-form/1","answers":"nope"}');
  const page = openForm({ language: 'en', storage });
  assert.equal(savedText(storage), null);
  assert.ok(storage.getItem(`${KEY}.broken`));
  assert.equal(page.app.refs.top.alert.textContent, text('en', 'ui.form.save.broken'));
});

test('the button that clears saved data when the form cannot start asks first', async () => {
  const html = (await import('./helpers.mjs')).readFormHtml();
  const rescue = (await import('./helpers.mjs')).extractScripts(html)[0];
  const vm = await import('node:vm');
  const { FakeDocument, createFakeWindow } = await import('./fake-dom.mjs');
  for (const answer of [false, true]) {
    const doc = new FakeDocument();
    const config = doc.createElement('script');
    config.setAttribute('id', 'emfc-config');
    config.textContent = JSON.stringify({ storageKey: KEY });
    const failed = doc.createElement('div');
    failed.setAttribute('id', 'emfc-failed');
    const button = doc.createElement('button');
    button.className = 'btn emfc-discard';
    button.setAttribute('data-confirm', 'Delete all saved answers?');
    failed.appendChild(button);
    doc.body.appendChild(config);
    doc.body.appendChild(failed);
    const storage = createMemoryStorage();
    storage.setItem(KEY, 'x');
    storage.setItem(KEEP_KEY, '0');
    const asked = [];
    const fake = createFakeWindow({ storage, confirm: (message) => { asked.push(message); return answer; } });
    vm.runInNewContext(rescue, { document: doc, window: fake.win });
    button.click();
    assert.deepEqual(asked, ['Delete all saved answers?']);
    assert.equal(storage.getItem(KEY), answer ? null : 'x');
    assert.equal(storage.getItem(KEEP_KEY), answer ? null : '0', 'the choice not to keep goes with the answers');
    assert.equal(fake.win.reloads, answer ? 1 : 0);
  }
});

// ---------------------------------------------------------------------------------------------
// L4: the original goes only after the copy that is set aside was written

test('a damaged copy stays where it is when there is no room to set it aside', () => {
  const storage = createMemoryStorage();
  const damaged = '{"format":"everything-mapped-form/1","answers":"nope"}';
  storage.setItem(KEY, damaged);
  const setItem = storage.setItem;
  storage.setItem = (key, value) => {
    if (key.endsWith('.broken')) throw new Error('over the quota');
    return setItem(key, value);
  };
  openForm({ language: 'en', storage });
  assert.equal(savedText(storage), damaged, 'the original is not removed');
  assert.equal(storage.getItem(`${KEY}.broken`), null);
});

// ---------------------------------------------------------------------------------------------
// L5: a pack cannot be loaded back

test('downloading a pack does not make the answers safe, saving the form data does, and the text says why', async () => {
  const page = openForm({ language: 'en', storage: createMemoryStorage(), protocol: 'file:' });
  answerGoal(page, GOAL);
  page.fake.runTimers();
  page.app.navItems.get('finish').button.click();
  page.app.refs.finish.download.click();
  await until(() => page.doc.downloads.length === 1, 'the download');
  assert.equal(tryLeaving(page), true, 'a pack cannot be opened here again');
  await page.app.exportData();
  assert.equal(tryLeaving(page), false);
  assert.doesNotMatch(data.dictionaries.en['ui.form.finish.intro'], /come back to change things/);
  assert.match(data.dictionaries.en['ui.form.finish.intro'], /cannot be opened here again/);
  assert.doesNotMatch(data.dictionaries.da['ui.form.finish.intro'], /vende tilbage for at rette/);
  assert.match(data.dictionaries.da['ui.form.finish.intro'], /kan ikke åbnes her igen/);
});

// ---------------------------------------------------------------------------------------------
// L6: the list of files must fit in an answer

test('a file is refused at attaching when the list of files would not fit in an answer, and the message is about files', () => {
  const state = engine.newState({ language: 'en', now: NOW });
  const long = (index) => `${'n'.repeat(90)}-${index}.png`;
  let accepted = 0;
  for (;;) {
    const problem = engine.attachmentProblem(state, { name: long(accepted), size: 1 }, 0, 'B.logo');
    if (problem) {
      assert.equal(problem.key, 'ui.form.files.listFull');
      assert.equal(problem.params.name, long(accepted));
      break;
    }
    state.assets.push({ id: `a${accepted + 1}`, qid: 'B.logo', name: long(accepted), renamedFrom: '', what: '', owner: '', rights: '', restrictions: '', size: 1, data: new Uint8Array(1) });
    accepted += 1;
    assert.ok(accepted < library.MAX_ATTACHMENTS, 'the list of files fills up before the files do');
  }
  const body = state.assets.map((asset) => `- assets/${asset.name}`).join('\n').length;
  assert.ok(body <= library.MAX_BODY_CHARS && body > library.MAX_BODY_CHARS - 6000, `${body} characters in a list that may have ${library.MAX_BODY_CHARS}`);
  // Another question has a list of its own.
  assert.equal(engine.attachmentProblem(state, { name: 'x.png', size: 1 }, 0, 'F.photos'), null);
});

test('a list of files that has grown too long through its descriptions says so in words about files', () => {
  const page = openForm({ language: 'en' });
  answerGoal(page, GOAL);
  const state = page.app.state;
  state.assets = Array.from({ length: 450 }, (unused, index) => ({ id: `a${index + 1}`, qid: 'B.logo', name: `${'f'.repeat(90)}-${index}.png`, renamedFrom: '', what: 'd'.repeat(480), owner: '', rights: 'ours', restrictions: '', size: 1, data: new Uint8Array(1) }));
  page.app.refresh();
  const problems = page.app.analysis.problems.filter((problem) => problem.params.id === 'B.logo');
  assert.equal(problems.length, 1);
  assert.ok(part(page, 'B.logo').hint.textContent.includes(text('en', 'ui.form.problem.filesTooLong')), part(page, 'B.logo').hint.textContent);
  assert.ok(!part(page, 'B.logo').hint.textContent.includes('Split the text'));
  page.app.navItems.get('finish').button.click();
  assert.ok(textOf(page.app.refs.finish.checksList).includes(text('en', 'ui.form.problem.filesTooLong')));
});

// ---------------------------------------------------------------------------------------------
// L7: moving about does not make a new copy, and an idle window keeps its place

test('moving about the form writes the place without a new number, and no other window is told of a new copy', () => {
  const { storage, first, second } = openedAfterSave();
  const before = saved(storage);
  first.app.showModule('C', {});
  first.fake.runTimers();
  const after = saved(storage);
  assert.equal(after.revision, before.revision, 'the same copy');
  assert.equal(after.writeId, before.writeId);
  assert.equal(after.currentModule, 'C', 'but with the place');
  tellOthers(second);
  assert.equal(second.app.syncMode, null);
  assert.equal(second.app.state.currentModule, 'A', 'the other window did not jump along');
  typeInto(part(first, 'A.budget').focus(), '10');
  first.fake.runTimers();
  assert.equal(saved(storage).revision, before.revision + 1, 'a change makes a new number');
});

test('a window that follows another keeps its own place and its focus', () => {
  const { first, second } = openedAfterSave();
  second.app.showModule('D', {});
  const field = second.doc.getElementById('f-A.budget-input');
  field.focus();
  typeInto(part(first, 'A.budget').focus(), '10');
  first.fake.runTimers();
  tellOthers(second);
  assert.equal(second.app.state.answers['A.budget'].text, '10');
  assert.equal(second.app.state.currentModule, 'D', 'the place of this window, not the other one\'s');
  assert.equal(second.app.sections.get('D').section.hidden, false);
  assert.equal(second.app.sections.get('A').section.hidden, true);
  same(second.doc.activeElement, second.doc.getElementById('f-A.budget-input'), 'the field that had the focus has it again');
});

// ---------------------------------------------------------------------------------------------
// L8: the notice does not take the focus from a field that is being typed in

test('a notice that appears while a field has the focus leaves the focus where it is', () => {
  const { first, second } = openTwo({ language: 'en' });
  const field = part(second, 'A.budget').focus();
  typeInto(field, '1');
  second.doc.activeElement = field;
  answerGoal(first, GOAL);
  first.fake.runTimers();
  tellOthers(second);
  assert.equal(second.app.syncMode, 'changed');
  same(second.doc.activeElement, field, 'the keys the person types still go to the field');
  assert.equal(banner(second).getAttribute('role'), 'alert', 'a screen reader still hears it');

  const spare = openTwo({ language: 'en' });
  typeInto(part(spare.second, 'A.budget').focus(), '1');
  spare.second.doc.activeElement = spare.second.app.refs.panel.save;
  answerGoal(spare.first, GOAL);
  spare.first.fake.runTimers();
  tellOthers(spare.second);
  same(spare.second.doc.activeElement, banner(spare.second), 'when no field has the focus the notice takes it');
});

// ---------------------------------------------------------------------------------------------
// L9: the warning about a large pack is about the size of the zip

test('a pack that is large before it is zipped but small as a zip is not called large', async () => {
  const loader = loadBrowserScript({ crypto: webcrypto });
  const state = loader.engine.newState({ language: 'en', now: NOW });
  loader.engine.record(state, 'A.goal').text = GOAL;
  const same1 = new Uint8Array(MIB);
  for (let index = 0; index < 60; index += 1) loader.engine.addAsset(state, 'B.logo', { name: `f${index}.bin`, data: same1 }).rights = 'ours';
  const small = async () => [new Uint8Array(6000)];
  const pack = await loader.engine.buildPack(state, { now: NOW, today: TODAY, compress: small });
  assert.ok(pack.totalBytes > 50 * MIB);
  assert.ok(pack.size < 5 * MIB);
  assert.equal(pack.large, false);
  const stored = await loader.engine.buildPack(state, { now: NOW, today: TODAY, compress: false });
  assert.equal(stored.large, true, 'stored as it is, the zip really is large');
});

// ---------------------------------------------------------------------------------------------
// L10: numbering names is not quadratic

test('thousands of files with the same name are numbered in a moment', () => {
  const raw = engine.serializeState(engine.newState({ language: 'en', now: NOW }), { files: false });
  const record = (name, index) => ({ id: `a${index}`, qid: 'B.logo', name, renamedFrom: '', what: '', owner: '', rights: '', restrictions: '', size: 1 });
  raw.assets = Array.from({ length: library.MAX_ATTACHMENTS }, (unused, index) => record('a.png', index));
  const started = Date.now();
  const result = engine.restoreState(JSON.parse(JSON.stringify(raw)));
  const first = Date.now() - started;
  assert.ok(first < 1500, `${first} ms`);
  const names = plain(result.state.assets.map((asset) => asset.name));
  assert.equal(names[0], 'a.png');
  assert.equal(names[1], 'a-2.png');
  assert.equal(names[library.MAX_ATTACHMENTS - 1], `a-${library.MAX_ATTACHMENTS}.png`);
  assert.equal(new Set(names.map((name) => library.foldPackName(name))).size, library.MAX_ATTACHMENTS);

  const long = 'x'.repeat(100);
  raw.assets = Array.from({ length: 2000 }, (unused, index) => record(`${long}.png`, index));
  const second = Date.now();
  const again = engine.restoreState(JSON.parse(JSON.stringify(raw)));
  assert.ok(Date.now() - second < 1500, `${Date.now() - second} ms for 100-character names`);
  assert.equal(new Set(again.state.assets.map((asset) => library.foldPackName(asset.name))).size, 2000);
  assert.ok(again.state.assets.every((asset) => library.assetNameProblem(asset.name, 'docs/assets') === ''));
});

test('numbering does not take a name that is already there, whatever order the names come in', () => {
  const taken = new Set();
  const names = ['a-2.png', 'a.png', 'a.png', 'a.png', 'A-3.PNG', 'a.png'];
  const made = names.map((name) => {
    const result = library.safeAssetName(name, taken, 'docs/assets');
    taken.add(library.foldPackName(result));
    return result;
  });
  assert.equal(new Set(made.map((name) => library.foldPackName(name))).size, names.length);
  assert.equal(made[0], 'a-2.png');
  assert.equal(made[1], 'a.png');
});

// ---------------------------------------------------------------------------------------------
// L11: attaching a file during an export

test('a file attached while the form data is being made does not spoil it, and an unexpected failure is not called "too large"', async () => {
  const page = openForm({ language: 'en' });
  answerGoal(page, GOAL);
  page.app.state.assets = [
    { id: 'a1', qid: 'B.logo', name: 'one.bin', renamedFrom: '', what: '', owner: '', rights: '', restrictions: '', size: 12 * MIB, data: new Uint8Array(12 * MIB) },
  ];
  let attached = false;
  const plan = await engine.exportPlan(page.app.state, '2026-10-23T12:00:00Z', {
    yieldToPage: async () => {
      if (attached) return;
      attached = true;
      page.app.state.assets.push({ id: 'a2', qid: 'B.logo', name: 'two.bin', renamedFrom: '', what: '', owner: '', rights: '', restrictions: '', size: 1, data: new Uint8Array(1) });
    },
  });
  assert.equal(attached, true);
  const back = engine.restoreState(JSON.parse(plan.parts.join('')));
  assert.deepEqual(plain(back.state.assets.map((asset) => asset.name)), ['one.bin'], 'what was there when the export began');

  const failing = openForm({ language: 'en' });
  answerGoal(failing, GOAL);
  failing.app.engine.exportPlan = async () => {
    throw new TypeError('something odd');
  };
  const silent = console.error;
  console.error = () => {};
  try {
    await failing.app.exportData();
  } finally {
    console.error = silent;
  }
  assert.equal(failing.app.refs.finish.notices.alert.textContent, text('en', 'ui.form.err.unexpected'));
  const big = openForm({ language: 'en' });
  big.app.engine.exportPlan = async () => {
    throw new RangeError('Invalid string length');
  };
  console.error = () => {};
  try {
    await big.app.exportData();
  } finally {
    console.error = silent;
  }
  assert.equal(big.app.refs.finish.notices.alert.textContent, text('en', 'ui.form.err.exportTooLarge'));
});

// ---------------------------------------------------------------------------------------------
// The keys the page writes and the keys its buttons delete

test('the keys the page ever writes are the keys that "Clear saved data" deletes', () => {
  const storage = createMemoryStorage();
  const writes = new Set();
  const setItem = storage.setItem;
  storage.setItem = (key, value) => {
    writes.add(key);
    return setItem(key, value);
  };
  const page = openForm({ language: 'en', storage });
  answerGoal(page, GOAL);
  page.fake.runTimers();
  tick(keepBox(page), false);
  tick(keepBox(page), true);
  tick(keepBox(page), false);
  assert.deepEqual([...writes].sort(), [KEEP_KEY, KEY].sort(), 'the answers and the choice not to keep');
  storage.setItem(`${KEY}.broken`, 'x');
  storage.setItem('emfc.form.v1', 'x');
  buttonByText(page.root, text('en', 'ui.form.privacy.clear')).click();
  assert.deepEqual([...storage.data.keys()], [], 'nothing of the page is left');
});

test('turning keeping off keeps the choice, and the text says that a web address starts ticked unless it was turned off', () => {
  assert.match(data.dictionaries.en['ui.form.privacy.text'], /it starts ticked, unless you turned it off,/);
  assert.match(data.dictionaries.da['ui.form.privacy.text'], /starter den med hak, medmindre du har slået det fra,/);
  assert.match(data.dictionaries.en['ui.form.privacy.text'], /every page on the same web site could read them/);
  assert.match(data.dictionaries.da['ui.form.privacy.text'], /alle sider på samme websted kan læse dem/);
});

test('a "Continue" that fails on a page that keeps nothing writes nothing, and the unreadable data can still be downloaded', () => {
  const storage = createMemoryStorage();
  const damaged = '{"format":"everything-mapped-form/1","answers":"nope"}';
  storage.setItem(KEY, damaged);
  const writes = [];
  const setItem = storage.setItem;
  storage.setItem = (key, value) => {
    writes.push(key);
    return setItem(key, value);
  };
  const page = openForm({ language: 'en', storage, protocol: 'file:' });
  buttonByText(banner(page), text('en', 'ui.form.offer.continue')).click();
  assert.deepEqual(writes, []);
  assert.equal(savedText(storage), damaged);
  assert.equal(page.app.refs.top.alert.textContent, text('en', 'ui.form.offer.unreadable'));
  assert.ok(hasButton(page.root, text('en', 'ui.form.privacy.downloadBroken')));
  assert.equal(page.app.syncMode, 'offer', 'the choice is still there');
  buttonByText(banner(page), text('en', 'ui.form.offer.remove')).click();
  assert.equal(savedText(storage), null);
});
