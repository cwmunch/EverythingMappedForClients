// Rendering answer files, the assets table and the open-questions file (FORMAT.md sections 4, 5, 8).
// Output is canonical: LF line endings, one blank line between blocks. This file must stay pure.

import { ANSWER_STATUSES, canonicalBody, effectiveLevel } from './rules.mjs';
import { MAX_CELL_CHARS, MAX_LISTED_ITEMS, decodeMarkup, defuseMarkup, describeAssetName, encodeMarkup, escapePipes, joinLines, normalizeNewlines, oneLine, showHiddenCharacters, toToken, truncateText } from './util.mjs';

const GENERATED_START = '<!-- generated:start -->';
const GENERATED_END = '<!-- generated:end -->';

// The text for a key, or the fallback while the text files do not define it.
export function textOr(i18n, key, fallback = '') {
  return i18n.has(key) ? i18n.t(key) : fallback;
}

export function questionLabel(i18n, questionId) {
  return oneLine(textOr(i18n, `q.${questionId}.label`, questionId));
}

// Headings of level 1 to 3 inside user text would end the answer, so they become level 4. A line
// that looks like a marker comment is defused.
export function protectBody(text) {
  return normalizeNewlines(text)
    .split('\n')
    .map((line) => {
      const heading = /^( {0,3})#{1,3}(?=\s|$)/.exec(line);
      if (heading) return `${heading[1]}####${line.slice(heading[0].length)}`;
      if (/^\s*<!--/.test(line)) return line.replace('<!--', '&lt;!--');
      return line;
    })
    .join('\n');
}

function quoteFrontMatter(value) {
  const text = defuseMarkup(joinLines(value));
  return `"${text.replace(/[\\"]/g, (char) => `\\${char}`)}"`;
}

function frontMatterBlock(schema, fileId, meta) {
  const lines = ['---', `schema: ${schema.schema}`, `file: ${fileId}`, `language: ${meta.language}`];
  if (meta.respondent) lines.push(`respondent: ${quoteFrontMatter(meta.respondent)}`);
  lines.push(`updated: ${meta.updated}`, '---');
  return lines.join('\n');
}

function questionBlock(question, i18n, entry) {
  const status = entry && ANSWER_STATUSES.includes(entry.status) ? entry.status : 'missing';
  const tokens = [`q:${question.id}`, `status:${status}`];
  if (entry && entry.owner) tokens.push(`owner:${toToken(entry.owner)}`);
  if (entry && entry.due) tokens.push(`due:${entry.due}`);
  const lines = [`### ${questionLabel(i18n, question.id)}`, `<!-- ${tokens.join(' ')} -->`];
  const body = entry ? protectBody(canonicalBody(question, entry)) : '';
  if (body !== '') lines.push(body);
  return lines.join('\n');
}

// One answer file. answersById holds every answer of the pack (parseFile shape), because showIf
// can refer to a question in another file. meta: { language, respondent?, updated }.
export function renderFile(schema, i18n, fileId, answersById, meta) {
  const file = schema.files.find((entry) => entry.id === fileId);
  if (!file) throw new Error(`Unknown file id: ${fileId}`);
  const blocks = [frontMatterBlock(schema, fileId, meta)];
  blocks.push(`# ${oneLine(textOr(i18n, `file.${fileId}.title`, fileId))}`);
  for (const moduleId of file.modules) {
    const moduleEntry = schema.modules.find((entry) => entry.id === moduleId);
    if (!moduleEntry) continue;
    blocks.push(`## ${oneLine(textOr(i18n, `module.${moduleId}.title`, moduleId))}`);
    for (const item of moduleEntry.questions) {
      const question = { ...item, module: moduleEntry.id, file: moduleEntry.file };
      if (effectiveLevel(question, answersById, schema) === 'skipped') continue;
      blocks.push(questionBlock(question, i18n, answersById[question.id]));
    }
  }
  return `${blocks.join('\n\n')}\n`;
}

// A cell in a markdown table: one line, no markup, pipes escaped, and cut at `limit` characters.
// Stored text is kept as it is, with its invisible joiners and special spaces. Only control
// characters and the hidden characters of util.mjs are written as <U+XXXX>, which no answer
// can contain, so that a damaged pack cannot put them into a generated file.
function tableCell(value, limit = Infinity) {
  return escapePipes(encodeMarkup(showHiddenCharacters(truncateText(joinLines(value), limit))));
}

function tableLine(cells, limit) {
  return `| ${cells.map((cell) => tableCell(cell, limit)).join(' | ')} |`;
}

// The file column of the assets table holds the name exactly: only a pipe and markup are escaped.
function fileCell(value) {
  return escapePipes(encodeMarkup(showHiddenCharacters(String(value ?? ''))));
}

// rows: [{ file, what, owner, rights, restrictions }]
export function renderAssets(rows, i18n) {
  const header = [
    i18n.t('ui.assets.col.file'),
    i18n.t('ui.assets.col.what'),
    i18n.t('ui.assets.col.owner'),
    i18n.t('ui.assets.col.rights'),
    i18n.t('ui.assets.col.restrictions'),
  ];
  const lines = [
    `# ${i18n.t('ui.assets.title')}`,
    '',
    i18n.t('ui.assets.intro'),
    '',
    tableLine(header),
    '|---|---|---|---|---|',
    ...rows.map((row) => `| ${fileCell(row.file)} | ${[row.what, row.owner, row.rights, row.restrictions].map((cell) => tableCell(cell)).join(' | ')} |`),
  ];
  return `${lines.join('\n')}\n`;
}

// Why a name is refused by the zip, by the code of nameProblems or entryNameProblems. The keys are
// written out so that the texts of every reason can be found and checked.
const NAME_REASON_KEYS = {
  empty: 'ui.nameReason.empty',
  notText: 'ui.nameReason.notText',
  backslash: 'ui.nameReason.backslash',
  notRelative: 'ui.nameReason.notRelative',
  forbiddenCharacter: 'ui.nameReason.forbiddenCharacter',
  emptyPart: 'ui.nameReason.emptyPart',
  dotPart: 'ui.nameReason.dotPart',
  endsWithDotOrSpace: 'ui.nameReason.endsWithDotOrSpace',
  deviceName: 'ui.nameReason.deviceName',
  partTooLong: 'ui.nameReason.partTooLong',
  pathTooLong: 'ui.nameReason.pathTooLong',
  duplicate: 'ui.nameReason.duplicate',
  fileAndFolder: 'ui.nameReason.fileAndFolder',
};

// The reason for a refused name as a clause ("the name is reserved on Windows"). `other` is the
// name that it clashes with, for the reasons duplicate and fileAndFolder.
export function nameReasonText(i18n, code, other = '') {
  return Object.hasOwn(NAME_REASON_KEYS, code) ? i18n.t(NAME_REASON_KEYS[code], { other }) : String(code);
}

// The message for a flag, in the language of the dictionary. Question flags get {label}; a file
// flag gets its path as {label}. The text is not made safe for printing: print it through
// sanitizeForTerminal.
export function describeFlag(flag, i18n) {
  const params = { ...flag.params };
  const questionId = flag.qid ?? params.qid;
  if (questionId) {
    params.qid = questionId;
    params.label = questionLabel(i18n, questionId);
  } else if (params.label === undefined && params.path !== undefined) {
    params.label = params.path;
  }
  // A file name is shown the same way everywhere: what cannot be seen is written as <U+XXXX>.
  if (flag.id.startsWith('assets.') && typeof params.file === 'string') params.file = describeAssetName(params.file);
  if (typeof params.other === 'string') params.other = describeAssetName(params.other);
  if (flag.id === 'assets.notPackable') params.reason = nameReasonText(i18n, params.reasonCode, params.other ?? '');
  return i18n.t(`flag.${flag.id}`, params);
}

// The rows of one level: deferred questions in scope of the depth, and, for the levels that are
// always asked, missing questions too.
function openRows(report, level, includeMissing) {
  return Object.entries(report.questions).filter(([, entry]) => {
    if (entry.level !== level) return false;
    if (entry.status === 'tbd') return entry.inScope !== false;
    return includeMissing && entry.status === 'missing';
  });
}

function openTable(rows, i18n) {
  const header = [
    i18n.t('ui.openq.col.question'),
    i18n.t('ui.openq.col.status'),
    i18n.t('ui.openq.col.owner'),
    i18n.t('ui.openq.col.due'),
    i18n.t('ui.openq.col.note'),
  ];
  const body = rows.map(([id, entry]) =>
    tableLine([questionLabel(i18n, id), textOr(i18n, `status.${entry.status}`, entry.status), entry.owner, entry.due, decodeMarkup(entry.note)], MAX_CELL_CHARS),
  );
  return [tableLine(header), '|---|---|---|---|---|', ...body];
}

// The findings as bullets: at most MAX_LISTED_ITEMS, each cut short, then a line with the rest.
function flagBullets(report, i18n) {
  const shown = report.flags.filter((flag) => flag.severity === 'block' || flag.severity === 'warn');
  const ordered = [...shown.filter((flag) => flag.severity === 'block'), ...shown.filter((flag) => flag.severity === 'warn')];
  const bullets = ordered.slice(0, MAX_LISTED_ITEMS).map((flag) => {
    const severity = flag.severity === 'block' ? i18n.t('ui.openq.sev.block') : i18n.t('ui.openq.sev.warn');
    return `- ${severity}: ${encodeMarkup(showHiddenCharacters(truncateText(joinLines(describeFlag(flag, i18n)), MAX_CELL_CHARS)))}`;
  });
  if (ordered.length > MAX_LISTED_ITEMS) bullets.push(`- ${i18n.t('ui.openq.more', { count: ordered.length - MAX_LISTED_ITEMS })}`);
  return bullets;
}

function generatedBlock(report, i18n) {
  const lines = [GENERATED_START, `## ${i18n.t('ui.openq.heading')}`, '', i18n.t('ui.openq.intro')];
  // The group names are the level names from the text files when they exist.
  const groups = [
    { level: 'gate1', includeMissing: true, heading: textOr(i18n, 'level.gate1.short', textOr(i18n, 'level.gate1', i18n.t('ui.openq.group.gate1'))) },
    { level: 'recommended', includeMissing: true, heading: textOr(i18n, 'level.recommended', i18n.t('ui.openq.group.recommended')) },
    { level: 'optional', includeMissing: false, heading: textOr(i18n, 'level.optional', i18n.t('ui.openq.group.optional')) },
  ];
  for (const { level, includeMissing, heading } of groups) {
    const rows = openRows(report, level, includeMissing);
    if (rows.length === 0 && level === 'optional') continue;
    lines.push('', `### ${heading}`, '');
    lines.push(...(rows.length === 0 ? [i18n.t('ui.openq.none')] : openTable(rows, i18n)));
  }
  const bullets = flagBullets(report, i18n);
  lines.push('', `### ${i18n.t('ui.openq.flagsHeading')}`, '');
  lines.push(...(bullets.length === 0 ? [i18n.t('ui.openq.noFlags')] : bullets));
  lines.push(GENERATED_END);
  return lines.join('\n');
}

// The open-questions file. Everything between the generated markers is replaced; text outside
// them is kept. Without a pair of markers the block is added at the end (or the file is created).
export function renderOpenQuestions(report, i18n, existingText) {
  const block = generatedBlock(report, i18n);
  const existing = existingText === undefined || existingText === null ? '' : normalizeNewlines(existingText);
  const start = existing.indexOf(GENERATED_START);
  const end = start === -1 ? -1 : existing.indexOf(GENERATED_END, start + GENERATED_START.length);
  if (start !== -1 && end !== -1) {
    const merged = existing.slice(0, start) + block + existing.slice(end + GENERATED_END.length);
    return merged.endsWith('\n') ? merged : `${merged}\n`;
  }
  if (existing.trim() === '') return `# ${i18n.t('ui.openq.title')}\n\n${block}\n`;
  return `${existing.trimEnd()}\n\n${block}\n`;
}
