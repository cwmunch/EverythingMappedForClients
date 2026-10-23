// Loads the command line texts (ui-cli.<lang>.json) and fills in {placeholders}.
// The installer does not depend on the pack library, so it reads its own file.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

export const DEFAULT_SCHEMA_DIR = path.join(packageRoot, 'skill', 'everything-mapped', 'schema');

export function fillPlaceholders(template, params = {}) {
  return template.replace(/\{(\w+)\}/g, (whole, name) =>
    Object.hasOwn(params, name) ? String(params[name]) : whole,
  );
}

// Returns { lang, t(key, params), has(key), keys() }. An unknown key returns the key itself,
// so a missing text never stops a command; a test checks that no key is missing.
export function loadText(lang, schemaDir = DEFAULT_SCHEMA_DIR) {
  const file = path.join(schemaDir, `ui-cli.${lang}.json`);
  const dictionary = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    lang,
    t: (key, params) =>
      Object.hasOwn(dictionary, key) ? fillPlaceholders(dictionary[key], params) : key,
    has: (key) => Object.hasOwn(dictionary, key),
    keys: () => Object.keys(dictionary),
  };
}
