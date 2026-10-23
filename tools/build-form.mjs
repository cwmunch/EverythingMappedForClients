#!/usr/bin/env node
// Builds docs/form/index.html: the static form that lets a client answer the intake in a browser
// and download the same pack the interviewer writes.
//
//   node tools/build-form.mjs                 write docs/form/index.html
//   node tools/build-form.mjs --check         exit 1 when the committed file differs from a fresh build
//   node tools/build-form.mjs --out <file>    write (or, with --check, compare) another file
//
// The page is one self-contained file: the stylesheet, the schema and both dictionaries as JSON,
// and one script made of the six pure library modules (util, i18n-core, rules, parse, render,
// validate) followed by the form's own source files in tools/form/. The output depends only on
// the input files, so the same input always gives the same bytes.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadI18n } from '../skill/everything-mapped/scripts/lib/i18n.mjs';
import { TOOL_VERSION } from '../skill/everything-mapped/scripts/lib/manifest.mjs';
import { DEFAULT_SCHEMA_DIR, loadSchema } from '../skill/everything-mapped/scripts/lib/schema.mjs';

export const CLIENT_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
export const LIBRARY_DIR = path.join(CLIENT_ROOT, 'skill', 'everything-mapped', 'scripts', 'lib');
export const FORM_SOURCE_DIR = path.join(CLIENT_ROOT, 'tools', 'form');
export const DEFAULT_OUTPUT = path.join(CLIENT_ROOT, 'docs', 'form', 'index.html');

// The order matters: a module may only use what the modules before it define.
export const LIBRARY_MODULES = ['util', 'i18n-core', 'rules', 'parse', 'render', 'validate'];
export const FORM_SCRIPTS = ['engine.js', 'ui.js'];
export const FORM_STYLESHEET = 'style.css';
export const FORM_RESCUE_SCRIPT = 'rescue.js';

// ---------------------------------------------------------------------------------------------
// The Content-Security-Policy

// The CSP value for an inline element is the hash of its exact text, so the page may run its own
// script and style and nothing else.
export function cspHash(text) {
  return `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
}

// Nothing may be fetched, framed, embedded or sent: every kind of load falls back to 'none'. Only
// the inline script and style (by hash) and the inline icon (a data: address, which browsers check
// against img-src) are allowed. The page shows no picture from a blob, so blob: is not listed.
// Navigation is not restricted by these rules, so the browser can still save the zip it is handed.
export function contentSecurityPolicy(scriptTexts, styleTexts) {
  return [
    "default-src 'none'",
    `script-src ${scriptTexts.map(cspHash).join(' ')}`,
    `style-src ${styleTexts.map(cspHash).join(' ')}`,
    'img-src data:',
    "connect-src 'none'",
    "font-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

// Inline code must not hold text that the HTML parser reads as the end of its element.
export function assertInlineSafe(name, text, tag) {
  const closing = tag === 'style' ? /<\/style/i : /<\/?script/i;
  if (closing.test(text)) throw new Error(`The inlined ${name} contains "<${tag === 'style' ? '/style' : 'script'}" or a closing tag, which would end or confuse the ${tag} element.`);
}

const IMPORT_STATEMENT = /^import\s[\s\S]*?\sfrom\s+(['"])([^'"]+)\1;?[ \t]*(?:\n|$)/gm;
const EXPORT_KEYWORD = /^export\s+(?=(?:async\s+function|function|class|const|let|var)\b)/gm;
const TOP_LEVEL_NAME = /^(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;

// ---------------------------------------------------------------------------------------------
// Inlining the library

function codeLines(text) {
  return text.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
}

// Turns one ES module of the library into plain script text: its imports are dropped (the other
// modules share one scope after inlining) and so is the `export` keyword. Anything that would not
// work in a browser script is an error.
export function stripModuleSyntax(source, name) {
  const text = source.replace(/\r\n?/g, '\n');
  const imported = [];
  const withoutImports = text.replace(IMPORT_STATEMENT, (whole, quote, from) => {
    imported.push(from);
    return '';
  });
  for (const from of imported) {
    const base = path.posix.basename(from, '.mjs');
    if (!from.startsWith('./') || !LIBRARY_MODULES.includes(base)) {
      throw new Error(`${name} imports ${from}. The pure modules may only import each other.`);
    }
  }
  const code = codeLines(withoutImports);
  if (/^\s*import\b/m.test(code) || /\bimport\s*\(/.test(code)) throw new Error(`${name} has an import this build cannot inline.`);
  if (/^export\s+(?:default|\{|\*)/m.test(code)) throw new Error(`${name} has an export form this build cannot inline.`);
  if (/\bimport\.meta\b|\brequire\s*\(|['"]node:/.test(code)) throw new Error(`${name} uses something that only works in Node.`);
  if (/(?<![\w.$])(?:process|Buffer)\b/.test(code)) throw new Error(`${name} uses a Node global (process or Buffer).`);
  return withoutImports.replace(EXPORT_KEYWORD, '').replace(/\s+$/, '\n');
}

function readSource(directory, file) {
  return fs.readFileSync(path.join(directory, file), 'utf8').replace(/^﻿/, '');
}

function topLevelNames(text) {
  return [...text.matchAll(TOP_LEVEL_NAME)].map((match) => match[1]);
}

// One name must not be declared in two parts, because all parts share one scope.
function assertNoDuplicateNames(parts) {
  const owner = new Map();
  for (const part of parts) {
    for (const name of topLevelNames(part.text)) {
      if (owner.has(name)) throw new Error(`The name ${name} is declared in both ${owner.get(name)} and ${part.name}.`);
      owner.set(name, part.name);
    }
  }
}

// The script of the page: the library modules, then the form sources, in one function scope.
export function buildScript(options = {}) {
  const libraryDir = options.libraryDir ?? LIBRARY_DIR;
  const formDir = options.formDir ?? FORM_SOURCE_DIR;
  const parts = [
    ...LIBRARY_MODULES.map((module) => ({
      name: `${module}.mjs`,
      text: stripModuleSyntax(readSource(libraryDir, `${module}.mjs`), `${module}.mjs`),
    })),
    ...(options.scripts ?? FORM_SCRIPTS).map((file) => ({ name: file, text: readSource(formDir, file).replace(/\r\n?/g, '\n') })),
  ];
  assertNoDuplicateNames(parts);
  const body = parts.map((part) => `// ---- ${part.name} ----\n${part.text.replace(/\s+$/, '')}\n`).join('\n');
  return `(function () {\n'use strict';\n\n${body}\n})();`;
}

// ---------------------------------------------------------------------------------------------
// The page

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const LINE_SEPARATOR = new RegExp(String.fromCharCode(0x2028), 'g');
const PARAGRAPH_SEPARATOR = new RegExp(String.fromCharCode(0x2029), 'g');

// JSON that can sit inside a script element: no "<" (so no closing tag or comment start) and no
// line separators that older engines treat as line ends.
function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(LINE_SEPARATOR, '\\u2028').replace(PARAGRAPH_SEPARATOR, '\\u2029');
}

function jsonBlock(id, value) {
  return `<script type="application/json" id="${id}">${jsonForScript(value)}</script>`;
}

// The text files the form reads. The installer's texts (ui-cli) are of no use in a client form.
export const FORM_TEXT_FILES = ['texts', 'ui-check', 'ui-form'];

// The union of the text files the form reads, merged the way loadI18n merges all of them (it also
// stops on an unreadable file or a key that is defined twice).
export function loadDictionary(lang, schemaDir = DEFAULT_SCHEMA_DIR) {
  const i18n = loadI18n(lang, schemaDir);
  const wanted = new Set();
  for (const name of FORM_TEXT_FILES) {
    const file = path.join(schemaDir, `${name}.${lang}.json`);
    if (fs.existsSync(file)) for (const key of Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')))) wanted.add(key);
  }
  return Object.fromEntries(i18n.keys().filter((key) => wanted.has(key)).map((key) => [key, i18n.t(key)]));
}

export function loadFormData(schemaDir = DEFAULT_SCHEMA_DIR) {
  const schema = loadSchema(path.join(schemaDir, 'intake-schema.json'));
  const dictionaries = Object.fromEntries(schema.languages.map((lang) => [lang, loadDictionary(lang, schemaDir)]));
  // The key the form saves under: named after the schema version, because pages of other projects can
  // share the same browser storage.
  return { schema, dictionaries, toolVersion: TOOL_VERSION, storageKey: `emfc.${schema.schema}.form` };
}

// One paragraph per language, from the text files.
function messageParagraphs(data, key) {
  return data.schema.languages.map((lang) => `<p lang="${lang}">${escapeHtml(data.dictionaries[lang][key] ?? '')}</p>`).join('\n');
}

function noscriptBlock(data) {
  return `<noscript>\n${messageParagraphs(data, 'ui.form.noscript')}\n</noscript>`;
}

// Shown when the form cannot start: the message and a button that removes the saved data, in each
// language, with the question it asks first (data-confirm). The button is wired by rescue.js, which
// does not depend on the form's script.
function failureBlock(data) {
  const sections = data.schema.languages.map((lang) => {
    const message = escapeHtml(data.dictionaries[lang]['ui.form.err.start'] ?? '');
    const button = escapeHtml(data.dictionaries[lang]['ui.form.privacy.clear'] ?? '');
    const question = escapeHtml(data.dictionaries[lang]['ui.form.privacy.confirm'] ?? '');
    return `<div lang="${lang}">\n<p>${message}</p>\n<p><button type="button" class="btn emfc-discard" data-confirm="${question}">${button}</button></p>\n</div>`;
  });
  return `<div id="emfc-failed" hidden>\n${sections.join('\n')}\n</div>`;
}

// The complete HTML of the form. options: { schemaDir, libraryDir, formDir, scripts }.
export function buildFormHtml(options = {}) {
  const formDir = options.formDir ?? FORM_SOURCE_DIR;
  const data = loadFormData(options.schemaDir);
  const style = readSource(formDir, FORM_STYLESHEET).replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  const rescue = readSource(formDir, FORM_RESCUE_SCRIPT).replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  const script = buildScript(options);
  assertInlineSafe('script', script, 'script');
  assertInlineSafe('rescue script', rescue, 'script');
  assertInlineSafe('style sheet', style, 'style');
  // What the browser hashes is the text between the tags, line breaks included.
  const inline = (text) => `\n${text}\n`;
  const policy = contentSecurityPolicy([inline(rescue), inline(script)], [inline(style)]);
  const lines = [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    `<meta http-equiv="Content-Security-Policy" content="${policy}">`,
    '<meta name="referrer" content="no-referrer">',
    '<link rel="icon" href="data:,">',
    `<title>${escapeHtml(data.dictionaries.en['ui.form.title'] ?? '')}</title>`,
    `<style>${inline(style)}</style>`,
    '</head>',
    '<body>',
    '<div id="app"></div>',
    failureBlock(data),
    noscriptBlock(data),
    jsonBlock('emfc-schema', data.schema),
    ...data.schema.languages.map((lang) => jsonBlock(`emfc-texts-${lang}`, data.dictionaries[lang])),
    jsonBlock('emfc-config', { toolVersion: data.toolVersion, storageKey: data.storageKey }),
    `<script>${inline(rescue)}</script>`,
    `<script>${inline(script)}</script>`,
    '</body>',
    '</html>',
  ];
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------
// Command line

function parseOptions(argv) {
  const options = { check: false, out: DEFAULT_OUTPUT, problems: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check') options.check = true;
    else if (arg === '--out' && index + 1 < argv.length) options.out = path.resolve(argv[(index += 1)]);
    else options.problems.push(arg === '--out' ? 'The option --out needs a file name.' : `Unknown argument: ${arg}`);
  }
  return options;
}

function readIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
  } catch {
    return null;
  }
}

// Returns the exit code: 0 done or up to date, 1 --check found a difference, 2 usage error, 3 the build failed.
export async function main(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  const options = parseOptions(argv);
  if (options.problems.length > 0) {
    for (const problem of options.problems) io.stderr.write(`${problem}\n`);
    io.stderr.write('Usage: node tools/build-form.mjs [--check] [--out <file>]\n');
    return 2;
  }
  let html;
  try {
    html = buildFormHtml();
  } catch (error) {
    io.stderr.write(`Cannot build the form: ${error.message}\n`);
    return 3;
  }
  if (options.check) {
    if (readIfExists(options.out) === html) {
      io.stdout.write(`${path.relative(process.cwd(), options.out)} is up to date.\n`);
      return 0;
    }
    io.stderr.write(`${path.relative(process.cwd(), options.out)} is out of date. Run: node tools/build-form.mjs\n`);
    return 1;
  }
  fs.mkdirSync(path.dirname(options.out), { recursive: true });
  fs.writeFileSync(options.out, html, 'utf8');
  io.stdout.write(`Wrote ${path.relative(process.cwd(), options.out)} (${Buffer.byteLength(html)} bytes).\n`);
  return 0;
}

function isMainModule() {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainModule()) process.exitCode = await main(process.argv.slice(2));
