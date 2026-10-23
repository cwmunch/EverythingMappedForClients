import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../../skill/everything-mapped/scripts/lib/index.mjs';
import { main as answer } from '../../skill/everything-mapped/scripts/answer.mjs';
import { main as assets } from '../../skill/everything-mapped/scripts/assets.mjs';
import { main as check } from '../../skill/everything-mapped/scripts/check.mjs';
import { main as next } from '../../skill/everything-mapped/scripts/next.mjs';
import { FIXTURES, copyFolder, makeSchemaDir, makeTempDir, readJson, runScript, writeText } from './helpers.mjs';

const DA_INPUT = path.join(FIXTURES, 'inputs', 'da-complete.json');

// A working folder with the test dictionary, and the folder the scripts run in.
function setup(t, fixture) {
  const schemaDir = makeSchemaDir(t);
  const cwd = makeTempDir(t);
  if (fixture) copyFolder(path.join(FIXTURES, fixture), cwd);
  const run = (main, argv, extra = {}) => runScript(main, argv, { cwd, schemaDir, ...extra });
  return { schemaDir, cwd, run };
}

function noOpenKeys(text) {
  assert.ok(!/\bui\.[a-z]+\.[A-Za-z.]+/.test(text), `an unresolved text key in: ${text}`);
}

// ---- check -----------------------------------------------------------------------------------

test('check on the complete Danish pack says it is ready, in Danish, and exits 0 even with --strict', async (t) => {
  const { run } = setup(t, 'pack-da-complete');
  const result = await run(check, ['--strict']);
  assert.equal(result.code, 0);
  assert.equal(result.err, '');
  assert.ok(result.out.startsWith('Klar: alle spørgsmål, der skal besvares, er besvaret.\n'));
  assert.ok(result.out.includes('Dybde: Det hele'));
  assert.ok(result.out.includes('Samlet dækning: 100 %'));
  assert.ok(result.out.includes('Svar: 97 færdige, 0 delvise, 0 udskudte, 0 mangler, 0 ikke relevante'));
  assert.ok(result.out.includes('Pakken er klar til at blive samlet og sendt.'));
  assert.ok(!result.out.includes('Spørgsmål, der skal besvares, og som mangler'));
  noOpenKeys(result.out);
});

test('check on the broken pack lists blockers with labels and findings grouped by severity', async (t) => {
  const { run } = setup(t, 'pack-broken');
  const result = await run(check, []);
  assert.equal(result.code, 0, 'exit 0 without --strict');
  const lines = result.out.split('\n');
  assert.ok(lines[0].startsWith('Ikke klar: der mangler stadig svar på spørgsmål, der skal besvares ('));
  assert.ok(result.out.includes('Spørgsmål, der skal besvares, og som mangler:\n  - A.business  Virksomheden kort fortalt\n'));
  assert.ok(result.out.includes('  - A.deadline\n'), 'a question without a label shows only its id');
  const must = result.out.indexOf('Skal rettes:');
  const should = result.out.indexOf('Bør rettes:');
  const info = result.out.indexOf('Til information:');
  const steps = result.out.indexOf('Næste skridt:');
  assert.ok(must > 0 && should > must && info > should && steps > info);
  assert.ok(result.out.includes('Virksomheden kort fortalt: svaret er for kort (17 tegn, der skal mindst være 60).'));
  assert.ok(result.out.includes('Filen docs/05-technical-and-compliance.md findes ikke endnu.'));
  noOpenKeys(result.out);
});

test('check --strict exits 1 when must-answer questions are open', async (t) => {
  const { run } = setup(t, 'pack-broken');
  assert.equal((await run(check, ['--strict'])).code, 1);
  assert.equal((await run(check, ['--strict', '--json'])).code, 1);
});

test('check --json prints the report with the completeness of the manifest and writes nothing', async (t) => {
  const { cwd, run } = setup(t, 'pack-en-partial');
  const before = fs.readFileSync(path.join(cwd, 'docs/intake-manifest.json'), 'utf8');
  const result = await run(check, ['--json']);
  assert.equal(result.code, 0);
  const report = JSON.parse(result.out);
  assert.deepEqual(Object.keys(report), ['language', 'depth', 'questions', 'gate1', 'completeness', 'flags', 'written']);
  assert.equal(report.language, 'en');
  assert.equal(report.gate1.ready, false);
  assert.ok(report.gate1.blocking.includes('A.why-now'));
  assert.equal(report.completeness.gate1Ready, false);
  assert.deepEqual(report.completeness.gate1Blocking, report.gate1.blocking);
  assert.ok(report.completeness.byArea.design);
  assert.deepEqual(report.written, []);
  assert.equal(fs.readFileSync(path.join(cwd, 'docs/intake-manifest.json'), 'utf8'), before);
});

test('check --write refreshes the manifest and the open questions, and says so', async (t) => {
  const { cwd, run } = setup(t, 'pack-en-partial');
  fs.rmSync(path.join(cwd, 'docs/intake-manifest.json'));
  fs.rmSync(path.join(cwd, 'docs/07-risks-and-open-questions.md'));
  const result = await run(check, ['--write', '--json']);
  assert.deepEqual(JSON.parse(result.out).written, ['docs/07-risks-and-open-questions.md', 'docs/intake-manifest.json']);
  assert.ok(fs.existsSync(path.join(cwd, 'docs/intake-manifest.json')));
  const again = await run(check, ['--write']);
  assert.ok(!again.out.includes('Wrote:'), 'nothing changed the second time');
  fs.appendFileSync(path.join(cwd, 'docs/00-brief.md'), '\n');
  const third = await run(check, ['--write']);
  assert.ok(third.out.includes('Wrote: docs/intake-manifest.json'));
});

test('check uses the language of the pack, --lang overrides the console language only', async (t) => {
  const { cwd, run } = setup(t, 'pack-broken');
  assert.ok((await run(check, [])).out.includes('Mappe:'));
  const english = await run(check, ['--lang', 'en', '--write']);
  assert.ok(english.out.startsWith('Not ready: must-answer questions still open'));
  assert.ok(fs.readFileSync(path.join(cwd, 'docs/07-risks-and-open-questions.md'), 'utf8').includes('# Risici og åbne spørgsmål'), 'files stay in the language of the pack');
});

test('check --depth changes the report and an unknown depth is a usage error', async (t) => {
  const { run } = setup(t, 'pack-en-partial');
  assert.equal(JSON.parse((await run(check, ['--json', '--depth', 'essentials'])).out).depth, 'essentials');
  assert.equal(JSON.parse((await run(check, ['--json'])).out).depth, 'standard');
  const bad = await run(check, ['--depth', 'huge']);
  assert.equal(bad.code, 2);
  assert.ok(bad.err.includes('Unknown depth "huge"'));
});

test('check reports usage errors in the console language with exit 2', async (t) => {
  const { run } = setup(t, 'pack-broken');
  const unknown = await run(check, ['--nope'], { env: { LANG: 'da_DK.UTF-8' } });
  assert.deepEqual([unknown.code, unknown.out, unknown.err], [2, '', 'Ukendt valgmulighed --nope.\n']);
  assert.equal((await run(check, ['--nope'])).err, 'Unknown option --nope.\n', 'English when nothing says otherwise');
  assert.equal((await run(check, ['--root'])).code, 2);
  assert.equal((await run(check, ['stray'])).code, 2);
  const language = await run(check, ['--lang', 'fr'], { env: { LANG: 'da_DK.UTF-8' } });
  assert.deepEqual([language.code, language.err], [2, 'Ukendt sprog "fr". Brug da eller en.\n']);
});

test('check on a folder without a pack exits 3, in the language of the environment', async (t) => {
  const { run } = setup(t);
  const danish = await run(check, [], { env: { LANG: 'da_DK.UTF-8' } });
  assert.equal(danish.code, 3);
  assert.ok(danish.err.startsWith('Der er ingen intake-pakke i '));
  const english = await run(check, [], { env: { LC_ALL: 'en_US.UTF-8', LANG: 'da_DK.UTF-8' } });
  assert.ok(english.err.startsWith('No intake pack found in '));
});

test('check exits 3 for a damaged pack and says which file', async (t) => {
  const { cwd, run } = setup(t, 'pack-en-partial');
  writeText(cwd, 'docs/intake-state.json', '{ broken');
  const result = await run(check, []);
  assert.equal(result.code, 3);
  assert.equal(result.err, 'docs/intake-state.json is not valid JSON.\n');
  writeText(cwd, 'docs/intake-state.json', JSON.stringify({ schema: 'everything-mapped-for-clients/7' }));
  assert.ok((await run(check, [])).err.includes('format version that is not supported (everything-mapped-for-clients/7)'));
});

test('--root is resolved against the working directory', async (t) => {
  const { cwd, run } = setup(t);
  copyFolder(path.join(FIXTURES, 'pack-en-partial'), path.join(cwd, 'nested', 'pack'));
  const result = await run(check, ['--root', path.join('nested', 'pack'), '--json']);
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.out).language, 'en');
});

test('the real texts never show the word gate to a client, in either language', async (t) => {
  const cwd = makeTempDir(t);
  copyFolder(path.join(FIXTURES, 'pack-broken'), cwd);
  for (const lang of ['da', 'en']) {
    const result = await runScript(check, ['--lang', lang], { cwd });
    assert.equal(result.code, 0);
    assert.ok(!/\bgate\b/i.test(result.out), `${lang}: ${result.out}`);
    noOpenKeys(result.out);
  }
});

// ---- next ------------------------------------------------------------------------------------

test('next works on an empty folder: everything is missing and the first questions are in module A', async (t) => {
  const { run } = setup(t);
  const result = await run(next, ['--count', '3', '--lang', 'da']);
  assert.equal(result.code, 0);
  const data = JSON.parse(result.out);
  assert.deepEqual(Object.keys(data), ['language', 'depth', 'module', 'done', 'remaining', 'questions']);
  assert.equal(data.language, 'da');
  assert.equal(data.depth, 'standard');
  assert.equal(data.module, 'A');
  assert.equal(data.done, false);
  assert.deepEqual(data.remaining, { gate1: 36, recommended: 39, optional: 0 });
  assert.deepEqual(data.questions.map((question) => question.id), ['A.business', 'A.project-kind', 'A.why-now']);
});

test('next describes each question: texts from the dictionary, choices with labels, rules', async (t) => {
  const { run } = setup(t);
  const data = JSON.parse((await run(next, ['--count', '4', '--lang', 'da'])).out);
  const business = data.questions.find((question) => question.id === 'A.business');
  assert.deepEqual(Object.keys(business), ['id', 'type', 'level', 'area', 'design', 'label', 'ask', 'help', 'example', 'choices', 'rules']);
  assert.equal(business.type, 'longtext');
  assert.equal(business.level, 'gate1');
  assert.equal(business.area, 'business');
  assert.equal(business.design, false);
  assert.equal(business.label, 'Virksomheden kort fortalt');
  assert.equal(business.ask, '', 'no ask text in the test dictionary');
  assert.deepEqual(business.choices, []);
  assert.deepEqual(business.rules, { minChars: 60 });
  const kind = data.questions.find((question) => question.id === 'A.project-kind');
  assert.deepEqual(kind.choices[1], { id: 'redesign', label: 'Redesign' });
  assert.deepEqual(kind.choices[0], { id: 'new-site', label: 'new-site' }, 'a missing text falls back to the id');
  const goal = JSON.parse((await run(next, ['--count', '1', '--module', 'A', '--depth', 'essentials'], { env: {} })).out);
  assert.equal(goal.questions[0].id, 'A.business');
});

test('next marks design inputs and honours --module, --count and --depth', async (t) => {
  const { run } = setup(t);
  const essentials = JSON.parse((await run(next, ['--depth', 'essentials', '--count', '100'])).out);
  assert.ok(essentials.questions.every((question) => question.level === 'gate1'));
  assert.deepEqual(essentials.remaining, { gate1: 36, recommended: 0, optional: 0 });
  const module = JSON.parse((await run(next, ['--module', 'e', '--depth', 'full', '--count', '100'])).out);
  assert.equal(module.module, 'E');
  assert.ok(module.questions.every((question) => question.id.startsWith('E.')));
  assert.equal(module.questions.length, 9);
  assert.ok(module.questions.filter((question) => question.design).length >= 5);
  assert.equal(JSON.parse((await run(next, ['--count', '2'])).out).questions.length, 2);
});

test('next returns only missing questions; partial, deferred and answered ones are left out', async (t) => {
  const { run } = setup(t, 'pack-en-partial');
  const ids = new Set();
  let gate1 = 0;
  for (const module of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']) {
    const data = JSON.parse((await run(next, ['--count', '100', '--module', module])).out);
    for (const question of data.questions) {
      ids.add(question.id);
      if (question.level === 'gate1') gate1 += 1;
    }
  }
  for (const left of ['A.business', 'A.why-now', 'A.stakeholders', 'B.purpose', 'E.like', 'I.domain', 'I.hosting']) {
    assert.ok(!ids.has(left), left);
  }
  assert.ok(ids.has('A.budget') && ids.has('G.multilingual') && ids.has('B.logo'));
  const first = JSON.parse((await run(next, ['--count', '100'])).out);
  assert.equal(first.language, 'en');
  assert.equal(first.remaining.gate1, gate1);
});

test('next never crosses a module boundary: the round holds one module and module names it', async (t) => {
  const { run } = setup(t);
  const first = JSON.parse((await run(next, ['--count', '100'])).out);
  assert.equal(first.module, 'A');
  assert.ok(first.questions.length > 1 && first.questions.every((question) => question.id.startsWith('A.')));
  const essentials = JSON.parse((await run(next, ['--count', '100', '--depth', 'essentials'])).out);
  assert.ok(essentials.questions.every((question) => question.id.startsWith('A.')));
  const sixth = await run(next, ['--count', '3', '--module', 'F']);
  assert.ok(JSON.parse(sixth.out).questions.every((question) => question.id.startsWith('F.')));
});

test('next returns exactly the focus ids from the state, in focus order, whatever their status', async (t) => {
  const { cwd, run } = setup(t, 'pack-en-partial');
  const statePath = path.join(cwd, 'docs/intake-state.json');
  const state = readJson(statePath);
  fs.writeFileSync(statePath, JSON.stringify({ ...state, focus: ['I.domain', 'A.business', 'A.goal'] }));
  const data = JSON.parse((await run(next, ['--depth', 'essentials'])).out);
  assert.deepEqual(data.questions.map((question) => question.id), ['I.domain', 'A.business', 'A.goal']);
  assert.equal(data.done, false);
  assert.equal(data.module, 'I');
});

test('next says it is done when nothing is missing', async (t) => {
  const { run } = setup(t, 'pack-da-complete');
  const data = JSON.parse((await run(next, [])).out);
  assert.equal(data.done, true);
  assert.deepEqual(data.questions, []);
  assert.deepEqual(data.remaining, { gate1: 0, recommended: 0, optional: 0 });
  assert.equal(data.language, 'da');
  assert.equal(data.depth, 'full');
  assert.equal(data.module, null);
});

test('next refuses bad options with exit 2', async (t) => {
  const { run } = setup(t);
  for (const argv of [['--count', '0'], ['--count', 'many'], ['--count', '2.5'], ['--module', 'Z'], ['--depth', 'deep'], ['--unknown']]) {
    const result = await run(next, argv, { env: { LANG: 'en_GB.UTF-8' } });
    assert.equal(result.code, 2, argv.join(' '));
    assert.equal(result.out, '');
    assert.notEqual(result.err, '');
  }
  assert.equal((await run(next, ['--count', '0'])).err, '--count must be a whole number of at least 1 (got "0").\n');
});

// ---- answer ----------------------------------------------------------------------------------

function writeInput(cwd, input, name = 'answers.json') {
  const file = path.join(cwd, name);
  fs.writeFileSync(file, JSON.stringify(input));
  return file;
}

test('answer creates the pack on first use, prints the summary and keeps the input unless --delete', async (t) => {
  const { cwd, run } = setup(t);
  const file = writeInput(cwd, readJson(DA_INPUT));
  const result = await run(answer, ['--root', 'pack', '--from', 'answers.json']);
  assert.equal(result.code, 0, result.err);
  const summary = JSON.parse(result.out);
  assert.deepEqual(Object.keys(summary), ['written', 'gate1', 'overall', 'next']);
  assert.equal(summary.gate1.ready, true);
  assert.equal(summary.overall, 1);
  assert.deepEqual(summary.next, []);
  assert.ok(summary.written.includes('docs/00-brief.md') && summary.written.includes('docs/intake-manifest.json'));
  assert.ok(fs.existsSync(file), 'the input file is kept without --delete');
  assert.ok(fs.statSync(path.join(cwd, 'pack/docs/assets')).isDirectory());
});

test('answer creates the empty docs/assets folder when it creates the pack', async (t) => {
  const { cwd, run } = setup(t);
  writeInput(cwd, { language: 'en', answers: [] });
  assert.equal((await run(answer, ['--from', 'answers.json'])).code, 0);
  const folder = path.join(cwd, 'docs', 'assets');
  assert.ok(fs.statSync(folder).isDirectory());
  assert.deepEqual(fs.readdirSync(folder), []);
});

test('answer --delete removes the input file after a successful write only', async (t) => {
  const { cwd, run } = setup(t);
  const file = writeInput(cwd, { language: 'da', answers: [{ id: 'B.name', status: 'complete', text: 'Nordlys' }] });
  assert.equal((await run(answer, ['--from', 'answers.json', '--delete'])).code, 0);
  assert.equal(fs.existsSync(file), false);
  const bad = writeInput(cwd, { answers: [{ id: 'Z.nope', status: 'complete', text: 'x' }] }, 'bad.json');
  const result = await run(answer, ['--from', 'bad.json', '--delete']);
  assert.equal(result.code, 2);
  assert.ok(fs.existsSync(bad), 'a refused input file is kept');
});

test('answer prints the first three questions still to ask', async (t) => {
  const { cwd, run } = setup(t);
  writeInput(cwd, { language: 'da', depth: 'essentials', answers: [{ id: 'A.business', status: 'complete', text: 'x'.repeat(70) }] });
  const summary = JSON.parse((await run(answer, ['--from', 'answers.json'])).out);
  assert.deepEqual(summary.next, ['A.project-kind', 'A.why-now', 'A.goal']);
  assert.equal(summary.gate1.ready, false);
  assert.ok(summary.gate1.blocking.includes('A.project-kind'));
});

test('answer --lang gives the language of a new pack when the input has none', async (t) => {
  const { cwd, run } = setup(t);
  writeInput(cwd, { answers: [] });
  assert.equal((await run(answer, ['--from', 'answers.json', '--lang', 'en'])).code, 0);
  assert.equal(readJson(path.join(cwd, 'docs/intake-state.json')).language, 'en');
});

test('answer stores recipient and notes in the state and appends respondents', async (t) => {
  const { cwd, run } = setup(t);
  writeInput(cwd, { language: 'da', recipient: 'Jonas Berg', notes: 'Husk telefon', respondent: { name: 'Anna Jensen', role: 'Marketing' }, answers: [{ id: 'B.name', status: 'complete', text: 'Nordlys' }] });
  await run(answer, ['--from', 'answers.json']);
  writeInput(cwd, { respondent: { name: 'Peter Holm', role: 'IT' }, answers: [{ id: 'B.fonts', status: 'complete', text: 'Fira' }] });
  await run(answer, ['--from', 'answers.json']);
  const state = readJson(path.join(cwd, 'docs/intake-state.json'));
  assert.equal(state.recipient, 'Jonas Berg');
  assert.equal(state.notes, 'Husk telefon');
  const brand = fs.readFileSync(path.join(cwd, 'docs/01-brand/brand.md'), 'utf8');
  assert.ok(brand.includes('respondent: "Anna Jensen, Marketing; Peter Holm, IT"'));
  const manifest = readJson(path.join(cwd, 'docs/intake-manifest.json'));
  assert.deepEqual(manifest.respondents.map((person) => person.name), ['Anna Jensen', 'Peter Holm']);
});

test('answer refuses bad input with exit 2, explains in the console language and writes nothing', async (t) => {
  const { cwd, run } = setup(t);
  writeInput(cwd, { language: 'da', answers: [
    { id: 'Z.nope', status: 'complete', text: 'x' },
    { id: 'A.deadline', status: 'complete', date: 'imorgen' },
  ] });
  const result = await run(answer, ['--from', 'answers.json', '--lang', 'da']);
  assert.equal(result.code, 2);
  assert.equal(result.out, '');
  assert.equal(result.err, 'Ukendt spørgsmåls-id: Z.nope.\nA.deadline: "imorgen" er ikke en gyldig dato (ÅÅÅÅ-MM-DD).\n');
  assert.deepEqual(fs.readdirSync(cwd), ['answers.json']);
});

test('answer refuses a missing, unreadable or invalid input file with exit 2', async (t) => {
  const { cwd, run } = setup(t);
  assert.equal((await run(answer, [], { env: { LANG: 'en_GB.UTF-8' } })).err, 'Name the answer file with --from <file.json>.\n');
  assert.equal((await run(answer, ['--from', 'missing.json'])).code, 2);
  fs.writeFileSync(path.join(cwd, 'broken.json'), '{ nope');
  const broken = await run(answer, ['--from', 'broken.json']);
  assert.equal(broken.code, 2);
  assert.ok(broken.err.includes('is not valid JSON'));
  assert.deepEqual(fs.readdirSync(cwd), ['broken.json']);
});

test('answer exits 3 when the existing pack cannot be read', async (t) => {
  const { cwd, run } = setup(t, 'pack-en-partial');
  writeText(cwd, 'docs/intake-state.json', 'not json');
  writeInput(cwd, { answers: [] });
  const result = await run(answer, ['--from', 'answers.json']);
  assert.equal(result.code, 3);
  assert.equal(result.out, '');
});

test('answer merges into an existing pack and the check agrees with the summary', async (t) => {
  const { cwd, run } = setup(t, 'pack-en-partial');
  writeInput(cwd, { answers: [{ id: 'B.purpose', status: 'complete', text: 'We exist to make sure nobody has to skip a good breakfast again.' }] });
  const summary = JSON.parse((await run(answer, ['--from', 'answers.json'])).out);
  const report = JSON.parse((await run(check, ['--json'])).out);
  assert.equal(report.questions['B.purpose'].status, 'complete');
  assert.deepEqual(summary.gate1, report.gate1);
  assert.equal(summary.overall, report.completeness.overall);
});

// ---- assets ----------------------------------------------------------------------------------

test('assets --scan --json lists what is missing from the table, in the form --add accepts', async (t) => {
  const { run } = setup(t, 'pack-broken');
  const result = await run(assets, ['--scan', '--json']);
  assert.equal(result.code, 0);
  const data = JSON.parse(result.out);
  assert.deepEqual(data.unlisted, ['assets/photo.txt']);
  const hiddenName = `assets/skjult${String.fromCharCode(0x202e)}navn.png`;
  assert.deepEqual(data.missingFile, ['assets/ghost.svg', hiddenName]);
  assert.deepEqual(data.badName, ['assets/skjult<U+202E>navn.png'], 'a name with a hidden character is shown with a marker');
  assert.deepEqual(data.noRights, ['assets/notes.txt']);
  assert.equal(data.rows.length, 4);
});

test('assets without options scans and prints readable lines', async (t) => {
  const { run } = setup(t, 'pack-broken');
  const result = await run(assets, []);
  assert.equal(result.code, 0);
  assert.ok(result.out.includes('Filer i mappen, som mangler på listen:\n  - assets/photo.txt\n'));
  assert.ok(result.out.includes('Rækker på listen uden en fil i mappen:\n  - assets/ghost.svg\n'));
  assert.ok(result.out.includes('Rækker uden udfyldte rettigheder:\n  - assets/notes.txt\n'));
  const clean = setup(t, 'pack-da-complete');
  assert.ok((await clean.run(assets, ['--scan'])).out.includes('Alle filer står på listen'));
});

test('assets on a folder without any pack or files says the folder is empty', async (t) => {
  const { run } = setup(t);
  const result = await run(assets, ['--scan'], { env: { LANG: 'en_GB.UTF-8' } });
  assert.equal(result.code, 0);
  assert.equal(result.out, 'The assets folder is empty and so is the file list.\n');
});

test('assets --add appends a row, updates it later and refreshes the manifest', async (t) => {
  const { cwd, run } = setup(t, 'pack-broken');
  const add = await run(assets, ['--add', 'photo.txt', '--what', 'Et foto', '--owner', 'Kunden', '--rights', 'Ejes af kunden', '--restrictions', 'Ingen', '--json']);
  assert.equal(add.code, 0, add.err);
  const data = JSON.parse(add.out);
  assert.deepEqual(data.added, ['assets/photo.txt']);
  assert.deepEqual(data.unlisted, []);
  const table = fs.readFileSync(path.join(cwd, 'docs/assets.md'), 'utf8');
  assert.ok(table.includes('| assets/photo.txt | Et foto | Kunden | Ejes af kunden | Ingen |'));
  assert.ok(table.startsWith('# Filer til projektet'));
  const update = JSON.parse((await run(assets, ['--add', 'assets/photo.txt', '--rights', 'Licens', '--json'])).out);
  assert.deepEqual(update.updated, ['assets/photo.txt']);
  const row = update.rows.find((entry) => entry.file === 'assets/photo.txt');
  assert.deepEqual([row.what, row.rights], ['Et foto', 'Licens']);
  assert.equal(update.rows.length, 5);
  const windows = JSON.parse((await run(assets, ['--add', 'docs\\assets\\notes.txt', '--rights', 'Ukendt', '--json'])).out);
  assert.deepEqual(windows.noRights, []);
  const manifest = readJson(path.join(cwd, 'docs/intake-manifest.json'));
  assert.ok(manifest.files.some((entry) => entry.path === 'docs/assets.md'));
});

test('assets --add refuses files that are not in docs/assets and details without --add', async (t) => {
  const { cwd, run } = setup(t, 'pack-broken');
  const before = fs.readFileSync(path.join(cwd, 'docs/assets.md'), 'utf8');
  const missing = await run(assets, ['--lang', 'en', '--add', 'nothing.png']);
  assert.deepEqual([missing.code, missing.err], [2, 'nothing.png is not in the folder docs/assets.\n']);
  assert.equal((await run(assets, ['--lang', 'en', '--add', '../secret.txt'])).err, '../secret.txt is not a valid file name in docs/assets.\n');
  assert.equal((await run(assets, ['--lang', 'en', '--what', 'x'])).err, '--what, --owner, --rights and --restrictions are used together with --add.\n');
  assert.equal((await run(assets, ['--lang', 'en', '--delete'])).err, '--delete is used together with --from.\n');
  assert.equal((await run(assets, ['--add'])).code, 2);
  assert.equal(fs.readFileSync(path.join(cwd, 'docs/assets.md'), 'utf8'), before);
});

test('assets --from adds the rows of a JSON file and --delete removes that file', async (t) => {
  const { cwd, run } = setup(t, 'pack-broken');
  const rows = { rows: [
    { file: 'assets/photo.txt', what: 'Et foto', owner: 'Kunden', rights: 'Ejes af kunden', restrictions: 'Ingen' },
    { file: 'notes.txt', rights: 'Licens' },
  ] };
  const file = path.join(cwd, 'rows.json');
  fs.writeFileSync(file, JSON.stringify(rows));
  const result = await run(assets, ['--from', 'rows.json', '--delete', '--json']);
  assert.equal(result.code, 0, result.err);
  const data = JSON.parse(result.out);
  assert.deepEqual(data.added, ['assets/photo.txt']);
  assert.deepEqual(data.updated, ['assets/notes.txt']);
  assert.deepEqual(data.unlisted, []);
  assert.deepEqual(data.noRights, []);
  assert.equal(fs.existsSync(file), false);
  fs.writeFileSync(file, JSON.stringify(rows));
  assert.equal((await run(assets, ['--from', 'rows.json'])).code, 0);
  assert.ok(fs.existsSync(file), 'the file stays without --delete');
});

test('assets --from refuses bad rows and keeps the table and the file', async (t) => {
  const { cwd, run } = setup(t, 'pack-broken');
  const before = fs.readFileSync(path.join(cwd, 'docs/assets.md'), 'utf8');
  const file = path.join(cwd, 'rows.json');
  for (const content of [
    { rows: [{ file: 'photo.txt' }, { file: 'nothing.png' }] },
    { rows: [{ file: 'photo.txt', colour: 'red' }] },
    { rows: [{ what: 'no file' }] },
    { rows: [{ file: 'photo.txt', rights: 5 }] },
    { rows: 'not a list' },
    { other: [] },
  ]) {
    fs.writeFileSync(file, JSON.stringify(content));
    const result = await run(assets, ['--from', 'rows.json', '--delete']);
    assert.equal(result.code, 2, JSON.stringify(content));
    assert.ok(fs.existsSync(file));
    assert.equal(fs.readFileSync(path.join(cwd, 'docs/assets.md'), 'utf8'), before);
  }
  fs.writeFileSync(file, '{ nope');
  assert.equal((await run(assets, ['--from', 'rows.json'])).code, 2);
  assert.equal((await run(assets, ['--from', 'absent.json'])).code, 2);
});

test('assets --from with an empty list still removes the file with --delete', async (t) => {
  const { cwd, run } = setup(t, 'pack-broken');
  const file = path.join(cwd, 'rows.json');
  fs.writeFileSync(file, JSON.stringify({ rows: [] }));
  assert.equal((await run(assets, ['--from', 'rows.json', '--delete'])).code, 0);
  assert.equal(fs.existsSync(file), false);
});

// ---- running as a script -----------------------------------------------------------------------

test('isMainModule is true only for the file node was started with', () => {
  const thisFile = fileURLToPath(import.meta.url);
  const original = process.argv[1];
  try {
    process.argv[1] = thisFile;
    assert.equal(isMainModule(import.meta.url), true);
    process.argv[1] = path.join(path.dirname(thisFile), 'helpers.mjs');
    assert.equal(isMainModule(import.meta.url), false);
    process.argv[1] = path.join(path.dirname(thisFile), 'does-not-exist.mjs');
    assert.equal(isMainModule(import.meta.url), false);
    process.argv[1] = '';
    assert.equal(isMainModule(import.meta.url), false);
  } finally {
    process.argv[1] = original;
  }
});

test('importing a script does not run it and every script exports an async main', () => {
  for (const main of [answer, assets, check, next]) {
    assert.equal(typeof main, 'function');
    assert.equal(main.constructor.name, 'AsyncFunction');
  }
});
