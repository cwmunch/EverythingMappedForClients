// Tests for the third review: line separators that defeated the line patterns, a hostile assets
// table, JSON output, the respondent line, invisible characters, hasAnyAnswer and isPackFile.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  applyAnswers,
  buildManifest,
  hasAnyAnswer,
  isPackFile,
  parseAssets,
  parseBody,
  parseFile,
  parsePack,
  refreshPack,
  sanitizeForTerminal,
  stringifyJson,
  validatePack,
  validatePackData,
} from '../../skill/everything-mapped/scripts/lib/index.mjs';
import { findQuestion } from '../../skill/everything-mapped/scripts/lib/rules.mjs';
import { normalizeNewlines, splitLines } from '../../skill/everything-mapped/scripts/lib/util.mjs';
import { main as answer } from '../../skill/everything-mapped/scripts/answer.mjs';
import { main as assets } from '../../skill/everything-mapped/scripts/assets.mjs';
import { main as check } from '../../skill/everything-mapped/scripts/check.mjs';
import { NOW, TODAY, makePackData, makeSchemaDir, makeTempDir, readJson, runScript, schema, writeText } from './helpers.mjs';

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const C1 = String.fromCharCode(0x85);
const RLO = String.fromCharCode(0x202e);
const FRONT = (file) => `---\nschema: everything-mapped-for-clients/1\nfile: ${file}\nlanguage: da\nupdated: 2026-10-23\n---\n`;

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

function snapshot(dir) {
  const result = {};
  const walk = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const absolute = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else result[path.relative(dir, absolute)] = fs.readFileSync(absolute, 'utf8');
    }
  };
  walk(dir);
  return result;
}

async function timed(work) {
  const started = performance.now();
  const result = await work();
  return { result, ms: performance.now() - started };
}

// ---- 1. U+2028 and U+2029 ---------------------------------------------------------------------

test('U+2028 and U+2029 are line breaks, like LF, CR and CRLF', () => {
  assert.equal(normalizeNewlines(`a${LS}b${PS}c\r\nd\re`), 'a\nb\nc\nd\ne');
  assert.deepEqual(splitLines(`a${LS}b`), ['a', 'b']);
});

test('a run of spaces followed by U+2028 cannot make the line patterns slow', () => {
  const hostile = `${' '.repeat(19000)}${LS}x`;
  const kinds = ['A.project-kind', 'A.deadline', 'A.metrics', 'A.goal'].map((id) => findQuestion(schema, id));
  const started = performance.now();
  for (let round = 0; round < 10; round += 1) {
    for (const question of kinds) {
      parseBody(question, `Choice:${hostile}`);
      parseBody(question, `Date:${hostile}\nNote:${hostile}`);
      parseBody(question, `-${hostile}`);
    }
    parseFile(`---\nschema: x\nfile: brief\nlanguage: da\nkey:${hostile}\n---\n`, schema);
  }
  assert.ok(performance.now() - started < 1000, 'ten rounds of every pattern take under a second');
});

test('a 2 MB brief with 104 front matter lines that end in spaces and U+2028 is read in under a second', async (t) => {
  const { cwd, run } = setup(t);
  const lines = Array.from({ length: 104 }, (_, index) => `k${index}:${' '.repeat(19000)}${LS}x`);
  const text = `---\nschema: everything-mapped-for-clients/1\nfile: brief\nlanguage: da\n${lines.join('\n')}\n---\n`;
  assert.ok(Buffer.byteLength(text) < 2 * 1024 * 1024, 'the file is within the size limit');
  writeText(cwd, 'docs/00-brief.md', text);
  const { result, ms } = await timed(() => run(check, ['--json']));
  assert.equal(result.code, 0, result.err);
  assert.ok(ms < 1000, `took ${ms} ms`);
});

test('a U+2028 inside an answer splits the line, and nothing is lost', () => {
  const parsed = parseFile(`${FRONT('brief')}\n### A\n<!-- q:A.goal status:complete -->\nfirst${LS}second${PS}third\n`, schema);
  assert.equal(parsed.answers['A.goal'].body, 'first\nsecond\nthird');
});

// ---- 2. a hostile assets table ------------------------------------------------------------------------

function tableOf(rows) {
  return `| File | What | Owner | Rights | Restrictions |\n|---|---|---|---|---|\n${rows}`;
}

test('an assets table with more than 5000 rows is refused with a clear message, not a stack overflow', async (t) => {
  const { cwd, run } = setup(t);
  writeText(cwd, 'docs/assets.md', tableOf(Array.from({ length: 113000 }, () => '|a||||\n').join('')));
  writeText(cwd, 'docs/00-brief.md', FRONT('brief'));
  assert.ok(fs.statSync(path.join(cwd, 'docs/assets.md')).size < 2 * 1024 * 1024);
  const { result, ms } = await timed(() => run(check, ['--lang', 'en']));
  assert.equal(result.code, 3);
  assert.equal(result.err, 'docs/assets.md: the table has more than 5000 rows, so the file is not read.\n');
  assert.ok(ms < 1000);
  assert.throws(() => parseAssets(tableOf('|a||||\n'.repeat(5001))), (error) => error.key === 'ui.check.err.tooManyRows');
  assert.equal(parseAssets(tableOf('|a||||\n'.repeat(5000))).length, 5000);
});

test('validation does not overflow the stack for a huge in-memory table, and its flags are capped', () => {
  const rows = Array.from({ length: 150000 }, (_, index) => ({ file: `assets/f${index}.png`, what: '', owner: '', rights: index % 2 ? '' : 'unknown', restrictions: '' }));
  const present = Array.from({ length: 150000 }, (_, index) => `g${index}.png`);
  const data = makePackData([]);
  data.assets = { rows, present };
  const report = validatePackData(data, schema, { today: TODAY });
  const count = (id) => report.flags.filter((flag) => flag.id === id).length;
  assert.equal(count('assets.unlisted'), 100);
  assert.equal(count('assets.missingFile'), 100);
  assert.equal(count('assets.noRights'), 100);
  assert.equal(count('assets.rightsUnknown'), 100);
});

test('a table of 5000 rows gives a bounded report, a small open-questions file and a pack that stays usable', async (t) => {
  const { cwd, run, options } = setup(t);
  applyAnswers(cwd, { language: 'en', answers: [] }, options);
  writeText(cwd, 'docs/assets.md', tableOf(Array.from({ length: 5000 }, (_, index) => `| assets/${'x'.repeat(250)}${index}.png | | | ${index % 2 ? 'unknown' : ''} | |\n`).join('')));
  assert.equal((await run(check, ['--write'])).code, 0);
  const openPath = path.join(cwd, 'docs/07-risks-and-open-questions.md');
  const text = fs.readFileSync(openPath, 'utf8');
  assert.ok(text.length < 200 * 1024, `the file has ${text.length} characters`);
  assert.equal(text.split('\n').filter((line) => line.startsWith('- ')).length, 201, '200 findings and one line for the rest');
  assert.match(text, /- and \d+ more that are not shown/);
  const human = await run(check, []);
  assert.match(human.out, /and \d+ more that are not shown/);
  assert.equal((await run(check, ['--write'])).code, 0, 'the generated file can be read again');
  fs.writeFileSync(path.join(cwd, 'answers.json'), JSON.stringify({ answers: [{ id: 'B.name', status: 'complete', text: 'Nordlys' }] }));
  assert.equal((await run(answer, ['--from', 'answers.json'])).code, 0);
  const scan = await run(assets, ['--scan']);
  assert.equal(scan.code, 0);
  assert.match(scan.out, /and \d+ more that are not shown/);
});

test('long notes cannot make the open-questions file larger than a few hundred characters per row', (t) => {
  const { cwd, options } = setup(t);
  const note = Array.from({ length: 150 }, () => 'n'.repeat(1000)).join('\n');
  const ids = ['A.business', 'A.why-now', 'A.goal', 'A.deadline-reason', 'A.failure', 'J.concerns', 'J.anything-else', 'A.budget', 'J.contact'];
  applyAnswers(cwd, { language: 'en', answers: ids.map((id) => ({ id, status: 'tbd', owner: 'client', note })) }, options);
  const text = fs.readFileSync(path.join(cwd, 'docs/07-risks-and-open-questions.md'), 'utf8');
  assert.ok(text.length < 100 * 1024, `${text.length} characters`);
  assert.ok(text.includes(`${'n'.repeat(300)}...`));
  assert.equal(parsePack(cwd, schema).files.brief.answers['A.business'].body.length, 150149, 'the answer itself is kept whole');
});

test('answer and check --write write nothing when the open-questions file would become too large', async (t) => {
  const { cwd, run, options } = setup(t);
  applyAnswers(cwd, { language: 'en', answers: [] }, options);
  const openPath = path.join(cwd, 'docs/07-risks-and-open-questions.md');
  fs.writeFileSync(openPath, `${'z'.repeat(2095000)}\n<!-- generated:start -->\nx\n<!-- generated:end -->\n`);
  const before = snapshot(cwd);
  fs.writeFileSync(path.join(cwd, 'answers.json'), JSON.stringify({ answers: [{ id: 'B.name', status: 'complete', text: 'Nordlys' }] }));
  const answered = await run(answer, ['--from', 'answers.json', '--lang', 'en']);
  assert.equal(answered.code, 3);
  assert.match(answered.err, /docs\/07-risks-and-open-questions\.md would become larger than 2 MB/);
  fs.rmSync(path.join(cwd, 'answers.json'));
  assert.deepEqual(snapshot(cwd), before, 'not even the answer files were written');
  const written = await run(check, ['--write', '--lang', 'en']);
  assert.equal(written.code, 3);
  assert.deepEqual(snapshot(cwd), before);
});

// ---- 3. JSON output ------------------------------------------------------------------------------------------

test('stringifyJson escapes DEL, C1 and display spoofing characters and parses to the same value', () => {
  const value = {
    text: `a${C1}b${RLO}c${LS}d${PS}e${String.fromCharCode(0x7f, 0x200b, 0xad, 0xfeff)}f${String.fromCodePoint(0xe0041)}g æøå ✓`,
    list: [{ nested: `${C1}` }],
    number: 3,
  };
  const output = stringifyJson(value);
  assert.deepEqual(JSON.parse(output), value);
  assert.ok(output.includes('\\u0085') && output.includes('\\u202e') && output.includes('\\u2028') && output.includes('\\u007f'));
  assert.ok(output.includes('\\udb40\\udc41'), 'an astral character becomes a surrogate pair');
  assert.ok(output.includes('æøå ✓'), 'ordinary text is left alone');
  for (const char of output) {
    const code = char.codePointAt(0);
    assert.ok(!(code >= 127 && code <= 159) && code !== 0x2028 && code !== 0x2029 && !(code >= 0x202a && code <= 0x202e), `U+${code.toString(16)}`);
  }
  assert.equal(stringifyJson({ a: [1] }), JSON.stringify({ a: [1] }, null, 2));
});

test('check --json and assets --json print no raw control or spoofing character, and the values are intact', async (t) => {
  const { cwd, run } = setup(t);
  const marker = `Z.${C1}${RLO}x`;
  writeText(cwd, 'docs/00-brief.md', `${FRONT('brief')}\n### A\n<!-- q:${marker} status:complete -->\nx\n`);
  const assetName = `evil${C1}${RLO}.png`;
  try {
    writeText(cwd, `docs/assets/${assetName}`, 'x');
  } catch {
    return t.skip('this file system does not allow the file name');
  }
  const report = await run(check, ['--json']);
  assert.equal(report.code, 0, report.err);
  const parsed = JSON.parse(report.out);
  assert.ok(parsed.flags.some((flag) => flag.id === 'marker.unknownQuestion' && flag.params.id === marker), 'the value is intact');
  for (const char of report.out) {
    const code = char.codePointAt(0);
    assert.ok(!(code >= 127 && code <= 159) && code !== 0x2028 && code !== 0x202e, `check: U+${code.toString(16)}`);
  }
  const scan = await run(assets, ['--scan', '--json']);
  assert.deepEqual(JSON.parse(scan.out).badName, ['evil<U+0085><U+202E>.png'], 'the name is shown with markers');
  for (const char of scan.out) {
    const code = char.codePointAt(0);
    assert.ok(!(code >= 127 && code <= 159) && code !== 0x202e, `assets: U+${code.toString(16)}`);
  }
});

// ---- 4. the respondent line ---------------------------------------------------------------------------------

test('a role that looks like an entity cannot hide the next respondent', (t) => {
  const { cwd, options } = setup(t);
  const people = [
    { name: 'Anna', role: 'R&D &amp' },
    { name: 'Bob', role: 'IT' },
    { name: 'Carol', role: 'Sales' },
    { name: 'Dan <b>', role: 'a &lt; b; c' },
    { name: 'Eve', role: '&' },
  ];
  let first = true;
  for (const person of people) {
    const input = { respondent: person, answers: [{ id: first ? 'B.name' : 'B.fonts', status: 'complete', text: 'Tekst' }] };
    applyAnswers(cwd, first ? { language: 'da', ...input } : input, options);
    first = false;
    // the same file for everybody: answer one more question in the brand file each time
  }
  const pack = parsePack(cwd, schema);
  assert.deepEqual(
    pack.manifest.respondents.map((person) => [person.name, person.role]),
    [['Anna', 'R&D &amp'], ['Bob', 'IT'], ['Carol', 'Sales'], ['Dan <b>', 'a &lt, b, c'], ['Eve', '&']],
  );
  const line = pack.files.brand.frontMatter.respondent;
  assert.equal(line.split('; ').length >= 5, true, line);
  const again = applyAnswers(cwd, { respondent: people[0], answers: [{ id: 'B.colors', status: 'complete', text: 'Blå' }] }, options);
  assert.equal(again.pack.files.brand.frontMatter.respondent, line, 'a known respondent is not added twice');
  assert.equal(applyAnswers(cwd, { answers: [] }, options).written.length, 0);
});

// ---- 5. invisible characters ----------------------------------------------------------------------------------

test('the sanitizer replaces invisible and direction characters with a visible stand-in', () => {
  const invisible = [0xad, 0x61c, 0x180e, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060, 0x2061, 0x2064, 0xfeff, 0xfff9, 0xfffa, 0xfffb, 0xe0001, 0xe0041, 0xe007f, 0x202a, 0x202e, 0x2066, 0x2069];
  for (const code of invisible) {
    const safe = sanitizeForTerminal(`a${String.fromCodePoint(code)}b`);
    assert.equal(safe, `a${String.fromCodePoint(0xfffd)}b`, `U+${code.toString(16)}`);
  }
  assert.equal(sanitizeForTerminal('Zoë æøå Ωmega ✓ 日本 ’ - '), 'Zoë æøå Ωmega ✓ 日本 ’ - ');
  assert.equal(sanitizeForTerminal(`a${String.fromCharCode(0x2062)}b`).includes(String.fromCharCode(0x2062)), false);
});

// ---- 6. hasAnyAnswer and isPackFile --------------------------------------------------------------------------

test('hasAnyAnswer uses what the check reports: an empty complete marker is not an answer', async (t) => {
  const { cwd, run } = setup(t);
  writeText(cwd, 'docs/00-brief.md', `${FRONT('brief')}\n### A\n<!-- q:A.goal status:complete -->\n`);
  const pack = parsePack(cwd, schema);
  assert.equal(hasAnyAnswer(pack), false);
  const report = JSON.parse((await run(check, ['--json'])).out);
  assert.equal(report.completeness.counts.complete, 0);
  assert.equal(report.questions['A.goal'].status, 'missing');
});

test('hasAnyAnswer: content counts, a note alone does not, a deferred question does', () => {
  const answered = (entry) => {
    const data = makePackData([]);
    data.files.brief.answers['A.goal'] = { owner: '', due: '', body: '', ...entry };
    return hasAnyAnswer(data);
  };
  assert.equal(answered({ status: 'complete', value: { text: '   ' } }), false);
  assert.equal(answered({ status: 'partial', value: { text: '' } }), false);
  assert.equal(answered({ status: 'complete', value: { choice: [], note: 'only a note' } }), false);
  assert.equal(answered({ status: 'complete', value: { items: [] } }), false);
  assert.equal(answered({ status: 'complete', value: { date: '' , note: 'x' } }), false);
  assert.equal(answered({ status: 'complete', value: { text: 'Et svar' } }), true);
  assert.equal(answered({ status: 'partial', value: { items: [{ text: 'a', note: '' }] } }), true);
  assert.equal(answered({ status: 'complete', value: { choice: ['redesign'], note: '' } }), true);
  assert.equal(answered({ status: 'complete', value: { date: '2026-12-01', note: '' } }), true);
  assert.equal(answered({ status: 'tbd', body: '' }), true);
  assert.equal(answered({ status: 'missing' }), false);
  assert.equal(answered({ status: 'complete', body: 'text without a value' }), true);
  assert.equal(answered({ status: 'complete', body: '  ' }), false);
});

test('isPackFile: hidden and temporary names anywhere in the path are not part of a pack', () => {
  for (const name of ['docs/00-brief.md', 'docs/assets/logo.svg', 'docs/assets/photos/a.jpg', 'docs/intake-state.json', 'docs/assets/tmp', 'docs/assets/a.tmpl']) {
    assert.equal(isPackFile(name), true, name);
  }
  for (const name of ['docs/assets/a.tmp', 'docs/assets/A.TMP', 'docs/.hidden', 'docs/assets/.gitkeep', 'docs/.cache/x.png', 'docs/x.tmp/y.png', 'docs\\assets\\a.tmp', '', '..', 'docs/../x']) {
    assert.equal(isPackFile(name), false, name);
  }
});

test('the manifest and the asset listing leave out dotfiles and *.tmp files, the way the zip does', (t) => {
  const { cwd, options } = setup(t);
  applyAnswers(cwd, { language: 'da', answers: [] }, options);
  for (const name of ['a.tmp', '.hidden', 'b.TMP', 'keep.png']) writeText(cwd, `docs/assets/${name}`, 'x');
  writeText(cwd, 'docs/assets/.cache/inner.png', 'x');
  writeText(cwd, 'docs/assets/folder.tmp/inner.png', 'x');
  const pack = parsePack(cwd, schema);
  assert.deepEqual(pack.assets.present, ['keep.png']);
  const manifest = buildManifest(pack, validatePack(pack, schema, { today: TODAY }), { now: NOW });
  const paths = manifest.files.map((entry) => entry.path);
  assert.ok(paths.includes('docs/assets/keep.png'));
  assert.ok(!paths.some((entry) => /\.tmp$/i.test(entry) || entry.split('/').some((part) => part.startsWith('.'))), paths.join(', '));
  assert.deepEqual(refreshPack(cwd, options).manifest.files.map((entry) => entry.path), paths);
});
