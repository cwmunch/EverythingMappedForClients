// Shared helpers for the form tests: loading the built page's script in a node:vm context, sample
// answers (as the form keeps them and as answer.mjs would receive them) and unzipping a pack.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { applyAnswers, loadI18n, loadSchema, refreshPack, renderAssets } from '../../skill/everything-mapped/scripts/lib/index.mjs';
import { unzip } from '../cli/unzip.mjs';

export const CLIENT_ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
export const FORM_HTML = path.join(CLIENT_ROOT, 'docs', 'form', 'index.html');
export const SCHEMA_DIR = path.join(CLIENT_ROOT, 'skill', 'everything-mapped', 'schema');

// A fixed moment in the middle of a day, so the local date is the same in every time zone.
export const NOW = new Date('2026-10-23T12:00:00Z');
export const TODAY = '2026-10-23';
export const NOW_STAMP = '2026-10-23T12:00:00Z';

export const schema = loadSchema();

export function readFormHtml() {
  return fs.readFileSync(FORM_HTML, 'utf8');
}

// The executable scripts of the page (the ones without a type), as the browser reads them: the text
// between the tags. There are two: the small one that runs first, then the form's script.
export function extractScripts(html) {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
}

// The form's own script: the last one.
export function extractScript(html) {
  const scripts = extractScripts(html);
  if (scripts.length === 0) throw new Error('The page has no main script.');
  return scripts[scripts.length - 1].replace(/^\n/, '').replace(/\n$/, '');
}

export function extractJson(html, id) {
  const match = new RegExp(`<script type="application/json" id="${id}">([\\s\\S]*?)</script>`).exec(html);
  if (!match) throw new Error(`The page has no JSON block ${id}.`);
  return JSON.parse(match[1]);
}

export function embeddedData(html = readFormHtml()) {
  const parsed = extractJson(html, 'emfc-schema');
  const dictionaries = {};
  for (const lang of parsed.languages) dictionaries[lang] = extractJson(html, `emfc-texts-${lang}`);
  const config = extractJson(html, 'emfc-config');
  return { schema: parsed, dictionaries, toolVersion: config.toolVersion, storageKey: config.storageKey };
}

// Runs the page's script in a fresh context that has no document, like a script that is only
// asked for its logic. Returns { emfc, data, engine, window, context }.
export function loadBrowserScript(options = {}) {
  const html = options.html ?? readFormHtml();
  const window = options.window ?? {};
  const sandbox = { window, console: options.console ?? console };
  if (options.document) sandbox.document = options.document;
  if (options.compression !== false) sandbox.CompressionStream = CompressionStream;
  if (options.crypto) sandbox.crypto = options.crypto;
  const context = vm.createContext(sandbox);
  vm.runInContext(extractScript(html), context, { filename: 'form-script.js' });
  const data = embeddedData(html);
  return { emfc: window.__emfc, data, engine: window.__emfc.createEngine(data), window, context };
}

// Plain data that crossed from the script's context: same values, this context's objects.
export function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

// The bytes of a Blob made by the page (the stand-in Blob keeps the pieces it was given).
export function blobBytes(blob) {
  const pieces = blob.parts.map((piece) => (typeof piece === 'string' ? Buffer.from(piece, 'utf8') : Buffer.from(piece)));
  return Buffer.concat(pieces);
}

export function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emfc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// name -> Buffer for every file of a zip made by the form.
export function unzipPack(bytes) {
  const entries = unzip(Buffer.from(bytes));
  return new Map([...entries].map(([name, entry]) => [name, entry.data]));
}

export function textOfEntry(entries, name) {
  if (!entries.has(name)) throw new Error(`The pack has no ${name}.`);
  return entries.get(name).toString('utf8');
}

// name -> Buffer for every file below root/docs, as the interviewer's scripts leave it.
export function readDocsTree(root) {
  const files = new Map();
  const visit = (directory, prefix) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) visit(path.join(directory, entry.name), `${relative}/`);
      else files.set(relative, fs.readFileSync(path.join(directory, entry.name)));
    }
  };
  visit(path.join(root, 'docs'), 'docs/');
  return files;
}

// ---------------------------------------------------------------------------------------------
// Sample answers

export const RESPONDENT = { name: 'Anna Jensen', role: 'Marketing' };
export const LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>';

const LONG_TEXT = 'Nordlys Cykler sælger og reparerer cykler i Aarhus, og vi vil gerne have flere private kunder.';

// Each entry: the id, how the form keeps the answer (`form`, merged into the question's record)
// and the same answer as answer.mjs takes it (`input`). Every question type is in here, in
// schema order. `files` lists attached files for a files question.
export const SAMPLE = [
  { id: 'A.business', form: { text: `${LONG_TEXT}\n\n# En overskrift i svaret\nVi har to butikker.` }, input: { text: `${LONG_TEXT}\n\n# En overskrift i svaret\nVi har to butikker.` } },
  { id: 'A.project-kind', form: { choice: ['redesign'], note: 'Siden er fra 2014.' }, input: { choice: ['redesign'], note: 'Siden er fra 2014.' } },
  {
    id: 'A.existing-site',
    form: { items: [{ text: 'https://nordlys-cykler.example', note: 'Den nuværende side | med pipe' }, { text: '', note: '' }] },
    input: { items: [{ text: 'https://nordlys-cykler.example', note: 'Den nuværende side | med pipe' }] },
  },
  { id: 'A.goal', form: { text: 'At få flere henvendelser fra private kunder, så vi kan fylde kalenderen to måneder frem.' }, input: { text: 'At få flere henvendelser fra private kunder, så vi kan fylde kalenderen to måneder frem.' } },
  {
    id: 'A.metrics',
    form: { items: [{ text: 'Henvendelser pr. måned', note: 'ignoreres for lister' }, { text: 'Salg A | B', note: '' }] },
    input: { items: [{ text: 'Henvendelser pr. måned' }, { text: 'Salg A | B' }] },
  },
  { id: 'A.deadline', form: { date: '2026-12-01', note: 'Før julesalget' }, input: { date: '2026-12-01', note: 'Før julesalget' } },
  { id: 'A.budget', form: { text: '150.000 kr.' }, input: { text: '150.000 kr.' } },
  { id: 'A.stakeholders', form: { unknown: true, owner: 'other', ownerName: 'Peter Holm', due: '2026-11-12', tbdNote: 'Spørg ejeren' }, input: { status: 'tbd', owner: 'Peter Holm', due: '2026-11-12', note: 'Spørg ejeren' } },
  { id: 'B.name', form: { text: 'Nordlys Cykler' }, input: { text: 'Nordlys Cykler' } },
  { id: 'B.assets-status', form: { choice: ['partial'] }, input: { choice: ['partial'] } },
  {
    id: 'B.logo',
    files: [{ name: 'logo.svg', text: LOGO_SVG, what: 'Hovedlogo', owner: 'Nordlys Cykler', rights: 'Ejes af os', restrictions: 'Ingen' }],
    input: { items: [{ text: 'assets/logo.svg', note: 'Hovedlogo' }] },
  },
  { id: 'D.languages', form: { choice: ['da', 'en'] }, input: { choice: ['da', 'en'] } },
  { id: 'I.domain', form: { unknown: true, owner: 'client', due: '2026-11-05', tbdNote: 'Spørg IT-afdelingen' }, input: { status: 'tbd', owner: 'client', due: '2026-11-05', note: 'Spørg IT-afdelingen' } },
  { id: 'I.hosting', form: { unknown: true, owner: 'me' }, input: { status: 'tbd', owner: RESPONDENT.name } },
];

export function sampleInputs(sample = SAMPLE) {
  return sample.map((item) => ({ id: item.id, status: 'complete', ...item.input }));
}

// Puts the sample into a form state made by the engine.
export function fillSample(engine, state, sample = SAMPLE) {
  state.respondent = { ...RESPONDENT };
  for (const item of sample) {
    if (item.form) Object.assign(engine.record(state, item.id), item.form);
    for (const file of item.files ?? []) {
      const asset = engine.addAsset(state, item.id, { name: file.name, data: new Uint8Array(Buffer.from(file.text)) });
      Object.assign(asset, { what: file.what, owner: file.owner, rights: file.rights, restrictions: file.restrictions });
    }
  }
  return state;
}

export function newSampleState(engine, language = 'da', sample = SAMPLE) {
  const state = engine.newState({ language, now: NOW });
  return fillSample(engine, state, sample);
}

// A form state and the matching answer.mjs inputs for every question of the schema (all visible
// when the project is a redesign), with content that satisfies every rule of the schema.
export function fullSample() {
  const sample = [];
  for (const entry of schema.modules) {
    for (const question of entry.questions) sample.push(fullAnswer(question));
  }
  return sample;
}

function fullAnswer(question) {
  const id = question.id;
  const minItems = Math.max(3, (question.rules && question.rules.minItems) || 0);
  const items = Array.from({ length: minItems }, (unused, index) => `Punkt ${index + 1} til ${id}`);
  const links = Array.from({ length: minItems }, (unused, index) => ({ text: `https://example.com/${id}/${index + 1}`, note: `Note ${index + 1}` }));
  switch (question.type) {
    case 'text':
      return { id, form: { text: `Svar på ${id}` }, input: { text: `Svar på ${id}` } };
    case 'longtext':
      return { id, form: { text: `${LONG_TEXT} (${id})` }, input: { text: `${LONG_TEXT} (${id})` } };
    case 'list':
      return { id, form: { items: items.map((text) => ({ text, note: '' })) }, input: { items: items.map((text) => ({ text })) } };
    case 'urllist':
      return { id, form: { items: links }, input: { items: links } };
    case 'date':
      return { id, form: { date: '2027-01-15', note: `Note til ${id}` }, input: { date: '2027-01-15', note: `Note til ${id}` } };
    case 'files':
      return {
        id,
        files: [{ name: `${id}.txt`, text: `Indhold ${id}`, what: 'En fil', owner: 'Os', rights: 'Ejes af os', restrictions: 'Ingen' }],
        input: { items: [{ text: `assets/${id}.txt`, note: 'En fil' }] },
      };
    default:
      return chosen(question);
  }
}

function chosen(question) {
  const choices = question.choices;
  if (question.id === 'A.project-kind') return { id: question.id, form: { choice: ['redesign'] }, input: { choice: ['redesign'] } };
  const picked = question.type === 'multichoice' ? choices.slice(0, 2) : [choices[0]];
  return { id: question.id, form: { choice: picked, note: `Note til ${question.id}` }, input: { choice: picked, note: `Note til ${question.id}` } };
}

// The files a sample attaches, as { name, text, what, owner, rights, restrictions }.
export function sampleAttachments(sample = SAMPLE) {
  return sample.flatMap((item) => item.files ?? []);
}

// Runs the real interviewer into a fresh folder and returns the docs tree: applyAnswers for the
// answers, then what the assets script does for attached files (the files, their table and a
// refresh of the generated files). options: { language, depth, respondent, recipient?, attachments? }.
export function interviewerTree(t, inputs, options) {
  const root = makeTempDir(t);
  const i18n = loadI18n(options.language);
  const input = {
    language: options.language,
    depth: options.depth,
    respondent: options.respondent,
    recipient: options.recipient ?? '',
    answers: inputs,
  };
  applyAnswers(root, input, { now: NOW, today: TODAY, i18n });
  const attachments = options.attachments ?? [];
  if (attachments.length > 0) {
    fs.mkdirSync(path.join(root, 'docs', 'assets'), { recursive: true });
    for (const file of attachments) fs.writeFileSync(path.join(root, 'docs', 'assets', file.name), file.text);
    const rows = attachments.map((file) => ({ file: `assets/${file.name}`, what: file.what, owner: file.owner, rights: file.rights, restrictions: file.restrictions }));
    fs.writeFileSync(path.join(root, 'docs', 'assets.md'), renderAssets(rows, i18n));
    refreshPack(root, { now: NOW, today: TODAY, i18n });
  }
  return readDocsTree(root);
}
