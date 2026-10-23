// Validation, scoring, the must-answer check and "what to ask next" (FORMAT.md sections 9, 11 and 14).
// Works on plain data, so the static form can use it too. This file must stay pure.

import { effectiveLevel, findQuestion, inDepth, parseBody, questionsInOrder, selectedChoices, textLength } from './rules.mjs';
import { MAX_ASSET_BYTES, MAX_ASSET_FILES, MAX_FLAGS_PER_KIND, MAX_PACK_BYTES, MAX_PACK_FILES, describeAssetName, entryNameProblems, formatMegabytes, hasHiddenCharacters, isPlainObject, isStorableAssetName, isValidDate, joinLines, localDate, restoreSetextLines, uniq } from './util.mjs';

// The design inputs that must be answered before the design inputs count as sufficient.
export const DESIGN_INPUT_IDS = ['E.like', 'E.dislike', 'E.feel'];

const URL_CHECKED_IDS = ['E.like', 'E.dislike', 'E.competitors', 'A.existing-site'];
const ALWAYS_WARN_FLAGS = ['rule.badChoice', 'rule.dateInPast'];
const MAX_URL_FLAGS = 10;
const UNKNOWN_RIGHTS = ['unknown', 'ukendt'];

// True when the rights column says that the rights are not known (allowed, but listed).
export function isUnknownRights(rights) {
  return UNKNOWN_RIGHTS.includes(String(rights ?? '').trim().toLowerCase());
}
const LEADING_PUNCTUATION = '(<[';
const TRAILING_PUNCTUATION = ')>],;.';
const URL_START = /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+$/i;
const DOMAIN_LIKE = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+(?:[/:?#]\S*)?$/i;

function newFlag(id, severity, params, where = {}) {
  const flag = { id, severity };
  if (where.qid) flag.qid = where.qid;
  if (where.file) flag.file = where.file;
  flag.params = params;
  return flag;
}

// Removes brackets and punctuation around a word, looking from each end (no pattern that backtracks).
function trimPunctuation(token) {
  let start = 0;
  let end = token.length;
  while (start < end && LEADING_PUNCTUATION.includes(token[start])) start += 1;
  while (end > start && TRAILING_PUNCTUATION.includes(token[end - 1])) end -= 1;
  return token.slice(start, end);
}

function looksLikeAddress(token) {
  const lower = token.toLowerCase();
  return lower.startsWith('http') || lower.startsWith('www.') || lower.includes('://');
}

// 'ok' when the entry holds a web address, 'broken' when a word looks like one but is not,
// 'text' for pasted text.
function classifyLink(text) {
  const words = text.split(/\s+/).map(trimPunctuation).filter(Boolean);
  if (words.some((word) => URL_START.test(word) || DOMAIN_LIKE.test(word))) return 'ok';
  return words.some(looksLikeAddress) ? 'broken' : 'text';
}

// Pasted text is allowed in link lists (information); a broken address is a warning.
function linkProblems(items) {
  const problems = [];
  for (const item of items) {
    const kind = classifyLink(item.text);
    if (kind === 'ok') continue;
    problems.push({ id: 'rule.notUrl', severity: kind === 'broken' ? 'warn' : 'info', params: { item: item.text } });
    if (problems.length === MAX_URL_FLAGS) break;
  }
  return problems;
}

// All answers of the pack by question id. When an id appears twice, the first one wins and the
// duplicate is listed in `duplicates` (files are read in schema order).
function gatherAnswers(packData, schema) {
  const answers = Object.create(null);
  const duplicates = [];
  for (const file of schema.files) {
    const parsed = packData.files && packData.files[file.id];
    if (!parsed || parsed.exists === false) continue;
    for (const [id, entry] of Object.entries(parsed.answers ?? {})) {
      if (Object.hasOwn(answers, id)) duplicates.push({ qid: id, file: file.id });
      else answers[id] = entry;
    }
  }
  return { answers, duplicates };
}

export function collectAnswers(packData, schema) {
  return gatherAnswers(packData, schema).answers;
}

// ---------------------------------------------------------------------------------------------
// Judging one answer

// What an answer contains, by type:
//   filled  there is content;  unmet  rules a `complete` answer fails (and is then partial);
//   always  problems reported for complete and partial answers;  invalid  content exists but is unusable.
function inspectText(question, value) {
  const length = textLength(value.text);
  const min = question.rules && question.rules.minChars;
  const unmet = min && length < min ? [{ id: 'rule.minChars', params: { min, actual: length } }] : [];
  return { filled: length > 0, unmet, always: [], invalid: false };
}

function inspectList(question, value) {
  const min = question.rules && question.rules.minItems;
  const unmet = min && value.items.length < min ? [{ id: 'rule.minItems', params: { min, actual: value.items.length } }] : [];
  const always = URL_CHECKED_IDS.includes(question.id) ? linkProblems(value.items) : [];
  return { filled: value.items.length > 0, unmet, always, invalid: false };
}

function inspectChoice(question, value) {
  const allowed = question.choices ?? [];
  const single = question.type === 'choice';
  const usable = (id, index) => allowed.includes(id) && !(single && index > 0);
  const always = value.choice
    .map((id, index) => (usable(id, index) ? null : { id: 'rule.badChoice', params: { choice: id } }))
    .filter(Boolean);
  const unmet = value.choice.length === 0 ? [{ id: 'rule.noChoice', params: {} }] : [];
  const invalid = value.choice.length > 0 && !value.choice.some(usable);
  return { filled: value.choice.length > 0, unmet, always, invalid };
}

function inspectDate(value, today) {
  if (value.date === '') return { filled: false, unmet: [{ id: 'rule.badDate', params: { value: '' } }], always: [], invalid: false };
  if (!isValidDate(value.date)) {
    return { filled: true, unmet: [], always: [{ id: 'rule.badDate', params: { value: value.date } }], invalid: true };
  }
  const always = value.date < today ? [{ id: 'rule.dateInPast', params: { date: value.date } }] : [];
  return { filled: true, unmet: [], always, invalid: false };
}

function valueOf(question, entry) {
  return entry.value ?? parseBody(question, entry.body ?? '');
}

function inspectAnswer(question, entry, today) {
  const value = valueOf(question, entry);
  if (question.type === 'date') return inspectDate(value, today);
  if (question.type === 'list' || question.type === 'urllist' || question.type === 'files') return inspectList(question, value);
  if (question.type === 'choice' || question.type === 'multichoice') return inspectChoice(question, value);
  return inspectText(question, value);
}

function tbdProblems(entry) {
  const problems = [];
  if (!entry.owner) problems.push({ id: 'tbd.noOwner', severity: 'warn', params: {} });
  if (!entry.due) problems.push({ id: 'tbd.noDue', severity: 'info', params: {} });
  return problems;
}

// -> { status, declared, owner, due, note, problems: [{ id, severity, params }] }
function judgeAnswer(question, entry, level, today) {
  const declared = entry ? entry.status : 'missing';
  const result = { status: declared, declared, owner: entry ? entry.owner : '', due: entry ? entry.due : '', note: '', problems: [] };
  if (declared === 'missing') return result;
  if (declared === 'tbd') {
    result.note = joinLines(restoreSetextLines(entry.body));
    result.problems = tbdProblems(entry);
    return result;
  }
  const severity = level === 'gate1' ? 'block' : 'warn';
  const found = inspectAnswer(question, entry, today);
  const withSeverity = (problem) => ({ ...problem, severity: problem.severity ?? (ALWAYS_WARN_FLAGS.includes(problem.id) ? 'warn' : severity) });
  const reported = declared === 'complete' ? [...found.unmet, ...found.always] : found.always;
  result.problems = (found.filled || declared === 'complete') ? reported.map(withSeverity) : [];
  if (!found.filled) result.status = 'missing';
  else if (declared === 'complete' && (found.invalid || found.unmet.length > 0)) result.status = 'partial';
  return result;
}

// ---------------------------------------------------------------------------------------------
// Pack level checks

function fileProblems(packData, schema, language) {
  const flags = [];
  for (const file of schema.files) {
    const parsed = packData.files && packData.files[file.id];
    const where = { file: file.id };
    if (!parsed || parsed.exists === false) {
      flags.push(newFlag('file.missing', 'info', { file: file.id, path: file.path }, where));
      continue;
    }
    for (const flag of parsed.flags ?? []) {
      flags.push({ ...flag, file: file.id, params: { file: file.id, path: file.path, ...flag.params } });
    }
    const found = parsed.frontMatter && parsed.frontMatter.language;
    if (language && found && schema.languages.includes(found) && found !== language) {
      flags.push(newFlag('file.languageMismatch', 'warn', { file: file.id, path: file.path, found, expected: language }, where));
    }
  }
  return flags;
}

// The name in the table row without the folder, exactly as written (backslashes are kept).
export function storedAssetName(file) {
  return file.replace(/^(?:docs\/)?assets\//, '');
}

// The name of an asset inside docs/assets, from the form used in the table ("assets/logo.svg"),
// also when it is written with backslashes or a leading ./.
export function assetName(file) {
  return file.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^(?:docs\/)?assets\//, '');
}

// Adds a flag for each row that passes the test, but no more than MAX_FLAGS_PER_KIND of one kind,
// so a table with thousands of rows cannot fill the report.
function addRowFlags(flags, rows, id, test, paramsOf = (row) => ({ file: row.file })) {
  let added = 0;
  for (const row of rows) {
    if (added === MAX_FLAGS_PER_KIND) return;
    if (test(row)) {
      flags.push(newFlag(id, 'warn', paramsOf(row)));
      added += 1;
    }
  }
}

// The key that two spellings of one file name share: the table may be written with composed
// accents (NFC) while the disk holds decomposed ones (NFD), as macOS does.
export function assetKey(file) {
  return assetName(file).normalize('NFC');
}

function hasHiddenText(row) {
  return [row.what, row.owner, row.rights, row.restrictions].some(hasHiddenCharacters);
}

// Files that the zip would refuse, each once: [{ name, code, other? }] with names relative to the
// assets folder. Names that cannot be listed are left out; they have their own flag.
export function notPackableAssets(present, assetsDir = 'docs/assets') {
  return notPackableAmong(present.filter(isStorableAssetName), assetsDir);
}

function notPackableAmong(storable, assetsDir) {
  const prefix = `${assetsDir}/`;
  const seen = new Set();
  const result = [];
  for (const problem of entryNameProblems(storable.map((name) => prefix + name))) {
    const name = problem.name.slice(prefix.length);
    if (seen.has(name)) continue;
    seen.add(name);
    const entry = { name, code: problem.code };
    if (problem.other !== undefined) entry.other = problem.other.slice(prefix.length);
    result.push(entry);
  }
  return result;
}

function assetProblems(assets, assetsDir) {
  const rows = (assets && assets.rows) ?? [];
  const present = (assets && assets.present) ?? [];
  const presentKeys = new Set(present.map((name) => name.normalize('NFC')));
  const listedKeys = new Set(rows.map((row) => assetKey(row.file)));
  const flags = [];
  const storable = [];
  let unlisted = 0;
  let badNames = 0;
  const addBadName = (shown) => {
    if (badNames < MAX_FLAGS_PER_KIND) flags.push(newFlag('assets.badName', 'warn', { file: shown }));
    badNames += 1;
  };
  for (const shown of (assets && assets.invalid) ?? []) addBadName(shown);
  for (const name of present) {
    if (!isStorableAssetName(name)) {
      addBadName(describeAssetName(name));
    } else {
      storable.push(name);
      if (!listedKeys.has(name.normalize('NFC')) && unlisted < MAX_FLAGS_PER_KIND) {
        flags.push(newFlag('assets.unlisted', 'warn', { file: name }));
        unlisted += 1;
      }
    }
  }
  for (const entry of notPackableAmong(storable, assetsDir).slice(0, MAX_FLAGS_PER_KIND)) {
    const params = { file: describeAssetName(entry.name), reasonCode: entry.code };
    if (entry.other !== undefined) params.other = describeAssetName(entry.other);
    flags.push(newFlag('assets.notPackable', 'warn', params));
  }
  // Links and special files are not part of a zip; their names are already written for display.
  for (const shown of ((assets && assets.notPlain) ?? []).slice(0, MAX_FLAGS_PER_KIND)) {
    flags.push(newFlag('assets.notPackable', 'warn', { file: shown, reasonCode: 'notPlain' }));
  }
  // Files over the size of the zip are left unread; files over the number that is listed are left out.
  for (const entry of ((assets && assets.large) ?? []).slice(0, MAX_FLAGS_PER_KIND)) {
    flags.push(newFlag('assets.tooLarge', 'warn', { file: describeAssetName(entry.name), size: formatMegabytes(entry.size), limit: formatMegabytes(MAX_ASSET_BYTES), bytes: entry.size }));
  }
  if (assets && assets.omitted > 0) {
    flags.push(newFlag('assets.tooMany', 'warn', { count: assets.omitted, limit: assets.fileLimit ?? MAX_ASSET_FILES }));
  }
  const nameParams = (row) => ({ file: describeAssetName(row.file) });
  addRowFlags(flags, rows, 'assets.badName', (row) => !isStorableAssetName(storedAssetName(row.file)), nameParams);
  addRowFlags(flags, rows, 'assets.missingFile', (row) => !presentKeys.has(assetKey(row.file)));
  addRowFlags(flags, rows, 'assets.noRights', (row) => row.rights.trim() === '');
  addRowFlags(flags, rows, 'assets.rightsUnknown', (row) => isUnknownRights(row.rights));
  addRowFlags(flags, rows, 'text.hiddenCharacters', hasHiddenText, (row) => ({ label: describeAssetName(row.file) }));
  return flags;
}

// Text in the state and the manifest that a person could have put there with an editor.
function storedTextProblems(packData, schema) {
  const stateFile = (schema.generatedFiles && schema.generatedFiles.state) || 'docs/intake-state.json';
  const manifestFile = (schema.generatedFiles && schema.generatedFiles.manifest) || 'docs/intake-manifest.json';
  const flags = [];
  const flag = (label) => flags.push(newFlag('text.hiddenCharacters', 'warn', { label }));
  const hidden = (value) => typeof value === 'string' && hasHiddenCharacters(value);
  const { state, manifest } = packData;
  if (isPlainObject(state)) {
    for (const field of ['recipient', 'notes']) if (hidden(state[field])) flag(`${stateFile} (${field})`);
  }
  if (isPlainObject(manifest)) {
    if (isPlainObject(manifest.project) && hidden(manifest.project.name)) flag(`${manifestFile} (project)`);
    const people = Array.isArray(manifest.respondents) ? manifest.respondents : [];
    if (people.some((person) => isPlainObject(person) && (hidden(person.name) || hidden(person.role)))) flag(`${manifestFile} (respondents)`);
  }
  return flags;
}

// pack puts the files of the layout and every asset in the zip, and stops at MAX_PACK_FILES entries or
// MAX_PACK_BYTES bytes. The layout is the answer files, the open-questions file, the table, the
// manifest and the state; they are counted as there, whether they exist yet or not.
function packSizeProblems(packData, schema) {
  const assets = packData.assets ?? {};
  const layout = schema.files.length + 4;
  const entries = layout + ((assets.present ?? []).length + (assets.omitted ?? 0));
  const bytes = assets.bytes ?? 0;
  if (entries <= MAX_PACK_FILES && bytes <= MAX_PACK_BYTES) return [];
  return [
    newFlag('pack.tooBig', 'warn', {
      entries,
      maxEntries: MAX_PACK_FILES,
      size: formatMegabytes(bytes),
      maxSize: formatMegabytes(MAX_PACK_BYTES),
      bytes,
      maxBytes: MAX_PACK_BYTES,
    }),
  ];
}

function crossProblems(packData, schema, answers, statuses) {
  const flags = [];
  const picked = (id) => selectedChoices(schema, answers, id);
  const languages = picked('D.languages');
  const features = picked('G.features');
  if (languages.length >= 2 && features.length > 0 && !features.includes('multilingual')) {
    flags.push(newFlag('cross.languagesVsMultilingual', 'warn', { languages: languages.join(', ') }));
  }
  const existingSite = answers['A.existing-site'];
  const siteAnswered = existingSite && (existingSite.status === 'complete' || existingSite.status === 'partial');
  const siteItems = siteAnswered ? valueOf(findQuestion(schema, 'A.existing-site'), existingSite).items : [];
  if (picked('A.project-kind').includes('redesign') && siteItems.length === 0) {
    flags.push(newFlag('cross.redesignNoSite', 'warn', {}));
  }
  const present = (packData.assets && packData.assets.present) ?? [];
  if (picked('B.assets-status').some((choice) => choice === 'guidelines' || choice === 'partial') && present.length === 0) {
    flags.push(newFlag('cross.assetsClaimedMissing', 'warn', {}));
  }
  const done = DESIGN_INPUT_IDS.filter((id) => statuses[id] === 'complete').length;
  if (done < DESIGN_INPUT_IDS.length) {
    flags.push(newFlag('cross.designInputsThin', 'info', { count: done, min: DESIGN_INPUT_IDS.length }));
  }
  return flags;
}

// ---------------------------------------------------------------------------------------------
// Scoring

function emptyBucket() {
  return { total: 0, weight: 0, earned: 0 };
}

function bucketScore(bucket) {
  return { score: bucket.weight === 0 ? 0 : Math.round((bucket.earned / bucket.weight) * 10000) / 10000, total: bucket.total };
}

function summarize(schema, records, depth) {
  const counts = { complete: 0, partial: 0, tbd: 0, missing: 0, skipped: 0 };
  const overall = emptyBucket();
  const byFile = Object.fromEntries(schema.files.map((file) => [file.id, emptyBucket()]));
  const byModule = Object.fromEntries(schema.moduleOrder.map((id) => [id, emptyBucket()]));
  const byArea = Object.fromEntries(schema.areas.map((area) => [area, emptyBucket()]));
  for (const record of records) {
    if (record.level === 'skipped') {
      counts.skipped += 1;
      continue;
    }
    if (!inDepth(record.level, depth, schema)) continue;
    counts[record.status] += 1;
    const weight = schema.weights[record.level];
    const earned = weight * (schema.statusScores[record.status] ?? 0);
    for (const bucket of [overall, byFile[record.file], byModule[record.module], byArea[record.area]]) {
      if (!bucket) continue;
      bucket.total += 1;
      bucket.weight += weight;
      bucket.earned += earned;
    }
  }
  const scored = (buckets) => Object.fromEntries(Object.entries(buckets).map(([key, bucket]) => [key, bucketScore(bucket)]));
  return {
    overall: bucketScore(overall).score,
    counts,
    byModule: scored(byModule),
    byFile: scored(byFile),
    byArea: scored(byArea),
  };
}

// ---------------------------------------------------------------------------------------------
// The report

// packData: { language, depth, files: { [fileId]: { exists, frontMatter, answers, flags } }, assets: { rows, present } }
// opts: { depth, today }.  Returns the Report of FORMAT.md section 11.
export function validatePackData(packData, schema, opts = {}) {
  const depth = opts.depth ?? packData.depth ?? 'standard';
  if (!Object.hasOwn(schema.depths, depth)) throw new Error(`Unknown depth: ${depth}`);
  const today = opts.today ?? localDate();
  const language = packData.language ?? null;
  const { answers, duplicates } = gatherAnswers(packData, schema);

  const flags = fileProblems(packData, schema, language);
  for (const duplicate of duplicates) {
    const path = schema.files.find((file) => file.id === duplicate.file).path;
    flags.push(newFlag('marker.duplicate', 'warn', { file: duplicate.file, path, qid: duplicate.qid }, duplicate));
  }

  const questions = {};
  const statuses = {};
  const records = [];
  for (const question of questionsInOrder(schema)) {
    const level = effectiveLevel(question, answers, schema);
    const entry = answers[question.id];
    const declared = entry ? entry.status : 'missing';
    let record = { status: 'skipped', declared, owner: '', due: '', note: '', problems: [] };
    if (level !== 'skipped') record = judgeAnswer(question, entry, level, today);
    else if (entry && declared !== 'missing' && question.showIf) {
      record.problems = [{ id: 'answer.notApplicable', severity: 'info', params: { controller: question.showIf.id } }];
    }
    const where = { qid: question.id, file: question.file };
    const questionFlags = record.problems.map((problem) => newFlag(problem.id, problem.severity, problem.params, where));
    for (const flag of questionFlags) flags.push(flag);
    questions[question.id] = {
      status: record.status,
      declared: record.declared,
      level,
      flags: questionFlags.map(({ id, severity, params }) => ({ id, severity, params })),
      owner: record.owner,
      due: record.due,
      note: record.note,
      inScope: level !== 'skipped' && inDepth(level, depth, schema),
    };
    statuses[question.id] = record.status;
    records.push({ level, status: record.status, file: question.file, module: question.module, area: question.area });
  }
  for (const flag of flags) {
    if (flag.qid && Object.hasOwn(questions, flag.qid) && !questions[flag.qid].flags.some((own) => own.id === flag.id)) {
      questions[flag.qid].flags.push({ id: flag.id, severity: flag.severity, params: flag.params });
    }
  }
  for (const flag of assetProblems(packData.assets, (schema.generatedFiles && schema.generatedFiles.assetsDir) || 'docs/assets')) flags.push(flag);
  for (const flag of storedTextProblems(packData, schema)) flags.push(flag);
  for (const flag of packSizeProblems(packData, schema)) flags.push(flag);
  for (const flag of crossProblems(packData, schema, answers, statuses)) flags.push(flag);

  const blocking = Object.entries(questions)
    .filter(([, entry]) => entry.level === 'gate1' && entry.status !== 'complete')
    .map(([id]) => id);
  return {
    language,
    depth,
    questions,
    gate1: { ready: blocking.length === 0, blocking },
    completeness: summarize(schema, records, depth),
    flags,
  };
}

export function validatePack(pack, schema, opts = {}) {
  return validatePackData(pack, schema, opts);
}

// True when a parsed value holds something a person answered. A note alone does not count.
function valueHasContent(value) {
  if (typeof value.text === 'string') return value.text.trim() !== '';
  if (Array.isArray(value.items)) return value.items.length > 0;
  if (Array.isArray(value.choice)) return value.choice.length > 0;
  return typeof value.date === 'string' && value.date.trim() !== '';
}

// A deferred question is an answer. A complete or partial one is only an answer when it has
// content: an empty marker is a missing answer, as the check reports it.
function entryIsAnswer(entry) {
  if (entry.status === 'tbd') return true;
  if (entry.status !== 'complete' && entry.status !== 'partial') return false;
  return entry.value ? valueHasContent(entry.value) : String(entry.body ?? '').trim() !== '';
}

// True when the pack holds any answer, at any level and any depth.
export function hasAnyAnswer(packData) {
  return Object.values(packData.files ?? {}).some(
    (file) => file.exists !== false && Object.values(file.answers ?? {}).some(entryIsAnswer),
  );
}

// The completeness block of the manifest (FORMAT.md section 6).
export function manifestCompleteness(report) {
  const { overall, counts, byFile, byModule } = report.completeness;
  return { overall, gate1Ready: report.gate1.ready, gate1Blocking: [...report.gate1.blocking], counts, byFile, byModule };
}

// ---------------------------------------------------------------------------------------------
// What to ask next

function openQuestions(report, schema, depth) {
  return questionsInOrder(schema).filter((question) => {
    const entry = report.questions[question.id];
    return entry && entry.status === 'missing' && inDepth(entry.level, depth, schema);
  });
}

// Missing questions in scope of the depth, counted by effective level.
export function remainingByLevel(report, schema, depth = report.depth) {
  const remaining = { gate1: 0, recommended: 0, optional: 0 };
  for (const question of openQuestions(report, schema, depth)) remaining[report.questions[question.id].level] += 1;
  return remaining;
}

function withReportFields(question, report) {
  const entry = report.questions[question.id];
  return { ...question, level: entry.level, status: entry.status };
}

// Questions to ask next. Only `missing` questions in scope of the depth are returned, in module
// order with gate1 questions first inside a module, and a round never crosses a module boundary:
// every question comes from the first module that has any left. A state.focus that holds ids that
// apply (known and not switched off) returns exactly those ids, whatever their status, in focus order;
// when none of its ids applies, the normal order is used.
// opts: { count, module, depth }.
export function nextQuestions(pack, schema, report, opts = {}) {
  const depth = opts.depth ?? report.depth;
  const focus = pack.state && Array.isArray(pack.state.focus) ? uniq(pack.state.focus) : [];
  // A focus question that is unknown or switched off does not apply; when none applies, the normal order is used.
  const applicable = focus.filter((id) => typeof id === 'string' && Object.hasOwn(report.questions, id) && report.questions[id].level !== 'skipped');
  let selected;
  if (applicable.length > 0) {
    selected = applicable.map((id) => findQuestion(schema, id));
  } else {
    const rank = (question) => schema.moduleOrder.indexOf(question.module) * 2 + (report.questions[question.id].level === 'gate1' ? 0 : 1);
    const ordered = openQuestions(report, schema, depth)
      .filter((question) => !opts.module || question.module === opts.module)
      .map((question, index) => ({ question, index }))
      .sort((first, second) => rank(first.question) - rank(second.question) || first.index - second.index)
      .map(({ question }) => question);
    selected = ordered.filter((question) => question.module === ordered[0]?.module);
  }
  const limited = opts.count ? selected.slice(0, opts.count) : selected;
  return limited.map((question) => withReportFields(question, report));
}
