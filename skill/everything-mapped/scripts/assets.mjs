// assets.mjs [--init] [--scan] [--add <file> --what <t> --owner <t> --rights <t> --restrictions <t>]
//            [--remove <file>] [--from <file.json> [--delete]] [--json] [--root <dir>] [--lang da|en]
// Keeps docs/assets.md in step with the files in docs/assets. --init makes the folder docs/assets
// (and docs) when it is missing and is the only option that makes it. --scan (the default) lists
// what is missing from the table, the names that cannot be listed and the names the zip would
// refuse. --add and --from add or update rows for files that are already in the folder; --from reads
// { "rows": [ { "file", "what", "owner", "rights", "restrictions" } ] }. A name is matched without
// regard to how an accent is written (composed or decomposed), and the table gets the spelling the
// disk has. --remove takes a row out of the table and leaves the file alone.
// A table that would pass its limits (5000 rows, 20000 characters in a line, 2 MB) is refused with
// exit 2 and nothing is written.
// Exit codes: 0 ok, 2 wrong use, 3 unreadable pack. (FORMAT.md section 12)

import fs from 'node:fs';
import path from 'node:path';
import {
  assetKey,
  assetName,
  describeAssetName,
  ensureAssetsFolder,
  failWith,
  hasHiddenCharacters,
  isMainModule,
  isStorableAssetName,
  isUnknownRights,
  nameReasonText,
  notPackableAssets,
  openScriptContext,
  parsePack,
  printProblems,
  readInputFile,
  reportSwept,
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
// the name of a file in docs/assets (found without regard to how an accent is written; `name` is
// then the spelling of the disk), and one that the table can hold exactly. `present` is a Map from
// the key of a name (see assetKey) to the name as the folder has it.
function toUpdate(raw, index, present) {
  const keys = isPlainObject(raw) ? Object.keys(raw) : [];
  const valid = isPlainObject(raw) && typeof raw.file === 'string' && keys.every((key) => key === 'file' || ROW_FIELDS.includes(key));
  if (!valid || ROW_FIELDS.some((field) => raw[field] !== undefined && typeof raw[field] !== 'string')) {
    throw new InputError([{ key: 'ui.assets.err.badRow', params: { index: index + 1 } }]);
  }
  const wanted = assetName(trimSpaces(raw.file));
  if (!isSafeName(wanted)) throw new InputError([{ key: 'ui.assets.err.badFile', params: { file: raw.file } }]);
  const name = present.get(wanted.normalize('NFC'));
  if (name === undefined) throw new InputError([{ key: 'ui.assets.err.noSuchFile', params: { file: raw.file } }]);
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
  const key = name.normalize('NFC');
  if (!pack.assets.rows.some((row) => assetKey(row.file) === key)) {
    throw new InputError([{ key: 'ui.assets.err.noSuchRow', params: { file: values.remove } }]);
  }
  return key;
}

// Applies the updates to the rows of the table. Returns { rows, added, updated }.
function applyUpdates(existingRows, updates) {
  const rows = existingRows.map((row) => ({ ...row }));
  const byKey = new Map(rows.map((row) => [assetKey(row.file), row]));
  const added = [];
  const updated = [];
  for (const { name, fields } of updates) {
    const key = name.normalize('NFC');
    const row = byKey.get(key);
    if (row) {
      Object.assign(row, fields);
      // A row written with another spelling of the same name gets the spelling of the disk.
      if (storedAssetName(row.file) !== name && assetKey(row.file) === key) row.file = `assets/${name}`;
      updated.push(row.file);
    } else {
      const created = { file: `assets/${name}`, what: '', owner: '', rights: '', restrictions: '', ...fields };
      rows.push(created);
      byKey.set(key, created);
      added.push(created.file);
    }
  }
  return { rows, added, updated };
}

function scanAssets(pack, schema) {
  const { rows, present } = pack.assets;
  const presentKeys = new Set(present.map((name) => name.normalize('NFC')));
  const listedKeys = new Set(rows.map((row) => assetKey(row.file)));
  return {
    unlisted: present.filter((name) => isStorableAssetName(name) && !listedKeys.has(name.normalize('NFC'))).map((name) => `assets/${name}`),
    badName: [
      ...(pack.assets.invalid ?? []),
      ...present.filter((name) => !isStorableAssetName(name)).map((name) => describeAssetName(name)),
      ...rows.filter((row) => !isStorableAssetName(storedAssetName(row.file))).map((row) => describeAssetName(row.file)),
    ],
    notPackable: [
      ...notPackableAssets(present, schema.generatedFiles.assetsDir).map((entry) => ({
        file: describeAssetName(entry.name),
        reason: entry.code,
        ...(entry.other === undefined ? {} : { other: describeAssetName(entry.other) }),
      })),
      // Links and special files cannot go into a zip at all.
      ...(pack.assets.notPlain ?? []).map((shown) => ({ file: shown, reason: 'notPlain' })),
    ],
    missingFile: rows.filter((row) => !presentKeys.has(assetKey(row.file))).map((row) => row.file),
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

// Names are shown with what cannot be seen written as <U+XXXX>, the same way in every message.
function formatScan(scan, changes, pack, i18n) {
  const lines = [];
  const shown = (names) => names.map((name) => describeAssetName(name));
  if (changes.created !== null) lines.push(i18n.t(changes.created ? 'ui.assets.initCreated' : 'ui.assets.initExists'));
  for (const file of shown(changes.added)) lines.push(i18n.t('ui.assets.added', { file }));
  for (const file of shown(changes.updated)) lines.push(i18n.t('ui.assets.updated', { file }));
  for (const file of shown(changes.removed)) lines.push(i18n.t('ui.assets.removed', { file }));
  if (pack.assets.present.length === 0 && pack.assets.rows.length === 0) lines.push(i18n.t('ui.assets.empty'));
  lines.push(...bullets(`${i18n.t('ui.assets.unlisted')}:`, shown(scan.unlisted), i18n));
  lines.push(...bullets(`${i18n.t('ui.assets.badName')}:`, scan.badName, i18n));
  lines.push(...bullets(`${i18n.t('ui.assets.notPackable')}:`, scan.notPackable.map((entry) => `${entry.file}: ${nameReasonText(i18n, entry.reason, entry.other)}`), i18n));
  lines.push(...bullets(`${i18n.t('ui.assets.missingFile')}:`, shown(scan.missingFile), i18n));
  lines.push(...bullets(`${i18n.t('ui.assets.noRights')}:`, shown(scan.noRights), i18n));
  lines.push(...bullets(`${i18n.t('ui.assets.rightsUnknown')}:`, shown(scan.rightsUnknown), i18n));
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
  const updates = collectUpdates(values, context, new Map(context.pack.assets.present.map((name) => [name.normalize('NFC'), name])));
  if (values.init) changes.created = ensureAssetsFolder(root, schema);
  let pack = context.pack;
  let swept = [];
  if (removal !== null || updates.length > 0) {
    let rows = pack.assets.rows;
    if (removal !== null) {
      changes.removed = rows.filter((row) => assetKey(row.file) === removal).map((row) => row.file);
      rows = rows.filter((row) => assetKey(row.file) !== removal);
    }
    const applied = applyUpdates(rows, updates);
    changes.added = applied.added;
    changes.updated = applied.updated;
    swept = writeAssetsTable(root, applied.rows, { schema, schemaDir: context.schemaDir, language: context.language, now: context.now, today: localDate(context.now) }).swept;
    pack = parsePack(root, schema);
  }
  const scan = scanAssets(pack, schema);
  if (values.json) {
    io.stdout.write(`${stringifyJson({ ...scan, ...changes, rows: pack.assets.rows })}\n`);
  } else {
    const text = formatScan(scan, changes, pack, i18n).join('\n');
    io.stdout.write(`${sanitizeForTerminal(text, { keepLineBreaks: true })}\n`);
  }
  reportSwept(io.stderr, i18n, swept);
  // The list is saved. A file that cannot be removed is a warning, not a failure.
  if (values.delete) {
    const rowsFile = path.resolve(context.cwd, values.from);
    try {
      fs.rmSync(rowsFile, { force: true });
    } catch (error) {
      printProblems(io.stderr, i18n, [{ key: 'ui.assets.warn.deleteFailed', params: { path: rowsFile, code: error && error.code ? String(error.code) : 'EIO' } }]);
    }
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
