// The manifest (FORMAT.md section 6) and SHA-256. This is where node:crypto is used, so the
// pure modules stay free of it.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { manifestCompleteness } from './validate.mjs';
import { MAX_ASSET_BYTES, PackError, RESPONDENT_LINE_SEPARATOR, decodeListPart, isPackFile, isoDateTime, showHiddenCharacters } from './util.mjs';

export const TOOL_VERSION = '1.0.0';
export const SCHEMA_ID = 'everything-mapped-for-clients/1';

const DEFAULT_PATHS = {
  openQuestions: 'docs/07-risks-and-open-questions.md',
  assets: 'docs/assets.md',
  assetsDir: 'docs/assets',
};

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

const HASH_CHUNK_BYTES = 1024 * 1024;
const { O_RDONLY = 0, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = fs.constants;

// Opens a file for reading and returns the descriptor, or throws an error with a code: ELOOP when
// the last part of the path is a link (it is not followed, so a file in a pack cannot lead
// somewhere else), ENOTFILE when it is not a regular file (a folder, a pipe, a device), or the
// code of the system. The file is opened without waiting, so a pipe put in place of a file cannot
// stop the program. With followLinks a link is followed, for a file a person names on the command
// line.
export function openRegularFile(absolute, { followLinks = false } = {}) {
  if (!followLinks && O_NOFOLLOW === 0) {
    const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (stat && stat.isSymbolicLink()) throw Object.assign(new Error('ELOOP: the file is a link'), { code: 'ELOOP' });
  }
  const descriptor = fs.openSync(absolute, O_RDONLY | O_NONBLOCK | (followLinks ? 0 : O_NOFOLLOW));
  try {
    if (!fs.fstatSync(descriptor).isFile()) throw Object.assign(new Error('ENOTFILE: not a regular file'), { code: 'ENOTFILE' });
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
  return descriptor;
}

// All the bytes of an open file, or null when there are more than `limit`. At most limit + 1 bytes
// are read. `sizeHint` (the size the file had) only sets the size of the first read.
export function readBoundedBytes(descriptor, limit, sizeHint = 0) {
  const chunks = [];
  let total = 0;
  const first = Math.min(Math.max(sizeHint, 0) + 1, HASH_CHUNK_BYTES);
  for (;;) {
    const buffer = Buffer.allocUnsafe(Math.min(Math.max(first, 4096), limit + 1 - total));
    const read = fs.readSync(descriptor, buffer, 0, buffer.length, null);
    if (read === 0) break;
    chunks.push(buffer.subarray(0, read));
    total += read;
    if (total > limit) return null;
  }
  return Buffer.concat(chunks, total);
}

// The SHA-256 of a file, read in chunks so that a large file never sits in memory as a whole.
// A file that is a link, is not a regular file or cannot be read is a PackError that names it.
export function sha256File(absolute) {
  const unreadable = () => new PackError('ui.check.err.assetUnreadable', { path: absolute });
  const hash = createHash('sha256');
  const chunk = Buffer.alloc(HASH_CHUNK_BYTES);
  let descriptor;
  try {
    descriptor = openRegularFile(absolute);
  } catch {
    throw unreadable();
  }
  try {
    let read = fs.readSync(descriptor, chunk, 0, chunk.length, null);
    while (read > 0) {
      hash.update(chunk.subarray(0, read));
      read = fs.readSync(descriptor, chunk, 0, chunk.length, null);
    }
  } catch {
    throw unreadable();
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function findAnswer(pack, id) {
  for (const file of Object.values(pack.files)) {
    if (file.answers && file.answers[id]) return file.answers[id];
  }
  return null;
}

function answerText(pack, id) {
  const entry = findAnswer(pack, id);
  if (!entry || (entry.status !== 'complete' && entry.status !== 'partial') || !entry.value) return '';
  return showHiddenCharacters((entry.value.text ?? '').split('\n')[0].trim());
}

function projectKind(pack) {
  const entry = findAnswer(pack, 'A.project-kind');
  if (!entry || (entry.status !== 'complete' && entry.status !== 'partial') || !entry.value) return '';
  return (entry.value.choice ?? [])[0] ?? '';
}

// Front matter respondent "Anna Jensen, Marketing; Peter Holm, IT" -> people with their latest update.
function respondentList(pack) {
  const people = new Map();
  for (const file of Object.values(pack.files)) {
    const frontMatter = file.frontMatter;
    if (!file.exists || !frontMatter || !frontMatter.respondent) continue;
    for (const part of frontMatter.respondent.split(RESPONDENT_LINE_SEPARATOR)) {
      const [name, ...roleParts] = part.split(',');
      const person = { name: decodeListPart(name.trim()), role: decodeListPart(roleParts.join(',').trim()), updated: frontMatter.updated ?? '' };
      if (person.name === '') continue;
      const key = `${person.name}\n${person.role}`;
      const known = people.get(key);
      if (!known || person.updated > known.updated) people.set(key, person);
    }
  }
  return [...people.values()];
}

function listedFiles(pack) {
  const paths = { ...DEFAULT_PATHS, ...pack.paths };
  const relative = [];
  for (const file of Object.values(pack.files)) if (file.exists) relative.push(file.path);
  relative.push(paths.openQuestions, paths.assets);
  for (const name of (pack.assets && pack.assets.present) ?? []) relative.push(`${paths.assetsDir}/${name}`);
  return relative.filter(isPackFile).sort();
}

// Refuses a folder that is a symbolic link: files below it would be hashed here and left out of a zip.
export function assertNotLinked(root, relativePath) {
  const stat = fs.lstatSync(path.join(root, ...relativePath.split('/')), { throwIfNoEntry: false });
  if (stat && stat.isSymbolicLink()) throw new PackError('ui.check.err.linkedFolder', { path: relativePath });
}

// The hash of each listed file that exists. `contents` (a Map from path to text) holds files that
// are not written yet; their hash is taken from the text. A file over MAX_ASSET_BYTES is not read: it
// is listed with its size and the marker skipped: "tooLarge" and no hash (`large` is a Map from a path
// to the size of such a file that is already known). A file that cannot be read is a PackError.
function hashFiles(root, relativePaths, contents, large = new Map()) {
  const files = [];
  for (const relative of relativePaths) {
    if (contents && contents.has(relative)) {
      files.push({ path: relative, sha256: sha256(contents.get(relative)) });
      continue;
    }
    if (large.has(relative)) {
      files.push({ path: relative, size: large.get(relative), skipped: 'tooLarge' });
      continue;
    }
    const absolute = path.join(root, ...relative.split('/'));
    let stat;
    try {
      stat = fs.statSync(absolute, { throwIfNoEntry: false });
    } catch {
      throw new PackError('ui.check.err.assetUnreadable', { path: relative });
    }
    if (!stat || !stat.isFile()) continue;
    if (stat.size > MAX_ASSET_BYTES) {
      files.push({ path: relative, size: stat.size, skipped: 'tooLarge' });
      continue;
    }
    try {
      files.push({ path: relative, sha256: sha256File(absolute) });
    } catch {
      throw new PackError('ui.check.err.assetUnreadable', { path: relative });
    }
  }
  return files;
}

// The assets that are over the size limit, by their path from the pack root.
function largeAssets(pack, paths) {
  const large = (pack.assets && pack.assets.large) ?? [];
  return new Map(large.map((entry) => [`${paths.assetsDir}/${entry.name}`, entry.size]));
}

function stampOf(value) {
  if (typeof value === 'string') return value;
  return isoDateTime(value instanceof Date ? value : new Date());
}

// meta: { now?, updatedAt?, createdAt?, toolVersion?, schema?, contents? }; now and the stamps may be
// a Date or an ISO string. The hashes are read from pack.root; meta.contents (a Map from path to
// text) stands in for files that are about to be written.
export function buildManifest(pack, report, meta = {}) {
  const paths = { ...DEFAULT_PATHS, ...pack.paths };
  assertNotLinked(pack.root, 'docs');
  assertNotLinked(pack.root, paths.assetsDir);
  const updatedAt = stampOf(meta.updatedAt ?? meta.now);
  return {
    schema: meta.schema ?? SCHEMA_ID,
    toolVersion: meta.toolVersion ?? TOOL_VERSION,
    language: report.language,
    depth: report.depth,
    project: { name: answerText(pack, 'B.name'), kind: projectKind(pack) },
    respondents: respondentList(pack),
    createdAt: stampOf(meta.createdAt ?? updatedAt),
    updatedAt,
    completeness: manifestCompleteness(report),
    files: hashFiles(pack.root, listedFiles(pack), meta.contents, largeAssets(pack, paths)),
  };
}
