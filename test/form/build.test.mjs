// The build of docs/form/index.html: a deterministic, self-contained file that holds the schema,
// both dictionaries and the library, and cannot reach the network.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { loadI18n } from '../../skill/everything-mapped/scripts/lib/index.mjs';
import {
  FORM_SCRIPTS,
  FORM_STYLESHEET,
  FORM_TEXT_FILES,
  LIBRARY_MODULES,
  assertInlineSafe,
  buildFormHtml,
  buildScript,
  contentSecurityPolicy,
  cspHash,
  main,
  stripModuleSyntax,
} from '../../tools/build-form.mjs';
import { CLIENT_ROOT, FORM_HTML, SCHEMA_DIR, embeddedData, extractJson, extractScript, extractScripts, makeTempDir, readFormHtml, schema } from './helpers.mjs';

const LIB_DIR = path.join(CLIENT_ROOT, 'skill', 'everything-mapped', 'scripts', 'lib');
const html = readFormHtml();
const script = extractScript(html);

function capture() {
  const out = [];
  const err = [];
  return { io: { stdout: { write: (text) => out.push(text) }, stderr: { write: (text) => err.push(text) } }, out: () => out.join(''), err: () => err.join('') };
}

// The page without its scripts and style, to look at the markup itself.
function markupOnly(text) {
  return text.replace(/<script[\s\S]*?<\/script>/g, '<script></script>').replace(/<style[\s\S]*?<\/style>/g, '<style></style>');
}

test('the build is deterministic: the same input gives the same bytes', () => {
  const first = buildFormHtml();
  const second = buildFormHtml();
  assert.ok(first === second, 'two builds differ');
  assert.ok(!first.includes('\r'), 'LF line endings only');
  assert.ok(first.endsWith('</html>\n'));
});

test('the committed docs/form/index.html is what a fresh build gives', () => {
  const committed = fs.readFileSync(FORM_HTML, 'utf8').replace(/\r\n/g, '\n');
  assert.ok(committed === buildFormHtml(), 'docs/form/index.html is out of date: run node tools/build-form.mjs');
});

test('--check exits 0 when the file is current and 1 when it differs or is missing', async (t) => {
  const current = capture();
  assert.equal(await main(['--check'], current.io), 0);
  assert.match(current.out(), /is up to date/);

  const dir = makeTempDir(t);
  const target = path.join(dir, 'form', 'index.html');
  const missing = capture();
  assert.equal(await main(['--check', '--out', target], missing.io), 1);
  assert.match(missing.err(), /is out of date/);

  const written = capture();
  assert.equal(await main(['--out', target], written.io), 0);
  assert.ok(fs.readFileSync(target, 'utf8') === buildFormHtml(), 'the written file is the build');
  assert.match(written.out(), /^Wrote /);
  assert.equal(await main(['--check', '--out', target], capture().io), 0);

  fs.writeFileSync(target, `${fs.readFileSync(target, 'utf8')}<!-- edited -->\n`);
  const changed = capture();
  assert.equal(await main(['--check', '--out', target], changed.io), 1);
  assert.match(changed.err(), /node tools\/build-form\.mjs/);

  fs.writeFileSync(target, buildFormHtml().replace(/\n/g, '\r\n'));
  assert.equal(await main(['--check', '--out', target], capture().io), 0, 'CRLF from a checkout does not count as a difference');
});

test('the build tool reports bad arguments with exit code 2', async () => {
  for (const argv of [['--bogus'], ['--out'], ['stray']]) {
    const result = capture();
    assert.equal(await main(argv, result.io), 2, argv.join(' '));
    assert.match(result.err(), /Usage: node tools\/build-form\.mjs/);
  }
});

test('the file is smaller than 700 KB', () => {
  const bytes = Buffer.byteLength(html);
  assert.ok(bytes < 700 * 1024, `${bytes} bytes`);
});

test('the page has no external script, style, font, image or request of any kind', () => {
  const markup = markupOnly(html);
  const banned = ['<script src', '<link href', 'fetch(', 'XMLHttpRequest', '@import', 'url(http'];
  for (const text of banned) assert.ok(!html.includes(text), `the page contains ${text}`);
  const references = [...markup.matchAll(/\b(?:src|href|action|poster|srcset|data|formaction)\s*=\s*["']?([^"'\s>]*)/gi)].map((match) => match[1]);
  assert.deepEqual(references.filter((reference) => !reference.startsWith('data:')), [], 'only inline data: addresses');
  assert.ok(!/<(?:img|iframe|embed|object|video|audio|source|form|base)\b/i.test(markup));
  const code = script.replace(/\/\/.*$/gm, '');
  for (const pattern of [
    /\bfetch\s*\(/, /XMLHttpRequest/, /\bWebSocket\b/, /\bEventSource\b/, /sendBeacon/, /importScripts/, /\bnew\s+Worker\b/,
    /serviceWorker/, /\bimport\s*\(/, /\bimport\.meta\b/, /\beval\s*\(/, /new\s+Function\b/, /document\.write/, /\.innerHTML\b/,
    /\.outerHTML\b/, /insertAdjacentHTML/, /javascript:/, /\bnew\s+Image\b/, /\.src\s*=/, /\blocation\s*=/, /\blocation\.(?:href|assign|replace)/,
  ]) {
    assert.ok(!pattern.test(code), `the script uses ${pattern}`);
  }
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)[1].replace(/\/\*[\s\S]*?\*\//g, '');
  for (const pattern of [/url\(/, /@import/, /@font-face/, /gradient/i, /box-shadow/, /text-shadow/, /backdrop-filter/, /filter\s*:/]) {
    assert.ok(!pattern.test(style), `the style uses ${pattern}`);
  }
});

// The directives of the page's policy as { name: value }.
function policyOf(text) {
  const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(text)[1];
  return { policy, directives: Object.fromEntries(policy.split(';').map((part) => part.trim().split(/\s+(.*)/s).slice(0, 2))) };
}

function sha256Base64(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('base64');
}

test('the content security policy has no default, no unsafe-inline, and a hash for each inline script and style', () => {
  const { policy, directives } = policyOf(html);
  assert.equal(directives['default-src'], "'none'");
  for (const name of ['connect-src', 'font-src', 'media-src', 'object-src', 'frame-src', 'child-src', 'worker-src', 'manifest-src', 'base-uri', 'form-action']) {
    assert.equal(directives[name], "'none'", name);
  }
  assert.equal(directives['img-src'], 'data:', 'only the inline icon is a picture; blob: is not needed');
  assert.ok(!/unsafe-inline|unsafe-eval|https?:|\*/.test(policy), 'nothing is allowed by a keyword or an address');

  // What the browser hashes is the text between the tags. Compare with the page itself.
  const scripts = extractScripts(html);
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1]);
  assert.equal(scripts.length, 2, 'the small script that runs first, then the form script');
  assert.equal(styles.length, 1);
  assert.deepEqual(directives['script-src'].split(' '), scripts.map((text) => `'sha256-${sha256Base64(text)}'`));
  assert.deepEqual(directives['style-src'].split(' '), styles.map((text) => `'sha256-${sha256Base64(text)}'`));
  assert.ok(!/ on[a-z]+=|style="|javascript:/i.test(markupOnly(html)), 'no inline handler or style attribute that the hashes would not cover');
});

test('the build computes the policy from the inline texts and refuses text that would end a script', () => {
  assert.equal(cspHash('abc'), "'sha256-ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0='");
  const policy = contentSecurityPolicy(['one', 'two'], ['three']);
  assert.match(policy, /^default-src 'none'; script-src 'sha256-[^ ]+' 'sha256-[^ ]+'; style-src 'sha256-[^ ]+'; img-src data:;/);
  for (const bad of ['</script>', 'x </SCRIPT >', '<script>', 'a<Script src=x>']) {
    assert.throws(() => assertInlineSafe('script', bad, 'script'), /would end or confuse the script element/, bad);
  }
  assert.throws(() => assertInlineSafe('style sheet', 'a { } </style>', 'style'), /style element/);
  assert.doesNotThrow(() => assertInlineSafe('script', 'const a = "<b>" + "</div>";', 'script'));
});

test('a build whose form script contains a script tag fails', (t) => {
  const dir = makeTempDir(t);
  for (const name of [...FORM_SCRIPTS, FORM_STYLESHEET, 'rescue.js']) fs.copyFileSync(path.join(CLIENT_ROOT, 'tools', 'form', name), path.join(dir, name));
  assert.doesNotThrow(() => buildFormHtml({ formDir: dir }));
  fs.appendFileSync(path.join(dir, 'ui.js'), '\nconst closing = "</" + "div>"; // </script>\n');
  assert.throws(() => buildFormHtml({ formDir: dir }), /would end or confuse the script element/);
});

test('the head sets language, viewport, colour scheme and an inline icon', () => {
  const markup = markupOnly(html);
  assert.ok(markup.startsWith('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">'));
  assert.ok(markup.includes('<meta name="viewport" content="width=device-width, initial-scale=1">'));
  assert.ok(markup.includes('<meta name="color-scheme" content="light dark">'));
  assert.ok(markup.includes('<link rel="icon" href="data:,">'), 'no request for /favicon.ico');
  assert.equal((markup.match(/<title>/g) || []).length, 1);
  assert.equal((markup.match(/<div id="app"><\/div>/g) || []).length, 1);
  const { dictionaries } = embeddedData(html);
  for (const lang of ['da', 'en']) {
    assert.ok(markup.includes(`<p lang="${lang}">${dictionaries[lang]['ui.form.noscript']}</p>`), `${lang} text without JavaScript`);
    assert.ok(markup.includes(`<div lang="${lang}">\n<p>${dictionaries[lang]['ui.form.err.start']}</p>`), `${lang} text when the form cannot start`);
    assert.ok(markup.includes(`<button type="button" class="btn emfc-discard">${dictionaries[lang]['ui.form.privacy.clear']}</button>`), `${lang} button that clears saved data when the form cannot start`);
  }
  assert.equal((markup.match(/<div id="emfc-failed" hidden>/g) || []).length, 1);
});

test('the schema and the dictionaries are embedded as JSON: the texts, ui-check and ui-form files, merged as the library merges them', () => {
  const data = embeddedData(html);
  assert.deepEqual(data.schema, JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, 'intake-schema.json'), 'utf8')));
  assert.deepEqual(FORM_TEXT_FILES, ['texts', 'ui-check', 'ui-form']);
  for (const lang of ['da', 'en']) {
    const loaded = loadI18n(lang);
    const own = new Set(FORM_TEXT_FILES.flatMap((name) => Object.keys(JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, `${name}.${lang}.json`), 'utf8')))));
    const expectedKeys = loaded.keys().filter((key) => own.has(key));
    assert.deepEqual(Object.keys(data.dictionaries[lang]), expectedKeys, `${lang}: same keys, same order as loadI18n`);
    for (const key of expectedKeys) assert.equal(data.dictionaries[lang][key], loaded.t(key), `${lang} ${key}`);
    assert.ok(expectedKeys.length < loaded.keys().length, `${lang}: the installer's texts are left out`);
  }
  assert.equal(data.toolVersion, JSON.parse(fs.readFileSync(path.join(CLIENT_ROOT, 'package.json'), 'utf8')).version);
  for (const match of html.matchAll(/<script type="application\/json" id="[^"]+">([\s\S]*?)<\/script>/g)) {
    assert.ok(!match[1].includes('<'), 'no "<" inside a JSON block');
  }
});

test('the page holds no text key of the installer', () => {
  for (const prefix of ['ui.cli.', 'ui.install.', 'ui.pack.']) {
    assert.ok(!html.includes(`"${prefix}`), `a key starting with ${prefix} is in the page`);
  }
  for (const lang of ['da', 'en']) {
    const keys = Object.keys(embeddedData(html).dictionaries[lang]);
    assert.deepEqual(keys.filter((key) => /^ui\.(?:cli|install|pack)\./.test(key)), []);
  }
});

test('every question of the schema is in the embedded data with all its texts, in both languages', () => {
  const { schema: embedded, dictionaries } = embeddedData(html);
  const ids = schema.modules.flatMap((entry) => entry.questions.map((question) => question.id));
  const embeddedIds = embedded.modules.flatMap((entry) => entry.questions.map((question) => question.id));
  assert.deepEqual(embeddedIds, ids);
  assert.equal(ids.length, 97);
  for (const lang of ['da', 'en']) {
    for (const entry of embedded.modules) {
      assert.ok(dictionaries[lang][`module.${entry.id}.title`] && dictionaries[lang][`module.${entry.id}.intro`], `module ${entry.id}`);
      for (const question of entry.questions) {
        for (const part of ['label', 'ask', 'help', 'example']) assert.ok(dictionaries[lang][`q.${question.id}.${part}`], `${lang} q.${question.id}.${part}`);
        for (const choice of question.choices ?? []) assert.ok(dictionaries[lang][`choice.${question.id}.${choice}`], `${lang} choice ${question.id}.${choice}`);
      }
    }
    for (const key of ['level.gate1', 'level.gate1.short', 'level.recommended', 'level.optional', 'status.complete', 'status.partial', 'status.tbd', 'depth.essentials', 'depth.standard', 'depth.full']) {
      assert.ok(dictionaries[lang][key], `${lang} ${key}`);
    }
  }
});

test('the script holds the six library modules in a fixed order, then the form sources, as plain script text', () => {
  const marks = [...LIBRARY_MODULES.map((name) => `${name}.mjs`), ...FORM_SCRIPTS].map((name) => script.indexOf(`// ---- ${name} ----`));
  assert.ok(marks.every((position) => position >= 0), 'every part is there');
  assert.deepEqual(marks, [...marks].sort((a, b) => a - b), 'in the fixed order');
  assert.deepEqual(LIBRARY_MODULES, ['util', 'i18n-core', 'rules', 'parse', 'render', 'validate']);
  assert.ok(!/^\s*(?:import|export)\b/m.test(script), 'no import or export keyword is left');
  assert.ok(!/['"]node:/.test(script));
  assert.ok(script.startsWith("(function () {\n'use strict';"));
  assert.ok(script.endsWith('})();'));
  for (const name of ['makeI18n', 'renderFile', 'renderAssets', 'renderOpenQuestions', 'parseFile', 'parseAssets', 'validatePackData', 'manifestCompleteness', 'entryFromInput', 'effectiveLevel']) {
    assert.ok(script.includes(`function ${name}(`), `${name} is inlined`);
  }
  assert.doesNotThrow(() => new vm.Script(script), 'the script compiles');
});

test('the inlined library is the library on disk: every exported name of the six modules is declared once', () => {
  for (const name of LIBRARY_MODULES) {
    const source = fs.readFileSync(path.join(LIB_DIR, `${name}.mjs`), 'utf8');
    for (const match of source.matchAll(/^export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) {
      const declared = new RegExp(`^(?:async\\s+)?(?:function\\*?|class|const|let|var)\\s+${match[1].replace(/\$/g, '\\$')}\\b`, 'gm');
      assert.equal((script.match(declared) || []).length, 1, `${match[1]} from ${name}.mjs`);
    }
  }
});

test('stripModuleSyntax drops imports and the export keyword and nothing else', () => {
  const source = [
    "// header: no node: imports, no process, no Buffer",
    "import { a, b } from './util.mjs';",
    'import {',
    '  c,',
    '  d,',
    "} from './rules.mjs';",
    '',
    'export const X = 1;',
    'export function f() { return a; }',
    'export async function g() {}',
    'export class H {}',
    'const kept = 2;',
    '',
  ].join('\n');
  const result = stripModuleSyntax(source, 'sample.mjs');
  assert.ok(!/^import\b/m.test(result) && !/^export\b/m.test(result));
  assert.ok(result.includes('const X = 1;') && result.includes('function f()') && result.includes('async function g()') && result.includes('class H'));
  assert.ok(result.includes('const kept = 2;') && result.includes('// header'));
  assert.ok(!result.includes('c,\n  d,'));
  assert.equal(stripModuleSyntax(source.replace(/\n/g, '\r\n'), 'crlf.mjs'), result);
});

test('stripModuleSyntax refuses what cannot run in a browser script', () => {
  const refuse = (source, pattern) => assert.throws(() => stripModuleSyntax(source, 'bad.mjs'), pattern, source);
  refuse("import fs from 'node:fs';\nexport const x = fs;", /may only import each other/);
  refuse("import { x } from './zip.mjs';", /may only import each other/);
  refuse("import { x } from '../other.mjs';", /may only import each other/);
  refuse('export default function f() {}', /export form/);
  refuse('const a = 1;\nexport { a };', /export form/);
  refuse("export * from './util.mjs';", /export form|import/);
  refuse("import './util.mjs';\nexport const x = 1;", /import/);
  refuse('export const x = () => import("./y.mjs");', /import/);
  refuse('export const x = process.argv;', /Node global/);
  refuse('export const x = Buffer.from("a");', /Node global/);
  refuse('export const x = import.meta.url;', /only works in Node/);
  refuse("export const x = require('fs');", /only works in Node/);
});

test('two parts that declare the same name are refused', (t) => {
  const dir = makeTempDir(t);
  fs.writeFileSync(path.join(dir, 'clash.js'), 'function oneLine() {}\n');
  fs.writeFileSync(path.join(dir, 'fine.js'), 'function somethingNew() {}\n');
  assert.throws(() => buildScript({ formDir: dir, scripts: ['clash.js'] }), /oneLine is declared in both util\.mjs and clash\.js/);
  assert.doesNotThrow(() => buildScript({ formDir: dir, scripts: ['fine.js'] }));
  fs.writeFileSync(path.join(dir, 'second.js'), 'const somethingNew = 1;\n');
  assert.throws(() => buildScript({ formDir: dir, scripts: ['fine.js', 'second.js'] }), /somethingNew is declared in both fine\.js and second\.js/);
});

test('the page code is written so the script can run without a document', () => {
  const sandbox = { window: {} };
  vm.runInNewContext(script, sandbox);
  assert.equal(typeof sandbox.window.__emfc.createEngine, 'function');
  assert.equal(typeof sandbox.window.__emfc.startForm, 'function');
  assert.equal(sandbox.window.__emfc.app, undefined);
  const bare = {};
  vm.runInNewContext(script, bare);
  assert.equal(typeof bare.__emfc.createEngine, 'function', 'the global object is used when there is no window');
});

test('the style sheet and the page sources are where the build looks for them', () => {
  for (const file of [...FORM_SCRIPTS, FORM_STYLESHEET]) assert.ok(fs.existsSync(path.join(CLIENT_ROOT, 'tools', 'form', file)), file);
  assert.ok(extractJson(html, 'emfc-config').toolVersion);
});

test('the form sources and its own texts contain no e-mail address', () => {
  const files = [
    ...FORM_SCRIPTS.map((file) => path.join(CLIENT_ROOT, 'tools', 'form', file)),
    path.join(CLIENT_ROOT, 'tools', 'form', FORM_STYLESHEET),
    path.join(CLIENT_ROOT, 'tools', 'build-form.mjs'),
    path.join(SCHEMA_DIR, 'ui-form.da.json'),
    path.join(SCHEMA_DIR, 'ui-form.en.json'),
  ];
  for (const file of files) {
    assert.ok(!/[\w.+-]+@[\w-]+\.[\w.]+/.test(fs.readFileSync(file, 'utf8')), `${path.basename(file)}: e-mail address`);
  }
});
