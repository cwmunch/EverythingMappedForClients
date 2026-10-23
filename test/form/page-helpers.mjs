// Helpers for tests that run the page code against the stand-in browser: opening a form (also
// two of them over one storage, like two tabs), typing, picking, waiting, finding buttons.

import assert from 'node:assert/strict';
import { FakeDocument, createFakeWindow, createMemoryStorage, findAll } from './fake-dom.mjs';
import { loadBrowserScript } from './helpers.mjs';

export const loaded = loadBrowserScript();
export const { emfc, data, engine } = loaded;
export const library = emfc.library;
export const KEY = data.storageKey;

export function fill(template, params = {}) {
  return template.replace(/\{(\w+)\}/g, (whole, name) => (name in params ? String(params[name]) : whole));
}

export function text(lang, key, params) {
  assert.ok(Object.hasOwn(data.dictionaries[lang], key), `missing text ${key} in ${lang}`);
  return fill(data.dictionaries[lang][key], params);
}

// A page with the form started in it. options go to the stand-in window; `emfc` and `data` replace
// the script and the embedded data.
export function openForm(options = {}) {
  const doc = new FakeDocument();
  const root = doc.createElement('div');
  root.setAttribute('id', 'app');
  doc.body.appendChild(root);
  const fake = createFakeWindow(options);
  const app = (options.emfc ?? emfc).startForm(doc, fake.win, options.data ?? data);
  return { app, doc, root, fake };
}

// Two pages over one storage, as two tabs of one browser are. Events of the storage are not sent
// by themselves: a test fires them (see tellOthers).
export function openTwo(options = {}) {
  const storage = options.storage ?? createMemoryStorage();
  return { storage, first: openForm({ ...options, storage }), second: openForm({ ...options, storage }) };
}

// What the browser does when the storage is changed in one tab: the other tabs get a "storage" event.
export function tellOthers(page, key = KEY) {
  page.fake.fire('storage', { key });
}

export function typeInto(field, value) {
  field.value = value;
  field.fire('input');
}

export function pick(input, checked = true) {
  input.checked = checked;
  input.fire('change');
}

export function part(page, id) {
  return page.app.parts.get(id);
}

export function inputsOf(root, type) {
  return findAll(root, (element) => element.localName === 'input' && element.getAttribute('type') === type);
}

export function buttonByText(root, label) {
  const found = findAll(root, (element) => element.localName === 'button' && element.textContent === label);
  assert.ok(found.length >= 1, `no button "${label}"`);
  return found[0];
}

export function hasButton(root, label) {
  return findAll(root, (element) => element.localName === 'button' && element.textContent === label && !element.hidden).length > 0;
}

export async function until(condition, what) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

// Types into the first text question and lets the page save.
export function answerGoal(page, value = 'At få flere henvendelser fra private kunder.') {
  typeInto(part(page, 'A.goal').focus(), value);
  return value;
}

export function savedText(storage) {
  return storage.getItem(KEY);
}

export function saved(storage) {
  const raw = storage.getItem(KEY);
  return raw === null ? null : JSON.parse(raw);
}
