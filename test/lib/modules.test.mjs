// The module map of FORMAT.md section 11: the API, the purity rule, and a check that the six pure
// modules still work when they are joined into one script, as the static form does.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import * as lib from '../../skill/everything-mapped/scripts/lib/index.mjs';
import { FIXTURES, LIB_DIR, TODAY, makeTempDir, schema, testI18n } from './helpers.mjs';

const PURE = ['util', 'i18n-core', 'rules', 'parse', 'render', 'validate'];
const IMPURE = ['schema', 'i18n', 'fs-pack', 'manifest', 'index'];

function read(name) {
  return fs.readFileSync(path.join(LIB_DIR, `${name}.mjs`), 'utf8');
}

// Code without comments and string contents, so words in them do not count.
function codeOnly(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

test('the library exports everything FORMAT.md section 11 lists', () => {
  for (const name of [
    'loadSchema', 'loadI18n', 'questionsInOrder', 'effectiveLevel', 'parseFile', 'parsePack', 'validatePack', 'renderFile',
    'parseAssets', 'renderAssets', 'buildManifest', 'renderOpenQuestions', 'nextQuestions', 'applyAnswers', 'sha256',
    'makeI18n', 'inDepth', 'bodyFromInput', 'parseBody', 'validatePackData',
  ]) {
    assert.equal(typeof lib[name], 'function', name);
  }
});

test('every module of the module map exists', () => {
  for (const name of [...PURE, ...IMPURE]) assert.ok(fs.existsSync(path.join(LIB_DIR, `${name}.mjs`)), name);
});

for (const name of PURE) {
  test(`${name}.mjs is pure: no node: import, no process, no Buffer, no other Node global`, () => {
    const text = read(name);
    const code = codeOnly(text);
    assert.ok(!/['"`]node:/.test(text), 'a node: specifier');
    assert.ok(!/\bprocess\b/.test(code), 'process');
    assert.ok(!/\bBuffer\b/.test(code), 'Buffer');
    for (const word of ['require', '__dirname', '__filename', 'setTimeout', 'setInterval', 'globalThis', 'import.meta', 'eval', 'Function']) {
      assert.ok(!new RegExp(`\\b${word}\\b`).test(code), word);
    }
    assert.ok(!/\bimport\s*\(/.test(code), 'dynamic import');
  });

  test(`${name}.mjs only imports from the other pure modules, one import per line`, () => {
    const imports = read(name).split('\n').filter((line) => /^\s*import\b/.test(line));
    for (const line of imports) {
      const match = /^import \{[^}]+\} from '\.\/([a-z0-9-]+)\.mjs';$/.exec(line);
      assert.ok(match, `import line not in the plain one-line form: ${line}`);
      assert.ok(PURE.includes(match[1]), `${name} imports ${match[1]}`);
    }
  });

  test(`${name}.mjs uses only plain export declarations`, () => {
    const exports = read(name).split('\n').filter((line) => /^export\b/.test(line));
    assert.ok(exports.length > 0);
    for (const line of exports) assert.match(line, /^export (async function|function|const|class) \w+/, line);
  });
}

test('the pure modules do not import each other in a circle and no top-level name is used twice', () => {
  const order = pureOrder();
  assert.deepEqual([...order].sort(), [...PURE].sort());
  const owner = new Map();
  for (const name of PURE) {
    for (const match of read(name).matchAll(/^(?:export )?(?:async )?(?:function|const|let|class) (\w+)/gm)) {
      assert.ok(!owner.has(match[1]), `${match[1]} is declared in both ${owner.get(match[1])} and ${name}`);
      owner.set(match[1], name);
    }
  }
});

// The pure modules in an order where each one comes after the ones it imports.
function pureOrder() {
  const order = [];
  const visiting = new Set();
  const visit = (name) => {
    if (order.includes(name)) return;
    assert.ok(!visiting.has(name), `circular import at ${name}`);
    visiting.add(name);
    for (const match of read(name).matchAll(/from '\.\/([a-z0-9-]+)\.mjs'/g)) visit(match[1]);
    visiting.delete(name);
    order.push(name);
  };
  PURE.forEach(visit);
  return order;
}

// The text transform of the form: drop import lines and the export keyword.
function joinPureModules() {
  const parts = pureOrder().map((name) =>
    read(name)
      .split('\n')
      .filter((line) => !/^import\b/.test(line))
      .map((line) => line.replace(/^export /, ''))
      .join('\n'),
  );
  const names = 'validatePackData, validatePack, nextQuestions, parseFile, parseAssets, renderFile, renderAssets, renderOpenQuestions, makeI18n, bodyFromInput, parseBody, entryFromInput, questionsInOrder';
  return `${parts.join('\n')}\nexport { ${names} };\n`;
}

test('joined into one script, the pure modules give the same results as the modules', async (t) => {
  const target = path.join(makeTempDir(t), 'bundle.mjs');
  fs.writeFileSync(target, joinPureModules());
  const bundle = await import(pathToFileURL(target).href);

  const root = path.join(FIXTURES, 'pack-en-partial');
  const i18n = testI18n('en');
  const joinedI18n = bundle.makeI18n(Object.fromEntries(i18n.keys().map((key) => [key, i18n.t(key)])), 'en');
  const files = {};
  const joinedFiles = {};
  for (const file of schema.files) {
    const text = fs.readFileSync(path.join(root, file.path), 'utf8');
    files[file.id] = { exists: true, ...lib.parseFile(text, schema) };
    joinedFiles[file.id] = { exists: true, ...bundle.parseFile(text, schema) };
  }
  assert.deepEqual(joinedFiles, files);

  const packData = { language: 'en', depth: 'standard', files, assets: { rows: [], present: [] } };
  const report = lib.validatePackData(packData, schema, { today: TODAY });
  assert.deepEqual(bundle.validatePackData(packData, schema, { today: TODAY }), report);

  const answers = Object.assign({}, ...Object.values(files).map((file) => file.answers));
  const meta = { language: 'en', updated: TODAY };
  assert.equal(bundle.renderFile(schema, joinedI18n, 'brief', answers, meta), lib.renderFile(schema, i18n, 'brief', answers, meta));
  assert.equal(bundle.renderOpenQuestions(report, joinedI18n), lib.renderOpenQuestions(report, i18n));
  assert.equal(bundle.renderAssets([], joinedI18n), lib.renderAssets([], i18n));

  const question = lib.questionsInOrder(schema).find((entry) => entry.id === 'A.metrics');
  const body = bundle.bodyFromInput(question, { items: [{ text: 'a | b', note: 'c' }] });
  assert.equal(body, lib.bodyFromInput(question, { items: [{ text: 'a | b', note: 'c' }] }));
  assert.deepEqual(bundle.parseBody(question, body), lib.parseBody(question, body));
  const ids = (list) => list.map((entry) => entry.id);
  const options = { count: 3 };
  assert.deepEqual(ids(bundle.nextQuestions({ state: null }, schema, report, options)), ids(lib.nextQuestions({ state: null }, schema, report, options)));
});
