// Everything that touches the file system for a pack: reading it, writing answers, refreshing the
// generated files, and the common start-up of the scripts. Every path is checked to stay inside
// the pack root, and every write goes to a temporary file first and is then renamed.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGUAGES, loadI18n, resolveLanguage } from './i18n.mjs';
import { assertNotLinked, buildManifest } from './manifest.mjs';
import { parseAssets, parseFile } from './parse.mjs';
import { renderAssets, renderFile, renderOpenQuestions } from './render.mjs';
import { checkAnswerInput, effectiveLevel, entryFromInput, findQuestion } from './rules.mjs';
import { DEFAULT_SCHEMA_DIR, loadSchema } from './schema.mjs';
import {
  InputError,
  MAX_ASSET_BYTES,
  MAX_ASSET_FILES,
  MAX_ASSET_ROWS,
  MAX_LINE_CHARS,
  MAX_JSON_FILE_BYTES,
  MAX_TEXT_FILE_BYTES,
  PackError,
  RESPONDENT_LINE_SEPARATOR,
  describeAssetName,
  encodeListName,
  encodeListPart,
  hasHiddenCharacters,
  isPackFile,
  isPlainObject,
  isValidDate,
  isoDateTime,
  joinLines,
  localDate,
  parseArgv,
  sanitizeForTerminal,
  uniq,
} from './util.mjs';
import { collectAnswers, nextQuestions, validatePack } from './validate.mjs';

// ---------------------------------------------------------------------------------------------
// Paths and atomic writes

function isOutside(relative) {
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

// The absolute path of relativePath inside root. Throws PackError when it would leave the root,
// also through a symbolic link.
export function resolveInside(root, relativePath) {
  const rootAbsolute = path.resolve(root);
  const shown = String(relativePath);
  if (shown.includes('\0')) throw new PackError('ui.check.err.outsideRoot', { path: shown.replace(/\0/g, '') });
  const target = path.resolve(rootAbsolute, shown);
  if (isOutside(path.relative(rootAbsolute, target))) throw new PackError('ui.check.err.outsideRoot', { path: shown });
  if (!fs.existsSync(rootAbsolute)) return target;

  let probe = target;
  while (!fs.lstatSync(probe, { throwIfNoEntry: false })) probe = path.dirname(probe);
  let real;
  try {
    real = fs.realpathSync(probe);
  } catch {
    throw new PackError('ui.check.err.outsideRoot', { path: shown });
  }
  if (isOutside(path.relative(fs.realpathSync(rootAbsolute), real))) {
    throw new PackError('ui.check.err.outsideRoot', { path: shown });
  }
  return target;
}

// Refuses a target that is a symbolic link: writing there would change a file somewhere else.
export function assertPlainTarget(target, shown = target) {
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (stat && stat.isSymbolicLink()) throw new PackError('ui.check.err.symlinkTarget', { path: shown });
}

// Writes next to the target, then renames over it, so a reader never sees half a file. The
// temporary name is random and the file is created exclusively, so a link planted in advance
// cannot be followed.
export function writeFileAtomic(target, content) {
  assertPlainTarget(target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporary, target);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function describeBytes(bytes) {
  return `${bytes / (1024 * 1024)} MB`;
}

function readUtf8(absolute, shown) {
  try {
    return fs.readFileSync(absolute, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    throw new PackError('ui.check.err.unreadable', { path: shown });
  }
}

// The text of a file, or null when it does not exist. A file over the limit is refused unread.
function readIfExists(absolute, shown, limit = MAX_TEXT_FILE_BYTES) {
  const stat = fs.statSync(absolute, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile()) throw new PackError('ui.check.err.unreadable', { path: shown });
  if (stat.size > limit) throw new PackError('ui.check.err.fileTooLarge', { path: shown, limit: describeBytes(limit) });
  return readUtf8(absolute, shown);
}

// Runs a parser and adds the file to the error it throws for text that is too long.
function parseWithPath(shown, parse) {
  try {
    return parse();
  } catch (error) {
    if (error instanceof PackError) throw new PackError(error.key, { path: shown, ...error.params });
    throw error;
  }
}

// The ids of the list that belong to the schema; anything else (including names like
// "constructor") is dropped.
function knownIds(schema, value) {
  if (!Array.isArray(value)) return [];
  return uniq(value.filter((id) => typeof id === 'string' && findQuestion(schema, id) !== null));
}

// Reads a file that a person named on the command line: it must be a regular file, and at most
// `limit` bytes are read from it. Returns { text } or { problem } with 'notFile', 'tooLarge' or
// 'unreadable'. A device or a pipe is refused before it is opened.
export function readInputFile(file, limit = MAX_TEXT_FILE_BYTES) {
  let descriptor;
  try {
    if (!fs.statSync(file).isFile()) return { problem: 'notFile' };
    descriptor = fs.openSync(file, 'r');
    if (!fs.fstatSync(descriptor).isFile()) return { problem: 'notFile' };
    const buffer = Buffer.alloc(limit + 1);
    let total = 0;
    while (total < buffer.length) {
      const read = fs.readSync(descriptor, buffer, total, buffer.length - total, null);
      if (read === 0) break;
      total += read;
    }
    if (total > limit) return { problem: 'tooLarge' };
    const text = buffer.toString('utf8', 0, total);
    return { text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text };
  } catch {
    return { problem: 'unreadable' };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

// Makes docs/assets, and docs above it, when they are missing. Returns true when it created the
// folder. A link at docs or docs/assets is refused.
export function ensureAssetsFolder(rootDir, schema) {
  const root = path.resolve(rootDir);
  const folder = schema.generatedFiles.assetsDir;
  for (const parent of [path.posix.dirname(folder), folder]) {
    resolveInside(root, parent);
    assertNotLinked(root, parent);
  }
  const absolute = resolveInside(root, folder);
  const existed = fs.existsSync(absolute);
  fs.mkdirSync(absolute, { recursive: true });
  return !existed;
}

// ---------------------------------------------------------------------------------------------
// Reading a pack

function readOptionalJson(root, relativePath, schema) {
  const text = readIfExists(resolveInside(root, relativePath), relativePath, MAX_JSON_FILE_BYTES);
  if (text === null) return null;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new PackError('ui.check.err.badJson', { path: relativePath });
  }
  if (!isPlainObject(data)) throw new PackError('ui.check.err.badJson', { path: relativePath });
  if (data.schema !== undefined && data.schema !== schema.schema) {
    throw new PackError('ui.check.err.unsupportedSchema', { path: relativePath, found: String(data.schema) });
  }
  return data;
}

function readAnswerFile(root, file, schema) {
  const text = readIfExists(resolveInside(root, file.path), file.path);
  if (text === null) return { path: file.path, exists: false, frontMatter: null, answers: {}, flags: [] };
  const parsed = parseWithPath(file.path, () => parseFile(text, schema));
  const version = parsed.frontMatter && parsed.frontMatter.schema;
  if (version && version !== schema.schema) {
    throw new PackError('ui.check.err.unsupportedSchema', { path: file.path, found: version });
  }
  return { path: file.path, exists: true, ...parsed };
}

// Files below a folder as forward-slash names; hidden and temporary files (see isPackFile) and anything
// that is not a plain file are left out.
function listPlainFiles(directory, shown, prefix = '') {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new PackError('ui.check.err.unreadable', { path: shown });
  }
  const names = [];
  for (const entry of entries) {
    if (!isPackFile(entry.name)) continue;
    if (entry.isDirectory()) {
      for (const nested of listPlainFiles(path.join(directory, entry.name), shown, `${prefix}${entry.name}/`)) names.push(nested);
    } else if (entry.isFile()) {
      names.push(`${prefix}${entry.name}`);
    }
  }
  return names.sort();
}

// The folders that hold the files of a pack must be real folders. A link there could point
// anywhere inside the root, and a zip does not follow it.
function assertPlainFolders(root, schema) {
  const known = [...schema.files.map((file) => file.path), schema.generatedFiles.state, schema.generatedFiles.manifest, schema.generatedFiles.openQuestions, schema.generatedFiles.assets];
  const folders = new Set([schema.generatedFiles.assetsDir, ...known.map((file) => path.posix.dirname(file))]);
  for (const folder of folders) {
    resolveInside(root, folder);
    assertNotLinked(root, folder);
  }
}

// Refuses a pack with an asset over the limit. Reading a pack never opens the assets, so this is
// checked where files are about to be written or hashed, before the first write.
export function assertAssetSizes(root, schema, names) {
  const folder = schema.generatedFiles.assetsDir;
  if (names.length > MAX_ASSET_FILES) throw new PackError('ui.check.err.tooManyAssets', { path: folder, limit: MAX_ASSET_FILES });
  for (const name of names) {
    const shown = `${folder}/${name}`;
    if (fs.statSync(resolveInside(root, shown)).size > MAX_ASSET_BYTES) {
      throw new PackError('ui.check.err.assetTooLarge', { path: shown, limit: describeBytes(MAX_ASSET_BYTES) });
    }
  }
}

function readAssets(root, schema) {
  const tablePath = schema.generatedFiles.assets;
  const tableText = readIfExists(resolveInside(root, tablePath), tablePath);
  const directory = resolveInside(root, schema.generatedFiles.assetsDir);
  return {
    rows: tableText === null ? [] : parseWithPath(tablePath, () => parseAssets(tableText)),
    present: listPlainFiles(directory, schema.generatedFiles.assetsDir),
  };
}

function pickLanguage(schema, state, manifest, files) {
  const candidates = [state && state.language, manifest && manifest.language];
  for (const file of Object.values(files)) candidates.push(file.exists && file.frontMatter ? file.frontMatter.language : null);
  return candidates.find((language) => schema.languages.includes(language)) ?? null;
}

function pickDepth(schema, state, manifest) {
  const candidates = [state && state.depth, manifest && manifest.depth];
  return candidates.find((depth) => typeof depth === 'string' && Object.hasOwn(schema.depths, depth)) ?? 'standard';
}

// -> { root, language, depth, paths, files, assets, manifest, state }  (FORMAT.md section 11)
// A folder without a pack gives a pack where every file is missing; it is not an error.
export function parsePack(rootDir, schema) {
  const root = path.resolve(rootDir);
  const files = {};
  for (const file of schema.files) files[file.id] = readAnswerFile(root, file, schema);
  assertPlainFolders(root, schema);
  const state = readOptionalJson(root, schema.generatedFiles.state, schema);
  if (state && Object.hasOwn(state, 'focus')) state.focus = knownIds(schema, state.focus);
  const manifest = readOptionalJson(root, schema.generatedFiles.manifest, schema);
  return {
    root,
    language: pickLanguage(schema, state, manifest, files),
    depth: pickDepth(schema, state, manifest),
    paths: { ...schema.generatedFiles },
    files,
    assets: readAssets(root, schema),
    manifest,
    state,
  };
}

// True when the folder holds nothing of a pack yet.
export function isEmptyPack(pack) {
  return (
    Object.values(pack.files).every((file) => !file.exists) &&
    !pack.state &&
    !pack.manifest &&
    pack.assets.rows.length === 0 &&
    pack.assets.present.length === 0
  );
}

// ---------------------------------------------------------------------------------------------
// Refreshing the generated files

function writeIfChanged(absolute, text, current) {
  if (current === text) return false;
  writeFileAtomic(absolute, text);
  return true;
}

// A generated file larger than the read limit would make the whole pack unreadable.
function assertReadable(text, shown, limit = MAX_TEXT_FILE_BYTES) {
  if (Buffer.byteLength(text, 'utf8') > limit) {
    throw new PackError('ui.check.err.generatedTooLarge', { path: shown, limit: describeBytes(limit) });
  }
}

function withoutUpdatedAt(manifest) {
  return JSON.stringify({ ...manifest, updatedAt: '' });
}

// Works out, without writing anything, what the generated files will contain for a pack as it is
// going to be: the report, the open-questions file and the manifest. `contents` (a Map from path
// to text) holds the files that are about to be written, so that their hash can be taken from the
// text. Everything that can fail (an unreadable asset, a file too large) fails here.
function planGenerated(root, schema, i18n, base, { depth, today, now, contents }) {
  const report = validatePack(base, schema, { depth, today });
  const openPath = schema.generatedFiles.openQuestions;
  const openAbsolute = resolveInside(root, openPath);
  const openCurrent = readIfExists(openAbsolute, openPath);
  const openText = renderOpenQuestions(report, i18n, openCurrent ?? undefined);
  assertReadable(openText, openPath);
  const allContents = new Map(contents);
  allContents.set(openPath, openText);
  const createdAt = base.manifest ? base.manifest.createdAt : undefined;
  const fresh = buildManifest(base, report, { now, createdAt, schema: schema.schema, contents: allContents });
  const unchanged = Boolean(base.manifest) && withoutUpdatedAt(base.manifest) === withoutUpdatedAt(fresh);
  const manifest = unchanged ? base.manifest : fresh;
  const manifestPath = schema.generatedFiles.manifest;
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  if (!unchanged) assertReadable(manifestText, manifestPath, MAX_JSON_FILE_BYTES);
  return {
    report,
    manifest,
    files: [
      { relative: openPath, absolute: openAbsolute, text: openText, current: openCurrent },
      ...(unchanged ? [] : [{ relative: manifestPath, absolute: resolveInside(root, manifestPath), text: manifestText, current: null }]),
    ],
  };
}

// Rewrites the open-questions file and the manifest from the answers on disk. A file is only
// written when its content changes, and the manifest keeps its updatedAt then. Nothing is written
// unless both files could be worked out.
// opts: { schema?, schemaDir?, i18n?, language?, depth?, now?, today? }
// Returns { written, pack, report, manifest }.
export function refreshPack(rootDir, opts = {}) {
  const schema = opts.schema ?? loadSchema();
  const root = path.resolve(rootDir);
  const now = opts.now ?? new Date();
  const existing = parsePack(root, schema);
  const language = existing.language ?? opts.language;
  if (!language) throw new PackError('ui.check.err.noLanguage');
  assertAssetSizes(root, schema, existing.assets.present);
  const base = existing.language ? existing : { ...existing, language };
  const i18n = opts.i18n ?? loadI18n(language, opts.schemaDir);
  const depth = opts.depth ?? base.depth;
  const plan = planGenerated(root, schema, i18n, base, { depth, today: opts.today ?? localDate(now), now, contents: new Map() });
  const written = [];
  for (const file of plan.files) {
    if (writeIfChanged(file.absolute, file.text, file.current)) written.push(file.relative);
  }
  return { written, pack: { ...base, manifest: plan.manifest }, report: plan.report, manifest: plan.manifest };
}

// The assets table must stay readable: at most MAX_ASSET_ROWS rows, no line over MAX_LINE_CHARS and
// no more than MAX_TEXT_FILE_BYTES in all. A table over a limit is refused (exit 2) with what to cut.
function checkTableLimits(rows, text, i18n) {
  if (rows.length > MAX_ASSET_ROWS) throw new InputError([{ key: 'ui.assets.err.tooManyRows', params: { limit: MAX_ASSET_ROWS } }]);
  if (text.split('\n').some((line) => line.length > MAX_LINE_CHARS)) {
    const row = rows.find((candidate) => renderAssets([candidate], i18n).split('\n').some((line) => line.length > MAX_LINE_CHARS));
    throw new InputError([{ key: 'ui.assets.err.lineTooLong', params: { file: describeAssetName(row ? row.file : ''), limit: MAX_LINE_CHARS } }]);
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_FILE_BYTES) {
    throw new InputError([{ key: 'ui.assets.err.tableTooLarge', params: { limit: describeBytes(MAX_TEXT_FILE_BYTES) } }]);
  }
}

// Writes the assets table (the rows are { file, what, owner, rights, restrictions }) and brings the
// open-questions file and the manifest up to date. The limits are checked first, and nothing is
// written when a limit is passed or a generated file cannot be worked out.
// opts: { schema?, schemaDir?, i18n?, language?, now?, today? }. Returns { written, pack, report }.
export function writeAssetsTable(rootDir, rows, opts = {}) {
  const schema = opts.schema ?? loadSchema();
  const root = path.resolve(rootDir);
  const now = opts.now ?? new Date();
  const pack = parsePack(root, schema);
  const language = pack.language ?? opts.language ?? 'en';
  const i18n = opts.i18n ?? loadI18n(language, opts.schemaDir);
  const tablePath = schema.generatedFiles.assets;
  const tableAbsolute = resolveInside(root, tablePath);
  const text = renderAssets(rows, i18n);
  checkTableLimits(rows, text, i18n);
  assertPlainTarget(tableAbsolute, tablePath);
  const tableFile = { relative: tablePath, absolute: tableAbsolute, text, current: readIfExists(tableAbsolute, tablePath) };
  const base = { ...pack, language: pack.language ?? language, assets: { rows: parseAssets(text), present: pack.assets.present } };
  const written = [];
  if (!pack.language) {
    if (writeIfChanged(tableAbsolute, text, tableFile.current)) written.push(tablePath);
    return { written, pack: base, report: validatePack(base, schema, { today: opts.today ?? localDate(now) }) };
  }
  assertAssetSizes(root, schema, pack.assets.present);
  const plan = planGenerated(root, schema, i18n, base, { depth: base.depth, today: opts.today ?? localDate(now), now, contents: new Map([[tablePath, text]]) });
  for (const file of [tableFile, ...plan.files]) {
    if (writeIfChanged(file.absolute, file.text, file.current)) written.push(file.relative);
  }
  return { written, pack: { ...base, manifest: plan.manifest }, report: plan.report };
}

// ---------------------------------------------------------------------------------------------
// Applying answers

function checkTopLevel(input, schema, pack, problems) {
  const add = (key, params = {}) => problems.push({ key, params });
  if (!Array.isArray(input.answers)) add('ui.answer.err.answersMissing');
  if (input.language !== undefined && !schema.languages.includes(input.language)) {
    add('ui.answer.err.badLanguage', { language: String(input.language) });
  } else if (pack.language && input.language && input.language !== pack.language) {
    add('ui.answer.err.languageChange', { found: pack.language, requested: input.language });
  } else if (!pack.language && input.language === undefined) {
    add('ui.answer.err.languageRequired');
  }
  if (input.depth !== undefined && !(typeof input.depth === 'string' && Object.hasOwn(schema.depths, input.depth))) {
    add('ui.answer.err.badDepth', { depth: String(input.depth) });
  }
  for (const field of ['recipient', 'notes']) {
    if (input[field] !== undefined && typeof input[field] !== 'string') add('ui.answer.err.badField', { field });
    else if (hasHiddenCharacters(input[field])) add('ui.answer.err.controlChars', { where: field });
  }
  const person = input.respondent;
  if (person !== undefined) {
    const valid = isPlainObject(person) && typeof person.name === 'string' && person.name.trim() !== '' && (person.role === undefined || typeof person.role === 'string');
    if (!valid) add('ui.answer.err.badRespondent');
    else if (hasHiddenCharacters(person.name) || hasHiddenCharacters(person.role)) add('ui.answer.err.controlChars', { where: 'respondent' });
  }
  if (input.focus !== undefined) {
    const valid = Array.isArray(input.focus) && input.focus.every((id) => typeof id === 'string' && findQuestion(schema, id));
    if (!valid) add('ui.answer.err.badFocus');
  }
}

// Checks every answer; returns [{ question, entry }] for the ones that are fine.
function checkAnswers(input, schema, problems) {
  const entries = [];
  if (!Array.isArray(input.answers)) return entries;
  const seen = new Set();
  input.answers.forEach((raw, index) => {
    if (!isPlainObject(raw)) {
      problems.push({ key: 'ui.answer.err.notAnAnswer', params: { index: index + 1 } });
      return;
    }
    const question = typeof raw.id === 'string' ? findQuestion(schema, raw.id) : null;
    if (!question) {
      problems.push({ key: 'ui.answer.err.unknownId', params: { id: String(raw.id) } });
    } else if (seen.has(question.id)) {
      problems.push({ key: 'ui.answer.err.duplicateId', params: { id: question.id } });
    } else {
      seen.add(question.id);
      const found = checkAnswerInput(question, raw);
      if (found.length > 0) {
        for (const problem of found) problems.push(problem);
      } else {
        entries.push({ question, entry: entryFromInput(question, raw) });
      }
    }
  });
  return entries;
}

// An answer to a question that is switched off by another answer would vanish from the file.
function notApplicableProblems(entries, merged, schema) {
  return entries
    .filter(({ question, entry }) => entry.status !== 'missing' && effectiveLevel(question, merged, schema) === 'skipped')
    .map(({ question }) => ({ key: 'ui.answer.err.notApplicable', params: { id: question.id } }));
}

function splitRespondents(text) {
  return String(text ?? '').split(RESPONDENT_LINE_SEPARATOR).map((part) => part.trim()).filter(Boolean);
}

// "Name, Role" for the front matter. Each part is escaped on its own: a comma in the name is
// written as &#44;, so the first comma always ends the name.
function respondentLabel(person) {
  const name = encodeListName(joinLines(person.name).replace(/;/g, ','));
  const role = encodeListPart(joinLines(person.role).replace(/;/g, ','));
  return role === '' ? name : `${name}, ${role}`;
}

// A respondent that is not in the list yet is appended; existing ones are never replaced.
function appendRespondent(existingText, person) {
  const list = splitRespondents(existingText);
  const label = respondentLabel(person);
  if (!list.includes(label)) list.push(label);
  return list.join('; ');
}

function planInput(input, schema, pack) {
  const problems = [];
  if (!isPlainObject(input)) throw new InputError([{ key: 'ui.answer.err.notObject', params: {} }]);
  checkTopLevel(input, schema, pack, problems);
  const entries = checkAnswers(input, schema, problems);
  const merged = collectAnswers(pack, schema);
  for (const { question, entry } of entries) merged[question.id] = entry;
  for (const problem of notApplicableProblems(entries, merged, schema)) problems.push(problem);
  if (problems.length > 0) throw new InputError(problems);
  return { entries, merged };
}

function nextState(input, pack, schema, language, depth, entries, now) {
  const previous = pack.state ?? {};
  const answered = new Set(entries.map(({ question }) => question.id));
  const previousFocus = knownIds(schema, previous.focus);
  const last = entries.length > 0 ? entries[entries.length - 1].question.module : previous.currentModule;
  return {
    schema: schema.schema,
    language,
    depth,
    currentModule: schema.moduleOrder.includes(last) ? last : schema.moduleOrder[0],
    focus: input.focus !== undefined ? knownIds(schema, input.focus) : previousFocus.filter((id) => !answered.has(id)),
    recipient: input.recipient !== undefined ? input.recipient.trim() : (previous.recipient ?? ''),
    notes: input.notes !== undefined ? input.notes : (previous.notes ?? ''),
    updatedAt: isoDateTime(now),
  };
}

function frontMatterMeta(parsed, touched, input, language, today) {
  const existingRespondent = parsed.exists && parsed.frontMatter && parsed.frontMatter.respondent ? parsed.frontMatter.respondent : '';
  const respondent = touched && input.respondent ? appendRespondent(existingRespondent, input.respondent) : existingRespondent;
  const previousUpdated = parsed.exists && parsed.frontMatter ? parsed.frontMatter.updated : undefined;
  const updated = !touched && isValidDate(previousUpdated) ? previousUpdated : today;
  return { language, respondent, updated };
}

// Everything that can fail is worked out before the first file is written: sizes, links in place
// of files, the new texts read back, the check and the next questions on them, the open-questions
// file and the manifest with the hash of every asset. Returns the pack as it is going to be and
// the generated files to write.
function prepareWrite(plans, { root, schema, pack, state, depth, today, now, i18n }) {
  assertAssetSizes(root, schema, pack.assets.present);
  for (const plan of plans) {
    if (Buffer.byteLength(plan.text, 'utf8') > MAX_TEXT_FILE_BYTES) {
      throw new InputError([{ key: 'ui.answer.err.resultTooLarge', params: { path: plan.relative, limit: describeBytes(MAX_TEXT_FILE_BYTES) } }]);
    }
    assertPlainTarget(plan.absolute, plan.relative);
  }
  for (const generated of [schema.generatedFiles.openQuestions, schema.generatedFiles.manifest]) {
    assertPlainTarget(resolveInside(root, generated), generated);
  }
  const files = {};
  const contents = new Map(plans.map((plan) => [plan.relative, plan.text]));
  for (const file of schema.files) {
    files[file.id] = { path: file.path, exists: true, ...parseWithPath(file.path, () => parseFile(contents.get(file.path), schema)) };
  }
  const base = { ...pack, language: state.language, depth, files, state };
  const plan = planGenerated(root, schema, i18n, base, { depth, today, now, contents });
  nextQuestions(base, schema, plan.report, { count: 3 });
  return { pack: { ...base, manifest: plan.manifest }, report: plan.report, files: plan.files };
}

// Merges answers into the pack in rootDir and refreshes everything generated. Creates the
// skeleton (six answer files, the assets table and the empty docs/assets folder) on first use.
// It is all or nothing as far as the program can tell: every file is worked out first, and the
// first write happens only when nothing failed.
//
// input: the JSON of answer.mjs (FORMAT.md section 12).  Bad input throws InputError and writes nothing.
// opts: { schema?, schemaDir?, i18n?, now?, today? }
// Returns { written, report, pack }: the files written (relative, forward slashes), the report
// and the pack as it is on disk afterwards.
export function applyAnswers(rootDir, input, opts = {}) {
  const schema = opts.schema ?? loadSchema();
  const root = path.resolve(rootDir);
  const now = opts.now ?? new Date();
  const today = opts.today ?? localDate(now);
  const pack = parsePack(root, schema);
  const { entries, merged } = planInput(input, schema, pack);

  const language = pack.language ?? input.language;
  const depth = input.depth ?? pack.depth;
  const i18n = opts.i18n ?? loadI18n(language, opts.schemaDir);
  const touched = new Set(entries.map(({ question }) => question.file));

  const plans = [];
  for (const file of schema.files) {
    const meta = frontMatterMeta(pack.files[file.id], touched.has(file.id), input, language, today);
    const text = renderFile(schema, i18n, file.id, merged, meta);
    const absolute = resolveInside(root, file.path);
    plans.push({ relative: file.path, absolute, text, current: readIfExists(absolute, file.path) });
  }
  const assetsPath = schema.generatedFiles.assets;
  const assetsAbsolute = resolveInside(root, assetsPath);
  if (readIfExists(assetsAbsolute, assetsPath) === null) {
    plans.push({ relative: assetsPath, absolute: assetsAbsolute, text: renderAssets([], i18n), current: null });
  }
  const state = nextState(input, pack, schema, language, depth, entries, now);
  const statePath = schema.generatedFiles.state;
  const stateAbsolute = resolveInside(root, statePath);
  plans.push({ relative: statePath, absolute: stateAbsolute, text: `${JSON.stringify(state, null, 2)}\n`, current: readIfExists(stateAbsolute, statePath) });
  const assetsFolder = resolveInside(root, schema.generatedFiles.assetsDir);
  const ready = prepareWrite(plans, { root, schema, pack, state, depth, today, now, i18n });

  fs.mkdirSync(assetsFolder, { recursive: true });
  const written = [];
  for (const plan of [...plans, ...ready.files]) {
    if (writeIfChanged(plan.absolute, plan.text, plan.current)) written.push(plan.relative);
  }
  return { written, report: ready.report, pack: ready.pack };
}

// ---------------------------------------------------------------------------------------------
// Common start-up of the scripts

// True when moduleUrl is the file node was started with (compared after resolving links).
export function isMainModule(moduleUrl) {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(fileURLToPath(moduleUrl)) === fs.realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

export function currentTime(io) {
  if (typeof io.now === 'function') return io.now();
  return io.now instanceof Date ? io.now : new Date();
}

// Prints problems ({ key, params }) one per line. They can hold text from the pack or from the
// input, so every line is made safe for a terminal first.
export function printProblems(stream, i18n, problems) {
  for (const problem of problems) stream.write(`${sanitizeForTerminal(i18n.t(problem.key, problem.params))}\n`);
}

// Prints an error in the given language and returns the exit code: 2 for bad input, 3 for the rest.
export function failWith(error, io, i18n) {
  if (!i18n) {
    io.stderr.write(`${sanitizeForTerminal(error && error.message ? error.message : String(error))}\n`);
    return error instanceof InputError ? 2 : 3;
  }
  if (error instanceof InputError) {
    printProblems(io.stderr, i18n, error.problems);
    return 2;
  }
  if (error instanceof PackError) {
    printProblems(io.stderr, i18n, [{ key: error.key, params: error.params }]);
    return 3;
  }
  printProblems(io.stderr, i18n, [{ key: 'ui.check.err.unexpected', params: { message: error && error.message ? error.message : String(error) } }]);
  return 3;
}

// Parses the options every script shares (--root, --lang), loads the schema and the pack, and
// picks the language. Returns { exitCode } when the script should stop, else the context.
// io may carry extra fields for tests: cwd, env, now() and schemaDir.
export function openScriptContext(argv, io, extraOptions = {}) {
  const env = io.env ?? process.env;
  const cwd = io.cwd ?? process.cwd();
  const schemaDir = io.schemaDir ?? DEFAULT_SCHEMA_DIR;
  const parsed = parseArgv(argv, { root: 'string', lang: 'string', ...extraOptions });
  const wanted = parsed.values.lang;
  const earlyLanguage = LANGUAGES.includes(wanted) ? wanted : resolveLanguage({ env });
  const earlyI18n = loadI18n(earlyLanguage, schemaDir);

  const problems = [...parsed.problems];
  for (const argument of parsed.positionals) problems.push({ key: 'ui.check.err.unexpectedArgument', params: { argument } });
  if (wanted !== undefined && !LANGUAGES.includes(wanted)) problems.push({ key: 'ui.check.err.badLanguage', params: { language: wanted } });
  if (problems.length > 0) {
    printProblems(io.stderr, earlyI18n, problems);
    return { exitCode: 2 };
  }

  const schema = loadSchema(path.join(schemaDir, 'intake-schema.json'));
  const root = path.resolve(cwd, parsed.values.root ?? '.');
  let pack;
  try {
    pack = parsePack(root, schema);
  } catch (error) {
    return { exitCode: failWith(error, io, earlyI18n) };
  }
  const language = resolveLanguage({ lang: wanted, packLanguage: pack.language, env });
  const i18n = language === earlyLanguage ? earlyI18n : loadI18n(language, schemaDir);
  // Files that are written use the language of the pack, not the one chosen for the console.
  const fileI18n = pack.language && pack.language !== language ? loadI18n(pack.language, schemaDir) : i18n;
  return { values: parsed.values, root, cwd, schemaDir, schema, pack, i18n, fileI18n, language, now: currentTime(io) };
}
