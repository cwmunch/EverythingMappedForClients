// The install record: a small file inside the installed skill folder that lists every file and
// folder the installer created. Uninstall and --force remove exactly what is listed and nothing else.

import fs from 'node:fs';
import path from 'node:path';
import { CliError } from './errors.mjs';

export const RECORD_NAME = '.everything-mapped-install.json';
export const RECORD_SCHEMA = 'everything-mapped-for-clients/install-record/1';

export function toSlashes(relative) {
  return relative.split(path.sep).join('/');
}

// files: [{ relative, sha256 }] and dirs: [relative], with native separators.
export function buildRecord(files, dirs) {
  return {
    schema: RECORD_SCHEMA,
    files: files.map((file) => ({ path: toSlashes(file.relative), sha256: file.sha256 })),
    dirs: dirs.map(toSlashes),
  };
}

// The absolute path of a path from the record, below folder.
export function recordedPath(folder, relative) {
  return path.join(folder, ...relative.split('/'));
}

// A recorded path must be plain and relative: no "..", no drive letter, no backslash, no NUL.
function isPlainRelative(value) {
  if (typeof value !== 'string' || value === '' || value.includes('\0') || value.includes('\\')) return false;
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function isValidRecord(data) {
  if (typeof data !== 'object' || data === null || data.schema !== RECORD_SCHEMA) return false;
  if (!Array.isArray(data.files) || !Array.isArray(data.dirs)) return false;
  const filesOk = data.files.every(
    (file) => typeof file === 'object' && file !== null && isPlainRelative(file.path) && /^[0-9a-f]{64}$/.test(file.sha256),
  );
  return filesOk && data.dirs.every(isPlainRelative);
}

// Reads and checks the record of an installed folder. Throws CliError when there is none
// (the folder was not made by this installer) or when it cannot be trusted.
export function readRecord(folder) {
  const file = path.join(folder, RECORD_NAME);
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) throw new CliError('ui.install.error.noRecord', { path: folder, record: RECORD_NAME });

  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new CliError('ui.install.error.badRecord', { path: folder, record: RECORD_NAME });
  }
  if (!isValidRecord(data)) throw new CliError('ui.install.error.badRecord', { path: folder, record: RECORD_NAME });
  return { files: data.files, dirs: data.dirs };
}
