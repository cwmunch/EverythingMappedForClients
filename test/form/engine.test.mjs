// The form's logic without a page: state to pack files to zip, checked against the library and
// against the real interviewer (applyAnswers) with the independent unzip helper.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import {
  entryFromInput,
  findQuestion,
  loadI18n,
  parsePack,
  renderAssets,
  renderFile,
  validatePack,
} from '../../skill/everything-mapped/scripts/lib/index.mjs';
import { unzip } from '../cli/unzip.mjs';
import {
  LOGO_SVG,
  NOW,
  NOW_STAMP,
  RESPONDENT,
  SAMPLE,
  TODAY,
  fullSample,
  interviewerTree,
  loadBrowserScript,
  makeTempDir,
  newSampleState,
  plain,
  sampleAttachments,
  sampleInputs,
  schema,
  textOfEntry,
  unzipPack,
} from './helpers.mjs';

const { engine, emfc } = loadBrowserScript();
const library = emfc.library;

async function packOf(state, options = {}) {
  return engine.buildPack(state, { now: NOW, today: TODAY, ...options });
}

function touchedFileIds(inputs, entries) {
  const ids = new Set();
  for (const input of inputs) {
    const question = findQuestion(schema, input.id);
    if (entries[input.id].status !== 'missing') ids.add(question.file);
  }
  return ids;
}

test('sha256, crc32 and base64 agree with node for many lengths', () => {
  for (const length of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 1000, 65536, 100001]) {
    const buffer = crypto.randomBytes(length);
    const bytes = new Uint8Array(buffer);
    assert.equal(library.sha256Hex(bytes), crypto.createHash('sha256').update(buffer).digest('hex'), `sha256 of ${length} bytes`);
    assert.equal(library.crc32(bytes), zlib.crc32(buffer), `crc32 of ${length} bytes`);
    const encoded = library.bytesToBase64(bytes);
    assert.equal(encoded, buffer.toString('base64'), `base64 of ${length} bytes`);
    assert.deepEqual(Buffer.from(library.base64ToBytes(encoded)), buffer, `base64 back for ${length} bytes`);
  }
  assert.equal(library.base64ToBytes('not base64!'), null);
  assert.equal(library.base64ToBytes('abc'), null);
});

test('encodeUtf8 matches TextEncoder, also for emoji and lone surrogates', () => {
  const samples = ['', 'abc', 'æøå ÆØÅ', 'Ünïcödé', '日本語', 'a😀b', 'a\ud800b', '\udc00'];
  for (const text of samples) {
    assert.deepEqual(Buffer.from(library.encodeUtf8(text)), Buffer.from(new TextEncoder().encode(text)), JSON.stringify(text));
  }
});

for (const language of ['da', 'en']) {
  test(`every answer file of the pack equals renderFile for the same answers (${language})`, async () => {
    const state = newSampleState(engine, language);
    const pack = await packOf(state);
    const entries = unzipPack(pack.bytes);
    const inputs = sampleInputs();
    const answers = Object.fromEntries(inputs.map((input) => [input.id, entryFromInput(findQuestion(schema, input.id), input)]));
    const touched = touchedFileIds(inputs, answers);
    const i18n = loadI18n(language);
    for (const file of schema.files) {
      const meta = {
        language,
        respondent: touched.has(file.id) ? `${RESPONDENT.name}, ${RESPONDENT.role}` : '',
        updated: TODAY,
      };
      const expected = renderFile(schema, i18n, file.id, answers, meta);
      assert.equal(textOfEntry(entries, file.path), expected, file.path);
    }
    const rows = [{ file: 'assets/logo.svg', what: 'Hovedlogo', owner: 'Nordlys Cykler', rights: 'Ejes af os', restrictions: 'Ingen' }];
    assert.equal(textOfEntry(entries, schema.generatedFiles.assets), renderAssets(rows, i18n));
    assert.equal(textOfEntry(entries, 'docs/assets/logo.svg'), LOGO_SVG);
  });
}

test('the whole pack is the same as the interviewer writes for the same answers', async (t) => {
  const state = newSampleState(engine, 'da');
  state.depth = 'standard';
  state.recipient = 'Jonas Berg';
  const formTree = unzipPack((await packOf(state)).bytes);
  const expectedTree = interviewerTree(t, sampleInputs(), {
    language: 'da',
    depth: 'standard',
    respondent: RESPONDENT,
    recipient: 'Jonas Berg',
    attachments: sampleAttachments(),
  });
  assert.ok(expectedTree.has('docs/assets/logo.svg'));
  assert.deepEqual([...formTree.keys()].sort(), [...expectedTree.keys()].sort());
  for (const [name, expected] of expectedTree) {
    assert.equal(formTree.get(name).toString('utf8'), expected.toString('utf8'), name);
  }
});

test('a pack without attached files is exactly what the interviewer writes, with its empty file list', async (t) => {
  const sample = SAMPLE.filter((item) => item.id !== 'B.logo');
  for (const language of ['da', 'en']) {
    const state = newSampleState(engine, language, sample);
    state.depth = 'full';
    const formTree = unzipPack((await packOf(state)).bytes);
    const expectedTree = interviewerTree(t, sampleInputs(sample), { language, depth: 'full', respondent: RESPONDENT });
    assert.deepEqual([...formTree.keys()].sort(), [...expectedTree.keys()].sort(), language);
    for (const [name, expected] of expectedTree) assert.equal(formTree.get(name).toString('utf8'), expected.toString('utf8'), `${language} ${name}`);
  }
});

test('a pack with every question answered equals the interviewer pack and is ready (full depth, English)', async (t) => {
  const sample = fullSample();
  const state = newSampleState(engine, 'en', sample);
  state.depth = 'full';
  const pack = await packOf(state);
  const formTree = unzipPack(pack.bytes);
  const expectedTree = interviewerTree(t, sampleInputs(sample), {
    language: 'en',
    depth: 'full',
    respondent: RESPONDENT,
    attachments: sampleAttachments(sample),
  });
  assert.deepEqual([...formTree.keys()].sort(), [...expectedTree.keys()].sort());
  for (const [name, expected] of expectedTree) {
    assert.equal(formTree.get(name).toString('utf8'), expected.toString('utf8'), name);
  }
  assert.equal(plain(pack.report.gate1).ready, true);
  assert.equal(pack.manifest.completeness.gate1Ready, true);
});

test('the pack passes the library check: unzipped, it gives the same report as the form', async (t) => {
  const state = newSampleState(engine, 'da');
  const pack = await packOf(state);
  const root = makeTempDir(t);
  for (const [name, data] of unzipPack(pack.bytes)) {
    fs.mkdirSync(path.dirname(path.join(root, ...name.split('/'))), { recursive: true });
    fs.writeFileSync(path.join(root, ...name.split('/')), data);
  }
  const parsed = parsePack(root, schema);
  assert.equal(parsed.language, 'da');
  assert.equal(parsed.depth, 'standard');
  const report = validatePack(parsed, schema, { depth: 'standard', today: TODAY });
  const manifest = JSON.parse(textOfEntry(unzipPack(pack.bytes), 'docs/intake-manifest.json'));
  assert.deepEqual(report.gate1.blocking, manifest.completeness.gate1Blocking);
  assert.deepEqual(report.completeness.counts, manifest.completeness.counts);
  assert.equal(report.completeness.overall, manifest.completeness.overall);
  assert.deepEqual(report.gate1.blocking, plain(pack.report.gate1.blocking));
  assert.equal(parsed.assets.present.length, 1);
  assert.equal(parsed.assets.rows.length, 1);
  assert.equal(report.flags.some((flag) => flag.id.startsWith('assets.')), false);
});

test('the manifest hashes every file but the manifest and the state file, and names the project', async () => {
  const state = newSampleState(engine, 'da');
  const pack = await packOf(state);
  const entries = unzipPack(pack.bytes);
  const manifest = JSON.parse(textOfEntry(entries, 'docs/intake-manifest.json'));
  assert.equal(manifest.schema, schema.schema);
  assert.equal(manifest.toolVersion, '1.0.0');
  assert.equal(manifest.language, 'da');
  assert.equal(manifest.project.name, 'Nordlys Cykler');
  assert.equal(manifest.project.kind, 'redesign');
  assert.deepEqual(manifest.respondents, [{ name: RESPONDENT.name, role: RESPONDENT.role, updated: TODAY }]);
  assert.equal(manifest.createdAt, NOW_STAMP);
  assert.equal(manifest.updatedAt, NOW_STAMP);
  const listed = manifest.files.map((file) => file.path);
  assert.deepEqual(listed, [...listed].sort());
  assert.ok(!listed.includes('docs/intake-manifest.json') && !listed.includes('docs/intake-state.json'));
  for (const file of manifest.files) {
    assert.equal(file.sha256, crypto.createHash('sha256').update(entries.get(file.path)).digest('hex'), file.path);
  }
  const state2 = JSON.parse(textOfEntry(entries, 'docs/intake-state.json'));
  assert.deepEqual(Object.keys(state2), ['schema', 'language', 'depth', 'currentModule', 'focus', 'recipient', 'notes', 'updatedAt']);
  assert.equal(state2.currentModule, 'I');
});

test('the zip reads back with the independent unzip: names, sizes, flags, modes and the date', async () => {
  const state = newSampleState(engine, 'da');
  const pack = await packOf(state);
  assert.equal(pack.name, 'intake-pack-2026-10-23.zip');
  const entries = unzip(Buffer.from(pack.bytes));
  const names = [...entries.keys()];
  assert.deepEqual(names, [...names].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
  assert.deepEqual(
    names,
    [
      'docs/00-brief.md',
      'docs/01-brand/brand.md',
      'docs/02-audience-and-competitors.md',
      'docs/03-content-inventory.md',
      'docs/04-scope-and-structure.md',
      'docs/05-technical-and-compliance.md',
      'docs/07-risks-and-open-questions.md',
      'docs/assets.md',
      'docs/assets/logo.svg',
      'docs/intake-manifest.json',
      'docs/intake-state.json',
    ],
  );
  const dosTime = (12 << 11) | (0 << 5) | 0;
  const dosDate = ((2026 - 1980) << 9) | (10 << 5) | 23;
  for (const [name, entry] of entries) {
    assert.ok(entry.flags & 0x0800, `${name}: UTF-8 flag`);
    assert.equal(entry.mode, 0o100644, `${name}: regular file`);
    assert.equal(entry.dosTime, dosTime, `${name}: time`);
    assert.equal(entry.dosDate, dosDate, `${name}: date`);
    assert.ok(entry.method === 0 || entry.method === 8);
  }
  assert.equal(entries.get('docs/00-brief.md').method, 8, 'text is deflated when CompressionStream exists');
  assert.ok(pack.bytes.length < pack.totalBytes);
});

test('without CompressionStream every entry is stored and still reads back', async () => {
  const { engine: plainEngine } = loadBrowserScript({ compression: false });
  const state = newSampleState(plainEngine, 'da');
  const pack = await plainEngine.buildPack(state, { now: NOW, today: TODAY });
  const entries = unzip(Buffer.from(pack.bytes));
  for (const [name, entry] of entries) assert.equal(entry.method, 0, name);
  const reference = await packOf(newSampleState(engine, 'da'));
  const deflated = unzipPack(reference.bytes);
  for (const [name, entry] of entries) assert.deepEqual(entry.data, deflated.get(name), name);
});

test('the zip is the same bytes every time for the same state and moment', async () => {
  const first = await packOf(newSampleState(engine, 'da'));
  const second = await packOf(newSampleState(engine, 'da'));
  assert.deepEqual(Buffer.from(first.bytes), Buffer.from(second.bytes));
});

test('createZipBytes stores empty and incompressible entries, handles non-ASCII names, and rejects bad names', async () => {
  const random = new Uint8Array(crypto.randomBytes(2000));
  const bytes = await library.createZipBytes(
    [
      { name: 'docs/assets/Logo æøå 日本.png', data: random },
      { name: 'docs/empty.txt', data: '' },
      { name: 'docs/text.txt', data: Array.from({ length: 400 }, (unused, index) => `line ${index} of ordinary text`).join('\n') },
    ],
    { date: NOW },
  );
  const entries = unzip(Buffer.from(bytes));
  assert.deepEqual(entries.get('docs/assets/Logo æøå 日本.png').data, Buffer.from(random));
  assert.equal(entries.get('docs/assets/Logo æøå 日本.png').method, 0);
  assert.equal(entries.get('docs/empty.txt').data.length, 0);
  assert.equal(entries.get('docs/text.txt').method, 8);
  for (const name of ['', '/abs', 'C:/x', 'a/../b', 'a//b', 'a\\b', 'docs/x\u0000y', 'a/./b']) {
    await assert.rejects(() => library.createZipBytes([{ name, data: 'x' }]), /Invalid zip entry name/, JSON.stringify(name));
  }
  await assert.rejects(() => library.createZipBytes([{ name: 'a', data: 'x' }, { name: 'a', data: 'y' }]), /appears twice/);
});

test('a pack of more than 65 535 files is refused with a message key', async () => {
  const entries = Array.from({ length: library.ZIP_MAX_ENTRIES + 1 }, (unused, index) => ({ name: `f${index}`, data: '' }));
  await assert.rejects(
    () => library.createZipBytes(entries, { compress: false }),
    (error) => error.name === 'FormError' && error.key === 'ui.form.err.tooManyFiles',
  );
});

test('a pack the team\'s reader would refuse is not built: more than 5 000 entries or more than 500 MB', async () => {
  const state = engine.newState({ language: 'en', now: NOW });
  engine.record(state, 'A.goal').text = 'Et mål';
  const asset = (index) => ({ id: `a${index + 1}`, qid: 'B.logo', name: `f${index}.txt`, what: '', owner: '', rights: '', restrictions: '', size: 1, data: new Uint8Array(1) });
  state.assets = Array.from({ length: 4990 }, (unused, index) => asset(index));
  assert.equal((await packOf(state, { compress: false })).entries.length, 5000, '4 990 files and the 10 pack files are still fine');
  state.assets.push(asset(4990));
  await assert.rejects(
    () => packOf(state, { compress: false }),
    (error) => error.name === 'FormError' && error.key === 'ui.form.err.tooManyFiles' && error.params.max === 5000 && error.params.count === 5001,
  );

  const big = engine.newState({ language: 'en', now: NOW });
  engine.record(big, 'A.goal').text = 'Et mål';
  engine.addAsset(big, 'B.logo', { name: 'a.bin', data: new Uint8Array(1) }).data = { length: 501 * 1024 * 1024 };
  await assert.rejects(() => packOf(big), (error) => error.key === 'ui.form.err.tooLarge');
});

test('nothing answered means no pack: the error carries a text key', async () => {
  const state = engine.newState({ language: 'en', now: NOW });
  await assert.rejects(
    () => packOf(state),
    (error) => error.name === 'FormError' && error.key === 'ui.form.err.nothing',
  );
  state.respondent = { ...RESPONDENT };
  await assert.rejects(() => packOf(state), (error) => error.key === 'ui.form.err.nothing');
  assert.equal(engine.hasAnswers(state), false);
});

test('showIf: a question switched off by another answer is left out of the files and the counts', async () => {
  const state = engine.newState({ language: 'da', now: NOW });
  engine.record(state, 'A.goal').text = 'At få flere henvendelser fra private kunder, så vi kan fylde kalenderen.';
  engine.record(state, 'A.existing-site').items = [{ text: 'https://example.com', note: '' }];
  engine.record(state, 'A.project-kind').choice = ['new-site'];
  let analysis = engine.analyze(state, { now: NOW });
  assert.equal(analysis.report.questions['A.existing-site'].level, 'skipped');
  assert.equal(engine.isVisible(analysis.report, 'A.existing-site', 'full'), false);
  const brief = analysis.files.find((file) => file.id === 'brief').text;
  assert.ok(!brief.includes('q:A.existing-site'));
  assert.ok(brief.includes('q:A.goal status:partial') || brief.includes('q:A.goal status:complete'));

  engine.record(state, 'A.project-kind').choice = ['redesign'];
  analysis = engine.analyze(state, { now: NOW });
  assert.equal(analysis.report.questions['A.existing-site'].level, 'recommended');
  assert.equal(engine.isVisible(analysis.report, 'A.existing-site', 'full'), true);
  assert.ok(analysis.files.find((file) => file.id === 'brief').text.includes('q:A.existing-site status:complete'));
  assert.ok(analysis.files.find((file) => file.id === 'brief').text.includes('- https://example.com'));

  engine.record(state, 'A.project-kind').choice = [];
  analysis = engine.analyze(state, { now: NOW });
  assert.equal(analysis.report.questions['A.existing-site'].level, 'recommended', 'an unanswered controlling question shows the question');
});

test('showIf: an answer in a hidden question does not count as an answer in the pack', async () => {
  const state = engine.newState({ language: 'en', now: NOW });
  engine.record(state, 'A.project-kind').choice = ['new-site'];
  engine.record(state, 'A.existing-site').items = [{ text: 'https://hidden.example', note: '' }];
  const analysis = engine.analyze(state, { now: NOW });
  assert.equal(analysis.inputs.length, 1);
  const pack = await packOf(state);
  const entries = unzipPack(pack.bytes);
  assert.ok(![...entries.values()].some((data) => data.toString('utf8').includes('hidden.example')));
});

test('requiredIf raises the level of a question when its condition holds', () => {
  const state = engine.newState({ language: 'en', now: NOW });
  const level = (id) => engine.analyze(state, { now: NOW }).report.questions[id].level;
  assert.equal(level('F.migration'), 'recommended');
  assert.equal(level('G.multilingual'), 'recommended');
  assert.equal(level('H.who-edits'), 'recommended');
  assert.equal(level('B.logo'), 'recommended');

  engine.record(state, 'A.project-kind').choice = ['redesign'];
  engine.record(state, 'D.languages').choice = ['da', 'en'];
  engine.record(state, 'H.editing-needs').choice = ['regular'];
  engine.record(state, 'B.assets-status').choice = ['guidelines'];
  assert.equal(level('F.migration'), 'gate1');
  assert.equal(level('G.multilingual'), 'gate1');
  assert.equal(level('H.who-edits'), 'gate1');
  assert.equal(level('B.logo'), 'gate1');

  engine.record(state, 'D.languages').choice = ['da'];
  engine.record(state, 'H.editing-needs').choice = ['nobody'];
  assert.equal(level('G.multilingual'), 'recommended');
  assert.equal(level('H.who-edits'), 'recommended');
  const blocking = engine.analyze(state, { now: NOW }).report.gate1.blocking;
  assert.ok(blocking.includes('F.migration'));
  assert.ok(blocking.includes('B.logo'));
});

test('depth decides which questions the form shows; the pack still lists them all', async () => {
  const state = newSampleState(engine, 'da');
  const report = engine.analyze(state, { now: NOW }).report;
  const shown = (depth) => engine.ordered.filter((question) => engine.isVisible(report, question.id, depth)).length;
  assert.ok(shown('essentials') < shown('standard'));
  assert.ok(shown('standard') < shown('full'));
  state.depth = 'essentials';
  const pack = await packOf(state);
  const brief = textOfEntry(unzipPack(pack.bytes), 'docs/00-brief.md');
  assert.ok(brief.includes('q:A.failure status:missing'), 'optional questions are written as missing');
  assert.equal(pack.manifest.depth, 'essentials');
});

test('a deferred answer carries its owner and due date in the marker', async () => {
  const state = newSampleState(engine, 'en');
  const entries = unzipPack((await packOf(state)).bytes);
  const brief = textOfEntry(entries, 'docs/00-brief.md');
  assert.ok(brief.includes('<!-- q:A.stakeholders status:tbd owner:Peter-Holm due:2026-11-12 -->\nSpørg ejeren'));
  assert.ok(textOfEntry(entries, 'docs/05-technical-and-compliance.md').includes('<!-- q:I.domain status:tbd owner:client due:2026-11-05 -->\nSpørg IT-afdelingen'));
  assert.ok(textOfEntry(entries, 'docs/05-technical-and-compliance.md').includes('<!-- q:I.hosting status:tbd owner:Anna-Jensen -->'));
  const open = textOfEntry(entries, 'docs/07-risks-and-open-questions.md');
  assert.ok(open.includes('Peter-Holm') && open.includes('2026-11-12'));
});

test('a deferred answer without a named owner is flagged, and an invalid due date is dropped', async () => {
  const state = engine.newState({ language: 'en', now: NOW });
  Object.assign(engine.record(state, 'I.domain'), { unknown: true, owner: 'other', ownerName: '   ', due: '2026-02-31' });
  Object.assign(engine.record(state, 'I.hosting'), { unknown: true, owner: 'me' });
  let analysis = engine.analyze(state, { now: NOW, today: TODAY });
  assert.equal(analysis.entries['I.domain'].owner, '');
  assert.equal(analysis.entries['I.domain'].due, '', 'the invalid date is not written');
  assert.ok(analysis.report.questions['I.domain'].flags.some((flag) => flag.id === 'tbd.noOwner'));
  assert.ok(analysis.report.questions['I.hosting'].flags.some((flag) => flag.id === 'tbd.noOwner'));
  assert.equal(analysis.problems.length, 0);

  state.respondent = { ...RESPONDENT };
  Object.assign(engine.record(state, 'I.domain'), { due: '2026-11-05', owner: 'client' });
  analysis = engine.analyze(state, { now: NOW, today: TODAY });
  assert.equal(analysis.problems.length, 0);
  assert.equal(analysis.entries['I.hosting'].owner, 'Anna-Jensen');
  assert.equal(analysis.report.questions['I.domain'].status, 'tbd');
});

test('toggling "I do not know" keeps what was typed and brings it back', async () => {
  const state = engine.newState({ language: 'en', now: NOW });
  const record = engine.record(state, 'A.budget');
  record.text = '150.000 kr.';
  record.unknown = true;
  record.owner = 'client';
  assert.equal(engine.analyze(state, { now: NOW }).report.questions['A.budget'].status, 'tbd');
  record.unknown = false;
  assert.equal(engine.analyze(state, { now: NOW }).report.questions['A.budget'].status, 'complete');
});

test('soft hints follow the rules of the schema and never block', () => {
  const state = engine.newState({ language: 'en', now: NOW });
  const hintsFor = (id) => plain(engine.hints(engine.byId.get(id), state, engine.analyze(state, { now: NOW }).report));
  assert.deepEqual(hintsFor('A.goal'), [{ key: 'ui.form.hint.minChars', params: { actual: 0, min: 40 } }]);
  engine.record(state, 'A.goal').text = 'Kort';
  assert.deepEqual(hintsFor('A.goal'), [{ key: 'ui.form.hint.minChars', params: { actual: 4, min: 40 } }]);
  engine.record(state, 'A.goal').text = 'x'.repeat(40);
  assert.deepEqual(hintsFor('A.goal'), []);

  assert.deepEqual(hintsFor('B.personality'), [{ key: 'ui.form.hint.minItems', params: { actual: 0, min: 5 } }]);
  engine.record(state, 'B.personality').items = [{ text: 'rolig', note: '' }, { text: '', note: '' }, { text: 'varm', note: '' }];
  assert.deepEqual(hintsFor('B.personality'), [{ key: 'ui.form.hint.minItems', params: { actual: 2, min: 5 } }]);

  assert.deepEqual(hintsFor('A.budget'), [], 'a question without rules has no hint');
  engine.record(state, 'E.like').items = [{ text: 'bare tekst uden adresse', note: '' }, { text: 'https://example.com', note: '' }, { text: 'https://example.org', note: '' }];
  assert.deepEqual(hintsFor('E.like'), [{ key: 'ui.form.hint.notUrl', params: { item: 'bare tekst uden adresse' } }]);
  engine.record(state, 'A.deadline').date = '2020-01-01';
  assert.deepEqual(hintsFor('A.deadline'), [{ key: 'ui.form.hint.datePast', params: { date: '2020-01-01' } }]);
  engine.record(state, 'A.goal').unknown = true;
  assert.deepEqual(hintsFor('A.goal'), [], 'no hints while the question is marked as unknown');
});

test('a short answer is partial and the progress counts it as answered', () => {
  const state = engine.newState({ language: 'en', now: NOW });
  engine.record(state, 'A.goal').text = 'Kort';
  engine.record(state, 'A.budget').text = '10';
  Object.assign(engine.record(state, 'I.domain'), { unknown: true });
  const report = engine.analyze(state, { now: NOW }).report;
  assert.equal(report.questions['A.goal'].status, 'partial');
  assert.ok(report.gate1.blocking.includes('A.goal'));
  const progress = plain(engine.progress(report, 'standard'));
  assert.equal(progress.total.tbd, 1);
  assert.equal(progress.perModule.A.done, 2);
  assert.equal(progress.perModule.I.tbd, 1);
  const total = engine.ordered.filter((question) => engine.isVisible(report, question.id, 'standard')).length;
  assert.equal(progress.total.total, total);
});

test('attached files: names are made safe and unique, and only files with data go into the pack', async () => {
  const taken = new Set();
  const safe = (name) => {
    const result = library.safeAssetName(name, taken);
    taken.add(result.toLowerCase());
    return result;
  };
  assert.equal(safe('logo.svg'), 'logo.svg');
  assert.equal(safe('Logo.SVG'), 'Logo-2.SVG');
  assert.equal(safe('../../etc/passwd'), 'passwd');
  assert.equal(safe('C:\\Users\\x\\foto 1.png'), 'foto-1.png');
  assert.equal(safe('.htaccess'), 'htaccess');
  assert.equal(safe('a|b?c*.txt'), 'a-b-c-.txt');
  assert.equal(safe('con.txt'), '_con.txt');
  assert.equal(safe(''), 'file');
  assert.equal(safe('   '), 'file-2');
  assert.equal(safe('Ærø, naïve & #1 100%.png'), 'Ærø,-naïve-&-1-100-.png');
  assert.ok(safe(`${'x'.repeat(300)}.png`).length <= 100);

  const state = engine.newState({ language: 'da', now: NOW });
  engine.record(state, 'A.goal').text = 'Et mål';
  const withData = engine.addAsset(state, 'B.logo', { name: 'a.png', data: new Uint8Array([1, 2, 3]) });
  const lost = engine.addAsset(state, 'B.logo', { name: 'b.png', data: new Uint8Array(1) });
  lost.data = null;
  withData.rights = 'Ejes af os';
  const pack = await packOf(state);
  const entries = unzipPack(pack.bytes);
  assert.deepEqual([...entries.keys()].filter((name) => name.startsWith('docs/assets/')), ['docs/assets/a.png']);
  assert.ok(textOfEntry(entries, 'docs/assets.md').includes('| assets/a.png |'));
  assert.ok(!textOfEntry(entries, 'docs/assets.md').includes('b.png'));
  assert.ok(textOfEntry(entries, 'docs/01-brand/brand.md').includes('- assets/a.png'));
  assert.ok(!textOfEntry(entries, 'docs/01-brand/brand.md').includes('b.png'));
  engine.removeAsset(state, withData.id);
  assert.equal(engine.assetsOf(state, 'B.logo').length, 1);
});

test('asset rows and a file without rights give the library warning', () => {
  const state = engine.newState({ language: 'da', now: NOW });
  engine.record(state, 'A.goal').text = 'Et mål';
  engine.addAsset(state, 'B.logo', { name: 'a.png', data: new Uint8Array([1]) });
  const report = engine.analyze(state, { now: NOW }).report;
  assert.ok(report.flags.some((flag) => flag.id === 'assets.noRights'));
  assert.ok(!report.flags.some((flag) => flag.id === 'assets.unlisted' || flag.id === 'assets.missingFile'));
});

test('saving and loading the form data gives the same state, with attached files', () => {
  const state = newSampleState(engine, 'da');
  state.recipient = 'Jonas Berg';
  state.currentModule = 'D';
  const saved = JSON.parse(JSON.stringify(engine.serializeState(state, { files: true, savedAt: NOW_STAMP })));
  assert.equal(saved.format, library.FORM_FORMAT);
  assert.equal(saved.assets[0].data, Buffer.from(LOGO_SVG).toString('base64'));
  const loaded = engine.restoreState(saved);
  assert.equal(loaded.ok, true);
  assert.deepEqual(plain(engine.inputsFromState(loaded.state).inputs), plain(engine.inputsFromState(state).inputs));
  assert.equal(loaded.state.language, 'da');
  assert.equal(loaded.state.recipient, 'Jonas Berg');
  assert.equal(loaded.state.currentModule, 'D');
  assert.equal(Buffer.from(loaded.state.assets[0].data).toString(), LOGO_SVG);
  assert.equal(loaded.state.assets[0].rights, 'Ejes af os');

  const without = JSON.parse(JSON.stringify(engine.serializeState(state, { files: false })));
  assert.equal(without.assets[0].data, undefined);
  assert.equal(engine.restoreState(without).state.assets[0].data, null);
});

test('loading form data refuses damaged data as a whole', () => {
  assert.equal(engine.restoreState(null).key, 'ui.form.err.importFormat');
  assert.equal(engine.restoreState([]).key, 'ui.form.err.importFormat');
  assert.equal(engine.restoreState({ format: 'something-else' }).key, 'ui.form.err.importFormat');
  assert.equal(engine.parseSavedText('{ not json').key, 'ui.form.err.importRead');
  const base = { format: library.FORM_FORMAT, language: 'en', depth: 'standard' };
  const damaged = [
    { answers: 'not an object' },
    { answers: [] },
    { answers: { 'A.goal': 'not an object' } },
    { answers: { 'A.goal': null } },
    { respondent: 'Anna' },
    { assets: {} },
    { assets: [{ qid: 'B.logo', name: 'a.png', data: '@@@@' }] },
    { assets: [{ qid: 'B.logo', name: 'a.png', data: 12 }] },
  ];
  for (const part of damaged) {
    const result = engine.restoreState(JSON.parse(JSON.stringify({ ...base, ...part })));
    assert.deepEqual(plain(result), { ok: false, key: 'ui.form.err.importInvalid' }, JSON.stringify(part));
    assert.deepEqual(plain(engine.parseSavedText(JSON.stringify({ ...base, ...part }))), { ok: false, key: 'ui.form.err.importInvalid' });
  }
});

test('loading form data cleans what is merely unusable and says how much it cleaned or left out', () => {
  const hostile = {
    format: library.FORM_FORMAT,
    language: 'xx',
    depth: 'everything',
    currentModule: '<img src=x onerror=alert(1)>',
    respondent: { name: 42, role: 'Ejer' },
    createdAt: 'yesterday',
    answers: {
      'A.goal': { text: 'Et m\u00e5l\u000b med tegn\u0085 der ikke kan gemmes', unknown: 'yes', owner: 'root', due: 'soon', extra: { deep: 1 } },
      'A.project-kind': { choice: ['redesign', 'nonsense', 'new-site'], note: 5 },
      'A.metrics': { items: [{ text: 'a', note: 'b' }, 'plain string', 7, null] },
      'A.deadline': { date: '31/12/2026' },
      'Z.unknown': { text: 'x' },
    },
    assets: [
      { qid: 'A.goal', name: 'wrong-question.png', data: 'AAAA' },
      { qid: 'B.logo', name: '../evil.png', data: 'AQID', rights: 5 },
      { qid: 'B.logo', name: 'evil.png' },
      'junk',
    ],
  };
  const result = engine.restoreState(JSON.parse(JSON.stringify(hostile)));
  assert.equal(result.ok, true);
  assert.deepEqual(plain(result.notes), { cleaned: 3, ignored: 3, droppedItems: 0, droppedFiles: 0, reattach: ['evil-2.png'] }, 'one text and two file names were changed; one question and two files were left out; one file must be attached again');
  const state = plain(result.state);
  assert.equal(state.language, 'en');
  assert.equal(state.depth, 'standard');
  assert.equal(state.currentModule, 'A');
  assert.equal(state.respondent.name, '');
  assert.match(state.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.deepEqual(state.answers['A.goal'], { text: 'Et m\u00e5l med tegn der ikke kan gemmes', unknown: false, owner: 'client', ownerName: '', due: '', tbdNote: '' });
  assert.deepEqual(state.answers['A.project-kind'].choice, ['redesign'], 'a single choice keeps one valid id');
  assert.equal(state.answers['A.project-kind'].note, '');
  assert.deepEqual(state.answers['A.metrics'].items, [{ text: 'a', note: '' }, { text: 'plain string', note: '' }, { text: '', note: '' }, { text: '', note: '' }]);
  assert.equal(state.answers['A.deadline'].date, '');
  assert.deepEqual(Object.keys(state.answers).sort(), ['A.deadline', 'A.goal', 'A.metrics', 'A.project-kind']);
  assert.deepEqual(state.assets.map((asset) => asset.name), ['evil.png', 'evil-2.png']);
  assert.equal(state.assets[0].rights, '');
  assert.equal(result.state.assets[1].data, null);
  assert.equal(Buffer.from(result.state.assets[0].data).toString('hex'), '010203');
  assert.equal(({}).polluted, undefined);
});

test('a state that is saved in one language and built in the other changes only the headings', async () => {
  const state = newSampleState(engine, 'da');
  const danish = unzipPack((await packOf(state)).bytes);
  state.language = 'en';
  const english = unzipPack((await packOf(state)).bytes);
  assert.ok(textOfEntry(danish, 'docs/00-brief.md').includes('language: da'));
  assert.ok(textOfEntry(english, 'docs/00-brief.md').includes('language: en'));
  assert.ok(textOfEntry(english, 'docs/00-brief.md').includes('Nordlys Cykler sælger og reparerer cykler i Aarhus'));
});
