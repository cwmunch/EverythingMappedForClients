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
// A name, a role, an owner or a recipient is a few words; a person list line is a few dozen people.
export const MAX_FIELD_CHARS = 200;
export const MAX_RESPONDENT_LINE_CHARS = 5000;

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
// descriptions and asset file names, and flagged in an existing pack, because they hide text,
// change the reading direction or show as nothing. The set is the Unicode property
// Default_Ignorable_Code_Point without the characters that legitimate text needs (see below), plus
// the interlinear annotation marks:
//   U+034F, U+061C, U+115F-1160, U+17B4-17B5, U+180B-180F, U+200B, the bidirectional embeddings
//   and overrides U+202A-202E, U+2060-206F (word joiner, invisible operators, isolates and the
//   deprecated format characters), U+3164, the byte order mark U+FEFF, U+FFA0, U+FFF0-FFF8,
//   U+FFF9-FFFB, U+1BCA0-1BCA3, U+1D173-1D17A and the tag and variation selector supplement
//   U+E0000-E0FFF.
// Not in the list, because stored text keeps them: ZWJ U+200D and ZWNJ U+200C (emoji and several
// scripts), the soft hyphen U+00AD, LRM U+200E, RLM U+200F, the variation selectors U+FE00-FE0F,
// U+202F and other white space. [from, to] ranges of code points.
export const HIDDEN_CHARACTER_RANGES = [
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200b],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff0, 0xfff8],
  [0xfff9, 0xfffb],
  [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a],
  [0xe0000, 0xe0fff],
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

// Text that a person may have written with line breaks and tabs, with every other control and
// hidden character written as <U+XXXX>. Used for text that is carried over unchanged (notes in the
// state file), so that nothing hidden is ever written back.
export function neutralizeHiddenCharacters(text) {
  const value = String(text ?? '');
  if (!hasHiddenCharacters(value)) return value;
  const parts = [];
  for (const char of value) {
    const code = char.codePointAt(0);
    parts.push(code === 9 || code === 10 || code === 13 ? char : showHiddenCharacters(char));
  }
  return parts.join('');
}

// True for a file name that the assets table can hold exactly: no control or hidden character,
// no line or paragraph separator (they end a row), no backslash, and no space at either end.
// Other names, with any kind of white space or invisible joiner, are stored as they are.
export function isStorableAssetName(name) {
  const value = String(name ?? '');
  if (value === '' || value.startsWith(' ') || value.endsWith(' ') || value.includes(String.fromCharCode(92))) return false;
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code < 32 || isControlCode(code) || isHiddenCode(code) || code === 0x2028 || code === 0x2029) return false;
  }
  return true;
}

// A file name for a message: every character that a terminal could show as nothing or as
// something else (control characters, hidden characters, joiners, direction marks, the soft hyphen,
// line and paragraph separators) and a space at either end are written as <U+XXXX>. This is the one
// way a file name is shown.
export function describeAssetName(name) {
  const parts = [];
  for (const char of String(name ?? '')) {
    const code = char.codePointAt(0);
    parts.push(code < 32 || isControlCode(code) || isDisplaySpoofing(code) ? codeMarker(code) : char);
  }
  let shown = parts.join('');
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
// Names in the pack and in the zip (FORMAT.md section 15)

// The tools that open the zip refuse longer names.
export const MAX_NAME_PART_BYTES = 255;
export const MAX_NAME_CHARACTERS = 240;

// Windows treats these names as devices, with or without an extension (nul.png is the device too).
// The superscript digits (code points 185, 178, 179) are reserved as well.
const PACK_DEVICE_NAMES = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9\xb9\xb2\xb3]|LPT[1-9\xb9\xb2\xb3])$/;
// Characters Windows cannot store in a file name.
const PACK_WINDOWS_CHARACTER = /[<>:"|?*]/;
// Besides control and hidden characters, a name may not hold the joiners and direction marks
// U+200C-200F or the line and paragraph separators, which make a name look like another one.
const PACK_NAME_EXTRA_RANGES = [[0x200c, 0x200f], [0x2028, 0x2029]];

function isPackNameForbiddenCode(code) {
  return code < 32 || isControlCode(code) || isHiddenCode(code) || inRanges(code, PACK_NAME_EXTRA_RANGES);
}

// Printable ASCII only: such a name needs none of the per-character work below.
const PRINTABLE_ASCII = /^[ -~]*$/;

function isWellFormedString(text) {
  if (PRINTABLE_ASCII.test(text)) return true;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function packNameBytes(text) {
  if (PRINTABLE_ASCII.test(text)) return text.length;
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code < 0x10000) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

function hasPackNameForbiddenCharacter(name) {
  if (PRINTABLE_ASCII.test(name)) return PACK_WINDOWS_CHARACTER.test(name);
  for (const char of name) {
    if (PACK_WINDOWS_CHARACTER.test(char) || isPackNameForbiddenCode(char.codePointAt(0))) return true;
  }
  return false;
}

// Two names that differ only in case, or in how an accent is written, are one file on Windows and
// macOS. This is the key that tells.
export function foldPackName(name) {
  return String(name).normalize('NFC').toLowerCase();
}

// The reasons for one part of a name (between two slashes), in the order the zip checks them.
function partNameProblems(part) {
  if (part === '') return [{ code: 'emptyPart', part }];
  if (part === '.' || part === '..') return [{ code: 'dotPart', part }];
  const problems = [];
  if (/[. ]$/.test(part)) problems.push({ code: 'endsWithDotOrSpace', part });
  if (PACK_DEVICE_NAMES.test(part.split('.')[0].trimEnd().toUpperCase())) problems.push({ code: 'deviceName', part });
  if (packNameBytes(part) > MAX_NAME_PART_BYTES) problems.push({ code: 'partTooLong', part });
  return problems;
}

// partCache (a Map from a part to its problems) saves the work when many names share their folders.
function collectNameProblems(name, partCache) {
  if (typeof name !== 'string' || name === '') return [{ code: 'empty' }];
  const ascii = PRINTABLE_ASCII.test(name);
  if (!ascii && !isWellFormedString(name)) return [{ code: 'notText' }];
  const problems = [];
  if (name.includes(String.fromCharCode(92))) problems.push({ code: 'backslash' });
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) problems.push({ code: 'notRelative' });
  if (hasPackNameForbiddenCharacter(name)) problems.push({ code: 'forbiddenCharacter' });
  for (const part of name.split('/')) {
    let found = partCache.get(part);
    if (found === undefined) {
      found = partNameProblems(part);
      partCache.set(part, found);
    }
    for (const problem of found) problems.push(problem);
  }
  if ((ascii ? name.length : Array.from(name).length) > MAX_NAME_CHARACTERS) problems.push({ code: 'pathTooLong' });
  return problems;
}

// Every reason the zip would refuse one entry name (a path from the pack root, forward slashes),
// in the order the zip checks them: [{ code, part? }], empty when the name is fine. Codes: empty,
// notText, backslash, notRelative, forbiddenCharacter, emptyPart, dotPart, endsWithDotOrSpace,
// deviceName, partTooLong and pathTooLong. A part-level code names the part.
export function nameProblems(name) {
  return collectNameProblems(name, new Map());
}

// The problems of a whole list of entry names: [{ name, code, part?, other? }] in the order of the
// list. Besides the problems of each name (see nameProblems) it finds a name that is the same as an
// earlier one apart from case or accent (code duplicate, other: the earlier name) and a name that is
// a file where another entry needs a folder of that name (code fileAndFolder, other: an entry
// inside the folder).
export function entryNameProblems(names) {
  const list = names.map((name) => String(name));
  const keys = list.map(foldPackName);
  const firstByKey = new Map();
  const insideFolder = new Map();
  const knownFolders = new Set();
  for (const [index, name] of list.entries()) {
    const key = keys[index];
    if (!firstByKey.has(key)) firstByKey.set(key, name);
    const parts = name.split('/');
    for (let length = 1; length < parts.length; length += 1) {
      const folder = parts.slice(0, length).join('/');
      if (knownFolders.has(folder)) continue;
      knownFolders.add(folder);
      const folderKey = foldPackName(folder);
      if (!insideFolder.has(folderKey)) insideFolder.set(folderKey, name);
    }
  }
  const partCache = new Map();
  const problems = [];
  const seen = new Set();
  for (const [index, name] of list.entries()) {
    for (const problem of collectNameProblems(name, partCache)) problems.push({ name, ...problem });
    const key = keys[index];
    if (seen.has(key)) problems.push({ name, code: 'duplicate', other: firstByKey.get(key) });
    seen.add(key);
    if (insideFolder.has(key)) problems.push({ name, code: 'fileAndFolder', other: insideFolder.get(key) });
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Setext headings in free text

// In markdown a line of = or - below a line of text turns that line into a heading. Free text is
// stored with one more backslash in front of such a line, so it is text and nothing else, and the
// reader takes the backslash off again. A line is an underline when it is up to three spaces, one
// or more = (or one or more -) and spaces or tabs, with any number of backslashes in front (the
// ones that earlier text already had). Every such line gets one backslash; every such line that
// starts with a backslash loses one, so the round trip is exact.
const SETEXT_UNDERLINE_LINE = /^\\* {0,3}(?:=+|-+)[ \t]*$/;
const SETEXT_ESCAPED_LINE = /^\\+ {0,3}(?:=+|-+)[ \t]*$/;

export function protectSetextLines(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => (SETEXT_UNDERLINE_LINE.test(line) ? `${String.fromCharCode(92)}${line}` : line))
    .join('\n');
}

export function restoreSetextLines(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => (SETEXT_ESCAPED_LINE.test(line) ? line.slice(1) : line))
    .join('\n');
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
