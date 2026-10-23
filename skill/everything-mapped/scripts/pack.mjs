// pack.mjs [--root <dir>] [--out <dir>] [--lang da|en] [--json]
// Checks the pack, refreshes the generated files and writes intake-pack-YYYY-MM-DD.zip
// (FORMAT.md sections 12 and 15). The absolute path of the zip is printed on a line of its own;
// with --json the only output is { zip, sha256, bytes, entries }.
// Exit codes: 0 ok, 2 wrong use or no answer at all, 3 an unreadable pack, a linked docs folder, a name or
// size the zip cannot hold, or a zip that could not be written.
// The files are streamed into the zip in chunks, so the memory used does not grow with the size of the pack.
// File names are shown everywhere the way check shows them: what cannot be seen is written as <U+XXXX>.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  describeAssetName,
  entryNameProblems,
  failWith,
  hasAnyAnswer,
  isMainModule,
  loadI18n,
  nameReasonText,
  openScriptContext,
  printProblems,
  refreshPack,
  resolveLanguage,
  sanitizeForTerminal,
  stringifyJson,
} from './lib/index.mjs';
import { MAX_ASSET_BYTES, MAX_PACK_BYTES, MAX_PACK_FILES, isPackFile, localDate } from './lib/util.mjs';
import { ZipError, writeZipFile } from './lib/zip.mjs';

const MB = 1024 * 1024;
// A zip above this is too large for most e-mail services.
const LARGE_ZIP_BYTES = 50 * MB;
// What the tools that open the zip accept (FORMAT.md section 15): MAX_ASSET_BYTES for one file,
// MAX_PACK_BYTES in all and MAX_PACK_FILES entries, from the library. They are enforced only here:
// check and answer work with larger packs and only flag them.
// The hidden temporary file a zip is written to (see zip.mjs) when it is left behind by a stopped run.
const STALE_TEMPORARY = /^\.intake-pack-\d{4}-\d{2}-\d{2}\.zip\.[0-9a-f]{16}\.tmp$/;
const STALE_AFTER_MS = 10 * 60 * 1000;
const ZIP_CODES_WITH_TEXT = [
  'tooManyEntries',
  'tooLarge',
  'badName',
  'nameTooLong',
  'duplicateName',
  'needsNewerNode',
  'fileChanged',
  'unreadableFile',
];

// A failure with a text key for the message and the exit code to end with. `details` are further
// lines ({ key, params }) printed under the message.
class Failure extends Error {
  constructor(key, params = {}, exitCode = 2, details = []) {
    super(key);
    this.name = 'Failure';
    this.key = key;
    this.params = params;
    this.exitCode = exitCode;
    this.details = details;
  }
}

function defaultIo() {
  return { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin };
}

function isInside(folder, target) {
  const relative = path.relative(folder, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function formatSize(bytes, lang = 'en') {
  const number = new Intl.NumberFormat(lang === 'da' ? 'da-DK' : 'en-GB', { maximumFractionDigits: 1 });
  if (bytes >= 1024 * 1024) return `${number.format(bytes / (1024 * 1024))} MB`;
  if (bytes >= 1024) return `${number.format(bytes / 1024)} KB`;
  return `${number.format(bytes)} B`;
}

// Text values of a message that name a file or folder, shown the one way file names are shown.
function showParams(params) {
  return Object.fromEntries(Object.entries(params).map(([key, value]) => [key, typeof value === 'string' ? describeAssetName(value) : value]));
}

// A name that is not valid UTF-8, written so that it can be read: valid text as it is, every other
// byte as <0xHH>, and what cannot be seen as <U+XXXX>. (The same display as check uses.)
function showNameBytes(bytes) {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let shown = '';
  let index = 0;
  while (index < bytes.length) {
    const lead = bytes[index];
    let length = 0;
    if (lead < 0x80) length = 1;
    else if (lead >= 0xf0) length = 4;
    else if (lead >= 0xe0) length = 3;
    else if (lead >= 0xc0) length = 2;
    let character = null;
    if (length > 0 && index + length <= bytes.length) {
      try {
        character = decoder.decode(bytes.subarray(index, index + length));
      } catch {
        character = null;
      }
    }
    if (character === null) {
      shown += `<0x${lead.toString(16).toUpperCase().padStart(2, '0')}>`;
      index += 1;
    } else {
      shown += character;
      index += length;
    }
  }
  return describeAssetName(shown);
}

// The zip goes to an existing folder that is not inside docs/. Real paths are compared,
// so a link that leads into docs/ is caught too.
function checkOutputFolder(outDir, root) {
  let stat = null;
  try {
    stat = fs.statSync(outDir);
  } catch {
    // reported below
  }
  if (!stat || !stat.isDirectory()) throw new Failure('ui.pack.error.outMissing', { dir: outDir });

  const docs = path.join(root, 'docs');
  const realDocs = fs.existsSync(docs) ? fs.realpathSync(docs) : path.join(fs.realpathSync(root), 'docs');
  if (isInside(realDocs, fs.realpathSync(outDir))) {
    throw new Failure('ui.pack.error.outInsideDocs', { dir: outDir });
  }
}

// Removes the temporary files an earlier, stopped pack left in the output folder: ordinary files named
// exactly like the ones a pack writes and untouched for ten minutes (a run that is still going is
// left alone). Nothing else is removed, and no link is followed. Returns the names removed.
function sweepStaleTemporaries(outDir, now) {
  const swept = [];
  for (const name of fs.readdirSync(outDir)) {
    if (!STALE_TEMPORARY.test(name)) continue;
    const absolute = path.join(outDir, name);
    const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (!stat || !stat.isFile() || now.getTime() - stat.mtimeMs < STALE_AFTER_MS) continue;
    try {
      fs.unlinkSync(absolute);
      swept.push(name);
    } catch {
      // not ours to insist on: it stays
    }
  }
  return swept;
}

// docs/ and docs/assets/ must be real folders. A link there would make the manifest describe files
// that the zip does not hold (or hold files from somewhere else), so the packing stops before listing anything.
function assertRealFolders(root, schema) {
  for (const folder of [path.join(root, 'docs'), path.join(root, ...schema.generatedFiles.assetsDir.split('/'))]) {
    const stat = fs.lstatSync(folder, { throwIfNoEntry: false });
    if (stat && stat.isSymbolicLink()) throw new Failure('ui.pack.error.linkedFolder', { path: folder }, 3);
    if (stat && !stat.isDirectory()) throw new Failure('ui.pack.error.notPlain', { path: folder }, 3);
  }
}

// Decides what goes into the zip by looking at names and sizes only; no file is read here.
// Included: the files of the section 3 layout (the six answer files, the open-questions file, the
// assets table, the manifest, the state) and the plain files below docs/assets/. Everything else
// under docs/ (files that isPackFile refuses, such as dotfiles and *.tmp files, then docs/06-decisions.md,
// other files and links) is skipped and named in `skipped`. Folders are read as bytes.
// Not plain files (links, pipes) and names that are not valid UTF-8 below docs/assets/ are left to the
// library's listing of the assets (pack.assets.notPlain and .invalid), which names them all; here a layout
// file that is not a plain file is listed in `notPlain`, and a name that is not valid UTF-8 anywhere else is skipped.
function planPack(root, schema) {
  const generated = schema.generatedFiles;
  const layout = new Set([
    ...schema.files.map((file) => file.path),
    generated.openQuestions,
    generated.assets,
    generated.manifest,
    generated.state,
  ]);
  const assetsPrefix = `${generated.assetsDir}/`;
  const inAssets = (relative) => relative === generated.assetsDir || relative.startsWith(assetsPrefix);
  const docs = path.join(root, 'docs');

  const included = [];
  const skipped = [];
  const notPlain = [];
  const walk = (folder, relative) => {
    for (const bytes of fs.readdirSync(folder, { encoding: 'buffer' })) {
      const text = bytes.toString('utf8');
      const valid = Buffer.from(text, 'utf8').equals(bytes);
      const absolute = valid ? path.join(folder, text) : Buffer.concat([Buffer.from(`${folder}${path.sep}`), bytes]);
      const entry = `${relative}/${valid ? text : showNameBytes(bytes)}`;
      const stat = fs.lstatSync(absolute);
      const label = stat.isDirectory() ? `${entry}/` : entry;
      if (!isPackFile(`${relative}/${text}`)) {
        skipped.push(label);
      } else if (!valid) {
        if (!inAssets(relative)) skipped.push(label);
      } else if (stat.isDirectory()) {
        walk(absolute, entry);
      } else if (!layout.has(entry) && !entry.startsWith(assetsPrefix)) {
        skipped.push(entry);
      } else if (stat.isFile()) {
        included.push({ name: entry, absolute, size: stat.size });
      } else if (!inAssets(relative)) {
        notPlain.push(entry);
      }
    }
  };
  walk(docs, 'docs');

  const compare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
  included.sort((a, b) => compare(a.name, b.name));
  return { included, skipped: skipped.sort(compare), notPlain: notPlain.sort(compare) };
}

// Stops before anything else is looked at when the pack has more files than the library lists: its
// listing of the assets counts the files beyond its own limit (omitted) without naming them, so
// there is nothing to list and the pack is far over the limit of entries anyway.
function assertAssetsListable(assets) {
  if (assets.omitted > 0) {
    throw new Failure('ui.pack.error.tooManyFiles', { count: assets.present.length + assets.omitted, max: MAX_PACK_FILES }, 3);
  }
}

// Why a file is refused: the reasons of the name rule, and two more.
function reasonText(i18n, problem, lang) {
  if (problem.code === 'notPlain') return i18n.t('ui.pack.reason.notPlain');
  if (problem.code === 'tooLarge') {
    return i18n.t('ui.pack.reason.tooLarge', { size: formatSize(problem.size, lang), max: formatSize(MAX_ASSET_BYTES, lang) });
  }
  return nameReasonText(i18n, problem.code, describeAssetName(problem.other ?? ''));
}

// Every file the zip would refuse, all at once with the reason for each: a character or a name that
// does not work on every system, a name that is too long, two names that are one on Windows and macOS,
// a file that is also the name of a folder, a name that is not valid UTF-8, something that is not an
// ordinary file, a file over the size limit. The files below docs/assets/ that are not plain, not valid
// UTF-8 or too large come from the library's listing (pack.assets). Nothing is written or read before this.
function assertFilesFit(plan, assets, schema, i18n, lang) {
  const prefix = `${schema.generatedFiles.assetsDir}/`;
  const problems = [
    ...entryNameProblems(plan.included.map((file) => file.name)),
    ...assets.invalid.map((name) => ({ name: `${prefix}${name}`, code: 'notText' })),
    ...assets.notPlain.map((name) => ({ name: `${prefix}${name}`, code: 'notPlain' })),
    ...plan.notPlain.map((name) => ({ name, code: 'notPlain' })),
    ...assets.large.map((file) => ({ name: `${prefix}${file.name}`, code: 'tooLarge', size: file.size })),
    ...plan.included
      .filter((file) => file.size > MAX_ASSET_BYTES && !file.name.startsWith(prefix))
      .map((file) => ({ name: file.name, code: 'tooLarge', size: file.size })),
  ];
  if (problems.length === 0) return;
  const details = problems.map((problem) => ({
    key: 'ui.pack.error.nameLine',
    params: { name: describeAssetName(problem.name), reason: reasonText(i18n, problem, lang) },
  }));
  throw new Failure('ui.pack.error.names', { count: problems.length }, 3, details);
}

// Refuses a pack with more files than the zip tools accept, or with more bytes in all.
function checkTotals(included, lang) {
  const total = included.reduce((sum, file) => sum + file.size, 0);
  if (total > MAX_PACK_BYTES) {
    throw new Failure('ui.pack.error.packTooLarge', { size: formatSize(total, lang), max: formatSize(MAX_PACK_BYTES, lang) }, 3);
  }
  if (included.length > MAX_PACK_FILES) {
    throw new Failure('ui.pack.error.tooManyFiles', { count: included.length, max: MAX_PACK_FILES }, 3);
  }
}

// Turns a zip writer failure into a message and an exit code.
function zipFailure(error) {
  if (error instanceof ZipError && error.code === 'packTooLarge') {
    return new Failure('ui.pack.error.packTooLarge', { size: formatSize(error.params.size), max: formatSize(error.params.max) }, 3);
  }
  if (error instanceof ZipError && ZIP_CODES_WITH_TEXT.includes(error.code)) {
    return new Failure(`ui.pack.error.zip.${error.code}`, error.params, 3);
  }
  return new Failure('ui.pack.error.writeFailed', { message: error.message }, 3);
}

async function writePackZip(zipPath, included, today) {
  const [year, month, day] = today.split('-').map(Number);
  const entries = included.map((file) => ({ name: file.name, path: file.absolute }));
  try {
    return await writeZipFile(zipPath, entries, {
      date: new Date(Date.UTC(year, month - 1, day)),
      maxUncompressedBytes: MAX_PACK_BYTES,
    });
  } catch (error) {
    throw zipFailure(error);
  }
}

// SHA-256 of a file, read in chunks.
function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.alloc(1024 * 1024);
  const fd = fs.openSync(filePath, 'r');
  try {
    let read = fs.readSync(fd, buffer, 0, buffer.length, null);
    while (read > 0) {
      hash.update(buffer.subarray(0, read));
      read = fs.readSync(fd, buffer, 0, buffer.length, null);
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

async function run(argv, io, session) {
  const context = openScriptContext(argv, io, { out: 'string', json: 'boolean' });
  if (context.exitCode !== undefined) return context.exitCode;
  const { values, root, schema, pack, i18n, language, now } = context;
  session.i18n = i18n;
  const { t } = i18n;
  const json = values.json === true;
  // File names and paths come from the pack and the person's disk, so nothing is printed raw.
  // (The JSON output is not affected: stringifyJson escapes control characters itself.)
  const say = (text) => {
    if (!json) io.stdout.write(`${sanitizeForTerminal(text)}\n`);
  };

  const today = localDate(now);
  const outDir = path.resolve(context.cwd, values.out ?? '.');
  assertRealFolders(root, schema);
  if (!hasAnyAnswer(pack)) throw new Failure('ui.pack.error.noAnswers');
  checkOutputFolder(outDir, root);
  const swept = sweepStaleTemporaries(outDir, now);
  if (swept.length > 0) (json ? io.stderr : io.stdout).write(`${sanitizeForTerminal(t('ui.pack.swept', { names: swept.map(describeAssetName).join(', ') }))}\n`);
  // Names and sizes only, before anything is read or written: refreshing the manifest below reads every asset to hash it.
  assertAssetsListable(pack.assets);
  const firstPlan = planPack(root, schema);
  assertFilesFit(firstPlan, pack.assets, schema, i18n, language);
  checkTotals(firstPlan.included, language);

  say(t('ui.pack.checking', { root: describeAssetName(root) }));
  // The generated files stay in the language of the pack, whatever language the messages here use.
  const { report, pack: refreshedPack } = refreshPack(root, { schema, schemaDir: context.schemaDir, language, now, today });
  say(t('ui.pack.counts', report.completeness.counts));
  say(
    report.gate1.ready
      ? t('ui.pack.core.ready')
      : t('ui.pack.core.notReady', { count: report.gate1.blocking.length }),
  );
  say(t('ui.pack.refreshed'));

  const plan = planPack(root, schema);
  assertFilesFit(plan, refreshedPack.assets, schema, i18n, language);
  checkTotals(plan.included, language);
  const { included, skipped } = plan;
  const warn = (text) => (json ? io.stderr : io.stdout).write(`${sanitizeForTerminal(text)}\n`);
  for (const entry of skipped) warn(t('ui.pack.skipped', { path: describeAssetName(entry) }));

  const zipPath = path.join(outDir, `intake-pack-${today}.zip`);
  const written = await writePackZip(zipPath, included, today);
  const hash = hashFile(zipPath);
  // The size that counts is the zip, not the files before they were zipped.
  if (written.bytes > LARGE_ZIP_BYTES) warn(t('ui.pack.warn.large', { size: formatSize(written.bytes, language) }));

  if (json) {
    const result = { zip: zipPath, sha256: hash, bytes: written.bytes, entries: written.entries };
    io.stdout.write(`${stringifyJson(result)}\n`);
    return 0;
  }

  say('');
  say(t('ui.pack.created', { file: path.basename(zipPath), count: written.entries, size: formatSize(written.bytes, language) }));
  say(t('ui.pack.files.title'));
  for (const file of included) say(`  ${describeAssetName(file.name)}`);
  say('');
  say(t('ui.pack.send.title'));
  say(t('ui.pack.send.file'));
  say(describeAssetName(zipPath));
  say(t('ui.pack.send.only'));
  say(t('ui.pack.send.sha', { hash }));
  say(t('ui.pack.send.shaHint'));
  return 0;
}

// The text files of the kit, for printing a failure: the ones already loaded, else the language the
// environment asks for. Null when they cannot be read (broken kit); the failure is then printed raw.
function textsForFailure(session, io) {
  if (session.i18n) return session.i18n;
  try {
    return loadI18n(resolveLanguage({ env: io.env ?? process.env }), io.schemaDir);
  } catch {
    return null;
  }
}

// io is { stdout, stderr, stdin } and may carry cwd, env, schemaDir and now (see openScriptContext).
export async function main(argv, io = defaultIo()) {
  const session = { i18n: null };
  try {
    return await run(argv, io, session);
  } catch (error) {
    const i18n = textsForFailure(session, io);
    if (error instanceof Failure && i18n) {
      const lines = [{ key: error.key, params: showParams(error.params) }, ...error.details];
      printProblems(io.stderr, i18n, lines);
      return error.exitCode;
    }
    return failWith(error, io, i18n);
  }
}

// When the reader stops early (for example "... | head"), writing fails with EPIPE. That is not an error.
function ignoreBrokenPipe(stream) {
  stream.on('error', (error) => {
    if (error.code !== 'EPIPE') throw error;
  });
}

if (isMainModule(import.meta.url)) {
  ignoreBrokenPipe(process.stdout);
  ignoreBrokenPipe(process.stderr);
  process.exitCode = await main(process.argv.slice(2));
}
