// Tests for hostile input: text that tries to control a terminal, to make the library slow, to
// break the generated block, to reach other files, to fill the memory or to put markup in a preview.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  InputError,
  PackError,
  applyAnswers,
  bodyFromInput,
  buildManifest,
  decodeMarkup,
  encodeMarkup,
  findQuestion,
  hasControlCharacters,
  inDepth,
  parseBody,
  parseFile,
  parsePack,
  refreshPack,
  renderAssets,
  sanitizeForTerminal,
  sha256File,
  validatePack,
  validatePackData,
  writeFileAtomic,
} from '../../skill/everything-mapped/scripts/lib/index.mjs';
import { main as answer } from '../../skill/everything-mapped/scripts/answer.mjs';
import { main as assets } from '../../skill/everything-mapped/scripts/assets.mjs';
import { main as check } from '../../skill/everything-mapped/scripts/check.mjs';
import { main as next } from '../../skill/everything-mapped/scripts/next.mjs';
import { NOW, TODAY, makePackData, makeSchemaDir, makeTempDir, readJson, runScript, schema, testI18n, writeText } from './helpers.mjs';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CSI = String.fromCharCode(0x9b);
const CLEAR_SCREEN = `${ESC}[2J`;
const CLIPBOARD = `${ESC}]52;c;QUJD${BEL}`;
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
      else result[path.relative(dir, absolute)] = fs.statSync(absolute).size > 1e6 ? 'large' : fs.readFileSync(absolute, 'utf8');
    }
  };
  walk(dir);
  return result;
}

function assertTerminalSafe(text, label) {
  for (const char of text) {
    const code = char.codePointAt(0);
    const unsafe = (code < 32 && code !== 10 && code !== 9) || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029 || (code >= 0x202a && code <= 0x202e);
    assert.ok(!unsafe, `${label}: unsafe character U+${code.toString(16)} in ${JSON.stringify(text.slice(0, 200))}`);
  }
}

function elapsed(work) {
  const started = performance.now();
  work();
  return performance.now() - started;
}

// ---- 1. terminal escapes -------------------------------------------------------------------------

test('sanitizeForTerminal replaces control characters with visible stand-ins and keeps normal text', () => {
  const text = `plain æøå\ttab${CLEAR_SCREEN}${CLIPBOARD}${CSI}x\r\nline`;
  const safe = sanitizeForTerminal(text);
  assertTerminalSafe(safe.replace(/\n/g, ''), 'default');
  assert.ok(safe.startsWith('plain æøå\ttab'));
  assert.ok(safe.includes(String.fromCodePoint(0x241b)), 'ESC becomes a control picture');
  assert.ok(safe.includes(String.fromCodePoint(0x2407)), 'BEL becomes a control picture');
  assert.ok(safe.includes(String.fromCodePoint(0x240d)), 'carriage return is never kept');
  assert.ok(safe.includes(String.fromCodePoint(0x240a)), 'a line feed is a stand-in unless line breaks are kept');
  assert.ok(sanitizeForTerminal('a\nb', { keepLineBreaks: true }).includes('\n'));
  assert.equal(sanitizeForTerminal(`a${String.fromCharCode(0x202e)}b${String.fromCharCode(0x2028)}`), `a${String.fromCodePoint(0xfffd)}b${String.fromCodePoint(0xfffd)}`);
  assert.equal(sanitizeForTerminal(`${String.fromCharCode(0x200d, 0xad, 0x200e, 0x85)}`), String.fromCodePoint(0xfffd).repeat(4), 'legitimate invisible characters are replaced when printed');
  assert.equal(sanitizeForTerminal(undefined), '');
  assert.equal(sanitizeForTerminal('Ærø ✓ 日本'), 'Ærø ✓ 日本');
});

test('hasControlCharacters finds C0, DEL and C1 characters but allows tab, line feed and carriage return', () => {
  assert.equal(hasControlCharacters(`ok\t\r\n æøå`), false);
  for (const code of [0, 7, 8, 11, 12, 14, 27, 31, 127, 128, 0x85, 0x9b, 159]) {
    assert.equal(hasControlCharacters(`a${String.fromCharCode(code)}b`), true, `code ${code}`);
  }
  assert.equal(hasControlCharacters(undefined), false);
});

function writeHostilePack(root) {
  writeText(root, 'docs/00-brief.md', `${FRONT('brief')}\n### A\n<!-- q:Z.${CLEAR_SCREEN}${CLIPBOARD} status:complete -->\nx\n\n### B\n<!-- q:A.goal status:${ESC}[31mred -->\nText\n`);
  writeText(root, 'docs/02-audience-and-competitors.md', `${FRONT('audience')}\n### L\n<!-- q:E.like status:complete -->\n- ${CLEAR_SCREEN}${CLIPBOARD} pasted ${CSI} text\n- ${ESC}]0;title${BEL}\n`);
  writeText(root, 'docs/05-technical-and-compliance.md', `${FRONT('technical')}\n### D\n<!-- q:I.domain status:tbd owner:${CLEAR_SCREEN}me due:${CLIPBOARD} -->\nNote ${CLEAR_SCREEN}${CLIPBOARD} here\n`);
  writeText(root, 'docs/intake-state.json', JSON.stringify({ schema: 'everything-mapped-for-clients/1', language: 'da', depth: 'full', focus: [], notes: '' }));
  fs.writeFileSync(path.join(root, 'docs', 'assets', `bad${ESC}[2J${CLIPBOARD}.png`), 'x', { flag: 'wx' });
}

test('check, check --write and assets print nothing that can control a terminal, from a crafted pack', async (t) => {
  const { cwd, run } = setup(t);
  fs.mkdirSync(path.join(cwd, 'docs', 'assets'), { recursive: true });
  try {
    writeHostilePack(cwd);
  } catch {
    return t.skip('this file system does not allow control characters in file names');
  }
  for (const lang of ['da', 'en']) {
    const human = await run(check, ['--lang', lang, '--write']);
    assert.equal(human.code, 0, human.err);
    assertTerminalSafe(human.out, `check ${lang}`);
    assertTerminalSafe(human.err, `check ${lang} stderr`);
    assert.ok(human.out.includes(String.fromCodePoint(0x241b)), 'the stand-in is visible');
  }
  const scan = await run(assets, ['--scan']);
  assertTerminalSafe(scan.out, 'assets scan');
  assert.ok(scan.out.includes('bad'));
  const json = await run(check, ['--json']);
  assert.doesNotThrow(() => JSON.parse(json.out), 'JSON output stays valid JSON');
  assert.ok(!json.out.includes(ESC), 'JSON escapes control characters');
  const generated = fs.readFileSync(path.join(cwd, 'docs/07-risks-and-open-questions.md'), 'utf8');
  assertTerminalSafe(generated, 'open questions file');
});

test('error messages that repeat text from the pack or the input are safe to print', async (t) => {
  const { cwd, run } = setup(t);
  writeText(cwd, 'docs/intake-state.json', JSON.stringify({ schema: `everything-mapped-for-clients/${CLEAR_SCREEN}${CLIPBOARD}` }));
  const result = await run(check, []);
  assert.equal(result.code, 3);
  assertTerminalSafe(result.err, 'unsupported schema');
  fs.rmSync(path.join(cwd, 'docs/intake-state.json'));
  fs.writeFileSync(path.join(cwd, 'answers.json'), JSON.stringify({ language: 'da', answers: [{ id: `Z.${CLEAR_SCREEN}${CLIPBOARD}`, status: 'complete', text: 'x' }] }));
  const refused = await run(answer, ['--from', 'answers.json']);
  assert.equal(refused.code, 2);
  assertTerminalSafe(refused.err, 'unknown id');
  assert.ok(refused.err.includes('Z.'));
});

test('answer.mjs refuses control characters in every field with exit 2 and writes nothing', async (t) => {
  const { cwd, run } = setup(t);
  const bad = `x${CLEAR_SCREEN}y`;
  const cases = {
    text: { language: 'da', answers: [{ id: 'A.goal', status: 'complete', text: bad }] },
    note: { language: 'da', answers: [{ id: 'A.project-kind', status: 'complete', choice: ['redesign'], note: bad }] },
    itemText: { language: 'da', answers: [{ id: 'A.metrics', status: 'complete', items: [{ text: bad }] }] },
    itemNote: { language: 'da', answers: [{ id: 'A.metrics', status: 'complete', items: [{ text: 'a', note: bad }] }] },
    plainItem: { language: 'da', answers: [{ id: 'A.metrics', status: 'complete', items: [bad] }] },
    owner: { language: 'da', answers: [{ id: 'I.domain', status: 'tbd', owner: bad, note: 'x' }] },
    tbdNote: { language: 'da', answers: [{ id: 'I.domain', status: 'tbd', note: bad }] },
    respondent: { language: 'da', respondent: { name: bad }, answers: [] },
    role: { language: 'da', respondent: { name: 'Anna', role: bad }, answers: [] },
    recipient: { language: 'da', recipient: bad, answers: [] },
    notes: { language: 'da', notes: bad, answers: [] },
    csi: { language: 'da', answers: [{ id: 'A.goal', status: 'complete', text: `a${CSI}b` }] },
  };
  for (const [name, input] of Object.entries(cases)) {
    fs.writeFileSync(path.join(cwd, 'answers.json'), JSON.stringify(input));
    const result = await run(answer, ['--from', 'answers.json', '--lang', 'en']);
    assert.equal(result.code, 2, name);
    assert.ok(result.err.includes('control characters'), `${name}: ${result.err}`);
    assertTerminalSafe(result.err, name);
    assert.deepEqual(fs.readdirSync(cwd), ['answers.json'], `${name}: nothing written`);
  }
});

test('answer.mjs accepts tabs, line feeds and carriage returns in text', async (t) => {
  const { cwd, run } = setup(t);
  fs.writeFileSync(path.join(cwd, 'answers.json'), JSON.stringify({ language: 'da', answers: [{ id: 'A.goal', status: 'complete', text: 'Line one\r\n\tindented\nLine three' }] }));
  assert.equal((await run(answer, ['--from', 'answers.json'])).code, 0);
  assert.equal(parsePack(cwd, schema).files.brief.answers['A.goal'].body, 'Line one\n\tindented\nLine three');
});

// ---- 2. slow patterns and size limits ------------------------------------------------------------

const HOSTILE = {
  'a letter': 'a'.repeat(150000),
  'spaces then x': `${' '.repeat(150000)}x`,
  'a, spaces, x': `a${' '.repeat(150000)}x`,
  'brackets then x': `${')'.repeat(150000)}x`,
  'dashes then x': `${'-'.repeat(150000)}x`,
  'open marker': `<!-- q:${'a '.repeat(75000)}`,
  pipes: '|'.repeat(150000),
  'escaped pipes': '\\|'.repeat(75000),
  'digits then x': `${'1'.repeat(150000)}x`,
  bullets: '- '.repeat(75000),
  'address-like': `http://${'a.'.repeat(75000)}!`,
  'less-than': '<'.repeat(150000),
  ampersands: '&'.repeat(150000),
  entities: '&lt;'.repeat(40000),
  'tabs between letters': 'a\t'.repeat(75000),
};

test('the text helpers handle very long hostile lines in well under a second each', () => {
  const dateQuestion = findQuestion(schema, 'A.deadline');
  const kinds = ['A.goal', 'A.metrics', 'A.project-kind', 'E.like'].map((id) => findQuestion(schema, id));
  for (const [name, text] of Object.entries(HOSTILE)) {
    const work = () => {
      sanitizeForTerminal(text);
      encodeMarkup(decodeMarkup(text));
      for (const question of kinds) {
        parseBody(question, text);
        bodyFromInput(question, { text, items: [{ text, note: text }], choice: ['redesign'], note: text });
      }
      parseBody(dateQuestion, text);
    };
    assert.ok(elapsed(work) < 1000, `${name} took too long`);
  }
});

test('validation and the open-questions file handle long hostile entries quickly', () => {
  for (const [name, text] of Object.entries(HOSTILE)) {
    const work = () => {
      const data = makePackData([
        { id: 'E.like', status: 'complete', items: [{ text, note: '' }] },
        { id: 'I.domain', status: 'tbd', note: text },
      ]);
      data.assets = { rows: [{ file: text, what: text, owner: '', rights: text, restrictions: '' }], present: [text] };
      const report = validatePackData(data, schema, { today: TODAY });
      assert.ok(report.flags.length < 400);
    };
    assert.ok(elapsed(work) < 1000, `${name} took too long`);
  }
});

test('the hostile line of the review (101 KB of a, 100,000 spaces and x) is refused fast, not read slowly', async (t) => {
  const { cwd, run } = setup(t);
  const line = `${'a'.repeat(1000)}${' '.repeat(100000)}x`;
  writeText(cwd, 'docs/00-brief.md', `${FRONT('brief')}\n### A\n<!-- q:A.goal status:complete -->\n${line}\n`);
  const started = performance.now();
  const result = await run(check, ['--json', '--lang', 'en']);
  assert.ok(performance.now() - started < 1000);
  assert.equal(result.code, 3);
  assert.equal(result.err, 'docs/00-brief.md: line 10 is longer than 20000 characters, so the file is not read.\n');
});

test('a line may have 20,000 characters and not one more', () => {
  const file = (length) => `${FRONT('brief')}\n### A\n<!-- q:A.goal status:complete -->\n${'a'.repeat(length)}\n`;
  assert.equal(parseFile(file(20000), schema).answers['A.goal'].body.length, 20000);
  assert.throws(() => parseFile(file(20001), schema), (error) => error instanceof PackError && error.key === 'ui.check.err.lineTooLong' && error.params.line === 10);
});

test('an answer may have 200 KB and not more, whatever the length of its lines', () => {
  const body = (lines) => Array.from({ length: lines }, () => 'x'.repeat(1000)).join('\n');
  const file = (lines) => `${FRONT('brief')}\n### A\n<!-- q:A.goal status:complete -->\n${body(lines)}\n`;
  assert.ok(parseFile(file(200), schema).answers['A.goal'].body.length <= 200 * 1024);
  assert.throws(() => parseFile(file(210), schema), (error) => error.key === 'ui.check.err.bodyTooLarge' && error.params.id === 'A.goal');
});

test('an answer file over 2 MB is refused without being read, and so is a state file over 20 MB', async (t) => {
  const { cwd, run } = setup(t);
  const briefPath = path.join(cwd, 'docs/00-brief.md');
  fs.mkdirSync(path.dirname(briefPath), { recursive: true });
  fs.writeFileSync(briefPath, '');
  fs.truncateSync(briefPath, 2 * 1024 * 1024 + 1);
  const result = await run(check, ['--lang', 'en']);
  assert.equal(result.code, 3);
  assert.equal(result.err, 'docs/00-brief.md is larger than 2 MB and is not read.\n');
  fs.truncateSync(briefPath, 0);
  const statePath = path.join(cwd, 'docs/intake-state.json');
  fs.writeFileSync(statePath, '');
  fs.truncateSync(statePath, 20 * 1024 * 1024 + 1);
  assert.equal((await run(check, ['--lang', 'en'])).err, 'docs/intake-state.json is larger than 20 MB and is not read.\n');
});

test('50,000 duplicate markers in one file are handled in under a second with a bounded number of flags', () => {
  const marker = '<!-- q:A.goal status:complete -->\n';
  const text = `${FRONT('brief')}\n### A\n${marker.repeat(50000)}`;
  assert.ok(text.length < 2 * 1024 * 1024);
  const started = performance.now();
  const parsed = parseFile(text, schema);
  const data = makePackData([]);
  data.files.brief = { path: 'docs/00-brief.md', exists: true, ...parsed };
  const report = validatePackData(data, schema, { today: TODAY });
  assert.ok(performance.now() - started < 1000);
  assert.ok(parsed.flags.length <= 100);
  assert.equal(parsed.flags.filter((flag) => flag.id === 'marker.duplicate').length, 1, 'a duplicate is reported once per question');
  assert.ok(report.flags.length < 200);
});

test('answer.mjs refuses an answer that is too long or an input file over 2 MB with exit 2', async (t) => {
  const { cwd, run } = setup(t);
  const longLine = 'x'.repeat(20001);
  fs.writeFileSync(path.join(cwd, 'answers.json'), JSON.stringify({ language: 'da', answers: [{ id: 'A.goal', status: 'complete', text: longLine }] }));
  const tooLong = await run(answer, ['--from', 'answers.json', '--lang', 'en']);
  assert.equal(tooLong.code, 2);
  assert.equal(tooLong.err, 'A.goal: the answer is too long. A line may have at most 20000 characters and the whole answer at most 200 KB.\n');
  const manyLines = Array.from({ length: 210 }, () => 'y'.repeat(1000)).join('\n');
  fs.writeFileSync(path.join(cwd, 'answers.json'), JSON.stringify({ language: 'da', answers: [{ id: 'A.goal', status: 'complete', text: manyLines }] }));
  assert.equal((await run(answer, ['--from', 'answers.json'])).code, 2);
  fs.writeFileSync(path.join(cwd, 'answers.json'), ' '.repeat(2 * 1024 * 1024 + 1));
  const large = await run(answer, ['--from', 'answers.json', '--lang', 'en']);
  assert.equal(large.code, 2);
  assert.ok(large.err.includes('is larger than 2 MB'));
  assert.deepEqual(fs.readdirSync(cwd), ['answers.json']);
});

test('applyAnswers refuses a result that would make an answer file over 2 MB, before writing anything', (t) => {
  const { cwd, options } = setup(t);
  const chunk = Array.from({ length: 190 }, () => 'z'.repeat(1000)).join('\n');
  const ids = ['A.business', 'A.why-now', 'A.goal', 'A.deadline-reason', 'A.failure', 'J.concerns', 'J.anything-else', 'A.budget', 'J.contact', 'J.availability', 'J.feedback', 'J.accounts'];
  const input = { language: 'da', answers: ids.map((id) => ({ id, status: 'complete', text: chunk })) };
  assert.throws(() => applyAnswers(cwd, input, options), (error) => error instanceof InputError && error.problems[0].key === 'ui.answer.err.resultTooLarge');
  assert.deepEqual(fs.readdirSync(cwd), []);
});

// ---- 3. the generated block ----------------------------------------------------------------------

test('a note or an id that holds the generated markers cannot break regeneration, which stays identical', (t) => {
  const { cwd, options } = setup(t);
  const evil = 'x <!-- generated:end --> y <!-- generated:start --> z';
  applyAnswers(cwd, {
    language: 'en',
    answers: [
      { id: 'I.domain', status: 'tbd', owner: 'client', due: '2026-11-05', note: evil },
      { id: 'D.channels', status: 'complete', choice: ['search'], note: 'fine' },
    ],
  }, options);
  const briefOfPack = path.join(cwd, 'docs/04-scope-and-structure.md');
  fs.writeFileSync(briefOfPack, fs.readFileSync(briefOfPack, 'utf8'));
  const audiencePath = path.join(cwd, 'docs/02-audience-and-competitors.md');
  fs.writeFileSync(audiencePath, fs.readFileSync(audiencePath, 'utf8').replace('Choice: search', 'Choice: search, <!-- generated:end -->, </td><img src=x>'));
  const openPath = path.join(cwd, 'docs/07-risks-and-open-questions.md');
  const outputs = [];
  for (let run = 0; run < 7; run += 1) {
    refreshPack(cwd, options);
    outputs.push(fs.readFileSync(openPath, 'utf8'));
  }
  assert.ok(outputs.every((text) => text === outputs[0]), 'seven runs give the same bytes');
  const text = outputs[0];
  assert.equal(text.match(/<!-- generated:end -->/g).length, 1);
  assert.equal(text.match(/<!-- generated:start -->/g).length, 1);
  assert.ok(text.includes('x &lt;!-- generated:end --&gt; y'));
  assert.ok(text.includes('&lt;/td>&lt;img src=x>'), 'tags in flag texts are defused');
  assert.ok(!/<(?:img|\/td)/.test(text));
});

// ---- 4. names that every object inherits ----------------------------------------------------------

const INHERITED = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf'];

test('state.focus with inherited names is dropped on read, next works and answer writes a clean state', async (t) => {
  const { cwd, run, options } = setup(t);
  applyAnswers(cwd, { language: 'da', answers: [] }, options);
  const statePath = path.join(cwd, 'docs/intake-state.json');
  const state = readJson(statePath);
  fs.writeFileSync(statePath, JSON.stringify({ ...state, focus: [...INHERITED, 'A.goal', 'nope', 5, null, {}] }));
  assert.deepEqual(parsePack(cwd, schema).state.focus, ['A.goal']);
  const result = await run(next, ['--count', '5']);
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(JSON.parse(result.out).questions.map((question) => question.id), ['A.goal']);
  fs.writeFileSync(path.join(cwd, 'answers.json'), JSON.stringify({ answers: [{ id: 'B.name', status: 'complete', text: 'Nordlys' }] }));
  const answered = await run(answer, ['--from', 'answers.json']);
  assert.equal(answered.code, 0, answered.err);
  assert.deepEqual(readJson(statePath).focus, ['A.goal']);
});

test('answer.mjs rejects inherited names as ids, focus and depth before writing anything', async (t) => {
  const { cwd, run, options } = setup(t);
  applyAnswers(cwd, { language: 'da', answers: [] }, options);
  const before = snapshot(cwd);
  for (const name of INHERITED) {
    const inputs = [
      { answers: [{ id: name, status: 'complete', text: 'x' }] },
      { focus: [name], answers: [] },
      { depth: name, answers: [] },
      { answers: [{ id: 'A.project-kind', status: 'complete', choice: [name] }] },
    ];
    for (const input of inputs) {
      fs.writeFileSync(path.join(cwd, 'answers.json'), JSON.stringify(input));
      assert.equal((await run(answer, ['--from', 'answers.json'])).code, 2, `${name} ${JSON.stringify(input)}`);
    }
  }
  fs.rmSync(path.join(cwd, 'answers.json'));
  assert.deepEqual(snapshot(cwd), before);
});

test('inherited names are not depths, and not questions in a pack file', () => {
  assert.equal(inDepth('gate1', 'constructor', schema), false);
  assert.equal(inDepth('gate1', '__proto__', schema), false);
  assert.throws(() => validatePackData(makePackData([]), schema, { depth: 'constructor' }), /Unknown depth/);
  for (const name of INHERITED) {
    const parsed = parseFile(`${FRONT('brief')}\n### A\n<!-- q:${name} status:complete -->\nx\n`, schema);
    assert.deepEqual(Object.keys(parsed.answers), [], name);
    assert.equal(parsed.flags[0].id, 'marker.unknownQuestion');
  }
});

test('--depth with an inherited name is a usage error for check and next', async (t) => {
  const { cwd, run, options } = setup(t);
  applyAnswers(cwd, { language: 'da', answers: [] }, options);
  assert.equal((await run(check, ['--depth', 'constructor'])).code, 2);
  assert.equal((await run(next, ['--depth', '__proto__'])).code, 2);
  assert.equal((await run(next, ['--module', 'constructor'])).code, 2);
});

// ---- 5. writing through links -----------------------------------------------------------------------

function trySymlink(target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath);
    return true;
  } catch {
    return false;
  }
}

test('writeFileAtomic and applyAnswers refuse to write through a symbolic link and change nothing', (t) => {
  const { cwd, options } = setup(t);
  applyAnswers(cwd, { language: 'da', answers: [] }, options);
  const real = path.join(cwd, 'docs', 'real-brief.md');
  fs.writeFileSync(real, 'keep me\n');
  const link = path.join(cwd, 'docs', '00-brief.md');
  fs.rmSync(link);
  if (!trySymlink(real, link)) return t.skip('symbolic links are not available here');
  const before = snapshot(cwd);
  assert.throws(() => writeFileAtomic(link, 'overwritten'), (error) => error instanceof PackError && error.key === 'ui.check.err.symlinkTarget');
  assert.throws(
    () => applyAnswers(cwd, { answers: [{ id: 'B.name', status: 'complete', text: 'Nordlys' }] }, options),
    (error) => error instanceof PackError && error.key === 'ui.check.err.symlinkTarget',
  );
  assert.deepEqual(snapshot(cwd), before, 'not even the files before the link in the order were written');
  assert.equal(fs.readFileSync(real, 'utf8'), 'keep me\n');
});

test('a link at a generated file (the manifest) is refused before the first write', (t) => {
  const { cwd, options } = setup(t);
  applyAnswers(cwd, { language: 'da', answers: [] }, options);
  const real = path.join(cwd, 'elsewhere.json');
  fs.writeFileSync(real, '{}');
  const manifest = path.join(cwd, 'docs', 'intake-manifest.json');
  fs.rmSync(manifest);
  if (!trySymlink(real, manifest)) return t.skip('symbolic links are not available here');
  const before = snapshot(cwd);
  assert.throws(() => applyAnswers(cwd, { answers: [{ id: 'B.name', status: 'complete', text: 'Nordlys' }] }, options), PackError);
  assert.deepEqual(snapshot(cwd), before);
});

test('the temporary file is created exclusively with a random name', (t) => {
  const dir = makeTempDir(t);
  const calls = [];
  const original = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (file, data, options) => {
    calls.push({ file: String(file), options });
    return original(file, data, options);
  });
  writeFileAtomic(path.join(dir, 'a.md'), 'one');
  writeFileAtomic(path.join(dir, 'a.md'), 'two');
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.options.flag, 'wx');
    assert.match(path.basename(call.file), /^a\.md\.[0-9a-f]{12}\.tmp$/);
  }
  assert.notEqual(calls[0].file, calls[1].file);
  assert.deepEqual(fs.readdirSync(dir), ['a.md']);
});

test('a file that already has the name of the temporary file is not followed or overwritten', (t) => {
  const dir = makeTempDir(t);
  const victim = path.join(dir, 'victim.txt');
  fs.writeFileSync(victim, 'safe');
  const target = path.join(dir, 'a.md');
  const original = fs.writeFileSync;
  let planted = null;
  t.mock.method(fs, 'writeFileSync', (file, data, options) => {
    if (planted === null && String(file).endsWith('.tmp')) {
      planted = String(file);
      if (!trySymlink(victim, planted)) throw new Error('no links');
    }
    return original(file, data, options);
  });
  try {
    writeFileAtomic(target, 'new');
    assert.fail('the write should have failed');
  } catch (error) {
    if (error.message === 'no links') return t.skip('symbolic links are not available here');
    assert.equal(error.code, 'EEXIST');
  }
  assert.equal(fs.readFileSync(victim, 'utf8'), 'safe');
  assert.equal(fs.existsSync(target), false);
});

// ---- 6. large files -------------------------------------------------------------------------------------

function makeSparse(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const descriptor = fs.openSync(file, 'w');
  try {
    fs.ftruncateSync(descriptor, bytes);
  } finally {
    fs.closeSync(descriptor);
  }
}

test('an asset over 500 MB makes check --write and answer exit 3 with a message and write nothing; reading still works', async (t) => {
  const { cwd, run, options } = setup(t);
  applyAnswers(cwd, { language: 'en', answers: [] }, options);
  makeSparse(path.join(cwd, 'docs', 'assets', 'big video.mp4'), 501 * 1024 * 1024);
  const before = snapshot(cwd);
  const expected = 'The file docs/assets/big video.mp4 is larger than 500 MB. Remove it or use a smaller file.\n';
  const write = await run(check, ['--write']);
  assert.equal(write.code, 3);
  assert.equal(write.err, expected);
  for (const [main, argv] of [[check, []], [assets, ['--scan']], [next, []]]) {
    const result = await run(main, argv);
    assert.equal(result.code, 0, `${argv.join(' ')}: reading never opens an asset`);
  }
  assert.ok((await run(assets, ['--scan', '--json'])).out.includes('assets/big video.mp4'));
  fs.writeFileSync(path.join(cwd, 'answers.json'), JSON.stringify({ answers: [{ id: 'B.name', status: 'complete', text: 'Nordlys' }] }));
  const answered = await run(answer, ['--from', 'answers.json']);
  assert.equal(answered.code, 3);
  assert.equal(answered.err, expected);
  fs.rmSync(path.join(cwd, 'answers.json'));
  assert.deepEqual(snapshot(cwd), before, 'answer wrote nothing before it refused');
});

test('the same message in Danish, and the pack works again once the file is small', async (t) => {
  const { cwd, run, options } = setup(t);
  applyAnswers(cwd, { language: 'da', answers: [] }, options);
  makeSparse(path.join(cwd, 'docs', 'assets', 'stor.bin'), 501 * 1024 * 1024);
  assert.equal((await run(check, ['--lang', 'da', '--write'])).err, 'Filen docs/assets/stor.bin er større end 500 MB. Fjern den, eller brug en mindre fil.\n');
  fs.truncateSync(path.join(cwd, 'docs', 'assets', 'stor.bin'), 1024);
  assert.equal((await run(check, ['--write'])).code, 0);
});

test('manifest hashes are made in chunks and equal the hash of the whole file', (t) => {
  const { cwd, options } = setup(t);
  applyAnswers(cwd, { language: 'da', answers: [] }, options);
  const assetPath = path.join(cwd, 'docs', 'assets', 'data.bin');
  const content = Buffer.alloc(3 * 1024 * 1024 + 123, 7);
  fs.writeFileSync(assetPath, content);
  assert.equal(sha256File(assetPath), createHash('sha256').update(content).digest('hex'));
  const readWhole = [];
  const original = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...rest) => {
    readWhole.push(String(file));
    return original(file, ...rest);
  });
  const pack = parsePack(cwd, schema);
  const manifest = buildManifest(pack, validatePack(pack, schema, { today: TODAY }), { now: NOW });
  assert.equal(manifest.files.find((entry) => entry.path === 'docs/assets/data.bin').sha256, createHash('sha256').update(content).digest('hex'));
  assert.ok(!readWhole.includes(assetPath), 'the asset was never read into memory as a whole');
  const empty = path.join(cwd, 'docs', 'assets', 'empty.bin');
  fs.writeFileSync(empty, '');
  assert.equal(sha256File(empty), createHash('sha256').update('').digest('hex'));
});

// ---- 7. markup in text ------------------------------------------------------------------------------------

function seeded(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

test('encodeMarkup leaves no comment and no tag start, and decodeMarkup gives back the original', () => {
  const random = seeded(7);
  const pieces = ['<', '>', '&', 'lt;', 'gt;', 'amp;', '!', '-', '--', '-->', '<!--', '/', '?', 'a', 'Z', ' ', '|', '\\', 'img src=x', '&lt;', '&amp;lt;', '\n'];
  for (let round = 0; round < 3000; round += 1) {
    const text = Array.from({ length: 1 + Math.floor(random() * 12) }, () => pieces[Math.floor(random() * pieces.length)]).join('');
    const encoded = encodeMarkup(text);
    assert.equal(decodeMarkup(encoded), text, JSON.stringify(text));
    assert.ok(!/<[A-Za-z/!?]/.test(encoded) && !encoded.includes('-->'), JSON.stringify(encoded));
  }
});

test('hostile markup survives the round trip through every answer type and is stored defused', () => {
  const hostile = [
    '<img src="https://tracker.example/pixel.png">',
    'text <!-- comment --> more',
    'a --> b',
    '<script>alert(1)</script>',
    '</div><?php echo 1 ?><!DOCTYPE html>',
    'already &lt;escaped&gt; and &amp;lt; and &',
    'a < b and c > d, 3 <= 4, <3',
  ];
  const kinds = {
    'A.goal': (text) => ({ text }),
    'A.metrics': (text) => ({ items: [{ text, note: text }] }),
    'B.logo': () => ({ items: [{ text: 'assets/x.png', note: '<img src=x>' }] }),
    'A.project-kind': (text) => ({ choice: ['redesign'], note: text }),
    'A.deadline': (text) => ({ date: '2026-12-01', note: text }),
  };
  for (const text of hostile) {
    for (const [id, make] of Object.entries(kinds)) {
      const question = findQuestion(schema, id);
      const input = make(text);
      const body = bodyFromInput(question, input);
      assert.ok(!/<[A-Za-z/!?]/.test(body) && !body.includes('-->'), `${id}: ${body}`);
      const value = parseBody(question, body);
      const expected = input.items ? input.items : null;
      if (expected) assert.deepEqual(value.items, expected.map((item) => ({ text: item.text, note: item.note })));
      else if (input.note !== undefined) assert.equal(value.note, text);
      else assert.equal(value.text, text);
    }
  }
});

test('hostile markup in answers, deferred notes, respondents and the assets table is defused in every file', (t) => {
  const { cwd, options } = setup(t);
  const img = '<img src="https://tracker.example/p.png">';
  const rows = [{ file: 'assets/a.png', what: img, owner: '<b>me</b>', rights: '<!-- x -->', restrictions: 'a --> b' }];
  applyAnswers(cwd, {
    language: 'en',
    respondent: { name: `Anna ${img}`, role: '<i>CEO</i>' },
    answers: [
      { id: 'A.goal', status: 'complete', text: `Goal ${img} <!-- q:A.budget status:complete --> end` },
      { id: 'A.metrics', status: 'complete', items: [{ text: img, note: '<script>x</script>' }] },
      { id: 'I.domain', status: 'tbd', owner: 'client', note: `${img} <!-- generated:end -->` },
    ],
  }, options);
  fs.writeFileSync(path.join(cwd, 'docs/assets/a.png'), 'x');
  fs.writeFileSync(path.join(cwd, 'docs/assets.md'), renderAssets(rows, testI18n('en')));
  refreshPack(cwd, options);
  for (const name of ['docs/00-brief.md', 'docs/05-technical-and-compliance.md', 'docs/assets.md', 'docs/07-risks-and-open-questions.md']) {
    const text = fs.readFileSync(path.join(cwd, name), 'utf8');
    assert.ok(!/<(?:img|script|b>|i>|\/)/.test(text), `${name} holds a tag`);
    const commentLines = text.split('\n').filter((line) => line.includes('<!--'));
    assert.ok(commentLines.every((line) => /^<!-- (q:[A-Za-z.-]+ status:[a-z]+(?: owner:\S+)?(?: due:\S+)? -->|generated:(start|end) -->)$/.test(line)), `${name}: ${commentLines.join(' | ')}`);
  }
  const pack = parsePack(cwd, schema);
  assert.equal(pack.files.brief.answers['A.goal'].value.text, `Goal ${img} <!-- q:A.budget status:complete --> end`);
  assert.equal(pack.files.brief.answers['A.budget'].status, 'missing', 'the text could not start another answer');
  assert.deepEqual(pack.assets.rows, rows, 'the assets table round trips');
  assert.equal(pack.manifest.respondents[0].name, `Anna ${img}`);
  assert.equal(pack.manifest.respondents[0].role, '<i>CEO</i>');
  const again = applyAnswers(cwd, { answers: [] }, options);
  assert.deepEqual(again.written, [], 'rewriting changes nothing');
});
