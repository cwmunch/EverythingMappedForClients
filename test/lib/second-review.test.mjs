// Tests for the second review of the pushed kit: switching off answered questions, file names
// that are not UTF-8, names the zip refuses, names that break the table, all-or-nothing writes,
// field lengths, NFC and NFD names, the wider set of hidden characters, safe opening of files and
// setext headings.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  HIDDEN_CHARACTER_RANGES,
  InputError,
  PackError,
  applyAnswers,
  bodyFromInput,
  describeAssetName,
  describeFlag,
  entryNameProblems,
  findQuestion,
  hasHiddenCharacters,
  isStorableAssetName,
  nameProblems,
  parseAssets,
  parseBody,
  parsePack,
  sha256File,
  validatePack,
  validatePackData,
} from '../../skill/everything-mapped/scripts/lib/index.mjs';
import { normalizeText } from '../../skill/everything-mapped/scripts/lib/util.mjs';
import { checkName } from '../../skill/everything-mapped/scripts/lib/zip.mjs';
import { main as answer } from '../../skill/everything-mapped/scripts/answer.mjs';
import { main as assets } from '../../skill/everything-mapped/scripts/assets.mjs';
import { main as check } from '../../skill/everything-mapped/scripts/check.mjs';
import { NOW, TODAY, makeSchemaDir, makeTempDir, readJson, runScript, schema, testI18n, writeText } from './helpers.mjs';

const char = (...codes) => String.fromCodePoint(...codes);
const IS_WINDOWS = process.platform === 'win32';
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

function pack(t, language = 'en') {
  const context = setup(t);
  applyAnswers(context.cwd, { language, answers: [] }, context.options);
  return context;
}

function snapshot(dir) {
  const result = {};
  const walk = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const absolute = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) result[path.relative(dir, absolute)] = fs.readFileSync(absolute, 'utf8');
      else result[path.relative(dir, absolute)] = 'link';
    }
  };
  walk(dir);
  return result;
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

function writeRows(cwd, rows, name = 'rows.json') {
  fs.writeFileSync(path.join(cwd, name), JSON.stringify({ rows }));
}

// ---- 1. changing an answer must not delete another one ---------------------------------------------------------

const KIND_AND_SITE = [
  { id: 'A.project-kind', status: 'complete', choice: ['redesign'] },
  { id: 'A.existing-site', status: 'complete', items: [{ text: 'https://example.com', note: 'The old site' }] },
];

test('an input that would switch off an answered question is refused with exit 2 and nothing is written', async (t) => {
  const { cwd, options, run } = setup(t);
  applyAnswers(cwd, { language: 'en', answers: KIND_AND_SITE }, options);
  const before = snapshot(cwd);
  fs.writeFileSync(path.join(cwd, 'answers.json'), JSON.stringify({ answers: [{ id: 'A.project-kind', status: 'complete', choice: ['new-site'] }] }));
  const result = await run(answer, ['--from', 'answers.json', '--lang', 'en']);
  assert.equal(result.code, 2);
  assert.equal(
    result.err,
    'Changing A.project-kind to new-site would switch off the question A.existing-site, which already has an answer. Send A.existing-site with status missing in the same input to clear it first, or keep A.project-kind as it is.\n',
  );
  fs.rmSync(path.join(cwd, 'answers.json'));
  assert.deepEqual(snapshot(cwd), before);
});

test('the same input is accepted when it clears the question, and the answer is gone only then', async (t) => {
  const { cwd, options, run } = setup(t);
  applyAnswers(cwd, { language: 'en', answers: KIND_AND_SITE }, options);
  fs.writeFileSync(path.join(cwd, 'answers.json'), JSON.stringify({ answers: [{ id: 'A.project-kind', status: 'complete', choice: ['new-site'] }, { id: 'A.existing-site', status: 'missing' }] }));
  assert.equal((await run(answer, ['--from', 'answers.json'])).code, 0);
  const brief = fs.readFileSync(path.join(cwd, 'docs/00-brief.md'), 'utf8');
  assert.ok(!brief.includes('q:A.existing-site') && !brief.includes('The old site'));
});

test('a deferred answer is protected as well, an unanswered question is not, and the first run has nothing to protect', (t) => {
  const { cwd, options } = setup(t);
  applyAnswers(cwd, { language: 'en', answers: [{ id: 'A.project-kind', status: 'complete', choice: ['other'] }, { id: 'A.existing-site', status: 'tbd', owner: 'client', note: 'Ask IT' }] }, options);
  const change = { answers: [{ id: 'A.project-kind', status: 'complete', choice: ['landing-page'] }] };
  assert.throws(() => applyAnswers(cwd, change, options), (error) => error instanceof InputError && error.problems[0].key === 'ui.answer.err.wouldSwitchOff');
  const other = setup(t);
  applyAnswers(other.cwd, { language: 'en', answers: [{ id: 'A.project-kind', status: 'complete', choice: ['redesign'] }] }, other.options);
  assert.doesNotThrow(() => applyAnswers(other.cwd, change, other.options), 'nothing was answered below the changed question');
  const first = setup(t);
  assert.doesNotThrow(() => applyAnswers(first.cwd, { language: 'en', answers: [{ id: 'A.project-kind', status: 'complete', choice: ['new-site'] }] }, first.options));
  const both = setup(t);
  assert.throws(
    () => applyAnswers(both.cwd, { language: 'en', answers: [{ id: 'A.project-kind', status: 'complete', choice: ['new-site'] }, KIND_AND_SITE[1]] }, both.options),
    (error) => error.problems.map((problem) => problem.key).join() === 'ui.answer.err.notApplicable',
  );
});

test('every showIf in the schema is covered, not only the pair of the shipped schema', (t) => {
  const custom = structuredClone(schema);
  custom.modules.find((entry) => entry.id === 'G').questions.find((q) => q.id === 'G.integrations').showIf = { id: 'G.features', in: ['booking'] };
  const { cwd, schemaDir } = setup(t);
  const options = { schema: custom, schemaDir, now: NOW, today: TODAY };
  applyAnswers(cwd, { language: 'en', answers: [{ id: 'G.features', status: 'complete', choice: ['booking'] }, { id: 'G.integrations', status: 'complete', items: [{ text: 'Calendar' }] }] }, options);
  const refused = { answers: [{ id: 'G.features', status: 'complete', choice: ['blog'] }] };
  assert.throws(() => applyAnswers(cwd, refused, options), (error) => error.problems[0].params.id === 'G.integrations' && error.problems[0].params.controller === 'G.features');
  assert.doesNotThrow(() => applyAnswers(cwd, { answers: [...refused.answers, { id: 'G.integrations', status: 'missing' }] }, options));
});

// ---- 2. a name that is not UTF-8 ------------------------------------------------------------------------------------

function writeBytesName(folder, bytes) {
  try {
    fs.writeFileSync(Buffer.concat([Buffer.from(`${folder}${path.sep}`), Buffer.from(bytes)]), 'x');
    return true;
  } catch {
    return false;
  }
}

test('a file name that is not UTF-8 is a bad name, never listed, and blocks nothing', async (t) => {
  if (IS_WINDOWS || process.platform === 'darwin') return t.skip('this file system does not keep names that are not UTF-8');
  const { cwd, options, run } = pack(t);
  const folder = path.join(cwd, 'docs/assets');
  assert.ok(writeBytesName(folder, [0x6c, 0x61, 0x74, 0xe9, 0x2e, 0x70, 0x6e, 0x67]));
  fs.writeFileSync(path.join(folder, 'ok.png'), 'x');
  const scan = JSON.parse((await run(assets, ['--scan', '--json'])).out);
  assert.deepEqual(scan.unlisted, ['assets/ok.png']);
  assert.deepEqual(scan.badName, ['lat<0xE9>.png']);
  const report = JSON.parse((await run(check, ['--json'])).out);
  assert.deepEqual(report.flags.filter((flag) => flag.id === 'assets.badName').map((flag) => flag.params.file), ['lat<0xE9>.png']);
  assert.equal(report.flags.some((flag) => flag.id === 'assets.unlisted' && flag.params.file.includes('lat')), false);
  fs.writeFileSync(path.join(cwd, 'answers.json'), JSON.stringify({ answers: [{ id: 'B.name', status: 'complete', text: 'Nordlys' }] }));
  const answered = await run(answer, ['--from', 'answers.json']);
  assert.equal(answered.code, 0, answered.err);
  assert.equal((await run(check, ['--write'])).code, 0);
  writeRows(cwd, [{ file: 'ok.png', what: 'Fine', rights: 'x' }]);
  const added = await run(assets, ['--from', 'rows.json']);
  assert.equal(added.code, 0, added.err);
  assert.equal((await run(assets, ['--remove', 'ok.png'])).code, 0);
  const manifest = readJson(path.join(cwd, 'docs/intake-manifest.json'));
  assert.ok(!manifest.files.some((entry) => entry.path.includes('lat')), 'it is not in the manifest');
  assert.deepEqual(parsePack(cwd, schema).assets.invalid, ['lat<0xE9>.png']);
  assert.ok(options);
});

test('a folder with a name that is not UTF-8 is skipped with its content and named once', async (t) => {
  if (IS_WINDOWS || process.platform === 'darwin') return t.skip('this file system does not keep names that are not UTF-8');
  const { cwd, run } = pack(t);
  const folder = path.join(cwd, 'docs/assets');
  const bad = Buffer.concat([Buffer.from(`${folder}${path.sep}`), Buffer.from([0x66, 0xe9])]);
  fs.mkdirSync(bad);
  fs.writeFileSync(Buffer.concat([bad, Buffer.from(`${path.sep}in.png`)]), 'x');
  const scan = JSON.parse((await run(assets, ['--scan', '--json'])).out);
  assert.deepEqual(scan.badName, ['f<0xE9>']);
  assert.deepEqual(scan.unlisted, []);
});

test('a file that disappears or cannot be examined is a PackError that names it, not a raw error', async (t) => {
  const { cwd, run } = pack(t);
  const asset = path.join(cwd, 'docs/assets/gone.bin');
  fs.writeFileSync(asset, 'x');
  const original = fs.statSync;
  t.mock.method(fs, 'statSync', (file, ...rest) => {
    if (String(file) === asset) throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    return original(file, ...rest);
  });
  fs.writeFileSync(path.join(cwd, 'answers.json'), JSON.stringify({ answers: [{ id: 'B.name', status: 'complete', text: 'Nordlys' }] }));
  const result = await run(answer, ['--from', 'answers.json']);
  assert.equal(result.code, 3);
  assert.match(result.err, /^The file docs\/assets\/gone\.bin cannot be read/);
  assert.ok(!result.err.includes('Unexpected error'));
});

// ---- 3. the rule of the zip for names ---------------------------------------------------------------------------------

const PACK_REFUSED = {
  'a:b.png': 'forbiddenCharacter',
  'what?.png': 'forbiddenCharacter',
  '<!--c.png': 'forbiddenCharacter',
  '>lead.png': 'forbiddenCharacter',
  'pipe|name.png': 'forbiddenCharacter',
  'trailing.': 'endsWithDotOrSpace',
  'con.png': 'deviceName',
  [`${char(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467)}.png`]: 'forbiddenCharacter',
};

test('nameProblems and entryNameProblems give the rule of the zip as data, with every problem', () => {
  for (const [name, code] of Object.entries(PACK_REFUSED)) {
    assert.equal(nameProblems(`docs/assets/${name}`)[0].code, code, name);
  }
  assert.deepEqual(nameProblems('docs/assets/fine name æøå.png'), []);
  assert.deepEqual(nameProblems(`docs/${'x'.repeat(256)}.png`).map((problem) => problem.code), ['partTooLong', 'pathTooLong']);
  assert.deepEqual(nameProblems(`docs/${'ø'.repeat(128)}.png`).map((problem) => problem.code), ['partTooLong'], 'bytes, not characters');
  assert.deepEqual(nameProblems(`${'d/'.repeat(121)}x.png`).map((problem) => problem.code), ['pathTooLong']);
  assert.deepEqual(nameProblems('docs\\a.png').map((problem) => problem.code), ['backslash']);
  const problems = entryNameProblems(['docs/assets/Logo.png', 'docs/assets/logo.png', 'docs/assets/con.png', 'docs/assets/Logo', 'docs/assets/logo/x.png', 'docs/assets/Å.png', `docs/assets/${'A'.normalize('NFC')}${char(0x30a)}.png`]);
  assert.deepEqual(
    problems.map((problem) => [problem.name, problem.code, problem.other ?? null]),
    [
      ['docs/assets/logo.png', 'duplicate', 'docs/assets/Logo.png'],
      ['docs/assets/con.png', 'deviceName', null],
      ['docs/assets/Logo', 'fileAndFolder', 'docs/assets/logo/x.png'],
      [`docs/assets/${char(0x41, 0x30a)}.png`, 'duplicate', 'docs/assets/Å.png'],
    ],
  );
});

test('zip.mjs still refuses the same names with the same messages, through the shared rule', () => {
  for (const [name] of Object.entries(PACK_REFUSED)) assert.throws(() => checkName(`docs/assets/${name}`), (error) => error.code === 'badName', name);
  assert.throws(() => checkName(`docs/${'x'.repeat(256)}.png`), (error) => error.code === 'nameTooLong');
  assert.throws(() => checkName('docs/a/../b'), (error) => error.code === 'badName' && /not allowed/.test(error.message));
  assert.doesNotThrow(() => checkName('docs/00-brief.md'));
});

test('check and assets warn about every name the zip would refuse, once, with the reason', async (t) => {
  const { cwd, run } = pack(t);
  const names = [...Object.keys(PACK_REFUSED), 'Logo.png', 'logo.png', 'Logo2', 'logo2/x.png', 'fine.png'];
  const made = names.filter((name) => tryWrite(path.join(cwd, 'docs/assets', name)));
  assert.ok(made.length >= 10);
  writeRows(cwd, made.map((file) => ({ file, what: 'x', rights: 'x' })));
  const added = await run(assets, ['--from', 'rows.json', '--json']);
  assert.equal(added.code, 0, added.err);
  const report = JSON.parse((await run(check, ['--json'])).out);
  const flagged = report.flags.filter((flag) => flag.id === 'assets.notPackable');
  const byFile = Object.fromEntries(flagged.map((flag) => [flag.params.file, flag.params.reasonCode]));
  assert.equal(byFile['a:b.png'], 'forbiddenCharacter');
  assert.equal(byFile['trailing.'], 'endsWithDotOrSpace');
  assert.equal(byFile['con.png'], 'deviceName');
  assert.equal(byFile[`${char(0x1f468)}<U+200D>${char(0x1f469)}<U+200D>${char(0x1f467)}.png`], 'forbiddenCharacter', 'the name is shown with markers');
  assert.equal(byFile['logo.png'], 'duplicate');
  assert.equal(byFile.Logo2, 'fileAndFolder');
  assert.equal(byFile['fine.png'], undefined);
  assert.equal(flagged.length, new Set(flagged.map((flag) => flag.params.file)).size, 'each name once');
  const scan = JSON.parse((await run(assets, ['--scan', '--json'])).out);
  assert.deepEqual(scan.notPackable.map((entry) => entry.file).sort(), flagged.map((flag) => flag.params.file).sort());
  assert.equal(scan.notPackable.find((entry) => entry.file === 'con.png').reason, 'deviceName');
  const human = await run(assets, ['--scan', '--lang', 'en']);
  assert.match(human.out, /con\.png: the name is reserved on Windows/);
  for (const lang of ['da', 'en']) {
    const message = describeFlag(flagged.find((flag) => flag.params.file === 'con.png'), testI18n(lang));
    assert.ok(message.includes('con.png') && !message.includes('{') && !message.startsWith('flag.'), message);
  }
  assert.match(describeFlag(flagged.find((flag) => flag.params.file === 'logo.png'), testI18n('en')), /differs from Logo\.png only in case/);
});

test('names the zip refuses do not stop the other commands', async (t) => {
  const { cwd, run } = pack(t);
  assert.ok(tryWrite(path.join(cwd, 'docs/assets/what?.png')));
  fs.writeFileSync(path.join(cwd, 'answers.json'), JSON.stringify({ answers: [{ id: 'B.name', status: 'complete', text: 'Nordlys' }] }));
  assert.equal((await run(answer, ['--from', 'answers.json'])).code, 0);
  assert.equal((await run(check, ['--write'])).code, 0);
});

// ---- 4. line separators in names -------------------------------------------------------------------------------------

test('a name with U+2028 or U+2029 is not storable and cannot split a row of the table', async (t) => {
  assert.equal(isStorableAssetName(`a${char(0x2028)}b.png`), false);
  assert.equal(isStorableAssetName(`a${char(0x2029)}b.png`), false);
  const { cwd, run } = pack(t);
  const names = [`line${char(0x2028)}sep.png`, `para${char(0x2029)}sep.png`];
  const made = names.filter((name) => tryWrite(path.join(cwd, 'docs/assets', name)));
  assert.ok(made.length >= 1);
  const scan = JSON.parse((await run(assets, ['--scan', '--json'])).out);
  assert.equal(scan.badName.length, made.length);
  assert.ok(scan.badName.every((name) => name.includes('<U+202')));
  for (const name of made) {
    const result = await run(assets, ['--add', name]);
    assert.equal(result.code, 2);
    assert.match(result.err, /cannot be put in the list because of its name/);
  }
  assert.deepEqual(parseAssets(fs.readFileSync(path.join(cwd, 'docs/assets.md'), 'utf8')), []);
  const report = JSON.parse((await run(check, ['--json'])).out);
  assert.equal(report.flags.filter((flag) => flag.id === 'assets.badName').length, made.length);
  assert.equal(report.flags.filter((flag) => flag.id === 'assets.notPackable').length, 0, 'a name that cannot be listed is reported once, as a bad name');
});

// ---- 5. all or nothing, with the file system in the way ---------------------------------------------------------------

function failRename(t, onCall) {
  const original = fs.renameSync;
  let calls = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    calls += 1;
    if (calls === onCall) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
    return original(from, to);
  });
}

test('a failed rename in the middle of answer puts every file back as it was', async (t) => {
  const { cwd, options, run } = pack(t);
  applyAnswers(cwd, { answers: [{ id: 'A.goal', status: 'complete', text: 'A goal that is long enough to be complete for this test.' }] }, options);
  const before = snapshot(cwd);
  failRename(t, 2);
  fs.writeFileSync(path.join(cwd, 'answers.json'), JSON.stringify({ respondent: { name: 'Anna', role: 'IT' }, answers: [{ id: 'A.goal', status: 'complete', text: 'A changed goal that is long enough to be complete.' }, { id: 'I.domain', status: 'tbd', owner: 'client', note: 'Ask' }, { id: 'B.name', status: 'complete', text: 'Nordlys' }] }));
  const result = await run(answer, ['--from', 'answers.json', '--lang', 'en'], { env: {} });
  assert.equal(result.code, 3);
  assert.match(result.err, /^Cannot save docs\/.* \(EIO\)\. Nothing was changed\.\n$/);
  fs.rmSync(path.join(cwd, 'answers.json'));
  assert.deepEqual(snapshot(cwd), before, 'old contents are back, and no temporary or backup file is left');
  t.mock.restoreAll();
  fs.writeFileSync(path.join(cwd, 'answers.json'), JSON.stringify({ answers: [{ id: 'B.name', status: 'complete', text: 'Nordlys' }] }));
  assert.equal((await run(answer, ['--from', 'answers.json'])).code, 0, 'and the same input works afterwards');
});

test('a failed rename in the last file also puts back the files renamed before it', (t) => {
  const { cwd, options } = pack(t);
  const before = snapshot(cwd);
  let calls = 0;
  const original = fs.renameSync;
  let total = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    total += 1;
    return original(from, to);
  });
  applyAnswers(cwd, { answers: [{ id: 'B.name', status: 'complete', text: 'Nordlys' }] }, { ...options, now: new Date('2026-11-01T12:00:00Z'), today: '2026-11-01' });
  const renames = total;
  t.mock.restoreAll();
  fs.cpSync(cwd, `${cwd}-saved`, { recursive: true });
  t.after(() => fs.rmSync(`${cwd}-saved`, { recursive: true, force: true }));
  for (const key of Object.keys(snapshot(cwd))) fs.rmSync(path.join(cwd, key), { force: true });
  for (const [key, text] of Object.entries(before)) writeText(cwd, key.split(path.sep).join('/'), text);
  assert.deepEqual(snapshot(cwd), before);
  failRename(t, renames);
  assert.throws(
    () => applyAnswers(cwd, { answers: [{ id: 'B.name', status: 'complete', text: 'Nordlys' }] }, { ...options, now: new Date('2026-11-01T12:00:00Z'), today: '2026-11-01' }),
    (error) => error instanceof PackError && error.key === 'ui.check.err.writeFailed',
  );
  assert.deepEqual(snapshot(cwd), before);
  assert.equal(calls, 0);
});

test('when a file cannot be put back either, the error says where the old version is', async (t) => {
  const { cwd, options, run } = pack(t);
  applyAnswers(cwd, { answers: [{ id: 'A.goal', status: 'complete', text: 'The first version of the goal, long enough to be complete.' }] }, options);
  const brief = path.join(cwd, 'docs/00-brief.md');
  const oldBrief = fs.readFileSync(brief, 'utf8');
  const original = fs.renameSync;
  let calls = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    calls += 1;
    if (calls === 2 || calls === 3) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
    return original(from, to);
  });
  fs.writeFileSync(path.join(cwd, 'answers.json'), JSON.stringify({ answers: [{ id: 'A.goal', status: 'complete', text: 'The second version of the goal, long enough to be complete.' }, { id: 'B.name', status: 'complete', text: 'Nordlys' }] }));
  const result = await run(answer, ['--from', 'answers.json', '--lang', 'en']);
  assert.equal(result.code, 3);
  assert.match(result.err, /^Cannot save docs\/.+ \(EIO\), and docs\/00-brief\.md could not be put back as it was\. The old version is in a file with the same name followed by \.tmp, in the same folder\.\n$/);
  const kept = fs.readdirSync(path.join(cwd, 'docs')).filter((name) => name.startsWith('00-brief.md.') && name.endsWith('.tmp'));
  assert.equal(kept.length, 1, 'the old version is kept under a name that is not part of the pack');
  assert.equal(fs.readFileSync(path.join(cwd, 'docs', kept[0]), 'utf8'), oldBrief);
});

test('a failure while the temporary files are written changes nothing either', (t) => {
  const { cwd, options } = pack(t);
  const before = snapshot(cwd);
  const original = fs.writeFileSync;
  let calls = 0;
  t.mock.method(fs, 'writeFileSync', (file, ...rest) => {
    calls += 1;
    if (calls === 3) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    return original(file, ...rest);
  });
  assert.throws(() => applyAnswers(cwd, { answers: [{ id: 'B.name', status: 'complete', text: 'Nordlys' }] }, options), (error) => error instanceof PackError && error.params.code === 'ENOSPC');
  t.mock.restoreAll();
  assert.deepEqual(snapshot(cwd), before);
});

test('check --write and the assets table are all or nothing too', async (t) => {
  const { cwd, run } = pack(t);
  fs.writeFileSync(path.join(cwd, 'docs/assets/logo.svg'), '<svg/>');
  const before = snapshot(cwd);
  failRename(t, 2);
  const written = await run(check, ['--write']);
  assert.equal(written.code, 3);
  assert.deepEqual(snapshot(cwd), before);
  t.mock.restoreAll();
  failRename(t, 2);
  const added = await run(assets, ['--add', 'logo.svg', '--what', 'Logo', '--rights', 'x']);
  assert.equal(added.code, 3);
  assert.deepEqual(snapshot(cwd), before, 'the table, the open questions and the manifest are as they were');
  t.mock.restoreAll();
  assert.equal((await run(assets, ['--add', 'logo.svg', '--what', 'Logo', '--rights', 'x'])).code, 0);
});

// ---- 6. field lengths -------------------------------------------------------------------------------------------------

test('long names, roles, owners and recipients are refused with exit 2 and a message that names the field', async (t) => {
  const { cwd, run } = setup(t);
  const cases = [
    [{ respondent: { name: 'n'.repeat(20001) } }, 'The field respondent.name is longer than 200 characters.'],
    [{ respondent: { name: 'Anna', role: 'r'.repeat(20001) } }, 'The field respondent.role is longer than 200 characters.'],
    [{ recipient: 'r'.repeat(20001) }, 'The field recipient is longer than 200 characters.'],
    [{ answers: [{ id: 'I.domain', status: 'tbd', owner: 'o'.repeat(20001), note: 'x' }] }, 'The field owner (I.domain) is longer than 200 characters.'],
  ];
  for (const [extra, message] of cases) {
    fs.writeFileSync(path.join(cwd, 'answers.json'), JSON.stringify({ language: 'en', answers: [], ...extra }));
    const result = await run(answer, ['--from', 'answers.json', '--lang', 'en']);
    assert.equal(result.code, 2, message);
    assert.equal(result.err, `${message}\n`);
    assert.deepEqual(fs.readdirSync(cwd), ['answers.json']);
  }
});

test('the respondent line cannot grow past what the parser reads', (t) => {
  const { cwd, options } = setup(t);
  applyAnswers(cwd, { language: 'en', answers: [] }, options);
  let refused = null;
  for (let index = 0; index < 60 && refused === null; index += 1) {
    try {
      applyAnswers(cwd, { respondent: { name: `Person ${index} ${'n'.repeat(190)}`, role: 'r'.repeat(190) }, answers: [{ id: 'B.name', status: 'complete', text: 'Nordlys' }] }, options);
    } catch (error) {
      refused = error;
    }
  }
  assert.ok(refused instanceof InputError, 'refused before the line became too long');
  assert.equal(refused.problems[0].key, 'ui.answer.err.fieldTooLong');
  assert.equal(refused.problems[0].params.field, 'respondent');
  assert.doesNotThrow(() => parsePack(cwd, schema), 'the pack can still be read');
});

test('text that grows when it is rewritten (raw markup) is an input error, not an unreadable pack', async (t) => {
  const { cwd, run } = setup(t);
  const grows = '<a'.repeat(7000);
  writeText(cwd, 'docs/00-brief.md', `${FRONT('brief')}\n### A\n<!-- q:A.goal status:complete -->\n${grows}\n`);
  fs.writeFileSync(path.join(cwd, 'answers.json'), JSON.stringify({ answers: [{ id: 'B.name', status: 'complete', text: 'Nordlys' }] }));
  const before = snapshot(cwd);
  const result = await run(answer, ['--from', 'answers.json', '--lang', 'en']);
  assert.equal(result.code, 2);
  assert.match(result.err, /^These answers would make a line longer than 20000 characters in docs\/00-brief\.md/);
  assert.deepEqual(snapshot(cwd), before, 'nothing was written');
});

// ---- 7. NFC and NFD names ------------------------------------------------------------------------------------------------

test('a row written in NFC finds a file with an NFD name, and the spelling of the disk is stored and printed', async (t) => {
  const { cwd, run } = pack(t);
  const nfd = `${char(0x41, 0x30a)}rhus.jpg`;
  const nfc = 'Århus.jpg'.normalize('NFC');
  assert.notEqual(nfd, nfc);
  assert.ok(tryWrite(path.join(cwd, 'docs/assets', nfd)));
  const scan = JSON.parse((await run(assets, ['--scan', '--json'])).out);
  assert.deepEqual(scan.unlisted, [`assets/${nfd}`]);
  writeRows(cwd, [{ file: nfc, what: 'Photo', rights: 'x' }]);
  const added = await run(assets, ['--from', 'rows.json', '--json']);
  assert.equal(added.code, 0, added.err);
  const data = JSON.parse(added.out);
  assert.deepEqual(data.added, [`assets/${nfd}`], 'the spelling found on disk');
  assert.deepEqual([data.unlisted, data.missingFile], [[], []]);
  assert.equal(parseAssets(fs.readFileSync(path.join(cwd, 'docs/assets.md'), 'utf8'))[0].file, `assets/${nfd}`);
  writeRows(cwd, [{ file: nfc, rights: 'Changed' }]);
  const again = JSON.parse((await run(assets, ['--from', 'rows.json', '--json'])).out);
  assert.deepEqual(again.updated, [`assets/${nfd}`]);
  assert.equal(again.rows.length, 1);
  assert.equal((await run(assets, ['--remove', nfc])).code, 0);
});

test('a hand-written NFC row for an NFD file is not flagged as missing or unlisted', async (t) => {
  const { cwd, run } = pack(t);
  const nfd = `${char(0x41, 0x30a)}rhus.jpg`;
  assert.ok(tryWrite(path.join(cwd, 'docs/assets', nfd)));
  fs.writeFileSync(path.join(cwd, 'docs/assets.md'), `| File | What | Owner | Rights | Restrictions |\n|---|---|---|---|---|\n| assets/${'Århus.jpg'.normalize('NFC')} | Photo | Kunden | Ejes | |\n`);
  const report = JSON.parse((await run(check, ['--json'])).out);
  assert.deepEqual(report.flags.filter((flag) => flag.id.startsWith('assets.')), []);
});

test('the other way round too: a row in NFD finds a file with an NFC name, in add, check and scan', async (t) => {
  const { cwd, run } = pack(t);
  const nfc = char(0xc5) + 'rhus.jpg';
  const nfd = char(0x41, 0x30a) + 'rhus.jpg';
  assert.ok(tryWrite(path.join(cwd, 'docs/assets', nfc)));
  // A table written by hand with the decomposed spelling.
  fs.writeFileSync(path.join(cwd, 'docs/assets.md'), `| File | What | Owner | Rights | Restrictions |\n|---|---|---|---|---|\n| assets/${nfd} | Photo | Kunden | Ejes | |\n`);
  const report = JSON.parse((await run(check, ['--json'])).out);
  assert.deepEqual(report.flags.filter((flag) => flag.id.startsWith('assets.')), [], 'neither missing nor unlisted');
  const scan = JSON.parse((await run(assets, ['--scan', '--json'])).out);
  assert.deepEqual([scan.unlisted, scan.missingFile], [[], []]);
  // An update finds the file by the other spelling and the table gets the spelling of the disk.
  const updated = JSON.parse((await run(assets, ['--add', nfd, '--rights', 'Changed', '--json'])).out);
  assert.deepEqual(updated.updated, [`assets/${nfc}`]);
  assert.equal(updated.rows.length, 1);
  const stored = parseAssets(fs.readFileSync(path.join(cwd, 'docs/assets.md'), 'utf8'));
  assert.deepEqual(stored.map((row) => [row.file, row.rights]), [[`assets/${nfc}`, 'Changed']]);
  const human = await run(assets, ['--add', nfd, '--what', 'Photo of the town', '--lang', 'en']);
  assert.match(human.out, new RegExp(`Updated: assets/${nfc}`));
});

test('a deferred answer with a line that already starts with a backslash keeps it', async (t) => {
  const { cwd, options, run } = setup(t);
  applyAnswers(cwd, { language: 'en', answers: [{ id: 'I.domain', status: 'tbd', owner: 'client', note: 'Ask\n\\---\n===' }] }, options);
  const report = JSON.parse((await run(check, ['--json'])).out);
  assert.equal(report.questions['I.domain'].note, 'Ask \\--- ===');
  const technical = fs.readFileSync(path.join(cwd, 'docs/05-technical-and-compliance.md'), 'utf8');
  assert.match(technical, /\nAsk\n\\\\---\n\\===\n/);
  assert.equal(applyAnswers(cwd, { answers: [] }, options).written.length, 0, 'writing again changes nothing');
});

// ---- 8. hidden characters, from the Unicode property -----------------------------------------------------------------------

const ALLOWED = new Set([0x200d, 0x200c, 0xad, 0x200e, 0x200f]);
for (let code = 0xfe00; code <= 0xfe0f; code += 1) ALLOWED.add(code);

function inRanges(code) {
  return HIDDEN_CHARACTER_RANGES.some(([from, to]) => code >= from && code <= to);
}

test('the refused set is every default-ignorable character except the allowed ones, plus the old ones', () => {
  const property = /\p{Default_Ignorable_Code_Point}/u;
  const missing = [];
  const extra = [];
  for (let code = 0; code <= 0x10ffff; code += 1) {
    if (code >= 0xd800 && code <= 0xdfff) continue;
    const ignorable = property.test(String.fromCodePoint(code));
    if (ignorable && !ALLOWED.has(code) && !inRanges(code)) missing.push(code.toString(16));
    if (!ignorable && inRanges(code) && !(code >= 0xfff9 && code <= 0xfffb)) extra.push(code.toString(16));
    if (ALLOWED.has(code) && inRanges(code)) extra.push(`allowed ${code.toString(16)}`);
  }
  assert.deepEqual(missing.slice(0, 10), [], 'default-ignorable characters that are not refused');
  assert.deepEqual(extra.slice(0, 10), [], 'refused characters that are not default-ignorable');
  for (const code of [0x206a, 0x206f, 0x1d173, 0x1d17a, 0x1bca0, 0x1bca3, 0xfff0, 0xfff8, 0x115f, 0x1160, 0x3164, 0xffa0, 0x34f, 0x180b, 0x180f, 0xe0080, 0xe0fff, 0xe0100, 0xe01ef, 0xe0041, 0x202e, 0x200b]) {
    assert.equal(hasHiddenCharacters(`a${char(code)}b`), true, code.toString(16));
  }
  for (const code of [...ALLOWED]) assert.equal(hasHiddenCharacters(`a${char(code)}b`), false, code.toString(16));
});

test('the terminal sanitizer marks all of them too', async () => {
  const { sanitizeForTerminal } = await import('../../skill/everything-mapped/scripts/lib/index.mjs');
  for (const code of [0x206a, 0x1d173, 0x1bca0, 0xfff0, 0x115f, 0x3164, 0xffa0, 0x34f, 0x180b, 0xe0080, 0xe0100]) {
    assert.equal(sanitizeForTerminal(`a${char(code)}b`), `a${char(0xfffd)}b`, code.toString(16));
  }
});

test('hidden characters in the state file and the manifest are flagged when the pack is read, and never kept raw', async (t) => {
  const { cwd, options, run } = pack(t);
  const statePath = path.join(cwd, 'docs/intake-state.json');
  fs.writeFileSync(statePath, JSON.stringify({ ...readJson(statePath), recipient: `Jonas${char(0xe0041, 0x202e)}`, notes: `n${char(0x2064)}` }));
  const manifestPath = path.join(cwd, 'docs/intake-manifest.json');
  const manifest = readJson(manifestPath);
  fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, respondents: [{ name: `Eve${char(0x202e)}`, role: '', updated: TODAY }] }));
  const report = JSON.parse((await run(check, ['--json'])).out);
  const labels = report.flags.filter((flag) => flag.id === 'text.hiddenCharacters').map((flag) => flag.params.label);
  assert.deepEqual(labels, ['docs/intake-state.json (recipient)', 'docs/intake-state.json (notes)', 'docs/intake-manifest.json (respondents)']);
  for (const lang of ['da', 'en']) assert.match((await run(check, ['--lang', lang])).out, /docs\/intake-state\.json \(recipient\)/);
  applyAnswers(cwd, { answers: [{ id: 'B.name', status: 'complete', text: 'Nordlys' }] }, options);
  const state = readJson(statePath);
  assert.equal(state.recipient, 'Jonas<U+E0041><U+202E>');
  assert.equal(state.notes, 'n<U+2064>');
  assert.equal(hasHiddenCharacters(JSON.stringify(readJson(manifestPath))), false);
});

// ---- 10. opening files ----------------------------------------------------------------------------------------------------

test('files are opened without following a link and without waiting for a pipe', (t) => {
  const { cwd } = pack(t);
  const asset = path.join(cwd, 'docs/assets/data.bin');
  fs.writeFileSync(asset, 'hello');
  const flags = [];
  const original = fs.openSync;
  t.mock.method(fs, 'openSync', (file, flag, ...rest) => {
    flags.push(flag);
    return original(file, flag, ...rest);
  });
  sha256File(asset);
  parsePack(cwd, schema);
  const { O_NOFOLLOW = 0, O_NONBLOCK = 0 } = fs.constants;
  assert.ok(flags.length > 3);
  for (const flag of flags) {
    assert.equal((flag & O_NOFOLLOW) === O_NOFOLLOW && (flag & O_NONBLOCK) === O_NONBLOCK, true, `flag ${flag}`);
  }
});

test('a link or a pipe in place of a file is a PackError that names the file', (t) => {
  const { cwd } = pack(t);
  const real = path.join(cwd, 'real.bin');
  fs.writeFileSync(real, 'x');
  const link = path.join(cwd, 'docs/assets/link.bin');
  try {
    fs.symlinkSync(real, link);
  } catch {
    return t.skip('symbolic links are not available here');
  }
  assert.throws(() => sha256File(link), (error) => error instanceof PackError && error.key === 'ui.check.err.assetUnreadable' && /link\.bin/.test(error.params.path));
  const asset = path.join(cwd, 'docs/assets/data.bin');
  fs.writeFileSync(asset, 'x');
  const original = fs.fstatSync;
  t.mock.method(fs, 'fstatSync', (descriptor, ...rest) => {
    const stat = original(descriptor, ...rest);
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { isFile: () => false });
  });
  assert.throws(() => sha256File(asset), (error) => error instanceof PackError && error.key === 'ui.check.err.assetUnreadable');
});

test('an answer file that is a link is refused with a message that names it', (t) => {
  const { cwd } = pack(t);
  const real = path.join(cwd, 'docs/real-brief.md');
  fs.writeFileSync(real, fs.readFileSync(path.join(cwd, 'docs/00-brief.md')));
  fs.rmSync(path.join(cwd, 'docs/00-brief.md'));
  try {
    fs.symlinkSync(real, path.join(cwd, 'docs/00-brief.md'));
  } catch {
    return t.skip('symbolic links are not available here');
  }
  assert.throws(() => parsePack(cwd, schema), (error) => error instanceof PackError && /00-brief\.md/.test(error.params.path));
});

// ---- 11. setext headings ----------------------------------------------------------------------------------------------------

const SETEXT_LINE = /^ {0,3}(=+|-+)[ \t]*$/;

test('lines of = or - below a text line are neutralised in the file and restored when it is read', (t) => {
  const question = findQuestion(schema, 'A.goal');
  const texts = ['Title\n===', 'Title\n---', 'a\n===\nb\n------\nc', '===', '  ---  ', '\\===', '\\\\---', 'x\n\\===\ny', 'not an underline: ===', '= = =', '- item\n---'];
  for (const text of texts) {
    const body = bodyFromInput(question, { text });
    assert.ok(!body.split('\n').some((line) => SETEXT_LINE.test(line)), JSON.stringify(body));
    assert.equal(parseBody(question, body).text, normalizeText(text), JSON.stringify(text));
  }
  const { cwd, options } = setup(t);
  applyAnswers(cwd, { language: 'en', answers: [{ id: 'A.goal', status: 'complete', text: 'Heading\n=======\nMore\n-------' }, { id: 'I.domain', status: 'tbd', note: 'Note\n---' }] }, options);
  const brief = fs.readFileSync(path.join(cwd, 'docs/00-brief.md'), 'utf8');
  const technical = fs.readFileSync(path.join(cwd, 'docs/05-technical-and-compliance.md'), 'utf8');
  // Below the front matter, no underline follows a line of text: it would turn that line into a heading.
  const underlinesText = (file) => {
    const lines = file.split('\n');
    const body = lines.slice(lines.indexOf('---', 1) + 1);
    return body.some((line, index) => SETEXT_LINE.test(line) && index > 0 && body[index - 1].trim() !== '' && !body[index - 1].startsWith('<!--'));
  };
  for (const file of [brief, technical]) assert.equal(underlinesText(file), false, file);
  const read = parsePack(cwd, schema);
  assert.equal(read.files.brief.answers['A.goal'].value.text, 'Heading\n=======\nMore\n-------');
  assert.equal(applyAnswers(cwd, { answers: [] }, options).written.length, 0, 'rewriting is stable');
});

test('a random mix of text and underline lines round trips', () => {
  const question = findQuestion(schema, 'A.goal');
  let state = 5;
  const random = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
  const pieces = ['text', '===', '---', '\\===', '\\\\---', '  ===', '- a', '= -', '', '--=='];
  for (let round = 0; round < 1500; round += 1) {
    const text = Array.from({ length: 1 + Math.floor(random() * 6) }, () => pieces[Math.floor(random() * pieces.length)]).join('\n').replace(/^\n+|\n+$/g, '');
    const body = bodyFromInput(question, { text });
    assert.ok(!body.split('\n').some((line) => SETEXT_LINE.test(line)), JSON.stringify(body));
    assert.equal(parseBody(question, body).text, normalizeText(text), JSON.stringify(text));
  }
});

// ---- the folder is made by --init only ---------------------------------------------------------------------------------------

test('--from and --add never make docs/assets; --init is the only option that does', async (t) => {
  const { cwd, run } = setup(t);
  writeRows(cwd, []);
  assert.equal((await run(assets, ['--from', 'rows.json'])).code, 0);
  assert.equal(fs.existsSync(path.join(cwd, 'docs')), false, 'nothing was made');
  writeRows(cwd, [{ file: 'logo.svg' }]);
  const refused = await run(assets, ['--from', 'rows.json', '--lang', 'en']);
  assert.equal(refused.code, 2);
  assert.equal(fs.existsSync(path.join(cwd, 'docs')), false);
  assert.equal((await run(assets, ['--init'])).code, 0);
  assert.ok(fs.statSync(path.join(cwd, 'docs/assets')).isDirectory());
  fs.writeFileSync(path.join(cwd, 'docs/assets/logo.svg'), '<svg/>');
  assert.equal((await run(assets, ['--from', 'rows.json'])).code, 0);
});
