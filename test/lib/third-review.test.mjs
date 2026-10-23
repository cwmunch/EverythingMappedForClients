// Tests for the third review of the pushed kit: two writers at once, assets that are too large or
// too many, answers to questions that are switched off, a focus that no longer applies, the
// language of a pack, a failing --delete, names that collide on Windows and macOS, links in the
// assets folder, leftover temporary files, folders left after a failed first write, the size of a
// pack, texts that blame the wrong thing and whitespace that does not survive a round trip.
//
// Data is kept small: the only large files are sparse (a length and no content) and are never read.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  applyAnswers,
  entryNameProblems,
  describeFlag,
  nextQuestions,
  parseBody,
  parsePack,
  findQuestion,
  bodyFromInput,
  validatePack,
  validatePackData,
} from '../../skill/everything-mapped/scripts/lib/index.mjs';
import { MAX_PACK_BYTES, MAX_PACK_FILES, foldPackName } from '../../skill/everything-mapped/scripts/lib/util.mjs';
import { main as answer } from '../../skill/everything-mapped/scripts/answer.mjs';
import { main as assets } from '../../skill/everything-mapped/scripts/assets.mjs';
import { main as check } from '../../skill/everything-mapped/scripts/check.mjs';
import { main as next } from '../../skill/everything-mapped/scripts/next.mjs';
import { NOW, TODAY, makePackData, makeSchemaDir, makeTempDir, readJson, runScript, schema, testI18n, writeText } from './helpers.mjs';

const char = (...codes) => String.fromCodePoint(...codes);
const MB = 1024 * 1024;

function setup(t) {
  const schemaDir = makeSchemaDir(t);
  const cwd = makeTempDir(t);
  return {
    schemaDir,
    cwd,
    options: { schema, schemaDir, now: NOW, today: TODAY },
    run: (main, argv, extra = {}) => runScript(main, argv, { cwd, schemaDir, ...extra }),
  };
}

function pack(t, language = 'en') {
  const context = setup(t);
  applyAnswers(context.cwd, { language, answers: [] }, context.options);
  return context;
}

// Every file below dir with its text; a file over 1 MB is recorded as 'large' and never read.
function snapshot(dir) {
  const result = {};
  const walk = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const absolute = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) result[path.relative(dir, absolute)] = fs.statSync(absolute).size > MB ? 'large' : fs.readFileSync(absolute, 'utf8');
      else result[path.relative(dir, absolute)] = 'special';
    }
  };
  walk(dir);
  return result;
}

function sparse(file, size) {
  fs.closeSync(fs.openSync(file, 'w'));
  fs.truncateSync(file, size);
}

function writeAnswers(cwd, input, name = 'answers.json') {
  fs.writeFileSync(path.join(cwd, name), JSON.stringify(input));
}

const KIND_AND_SITE = [
  { id: 'A.project-kind', status: 'complete', choice: ['redesign'] },
  { id: 'A.existing-site', status: 'complete', items: [{ text: 'https://old.example.com', note: 'The old site' }] },
];

function editFile(cwd, relative, from, to) {
  const file = path.join(cwd, relative);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes(from), `${relative} holds ${from}`);
  fs.writeFileSync(file, text.replace(from, () => to));
}

// ---- M2. two writers at once ----------------------------------------------------------------------------------------

const RACE_TARGETS = [
  'docs/01-brand/brand.md',
  'docs/00-brief.md',
  'docs/intake-state.json',
  'docs/07-risks-and-open-questions.md',
  'docs/intake-manifest.json',
];

for (const target of RACE_TARGETS) {
  test(`another program changing ${target} between the read and the rename stops the write: exit 3, nothing renamed, input kept`, async (t) => {
    const { cwd, options, run } = pack(t);
    applyAnswers(cwd, { answers: [{ id: 'A.goal', status: 'complete', text: 'A goal that is long enough to count as complete.' }] }, options);
    writeAnswers(cwd, { answers: [{ id: 'B.name', status: 'complete', text: 'Nordlys' }] });
    const before = snapshot(cwd);
    const targetPath = path.join(cwd, target);
    const original = fs.writeFileSync;
    let changed = null;
    t.mock.method(fs, 'writeFileSync', (file, ...rest) => {
      const result = original(file, ...rest);
      if (changed === null && String(file).endsWith('.tmp')) {
        changed = `${fs.readFileSync(targetPath, 'utf8')}\n`;
        original(targetPath, changed);
      }
      return result;
    });
    const result = await run(answer, ['--from', 'answers.json', '--delete', '--lang', 'en']);
    t.mock.restoreAll();
    assert.equal(result.code, 3);
    assert.equal(result.err, `Another program changed ${target} while this ran. Nothing was changed. Run the command again.\n`);
    assert.equal(result.out, '');
    const after = snapshot(cwd);
    assert.equal(after[target], changed, 'the other program\'s version is still there');
    assert.ok(Object.hasOwn(after, 'answers.json'), 'the input file is not deleted');
    delete after[target];
    delete before[target];
    assert.deepEqual(after, before, 'nothing else changed and no temporary or backup file is left');
  });
}

test('the same input works when run again, and the Danish message names the file too', async (t) => {
  const { cwd, options, run } = pack(t, 'da');
  applyAnswers(cwd, { answers: [{ id: 'A.goal', status: 'complete', text: 'Et mål, der er langt nok til at tælle som besvaret.' }] }, options);
  writeAnswers(cwd, { answers: [{ id: 'B.name', status: 'complete', text: 'Nordlys' }] });
  const original = fs.writeFileSync;
  let injected = false;
  t.mock.method(fs, 'writeFileSync', (file, ...rest) => {
    const result = original(file, ...rest);
    if (!injected && String(file).endsWith('.tmp')) {
      injected = true;
      original(path.join(cwd, 'docs/00-brief.md'), `${fs.readFileSync(path.join(cwd, 'docs/00-brief.md'), 'utf8')}\n`);
    }
    return result;
  });
  const failed = await run(answer, ['--from', 'answers.json', '--delete']);
  t.mock.restoreAll();
  assert.equal(failed.code, 3);
  assert.equal(failed.err, 'Et andet program ændrede docs/00-brief.md, mens dette kørte. Der er ikke ændret noget. Kør kommandoen igen.\n');
  const again = await run(answer, ['--from', 'answers.json', '--delete']);
  assert.equal(again.code, 0, again.err);
  assert.equal(fs.existsSync(path.join(cwd, 'answers.json')), false);
});

// ---- M3. assets that are too large or too many ---------------------------------------------------------------------------

test('an asset over the limit does not stop any command: it is flagged, never read, and marked in the manifest', async (t) => {
  const { cwd, run } = pack(t);
  sparse(path.join(cwd, 'docs/assets/huge.bin'), 600 * MB);
  fs.writeFileSync(path.join(cwd, 'docs/assets/small.txt'), 'hello');
  const opened = [];
  const originalOpen = fs.openSync;
  t.mock.method(fs, 'openSync', (file, ...rest) => {
    opened.push(String(file));
    return originalOpen(file, ...rest);
  });
  const report = JSON.parse((await run(check, ['--json'])).out);
  assert.deepEqual(
    report.flags.filter((flag) => flag.id === 'assets.tooLarge'),
    [{ id: 'assets.tooLarge', severity: 'warn', params: { file: 'huge.bin', size: '600 MB', limit: '500 MB', bytes: 600 * MB } }],
  );
  assert.match((await run(check, ['--lang', 'en'])).out, /The file huge\.bin is 600 MB, which is more than the 500 MB the zip can hold/);
  writeAnswers(cwd, { answers: [{ id: 'B.name', status: 'complete', text: 'Nordlys' }] });
  for (const [main, argv] of [
    [answer, ['--from', 'answers.json']],
    [check, ['--write']],
    [assets, ['--add', 'small.txt', '--what', 'A text', '--rights', 'Ours']],
    [assets, ['--add', 'huge.bin', '--what', 'A big file', '--rights', 'Ours']],
  ]) {
    const result = await run(main, argv);
    assert.equal(result.code, 0, `${argv.join(' ')}: ${result.err}`);
  }
  const manifest = readJson(path.join(cwd, 'docs/intake-manifest.json'));
  assert.deepEqual(manifest.files.find((entry) => entry.path === 'docs/assets/huge.bin'), { path: 'docs/assets/huge.bin', size: 600 * MB, skipped: 'tooLarge' });
  assert.match(manifest.files.find((entry) => entry.path === 'docs/assets/small.txt').sha256, /^[0-9a-f]{64}$/);
  t.mock.restoreAll();
  assert.equal(opened.some((file) => file.endsWith('huge.bin')), false, 'the large file was never opened');
});

test('files beyond the limit are left out, counted, and the first ones in sorted order are listed', (t) => {
  const { cwd, options } = pack(t);
  for (const name of ['h.txt', 'c.txt', 'a.txt', 'g.txt', 'b.txt', 'f.txt', 'e.txt', 'd.txt']) fs.writeFileSync(path.join(cwd, 'docs/assets', name), 'x');
  // The folder is listed in the worst order, so the first five must be picked after sorting.
  const originalList = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (...args) => originalList(...args).reverse());
  const read = parsePack(cwd, schema, { maxAssetFiles: 5 });
  t.mock.restoreAll();
  assert.deepEqual(read.assets.present, ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']);
  assert.equal(read.assets.omitted, 3);
  const flags = validatePack(read, schema, { today: TODAY }).flags.filter((flag) => flag.id === 'assets.tooMany');
  assert.deepEqual(flags.map((flag) => flag.params), [{ count: 3, limit: 5 }]);
  assert.equal(describeFlag(flags[0], testI18n('en')), '3 files in the folder docs/assets are not listed, because only the first 5 (in alphabetical order) are. Move the rest to another folder.');
  assert.ok(options);
});

test('files that together are over the size of a pack are reported by check, with the size', async (t) => {
  const { cwd, run } = pack(t);
  sparse(path.join(cwd, 'docs/assets/one.bin'), 300 * MB);
  sparse(path.join(cwd, 'docs/assets/two.bin'), 300 * MB);
  const report = JSON.parse((await run(check, ['--json'])).out);
  assert.deepEqual(report.flags.filter((flag) => flag.id === 'pack.tooBig').map((flag) => [flag.params.entries, flag.params.size, flag.params.bytes]), [[12, '600 MB', 600 * MB]]);
  assert.equal(report.flags.some((flag) => flag.id === 'assets.tooLarge'), false, 'each file is under the limit of one file');
});

test('a file that another program makes between the read and the rename is not overwritten', async (t) => {
  const { cwd, run } = setup(t);
  writeAnswers(cwd, { language: 'en', answers: [{ id: 'B.name', status: 'complete', text: 'Nordlys' }] });
  const briefPath = path.join(cwd, 'docs/00-brief.md');
  const original = fs.writeFileSync;
  let made = false;
  t.mock.method(fs, 'writeFileSync', (file, ...rest) => {
    const result = original(file, ...rest);
    if (!made && String(file).endsWith('.tmp')) {
      made = true;
      original(briefPath, 'written by someone else\n');
    }
    return result;
  });
  const result = await run(answer, ['--from', 'answers.json', '--lang', 'en']);
  t.mock.restoreAll();
  assert.equal(result.code, 3);
  assert.equal(result.err, 'Another program changed docs/00-brief.md while this ran. Nothing was changed. Run the command again.\n');
  assert.equal(fs.readFileSync(briefPath, 'utf8'), 'written by someone else\n');
  assert.deepEqual(fs.readdirSync(path.join(cwd, 'docs')), ['00-brief.md'], 'everything we made is gone');
});

test('50,003 files in the assets folder do not stop the interview: 50,000 are listed and 3 are left out', async (t) => {
  const { cwd, run } = pack(t);
  const folder = path.join(cwd, 'docs/assets');
  for (let index = 0; index < 50003; index += 1) fs.writeFileSync(path.join(folder, `f${String(index).padStart(5, '0')}.txt`), '');
  const report = JSON.parse((await run(check, ['--json'])).out);
  assert.deepEqual(report.flags.filter((flag) => flag.id === 'assets.tooMany').map((flag) => flag.params), [{ count: 3, limit: 50000 }]);
  writeAnswers(cwd, { answers: [{ id: 'B.name', status: 'complete', text: 'Nordlys' }] });
  const saved = await run(answer, ['--from', 'answers.json']);
  assert.equal(saved.code, 0, saved.err);
  const manifest = readJson(path.join(cwd, 'docs/intake-manifest.json'));
  assert.equal(manifest.files.filter((entry) => entry.path.startsWith('docs/assets/')).length, 50000);
  assert.equal(manifest.files.some((entry) => entry.path.endsWith('f50000.txt')), false);
});

// ---- M4. an answer to a question that is switched off ---------------------------------------------------------------------

test('a hand-edited switch keeps the answer: flagged, not scored, not asked, and still there after an unrelated answer', async (t) => {
  const { cwd, options, run } = pack(t);
  applyAnswers(cwd, { answers: KIND_AND_SITE }, options);
  const counts = (report) => report.completeness.counts;
  const first = JSON.parse((await run(check, ['--json'])).out);
  assert.equal(counts(first).complete, 2);
  assert.deepEqual(first.flags.filter((flag) => flag.id === 'answer.notApplicable'), []);
  const blockBefore = fs.readFileSync(path.join(cwd, 'docs/00-brief.md'), 'utf8').match(/<!-- q:A\.existing-site[\s\S]*?(?=\n###|\n*$)/)[0];

  editFile(cwd, 'docs/00-brief.md', 'Choice: redesign', 'Choice: new-site');
  const switched = JSON.parse((await run(check, ['--json'])).out);
  assert.equal(switched.questions['A.existing-site'].status, 'skipped');
  assert.equal(switched.questions['A.existing-site'].declared, 'complete');
  assert.equal(counts(switched).complete, 1, 'not counted');
  assert.equal(counts(switched).skipped, switched.completeness.counts.skipped);
  const flag = switched.flags.find((entry) => entry.id === 'answer.notApplicable');
  assert.deepEqual(flag, { id: 'answer.notApplicable', severity: 'info', qid: 'A.existing-site', file: 'brief', params: { controller: 'A.project-kind' } });
  assert.match((await run(check, ['--lang', 'en'])).out, /has an answer, but the answer to Kind of project \(A\.project-kind\) switches this question off/);
  const asked = JSON.parse((await run(next, ['--count', '50'])).out);
  assert.equal(asked.questions.some((question) => question.id === 'A.existing-site'), false);

  writeAnswers(cwd, { answers: [{ id: 'A.budget', status: 'complete', text: '100,000 kroner' }] });
  const saved = await run(answer, ['--from', 'answers.json']);
  assert.equal(saved.code, 0, saved.err);
  const brief = fs.readFileSync(path.join(cwd, 'docs/00-brief.md'), 'utf8');
  assert.ok(brief.includes('https://old.example.com | The old site'), 'the answer survived the unrelated write');
  assert.equal(brief.match(/<!-- q:A\.existing-site[\s\S]*?(?=\n###|\n*$)/)[0], blockBefore, 'exactly as written');

  editFile(cwd, 'docs/00-brief.md', 'Choice: new-site', 'Choice: redesign');
  const back = JSON.parse((await run(check, ['--json'])).out);
  assert.equal(back.questions['A.existing-site'].status, 'complete');
  assert.equal(counts(back).complete, 3, 'counted again');
  assert.deepEqual(back.flags.filter((entry) => entry.id === 'answer.notApplicable'), []);
});

test('the same holds for a deferred answer and for a custom showIf', (t) => {
  const custom = structuredClone(schema);
  custom.modules.find((entry) => entry.id === 'G').questions.find((q) => q.id === 'G.integrations').showIf = { id: 'G.features', in: ['booking'] };
  const { cwd, schemaDir } = setup(t);
  const options = { schema: custom, schemaDir, now: NOW, today: TODAY };
  applyAnswers(cwd, { language: 'en', answers: [{ id: 'G.features', status: 'complete', choice: ['booking'] }, { id: 'G.integrations', status: 'tbd', owner: 'client', note: 'Ask the web shop' }] }, options);
  editFile(cwd, 'docs/04-scope-and-structure.md', 'Choice: booking', 'Choice: blog');
  const read = parsePack(cwd, custom);
  const report = validatePack(read, custom, { today: TODAY });
  assert.equal(report.questions['G.integrations'].status, 'skipped');
  assert.deepEqual(report.flags.filter((flag) => flag.id === 'answer.notApplicable').map((flag) => [flag.qid, flag.params.controller]), [['G.integrations', 'G.features']]);
  applyAnswers(cwd, { answers: [{ id: 'G.pages', status: 'complete', items: [{ text: 'Home' }] }] }, options);
  const text = fs.readFileSync(path.join(cwd, 'docs/04-scope-and-structure.md'), 'utf8');
  assert.match(text, /<!-- q:G\.integrations status:tbd owner:client -->\nAsk the web shop/);
  editFile(cwd, 'docs/04-scope-and-structure.md', 'Choice: blog', 'Choice: booking');
  assert.equal(validatePack(parsePack(cwd, custom), custom, { today: TODAY }).questions['G.integrations'].status, 'tbd');
});

test('an input that clears the switched-off question as missing still removes it, and giving it an answer is still refused', (t) => {
  const { cwd, options } = pack(t);
  applyAnswers(cwd, { answers: KIND_AND_SITE }, options);
  editFile(cwd, 'docs/00-brief.md', 'Choice: redesign', 'Choice: new-site');
  assert.throws(
    () => applyAnswers(cwd, { answers: [{ id: 'A.existing-site', status: 'complete', items: [{ text: 'https://other.example.com' }] }] }, options),
    (error) => error.problems[0].key === 'ui.answer.err.notApplicable',
  );
  applyAnswers(cwd, { answers: [{ id: 'A.existing-site', status: 'missing' }] }, options);
  const brief = fs.readFileSync(path.join(cwd, 'docs/00-brief.md'), 'utf8');
  assert.ok(!brief.includes('old.example.com'));
  assert.ok(!brief.includes('q:A.existing-site'), 'no block is written for a switched-off question without an answer');
});

test('a marker without an answer under a switched-off question is not an answer: no flag, and it is not written again', async (t) => {
  const { cwd, options, run } = pack(t);
  applyAnswers(cwd, { answers: [{ id: 'A.project-kind', status: 'complete', choice: ['new-site'] }] }, options);
  editFile(cwd, 'docs/00-brief.md', '### ', '### Existing\n<!-- q:A.existing-site status:missing -->\n\n### ');
  const report = JSON.parse((await run(check, ['--json'])).out);
  assert.equal(report.questions['A.existing-site'].declared, 'missing');
  assert.deepEqual(report.flags.filter((flag) => flag.id === 'answer.notApplicable'), []);
  applyAnswers(cwd, { answers: [{ id: 'A.budget', status: 'complete', text: '100,000 kroner' }] }, options);
  assert.ok(!fs.readFileSync(path.join(cwd, 'docs/00-brief.md'), 'utf8').includes('q:A.existing-site'));
});

// ---- L1. a focus that no longer applies ------------------------------------------------------------------------------------

test('a focus question that is switched off is dropped when the state is written, and answering the others empties the focus', (t) => {
  const { cwd, options } = pack(t);
  applyAnswers(cwd, { answers: [{ id: 'A.project-kind', status: 'complete', choice: ['new-site'] }], focus: ['A.existing-site', 'A.budget'] }, options);
  assert.deepEqual(readJson(path.join(cwd, 'docs/intake-state.json')).focus, ['A.budget']);
  applyAnswers(cwd, { answers: [{ id: 'A.budget', status: 'complete', text: '100,000 kroner' }] }, options);
  assert.deepEqual(readJson(path.join(cwd, 'docs/intake-state.json')).focus, []);
});

test('next ignores focus ids that do not apply and falls back to the normal order', async (t) => {
  const { cwd, options, run } = pack(t);
  applyAnswers(cwd, { answers: [{ id: 'A.project-kind', status: 'complete', choice: ['new-site'] }] }, options);
  const statePath = path.join(cwd, 'docs/intake-state.json');
  fs.writeFileSync(statePath, JSON.stringify({ ...readJson(statePath), focus: ['A.existing-site'] }));
  const result = JSON.parse((await run(next, [])).out);
  assert.ok(result.questions.length > 0, 'the interview goes on');
  assert.equal(result.done, false);
  assert.equal(result.questions.some((question) => question.id === 'A.existing-site'), false);
  fs.writeFileSync(statePath, JSON.stringify({ ...readJson(statePath), focus: ['A.existing-site', 'A.budget'] }));
  assert.deepEqual(JSON.parse((await run(next, [])).out).questions.map((question) => question.id), ['A.budget']);
  const report = validatePack(parsePack(cwd, schema), schema, { today: TODAY });
  assert.ok(nextQuestions(parsePack(cwd, schema), schema, report, { count: 3 }).length > 0);
});

// ---- L2. the language of a pack is not set from the console -----------------------------------------------------------------

for (const [lang, line] of [
  ['en', 'No answer has set the language of this pack yet, so nothing was written. The first answer sets it.'],
  ['da', 'Ingen svar har endnu fastsat sprog for denne pakke, så der er ikke skrevet noget. Det første svar fastsætter det.'],
]) {
  test(`check --write before the first answer writes nothing and does not lock the language (${lang})`, async (t) => {
    const { cwd, run } = setup(t);
    assert.equal((await run(assets, ['--init'])).code, 0);
    fs.writeFileSync(path.join(cwd, 'docs/assets/logo.svg'), '<svg/>');
    const before = snapshot(cwd);
    const result = await run(check, ['--write', '--lang', lang], { env: { LANG: 'en_US.UTF-8' } });
    assert.equal(result.code, 0, result.err);
    assert.ok(`${result.out}${result.err}`.includes(line), `${result.out}${result.err}`);
    assert.deepEqual(snapshot(cwd), before);
    writeAnswers(cwd, { language: 'da', answers: [{ id: 'B.name', status: 'complete', text: 'Nordlys' }] });
    const saved = await run(answer, ['--from', 'answers.json'], { env: { LANG: 'en_US.UTF-8' } });
    assert.equal(saved.code, 0, saved.err);
    assert.equal(readJson(path.join(cwd, 'docs/intake-manifest.json')).language, 'da');
  });
}

// ---- L4. --delete that fails after a successful write -------------------------------------------------------------------------

test('a --delete that fails after the write prints the summary, warns with the path and exits 0 (answer and assets)', async (t) => {
  const { cwd, run } = pack(t);
  fs.writeFileSync(path.join(cwd, 'docs/assets/logo.svg'), '<svg/>');
  writeAnswers(cwd, { answers: [{ id: 'B.name', status: 'complete', text: 'Nordlys' }] });
  writeAnswers(cwd, { rows: [{ file: 'logo.svg', what: 'Logo', rights: 'Ours' }] }, 'rows.json');
  const original = fs.rmSync;
  t.mock.method(fs, 'rmSync', (file, ...rest) => {
    if (String(file).endsWith('answers.json') || String(file).endsWith('rows.json')) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    return original(file, ...rest);
  });
  const saved = await run(answer, ['--from', 'answers.json', '--delete', '--lang', 'en']);
  assert.equal(saved.code, 0, saved.err);
  assert.ok(Array.isArray(JSON.parse(saved.out).written));
  assert.equal(saved.err, `The answers were saved, but the file ${path.join(cwd, 'answers.json')} could not be removed (EPERM). Remove it yourself.\n`);
  const listed = await run(assets, ['--from', 'rows.json', '--delete', '--json', '--lang', 'en']);
  assert.equal(listed.code, 0, listed.err);
  assert.equal(JSON.parse(listed.out).added.length, 1);
  assert.match(listed.err, /rows\.json could not be removed \(EPERM\)/);
});

// ---- L6. names that collide on Windows and macOS --------------------------------------------------------------------------------

test('names that differ in a letter that changes case in two steps are one name', () => {
  for (const [first, second] of [['i.txt', 'ı.txt'], ['s.txt', 'ſ.txt'], ['ασ.txt', 'ας.txt'], ['Logo.png', 'logo.png'], [`${char(0xc5)}.png`, `${char(0x41, 0x30a)}.png`]]) {
    assert.equal(foldPackName(first), foldPackName(second), `${first} ${second}`);
    const problems = entryNameProblems([`docs/assets/${first}`, `docs/assets/${second}`]);
    assert.deepEqual(problems.map((problem) => [problem.name, problem.code, problem.other]), [[`docs/assets/${second}`, 'duplicate', `docs/assets/${first}`]]);
  }
  assert.notEqual(foldPackName('a.txt'), foldPackName('b.txt'));
  assert.notEqual(foldPackName(`stra${char(0xdf)}e.txt`), foldPackName('STRASSE.txt'), 'the sharp s is not the letters ss on Windows');
});

// ---- L7. links and special files in the assets folder -------------------------------------------------------------------------------

test('a link in docs/assets is reported by check and by assets --scan before pack refuses it', async (t) => {
  const { cwd, run } = pack(t);
  const real = path.join(cwd, 'outside.txt');
  fs.writeFileSync(real, 'x');
  try {
    fs.symlinkSync(real, path.join(cwd, 'docs/assets/link.txt'));
  } catch {
    return t.skip('symbolic links are not available here');
  }
  fs.writeFileSync(path.join(cwd, 'docs/assets/plain.txt'), 'x');
  const report = JSON.parse((await run(check, ['--json'])).out);
  assert.deepEqual(report.flags.filter((flag) => flag.id === 'assets.notPackable').map((flag) => flag.params), [{ file: 'link.txt', reasonCode: 'notPlain' }]);
  const scan = JSON.parse((await run(assets, ['--scan', '--json'])).out);
  assert.deepEqual(scan.notPackable, [{ file: 'link.txt', reason: 'notPlain' }]);
  assert.match((await run(assets, ['--scan', '--lang', 'en'])).out, /link\.txt: the entry is a link or a special file, not a plain file/);
  assert.match((await run(assets, ['--scan', '--lang', 'da'])).out, /link\.txt: /);
  const message = describeFlag(report.flags.find((flag) => flag.id === 'assets.notPackable'), testI18n('da'));
  assert.ok(message.includes('link.txt') && !message.includes('{') && !message.includes('ui.nameReason'), message);
});

// ---- L8. leftover temporary files -------------------------------------------------------------------------------------------------------

test('stale temporary files of ours are swept at the start of a write, and nothing else is touched', async (t) => {
  const { cwd, run } = pack(t);
  const minutes = (count) => new Date(NOW.getTime() - count * 60 * 1000);
  const make = (relative, age) => {
    const file = path.join(cwd, relative);
    fs.writeFileSync(file, 'old answer text');
    fs.utimesSync(file, minutes(age), minutes(age));
    return file;
  };
  const stale = make('docs/00-brief.md.0a1b2c3d4e5f.tmp', 11);
  const staleBrand = make('docs/01-brand/brand.md.ffffffffffff.tmp', 60);
  const fresh = make('docs/00-brief.md.111111111111.tmp', 2);
  const foreign = make('docs/notes.md.0a1b2c3d4e5f.tmp', 600);
  const plain = make('docs/other.tmp', 600);
  const wrongLength = make('docs/00-brief.md.0a1b2c.tmp', 600);
  const assetTemp = make('docs/assets/logo.svg.0a1b2c3d4e5f.tmp', 600);
  const real = path.join(cwd, 'outside.tmp');
  fs.writeFileSync(real, 'x');
  fs.utimesSync(real, minutes(600), minutes(600));
  let linked = null;
  try {
    linked = path.join(cwd, 'docs/assets.md.abcdefabcdef.tmp');
    fs.symlinkSync(real, linked);
  } catch {
    linked = null;
  }
  writeAnswers(cwd, { answers: [{ id: 'B.name', status: 'complete', text: 'Nordlys' }] });
  const saved = await run(answer, ['--from', 'answers.json', '--lang', 'en']);
  assert.equal(saved.code, 0, saved.err);
  assert.equal(saved.err, 'Removed leftover temporary files from an earlier run: docs/00-brief.md.0a1b2c3d4e5f.tmp, docs/01-brand/brand.md.ffffffffffff.tmp\n');
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(staleBrand), false);
  for (const kept of [fresh, foreign, plain, wrongLength, assetTemp, real]) assert.equal(fs.existsSync(kept), true, kept);
  if (linked) assert.equal(fs.lstatSync(linked).isSymbolicLink(), true, 'a link is left alone');
  const second = await run(check, ['--write', '--lang', 'en']);
  assert.equal(second.err, '', 'nothing more to sweep');
  assert.equal(JSON.parse((await run(check, ['--json'])).out).flags.some((flag) => flag.id === 'file.strayText'), false);
});

// ---- L9. folders left behind by a failed first write -----------------------------------------------------------------------------------

test('a failed first write leaves no folder behind, wherever it fails', async (t) => {
  for (const failAt of [1, 2, 3, 5]) {
    const { cwd, run } = setup(t);
    writeAnswers(cwd, { language: 'en', answers: [{ id: 'B.name', status: 'complete', text: 'Nordlys' }] });
    const original = fs.renameSync;
    let calls = 0;
    t.mock.method(fs, 'renameSync', (from, to) => {
      calls += 1;
      if (calls === failAt) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
      return original(from, to);
    });
    const result = await run(answer, ['--from', 'answers.json']);
    t.mock.restoreAll();
    assert.equal(result.code, 3, `${failAt}: ${result.err}`);
    assert.deepEqual(fs.readdirSync(cwd), ['answers.json'], `rename ${failAt}: nothing but the input is left`);
  }
});

// ---- L10. a pack that pack would refuse ------------------------------------------------------------------------------------------------

test('check warns when the pack would pass the number of files or the size that pack accepts', async (t) => {
  assert.equal(MAX_PACK_FILES, 5000);
  assert.equal(MAX_PACK_BYTES, 500 * MB);
  const source = fs.readFileSync(new URL('../../skill/everything-mapped/scripts/pack.mjs', import.meta.url), 'utf8');
  const declared = /const MAX_PACK_FILES = (\d+);/.exec(source);
  if (declared) assert.equal(Number(declared[1]), MAX_PACK_FILES, 'pack.mjs and the library use the same limit');
  const bytes = /const MAX_PACK_BYTES = (\d+) \* MB;/.exec(source);
  if (bytes) assert.equal(Number(bytes[1]) * MB, MAX_PACK_BYTES);

  const names = (count) => Array.from({ length: count }, (_, index) => `f${index}.txt`);
  const flagsFor = (assetsData) => {
    const data = makePackData([]);
    data.assets = { rows: [], present: [], invalid: [], notPlain: [], large: [], omitted: 0, bytes: 0, ...assetsData };
    return validatePackData(data, schema, { today: TODAY }).flags.filter((flag) => flag.id === 'pack.tooBig');
  };
  assert.deepEqual(flagsFor({ present: names(4990) }), [], '4990 assets and the 10 files of the layout are exactly the limit');
  assert.deepEqual(flagsFor({ present: names(4991) }).map((flag) => flag.params), [{ entries: 5001, maxEntries: 5000, size: '0 MB', maxSize: '500 MB', bytes: 0, maxBytes: 500 * MB }]);
  assert.equal(flagsFor({ present: names(3), omitted: 4988 }).length, 1, 'files that are not listed count too: pack would see them');
  assert.equal(flagsFor({ present: names(3), bytes: 500 * MB }).length, 0);
  assert.equal(flagsFor({ present: names(3), bytes: 500 * MB + 1 }).length, 1);
  const message = describeFlag(flagsFor({ present: names(3), bytes: 600 * MB })[0], testI18n('en'));
  assert.equal(message, 'The pack would hold 13 files and 600 MB. The zip takes at most 5000 files and 500 MB, so pack will stop. Remove or shrink files in docs/assets.');

  const { cwd, run } = pack(t);
  for (const name of names(4995)) fs.writeFileSync(path.join(cwd, 'docs/assets', name), '');
  const report = JSON.parse((await run(check, ['--json'])).out);
  assert.equal(report.flags.filter((flag) => flag.id === 'pack.tooBig').length, 1);
});

// ---- L11. texts that blame the input -----------------------------------------------------------------------------------------------------

test('the texts for a result that grows past a limit ask for a shorter input and do not send anyone to edit files', () => {
  for (const lang of ['da', 'en']) {
    const texts = readJson(path.join(import.meta.dirname, `../../skill/everything-mapped/schema/ui-check.${lang}.json`));
    for (const key of ['ui.answer.err.resultLineTooLong', 'ui.answer.err.resultBodyTooLarge']) {
      assert.doesNotMatch(texts[key], /by hand|i hånden/, `${lang} ${key}`);
      assert.match(texts[key], lang === 'en' ? /Nothing was written\. Shorten the text in your input and send it again\.$/ : /Der er ikke skrevet noget\. Gør teksten i dit input kortere, og send det igen\.$/);
    }
  }
});

// ---- L13. whitespace that does not survive ---------------------------------------------------------------------------------------------------

test('white space of any kind at the ends of items and notes is not kept, and the round trip is exact', () => {
  const nbsp = char(0xa0);
  const ideographic = char(0x3000);
  const question = findQuestion(schema, 'E.like');
  const input = { items: [{ text: `${nbsp}A${nbsp}`, note: `${ideographic}n${ideographic}` }, { text: nbsp, note: 'lost with it' }, { text: `${ideographic} `, note: '' }, 'B'] };
  const body = bodyFromInput(question, input);
  assert.equal(body, '- A | n\n- B');
  const parsed = parseBody(question, body);
  assert.deepEqual(parsed.items, [{ text: 'A', note: 'n' }, { text: 'B', note: '' }]);
  assert.equal(bodyFromInput(question, parsed), body);
});

test('an answer whose only item is white space is refused as having no content', (t) => {
  const { cwd, options } = pack(t);
  assert.throws(
    () => applyAnswers(cwd, { answers: [{ id: 'E.like', status: 'complete', items: [{ text: char(0xa0) }] }] }, options),
    (error) => error.problems[0].key === 'ui.answer.err.noContent',
  );
});

test('lines of a note lose their indentation consistently, so the round trip is exact', () => {
  const question = findQuestion(schema, 'A.project-kind');
  const body = bodyFromInput(question, { choice: ['redesign'], note: 'first\n    indented\n\t\ttabbed\n  two' });
  assert.equal(body, 'Choice: redesign\nNote: first\nNote: indented\nNote: tabbed\nNote: two');
  const parsed = parseBody(question, body);
  assert.equal(parsed.note, 'first\nindented\ntabbed\ntwo');
  assert.equal(bodyFromInput(question, parsed), body);
  const nbspNote = bodyFromInput(question, { choice: ['redesign'], note: `${char(0xa0)}text${char(0xa0)}` });
  assert.equal(nbspNote, 'Choice: redesign\nNote: text');
});

