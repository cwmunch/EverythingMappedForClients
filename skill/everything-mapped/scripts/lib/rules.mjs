// Schema rules and the one place that converts between structured input and markdown bodies
// (FORMAT.md sections 4.4 and 9). This file must stay pure: no node: imports, no process, no Buffer.

import { MAX_BODY_CHARS, MAX_FIELD_CHARS, MAX_LINE_CHARS, decodeMarkup, encodeMarkup, escapePipes, hasHiddenCharacters, isPlainObject, isValidDate, joinLines, normalizeText, protectSetextLines, restoreSetextLines, splitLines, splitPipes, toToken, uniq } from './util.mjs';

export const ANSWER_STATUSES = ['complete', 'partial', 'tbd', 'missing'];

const LIST_TYPES = ['list', 'urllist', 'files'];
const CHOICE_TYPES = ['choice', 'multichoice'];
const LEVEL_ORDER = ['gate1', 'recommended', 'optional'];
// A dot does not match every line break, so the rest of a line is matched with [\s\S]*.
const BULLET_LINE = /^\s*(?:[-*+]|\d+[.)])(?:\s+([\s\S]*))?$/;
const CHOICE_LINE = /^\s*Choice:[ \t]*([\s\S]*)$/i;
const DATE_LINE = /^\s*Date:[ \t]*([\s\S]*)$/i;
const NOTE_LINE = /^\s*Note:[ \t]*([\s\S]*)$/i;
const CONTENT_FIELDS = ['text', 'items', 'choice', 'date', 'note'];
const KNOWN_FIELDS = ['id', 'status', 'owner', 'due', ...CONTENT_FIELDS];
const FIELDS_BY_TYPE = {
  text: ['text'],
  longtext: ['text'],
  list: ['items', 'text'],
  urllist: ['items', 'text'],
  files: ['items', 'text'],
  choice: ['choice', 'note'],
  multichoice: ['choice', 'note'],
  date: ['date', 'note'],
};

export function isListType(type) {
  return LIST_TYPES.includes(type);
}

export function isChoiceType(type) {
  return CHOICE_TYPES.includes(type);
}

// ---------------------------------------------------------------------------------------------
// Questions, levels and depth

// Every question in interview order (schema.moduleOrder), with its module id and file id added.
export function questionsInOrder(schema) {
  const modulesById = new Map(schema.modules.map((entry) => [entry.id, entry]));
  const result = [];
  for (const moduleId of schema.moduleOrder) {
    const entry = modulesById.get(moduleId);
    if (!entry) continue;
    for (const question of entry.questions) result.push({ ...question, module: entry.id, file: entry.file });
  }
  return result;
}

export function findQuestion(schema, id) {
  for (const entry of schema.modules) {
    const question = entry.questions.find((candidate) => candidate.id === id);
    if (question) return { ...question, module: entry.id, file: entry.file };
  }
  return null;
}

export function inDepth(level, depth, schema) {
  return Object.hasOwn(schema.depths, depth) && schema.depths[depth].includes(level);
}

// The valid choice ids picked in an answer. Deferred and unanswered questions pick nothing.
export function selectedChoices(schema, answersById, id) {
  const question = findQuestion(schema, id);
  const entry = answersById[id];
  if (!question || !entry || entry.status === 'tbd' || entry.status === 'missing') return [];
  const value = entry.value ?? parseBody(question, entry.body);
  const allowed = question.choices ?? [];
  return (value.choice ?? []).filter((choice) => allowed.includes(choice));
}

function isQuestionShown(question, answersById, schema) {
  const condition = question.showIf;
  if (!condition) return true;
  const selected = selectedChoices(schema, answersById, condition.id);
  if (selected.length === 0) return true;
  return selected.some((choice) => condition.in.includes(choice));
}

function requirementHolds(rule, answersById, schema) {
  const selected = selectedChoices(schema, answersById, rule.id);
  if (Array.isArray(rule.in)) return selected.some((choice) => rule.in.includes(choice));
  if (Array.isArray(rule.notIn)) {
    return selected.length > 0 && selected.every((choice) => !rule.notIn.includes(choice));
  }
  if (typeof rule.minSelected === 'number') return selected.length >= rule.minSelected;
  return false;
}

function strongerLevel(first, second) {
  const firstRank = LEVEL_ORDER.indexOf(first);
  const secondRank = LEVEL_ORDER.indexOf(second);
  if (secondRank === -1) return first;
  if (firstRank === -1) return second;
  return secondRank < firstRank ? second : first;
}

// 'gate1' | 'recommended' | 'optional' | 'skipped'
export function effectiveLevel(question, answersById, schema) {
  if (!isQuestionShown(question, answersById, schema)) return 'skipped';
  const rule = question.requiredIf;
  if (rule && requirementHolds(rule, answersById, schema)) return strongerLevel(question.level, rule.level);
  return question.level;
}

// The questions that the answers in `after` switch off (showIf) although they were shown with
// `before` and hold an answer (also a deferred one): [{ id, controller, value }], where controller
// is the question whose answer switches it off and value is what it is set to. `ignore` is a Set
// of ids that are not reported, such as the questions that the same input clears.
export function switchedOffQuestions(schema, before, after, ignore = new Set()) {
  const found = [];
  for (const question of questionsInOrder(schema)) {
    if (!question.showIf || ignore.has(question.id)) continue;
    const entry = after[question.id];
    if (!entry || entry.status === 'missing') continue;
    if (effectiveLevel(question, before, schema) === 'skipped') continue;
    if (effectiveLevel(question, after, schema) !== 'skipped') continue;
    found.push({ id: question.id, controller: question.showIf.id, value: selectedChoices(schema, after, question.showIf.id).join(', ') });
  }
  return found;
}

// ---------------------------------------------------------------------------------------------
// Body text -> structured value

function parseListBody(text) {
  const raw = [];
  for (const line of splitLines(text)) {
    if (line.trim() === '') continue;
    const bullet = BULLET_LINE.exec(line);
    if (bullet) raw.push(bullet[1] ?? '');
    else if (/^\s/.test(line) && raw.length > 0) raw[raw.length - 1] += ` ${line.trim()}`;
    else raw.push(line.trim());
  }
  return raw.map(toListItem).filter((item) => item.text !== '');
}

// One line of text for an item or a note: line breaks become a space and white space of any kind at
// the ends is dropped, because the file cannot hold it (a bullet or a "Note:" ends in white space
// that is read as part of the marker). An item that is only white space is no item.
function itemText(value) {
  return joinLines(value).trim();
}

function toListItem(raw) {
  const [text, note = ''] = splitPipes(raw, 2).map(itemText);
  return { text, note };
}

// The first line matching tagPattern carries the tag; every other line is note text.
function parseTaggedBody(text, tagPattern) {
  let tagged = null;
  const noteLines = [];
  for (const line of splitLines(text)) {
    const tag = tagged === null ? tagPattern.exec(line) : null;
    if (tag) {
      tagged = tag[1].trim();
      continue;
    }
    const note = NOTE_LINE.exec(line);
    noteLines.push(note ? note[1] : line);
  }
  return { tagged, note: normalizeText(noteLines.join('\n')) };
}

function parseChoiceIds(tagged) {
  if (tagged === null) return [];
  return uniq(tagged.split(',').map((id) => id.trim().toLowerCase()).filter(Boolean));
}

// text/longtext -> { text }; list types -> { items: [{ text, note }] };
// choice types -> { choice: [ids], note }; date -> { date, note }
export function parseBody(question, body) {
  const text = decodeMarkup(normalizeText(body));
  if (LIST_TYPES.includes(question.type)) return { items: parseListBody(text) };
  if (CHOICE_TYPES.includes(question.type)) {
    const { tagged, note } = parseTaggedBody(text, CHOICE_LINE);
    return { choice: parseChoiceIds(tagged), note };
  }
  if (question.type === 'date') {
    const { tagged, note } = parseTaggedBody(text, DATE_LINE);
    return { date: tagged ?? '', note };
  }
  return { text: restoreSetextLines(text) };
}

export function emptyValue(question) {
  return parseBody(question, '');
}

// Characters in a text answer: trimmed, with bullet markers removed (used by rules.minChars).
export function textLength(text) {
  const stripped = splitLines(text)
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''))
    .join('\n')
    .trim();
  return Array.from(stripped).length;
}

// ---------------------------------------------------------------------------------------------
// Structured input -> body text

function toInputItem(raw) {
  if (isPlainObject(raw)) return { text: itemText(raw.text), note: itemText(raw.note) };
  return { text: itemText(raw), note: '' };
}

// Items come from `items`; a `text` with bullets is accepted when `items` is absent.
function inputItems(input) {
  if (Array.isArray(input.items)) return input.items.map(toInputItem).filter((item) => item.text !== '');
  if (typeof input.text === 'string') return parseListBody(normalizeText(input.text));
  return [];
}

function inputChoiceIds(input) {
  const raw = Array.isArray(input.choice) ? input.choice : [input.choice];
  return uniq(raw.filter((id) => id !== undefined && id !== null).map((id) => String(id).trim().toLowerCase()).filter(Boolean));
}

function noteLines(note) {
  const text = encodeMarkup(normalizeText(note));
  if (text === '') return [];
  // A note line starts after "Note:" and the white space behind it, so the indentation of a line is not kept.
  return text.split('\n').map((line) => `Note: ${line.trimStart()}`.trimEnd());
}

function itemLine(item) {
  const note = item.note ? ` | ${escapePipes(encodeMarkup(item.note))}` : '';
  return `- ${escapePipes(encodeMarkup(item.text))}${note}`;
}

// input: { text } | { items: [{ text, note }] } | { choice: [ids], note } | { date, note }
export function bodyFromInput(question, input) {
  if (LIST_TYPES.includes(question.type)) return inputItems(input).map(itemLine).join('\n');
  if (CHOICE_TYPES.includes(question.type)) {
    const ids = inputChoiceIds(input);
    const lines = ids.length > 0 ? [`Choice: ${ids.join(', ')}`] : [];
    return [...lines, ...noteLines(input.note)].join('\n');
  }
  if (question.type === 'date') {
    const date = String(input.date ?? '').trim();
    return [...(date ? [`Date: ${date}`] : []), ...noteLines(input.note)].join('\n');
  }
  return encodeMarkup(protectSetextLines(normalizeText(input.text)));
}

// The body as the renderer writes it: canonical bullets, Choice and Note lines.
// Deferred and missing answers keep their text, which is a free note.
export function canonicalBody(question, entry) {
  const body = normalizeText(entry.body);
  if (entry.status === 'complete' || entry.status === 'partial') {
    return bodyFromInput(question, parseBody(question, body));
  }
  return encodeMarkup(protectSetextLines(restoreSetextLines(decodeMarkup(body))));
}

// ---------------------------------------------------------------------------------------------
// Answer input for answer.mjs

function isAssetPath(text) {
  if (!text.startsWith('assets/') || text === 'assets/') return false;
  if (/[\\\0]/.test(text)) return false;
  return text.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function isRawItem(raw) {
  if (typeof raw === 'string') return true;
  if (!isPlainObject(raw) || typeof raw.text !== 'string') return false;
  if (raw.note !== undefined && typeof raw.note !== 'string') return false;
  return Object.keys(raw).every((key) => key === 'text' || key === 'note');
}

function listProblems(question, input, add) {
  const items = Array.isArray(input.items) ? input.items : null;
  if (input.items !== undefined && (!items || !items.every(isRawItem))) {
    add('ui.answer.err.badItems');
    return;
  }
  if (input.items === undefined && input.text !== undefined && typeof input.text !== 'string') {
    add('ui.answer.err.badText', { field: 'text' });
    return;
  }
  const parsed = inputItems(input);
  if (parsed.length === 0) add('ui.answer.err.noContent');
  if (question.type === 'files') {
    for (const item of parsed) if (!isAssetPath(item.text)) add('ui.answer.err.badFilePath', { path: item.text });
  }
}

function choiceProblems(question, input, add) {
  const raw = input.choice;
  if (raw !== undefined && typeof raw !== 'string' && !(Array.isArray(raw) && raw.every((id) => typeof id === 'string'))) {
    add('ui.answer.err.badChoiceField');
    return;
  }
  const ids = inputChoiceIds(input);
  if (ids.length === 0) add('ui.answer.err.noContent');
  for (const id of ids) {
    if (!(question.choices ?? []).includes(id)) add('ui.answer.err.badChoice', { choice: id });
  }
  if (question.type === 'choice' && ids.length > 1) add('ui.answer.err.singleChoiceOnly');
}

function dateProblems(input, add) {
  if (input.date === undefined) add('ui.answer.err.noContent');
  else if (typeof input.date !== 'string' || !isValidDate(input.date.trim())) {
    add('ui.answer.err.badDate', { value: String(input.date) });
  }
}

function textProblems(input, add) {
  if (input.text !== undefined && typeof input.text !== 'string') add('ui.answer.err.badText', { field: 'text' });
  else if (normalizeText(input.text) === '') add('ui.answer.err.noContent');
}

function contentProblems(question, input, add) {
  if (LIST_TYPES.includes(question.type)) listProblems(question, input, add);
  else if (CHOICE_TYPES.includes(question.type)) choiceProblems(question, input, add);
  else if (question.type === 'date') dateProblems(input, add);
  else textProblems(input, add);
  if (input.note !== undefined && typeof input.note !== 'string') add('ui.answer.err.badText', { field: 'note' });
}

// Every text the input carries, for the control character check.
function inputStrings(input) {
  const strings = [];
  const add = (value) => {
    if (typeof value === 'string') strings.push(value);
  };
  for (const key of ['id', 'owner', 'due', 'text', 'note', 'date']) add(input[key]);
  (Array.isArray(input.choice) ? input.choice : [input.choice]).forEach(add);
  for (const item of Array.isArray(input.items) ? input.items : []) {
    if (isPlainObject(item)) {
      add(item.text);
      add(item.note);
    } else {
      add(item);
    }
  }
  return strings;
}

function exceedsTextLimits(body) {
  return body.length > MAX_BODY_CHARS || splitLines(body).some((line) => line.length > MAX_LINE_CHARS);
}

// Returns a list of { key, params } problems (empty when the input is fine). The caller has
// already checked that the id exists.
export function checkAnswerInput(question, input) {
  const problems = [];
  const add = (key, params = {}) => problems.push({ key, params: { id: question.id, ...params } });
  for (const field of Object.keys(input)) {
    if (!KNOWN_FIELDS.includes(field)) add('ui.answer.err.unknownField', { field });
  }
  if (!ANSWER_STATUSES.includes(input.status)) {
    add('ui.answer.err.badStatus', { status: String(input.status) });
    return problems;
  }
  if (input.owner !== undefined && typeof input.owner !== 'string') add('ui.answer.err.badOwner');
  else if (typeof input.owner === 'string' && input.owner.length > MAX_FIELD_CHARS) {
    add('ui.answer.err.fieldTooLong', { field: `owner (${question.id})`, limit: MAX_FIELD_CHARS });
  }
  if (input.due !== undefined && input.due !== '' && !isValidDate(input.due)) {
    add('ui.answer.err.badDue', { value: String(input.due) });
  }
  const given = CONTENT_FIELDS.filter((field) => input[field] !== undefined);
  if (input.status === 'missing') {
    if (given.length > 0) add('ui.answer.err.missingHasContent');
  } else if (input.status === 'tbd') {
    for (const field of given) {
      if (field !== 'note' && field !== 'text') add('ui.answer.err.tbdContent', { field });
      else if (typeof input[field] !== 'string') add('ui.answer.err.badText', { field });
    }
  } else {
    const allowed = FIELDS_BY_TYPE[question.type] ?? ['text'];
    for (const field of given) {
      if (!allowed.includes(field)) add('ui.answer.err.wrongField', { field, type: question.type });
    }
    contentProblems(question, input, add);
  }
  if (inputStrings(input).some(hasHiddenCharacters)) add('ui.answer.err.controlChars', { where: question.id });
  if (problems.length === 0 && exceedsTextLimits(entryFromInput(question, input).body)) {
    add('ui.answer.err.tooLong', { lineLimit: MAX_LINE_CHARS, bodyLimit: '200 KB' });
  }
  return problems;
}

// Turns checked input into the shape parseFile gives for an answer: { status, owner, due, body, value }.
export function entryFromInput(question, input) {
  const owner = toToken(input.owner ?? '');
  const due = input.due ?? '';
  if (input.status === 'complete' || input.status === 'partial') {
    const body = bodyFromInput(question, input);
    return { status: input.status, owner, due, body, value: parseBody(question, body) };
  }
  if (input.status === 'tbd') {
    const parts = [input.note, input.text].filter((part) => typeof part === 'string' && part.trim() !== '');
    return { status: 'tbd', owner, due, body: encodeMarkup(protectSetextLines(normalizeText(parts.join('\n')))), value: emptyValue(question) };
  }
  return { status: 'missing', owner, due, body: '', value: emptyValue(question) };
}
