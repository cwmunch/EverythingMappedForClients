// Names of files and characters in text: the form refuses exactly what the library refuses (the zip
// writer's name check, the list of files, the reader of a pack and the rule for hidden characters),
// keeps everything else, and says when it took something out.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parsePack, validatePack } from '../../skill/everything-mapped/scripts/lib/index.mjs';
import { main as packMain } from '../../skill/everything-mapped/scripts/pack.mjs';
import { checkName } from '../../skill/everything-mapped/scripts/lib/zip.mjs';
import { HIDDEN_CHARACTER_RANGES, hasHiddenCharacters, isPackFile, isStorableAssetName } from '../../skill/everything-mapped/scripts/lib/util.mjs';
import { NOW, TODAY, interviewerTree, makeTempDir, newSampleState, plain, schema, textOfEntry, unzipPack } from './helpers.mjs';
import { engine, library, openForm, part, text, typeInto, inputsOf, until } from './page-helpers.mjs';
import { fakeFile, findAll, textOf } from './fake-dom.mjs';

const DIRECTORY = 'docs/assets';

function zipRefuses(name) {
  try {
    checkName(name);
    return false;
  } catch {
    return true;
  }
}

// Every code point of the first plane and the ones in the other planes where something happens (tag
// characters, symbols, emoji), and one in 61 of the rest.
function everyCodePoint(visit) {
  for (let code = 0; code <= 0x10ffff; code += 1) {
    if (code >= 0xd800 && code <= 0xdfff) continue;
    const dense = code <= 0xffff || (code >= 0xe0000 && code <= 0xe01ff) || (code >= 0x1f000 && code <= 0x1faff);
    if (dense || code % 61 === 0) visit(code, String.fromCodePoint(code));
  }
}

// ---------------------------------------------------------------------------------------------
// L3: the form's name check is the library's

const TRICKY_PATHS = [
  'docs/assets/ok.txt', 'docs/assets/notes..txt', 'docs/assets/a.b.c', 'docs/assets/a b', 'docs/assets/ leading', 'docs/assets/.hidden',
  'docs/assets/a.', 'docs/assets/a ', 'docs/assets/a. .', 'docs/assets/dots...', 'docs/assets/.', 'docs/assets/..', 'docs/./x', 'docs/../x', 'docs//x', 'docs/', '/abs', 'C:/x', 'c:x',
  'docs/assets/CON', 'docs/assets/con.txt', 'docs/assets/Nul.tar.gz', 'docs/assets/AUX', 'docs/assets/prn.', 'docs/assets/COM1', 'docs/assets/COM9.txt', 'docs/assets/LPT1',
  'docs/assets/COM\u00b9.txt', 'docs/assets/lpt\u00b2', 'docs/assets/LPT\u00b3.png', 'docs/assets/COM0', 'docs/assets/LPT0.txt', 'docs/assets/CLOCK$',
  'docs/assets/conin$', 'docs/assets/CONOUT$.log', 'docs/assets/LPT9 .txt', 'docs/assets/con .txt', 'docs/assets/conin$', 'docs/assets/con\u0131n$', 'docs/assets/console.txt', 'docs/assets/nul-1.txt',
  'docs/assets/a:b', 'docs/assets/a<b', 'docs/assets/a>b', 'docs/assets/a"b', 'docs/assets/a|b', 'docs/assets/a?b', 'docs/assets/a*b', 'docs/assets/a\\b', 'docs/assets/a#b%c',
  'docs/assets/a\u0000b', 'docs/assets/a\tb', 'docs/assets/a\nb', 'docs/assets/a\u007fb', 'docs/assets/a\u0085b', 'docs/assets/a\u009fb', 'docs/assets/a\u00a0b', 'docs/assets/a\u00adb',
  'docs/assets/a\u200bb', 'docs/assets/a\u200cb', 'docs/assets/a\u200db', 'docs/assets/a\u200eb', 'docs/assets/a\u200fb', 'docs/assets/a\u2028b', 'docs/assets/a\u2029b', 'docs/assets/a\u202ab', 'docs/assets/a\u202eb', 'docs/assets/a\u202fb',
  'docs/assets/a\u2060b', 'docs/assets/a\u2064b', 'docs/assets/a\u2066b', 'docs/assets/a\u2069b', 'docs/assets/a\ufeffb', 'docs/assets/a\ufff9b', `docs/assets/a${String.fromCodePoint(0xe0041)}b`, 'docs/assets/a\u061cb', 'docs/assets/a\u180eb',
  'docs/assets/a\ud800b', 'docs/assets/a\udc00', 'docs/assets/\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67.png', 'docs/assets/Familiefoto \ud83d\udc68 og Ka\u00adtalog.pdf', 'docs/assets/\u00c6\u00f8\u00e5 \u65e5\u672c.png',
  `docs/assets/${'x'.repeat(255)}`, `docs/assets/${'x'.repeat(256)}`, `docs/assets/${'\u00e9'.repeat(127)}`, `docs/assets/${'\u00e9'.repeat(128)}`, `docs/assets/${'\u65e5'.repeat(85)}`, `docs/assets/${'\u65e5'.repeat(86)}`,
  `docs/assets/${'x'.repeat(228)}`, `docs/assets/${'x'.repeat(229)}`, `a/${'x'.repeat(238)}`, `a/${'x'.repeat(239)}`, `a/${'\ud83d\ude00'.repeat(119)}b`, `a/${'\ud83d\ude00'.repeat(120)}b`,
];

test('the form refuses the names the zip writer refuses, and no others (a table of tricky names)', () => {
  assert.ok(TRICKY_PATHS.length > 90);
  for (const name of TRICKY_PATHS) {
    assert.equal(library.zipNameProblem(name) !== '', zipRefuses(name), JSON.stringify(name));
  }
});

test('the characters a name may not hold are the zip writer\'s, code point by code point', () => {
  everyCodePoint((code, char) => {
    const name = `docs/a${char}b`;
    assert.equal(library.zipNameProblem(name) !== '', zipRefuses(name), `U+${code.toString(16)}`);
  });
  for (const lone of [0xd800, 0xdbff, 0xdc00, 0xdfff]) {
    const name = `docs/a${String.fromCharCode(lone)}b`;
    assert.equal(library.zipNameProblem(name) !== '', zipRefuses(name), `lone ${lone.toString(16)}`);
    assert.equal(zipRefuses(name), true);
  }
});

test('the form refuses a file name when the zip writer, the list of files or the reader of a pack would', () => {
  const names = TRICKY_PATHS.map((full) => full.slice(full.indexOf('/') + 1)).filter((name) => name !== '' && !name.includes('/'));
  const refused = (name) => zipRefuses(`${DIRECTORY}/${name}`) || !isStorableAssetName(name) || !isPackFile(`${DIRECTORY}/${name}`);
  for (const name of names) assert.equal(library.assetNameProblem(name, DIRECTORY) !== '', refused(name), JSON.stringify(name));
  everyCodePoint((code, char) => {
    const name = `a${char}b`;
    assert.equal(library.assetNameProblem(name, DIRECTORY) !== '', refused(name), `U+${code.toString(16)}`);
  });
});

test('every code point the library hides is a code point a file name may not hold', () => {
  for (const [first, last] of HIDDEN_CHARACTER_RANGES) {
    for (const code of [first, last]) assert.equal(library.isForbiddenNameCode(code), true, `U+${code.toString(16)}`);
  }
  for (const code of [0x200c, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029, 0x09, 0x0a, 0x0d, 0xd800]) {
    assert.equal(library.isForbiddenNameCode(code), true, `U+${code.toString(16)}`);
  }
  for (const char of ['a', ' ', '-', '\u00e9', '\u65e5', '\ud83d\ude00', '\u00a0', '\u00ad', '\u202f']) {
    assert.equal(library.isForbiddenNameCode(char.codePointAt(0)), false, JSON.stringify(char));
  }
});

// A small generator with a fixed seed, so a failure can be run again.
function generator(seed) {
  let value = seed;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

const PIECES = [
  '.', '..', '...', ' ', '  ', '-', '_', '/', '\\', ':', '<', '>', '"', '|', '?', '*', '#', '%', 'a', 'B', 'x', '0', '9', 'con', 'NUL', 'Aux', 'com1', 'LPT3', 'conin$', 'prn', '.tmp', '.TMP', '.png', '.pdf-annotated',
  '\u00e9', 'e\u0301', '\u00c9', '\u65e5\u672c', '\ud83d\ude00', '\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67', '\u200b', '\u200c', '\u200d', '\u200e', '\u200f', '\u202e', '\u2028', '\ufeff', '\u00ad', '\u00a0', '\u202f',
  '\u0000', '\t', '\n', '\u0085', '\ud800', '\udc00', String.fromCodePoint(0xe0041), '\ufff9', '\u00b9', '\u0131', 'x'.repeat(40), '\u65e5'.repeat(30),
];

function fuzzName(random) {
  const count = 1 + Math.floor(random() * 9);
  return Array.from({ length: count }, () => PIECES[Math.floor(random() * PIECES.length)]).join('');
}

function assertWhole(name, raw) {
  const where = `${JSON.stringify(raw)} -> ${JSON.stringify(name)}`;
  assert.equal(library.assetNameProblem(name, DIRECTORY), '', where);
  assert.equal(zipRefuses(`${DIRECTORY}/${name}`), false, where);
  assert.equal(isStorableAssetName(name), true, where);
  assert.equal(isPackFile(`${DIRECTORY}/${name}`), true, where);
  assert.ok(Array.from(name).length <= 101, where);
  assert.ok(library.encodeUtf8(name).length <= 201, where);
  // (101 and 201: a device name gets a "_" in front after the name was cut.)
  assert.ok(!/[. ]$/.test(name), where);
  assert.ok(name.isWellFormed(), where);
}

test('whatever name a person gives, the name that results passes all of it and ends in neither a dot nor a space', () => {
  const raws = TRICKY_PATHS.map((full) => full.slice(full.lastIndexOf('/') + 1));
  const random = generator(20261023);
  for (let index = 0; index < 4000; index += 1) raws.push(fuzzName(random));
  everyCodePoint((code, char) => {
    if (code % 7 === 0 || code < 0x3000 || code >= 0xe0000) raws.push(`a${char}b`, `${char}`, `x.${char}`);
  });
  const taken = new Set();
  for (const raw of raws) {
    const name = library.safeAssetName(raw, new Set(), DIRECTORY);
    assertWhole(name, raw);
    const shared = library.safeAssetName(raw, taken, DIRECTORY);
    assertWhole(shared, raw);
    assert.ok(!taken.has(library.foldName(shared)), `${JSON.stringify(raw)} is unique among the others`);
    taken.add(library.foldName(shared));
  }
  assert.equal(taken.size, raws.length, 'no two names are the same, ignoring case and the way an accent is written');
});

test('the name in the report: cut by the length limit on a dot, it does not end in a dot', async (t) => {
  const raw = `${'Scanning af kontrakt '.repeat(5).slice(0, 77)} ... den 3. okt. 2026.pdf-annotated`;
  const stem = `${'x'.repeat(97)} 3. okt. 2026.pdf-annotated`;
  for (const given of [raw, stem]) {
    const name = library.safeAssetName(given, new Set(), DIRECTORY);
    assertWhole(name, given);
  }
  // The very case: the hundredth character is the dot after "3".
  const cut = library.safeAssetName(stem, new Set(), DIRECTORY);
  assert.ok(Array.from(cut).length <= 100);
  assert.ok(!cut.endsWith('.'));
  assert.ok(cut.endsWith('3'), cut);

  // And the pack the form makes with it is accepted by the team's pack script.
  const state = newSampleState(engine, 'da');
  const asset = engine.addAsset(state, 'B.logo', { name: stem, data: new Uint8Array([1, 2, 3]) });
  asset.rights = 'Ejes af os';
  assert.equal(asset.name, cut);
  await assertPackAccepted(t, state);
});

test('a name numbered to stay unique, and two names that are one on Windows or macOS, stay valid and different', () => {
  const taken = new Set();
  const first = library.safeAssetName('Rapport.pdf', taken, DIRECTORY);
  taken.add(library.foldName(first));
  const second = library.safeAssetName('RAPPORT.PDF', taken, DIRECTORY);
  taken.add(library.foldName(second));
  const accent = library.safeAssetName('Caf\u00e9.txt', taken, DIRECTORY);
  taken.add(library.foldName(accent));
  const decomposed = library.safeAssetName('Cafe\u0301.TXT', taken, DIRECTORY);
  assert.deepEqual([first, second, accent, decomposed], ['Rapport.pdf', 'RAPPORT-2.PDF', 'Caf\u00e9.txt', 'Caf\u00e9-2.TXT']);
  const long = `${'y'.repeat(150)}.pdf`;
  const cut = new Set();
  const names = [];
  for (let index = 0; index < 5; index += 1) {
    const name = library.safeAssetName(long, cut, DIRECTORY);
    cut.add(library.foldName(name));
    names.push(name);
    assertWhole(name, long);
  }
  assert.equal(new Set(names).size, 5);
});

test('names like notes..txt stay as they are, and device names get a prefix', () => {
  assert.equal(library.safeAssetName('notes..txt', new Set(), DIRECTORY), 'notes..txt');
  assert.equal(library.safeAssetName('a...b', new Set(), DIRECTORY), 'a...b');
  assert.equal(library.safeAssetName('nul.png', new Set(), DIRECTORY), '_nul.png');
  assert.equal(library.safeAssetName('COM\u00b9', new Set(), DIRECTORY), '_COM\u00b9');
  assert.equal(library.safeAssetName('con\u0131n$.txt', new Set(), DIRECTORY), '_con\u0131n$.txt', 'a dotless i is still the device name when upper-cased');
  assert.equal(library.safeAssetName('x.', new Set(), DIRECTORY), 'x');
  assert.equal(library.safeAssetName('x. . ', new Set(), DIRECTORY), 'x.-', 'spaces at the end are dropped; the dot that is left then goes too');
  assert.equal(library.safeAssetName('  report.pdf ', new Set(), DIRECTORY), 'report.pdf');
  assert.equal(library.safeAssetName('...', new Set(), DIRECTORY), 'file');
  assert.equal(library.safeAssetName('', new Set(), DIRECTORY), 'file');
});

test('the zip writer of the form refuses the same names as the team\'s', async () => {
  const sample = TRICKY_PATHS.filter((name) => name.length < 400);
  for (const name of sample) {
    const refused = zipRefuses(name);
    let formRefuses = false;
    try {
      await library.createZipBytes([{ name, data: 'x' }]);
    } catch (error) {
      formRefuses = /Invalid zip entry name/.test(error.message);
    }
    assert.equal(formRefuses, refused, JSON.stringify(name));
  }
});

test('a name the page cannot put in a pack is refused with the message about the name, not a crash', async () => {
  const state = newSampleState(engine, 'da');
  const asset = engine.addAsset(state, 'B.logo', { name: 'ok.png', data: new Uint8Array([1]) });
  asset.rights = 'Ejes af os';
  asset.name = 'bad.';
  await assert.rejects(() => engine.buildPack(state, { now: NOW, today: TODAY }), (error) => error.key === 'ui.form.err.fileName');
  asset.name = 'a\u200db.png';
  await assert.rejects(() => engine.buildPack(state, { now: NOW, today: TODAY }), (error) => error.key === 'ui.form.err.fileName');
});

test('loaded file names are made whole the same way, and two that are one stay two', () => {
  const raw = { ...engine.serializeState(engine.newState({ language: 'en', now: NOW }), { files: false }) };
  const record = (name) => ({ id: 'a', qid: 'B.logo', name, renamedFrom: '', what: '', owner: '', rights: '', restrictions: '', size: 1 });
  raw.assets = [record('Report.'), record('REPORT'), record('rep\u200dort.pdf'), record('Re\u0301port.pdf'), record('Report.pdf')];
  const result = engine.restoreState(raw);
  assert.deepEqual(plain(result.state.assets.map((asset) => asset.name)), ['Report', 'REPORT-2', 'report.pdf', 'R\u00e9port.pdf', 'Report-2.pdf']);
  assert.equal(result.notes.cleaned, 5, 'every name was changed on the way in');
});

// ---------------------------------------------------------------------------------------------
// L7: text loses what the library refuses and nothing else

const KEPT = {
  ZWJ: '\u200d', ZWNJ: '\u200c', SHY: '\u00ad', LRM: '\u200e', RLM: '\u200f', NNBSP: '\u202f', NBSP: '\u00a0', 'variation selector': '\ufe0f', 'combining accent': 'e\u0301', 'emoji sequence': '\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67',
};

test('text keeps joiners, the soft hyphen, direction marks and no-break spaces', () => {
  for (const [what, value] of Object.entries(KEPT)) {
    const sample = `a${value}b`;
    assert.equal(library.cleanLine(sample, 100), sample, `${what} in a line`);
    assert.equal(library.cleanName(sample, 100), sample, `${what} in a name`);
    assert.equal(library.cleanBlock(`${sample}\n${sample}`, 100), `${sample}\n${sample}`, `${what} in a block`);
    assert.equal(library.countRemoved(sample), 0, what);
  }
});

test('text loses what the library refuses: control characters and the hidden ones, and lone surrogates', () => {
  const refused = ['\u0000', '\u0007', '\u000b', '\u001b', '\u007f', '\u0085', '\u009f', '\u061c', '\u180e', '\u200b', '\u202a', '\u202e', '\u2060', '\u2064', '\u2066', '\u2069', '\ufeff', '\ufff9', '\ufffb', String.fromCodePoint(0xe0001), String.fromCodePoint(0xe007f), '\ud800', '\udc00'];
  for (const value of refused) {
    assert.equal(library.cleanLine(`a${value}b`, 100), 'ab', JSON.stringify(value));
    assert.equal(library.cleanBlock(`a${value}b`, 100), 'ab', JSON.stringify(value));
    assert.equal(library.countRemoved(`a${value}b`), 1, JSON.stringify(value));
  }
  assert.equal(library.countRemoved(refused.join('.')), refused.length, 'each one is counted, also two lone surrogates next to dots');
});

test('the form removes a character from text exactly when the library calls the text hidden', () => {
  everyCodePoint((code, char) => {
    const line = library.cleanLine(`a${char}b`, 100);
    const block = library.cleanBlock(`a${char}b`, 100);
    if ([0x09, 0x0a, 0x0d, 0x2028, 0x2029].includes(code)) {
      assert.equal(line, 'a b', `U+${code.toString(16)} in a line is a space`);
      assert.equal(block, code === 0x09 ? 'a\tb' : 'a\nb', `U+${code.toString(16)} in a block`);
      return;
    }
    const expected = hasHiddenCharacters(char) ? 'ab' : `a${char}b`;
    assert.equal(line, expected, `U+${code.toString(16)}`);
    assert.equal(block, expected, `U+${code.toString(16)}`);
    assert.equal(hasHiddenCharacters(line), false);
  });
});

test('the page says in one quiet line how many hidden characters it took out, and counts on', () => {
  const page = openForm({ language: 'en' });
  const goal = part(page, 'A.goal');
  assert.equal(goal.removed.hidden, true, 'nothing to say at first');
  const field = goal.focus();
  typeInto(field, `Et m\u00e5l\u200b med\u202e tegn`);
  assert.equal(field.value, 'Et m\u00e5l med tegn', 'the field shows what goes into the pack');
  assert.equal(page.app.state.answers['A.goal'].text, 'Et m\u00e5l med tegn');
  assert.equal(goal.removed.hidden, false);
  assert.equal(goal.removed.textContent, text('en', 'ui.form.hint.removed', { count: 2 }));
  typeInto(field, `Et m\u00e5l med tegn\ufeff`);
  assert.equal(goal.removed.textContent, text('en', 'ui.form.hint.removed', { count: 3 }));
  typeInto(field, `Et m\u00e5l \u200d\u00ad\u200e`);
  assert.equal(goal.removed.textContent, text('en', 'ui.form.hint.removed', { count: 3 }), 'joiners and the like are not counted');
  assert.equal(field.value, 'Et m\u00e5l \u200d\u00ad\u200e');

  const name = page.root;
  const respondent = findAll(name, (element) => element.getAttribute('id') === 'respondent-name')[0];
  typeInto(respondent, 'Anna\u200b Jensen');
  const setupNote = findAll(name, (element) => element.localName === 'p' && element.getAttribute('role') === 'status' && element.textContent === text('en', 'ui.form.hint.removed', { count: 1 }));
  assert.equal(setupNote.length, 1, 'the setup fields have their own line');
  assert.equal(page.app.state.respondent.name, 'Anna Jensen');
});

test('a file description and a list row get the same quiet line', async () => {
  const page = openForm({ language: 'da' });
  const input = inputsOf(part(page, 'B.logo').root, 'file')[0];
  input.files = [fakeFile('logo.svg', 'x')];
  input.fire('change');
  await until(() => page.app.state.assets.length === 1, 'the file');
  const description = findAll(part(page, 'B.logo').root, (element) => element.localName === 'input' && element.getAttribute('type') === 'text')[0];
  typeInto(description, 'Hoved\u200blogo');
  assert.equal(page.app.state.assets[0].what, 'Hovedlogo');
  const note = findAll(part(page, 'B.logo').root, (element) => element.localName === 'p' && element.textContent === text('da', 'ui.form.hint.removed', { count: 1 }));
  assert.equal(note.length, 1);

  const row = findAll(part(page, 'A.metrics').root, (element) => element.localName === 'input' && element.getAttribute('type') === 'text')[0];
  typeInto(row, 'Salg\u202e');
  assert.equal(part(page, 'A.metrics').removed.textContent, text('da', 'ui.form.hint.removed', { count: 1 }));
});

// ---------------------------------------------------------------------------------------------
// The text that was typed is the text that the library gets: form -> pack -> check

async function assertPackAccepted(t, state) {
  const pack = await engine.buildPack(state, { now: NOW, today: TODAY });
  const entries = unzipPack(pack.bytes);
  const root = makeTempDir(t);
  for (const [name, content] of entries) {
    fs.mkdirSync(path.dirname(path.join(root, ...name.split('/'))), { recursive: true });
    fs.writeFileSync(path.join(root, ...name.split('/')), content);
  }
  const report = validatePack(parsePack(root, schema), schema, { depth: state.depth, today: TODAY });
  const bad = report.flags.filter((flag) => /^(?:text\.|assets\.(?:badName|unlisted|missingFile)|pack\.)/.test(flag.id));
  assert.deepEqual(bad.map((flag) => flag.id), [], 'the library finds nothing wrong with the names or the text');
  const out = path.join(makeTempDir(t), 'out');
  fs.mkdirSync(out);
  const lines = [];
  const code = await packMain(['--root', root, '--out', out], {
    stdout: { write: (chunk) => lines.push(String(chunk)) },
    stderr: { write: (chunk) => lines.push(String(chunk)) },
    stdin: process.stdin,
    cwd: root,
    env: {},
    now: () => new Date(2026, 9, 23, 12, 0, 0),
  });
  assert.equal(code, 0, `the pack script accepts the pack: ${lines.join('')}`);
  return { entries, report };
}

test('a family photo with a joined emoji and a soft hyphen goes from the form into a pack the library accepts', async (t) => {
  const family = 'Familiefoto \ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67 og Ka\u00adtalog';
  const state = newSampleState(engine, 'da');
  engine.record(state, 'A.goal').text = `Vi viser ${family} p\u00e5 forsiden, s\u00e5 kunderne ser, hvem vi er.`;
  engine.record(state, 'A.business').text = `${family}\n\nEn linje mere.`;
  state.respondent.name = 'Anna \u200d Jensen';
  const asset = engine.addAsset(state, 'B.logo', { name: `${family}.png`, data: new Uint8Array([1, 2, 3]) });
  asset.what = family;
  asset.rights = 'Ejes af os';
  assert.equal(asset.name, 'Familiefoto-\ud83d\udc68\ud83d\udc69\ud83d\udc67-og-Ka\u00adtalog.png', 'the file name loses the joiners, as the zip needs; the soft hyphen is allowed in a name');
  assert.ok(asset.renamedFrom.includes('<U+200D>'), asset.renamedFrom);

  const { entries } = await assertPackAccepted(t, state);
  const answers = Buffer.concat([...entries].filter(([name]) => /^docs\/0\d-/.test(name)).map(([, content]) => content)).toString('utf8');
  assert.ok(answers.includes(`Vi viser ${family} p\u00e5 forsiden`), 'the answer is in the pack exactly as typed');
  assert.ok(textOfEntry(entries, 'docs/assets.md').includes(family), 'and so is the description');
  assert.ok(answers.includes('Anna \u200d Jensen'), 'and the name of the person');
  assert.equal(hasHiddenCharacters(answers), false);
});

test('what the page accepts from a person the library accepts in the pack, for every kind of field', async (t) => {
  const state = newSampleState(engine, 'en');
  const sample = Object.values(KEPT).join(' ');
  for (const question of engine.ordered) {
    const record = engine.record(state, question.id);
    if (question.type === 'text' || question.type === 'longtext') record.text = library.cleanBlock(`${sample} ${question.id}`, 3000);
    if (question.type === 'list') record.items = [{ text: library.cleanLine(`${sample} 1`, 900), note: '' }, { text: 'two', note: '' }, { text: 'three', note: '' }];
  }
  state.recipient = library.cleanName(`Team ${sample}`, 200);
  const { report } = await assertPackAccepted(t, state);
  assert.equal(report.flags.some((flag) => flag.id === 'text.hiddenCharacters'), false);
  void textOf;
});

// ---------------------------------------------------------------------------------------------
// The respondent line is the interviewer's: the library's encodeListName and separator

test('a name with a comma, a semicolon, an ampersand or a joiner is written as the interviewer writes it and read back whole', async (t) => {
  const goal = { id: 'A.goal', status: 'complete', text: 'At få flere henvendelser fra private kunder, så vi kan fylde kalenderen.' };
  for (const person of [
    { name: 'Hansen, Anna', role: 'Chef, Marketing' },
    { name: 'Anna; Peter', role: 'IT; Drift' },
    { name: 'R&D &lt; Team', role: '&amp; co <b>' },
    { name: 'María ‍ José', role: 'Diseño' },
    { name: 'Solo', role: '' },
  ]) {
    const state = engine.newState({ language: 'da', now: NOW });
    state.respondent = person;
    engine.record(state, 'A.goal').text = goal.text;
    const entries = unzipPack((await engine.buildPack(state, { now: NOW, today: TODAY })).bytes);
    const expected = interviewerTree(t, [goal], { language: 'da', depth: 'standard', respondent: person });
    const brief = textOfEntry(entries, 'docs/00-brief.md');
    assert.equal(brief, expected.get('docs/00-brief.md').toString('utf8'), JSON.stringify(person));
    const manifest = JSON.parse(textOfEntry(entries, 'docs/intake-manifest.json'));
    const interviewer = JSON.parse(expected.get('docs/intake-manifest.json').toString('utf8'));
    assert.deepEqual(manifest.respondents.map(({ name, role }) => ({ name, role })), interviewer.respondents.map(({ name, role }) => ({ name, role })), JSON.stringify(person));
    const semicolons = person.name.replace(/;/g, ',');
    assert.equal(manifest.respondents[0].name, semicolons, 'the name comes back whole');
  }
});
