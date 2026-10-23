import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  InputError,
  PackError,
  applyAnswers,
  buildManifest,
  isEmptyPack,
  parsePack,
  refreshPack,
  resolveInside,
  sha256,
  validatePack,
  writeFileAtomic,
} from '../../skill/everything-mapped/scripts/lib/index.mjs';
import { FIXTURES, NOW, TODAY, copyFolder, makeSchemaDir, makeTempDir, readJson, schema, writeText } from './helpers.mjs';

const DA_INPUT = readJson(path.join(FIXTURES, 'inputs', 'da-complete.json'));
const EN_INPUT = readJson(path.join(FIXTURES, 'inputs', 'en-partial.json'));
const STATE_FILE = 'docs/intake-state.json';

// Every file below dir as { relative path: content }, to compare a folder before and after.
function snapshot(dir) {
  const result = {};
  const walk = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const absolute = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        result[`${path.relative(dir, absolute).split(path.sep).join('/')}/`] = '';
        walk(absolute);
      } else {
        result[path.relative(dir, absolute).split(path.sep).join('/')] = fs.readFileSync(absolute, 'utf8');
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return result;
}

function setup(t) {
  const schemaDir = makeSchemaDir(t);
  const root = path.join(makeTempDir(t), 'pack');
  const options = { schema, schemaDir, now: NOW, today: TODAY };
  return { schemaDir, root, options };
}

function trySymlink(target, linkPath, type) {
  try {
    fs.symlinkSync(target, linkPath, type);
    return true;
  } catch {
    return false;
  }
}

function inputProblems(root, input, options) {
  try {
    applyAnswers(root, input, options);
  } catch (error) {
    assert.ok(error instanceof InputError, String(error));
    return error.problems.map((problem) => problem.key.replace('ui.answer.err.', ''));
  }
  return assert.fail('the input should have been refused');
}

// ---- reading a pack --------------------------------------------------------------------------

test('parsePack reads the Danish fixture pack', () => {
  const pack = parsePack(path.join(FIXTURES, 'pack-da-complete'), schema);
  assert.equal(pack.language, 'da');
  assert.equal(pack.depth, 'full');
  assert.deepEqual(Object.keys(pack.files), schema.files.map((file) => file.id));
  assert.ok(Object.values(pack.files).every((file) => file.exists && file.flags.length === 0));
  assert.equal(pack.files.brief.path, 'docs/00-brief.md');
  assert.equal(pack.files.brief.answers['A.goal'].status, 'complete');
  assert.deepEqual(pack.assets.present, ['logo.svg']);
  assert.equal(pack.assets.rows[0].file, 'assets/logo.svg');
  assert.equal(pack.state.recipient, 'Jonas Berg');
  assert.equal(pack.manifest.language, 'da');
  assert.equal(pack.paths.openQuestions, 'docs/07-risks-and-open-questions.md');
  assert.ok(path.isAbsolute(pack.root));
  assert.equal(isEmptyPack(pack), false);
});

test('parsePack gives the language and depth of the English fixture and its flags', () => {
  const pack = parsePack(path.join(FIXTURES, 'pack-en-partial'), schema);
  assert.equal(pack.language, 'en');
  assert.equal(pack.depth, 'standard');
  assert.deepEqual(pack.assets, { rows: [], present: [], invalid: [] });
  assert.equal(pack.files.brand.answers['B.purpose'].body, 'Fresh bread every day.');
});

test('parsePack on an empty or missing folder gives a pack where everything is missing', (t) => {
  const dir = makeTempDir(t);
  for (const root of [dir, path.join(dir, 'does-not-exist')]) {
    const pack = parsePack(root, schema);
    assert.equal(pack.language, null);
    assert.equal(pack.depth, 'standard');
    assert.equal(pack.state, null);
    assert.equal(pack.manifest, null);
    assert.ok(Object.values(pack.files).every((file) => !file.exists && Object.keys(file.answers).length === 0));
    assert.equal(isEmptyPack(pack), true);
  }
});

test('the language comes from the state, then the manifest, then the front matter of a file', (t) => {
  const root = makeTempDir(t);
  writeText(root, 'docs/00-brief.md', '---\nschema: everything-mapped-for-clients/1\nfile: brief\nlanguage: en\n---\n');
  assert.equal(parsePack(root, schema).language, 'en');
  writeText(root, 'docs/intake-manifest.json', JSON.stringify({ schema: schema.schema, language: 'da', depth: 'full' }));
  const withManifest = parsePack(root, schema);
  assert.equal(withManifest.language, 'da');
  assert.equal(withManifest.depth, 'full');
  writeText(root, STATE_FILE, JSON.stringify({ schema: schema.schema, language: 'en', depth: 'essentials' }));
  const withState = parsePack(root, schema);
  assert.equal(withState.language, 'en');
  assert.equal(withState.depth, 'essentials');
  writeText(root, STATE_FILE, JSON.stringify({ schema: schema.schema, language: 'fr', depth: 'huge' }));
  assert.equal(parsePack(root, schema).depth, 'full', 'an unusable state value is skipped');
});

test('parsePack refuses a state or manifest that is not JSON, not an object or from another version', (t) => {
  const root = makeTempDir(t);
  const failure = () => {
    try {
      parsePack(root, schema);
    } catch (error) {
      assert.ok(error instanceof PackError);
      return error;
    }
    return assert.fail('parsePack should have refused the pack');
  };
  writeText(root, STATE_FILE, '{ not json');
  assert.equal(failure().key, 'ui.check.err.badJson');
  assert.deepEqual(failure().params, { path: STATE_FILE });
  writeText(root, STATE_FILE, '[1, 2]');
  assert.equal(failure().key, 'ui.check.err.badJson');
  writeText(root, STATE_FILE, JSON.stringify({ schema: 'everything-mapped-for-clients/2' }));
  assert.equal(failure().key, 'ui.check.err.unsupportedSchema');
  assert.equal(failure().params.found, 'everything-mapped-for-clients/2');
  fs.rmSync(path.join(root, STATE_FILE));
  writeText(root, 'docs/intake-manifest.json', 'nonsense');
  assert.deepEqual(failure().params, { path: 'docs/intake-manifest.json' });
});

test('parsePack refuses an answer file from another version or one that is a folder', (t) => {
  const root = makeTempDir(t);
  writeText(root, 'docs/00-brief.md', '---\nschema: everything-mapped-for-clients/9\nfile: brief\nlanguage: da\n---\n');
  assert.throws(() => parsePack(root, schema), (error) => error.key === 'ui.check.err.unsupportedSchema');
  fs.rmSync(path.join(root, 'docs/00-brief.md'));
  fs.mkdirSync(path.join(root, 'docs/00-brief.md'));
  assert.throws(() => parsePack(root, schema), (error) => error.key === 'ui.check.err.unreadable');
});

test('parsePack lists asset files recursively, sorted, without hidden files or folders', (t) => {
  const root = makeTempDir(t);
  writeText(root, 'docs/assets/b.png', 'b');
  writeText(root, 'docs/assets/a.png', 'a');
  writeText(root, 'docs/assets/photos/2026/c.jpg', 'c');
  writeText(root, 'docs/assets/.gitkeep', '');
  writeText(root, 'docs/assets/photos/.hidden', '');
  assert.deepEqual(parsePack(root, schema).assets.present, ['a.png', 'b.png', 'photos/2026/c.jpg']);
});

test('parsePack ignores a symbolic link inside docs/assets', (t) => {
  const root = makeTempDir(t);
  writeText(root, 'docs/assets/real.png', 'x');
  if (!trySymlink(path.join(root, 'docs/assets/real.png'), path.join(root, 'docs/assets/link.png'))) return t.skip('symbolic links are not available here');
  assert.deepEqual(parsePack(root, schema).assets.present, ['real.png']);
});

// ---- path safety -----------------------------------------------------------------------------

test('resolveInside accepts paths inside the root, also ones that do not exist yet', (t) => {
  const root = makeTempDir(t);
  assert.equal(resolveInside(root, 'docs/00-brief.md'), path.join(root, 'docs', '00-brief.md'));
  assert.equal(resolveInside(root, 'a/b/../c.txt'), path.join(root, 'a', 'c.txt'));
  assert.equal(resolveInside(path.join(root, 'missing-root'), 'x.md'), path.join(root, 'missing-root', 'x.md'));
});

test('resolveInside refuses paths that leave the root', (t) => {
  const root = makeTempDir(t);
  const refused = (value) => assert.throws(() => resolveInside(root, value), (error) => error instanceof PackError && error.key === 'ui.check.err.outsideRoot');
  refused('../outside.txt');
  refused('docs/../../outside.txt');
  refused(path.resolve(root, '..', 'sibling'));
  refused('docs/a\0b');
  refused('..');
});

test('resolveInside refuses a path that goes through a symbolic link out of the root', (t) => {
  const base = makeTempDir(t);
  const root = path.join(base, 'pack');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.mkdirSync(outside);
  if (!trySymlink(outside, path.join(root, 'docs', 'assets'), 'dir')) return t.skip('symbolic links are not available here');
  assert.throws(() => resolveInside(root, 'docs/assets/logo.svg'), (error) => error.key === 'ui.check.err.outsideRoot');
  assert.throws(() => parsePack(root, schema), (error) => error.key === 'ui.check.err.outsideRoot');
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing was written outside');
});

test('resolveInside refuses a dangling symbolic link and applyAnswers writes nothing through it', (t) => {
  const { root, options } = setup(t);
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  const target = path.join(path.dirname(root), 'elsewhere.md');
  if (!trySymlink(target, path.join(root, 'docs', '00-brief.md'))) return t.skip('symbolic links are not available here');
  assert.throws(() => applyAnswers(root, { language: 'da', answers: [] }, options), (error) => error instanceof PackError);
  assert.equal(fs.existsSync(target), false);
});

test('writeFileAtomic replaces a file without leaving temporary files and creates folders', (t) => {
  const root = makeTempDir(t);
  const target = path.join(root, 'a', 'b', 'file.md');
  writeFileAtomic(target, 'one\n');
  writeFileAtomic(target, 'two æøå\n');
  assert.equal(fs.readFileSync(target, 'utf8'), 'two æøå\n');
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['file.md']);
});

test('writeFileAtomic cleans up its temporary file when the rename fails', (t) => {
  const root = makeTempDir(t);
  const target = path.join(root, 'folder');
  fs.mkdirSync(target);
  assert.throws(() => writeFileAtomic(target, 'x'));
  assert.deepEqual(fs.readdirSync(root), ['folder']);
});

// ---- applyAnswers: creating, merging, refusing -----------------------------------------------

test('applyAnswers creates the whole skeleton on first use, including the empty docs/assets folder', (t) => {
  const { root, options } = setup(t);
  const result = applyAnswers(root, { language: 'da', answers: [] }, options);
  for (const file of schema.files) assert.ok(fs.statSync(path.join(root, file.path)).isFile(), file.path);
  assert.ok(fs.statSync(path.join(root, 'docs', 'assets')).isDirectory());
  assert.deepEqual(fs.readdirSync(path.join(root, 'docs', 'assets')), []);
  for (const generated of ['docs/assets.md', STATE_FILE, 'docs/07-risks-and-open-questions.md', 'docs/intake-manifest.json']) {
    assert.ok(fs.statSync(path.join(root, generated)).isFile(), generated);
  }
  assert.deepEqual(result.written, [
    ...schema.files.map((file) => file.path),
    'docs/assets.md',
    STATE_FILE,
    'docs/07-risks-and-open-questions.md',
    'docs/intake-manifest.json',
  ]);
  assert.equal(fs.existsSync(path.join(root, 'docs', '06-decisions.md')), false, 'files of the team are never created');
  assert.equal(result.report.language, 'da');
  assert.equal(result.report.completeness.counts.complete, 0);
  assert.equal(result.pack.language, 'da');
  const brief = fs.readFileSync(path.join(root, 'docs/00-brief.md'), 'utf8');
  assert.ok(brief.includes('updated: 2026-10-23'));
  assert.ok(brief.includes('<!-- q:A.business status:missing -->'));
  assert.ok(!brief.includes('respondent:'));
});

test('applyAnswers needs a language on first use and then creates nothing', (t) => {
  const { root, options } = setup(t);
  assert.deepEqual(inputProblems(root, { answers: [] }, options), ['languageRequired']);
  assert.equal(fs.existsSync(root), false);
  assert.deepEqual(inputProblems(root, { language: 'fr', answers: [] }, options), ['badLanguage']);
  assert.equal(fs.existsSync(root), false);
});

test('applyAnswers writes the Danish fixture input to a pack that matches the fixture pack', (t) => {
  const { root, options } = setup(t);
  const result = applyAnswers(root, DA_INPUT, options);
  assert.equal(result.report.gate1.ready, true);
  const fixture = path.join(FIXTURES, 'pack-da-complete');
  for (const file of schema.files) {
    const strip = (text) => text.split('\n').filter((line) => !/^#{1,6}\s/.test(line)).join('\n');
    assert.equal(strip(fs.readFileSync(path.join(root, file.path), 'utf8')), strip(fs.readFileSync(path.join(fixture, file.path), 'utf8')), file.path);
  }
});

test('applyAnswers merges: earlier answers stay, a repeated id is replaced, other files keep their date', (t) => {
  const { root, options } = setup(t);
  applyAnswers(root, { language: 'da', answers: [
    { id: 'A.goal', status: 'complete', text: 'Et mål, der er langt nok til at tælle som fuldstændigt svar.' },
    { id: 'B.name', status: 'complete', text: 'Nordlys' },
  ] }, options);
  const later = { ...options, now: new Date('2026-11-02T12:00:00Z'), today: '2026-11-02' };
  const result = applyAnswers(root, { answers: [
    { id: 'B.name', status: 'partial', text: 'Nordlys Cykler' },
    { id: 'I.domain', status: 'tbd', owner: 'client', due: '2026-11-05', note: 'Spørg IT' },
  ] }, later);
  const pack = result.pack;
  assert.equal(pack.files.brief.answers['A.goal'].status, 'complete', 'untouched answer stays');
  assert.equal(pack.files.brand.answers['B.name'].body, 'Nordlys Cykler');
  assert.equal(pack.files.brand.answers['B.name'].status, 'partial');
  assert.equal(pack.files.technical.answers['I.domain'].owner, 'client');
  assert.equal(pack.files.brief.frontMatter.updated, '2026-10-23', 'the brief was not touched');
  assert.equal(pack.files.brand.frontMatter.updated, '2026-11-02');
  assert.equal(pack.files.technical.frontMatter.updated, '2026-11-02');
  assert.ok(!result.written.includes('docs/00-brief.md'), 'unchanged files are not rewritten');
  assert.ok(result.written.includes(STATE_FILE));
  assert.equal(pack.state.currentModule, 'I');
});

test('applying the same input twice writes nothing the second time', (t) => {
  const { root, options } = setup(t);
  applyAnswers(root, EN_INPUT, options);
  const before = snapshot(root);
  const again = applyAnswers(root, EN_INPUT, options);
  assert.deepEqual(again.written, []);
  assert.deepEqual(snapshot(root), before);
});

test('answers can be cleared with status missing', (t) => {
  const { root, options } = setup(t);
  applyAnswers(root, { language: 'en', answers: [{ id: 'B.name', status: 'complete', text: 'Harbour' }] }, options);
  const result = applyAnswers(root, { answers: [{ id: 'B.name', status: 'missing' }] }, options);
  assert.equal(result.pack.files.brand.answers['B.name'].status, 'missing');
  assert.equal(result.pack.files.brand.answers['B.name'].body, '');
});

test('applyAnswers rewrites files canonically, also ones that were written by hand with CRLF', (t) => {
  const { root, options } = setup(t);
  applyAnswers(root, { language: 'da', answers: [{ id: 'A.metrics', status: 'complete', items: [{ text: 'Leads' }] }] }, options);
  const briefPath = path.join(root, 'docs/00-brief.md');
  const handEdited = fs.readFileSync(briefPath, 'utf8').replace('- Leads', '* Leads  ').replace(/\n/g, '\r\n');
  fs.writeFileSync(briefPath, handEdited);
  applyAnswers(root, { answers: [{ id: 'A.budget', status: 'complete', text: 'Lidt' }] }, options);
  const text = fs.readFileSync(briefPath, 'utf8');
  assert.ok(!text.includes('\r'));
  assert.ok(text.includes('<!-- q:A.metrics status:complete -->\n- Leads\n'));
  assert.ok(text.includes('<!-- q:A.budget status:complete -->\nLidt\n'));
});

test('bad input writes nothing: an unknown id next to good answers leaves the folder as it was', (t) => {
  const { root, options } = setup(t);
  applyAnswers(root, EN_INPUT, options);
  const before = snapshot(root);
  const problems = inputProblems(root, { answers: [
    { id: 'A.goal', status: 'complete', text: 'A new goal that is certainly long enough to be fine.' },
    { id: 'Z.nothing', status: 'complete', text: 'x' },
  ] }, options);
  assert.deepEqual(problems, ['unknownId']);
  assert.deepEqual(snapshot(root), before);
});

test('bad input writes nothing on first use either', (t) => {
  const { root, options } = setup(t);
  fs.mkdirSync(root);
  assert.deepEqual(inputProblems(root, { language: 'da', answers: [{ id: 'nope', status: 'complete', text: 'x' }] }, options), ['unknownId']);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('applyAnswers reports every problem of the input at once', (t) => {
  const { root, options } = setup(t);
  const problems = inputProblems(root, { language: 'da', depth: 'huge', recipient: 5, respondent: { role: 'x' }, focus: ['nope'], answers: [
    'text',
    { id: 'A.goal', status: 'complete' },
    { id: 'A.goal', status: 'complete', text: 'twice' },
    { id: 'A.deadline', status: 'complete', date: 'soon' },
    { id: 'A.project-kind', status: 'complete', choice: ['bogus'] },
  ] }, options);
  assert.deepEqual(problems, ['badDepth', 'badField', 'badRespondent', 'badFocus', 'notAnAnswer', 'noContent', 'duplicateId', 'badDate', 'badChoice']);
  assert.deepEqual(inputProblems(root, 'text', options), ['notObject']);
  assert.deepEqual(inputProblems(root, { language: 'da' }, options), ['answersMissing']);
});

test('the language of a pack cannot be changed by later input', (t) => {
  const { root, options } = setup(t);
  applyAnswers(root, { language: 'da', answers: [] }, options);
  assert.deepEqual(inputProblems(root, { language: 'en', answers: [] }, options), ['languageChange']);
  assert.doesNotThrow(() => applyAnswers(root, { language: 'da', answers: [] }, options));
});

test('an answer to a question that another answer switches off is refused, clearing it is allowed', (t) => {
  const { root, options } = setup(t);
  applyAnswers(root, { language: 'da', answers: [{ id: 'A.project-kind', status: 'complete', choice: ['new-site'] }] }, options);
  const answer = { id: 'A.existing-site', status: 'complete', items: [{ text: 'https://example.com' }] };
  assert.deepEqual(inputProblems(root, { answers: [answer] }, options), ['notApplicable']);
  assert.doesNotThrow(() => applyAnswers(root, { answers: [{ id: 'A.existing-site', status: 'missing' }] }, options));
  const together = { answers: [{ id: 'A.project-kind', status: 'complete', choice: ['redesign'] }, answer] };
  assert.doesNotThrow(() => applyAnswers(root, together, options), 'both together are fine');
});

test('changing the answer that switches a question on or off changes the file', (t) => {
  const { root, options } = setup(t);
  const read = () => fs.readFileSync(path.join(root, 'docs/00-brief.md'), 'utf8');
  applyAnswers(root, { language: 'da', answers: [{ id: 'A.project-kind', status: 'complete', choice: ['redesign'] }] }, options);
  assert.ok(read().includes('q:A.existing-site'));
  applyAnswers(root, { answers: [{ id: 'A.project-kind', status: 'complete', choice: ['landing-page'] }] }, options);
  assert.ok(!read().includes('q:A.existing-site'));
  applyAnswers(root, { answers: [{ id: 'A.project-kind', status: 'complete', choice: ['other'] }] }, options);
  assert.ok(read().includes('q:A.existing-site'));
});

test('a respondent that differs from the existing ones is appended, never replaced', (t) => {
  const { root, options } = setup(t);
  const anna = { name: 'Anna Jensen', role: 'Marketing' };
  const peter = { name: 'Peter Holm', role: 'IT' };
  applyAnswers(root, { language: 'da', respondent: anna, answers: [{ id: 'A.goal', status: 'partial', text: 'Mål' }, { id: 'I.domain', status: 'complete', text: 'x.example' }] }, options);
  applyAnswers(root, { respondent: peter, answers: [{ id: 'I.hosting', status: 'complete', text: 'Hos os' }] }, options);
  applyAnswers(root, { respondent: peter, answers: [{ id: 'I.dns-contact', status: 'complete', text: 'Peter' }] }, options);
  const result = applyAnswers(root, { respondent: anna, answers: [{ id: 'A.budget', status: 'complete', text: 'Lidt' }] }, options);
  assert.equal(result.pack.files.technical.frontMatter.respondent, 'Anna Jensen, Marketing; Peter Holm, IT');
  assert.equal(result.pack.files.brief.frontMatter.respondent, 'Anna Jensen, Marketing');
  assert.deepEqual(result.pack.manifest.respondents.map((person) => [person.name, person.role]), [['Anna Jensen', 'Marketing'], ['Peter Holm', 'IT']]);
  assert.equal(result.pack.manifest.respondents[0].updated, TODAY);
});

test('a respondent with a role-less name and one with semicolons are written safely', (t) => {
  const { root, options } = setup(t);
  const result = applyAnswers(root, { language: 'en', respondent: { name: 'Sam; Reed' }, answers: [{ id: 'B.name', status: 'complete', text: 'Harbour' }] }, options);
  assert.equal(result.pack.files.brand.frontMatter.respondent, 'Sam&#44; Reed', 'a comma in a name is written as &#44; so that the first comma ends the name');
  assert.equal(result.pack.manifest.respondents[0].name, 'Sam, Reed');
});

test('recipient and notes go to the state file and are kept until changed', (t) => {
  const { root, options } = setup(t);
  applyAnswers(root, { language: 'da', depth: 'full', recipient: ' Jonas Berg ', notes: 'Første runde', answers: [] }, options);
  const state = () => readJson(path.join(root, STATE_FILE));
  assert.deepEqual(state(), {
    schema: schema.schema,
    language: 'da',
    depth: 'full',
    currentModule: 'A',
    focus: [],
    recipient: 'Jonas Berg',
    notes: 'Første runde',
    updatedAt: '2026-10-23T12:00:00Z',
  });
  applyAnswers(root, { answers: [{ id: 'B.name', status: 'complete', text: 'Nordlys' }] }, options);
  assert.equal(state().recipient, 'Jonas Berg');
  assert.equal(state().notes, 'Første runde');
  assert.equal(state().depth, 'full');
  assert.equal(state().currentModule, 'B');
  applyAnswers(root, { notes: '', recipient: 'Mette', answers: [] }, options);
  assert.equal(state().notes, '');
  assert.equal(state().recipient, 'Mette');
});

test('focus: input sets it, answering a focus question removes it, an empty list clears it', (t) => {
  const { root, options } = setup(t);
  applyAnswers(root, { language: 'da', focus: ['A.goal', 'B.name', 'I.domain'], answers: [] }, options);
  const focus = () => readJson(path.join(root, STATE_FILE)).focus;
  assert.deepEqual(focus(), ['A.goal', 'B.name', 'I.domain']);
  applyAnswers(root, { answers: [{ id: 'B.name', status: 'complete', text: 'Nordlys' }] }, options);
  assert.deepEqual(focus(), ['A.goal', 'I.domain']);
  applyAnswers(root, { focus: [], answers: [] }, options);
  assert.deepEqual(focus(), []);
});

test('the depth is stored and changed by input', (t) => {
  const { root, options } = setup(t);
  assert.equal(applyAnswers(root, { language: 'en', depth: 'essentials', answers: [] }, options).report.depth, 'essentials');
  assert.equal(applyAnswers(root, { answers: [] }, options).report.depth, 'essentials');
  assert.equal(applyAnswers(root, { depth: 'full', answers: [] }, options).report.depth, 'full');
});

test('the open-questions file is regenerated and text outside the markers is kept', (t) => {
  const { root, options } = setup(t);
  applyAnswers(root, { language: 'da', answers: [] }, options);
  const openPath = path.join(root, 'docs/07-risks-and-open-questions.md');
  const text = fs.readFileSync(openPath, 'utf8');
  fs.writeFileSync(openPath, `Risiko: vi har ikke adgang til domænet.\n\n${text}\nEfterskrift.\n`);
  applyAnswers(root, { answers: [{ id: 'I.domain', status: 'tbd', owner: 'client', due: '2026-11-05', note: 'Spørg IT' }] }, options);
  const updated = fs.readFileSync(openPath, 'utf8');
  assert.ok(updated.startsWith('Risiko: vi har ikke adgang til domænet.\n\n# Risici og åbne spørgsmål'));
  assert.ok(updated.endsWith('<!-- generated:end -->\n\nEfterskrift.\n'));
  assert.ok(updated.includes('| I.domain | Afklares senere | client | 2026-11-05 | Spørg IT |'));
});

test('the manifest has hashes of the files, the project, the completeness and no temporary files are left', (t) => {
  const { root, options } = setup(t);
  const result = applyAnswers(root, DA_INPUT, options);
  fs.writeFileSync(path.join(root, 'docs/assets/logo.svg'), '<svg/>');
  const refreshed = refreshPack(root, options);
  const manifest = refreshed.manifest;
  assert.equal(manifest.project.name, 'Nordlys Cykler');
  assert.equal(manifest.project.kind, 'redesign');
  assert.equal(manifest.language, 'da');
  assert.equal(manifest.depth, 'full');
  assert.equal(manifest.toolVersion, '1.0.0');
  assert.equal(manifest.createdAt, '2026-10-23T12:00:00Z');
  assert.equal(manifest.completeness.overall, 1);
  assert.equal(manifest.completeness.gate1Ready, true);
  assert.deepEqual(manifest.completeness.counts, result.report.completeness.counts);
  const paths = manifest.files.map((entry) => entry.path);
  assert.deepEqual(paths, [...paths].sort());
  assert.ok(paths.includes('docs/00-brief.md') && paths.includes('docs/assets/logo.svg') && paths.includes('docs/assets.md'));
  assert.ok(!paths.includes('docs/intake-manifest.json') && !paths.includes(STATE_FILE));
  for (const entry of manifest.files) {
    const actual = createHash('sha256').update(fs.readFileSync(path.join(root, ...entry.path.split('/')))).digest('hex');
    assert.equal(entry.sha256, actual, entry.path);
  }
  const names = fs.readdirSync(root, { recursive: true }).map(String);
  assert.ok(names.length > 10 && names.every((name) => !name.endsWith('.tmp')), 'no temporary files are left');
});

test('sha256 hashes strings as UTF-8 and buffers alike', () => {
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256(Buffer.from('abc')), sha256('abc'));
  assert.equal(sha256('æ'), createHash('sha256').update('æ', 'utf8').digest('hex'));
});

// ---- refreshing ------------------------------------------------------------------------------

test('refreshPack writes the open questions and manifest, and a second run writes nothing', (t) => {
  const { root, options } = setup(t);
  copyFolder(path.join(FIXTURES, 'pack-en-partial'), root);
  fs.rmSync(path.join(root, 'docs/intake-manifest.json'));
  fs.rmSync(path.join(root, 'docs/07-risks-and-open-questions.md'));
  const first = refreshPack(root, options);
  assert.deepEqual(first.written, ['docs/07-risks-and-open-questions.md', 'docs/intake-manifest.json']);
  const second = refreshPack(root, { ...options, now: new Date('2026-12-24T12:00:00Z') });
  assert.deepEqual(second.written, []);
  assert.equal(second.manifest.updatedAt, '2026-10-23T12:00:00Z', 'updatedAt moves only when something changed');
  fs.appendFileSync(path.join(root, 'docs/04-scope-and-structure.md'), '\n');
  const third = refreshPack(root, { ...options, now: new Date('2026-12-24T12:00:00Z') });
  assert.deepEqual(third.written, ['docs/intake-manifest.json']);
  assert.equal(third.manifest.updatedAt, '2026-12-24T12:00:00Z');
  assert.equal(third.manifest.createdAt, '2026-10-23T12:00:00Z');
});

test('refreshPack uses the language of the pack, whatever the dictionary passed in', (t) => {
  const { root, options } = setup(t);
  copyFolder(path.join(FIXTURES, 'pack-en-partial'), root);
  refreshPack(root, options);
  assert.ok(fs.readFileSync(path.join(root, 'docs/07-risks-and-open-questions.md'), 'utf8').includes('# Risks and open questions'));
});

test('refreshPack needs a language', (t) => {
  const { root, options } = setup(t);
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  assert.throws(() => refreshPack(root, options), (error) => error.key === 'ui.check.err.noLanguage');
});

test('buildManifest takes ISO strings or dates for its times', () => {
  const pack = parsePack(path.join(FIXTURES, 'pack-en-partial'), schema);
  const report = validatePack(pack, schema, { today: TODAY });
  const fromStrings = buildManifest(pack, report, { updatedAt: '2026-01-01T00:00:00Z', createdAt: '2025-01-01T00:00:00Z' });
  assert.equal(fromStrings.updatedAt, '2026-01-01T00:00:00Z');
  assert.equal(fromStrings.createdAt, '2025-01-01T00:00:00Z');
  const fromDate = buildManifest(pack, report, { now: new Date('2026-02-03T04:05:06.789Z') });
  assert.equal(fromDate.updatedAt, '2026-02-03T04:05:06Z');
  assert.equal(fromDate.createdAt, '2026-02-03T04:05:06Z');
  assert.deepEqual(Object.keys(fromDate), ['schema', 'toolVersion', 'language', 'depth', 'project', 'respondents', 'createdAt', 'updatedAt', 'completeness', 'files']);
  assert.deepEqual(fromDate.respondents, [{ name: 'Sam Reed', role: 'Operations', updated: '2026-10-23' }]);
});
