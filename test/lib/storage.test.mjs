// Tests for the fourth review: the assets table must never become unreadable, what text may be
// stored, file names that round trip, all-or-nothing writes, input files, linked folders,
// assets --init and the last small items.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  CONTROL_CHARACTER_RANGES,
  HIDDEN_CHARACTER_RANGES,
  InputError,
  PackError,
  applyAnswers,
  buildManifest,
  decodeMarkup,
  describeAssetName,
  encodeMarkup,
  hasHiddenCharacters,
  isStorableAssetName,
  nameProblems,
  parseAssets,
  parsePack,
  readInputFile,
  refreshPack,
  renderAssets,
  sanitizeForTerminal,
  showHiddenCharacters,
  validatePack,
  validatePackData,
  writeAssetsTable,
} from '../../skill/everything-mapped/scripts/lib/index.mjs';
import { toToken } from '../../skill/everything-mapped/scripts/lib/util.mjs';
import { main as answer } from '../../skill/everything-mapped/scripts/answer.mjs';
import { main as assets } from '../../skill/everything-mapped/scripts/assets.mjs';
import { main as check } from '../../skill/everything-mapped/scripts/check.mjs';
import { main as next } from '../../skill/everything-mapped/scripts/next.mjs';
import { describeFlag } from '../../skill/everything-mapped/scripts/lib/render.mjs';
import { cpuNow, makePackData, makeSchemaDir, makeTempDir, NOW, readJson, runScript, schema, testI18n, TODAY, WORK_LIMIT_MS, writeText } from './helpers.mjs';

const char = (...codes) => String.fromCodePoint(...codes);
const FRONT = (file) => `---\nschema: everything-mapped-for-clients/1\nfile: ${file}\nlanguage: da\nupdated: 2026-10-23\n---\n`;
const IS_WINDOWS = process.platform === 'win32';

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
      else if (entry.isFile()) {
        try {
          result[path.relative(dir, absolute)] = fs.readFileSync(absolute, 'utf8');
        } catch {
          result[path.relative(dir, absolute)] = 'unreadable';
        }
      }
      else result[path.relative(dir, absolute)] = 'link';
    }
  };
  walk(dir);
  return result;
}

function pack(t, language = 'da') {
  const context = setup(t);
  applyAnswers(context.cwd, { language, answers: [] }, context.options);
  return context;
}

function tryWrite(file, content = 'x') {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return true;
  } catch {
    return false;
  }
}

function trySymlink(target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath);
    return true;
  } catch {
    return false;
  }
}

function writeRows(cwd, rows, name = 'rows.json') {
  fs.writeFileSync(path.join(cwd, name), JSON.stringify({ rows }));
}

// ---- A. the assets table never becomes unreadable ------------------------------------------------------------

test('a description of 20,001 characters is refused with exit 2 and nothing is written', async (t) => {
  const { cwd, run } = pack(t, 'en');
  fs.writeFileSync(path.join(cwd, 'docs/assets/logo.svg'), '<svg/>');
  const before = snapshot(cwd);
  const viaFlag = await run(assets, ['--add', 'logo.svg', '--what', 'w'.repeat(20001)]);
  assert.equal(viaFlag.code, 2);
  assert.equal(viaFlag.err, 'The text for assets/logo.svg would make a line longer than 20000 characters. Shorten the description.\n');
  writeRows(cwd, [{ file: 'logo.svg', what: 'w'.repeat(20001) }]);
  const viaFile = await run(assets, ['--from', 'rows.json', '--lang', 'en']);
  assert.equal(viaFile.code, 2);
  const unchanged = snapshot(cwd);
  delete unchanged['rows.json'];
  assert.deepEqual(unchanged, before, 'not the table, the state or the manifest was touched');
  assert.equal((await run(check, [])).code, 0, 'the pack can still be read');
  assert.equal((await run(assets, ['--add', 'logo.svg', '--what', 'w'.repeat(19000)])).code, 0, 'a long but allowed description works');
});

test('5,001 files with one row each are refused through --from, and 5,000 rows are accepted', async (t) => {
  const { cwd, run } = pack(t, 'en');
  const names = Array.from({ length: 5001 }, (_, index) => `f${index}.txt`);
  for (const name of names) fs.writeFileSync(path.join(cwd, 'docs/assets', name), '');
  const before = snapshot(cwd);
  writeRows(cwd, names.map((file) => ({ file })));
  const refused = await run(assets, ['--from', 'rows.json', '--lang', 'en']);
  assert.equal(refused.code, 2);
  assert.equal(refused.err, 'The table would have more than 5000 rows. Remove some rows first, or list fewer files.\n');
  const unchanged = snapshot(cwd);
  delete unchanged['rows.json'];
  assert.deepEqual(unchanged, before);
  writeRows(cwd, names.slice(0, 5000).map((file) => ({ file })));
  const accepted = await run(assets, ['--from', 'rows.json']);
  assert.equal(accepted.code, 0, accepted.err);
  assert.equal((await run(check, ['--write'])).code, 0, 'and the pack is still readable');
});

test('writeAssetsTable refuses a table over the limits before writing: rows, a line, 2 MB', (t) => {
  const { cwd, options } = pack(t, 'en');
  const before = snapshot(cwd);
  const row = (index, what = '') => ({ file: `assets/f${index}.png`, what, owner: '', rights: '', restrictions: '' });
  const refused = (rows) => {
    try {
      writeAssetsTable(cwd, rows, options);
    } catch (error) {
      assert.ok(error instanceof InputError);
      return error.problems[0].key.replace('ui.assets.err.', '');
    }
    return assert.fail('the table should have been refused');
  };
  assert.equal(refused(Array.from({ length: 5001 }, (_, index) => row(index))), 'tooManyRows');
  assert.equal(refused([row(1, 'x'.repeat(20001))]), 'lineTooLong');
  assert.equal(refused(Array.from({ length: 4000 }, (_, index) => row(index, 'y'.repeat(600)))), 'tableTooLarge');
  assert.deepEqual(snapshot(cwd), before);
  assert.doesNotThrow(() => writeAssetsTable(cwd, Array.from({ length: 5000 }, (_, index) => row(index)), options));
});

test('50,000 asset names are matched against 5,000 rows without a pause', async (t) => {
  const { cwd, run } = pack(t, 'en');
  const rows = Array.from({ length: 5000 }, (_, index) => `| assets/f${index}.txt | | | | |\n`).join('');
  fs.writeFileSync(path.join(cwd, 'docs/assets.md'), `| File | What | Owner | Rights | Restrictions |\n|---|---|---|---|---|\n${rows}`);
  for (let index = 0; index < 20000; index += 1) fs.writeFileSync(path.join(cwd, 'docs/assets', `f${index}.txt`), '');
  const started = cpuNow();
  const result = await run(assets, ['--scan', '--json']);
  assert.equal(result.code, 0, result.err);
  assert.ok(cpuNow() - started < 2 * WORK_LIMIT_MS, `took ${cpuNow() - started} ms`);
  assert.equal(JSON.parse(result.out).unlisted.length, 15000);
  const data = makePackData([]);
  data.assets = { rows: Array.from({ length: 5000 }, (_, index) => ({ file: `assets/f${index}.txt`, what: '', owner: '', rights: 'x', restrictions: '' })), present: Array.from({ length: 50000 }, (_, index) => `f${index}.txt`) };
  const validated = cpuNow();
  validatePackData(data, schema, { today: TODAY });
  assert.ok(cpuNow() - validated < WORK_LIMIT_MS);
});

// ---- B. what may be stored ---------------------------------------------------------------------------------------

const REFUSED = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x061c, 0xe0001, 0xe0041, 0xe007f, 0x200b, 0x2060, 0x2061, 0x2064, 0xfeff, 0xfff9, 0xfffa, 0xfffb, 0x180e, 0x034f, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x180b, 0x180f, 0x2065, 0x206a, 0x206f, 0x3164, 0xffa0, 0xfff0, 0xfff8, 0x1bca0, 0x1bca3, 0x1d173, 0x1d17a, 0xe0100, 0xe0fff];
const KEPT = [0x200c, 0x200d, 0xad, 0x200e, 0x200f, 0xfe0f, 0x202f, 0xa0, 0x3000, 0x2003];

test('the refused set is exported as data and is exactly the list of the contract', () => {
  const codes = new Set();
  for (const [from, to] of HIDDEN_CHARACTER_RANGES) for (let code = from; code <= to; code += 1) codes.add(code);
  const expected = new Set();
  for (const [from, to] of [[0x034f, 0x034f], [0x061c, 0x061c], [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180f], [0x200b, 0x200b], [0x202a, 0x202e], [0x2060, 0x206f], [0x3164, 0x3164], [0xfeff, 0xfeff], [0xffa0, 0xffa0], [0xfff0, 0xfffb], [0x1bca0, 0x1bca3], [0x1d173, 0x1d17a], [0xe0000, 0xe0fff]]) {
    for (let code = from; code <= to; code += 1) expected.add(code);
  }
  assert.deepEqual([...codes].sort((a, b) => a - b), [...expected].sort((a, b) => a - b));
  assert.deepEqual(CONTROL_CHARACTER_RANGES, [[0, 8], [11, 12], [14, 31], [127, 159]]);
  for (const code of REFUSED) assert.equal(hasHiddenCharacters(`a${char(code)}b`), true, `U+${code.toString(16)}`);
  for (const code of KEPT) assert.equal(hasHiddenCharacters(`a${char(code)}b`), false, `U+${code.toString(16)}`);
  assert.equal(hasHiddenCharacters('tab\tline\r\nbreak'), false);
  assert.equal(hasHiddenCharacters(`x${char(0x1b)}`), true);
});

test('answer input with a hidden character is refused in every field with exit 2 and nothing is written', async (t) => {
  const { cwd, run } = setup(t);
  for (const code of REFUSED) {
    const bad = `a${char(code)}b`;
    const inputs = [
      { language: 'da', answers: [{ id: 'A.goal', status: 'complete', text: bad }] },
      { language: 'da', answers: [{ id: 'A.metrics', status: 'complete', items: [{ text: 'x', note: bad }] }] },
      { language: 'da', answers: [{ id: 'I.domain', status: 'tbd', owner: 'client', note: bad }] },
      { language: 'da', respondent: { name: bad }, answers: [] },
      { language: 'da', recipient: bad, answers: [] },
      { language: 'da', notes: bad, answers: [] },
    ];
    for (const input of inputs) {
      fs.writeFileSync(path.join(cwd, 'answers.json'), JSON.stringify(input));
      const result = await run(answer, ['--from', 'answers.json', '--lang', 'en']);
      assert.equal(result.code, 2, `U+${code.toString(16)} ${JSON.stringify(input).slice(0, 60)}`);
      assert.match(result.err, /cannot be seen or that change the reading direction/);
      assert.deepEqual(fs.readdirSync(cwd), ['answers.json']);
    }
  }
});

test('legitimate invisible characters and special spaces are stored exactly, in answers and in the generated files', async (t) => {
  const { cwd, options, run } = setup(t);
  const text = `Familie ${char(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467)} foto${char(0xfe0f)} og Ka${char(0xad)}talog ${char(0x200e)}abc${char(0x200f)} nu${char(0x202f)}her${char(0xa0)}og${char(0x3000)}her ${char(0x200c)}`;
  const result = applyAnswers(cwd, {
    language: 'da',
    respondent: { name: `Anna${char(0x202f)}Jensen`, role: `Mark${char(0xad)}eting` },
    answers: [
      { id: 'A.goal', status: 'complete', text },
      { id: 'A.metrics', status: 'complete', items: [{ text, note: text }] },
      { id: 'A.project-kind', status: 'complete', choice: ['redesign'], note: text },
      { id: 'I.domain', status: 'tbd', owner: 'client', due: '2026-11-05', note: text },
    ],
  }, options);
  const parsed = parsePack(cwd, schema);
  assert.equal(parsed.files.brief.answers['A.goal'].value.text, text);
  assert.deepEqual(parsed.files.brief.answers['A.metrics'].value.items, [{ text, note: text }]);
  assert.equal(parsed.files.brief.answers['A.project-kind'].value.note, text);
  assert.equal(parsed.files.technical.answers['I.domain'].body, text);
  assert.equal(parsed.manifest.respondents[0].name, `Anna${char(0x202f)}Jensen`);
  assert.equal(parsed.manifest.respondents[0].role, `Mark${char(0xad)}eting`);
  const open = fs.readFileSync(path.join(cwd, 'docs/07-risks-and-open-questions.md'), 'utf8');
  assert.ok(open.includes(text), 'the note in the open-questions table is the stored text');
  assert.equal(applyAnswers(cwd, { answers: [] }, options).written.length, 0, 'rewriting changes nothing');
  assert.ok(result.written.length > 0);
  const printed = await run(check, ['--lang', 'en']);
  assert.ok(printed.out.length > 0);
});

test('assets.mjs stores descriptions with legitimate invisible characters exactly, and refuses hidden ones', async (t) => {
  const { cwd, run } = pack(t, 'en');
  fs.writeFileSync(path.join(cwd, 'docs/assets/logo.svg'), '<svg/>');
  const what = `Familiefoto ${char(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467)} og Ka${char(0xad)}talog`;
  assert.equal((await run(assets, ['--add', 'logo.svg', '--what', what, '--owner', `Kun${char(0x202f)}den`])).code, 0);
  const row = parseAssets(fs.readFileSync(path.join(cwd, 'docs/assets.md'), 'utf8'))[0];
  assert.equal(row.what, what);
  assert.equal(row.owner, `Kun${char(0x202f)}den`);
  const before = snapshot(cwd);
  const refused = await run(assets, ['--add', 'logo.svg', '--rights', `own${char(0x202e)}ed`]);
  assert.equal(refused.code, 2);
  assert.equal(refused.err, 'assets/logo.svg: the text in rights contains control characters or characters that cannot be seen. Remove them.\n'.replace('assets/logo.svg', 'logo.svg'));
  assert.deepEqual(snapshot(cwd), before);
});

test('an existing pack with hidden characters is read, and flagged with the question or the file', async (t) => {
  const { cwd, run } = setup(t);
  writeText(cwd, 'docs/00-brief.md', `${FRONT('brief')}\n# Title${char(0x200b)}\n\n### A\n<!-- q:A.goal status:complete -->\nSkjult${char(0x202e)}tekst\n\n### B\n<!-- q:A.budget status:complete -->\nOrdinær${char(0x200d)}tekst\n`);
  writeText(cwd, 'docs/assets.md', `| File | What | Owner | Rights | Restrictions |\n|---|---|---|---|---|\n| assets/a.png | Skjult${char(0x2066)} | | x | |\n`);
  const result = await run(check, ['--json']);
  assert.equal(result.code, 0, result.err);
  const flags = JSON.parse(result.out).flags.filter((flag) => flag.id === 'text.hiddenCharacters');
  assert.deepEqual(flags.map((flag) => [flag.qid ?? null, flag.severity]), [['A.goal', 'warn'], [null, 'warn'], [null, 'warn']]);
  assert.equal(flags[1].file, 'brief');
  assert.equal(flags[2].params.label, 'assets/a.png');
  const human = await run(check, ['--lang', 'en']);
  assert.match(human.out, /the text contains characters that cannot be seen or that change the reading direction/);
  for (const lang of ['da', 'en']) {
    const message = describeFlag(flags[0], testI18n(lang));
    assert.ok(message.length > 20 && !message.includes('flag.'), `${lang}: ${message}`);
  }
});

// ---- C. file names that round trip ---------------------------------------------------------------------------------

const GOOD_NAMES = [
  `Screenshot 2026-10-23 at 10.15.30${char(0x202f)}AM.png`,
  'two  spaces  here.png',
  `soft${char(0xad)}hyphen.png`,
  `zwj${char(0x200d)}name${char(0x200c)}.png`,
  `lrm${char(0x200e)}rlm${char(0x200f)}.png`,
  `variation${char(0xfe0f)}.png`,
  `nbsp${char(0xa0)}name.png`,
  'pipe|name.png',
  'amp&lt;name.png',
  'a<b>c.png',
  'dash-->name.png',
  'æøå ÆØÅ.png',
  'with space.png',
  'sub/folder name.png',
];

test('every file name the policy allows is stored exactly and listed without warnings', async (t) => {
  const { cwd, run } = pack(t, 'en');
  const made = [];
  for (const name of GOOD_NAMES) if (tryWrite(path.join(cwd, 'docs/assets', name))) made.push(name);
  assert.ok(made.length >= 8, 'the file system accepts most of the names');
  writeRows(cwd, made.map((file) => ({ file, what: `About ${file}`, rights: 'Owned' })));
  const added = await run(assets, ['--from', 'rows.json', '--json']);
  assert.equal(added.code, 0, added.err);
  const data = JSON.parse(added.out);
  assert.deepEqual([data.unlisted, data.badName, data.missingFile], [[], [], []]);
  assert.deepEqual(data.rows.map((row) => row.file).sort(), made.map((name) => `assets/${name}`).sort());
  const stored = parseAssets(fs.readFileSync(path.join(cwd, 'docs/assets.md'), 'utf8'));
  assert.deepEqual(stored.map((row) => row.file).sort(), made.map((name) => `assets/${name}`).sort());
  const report = JSON.parse((await run(check, ['--json'])).out);
  assert.deepEqual(report.flags.filter((flag) => flag.id.startsWith('assets.') && flag.id !== 'assets.notPackable'), []);
  // The table holds these names exactly; the zip refuses the ones with a character that Windows cannot store.
  const refusedByZip = made.filter((name) => nameProblems(`docs/assets/${name}`).length > 0).sort();
  assert.ok(refusedByZip.length >= 3);
  assert.deepEqual(report.flags.filter((flag) => flag.id === 'assets.notPackable').map((flag) => flag.params.file).sort(), refusedByZip.map((name) => describeAssetName(name)).sort());
  const again = await run(assets, ['--from', 'rows.json', '--json']);
  assert.deepEqual(JSON.parse(again.out).updated.length, made.length, 'the same rows are found again');
});

test('the table round trips every allowed name in memory too', () => {
  const rows = GOOD_NAMES.map((name) => ({ file: `assets/${name}`, what: name, owner: '', rights: 'x', restrictions: '' }));
  assert.deepEqual(parseAssets(renderAssets(rows, testI18n('en'))), rows);
  const data = makePackData([]);
  data.assets = { rows, present: GOOD_NAMES };
  assert.deepEqual(validatePackData(data, schema, { today: TODAY }).flags.filter((flag) => flag.id.startsWith('assets.') && flag.id !== 'assets.notPackable'), []);
});

test('names with a hidden character, a control character, a backslash or a space at an end are not put in the table', async (t) => {
  const { cwd, run } = pack(t, 'en');
  const bad = [`evil${char(0x202e)}.png`, `zero${char(0x200b)}width.png`, `tag${char(0xe0041)}.png`, `bom${char(0xfeff)}.png`, 'tab\there.png', ' leading.png', 'trailing.png ', 'back\\slash.png', 'new\nline.png'];
  const made = bad.filter((name) => tryWrite(path.join(cwd, 'docs/assets', name)));
  assert.ok(made.length >= 4);
  for (const name of made) assert.equal(isStorableAssetName(name), false, JSON.stringify(name));
  const scan = JSON.parse((await run(assets, ['--scan', '--json'])).out);
  assert.deepEqual(scan.unlisted, []);
  assert.equal(scan.badName.length, made.length);
  assert.ok(scan.badName.includes('evil<U+202E>.png') && scan.badName.includes('<U+0020>leading.png'));
  const human = await run(assets, ['--scan', '--lang', 'en']);
  assert.ok(human.out.includes('Files whose names cannot be listed (rename them):\n  - '));
  for (const name of made) {
    const result = await run(assets, ['--add', name]);
    if (name.includes('\\') || name.startsWith(' ') || name.endsWith(' ')) continue; // the command line drops spaces at the ends of a name
    assert.equal(result.code, 2, JSON.stringify(name));
    assert.match(result.err, /cannot be put in the list because of its name\. Rename the file/);
    assert.equal(hasHiddenCharacters(result.err), false, 'the name is printed with markers');
  }
  const report = JSON.parse((await run(check, ['--json'])).out);
  assert.equal(report.flags.filter((flag) => flag.id === 'assets.badName').length, made.length);
  assert.equal(report.flags.some((flag) => flag.id === 'assets.unlisted'), false);
  assert.deepEqual(fs.readFileSync(path.join(cwd, 'docs/assets.md'), 'utf8').includes('evil'), false, 'nothing of the name reached the table');
  for (const lang of ['da', 'en']) assert.ok(describeFlag(report.flags.find((flag) => flag.id === 'assets.badName'), testI18n(lang)).length > 20);
});

test('describeAssetName and showHiddenCharacters write what cannot be seen as <U+XXXX>', () => {
  assert.equal(describeAssetName(` a${char(0x202e)}b${char(0xe0041)}\t `), '<U+0020>a<U+202E>b<U+E0041><U+0009><U+0020>');
  assert.equal(showHiddenCharacters(`ok ${char(0x200d)}${char(0xad)} fine`), `ok ${char(0x200d)}${char(0xad)} fine`, 'legitimate characters are left alone');
  assert.equal(showHiddenCharacters(`a${char(0x1b, 0x85, 0x200b)}`), 'a<U+001B><U+0085><U+200B>');
});

// ---- D. all or nothing ---------------------------------------------------------------------------------------------

test('an unreadable asset stops answer and check --write before anything is written', async (t) => {
  const { cwd, run } = pack(t, 'en');
  const asset = path.join(cwd, 'docs/assets/secret.bin');
  fs.writeFileSync(asset, 'content');
  const original = fs.openSync;
  t.mock.method(fs, 'openSync', (file, ...rest) => {
    if (String(file) === asset) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    return original(file, ...rest);
  });
  const before = snapshot(cwd);
  fs.writeFileSync(path.join(cwd, 'answers.json'), JSON.stringify({ answers: [{ id: 'B.name', status: 'complete', text: 'Nordlys' }] }));
  const answered = await run(answer, ['--from', 'answers.json']);
  assert.equal(answered.code, 3);
  assert.equal(answered.err, 'The file docs/assets/secret.bin cannot be read, so nothing was saved. Check who may open the file, or remove it.\n');
  const refreshed = await run(check, ['--write']);
  assert.equal(refreshed.code, 3);
  assert.equal(refreshed.err, answered.err);
  fs.rmSync(path.join(cwd, 'answers.json'));
  assert.deepEqual(snapshot(cwd), before, 'no answer file, no state, no manifest was touched');
  assert.equal((await run(assets, ['--add', 'secret.bin', '--what', 'x'])).code, 3);
  assert.deepEqual(snapshot(cwd), before);
});

test('a file with no read permission stops answer the same way (not as root, not on Windows)', async (t) => {
  if (IS_WINDOWS || process.getuid?.() === 0) return t.skip('permissions cannot be tested here');
  const { cwd, run } = pack(t, 'en');
  const asset = path.join(cwd, 'docs/assets/locked.bin');
  fs.writeFileSync(asset, 'x');
  fs.chmodSync(asset, 0o000);
  t.after(() => {
    if (fs.existsSync(asset)) fs.chmodSync(asset, 0o644);
  });
  const before = snapshot(cwd);
  fs.writeFileSync(path.join(cwd, 'answers.json'), JSON.stringify({ answers: [{ id: 'B.name', status: 'complete', text: 'Nordlys' }] }));
  const result = await run(answer, ['--from', 'answers.json']);
  assert.equal(result.code, 3);
  assert.match(result.err, /docs\/assets\/locked\.bin cannot be read, so nothing was saved/);
  fs.rmSync(path.join(cwd, 'answers.json'));
  assert.deepEqual(snapshot(cwd), before);
});

test('the manifest that answer writes is the one a fresh refresh would write', async (t) => {
  const { cwd, options, run } = pack(t, 'en');
  fs.writeFileSync(path.join(cwd, 'docs/assets/data.bin'), Buffer.alloc(1000, 3));
  writeRows(cwd, [{ file: 'data.bin', what: 'Data', rights: 'x' }]);
  await run(assets, ['--from', 'rows.json']);
  fs.writeFileSync(path.join(cwd, 'answers.json'), JSON.stringify({ respondent: { name: 'Anna', role: 'IT' }, answers: [{ id: 'B.name', status: 'complete', text: 'Nordlys' }, { id: 'I.domain', status: 'tbd', note: 'x' }] }));
  const result = await run(answer, ['--from', 'answers.json']);
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(refreshPack(cwd, options).written, [], 'nothing is left for a refresh to change');
  const manifest = readJson(path.join(cwd, 'docs/intake-manifest.json'));
  assert.ok(manifest.files.some((entry) => entry.path === 'docs/assets/data.bin'));
  assert.ok(manifest.files.some((entry) => entry.path === 'docs/07-risks-and-open-questions.md'));
});

// ---- E. input files -------------------------------------------------------------------------------------------------

test('--from refuses a folder or a device, reads at most the limit and accepts a file of exactly 2 MB', async (t) => {
  const { cwd, run } = setup(t);
  fs.mkdirSync(path.join(cwd, 'folder'));
  for (const main of [answer, assets]) {
    const result = await run(main, ['--from', 'folder', '--lang', 'en']);
    assert.equal(result.code, 2);
    assert.match(result.err, /folder is not a file\./);
  }
  if (fs.existsSync('/dev/zero')) {
    const started = cpuNow();
    for (const main of [answer, assets]) {
      const result = await run(main, ['--from', '/dev/zero']);
      assert.equal(result.code, 2);
    }
    assert.ok(cpuNow() - started < WORK_LIMIT_MS);
    assert.deepEqual(readInputFile('/dev/zero'), { problem: 'notFile' });
  }
  const base = '{"language":"da","answers":[]}';
  const exact = base + ' '.repeat(2 * 1024 * 1024 - base.length);
  assert.equal(exact.length, 2 * 1024 * 1024);
  fs.writeFileSync(path.join(cwd, 'exact.json'), exact);
  assert.equal((await run(answer, ['--from', 'exact.json'])).code, 0);
  fs.writeFileSync(path.join(cwd, 'over.json'), `${exact} `);
  assert.equal((await run(answer, ['--from', 'over.json'])).code, 2);
  assert.deepEqual(readInputFile(path.join(cwd, 'missing.json')), { problem: 'unreadable' });
  assert.equal(readInputFile(path.join(cwd, 'exact.json')).text.length, 2 * 1024 * 1024);
});

// ---- F. linked folders ----------------------------------------------------------------------------------------------

test('a linked docs/assets (or docs, or docs/01-brand) is refused everywhere with exit 3 and nothing is written', async (t) => {
  for (const folder of ['docs/assets', 'docs/01-brand']) {
    const { cwd, options, run } = pack(t, 'en');
    const target = path.join(cwd, `elsewhere-${path.basename(folder)}`);
    fs.mkdirSync(target);
    fs.rmSync(path.join(cwd, folder), { recursive: true });
    if (!trySymlink(target, path.join(cwd, folder))) return t.skip('symbolic links are not available here');
    const before = snapshot(cwd);
    fs.writeFileSync(path.join(cwd, 'answers.json'), JSON.stringify({ answers: [{ id: 'B.name', status: 'complete', text: 'Nordlys' }] }));
    const expected = `The folder ${folder} is a symbolic link. The pack needs a real folder there.\n`;
    for (const [main, argv] of [[check, []], [check, ['--write']], [next, []], [answer, ['--from', 'answers.json']], [assets, ['--scan']], [assets, ['--init']]]) {
      const result = await run(main, argv);
      assert.equal(result.code, 3, `${folder} ${argv.join(' ')}`);
      assert.equal(result.err, expected);
    }
    fs.rmSync(path.join(cwd, 'answers.json'));
    assert.deepEqual(snapshot(cwd), before);
    if (folder === 'docs/assets') assert.throws(() => buildManifest({ root: cwd, files: {}, assets: { present: [] }, paths: { assetsDir: 'docs/assets' } }, { language: 'en', depth: 'standard', completeness: { overall: 0, counts: {}, byFile: {}, byModule: {} }, gate1: { ready: false, blocking: [] } }), (error) => error instanceof PackError && error.key === 'ui.check.err.linkedFolder');
    assert.throws(() => parsePack(cwd, schema), (error) => error.key === 'ui.check.err.linkedFolder');
    assert.ok(options);
  }
});

test('a link to a folder outside the root is still reported as outside the root', (t) => {
  const { cwd } = pack(t, 'en');
  const outside = makeTempDir(t);
  fs.rmSync(path.join(cwd, 'docs/assets'), { recursive: true });
  if (!trySymlink(outside, path.join(cwd, 'docs/assets'))) return t.skip('symbolic links are not available here');
  assert.throws(() => parsePack(cwd, schema), (error) => error.key === 'ui.check.err.outsideRoot');
});

// ---- G. assets --init -------------------------------------------------------------------------------------------------

test('assets --init makes docs/assets, says so, and can be run again', async (t) => {
  const { cwd, run } = setup(t);
  const first = await run(assets, ['--init', '--lang', 'en']);
  assert.equal(first.code, 0, first.err);
  assert.ok(first.out.startsWith('The folder docs/assets was created.\n'));
  assert.ok(fs.statSync(path.join(cwd, 'docs/assets')).isDirectory());
  const second = await run(assets, ['--init', '--lang', 'da']);
  assert.equal(second.code, 0);
  assert.ok(second.out.startsWith('Mappen docs/assets findes allerede.\n'));
  const json = JSON.parse((await run(assets, ['--init', '--json'])).out);
  assert.equal(json.created, false);
  assert.deepEqual(fs.readdirSync(path.join(cwd, 'docs')), ['assets'], 'nothing else was made');
});

test('assets --init works with a relative --root that does not exist yet and refuses a linked docs', async (t) => {
  const { cwd, run } = setup(t);
  assert.equal((await run(assets, ['--init', '--root', 'new/pack'])).code, 0);
  assert.ok(fs.statSync(path.join(cwd, 'new/pack/docs/assets')).isDirectory());
  const target = path.join(cwd, 'linked/real-docs');
  fs.mkdirSync(target, { recursive: true });
  if (!trySymlink(target, path.join(cwd, 'linked/docs'))) return t.skip('symbolic links are not available here');
  const refused = await run(assets, ['--init', '--root', 'linked', '--lang', 'en']);
  assert.equal(refused.code, 3);
  assert.equal(refused.err, 'The folder docs is a symbolic link. The pack needs a real folder there.\n');
  assert.deepEqual(fs.readdirSync(target), []);
});

test('assets --init makes the folder, --from only lists files that are in it, and nothing is a link', async (t) => {
  const { cwd, run } = setup(t);
  assert.equal(JSON.parse((await run(assets, ['--init', '--json'])).out).created, true);
  assert.ok(fs.statSync(path.join(cwd, 'docs/assets')).isDirectory());
  writeRows(cwd, []);
  const result = await run(assets, ['--from', 'rows.json', '--delete', '--json']);
  assert.equal(result.code, 0, result.err);
  assert.equal(JSON.parse(result.out).created, null, '--from does not make the folder');
  assert.equal(fs.existsSync(path.join(cwd, 'rows.json')), false);
  writeRows(cwd, [{ file: 'missing.png' }]);
  const refused = await run(assets, ['--from', 'rows.json']);
  assert.equal(refused.code, 2, 'a row for a file that is not there is still refused');
});

// ---- H. small items and markup -------------------------------------------------------------------------------------------

test('toToken gives the same token when applied again', () => {
  assert.equal(toToken('a -'), 'a-');
  assert.equal(toToken('Anna Jensen'), 'Anna-Jensen');
  let state = 11;
  const random = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
  const pieces = ['a', 'B', ' ', '-', '--', '<', '>', '"', '  ', 'æ'];
  for (let round = 0; round < 2000; round += 1) {
    const text = Array.from({ length: 1 + Math.floor(random() * 8) }, () => pieces[Math.floor(random() * pieces.length)]).join('');
    assert.equal(toToken(toToken(text)), toToken(text), JSON.stringify(text));
  }
});

test('a comma in a respondent name survives into the manifest, and names without a comma are unchanged', (t) => {
  const { cwd, options } = setup(t);
  const result = applyAnswers(cwd, { language: 'da', respondent: { name: 'Jensen, Anna', role: 'Marketing, Odense' }, answers: [{ id: 'B.name', status: 'complete', text: 'Nordlys' }] }, options);
  assert.equal(result.pack.files.brand.frontMatter.respondent, 'Jensen&#44; Anna, Marketing, Odense');
  assert.deepEqual(result.pack.manifest.respondents.map((person) => [person.name, person.role]), [['Jensen, Anna', 'Marketing, Odense']]);
  const next2 = applyAnswers(cwd, { respondent: { name: 'Peter Holm', role: 'IT' }, answers: [{ id: 'B.fonts', status: 'complete', text: 'Fira' }] }, options);
  assert.equal(next2.pack.files.brand.frontMatter.respondent, 'Jensen&#44; Anna, Marketing, Odense; Peter Holm, IT');
  assert.deepEqual(next2.pack.manifest.respondents.map((person) => person.name), ['Jensen, Anna', 'Peter Holm']);
  assert.equal(applyAnswers(cwd, { respondent: { name: 'Jensen, Anna', role: 'Marketing, Odense' }, answers: [{ id: 'B.colors', status: 'complete', text: 'Blå' }] }, options).pack.files.brand.frontMatter.respondent, next2.pack.files.brand.frontMatter.respondent);
});

test('markup: --!> is defused as well, and decoding is the exact inverse for every text', () => {
  assert.equal(encodeMarkup('a --!> b'), 'a --!&gt; b');
  assert.equal(encodeMarkup('a --> b ---> c'), 'a --&gt; b ---&gt; c');
  assert.equal(decodeMarkup('--!>'), '--!>', 'text stored before this change decodes as it did');
  assert.equal(decodeMarkup('--&gt;'), '-->');
  const samples = ['--!>', '--!&gt;', '--&gt;', '-->', '--!&amp;gt;', '&amp;--!>', '<!--x--!>y-->', '&lt;!--', '---!>', '--!!>', '&amp;amp;', '--!&amp;--!>'];
  for (const text of samples) {
    const encoded = encodeMarkup(text);
    assert.equal(decodeMarkup(encoded), text, JSON.stringify(text));
    assert.ok(!/--!?>/.test(encoded) && !/<[A-Za-z/!?]/.test(encoded), JSON.stringify(encoded));
  }
  let state = 3;
  const random = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
  const pieces = ['-', '--', '!', '>', '<', '&', 'amp;', 'lt;', 'gt;', 'a', ' ', '--!>', '-->', '&lt;', '&gt;', '&amp;'];
  for (let round = 0; round < 4000; round += 1) {
    const text = Array.from({ length: 1 + Math.floor(random() * 10) }, () => pieces[Math.floor(random() * pieces.length)]).join('');
    const encoded = encodeMarkup(text);
    assert.equal(decodeMarkup(encoded), text, JSON.stringify(text));
    assert.ok(!/--!?>/.test(encoded), JSON.stringify(encoded));
  }
});

test('the terminal sanitizer replaces hidden and confusable characters when printing, and never touches the stored text', async (t) => {
  const { cwd, options } = setup(t);
  const text = `a${char(0x200d)}b${char(0xad)}c${char(0x202e)}d`;
  assert.equal(sanitizeForTerminal(text), `a${char(0xfffd)}b${char(0xfffd)}c${char(0xfffd)}d`);
  applyAnswers(cwd, { language: 'da', answers: [{ id: 'A.goal', status: 'complete', text: `a${char(0x200d)}b${char(0xad)}c` }] }, options);
  assert.equal(parsePack(cwd, schema).files.brief.answers['A.goal'].value.text, `a${char(0x200d)}b${char(0xad)}c`);
  const report = validatePack(parsePack(cwd, schema), schema, { today: TODAY });
  assert.ok(report.questions['A.goal']);
});
