// assets.mjs [--init] [--scan] [--add <file> --what <t> --owner <t> --rights <t> --restrictions <t>]
//            [--remove <file>] [--from <file.json> [--delete]] [--json] [--root <dir>] [--lang da|en]
// Keeps docs/assets.md in step with the files in docs/assets. --init makes the folder docs/assets
// (and docs) when it is missing. --scan (the default) lists what is missing from the table.
// --add and --from add or update rows; --from reads
// { "rows": [ { "file", "what", "owner", "rights", "restrictions" } ] } and makes the folder when it
// is missing. --remove takes a row out of the table and leaves the file alone.
// A table that would pass its limits (5000 rows, 20000 characters in a line, 2 MB) is refused with
// exit 2 and nothing is written.
// Exit codes: 0 ok, 2 wrong use, 3 unreadable pack. (FORMAT.md section 12)

import fs from 'node:fs';
import path from 'node:path';
import {
  assetName,
  describeAssetName,
  ensureAssetsFolder,
  failWith,
  hasHiddenCharacters,
  isMainModule,
  isStorableAssetName,
  isUnknownRights,
  openScriptContext,
  parsePack,
  readInputFile,
  sanitizeForTerminal,
  storedAssetName,
  stringifyJson,
  writeAssetsTable,
} from './lib/index.mjs';
import { InputError, MAX_LISTED_ITEMS, isPlainObject, localDate, trimSpaces } from './lib/util.mjs';

const OPTIONS = {
  init: 'boolean',
  scan: 'boolean',
  add: 'string',
  remove: 'string',
  what: 'string',
  owner: 'string',
  rights: 'string',
  restrictions: 'string',
  from: 'string',
  delete: 'boolean',
  json: 'boolean',
};
const ROW_FIELDS = ['what', 'owner', 'rights', 'restrictions'];
const READ_PROBLEMS = { notFile: 'ui.assets.err.notAFile', tooLarge: 'ui.assets.err.fileTooLarge', unreadable: 'ui.assets.err.cannotReadFrom' };

function usageProblems(values) {
  const problems = [];
  const detailGiven = ROW_FIELDS.some((field) => values[field] !== undefined);
  if (detailGiven && values.add === undefined) problems.push({ key: 'ui.assets.err.detailsNeedAdd', params: {} });
  if (values.delete && values.from === undefined) problems.push({ key: 'ui.assets.err.deleteNeedsFrom', params: {} });
  return problems;
}

function readRowsFile(file) {
  const { text, problem } = readInputFile(file);
  if (problem) throw new InputError([{ key: READ_PROBLEMS[problem], params: { path: file, limit: '2 MB' } }]);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new InputError([{ key: 'ui.assets.err.cannotReadFrom', params: { path: file } }]);
  }
  if (!isPlainObject(data) || !Array.isArray(data.rows)) {
    throw new InputError([{ key: 'ui.assets.err.rowsMissing', params: { path: file } }]);
  }
  return data.rows;
}

function isSafeName(name) {
  return name !== '' && !name.startsWith('/') && name.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

// A row to add or update: { name, fields } with only the fields that were given. The name must be
// the name of a file in docs/assets, and one that the table can hold exactly.
function toUpdate(raw, index, present) {
  const keys = isPlainObject(raw) ? Object.keys(raw) : [];
  const valid = isPlainObject(raw) && typeof raw.file === 'string' && keys.every((key) => key === 'file' || ROW_FIELDS.includes(key));
  if (!valid || ROW_FIELDS.some((field) => raw[field] !== undefined && typeof raw[field] !== 'string')) {
    throw new InputError([{ key: 'ui.assets.err.badRow', params: { index: index + 1 } }]);
  }
  const name = assetName(trimSpaces(raw.file));
  if (!isSafeName(name)) throw new InputError([{ key: 'ui.assets.err.badFile', params: { file: raw.file } }]);
  if (!present.has(name)) throw new InputError([{ key: 'ui.assets.err.noSuchFile', params: { file: raw.file } }]);
  if (!isStorableAssetName(name)) throw new InputError([{ key: 'ui.assets.err.badName', params: { file: describeAssetName(name) } }]);
  const fields = {};
  for (const field of ROW_FIELDS) {
    if (raw[field] === undefined) continue;
    if (hasHiddenCharacters(raw[field])) throw new InputError([{ key: 'ui.assets.err.hiddenText', params: { file: describeAssetName(name), field } }]);
    fields[field] = raw[field];
  }
  return { name, fields };
}

function collectUpdates(values, context, present) {
  const rows = values.from === undefined ? [] : readRowsFile(path.resolve(context.cwd, values.from));
  if (values.add !== undefined) {
    const details = {};
    for (const field of ROW_FIELDS) if (values[field] !== undefined) details[field] = values[field];
    rows.push({ file: values.add, ...details });
  }
  return rows.map((raw, index) => toUpdate(raw, index, present));
}

// The name of the row to remove, checked against the table. The file itself need not exist.
function collectRemoval(values, pack) {
  if (values.remove === undefined) return null;
  const name = assetName(trimSpaces(values.remove));
  if (!isSafeName(name)) throw new InputError([{ key: 'ui.assets.err.badFile', params: { file: values.remove } }]);
  if (!pack.assets.rows.some((row) => assetName(row.file) === name)) {
    throw new InputError([{ key: 'ui.assets.err.noSuchRow', params: { file: values.remove } }]);
  }
  return name;
}

// Applies the updates to the rows of the table. Returns { rows, added, updated }.
function applyUpdates(existingRows, updates) {
  const rows = existingRows.map((row) => ({ ...row }));
  const byName = new Map(rows.map((row) => [assetName(row.file), row]));
  const added = [];
  const updated = [];
  for (const { name, fields } of updates) {
    const row = byName.get(name);
    if (row) {
      Object.assign(row, fields);
      updated.push(row.file);
    } else {
      const created = { file: `assets/${name}`, what: '', owner: '', rights: '', restrictions: '', ...fields };
      rows.push(created);
      byName.set(name, created);
      added.push(created.file);
    }
  }
  return { rows, added, updated };
}

function scanAssets(pack) {
  const { rows, present } = pack.assets;
  const presentSet = new Set(present);
  const listed = new Set(rows.map((row) => assetName(row.file)));
  return {
    unlisted: present.filter((name) => isStorableAssetName(name) && !listed.has(name)).map((name) => `assets/${name}`),
    badName: [
      ...present.filter((name) => !isStorableAssetName(name)).map((name) => describeAssetName(name)),
      ...rows.filter((row) => !isStorableAssetName(storedAssetName(row.file))).map((row) => describeAssetName(row.file)),
    ],
    missingFile: rows.filter((row) => !presentSet.has(assetName(row.file))).map((row) => row.file),
    noRights: rows.filter((row) => row.rights.trim() === '').map((row) => row.file),
    rightsUnknown: rows.filter((row) => isUnknownRights(row.rights)).map((row) => row.file),
  };
}

// A heading and at most MAX_LISTED_ITEMS names, then a line with the number left out.
function bullets(heading, names, i18n) {
  if (names.length === 0) return [];
  const lines = [heading, ...names.slice(0, MAX_LISTED_ITEMS).map((name) => `  - ${name}`)];
  if (names.length > MAX_LISTED_ITEMS) lines.push(`  - ${i18n.t('ui.assets.more', { count: names.length - MAX_LISTED_ITEMS })}`);
  return lines;
}

function formatScan(scan, changes, pack, i18n) {
  const lines = [];
  if (changes.created !== null) lines.push(i18n.t(changes.created ? 'ui.assets.initCreated' : 'ui.assets.initExists'));
  for (const file of changes.added) lines.push(i18n.t('ui.assets.added', { file }));
  for (const file of changes.updated) lines.push(i18n.t('ui.assets.updated', { file }));
  for (const file of changes.removed) lines.push(i18n.t('ui.assets.removed', { file }));
  if (pack.assets.present.length === 0 && pack.assets.rows.length === 0) lines.push(i18n.t('ui.assets.empty'));
  lines.push(...bullets(`${i18n.t('ui.assets.unlisted')}:`, scan.unlisted, i18n));
  lines.push(...bullets(`${i18n.t('ui.assets.badName')}:`, scan.badName, i18n));
  lines.push(...bullets(`${i18n.t('ui.assets.missingFile')}:`, scan.missingFile, i18n));
  lines.push(...bullets(`${i18n.t('ui.assets.noRights')}:`, scan.noRights, i18n));
  lines.push(...bullets(`${i18n.t('ui.assets.rightsUnknown')}:`, scan.rightsUnknown, i18n));
  if (scan.unlisted.length + scan.missingFile.length + scan.badName.length === 0 && pack.assets.rows.length > 0) {
    lines.push(i18n.t('ui.assets.allListed'));
  }
  return lines;
}

function run(context, io) {
  const { values, root, schema, i18n } = context;
  const problems = usageProblems(values);
  if (problems.length > 0) throw new InputError(problems);
  const changes = { created: null, added: [], updated: [], removed: [] };
  const removal = collectRemoval(values, context.pack);
  const updates = collectUpdates(values, context, new Set(context.pack.assets.present));
  if (values.init || values.from !== undefined) changes.created = ensureAssetsFolder(root, schema);
  let pack = context.pack;
  if (removal !== null || updates.length > 0) {
    let rows = pack.assets.rows;
    if (removal !== null) {
      changes.removed = rows.filter((row) => assetName(row.file) === removal).map((row) => row.file);
      rows = rows.filter((row) => assetName(row.file) !== removal);
    }
    const applied = applyUpdates(rows, updates);
    changes.added = applied.added;
    changes.updated = applied.updated;
    writeAssetsTable(root, applied.rows, { schema, schemaDir: context.schemaDir, language: context.language, now: context.now, today: localDate(context.now) });
    pack = parsePack(root, schema);
  }
  if (values.delete) fs.rmSync(path.resolve(context.cwd, values.from), { force: true });
  const scan = scanAssets(pack);
  if (values.json) {
    io.stdout.write(`${stringifyJson({ ...scan, ...changes, rows: pack.assets.rows })}\n`);
  } else {
    const text = formatScan(scan, changes, pack, i18n).join('\n');
    io.stdout.write(`${sanitizeForTerminal(text, { keepLineBreaks: true })}\n`);
  }
  return 0;
}

export async function main(argv, io = { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin }) {
  let context = null;
  try {
    context = openScriptContext(argv, io, OPTIONS);
    if (context.exitCode !== undefined) return context.exitCode;
    return run(context, io);
  } catch (error) {
    return failWith(error, io, context && context.i18n);
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
