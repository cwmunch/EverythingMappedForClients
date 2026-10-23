// Loading the text files from disk (FORMAT.md section 10).

import fs from 'node:fs';
import path from 'node:path';
import { makeI18n } from './i18n-core.mjs';
import { DEFAULT_SCHEMA_DIR } from './schema.mjs';

export const LANGUAGES = ['da', 'en'];

function readDictionary(filePath) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`Cannot read the text file ${filePath}: ${error.message}`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error(`The text file ${filePath} must be one flat JSON object.`);
  }
  for (const [key, value] of Object.entries(data)) {
    if (typeof value !== 'string') throw new Error(`The text file ${filePath} has a non-text value for "${key}".`);
  }
  return data;
}

// The union of every `*.<lang>.json` file in dir, in alphabetical order. A key defined in two
// files is an error.
export function loadI18n(lang, dir = DEFAULT_SCHEMA_DIR) {
  const suffix = `.${lang}.json`;
  const names = fs.readdirSync(dir).filter((name) => name.endsWith(suffix)).sort();
  if (names.length === 0) throw new Error(`No text files for the language "${lang}" in ${dir}.`);
  const dict = {};
  const definedIn = {};
  for (const name of names) {
    for (const [key, value] of Object.entries(readDictionary(path.join(dir, name)))) {
      if (Object.hasOwn(dict, key)) throw new Error(`The text key "${key}" is defined in both ${definedIn[key]} and ${name}.`);
      dict[key] = value;
      definedIn[key] = name;
    }
  }
  return makeI18n(dict, lang);
}

// --lang, else the language of the pack, else LC_ALL / LANG starting with "da", else English.
export function resolveLanguage({ lang, packLanguage, env = {} }) {
  if (lang) return lang;
  if (LANGUAGES.includes(packLanguage)) return packLanguage;
  const locale = env.LC_ALL || env.LANG || '';
  return locale.toLowerCase().startsWith('da') ? 'da' : 'en';
}
