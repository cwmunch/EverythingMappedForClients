// Tests for the second round of contract changes: stray text, the scope of the open-questions
// table, unknown rights, assets --remove, pasted text in link lists, check --write with only
// docs/assets, and hasAnyAnswer.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { applyAnswers, hasAnyAnswer, parsePack, refreshPack } from '../../skill/everything-mapped/scripts/lib/index.mjs';
import { main as assets } from '../../skill/everything-mapped/scripts/assets.mjs';
import { main as check } from '../../skill/everything-mapped/scripts/check.mjs';
import { describeFlag } from '../../skill/everything-mapped/scripts/lib/render.mjs';
import { parseFile } from '../../skill/everything-mapped/scripts/lib/parse.mjs';
import { renderOpenQuestions } from '../../skill/everything-mapped/scripts/lib/render.mjs';
import { validatePackData } from '../../skill/everything-mapped/scripts/lib/validate.mjs';
import {
  FIXTURES,
  NOW,
  TODAY,
  complete,
  copyFolder,
  flagsFor,
  makePackData,
  makeSchemaDir,
  makeTempDir,
  readJson,
  runScript,
  schema,
  testI18n,
  writeText,
} from './helpers.mjs';

const FRONT = '---\nschema: everything-mapped-for-clients/1\nfile: brief\nlanguage: da\nupdated: 2026-10-23\n---\n';

function validate(inputs, options = {}) {
  return validatePackData(makePackData(inputs, options), schema, { today: TODAY, depth: options.depth });
}

function setup(t, fixture) {
  const schemaDir = makeSchemaDir(t);
  const cwd = makeTempDir(t);
  if (fixture) copyFolder(path.join(FIXTURES, fixture), cwd);
  return { schemaDir, cwd, run: (main, argv, extra = {}) => runScript(main, argv, { cwd, schemaDir, ...extra }) };
}

// ---- file.strayText ----------------------------------------------------------------------------

function strayOf(text) {
  const parsed = parseFile(`${FRONT}${text}`, schema);
  return { flags: parsed.flags.filter((flag) => flag.id === 'file.strayText'), parsed };
}

test('file.strayText: text under a heading and before the first marker is reported with its line and an excerpt', () => {
  const { flags } = strayOf('\n# Title\n\nAn introduction somebody added.\n\n## Module\n\n### Q\n<!-- q:A.goal status:complete -->\nGoal\n');
  assert.equal(flags.length, 1);
  assert.deepEqual(flags[0], {
    id: 'file.strayText',
    severity: 'warn',
    params: { line: 10, excerpt: 'An introduction somebody added.', count: 1 },
  });
});

test('file.strayText: one flag per file, with the first line and the number of lines', () => {
  const { flags } = strayOf('\n# Title\nFirst stray line\n\n### Q\n<!-- q:A.goal status:complete -->\nGoal\n\n## Module\nSecond stray line\nThird stray line\n');
  assert.equal(flags.length, 1);
  assert.deepEqual([flags[0].params.line, flags[0].params.excerpt, flags[0].params.count], [9, 'First stray line', 3]);
});

test('file.strayText: a heading inside an answer that starts text of its own is reported', () => {
  const { flags, parsed } = strayOf('\n### Q\n<!-- q:A.goal status:complete -->\nGoal text\n### My own heading\nMy own paragraph\n');
  assert.equal(parsed.answers['A.goal'].body, 'Goal text');
  assert.equal(flags.length, 1);
  assert.equal(flags[0].params.excerpt, '### My own heading', 'the heading comes first');
  assert.equal(flags[0].params.count, 2);
});

test('file.strayText: a question heading without a marker is reported, one with a marker is not', () => {
  assert.equal(strayOf('\n### Lonely heading\n\n## Module\n').flags.length, 1);
  assert.equal(strayOf('\n### Q\n\n<!-- q:A.goal status:complete -->\nGoal\n').flags.length, 0, 'blank lines between heading and marker are fine');
  assert.equal(strayOf('\n# Title\n\n## Module\n\n### Q\n<!-- q:A.goal status:missing -->\n').flags.length, 0);
});

test('file.strayText: the body of an unknown or duplicate marker is not stray text', () => {
  const text = '\n### A\n<!-- q:Z.nothing status:complete -->\nBody of an unknown question\n\n### B\n<!-- q:A.goal status:complete -->\nGoal\n\n### C\n<!-- q:A.goal status:partial -->\nSecond body\n';
  const { flags, parsed } = strayOf(text);
  assert.deepEqual(flags, []);
  assert.deepEqual(parsed.flags.map((flag) => flag.id), ['marker.unknownQuestion', 'marker.duplicate']);
});

test('file.strayText: headings of level 4 or deeper inside an answer stay in the answer', () => {
  const { flags, parsed } = strayOf('\n### Q\n<!-- q:A.goal status:complete -->\nGoal\n#### Deeper heading\nMore\n');
  assert.deepEqual(flags, []);
  assert.equal(parsed.answers['A.goal'].body, 'Goal\n#### Deeper heading\nMore');
});

test('file.strayText: a long excerpt is cut at 60 characters and written on one line', () => {
  const { flags } = strayOf(`\n# Title\n\n${'word '.repeat(40)}\n`);
  assert.ok(flags[0].params.excerpt.endsWith('...'));
  assert.equal(Array.from(flags[0].params.excerpt).length, 63);
});

test('file.strayText: files without front matter report it as well, and fixtures that are clean stay clean', () => {
  const parsed = parseFile('# Indhold\n\nDenne fil mangler front matter.\n\n### Q\n<!-- q:C.offers status:missing -->\n', schema);
  assert.deepEqual(parsed.flags.map((flag) => flag.id), ['file.badFrontMatter', 'file.strayText']);
  for (const name of ['pack-da-complete', 'pack-en-partial']) {
    const pack = parsePack(path.join(FIXTURES, name), schema);
    for (const file of Object.values(pack.files)) assert.deepEqual(file.flags, [], `${name} ${file.path}`);
  }
});

test('file.strayText reaches the report with the file, path and a message in both languages', () => {
  const pack = parsePack(path.join(FIXTURES, 'pack-broken'), schema);
  const report = validatePackData(pack, schema, { today: TODAY });
  const flag = report.flags.find((entry) => entry.id === 'file.strayText');
  assert.equal(flag.file, 'content');
  assert.equal(flag.severity, 'warn');
  assert.deepEqual(flag.params, { file: 'content', path: 'docs/03-content-inventory.md', line: 3, excerpt: 'Denne fil mangler front matter.', count: 1 });
  assert.equal(
    describeFlag(flag, testI18n('en')),
    'docs/03-content-inventory.md: there is text outside the answers, from line 3 ("Denne fil mangler front matter."). It is removed the next time answers are saved.',
  );
  assert.ok(describeFlag(flag, testI18n('da')).startsWith('docs/03-content-inventory.md: der står tekst uden for svarene, fra linje 3'));
});

test('text added outside the answers is reported by check and is gone after the next save', async (t) => {
  const { cwd, schemaDir, run } = setup(t, 'pack-en-partial');
  const briefPath = path.join(cwd, 'docs/00-brief.md');
  fs.writeFileSync(briefPath, fs.readFileSync(briefPath, 'utf8').replace('## ', 'My note, added by hand.\n\n## '));
  const before = await run(check, ['--json']);
  assert.ok(JSON.parse(before.out).flags.some((flag) => flag.id === 'file.strayText' && flag.file === 'brief'));
  applyAnswers(cwd, { answers: [{ id: 'A.budget', status: 'complete', text: 'Lidt' }] }, { schema, schemaDir, now: NOW, today: TODAY });
  assert.ok(!fs.readFileSync(briefPath, 'utf8').includes('My note, added by hand.'));
  const after = JSON.parse((await run(check, ['--json'])).out);
  assert.ok(!after.flags.some((flag) => flag.id === 'file.strayText'));
});

// ---- open questions: deferred rows by depth -----------------------------------------------------

const DEFERRED = [
  { id: 'A.stakeholders', status: 'tbd', owner: 'client', due: '2026-11-05', note: 'Must-answer question' },
  { id: 'A.budget', status: 'tbd', owner: 'client', due: '2026-11-05', note: 'Recommended question' },
  { id: 'A.failure', status: 'tbd', owner: 'client', due: '2026-11-05', note: 'Optional question' },
];

function openText(depth, inputs = DEFERRED) {
  return renderOpenQuestions(validate(inputs, { depth }), testI18n('en'));
}

test('open questions list deferred questions of every level in scope of the depth', () => {
  const full = openText('full');
  assert.ok(full.includes('| A.stakeholders | To be decided | client | 2026-11-05 | Must-answer question |'));
  assert.ok(full.includes('| A.budget | To be decided | client | 2026-11-05 | Recommended question |'));
  assert.ok(full.includes('| A.failure | To be decided | client | 2026-11-05 | Optional question |'));
  assert.ok(full.indexOf('### Nice to have') > full.indexOf('### Recommended'));
  assert.ok(full.indexOf('| A.failure |') > full.indexOf('### Nice to have'));
});

test('open questions leave out deferred questions that are out of scope of the depth', () => {
  const standard = openText('standard');
  assert.ok(standard.includes('| A.budget |') && !standard.includes('| A.failure |') && !standard.includes('### Nice to have'));
  const essentials = openText('essentials');
  assert.ok(essentials.includes('| A.stakeholders |') && !essentials.includes('| A.budget |') && !essentials.includes('| A.failure |'));
});

test('open questions list missing questions of the must-answer and recommended levels only', () => {
  const full = openText('full', []);
  assert.ok(full.includes('| The main goal |') && full.includes('| A.budget |'));
  assert.ok(!full.includes('| A.failure |'), 'a missing optional question is not listed, even at the full depth');
  assert.ok(!full.includes('### Nice to have'));
});

test('the open-questions file written by check --write has the optional group at the full depth', async (t) => {
  const { cwd, run } = setup(t, 'pack-da-complete');
  const statePath = path.join(cwd, 'docs/intake-state.json');
  applyAnswers(cwd, { answers: [{ id: 'A.failure', status: 'tbd', owner: 'client', note: 'Senere' }] }, { schema, schemaDir: makeSchemaDir(t), now: NOW, today: TODAY });
  assert.ok(fs.existsSync(statePath));
  const text = fs.readFileSync(path.join(cwd, 'docs/07-risks-and-open-questions.md'), 'utf8');
  assert.ok(text.includes('### Godt at have'));
  assert.ok(text.includes('| A.failure | Afklares senere | client |  | Senere |'));
  const standard = await run(check, ['--write', '--depth', 'standard']);
  assert.equal(standard.code, 0);
  assert.ok(!fs.readFileSync(path.join(cwd, 'docs/07-risks-and-open-questions.md'), 'utf8').includes('| A.failure |'));
});

// ---- assets.rightsUnknown ---------------------------------------------------------------------

test('assets.rightsUnknown: unknown and ukendt in any case are flagged, other rights and empty rights are not', () => {
  const row = (file, rights) => ({ file, what: '', owner: '', rights, restrictions: '' });
  const assetsData = {
    rows: [row('assets/a.png', 'unknown'), row('assets/b.png', ' Ukendt '), row('assets/c.png', 'UNKNOWN'), row('assets/d.png', 'Ejes af kunden'), row('assets/e.png', ''), row('assets/f.png', 'unknown license')],
    present: ['a.png', 'b.png', 'c.png', 'd.png', 'e.png', 'f.png'],
  };
  const report = validate([], { assets: assetsData });
  const ids = (id) => report.flags.filter((flag) => flag.id === id).map((flag) => flag.params.file);
  assert.deepEqual(ids('assets.rightsUnknown'), ['assets/a.png', 'assets/b.png', 'assets/c.png']);
  assert.deepEqual(ids('assets.noRights'), ['assets/e.png']);
  assert.equal(report.flags.find((flag) => flag.id === 'assets.rightsUnknown').severity, 'warn');
});

test('assets scan lists unknown rights and no longer claims that every row has rights', async (t) => {
  const { cwd, run } = setup(t, 'pack-da-complete');
  const tablePath = path.join(cwd, 'docs/assets.md');
  fs.writeFileSync(tablePath, fs.readFileSync(tablePath, 'utf8').replace('Ejes af kunden', 'ukendt'));
  const scan = await run(assets, ['--scan']);
  assert.ok(scan.out.includes('Rækker, hvor rettighederne er ukendte:\n  - assets/logo.svg\n'));
  assert.ok(scan.out.includes('Alle filer står på listen.'));
  assert.ok(!/rettigheder(ne)? (er|har)/.test(scan.out.replace('Rækker, hvor rettighederne er ukendte', '')), 'no claim about rights');
  const json = JSON.parse((await run(assets, ['--scan', '--json'])).out);
  assert.deepEqual(json.rightsUnknown, ['assets/logo.svg']);
  const report = JSON.parse((await run(check, ['--json'])).out);
  assert.ok(report.flags.some((flag) => flag.id === 'assets.rightsUnknown'));
});

// ---- assets --remove -------------------------------------------------------------------------------

test('assets --remove takes the row out of the table and leaves the file alone', async (t) => {
  const { cwd, run } = setup(t, 'pack-broken');
  const result = await run(assets, ['--remove', 'ghost.svg', '--json']);
  assert.equal(result.code, 0, result.err);
  const data = JSON.parse(result.out);
  assert.deepEqual(data.removed, ['assets/ghost.svg']);
  assert.deepEqual(data.missingFile, ['assets/skjult<U+202E>navn.png'], 'the damaged row is left without a file, and its hidden character is now written as a marker');
  assert.ok(!fs.readFileSync(path.join(cwd, 'docs/assets.md'), 'utf8').includes('ghost.svg'));
  assert.equal(data.rows.length, 3);
  assert.ok(fs.existsSync(path.join(cwd, 'docs/assets/logo.svg')));
});

test('assets --remove works with the assets/ and docs/assets/ prefixes, also for a file that exists', async (t) => {
  const { cwd, run } = setup(t, 'pack-broken');
  assert.equal((await run(assets, ['--remove', 'assets/notes.txt'])).code, 0);
  assert.ok(!fs.readFileSync(path.join(cwd, 'docs/assets.md'), 'utf8').includes('notes.txt'));
  assert.ok(fs.existsSync(path.join(cwd, 'docs/assets/notes.txt')), 'the file stays');
  const human = await run(assets, ['--remove', 'docs/assets/logo.svg', '--lang', 'en']);
  assert.ok(human.out.startsWith('Removed from the list: assets/logo.svg\n'));
  assert.ok(human.out.includes('assets/logo.svg'), 'the file is now missing from the table');
  assert.ok(fs.existsSync(path.join(cwd, 'docs/assets/logo.svg')));
  const manifest = readJson(path.join(cwd, 'docs/intake-manifest.json'));
  assert.ok(manifest.files.some((entry) => entry.path === 'docs/assets/notes.txt'));
});

test('assets --remove of a row that is not in the table exits 2 and changes nothing', async (t) => {
  const { cwd, run } = setup(t, 'pack-broken');
  const before = fs.readFileSync(path.join(cwd, 'docs/assets.md'), 'utf8');
  const missing = await run(assets, ['--remove', 'nothing.png', '--lang', 'en']);
  assert.deepEqual([missing.code, missing.out, missing.err], [2, '', 'nothing.png is not in the list.\n']);
  assert.equal((await run(assets, ['--remove', '../x'])).code, 2);
  assert.equal((await run(assets, ['--remove'])).code, 2);
  assert.equal(fs.readFileSync(path.join(cwd, 'docs/assets.md'), 'utf8'), before);
});

// ---- rule.notUrl ------------------------------------------------------------------------------------

function linkFlags(text) {
  const report = validate([complete('E.like', { items: [{ text }, { text: 'https://example.com/a' }, { text: 'https://example.com/b' }] })]);
  return { report, flags: flagsFor(report, 'E.like') };
}

test('rule.notUrl: a pasted sentence is information, and the answer stays complete', () => {
  const { report, flags } = linkFlags('Jeg kan godt lide siderne hos en lokal bager');
  assert.deepEqual(flags.map((flag) => [flag.id, flag.severity]), [['rule.notUrl', 'info']]);
  assert.equal(report.questions['E.like'].status, 'complete');
});

test('rule.notUrl: an entry that looks like a web address but does not parse is a warning', () => {
  for (const text of ['http://', 'https:/example.com', 'httpx example', 'www.', 'See http:// for it']) {
    const { flags } = linkFlags(text);
    assert.deepEqual(flags.map((flag) => [flag.id, flag.severity]), [['rule.notUrl', text === 'www.' ? 'info' : 'warn']], text);
  }
});

test('rule.notUrl: addresses of any scheme, domains and sentences that hold an address are fine', () => {
  for (const text of ['https://example.com', 'www.example.dk/side', 'ftp://example.com/x', 'example.net', 'Se https://example.com her', '(www.example.org)']) {
    assert.deepEqual(linkFlags(text).flags, [], text);
  }
});

test('check does not print should-fix for a pasted sentence in a link list but does for a broken address', async (t) => {
  const { cwd, run } = setup(t, 'pack-da-complete');
  applyAnswers(cwd, { answers: [{ id: 'E.like', status: 'complete', items: [{ text: 'Noget roligt og enkelt' }, { text: 'https://example.com/a' }, { text: 'https://example.com/b' }] }] }, { schema, schemaDir: makeSchemaDir(t), now: NOW, today: TODAY });
  const plain = await run(check, ['--lang', 'en']);
  assert.ok(!plain.out.includes('Should fix'), plain.out);
  assert.ok(plain.out.includes('For information:'));
  assert.ok(plain.out.includes('"Noget roligt og enkelt" is not a web address; it is kept as pasted text.'));
  applyAnswers(cwd, { answers: [{ id: 'E.like', status: 'complete', items: [{ text: 'http://' }, { text: 'https://example.com/a' }, { text: 'https://example.com/b' }] }] }, { schema, schemaDir: makeSchemaDir(t), now: NOW, today: TODAY });
  assert.ok((await run(check, ['--lang', 'en'])).out.includes('Should fix:\n  - '));
});

test('the broken fixture has an information flag for pasted text and a warning for a broken address', () => {
  const pack = parsePack(path.join(FIXTURES, 'pack-broken'), schema);
  const report = validatePackData(pack, schema, { today: TODAY });
  assert.deepEqual(
    flagsFor(report, 'E.like').map((flag) => [flag.severity, flag.params.item]),
    [['info', 'Noget roligt og enkelt'], ['warn', 'http://']],
  );
});

// ---- check --write --lang with only docs/assets --------------------------------------------------------

test('check --write --lang en on a folder that has only docs/assets writes nothing: the language is not taken from the console', async (t) => {
  const { cwd, run } = setup(t);
  writeText(cwd, 'docs/assets/logo.svg', '<svg/>');
  const result = await run(check, ['--write', '--lang', 'en']);
  assert.equal(result.code, 0, result.err);
  assert.ok(result.err.includes('No answer has set the language of this pack yet, so nothing was written.'));
  assert.equal(fs.existsSync(path.join(cwd, 'docs/intake-manifest.json')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'docs/07-risks-and-open-questions.md')), false);
});

test('check --write on a folder with only docs/assets does not use the language of the environment either', async (t) => {
  const { cwd, run } = setup(t);
  writeText(cwd, 'docs/assets/logo.svg', '<svg/>');
  const result = await run(check, ['--write'], { env: { LANG: 'da_DK.UTF-8' } });
  assert.equal(result.code, 0, result.err);
  assert.ok(result.err.includes('Ingen svar har endnu fastsat sprog for denne pakke'));
  assert.equal(fs.existsSync(path.join(cwd, 'docs/intake-manifest.json')), false);
});

test('refreshPack takes the language from its options when the pack has none', (t) => {
  const root = makeTempDir(t);
  writeText(root, 'docs/assets/logo.svg', '<svg/>');
  const result = refreshPack(root, { schema, schemaDir: makeSchemaDir(t), language: 'en', now: NOW, today: TODAY });
  assert.equal(result.report.language, 'en');
  assert.equal(result.manifest.language, 'en');
});

// ---- hasAnyAnswer ---------------------------------------------------------------------------------------

test('hasAnyAnswer is false for a pack without answers and true for any status except missing', () => {
  assert.equal(hasAnyAnswer(makePackData([])), false);
  assert.equal(hasAnyAnswer(makePackData([{ id: 'A.goal', status: 'missing' }])), false);
  for (const input of [
    { id: 'A.goal', status: 'partial', text: 'Delvist' },
    { id: 'A.goal', status: 'tbd', note: 'Senere' },
    { id: 'A.goal', status: 'complete', text: 'Et svar' },
  ]) {
    assert.equal(hasAnyAnswer(makePackData([input])), true, input.status);
  }
});

test('hasAnyAnswer ignores the depth and the level, unlike the counts of the report', () => {
  const data = makePackData([{ id: 'A.failure', status: 'complete', text: 'Et valgfrit svar' }], { depth: 'essentials' });
  const report = validatePackData(data, schema, { today: TODAY });
  assert.equal(report.completeness.counts.complete, 0, 'out of scope at the essentials depth');
  assert.equal(hasAnyAnswer(data), true);
});

test('hasAnyAnswer sees answers in a parsed pack and not in an empty folder or a skeleton', (t) => {
  assert.equal(hasAnyAnswer(parsePack(path.join(FIXTURES, 'pack-en-partial'), schema)), true);
  assert.equal(hasAnyAnswer(parsePack(path.join(FIXTURES, 'pack-broken'), schema)), true);
  assert.equal(hasAnyAnswer(parsePack(makeTempDir(t), schema)), false);
  const root = path.join(makeTempDir(t), 'pack');
  applyAnswers(root, { language: 'da', answers: [] }, { schema, schemaDir: makeSchemaDir(t), now: NOW, today: TODAY });
  assert.equal(hasAnyAnswer(parsePack(root, schema)), false, 'a skeleton has only missing answers');
  applyAnswers(root, { answers: [{ id: 'A.failure', status: 'tbd', note: 'Senere' }] }, { schema, schemaDir: makeSchemaDir(t), now: NOW, today: TODAY });
  assert.equal(hasAnyAnswer(parsePack(root, schema)), true);
});
