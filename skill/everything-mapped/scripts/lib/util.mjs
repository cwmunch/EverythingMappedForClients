// Small helpers shared by the pure modules (util, i18n-core, rules, parse, render, validate).
// This file must stay pure: no node: imports, no process, no Buffer. The static form inlines it.

// A pack that cannot be read: the key is an i18n key and the params fill its placeholders.
export class PackError extends Error {
  constructor(key, params = {}) {
    super(key);
    this.name = 'PackError';
    this.key = key;
    this.params = params;
  }
}

// Bad input for answer.mjs. `problems` is a list of { key, params } with i18n keys.
export class InputError extends Error {
  constructor(problems) {
    super(problems.map((problem) => problem.key).join(', '));
    this.name = 'InputError';
    this.problems = problems;
  }
}

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function uniq(list) {
  return [...new Set(list)];
}

// U+2028 and U+2029 end a line in JavaScript patterns (a dot does not match them), so they are
// line breaks here too.
const LINE_SEPARATORS = [String.fromCharCode(0x2028), String.fromCharCode(0x2029)];

// Removes a byte order mark and turns CRLF, CR, U+2028 and U+2029 into LF.
export function normalizeNewlines(text) {
  let result = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  for (const separator of LINE_SEPARATORS) result = result.split(separator).join('\n');
  return result;
}

export function splitLines(text) {
  return normalizeNewlines(text).split('\n');
}

// Canonical free text: LF only, no trailing spaces on any line, no blank lines at the ends.
export function normalizeText(text) {
  return splitLines(text)
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

// Collapses every run of white space (including line breaks) into one space.
export function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

const LINE_BREAK_RUN = new RegExp(`[\\r\\n${String.fromCharCode(0x2028, 0x2029)}]+`, 'g');

// Removes spaces and tabs at both ends (and nothing else: other white space is text).
export function trimSpaces(text) {
  const value = String(text ?? '');
  let start = 0;
  let end = value.length;
  while (start < end && (value[start] === ' ' || value[start] === '\t')) start += 1;
  while (end > start && (value[end - 1] === ' ' || value[end - 1] === '\t')) end -= 1;
  return value.slice(start, end);
}

// Stored text on one line: line breaks become one space; every other character, including
// other kinds of white space, stays as it is.
export function joinLines(text) {
  return trimSpaces(String(text ?? '').replace(LINE_BREAK_RUN, ' '));
}

// A marker token has no spaces and cannot close the marker comment. Applying it twice gives the
// same token as applying it once.
export function toToken(text) {
  return oneLine(text).replace(/[<>"]/g, '').replace(/ /g, '-').replace(/-{2,}/g, '-');
}

export function slugify(text) {
  const slug = oneLine(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-');
  let start = 0;
  let end = slug.length;
  while (start < end && slug[start] === '-') start += 1;
  while (end > start && slug[end - 1] === '-') end -= 1;
  return slug.slice(start, end);
}

// Backslash-pipe is a literal pipe in table cells and in "text | note" list items.
export function escapePipes(text) {
  return String(text ?? '').replace(/\|/g, '\\|');
}

// Splits at unescaped pipes and unescapes the parts. With maxParts, later pipes stay literal.
export function splitPipes(text, maxParts = Infinity) {
  const parts = [];
  let current = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\\' && text[index + 1] === '|') {
      current += '|';
      index += 1;
    } else if (char === '|' && parts.length < maxParts - 1) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

// True for a real calendar date written as YYYY-MM-DD.
export function isValidDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1000) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function localDate(date = new Date()) {
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function isoDateTime(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---------------------------------------------------------------------------------------------
// Limits that keep a hostile pack from using unbounded time or memory

export const MAX_LINE_CHARS = 20000;
export const MAX_BODY_CHARS = 200 * 1024;
export const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_JSON_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_ASSET_BYTES = 500 * 1024 * 1024;
export const MAX_ASSET_ROWS = 5000;
export const MAX_ASSET_FILES = 50000;
export const MAX_FLAGS_PER_KIND = 100;
export const MAX_LISTED_ITEMS = 200;
export const MAX_CELL_CHARS = 300;

// Cuts text at max characters and adds "...". A surrogate pair is never cut in two.
export function truncateText(text, max) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  let end = max;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${value.slice(0, end)}...`;
}

// The files that belong to a pack, by their path from the pack root (forward slashes): anything
// with a hidden name (a dot first) or a temporary one (.tmp last) in its path does not.
// The manifest and the zip use this one rule.
export function isPackFile(relativePath) {
  const segments = String(relativePath).replace(/\\/g, '/').split('/').filter((segment) => segment !== '');
  if (segments.length === 0) return false;
  return !segments.some((segment) => segment.startsWith('.') || segment.toLowerCase().endsWith('.tmp'));
}

// ---------------------------------------------------------------------------------------------
// Control and hidden characters

// Control codes that answer input refuses: C0 except tab, line feed and carriage return, DEL
// and C1. These are [from, to] ranges of code points.
export const CONTROL_CHARACTER_RANGES = [[0, 8], [11, 12], [14, 31], [127, 159]];

// Characters that are refused in answer input, in respondent, recipient, notes, asset
// descriptions and asset file names, and flagged in an existing pack, because they hide text or
// change the reading direction: U+061C, U+180E, zero-width space U+200B, the bidirectional
// embeddings, overrides and isolates (U+202A-202E, U+2066-2069), word joiner and invisible
// operators (U+2060-2064), the byte order mark U+FEFF anywhere, interlinear annotation marks
// (U+FFF9-FFFB) and the tag characters (U+E0000-E007F). [from, to] ranges of code points.
// Legitimate invisible characters (U+200C, U+200D, U+200E, U+200F, U+00AD, variation selectors,
// U+202F and other white space) are not in this list; stored text keeps them.
export const HIDDEN_CHARACTER_RANGES = [
  [0x061c, 0x061c],
  [0x180e, 0x180e],
  [0x200b, 0x200b],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
  [0xfff9, 0xfffb],
  [0xe0000, 0xe007f],
];

// Characters that are fine in stored text but are shown as <U+XXXX> when printed, because they
// are easy to confuse with nothing: the soft hyphen, ZWNJ, ZWJ, LRM, RLM, line and paragraph separators.
const PRINT_ONLY_RANGES = [[0xad, 0xad], [0x200c, 0x200f], [0x2028, 0x2029]];

function inRanges(code, ranges) {
  for (const [from, to] of ranges) {
    if (code >= from && code <= to) return true;
  }
  return false;
}

export function isControlCode(code) {
  return inRanges(code, CONTROL_CHARACTER_RANGES);
}

export function isHiddenCode(code) {
  return inRanges(code, HIDDEN_CHARACTER_RANGES);
}

// True when the text holds a control character that no answer should contain. Tab, line feed
// and carriage return are fine.
export function hasControlCharacters(text) {
  for (const char of String(text ?? '')) {
    if (isControlCode(char.codePointAt(0))) return true;
  }
  return false;
}

// The one rule for text that people hand in: true when the text holds a control character (see
// CONTROL_CHARACTER_RANGES) or a hidden character (see HIDDEN_CHARACTER_RANGES). Tab, line feed
// and carriage return are allowed; a carriage return becomes a line break.
export function hasHiddenCharacters(text) {
  for (const char of String(text ?? '')) {
    const code = char.codePointAt(0);
    if (isControlCode(code) || isHiddenCode(code)) return true;
  }
  return false;
}

function codeMarker(code) {
  return `<U+${code.toString(16).toUpperCase().padStart(4, '0')}>`;
}

// Text with every control character (also tab and line breaks) and every hidden character written
// as <U+XXXX>, so that it can be read and cannot do anything.
export function showHiddenCharacters(text) {
  const parts = [];
  for (const char of String(text ?? '')) {
    const code = char.codePointAt(0);
    parts.push(code < 32 || isControlCode(code) || isHiddenCode(code) ? codeMarker(code) : char);
  }
  return parts.join('');
}

// True for a file name that the assets table can hold exactly: no control or hidden character,
// no backslash, and no space at either end. Other names, with any kind of white space or
// invisible joiner, are stored as they are.
export function isStorableAssetName(name) {
  const value = String(name ?? '');
  if (value === '' || value.startsWith(' ') || value.endsWith(' ') || value.includes(String.fromCharCode(92))) return false;
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code < 32 || isControlCode(code) || isHiddenCode(code)) return false;
  }
  return true;
}

// A file name for a message, with the characters that cannot be seen written as <U+XXXX>.
export function describeAssetName(name) {
  let shown = showHiddenCharacters(name);
  if (shown.startsWith(' ')) shown = `${codeMarker(32)}${shown.slice(1)}`;
  if (shown.endsWith(' ')) shown = `${shown.slice(0, -1)}${codeMarker(32)}`;
  return shown;
}

// Characters that are shown as a marker when printed: the hidden ones and the confusable ones.
export function isDisplaySpoofing(code) {
  return isHiddenCode(code) || inRanges(code, PRINT_ONLY_RANGES);
}

// Characters that can change what a terminal shows: all C0 except tab, DEL, C1, carriage return
// and the display spoofing characters above.
function isTerminalUnsafe(code, keepLineBreaks) {
  if (code === 10) return !keepLineBreaks;
  if (code < 32) return code !== 9;
  if (code >= 127 && code <= 159) return true;
  return isDisplaySpoofing(code);
}

// Safe to print: every unsafe character is replaced by a visible stand-in (a control picture for
// C0 and DEL, the replacement character for the rest). With keepLineBreaks, line feeds stay.
// This is for printing only; stored text is never changed with it.
export function sanitizeForTerminal(text, options = {}) {
  const keepLineBreaks = options.keepLineBreaks === true;
  const parts = [];
  for (const char of String(text ?? '')) {
    const code = char.codePointAt(0);
    if (!isTerminalUnsafe(code, keepLineBreaks)) parts.push(char);
    else if (code < 32) parts.push(String.fromCodePoint(0x2400 + code));
    else if (code === 127) parts.push(String.fromCodePoint(0x2421));
    else parts.push(String.fromCodePoint(0xfffd));
  }
  return parts.join('');
}

function unicodeEscape(code) {
  if (code <= 0xffff) return `${String.fromCharCode(92)}u${code.toString(16).padStart(4, '0')}`;
  const offset = code - 0x10000;
  return unicodeEscape(0xd800 + (offset >> 10)) + unicodeEscape(0xdc00 + (offset & 0x3ff));
}

// JSON text for printing: indented, with DEL, C1 and the display spoofing characters written as
// \\uXXXX escapes, so the output is safe to show and parses to the same value.
export function stringifyJson(value) {
  const parts = [];
  for (const char of JSON.stringify(value, null, 2)) {
    const code = char.codePointAt(0);
    parts.push(code >= 127 && (code <= 159 || isDisplaySpoofing(code)) ? unicodeEscape(code) : char);
  }
  return parts.join('');
}

// ---------------------------------------------------------------------------------------------
// Markup in free text

// Free text is stored so that no markdown preview can see a comment or a tag in it: `<` before a
// letter, "/", "!" or "?" and the end of a comment become entities. A literal entity in the
// original is protected by escaping its ampersand, so decodeMarkup(encodeMarkup(x)) is x.
export function encodeMarkup(text) {
  return defuseMarkup(String(text ?? '').replace(/&(?=(?:lt|gt|amp);)/g, '&amp;'));
}

// Only the defusing, without touching ampersands. Safe to apply again to its own output.
export function defuseMarkup(text) {
  return String(text ?? '')
    .replace(/<(?=[A-Za-z/!?])/g, '&lt;')
    .replace(/--!?>/g, (whole) => `${whole.slice(0, -1)}&gt;`);
}

// For one part of a list that is joined into a string (a person in the respondent line): every
// ampersand is escaped, so that a part can never end or fake an entity. decodeMarkup reverses it.
export function encodeListPart(text) {
  return defuseMarkup(String(text ?? '').replace(/&/g, '&amp;'));
}

// The same for the name of a person, in which a comma is written as &#44; so that the first
// comma of "Name, Role" always separates the name from the role.
export function encodeListName(text) {
  return encodeListPart(text).replace(/,/g, '&#44;');
}

export function decodeListPart(text) {
  return String(text ?? '').replace(/&(lt|gt|amp|#44);/g, (whole, name) => {
    if (name === 'lt') return '<';
    if (name === 'gt') return '>';
    return name === 'amp' ? '&' : ',';
  });
}

// People in a respondent line are separated by a semicolon that does not end an entity.
export const RESPONDENT_LINE_SEPARATOR = /(?<!&(?:lt|gt|amp|#44));/;

export function decodeMarkup(text) {
  return String(text ?? '').replace(/&(lt|gt|amp);/g, (whole, name) => {
    if (name === 'lt') return '<';
    return name === 'gt' ? '>' : '&';
  });
}

// Minimal option parser for the scripts. `spec` maps an option name to 'string' or 'boolean'.
// Returns { values, positionals, problems }; problems are { key, params } with i18n keys.
export function parseArgv(argv, spec) {
  const values = {};
  const positionals = [];
  const problems = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index]);
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const equals = arg.indexOf('=');
    const name = equals === -1 ? arg.slice(2) : arg.slice(2, equals);
    const kind = Object.hasOwn(spec, name) ? spec[name] : undefined;
    if (!kind) {
      problems.push({ key: 'ui.check.err.unknownOption', params: { option: `--${name}` } });
    } else if (kind === 'boolean') {
      if (equals === -1) values[name] = true;
      else problems.push({ key: 'ui.check.err.unexpectedValue', params: { option: `--${name}` } });
    } else if (equals !== -1) {
      values[name] = arg.slice(equals + 1);
    } else if (index + 1 < argv.length && !String(argv[index + 1]).startsWith('--')) {
      values[name] = String(argv[index + 1]);
      index += 1;
    } else {
      problems.push({ key: 'ui.check.err.missingValue', params: { option: `--${name}` } });
    }
  }
  return { values, positionals, problems };
}
