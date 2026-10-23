// Parsing answer files and the assets table (FORMAT.md sections 4 and 5).
// Tolerant on input (CRLF, any bullet style, trailing spaces). This file must stay pure.

import { ANSWER_STATUSES, emptyValue, findQuestion, parseBody } from './rules.mjs';
import { MAX_ASSET_ROWS, MAX_BODY_CHARS, MAX_LINE_CHARS, PackError, decodeMarkup, hasHiddenCharacters, joinLines, normalizeNewlines, normalizeText, oneLine, splitLines, splitPipes, trimSpaces } from './util.mjs';

const REQUIRED_FRONT_MATTER = ['schema', 'file', 'language'];
const HEADING_LINE = /^ {0,3}#{1,3}(?:\s|$)/;
const QUESTION_HEADING_LINE = /^ {0,3}###(?:\s|$)/;
const FRONT_MATTER_LINE = /^([A-Za-z][\w-]*):\s*([\s\S]*)$/;
const MAX_PARSE_FLAGS = 100;
const EXCERPT_CHARS = 60;

// A line this long is not text a person wrote; reading it could take unbounded time.
function checkLineLengths(lines) {
  const index = lines.findIndex((line) => line.length > MAX_LINE_CHARS);
  if (index !== -1) throw new PackError('ui.check.err.lineTooLong', { line: index + 1, limit: MAX_LINE_CHARS });
}

// A damaged file can hold thousands of problems; the first ones are enough to show.
function pushFlag(flags, flag) {
  if (flags.length < MAX_PARSE_FLAGS) flags.push(flag);
}

function unquoteFrontMatter(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  return value;
}

// Returns { frontMatter, start }: frontMatter is null when there is no closed block at the top.
function readFrontMatter(lines) {
  const first = lines.findIndex((line) => line.trim() !== '');
  if (first === -1 || lines[first].trim() !== '---') return { frontMatter: null, start: 0 };
  const end = lines.findIndex((line, index) => index > first && line.trim() === '---');
  if (end === -1) return { frontMatter: null, start: 0 };
  const frontMatter = {};
  for (const line of lines.slice(first + 1, end)) {
    const match = FRONT_MATTER_LINE.exec(line);
    if (match) frontMatter[match[1]] = unquoteFrontMatter(match[2].trim());
  }
  return { frontMatter, start: end + 1 };
}

// The required front matter keys that are missing or have an unusable value.
function badFrontMatterKeys(frontMatter, schema) {
  if (!frontMatter) return [...REQUIRED_FRONT_MATTER];
  return REQUIRED_FRONT_MATTER.filter((key) => {
    const value = frontMatter[key];
    if (!value) return true;
    if (key === 'file') return !schema.files.some((file) => file.id === value);
    if (key === 'language') return !schema.languages.includes(value);
    return false;
  });
}

// <!-- q:<id> status:<status> [owner:<owner>] [due:<date>] -->, or null for any other line.
function parseMarker(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('<!--') || !trimmed.endsWith('-->')) return null;
  const inner = trimmed.slice(4, -3).trim();
  if (!inner.startsWith('q:') || inner.includes('>')) return null;
  const [id, ...words] = inner.slice(2).split(/\s+/);
  if (id === '') return null;
  const tokens = {};
  for (const word of words) {
    const colon = word.indexOf(':');
    if (colon > 0) tokens[word.slice(0, colon)] = word.slice(colon + 1);
  }
  return { id, status: tokens.status ?? '', owner: tokens.owner ?? '', due: tokens.due ?? '' };
}

// Opens an answer for a marker, or reports why it is ignored. Returns the open answer or null.
function openAnswer(marker, state) {
  const question = findQuestion(state.schema, marker.id);
  if (!question) {
    pushFlag(state.flags, { id: 'marker.unknownQuestion', severity: 'warn', params: { id: marker.id } });
    return null;
  }
  if (Object.hasOwn(state.answers, marker.id)) {
    if (!state.duplicated.has(marker.id)) {
      state.duplicated.add(marker.id);
      pushFlag(state.flags, { id: 'marker.duplicate', severity: 'warn', qid: marker.id, params: { qid: marker.id } });
    }
    return null;
  }
  const entry = { status: marker.status, owner: marker.owner, due: marker.due, body: '', value: null };
  state.answers[marker.id] = entry;
  return { entry, question, lines: [] };
}

// Fills body and value once all lines are known. An unreadable status is reported and replaced
// by partial (there is text) or missing (there is none).
function closeAnswer(open, flags) {
  const { entry, question } = open;
  entry.body = normalizeText(open.lines.join('\n'));
  if (entry.body.length > MAX_BODY_CHARS) {
    throw new PackError('ui.check.err.bodyTooLarge', { id: question.id, limit: '200 KB' });
  }
  if (hasHiddenCharacters(entry.body)) {
    pushFlag(flags, { id: 'text.hiddenCharacters', severity: 'warn', qid: question.id, params: { qid: question.id } });
  }
  if (!ANSWER_STATUSES.includes(entry.status)) {
    pushFlag(flags, { id: 'marker.badStatus', severity: 'warn', qid: question.id, params: { qid: question.id, status: entry.status } });
    entry.status = entry.body === '' ? 'missing' : 'partial';
  }
  entry.value = entry.status === 'tbd' || entry.status === 'missing' ? emptyValue(question) : parseBody(question, entry.body);
}

// True for a "###" heading that no marker follows: the renderer never writes one, so a person did.
function isStrayQuestionHeading(lines, index) {
  if (!QUESTION_HEADING_LINE.test(lines[index])) return false;
  let next = index + 1;
  while (next < lines.length && lines[next].trim() === '') next += 1;
  return next >= lines.length || parseMarker(lines[next]) === null;
}

function excerptOf(line) {
  const text = oneLine(line);
  const chars = Array.from(text);
  return chars.length > EXCERPT_CHARS ? `${chars.slice(0, EXCERPT_CHARS).join('')}...` : text;
}

// -> { frontMatter, answers: { [id]: { status, owner, due, body, value } }, flags }
// Flags are { id, severity, qid?, params }. The caller adds the file. Throws PackError for a
// line or an answer that is too long to read.
export function parseFile(text, schema) {
  const lines = splitLines(text);
  checkLineLengths(lines);
  const { frontMatter, start } = readFrontMatter(lines);
  const flags = [];
  const badKeys = badFrontMatterKeys(frontMatter, schema);
  if (badKeys.length > 0) pushFlag(flags, { id: 'file.badFrontMatter', severity: 'warn', params: { keys: badKeys.join(', ') } });

  const state = { schema, answers: {}, flags, duplicated: new Set() };
  const opened = [];
  const stray = { count: 0, line: 0, excerpt: '' };
  const noteStray = (index) => {
    stray.count += 1;
    if (stray.count === 1) Object.assign(stray, { line: index + 1, excerpt: excerptOf(lines[index]) });
  };
  let current = null;
  let ignoring = false;
  let hiddenOutsideAnswers = lines.slice(0, start).some(hasHiddenCharacters);
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    const isHeading = HEADING_LINE.test(line);
    const marker = isHeading ? null : parseMarker(line);
    if (isHeading) {
      if (isStrayQuestionHeading(lines, index)) noteStray(index);
      current = null;
      ignoring = false;
    } else if (marker) {
      current = openAnswer(marker, state);
      ignoring = current === null;
      if (current) opened.push(current);
    } else if (current) {
      current.lines.push(line);
    } else if (!ignoring && line.trim() !== '') {
      noteStray(index);
    }
    if (!current || isHeading || marker) hiddenOutsideAnswers = hiddenOutsideAnswers || hasHiddenCharacters(line);
  }
  for (const open of opened) closeAnswer(open, flags);
  if (hiddenOutsideAnswers) pushFlag(flags, { id: 'text.hiddenCharacters', severity: 'warn', params: {} });
  if (stray.count > 0) {
    pushFlag(flags, { id: 'file.strayText', severity: 'warn', params: { line: stray.line, excerpt: stray.excerpt, count: stray.count } });
  }
  return { frontMatter, answers: state.answers, flags };
}

// Rows of the assets table: [{ file, what, owner, rights, restrictions }].
// The first table row is the header and the second the separator; their text is ignored.
// A table with more than MAX_ASSET_ROWS rows is refused with a PackError.
export function parseAssets(text) {
  const lines = normalizeNewlines(text).split('\n');
  checkLineLengths(lines);
  const tableLines = lines.map((line) => line.trim()).filter((line) => line.startsWith('|'));
  if (tableLines.length - 2 > MAX_ASSET_ROWS) throw new PackError('ui.check.err.tooManyRows', { limit: MAX_ASSET_ROWS });
  const rows = [];
  for (const line of tableLines.slice(2)) {
    const inner = line.replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
    const [fileCell = '', ...cells] = splitPipes(inner);
    const [what = '', owner = '', rights = '', restrictions = ''] = cells.map((cell) => decodeMarkup(joinLines(cell)));
    // The file column is read exactly: only the padding around the cell is removed.
    const file = decodeMarkup(trimSpaces(fileCell));
    if (file !== '') rows.push({ file, what, owner, rights, restrictions });
  }
  return rows;
}
