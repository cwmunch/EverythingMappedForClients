// The limits of the form, kept the same everywhere: the export of form data never goes over what
// the loader accepts, files and list rows have one limit each, a pack that cannot fit is refused
// when a file is attached, and a big pack gives the page its turns.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import { fakeFile, findAll, textOf } from './fake-dom.mjs';
import { NOW, TODAY, loadBrowserScript, plain, unzipPack } from './helpers.mjs';
import {
  KEY,
  buttonByText,
  data,
  engine,
  inputsOf,
  library,
  openForm,
  part,
  text,
  typeInto,
  until,
} from './page-helpers.mjs';

const MIB = 1024 * 1024;
const GOAL = 'At få flere henvendelser fra private kunder.';

function newState(language = 'en') {
  return engine.newState({ language, now: NOW });
}

// An attached file that only claims to be `bytes` long. Nothing reads it (the export without files
// and the checks of sizes look at its length only), so a test can speak of hundreds of megabytes.
function claimedFile(state, name, bytes, qid = 'B.logo') {
  return engine.addAsset(state, qid, { name, data: { length: bytes } });
}

function joined(plan) {
  return plan.parts.join('');
}

// ---------------------------------------------------------------------------------------------
// M3: the form data file is never more than the loader takes

test('files that would make the form data unloadable are left out of it, and the answers are kept', () => {
  const state = newState('da');
  engine.record(state, 'A.goal').text = GOAL;
  claimedFile(state, 'film.mov', 160 * MIB).what = 'Film';
  claimedFile(state, 'scan.tif', 145 * MIB);
  const base64 = 4 * Math.ceil((160 * MIB) / 3) + 4 * Math.ceil((145 * MIB) / 3);
  assert.ok(base64 > library.IMPORT_MAX_BYTES, 'as it was: the file would be over what the loader accepts');
  const plan = engine.exportPlan(state, '2026-10-23T12:00:00Z');
  assert.equal(plan.withFiles, false);
  assert.deepEqual(plain(plan.reattach), ['film.mov', 'scan.tif']);
  assert.ok(plan.bytes < MIB, 'a few kilobytes of answers and the list');
  assert.ok(plan.bytes <= library.IMPORT_MAX_BYTES);
  const result = engine.parseSavedText(joined(plan));
  assert.equal(result.ok, true, 'the loader accepts it');
  assert.equal(result.state.answers['A.goal'].text, GOAL, 'the answers are there');
  assert.deepEqual(plain(result.state.assets.map((asset) => [asset.name, asset.what, asset.size, asset.data])), [
    ['film.mov', 'Film', 160 * MIB, null],
    ['scan.tif', '', 145 * MIB, null],
  ]);
  assert.deepEqual(plain(result.notes.reattach), ['film.mov', 'scan.tif'], 'and the loader names the files to attach again');
});

test('files that fit are exported with their content, and a file without content is named', () => {
  const state = newState();
  engine.record(state, 'A.goal').text = GOAL;
  engine.addAsset(state, 'B.logo', { name: 'logo.svg', data: new Uint8Array([1, 2, 3]) });
  const whole = engine.exportPlan(state, '2026-10-23T12:00:00Z');
  assert.equal(whole.withFiles, true);
  assert.deepEqual(plain(whole.reattach), []);
  assert.equal(Buffer.from(engine.parseSavedText(joined(whole)).state.assets[0].data).toString('hex'), '010203');

  const lost = engine.addAsset(state, 'B.logo', { name: 'gone.png', data: new Uint8Array(1) });
  lost.data = null;
  const missing = engine.exportPlan(state, '2026-10-23T12:00:00Z');
  assert.equal(missing.withFiles, true, 'the file that is there still goes in');
  assert.deepEqual(plain(missing.reattach), ['gone.png']);
});

test('a file of exactly the budget is the edge: one byte more and the files stay out', () => {
  const state = newState();
  // 225 MB of bytes make exactly 300 MB of base64, which is the budget; one byte more is over it.
  assert.equal(4 * Math.ceil((225 * MIB) / 3), library.EXPORT_FILES_BUDGET);
  claimedFile(state, 'edge.bin', 225 * MIB + 1);
  const plan = engine.exportPlan(state, '2026-10-23T12:00:00Z');
  assert.equal(plan.withFiles, false);
  assert.deepEqual(plain(plan.reattach), ['edge.bin']);
});

test('the list of files and the answers alone, at their largest, are far below what the loader takes', () => {
  const state = newState();
  const quote = '"';
  for (const question of engine.ordered) {
    const record = engine.record(state, question.id);
    if (question.type === 'text') record.text = quote.repeat(library.LIMITS.line.max);
    if (question.type === 'longtext') record.text = quote.repeat(library.LIMITS.block.max);
    if (question.type === 'list' || question.type === 'urllist') {
      record.items = Array.from({ length: library.MAX_ROWS }, () => ({ text: quote.repeat(library.LIMITS.item.max), note: quote.repeat(library.LIMITS.item.max) }));
    }
  }
  state.assets = Array.from({ length: library.MAX_ATTACHMENTS }, (unused, index) => ({
    id: `a${index + 1}`,
    qid: 'B.logo',
    name: `${'n'.repeat(90)}-${index}.txt`,
    renamedFrom: '',
    what: quote.repeat(library.LIMITS.asset.max),
    owner: quote.repeat(library.LIMITS.asset.max),
    rights: quote.repeat(library.LIMITS.asset.max),
    restrictions: quote.repeat(library.LIMITS.asset.max),
    size: 1,
    data: null,
  }));
  const plan = engine.exportPlan(state, '2026-10-23T12:00:00Z');
  assert.ok(plan.bytes < library.IMPORT_MAX_BYTES - library.EXPORT_FILES_BUDGET, `${plan.bytes} bytes`);
  assert.equal(engine.restoreState(JSON.parse(joined(plan))).ok, true);
});

test('the page saves form data without the files, says which to attach again, and the loader says it too', async () => {
  const page = openForm({ language: 'en' });
  typeInto(part(page, 'A.goal').focus(), GOAL);
  const input = inputsOf(part(page, 'B.logo').root, 'file')[0];
  input.files = [fakeFile('film.mov', 'x'), fakeFile('scan.tif', 'y')];
  input.fire('change');
  await until(() => page.app.state.assets.length === 2, 'the files');
  for (const asset of page.app.state.assets) asset.data = { length: 160 * MIB };
  page.app.exportData();
  const notice = page.app.refs.finish.notices.status.textContent;
  assert.equal(notice, text('en', 'ui.form.finish.exportedNoFiles', { names: 'film.mov, scan.tif' }));
  assert.equal(page.doc.downloads.length, 1);
  const blob = page.fake.blobs.get(page.doc.downloads[0].href);
  const fileText = blob.parts.join('');

  const next = openForm({ language: 'en' });
  const file = fakeFile('form.json', fileText);
  await next.app.importFile(file);
  assert.equal(next.app.state.answers['A.goal'].text, GOAL);
  assert.equal(next.app.refs.top.status.textContent, `${text('en', 'ui.form.import.done')} ${text('en', 'ui.form.import.reattach', { names: 'film.mov, scan.tif' })}`);
  const cards = findAll(part(next, 'B.logo').root, (element) => element.className === 'asset');
  assert.equal(cards.length, 2);
  assert.ok(cards.every((card) => textOf(card).includes(text('en', 'ui.form.files.noData'))));
});

test('the page names a file that is not on it when form data is saved with the others', async () => {
  const page = openForm({ language: 'da' });
  typeInto(part(page, 'A.goal').focus(), GOAL);
  const input = inputsOf(part(page, 'B.logo').root, 'file')[0];
  input.files = [fakeFile('logo.svg', 'x'), fakeFile('kort.png', 'y')];
  input.fire('change');
  await until(() => page.app.state.assets.length === 2, 'the files');
  page.app.state.assets[1].data = null;
  page.app.exportData();
  assert.equal(page.app.refs.finish.notices.status.textContent, text('da', 'ui.form.finish.exportedMissing', { names: 'kort.png' }));
  page.app.state.assets[1].data = new Uint8Array(1);
  page.app.exportData();
  assert.equal(page.app.refs.finish.notices.status.textContent, text('da', 'ui.form.finish.exported'));
});

test('a long list of names in a message ends with "and N more"', async () => {
  const page = openForm({ language: 'en' });
  typeInto(part(page, 'A.goal').focus(), GOAL);
  const state = page.app.state;
  for (let index = 0; index < 12; index += 1) claimedFile(state, `f${index}.bin`, 200 * MIB);
  page.app.exportData();
  const names = Array.from({ length: 8 }, (unused, index) => `f${index}.bin`).join(', ');
  assert.equal(page.app.refs.finish.notices.status.textContent, text('en', 'ui.form.finish.exportedNoFiles', { names: `${names} ${text('en', 'ui.form.more', { count: 4 })}` }));
});

// ---------------------------------------------------------------------------------------------
// L1: one limit for attached files

test('the form takes as many file records everywhere as it takes files', () => {
  assert.equal(library.MAX_ATTACHMENTS, library.PACK_MAX_ENTRIES - 10);
  assert.equal(library.MAX_ATTACHMENTS, 4990);
  const state = newState();
  state.assets = Array.from({ length: 1000 }, (unused, index) => ({ id: `a${index + 1}`, qid: 'B.logo', name: `f${index}.txt`, renamedFrom: '', what: 'w', owner: '', rights: '', restrictions: '', size: 7, data: null }));
  const back = engine.restoreState(JSON.parse(JSON.stringify(engine.serializeState(state, { files: false }))));
  assert.equal(back.state.assets.length, 1000, 'saved and loaded: all 1 000, not 500');
  assert.deepEqual(plain(back.notes), { cleaned: 0, ignored: 0, droppedItems: 0, droppedFiles: 0, reattach: state.assets.map((asset) => asset.name) });

  state.assets = Array.from({ length: 4990 }, (unused, index) => ({ ...state.assets[0], id: `a${index + 1}`, name: `f${index}.txt` }));
  assert.equal(engine.attachmentProblem(state, { name: 'x.txt', size: 1 }).key, 'ui.form.files.tooMany', 'the form refuses the 4 991st file');
  const saved = JSON.parse(JSON.stringify(engine.serializeState(state, { files: false })));
  saved.assets.push({ ...saved.assets[0], name: 'one-more.txt' });
  const over = engine.restoreState(saved);
  assert.equal(over.state.assets.length, 4990, 'and loads no more than it takes');
  assert.equal(over.notes.droppedFiles, 1);
  assert.equal(over.notes.ignored, 0, 'that is not "entries that do not fit"');
});

test('records beyond the limit are reported as files, with the real limit, not as entries that do not fit', () => {
  const state = newState();
  const record = { id: 'a1', qid: 'B.logo', name: 'f.txt', renamedFrom: '', what: '', owner: '', rights: '', restrictions: '', size: 1 };
  const raw = { ...engine.serializeState(state, { files: false }), assets: Array.from({ length: 5000 }, (unused, index) => ({ ...record, name: `f${index}.txt` })) };
  const page = openForm({ language: 'en' });
  const result = engine.restoreState(raw);
  assert.equal(result.state.assets.length, 4990);
  assert.equal(result.notes.droppedFiles, 10);
  return page.app.importFile(fakeFile('big.json', JSON.stringify(raw))).then(() => {
    const message = page.app.refs.top.status.textContent;
    assert.ok(message.includes(text('en', 'ui.form.import.droppedFiles', { count: 10, max: 4990 })));
    assert.ok(!message.includes('do not fit this form'));
  });
});

// ---------------------------------------------------------------------------------------------
// L2: rows of a list

function fillList(page, id, count) {
  page.app.state.answers[id] = { items: Array.from({ length: count }, (unused, index) => ({ text: `Punkt ${index + 1}`, note: '' })) };
  page.app.render();
}

function addButton(page, id) {
  const label = text('en', 'ui.form.list.add');
  return findAll(part(page, id).root, (element) => element.localName === 'button' && element.textContent === label)[0];
}

function rowsOf(page, id) {
  return findAll(part(page, id).root, (element) => element.localName === 'li' && element.className.startsWith('row'));
}

test('a list stops at 500 rows with a message, and takes rows again when one is removed', () => {
  const page = openForm({ language: 'en' });
  fillList(page, 'A.metrics', 499);
  assert.equal(rowsOf(page, 'A.metrics').length, 499);
  const add = addButton(page, 'A.metrics');
  assert.equal(add.disabled, false);
  add.click();
  assert.equal(rowsOf(page, 'A.metrics').length, 500);
  const fresh = addButton(page, 'A.metrics');
  assert.equal(fresh.disabled, true, 'the button is off at the limit');
  const full = findAll(part(page, 'A.metrics').root, (element) => element.localName === 'p' && element.textContent === text('en', 'ui.form.list.full', { max: 500 }));
  assert.equal(full.length, 1);
  assert.equal(full[0].hidden, false);

  fresh.click();
  assert.equal(rowsOf(page, 'A.metrics').length, 500, 'a click that gets through changes nothing');
  const lastRow = rowsOf(page, 'A.metrics')[499];
  const input = findAll(lastRow, (element) => element.localName === 'input')[0];
  input.fire('keydown', { key: 'Enter' });
  assert.equal(rowsOf(page, 'A.metrics').length, 500, 'Enter in the last row adds nothing either');

  findAll(rowsOf(page, 'A.metrics')[0], (element) => element.localName === 'button')[0].click();
  assert.equal(rowsOf(page, 'A.metrics').length, 499);
  assert.equal(addButton(page, 'A.metrics').disabled, false);
  assert.equal(full[0].hidden, true, 'the message is gone');
});

test('list entries beyond 500 are a problem that blocks the download, never dropped quietly', async () => {
  const state = newState();
  engine.record(state, 'A.goal').text = GOAL;
  engine.record(state, 'A.metrics').items = Array.from({ length: 502 }, (unused, index) => ({ text: `Punkt ${index + 1}`, note: '' }));
  const analysis = engine.analyze(state, { now: NOW });
  assert.deepEqual(plain(analysis.problems), [{ key: 'ui.form.problem.tooManyRows', params: { id: 'A.metrics', count: 2, max: 500 } }]);
  await assert.rejects(() => engine.buildPack(state, { now: NOW, today: TODAY }), (error) => error.key === 'ui.form.err.dropped');

  engine.record(state, 'A.metrics').items = Array.from({ length: 502 }, (unused, index) => ({ text: index < 500 ? `Punkt ${index + 1}` : '', note: '' }));
  assert.deepEqual(plain(engine.analyze(state, { now: NOW }).problems), [], 'empty rows beyond the limit hold nothing');
  assert.ok((await engine.buildPack(state, { now: NOW, today: TODAY })).size > 0);
});

test('the page says which list is too long, in the question and in the review', async () => {
  const page = openForm({ language: 'en' });
  typeInto(part(page, 'A.goal').focus(), GOAL);
  fillList(page, 'A.metrics', 502);
  page.app.flush();
  const reason = text('en', 'ui.form.problem.tooManyRows', { count: 2, max: 500 });
  assert.ok(part(page, 'A.metrics').hint.textContent.includes(text('en', 'ui.form.hint.dropped', { reason })));
  page.app.navItems.get('finish').button.click();
  assert.ok(textOf(page.app.refs.finish.checksList).includes(reason));
  page.app.refs.finish.download.click();
  await until(() => page.app.refs.finish.notices.alert.textContent !== '', 'the message');
  assert.equal(page.doc.downloads.length, 0);
  assert.ok(page.app.refs.finish.notices.alert.textContent.includes(text('en', 'q.A.metrics.label')) || page.app.refs.finish.notices.alert.textContent.length > 20);
});

test('a loaded list with more than 500 rows keeps 500 and says how many were left out', async () => {
  const raw = {
    ...engine.serializeState(newState(), { files: false }),
    answers: { 'A.metrics': { items: Array.from({ length: 600 }, (unused, index) => ({ text: `Punkt ${index + 1}`, note: '' })) } },
  };
  const result = engine.restoreState(raw);
  assert.equal(result.state.answers['A.metrics'].items.length, 500);
  assert.equal(result.notes.droppedItems, 100);
  assert.equal(result.notes.ignored, 0);
  const page = openForm({ language: 'en' });
  await page.app.importFile(fakeFile('list.json', JSON.stringify(raw)));
  assert.ok(page.app.refs.top.status.textContent.includes(text('en', 'ui.form.import.droppedItems', { count: 100, max: 500 })));
  assert.equal(rowsOf(page, 'A.metrics').length, 500);
});

// ---------------------------------------------------------------------------------------------
// L6: the total is checked when a file is attached

test('a file is refused at once when it can never fit in a pack or when the files together would not', () => {
  const state = newState();
  const room = 498 * MIB;
  assert.equal(engine.attachmentProblem(state, { name: 'a.bin', size: room }), null);
  assert.equal(engine.attachmentProblem(state, { name: 'a.bin', size: room + 1 }).key, 'ui.form.files.tooBig');
  assert.equal(engine.attachmentProblem(state, { name: 'a.bin', size: 500 * MIB }).key, 'ui.form.files.tooBig');
  claimedFile(state, 'one.bin', 400 * MIB);
  assert.equal(engine.attachedBytes(state), 400 * MIB);
  assert.equal(engine.attachmentProblem(state, { name: 'two.bin', size: 98 * MIB }), null, 'together exactly what a pack can hold');
  assert.deepEqual(plain(engine.attachmentProblem(state, { name: 'two.bin', size: 98 * MIB + 1 })), { key: 'ui.form.files.totalTooBig', params: { name: 'two.bin', limit: '498 MB' } });
  const without = newState();
  claimedFile(without, 'gone.bin', 1).data = null;
  assert.equal(engine.attachedBytes(without), 0, 'a file without content takes no room');
});

test('the page does not read a file that does not fit, and says why next to the file field', async () => {
  const page = openForm({ language: 'en' });
  const input = inputsOf(part(page, 'B.logo').root, 'file')[0];
  claimedFile(page.app.state, 'existing.bin', 450 * MIB);
  const unread = { name: 'next.bin', size: 60 * MIB, arrayBuffer: async () => assert.fail('a file that does not fit must not be read') };
  const small = fakeFile('small.txt', 'abc');
  input.files = [unread, small];
  input.fire('change');
  await until(() => page.app.state.assets.length === 2, 'the small file');
  assert.equal(part(page, 'B.logo').notices.alert.textContent, text('en', 'ui.form.files.totalTooBig', { name: 'next.bin', limit: '498 MB' }));
  assert.deepEqual(plain(page.app.state.assets.map((asset) => asset.name)), ['existing.bin', 'small.txt']);
});

test('the pack is refused before anything is hashed when it would not fit', async () => {
  const state = newState();
  engine.record(state, 'A.goal').text = GOAL;
  claimedFile(state, 'a.bin', 300 * MIB).rights = 'ours';
  claimedFile(state, 'b.bin', 199 * MIB).rights = 'ours';
  await assert.rejects(() => engine.buildPack(state, { now: NOW, today: TODAY }), (error) => error.key === 'ui.form.err.tooLarge');
});

// ---------------------------------------------------------------------------------------------
// L6: the page gets its turns, and the browser hashes when it can

test('a big pack gives the page a turn now and then, a small one does not', async () => {
  let turns = 0;
  const yieldToPage = async () => {
    turns += 1;
  };
  const state = newState();
  engine.record(state, 'A.goal').text = GOAL;
  await engine.buildPack(state, { now: NOW, today: TODAY, yieldToPage });
  assert.equal(turns, 0, 'a pack of a few kilobytes needs no turn');
  for (let index = 0; index < 4; index += 1) {
    const asset = engine.addAsset(state, 'B.logo', { name: `f${index}.bin`, data: new Uint8Array(crypto.randomBytes(5 * MIB)) });
    asset.rights = 'ours';
  }
  turns = 0;
  const pack = await engine.buildPack(state, { now: NOW, today: TODAY, yieldToPage });
  assert.ok(turns >= 2, `${turns} turns for 20 MB, once while hashing and once while the zip is made`);
  assert.equal(unzipPack(pack.bytes).size, 10 + 4 - 0 - 0, 'and the pack is whole');
});

test('the message "building" is on the page before the work starts, and the browser gets a frame first', async () => {
  const page = openForm({ language: 'en' });
  typeInto(part(page, 'A.goal').focus(), GOAL);
  let frames = 0;
  const original = page.fake.win.requestAnimationFrame;
  page.fake.win.requestAnimationFrame = (callback) => {
    frames += 1;
    return original(callback);
  };
  let seen = null;
  const build = page.app.engine.buildPack;
  page.app.engine.buildPack = (...args) => {
    seen = page.app.refs.finish.notices.status.textContent;
    return build(...args);
  };
  page.app.navItems.get('finish').button.click();
  page.app.refs.finish.download.click();
  await until(() => page.doc.downloads.length === 1, 'the download');
  assert.equal(seen, text('en', 'ui.form.finish.building'), 'the message was there when the work began');
  assert.ok(frames >= 1, 'a frame was asked for first');
});

test('a hidden tab gets no frames, and the build still starts', async () => {
  const page = openForm({ language: 'en' });
  typeInto(part(page, 'A.goal').focus(), GOAL);
  page.fake.win.requestAnimationFrame = () => 0;
  let started = false;
  const build = page.app.engine.buildPack;
  page.app.engine.buildPack = (...args) => {
    started = true;
    return build(...args);
  };
  const real = page.fake.win.setTimeout;
  // The fallback timer has a delay of 100 ms; the stand-in only runs the ones the test runs.
  page.fake.win.setTimeout = (callback, delay) => (delay === 100 ? real(callback, 0) : real(callback, delay));
  page.app.navItems.get('finish').button.click();
  page.app.refs.finish.download.click();
  await until(() => started, 'the build');
});

test('the browser hashes through crypto.subtle when it has it, and the plain code gives the same hashes', async () => {
  const withCrypto = loadBrowserScript({ crypto: webcrypto });
  const without = loadBrowserScript();
  const calls = [];
  const subtle = withCrypto.window.__emfc.library.sha256HexAsync;
  assert.equal(typeof subtle, 'function');
  const spied = loadBrowserScript({
    crypto: {
      subtle: {
        digest: (...args) => {
          calls.push(args[0]);
          return webcrypto.subtle.digest(...args);
        },
      },
    },
  });
  for (const size of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 65536, 1024 * 1024 + 3]) {
    const bytes = new Uint8Array(crypto.randomBytes(size));
    const expected = crypto.createHash('sha256').update(bytes).digest('hex');
    assert.equal(await spied.window.__emfc.library.sha256HexAsync(bytes), expected, `subtle, ${size} bytes`);
    assert.equal(await without.window.__emfc.library.sha256HexAsync(bytes), expected, `plain code, ${size} bytes`);
  }
  assert.equal(calls.length, 12);
  assert.ok(calls.every((algorithm) => algorithm === 'SHA-256'));
});

test('when crypto.subtle refuses, the plain code does the hash', async () => {
  const refusing = loadBrowserScript({ crypto: { subtle: { digest: async () => { throw new Error('not allowed here'); } } } });
  const bytes = new Uint8Array(crypto.randomBytes(5000));
  assert.equal(await refusing.window.__emfc.library.sha256HexAsync(bytes), crypto.createHash('sha256').update(bytes).digest('hex'));
  const odd = loadBrowserScript({ crypto: {} });
  assert.equal(await odd.window.__emfc.library.sha256HexAsync(bytes), crypto.createHash('sha256').update(bytes).digest('hex'));
  const nothing = loadBrowserScript({ crypto: { subtle: null } });
  assert.equal(await nothing.window.__emfc.library.sha256HexAsync(bytes), crypto.createHash('sha256').update(bytes).digest('hex'));
});

test('a pack built with crypto.subtle is the same bytes as one built without it', async () => {
  const make = async (loader) => {
    const state = loader.engine.newState({ language: 'da', now: NOW });
    loader.engine.record(state, 'A.goal').text = GOAL;
    loader.engine.record(state, 'B.name').text = 'Nordlys Cykler';
    const asset = loader.engine.addAsset(state, 'B.logo', { name: 'random.bin', data: new Uint8Array(crypto.createHash('sha256').update('seed').digest()) });
    asset.rights = 'Ejes af os';
    const pack = await loader.engine.buildPack(state, { now: NOW, today: TODAY });
    return Buffer.from(pack.bytes);
  };
  const first = await make(loadBrowserScript({ crypto: webcrypto }));
  const second = await make(loadBrowserScript());
  assert.ok(first.equals(second));
});

test('the texts of these limits are in both languages', () => {
  for (const lang of ['da', 'en']) {
    for (const key of ['finish.exportedNoFiles', 'finish.exportedMissing', 'more', 'import.reattach', 'import.droppedItems', 'import.droppedFiles', 'files.totalTooBig', 'list.full', 'problem.tooManyRows']) {
      assert.ok(data.dictionaries[lang][`ui.form.${key}`], `${lang} ${key}`);
    }
  }
  assert.ok(KEY);
});

// ---------------------------------------------------------------------------------------------
// L8: the focus does not get lost when a file is removed

async function pageWithFiles(names) {
  const page = openForm({ language: 'en' });
  const input = inputsOf(part(page, 'B.logo').root, 'file')[0];
  input.files = names.map((name) => fakeFile(name, name));
  input.fire('change');
  await until(() => page.app.state.assets.length === names.length, 'the files');
  return { page, input };
}

function cardsOf(page) {
  return findAll(part(page, 'B.logo').root, (element) => element.className === 'asset');
}

function removeButtonOf(card) {
  return findAll(card, (element) => element.localName === 'button')[0];
}

function firstFieldOf(card) {
  return findAll(card, (element) => element.localName === 'input')[0];
}

test('removing a file puts the focus on the next card, and on the previous one when the last is removed', async () => {
  const { page } = await pageWithFiles(['a.txt', 'b.txt', 'c.txt']);
  removeButtonOf(cardsOf(page)[1]).click();
  assert.deepEqual(plain(page.app.state.assets.map((asset) => asset.name)), ['a.txt', 'c.txt']);
  let cards = cardsOf(page);
  assert.equal(page.doc.activeElement, firstFieldOf(cards[1]), 'the card that moved up');
  removeButtonOf(cards[1]).click();
  cards = cardsOf(page);
  assert.equal(cards.length, 1);
  assert.equal(page.doc.activeElement, firstFieldOf(cards[0]), 'the last card went, so the one before it');
});

test('removing the only file puts the focus on the field for attaching files', async () => {
  const { page, input } = await pageWithFiles(['only.txt']);
  removeButtonOf(cardsOf(page)[0]).click();
  assert.equal(page.app.state.assets.length, 0);
  assert.equal(page.doc.activeElement, input);
});

test('removing a file from one question does not move the focus into another', async () => {
  const { page } = await pageWithFiles(['a.txt', 'b.txt']);
  const other = inputsOf(part(page, 'B.logo').root, 'file')[0];
  assert.ok(other);
  removeButtonOf(cardsOf(page)[0]).click();
  assert.equal(page.doc.activeElement, firstFieldOf(cardsOf(page)[0]));
});

test('the check at attaching counts what the answer files take, as the build does', () => {
  const state = newState();
  claimedFile(state, 'big.bin', 400 * MIB);
  assert.equal(engine.attachmentProblem(state, { name: 'two.bin', size: 98 * MIB }, 0), null);
  assert.equal(engine.attachmentProblem(state, { name: 'two.bin', size: 98 * MIB }, 1).key, 'ui.form.files.totalTooBig', 'one byte of answers is too much at the edge');
  assert.equal(engine.attachmentProblem(state, { name: 'two.bin', size: 98 * MIB - 20000 }, 20000), null);
  assert.equal(engine.attachmentProblem(newState(), { name: 'one.bin', size: 498 * MIB }, 20000).key, 'ui.form.files.tooBig');
  assert.equal(engine.attachmentProblem(newState(), { name: 'one.bin', size: 498 * MIB }, 20000).params.limit, '498 MB', 'the message names the size of a pack minus its own files');
});

test('a pack that was let through at attaching builds, also at the edge with the answers counted', async () => {
  const page = openForm({ language: 'en' });
  typeInto(part(page, 'A.goal').focus(), GOAL);
  page.app.flush();
  const used = page.app.analysis.files.reduce((sum, file) => sum + library.encodeUtf8(file.text).length, 0) + library.encodeUtf8(page.app.analysis.assetsText).length;
  assert.ok(used > 1000 && used < 100000, `${used} bytes of answers`);
  const room = 498 * MIB - used;
  const state = page.app.state;
  claimedFile(state, 'edge.bin', room - 1);
  const fits = engine.attachmentProblem(state, { name: 'x.bin', size: 1 }, used);
  assert.equal(fits, null, 'one byte more still fits');
  const refused = engine.attachmentProblem(state, { name: 'y.bin', size: 2 }, used);
  assert.equal(refused.key, 'ui.form.files.totalTooBig');
});

test('the plain hash, the CRC and the deflate work in slices and give the page turns, with the same results', async () => {
  const without = loadBrowserScript();
  const lib = without.window.__emfc.library;
  const bytes = new Uint8Array(crypto.randomBytes(10 * MIB + 5));
  let turns = 0;
  const pause = async (count) => {
    turns += 1;
    assert.ok(count > 0 && count <= 4 * MIB, `a slice of ${count} bytes`);
  };
  const expected = crypto.createHash('sha256').update(bytes).digest('hex');
  assert.equal(await lib.sha256HexAsync(bytes, pause), expected, 'no crypto.subtle: the plain code, in slices');
  assert.equal(turns, 3, 'three slices of at most 4 MB');
  assert.equal(await lib.sha256HexAsync(bytes), expected, 'and without a pause function too');

  // The zip: every slice of deflate and of CRC is a turn; the zip reads back whole.
  let zipTurns = 0;
  const { parts, size } = await lib.createZipParts([{ name: 'docs/assets/random.bin', data: bytes }, { name: 'docs/a.txt', data: 'abc'.repeat(1000) }], {
    date: NOW,
    yieldToPage: async () => {
      zipTurns += 1;
    },
  });
  assert.ok(zipTurns >= 2, `${zipTurns} turns`);
  const entries = unzipPack(Buffer.concat(parts.map((piece) => Buffer.from(piece))));
  assert.ok(entries.get('docs/assets/random.bin').equals(Buffer.from(bytes)));
  assert.equal(entries.get('docs/a.txt').toString(), 'abc'.repeat(1000));
  assert.equal(size, parts.reduce((sum, piece) => sum + piece.length, 0));
});

test('with crypto.subtle the hash is not done in slices at all', async () => {
  const withCrypto = loadBrowserScript({ crypto: webcrypto });
  let turns = 0;
  const bytes = new Uint8Array(crypto.randomBytes(9 * MIB));
  const hash = await withCrypto.window.__emfc.library.sha256HexAsync(bytes, async () => {
    turns += 1;
  });
  assert.equal(hash, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.equal(turns, 0);
});

test('a deflate that fails halfway leaves the file stored, and the pack is whole', async () => {
  const state = newState();
  engine.record(state, 'A.goal').text = GOAL;
  engine.addAsset(state, 'B.logo', { name: 'a.bin', data: new Uint8Array(crypto.randomBytes(MIB)) }).rights = 'ours';
  const pack = await engine.buildPack(state, { now: NOW, today: TODAY, compress: async () => null });
  assert.ok(unzipPack(pack.bytes).get('docs/assets/a.bin').length === MIB);
});

test('a turn of the page is a message on a channel when the browser has one, and a timer of 0 when it has not', async () => {
  const page = openForm({ language: 'en' });
  const posted = [];
  page.fake.win.MessageChannel = class {
    constructor() {
      this.port1 = { onmessage: null, close: () => {} };
      this.port2 = { postMessage: () => { posted.push('ping'); setTimeout(() => this.port1.onmessage(), 0); } };
    }
  };
  await page.app.yieldToPage();
  assert.deepEqual(posted, ['ping']);
  delete page.fake.win.MessageChannel;
  await page.app.yieldToPage();
  assert.deepEqual(posted, ['ping'], 'no channel: the timer answered');
});
