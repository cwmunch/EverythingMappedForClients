// The logic of the static form without any DOM: form state, answers, pack files, manifest, zip.
//
// tools/build-form.mjs inlines this file after the six pure library modules (util, i18n-core, rules,
// parse, render, validate) into one script, so everything here shares their scope and uses their
// functions directly. Nothing in this file touches the DOM, the network or storage.

const FORM_FORMAT = 'everything-mapped-form/1';
const OWNER_CHOICES = ['client', 'me', 'other'];
const SIZE_WARNING_BYTES = 50 * 1024 * 1024;
const ZIP_MAX_BYTES = 0xffffffff;
const ZIP_MAX_ENTRIES = 0xffff;
// What the team's reader of a pack accepts (FORMAT.md section 15): the form never builds more.
const PACK_MAX_ENTRIES = 5000;
const PACK_MAX_BYTES = 500 * 1024 * 1024;
const PACK_MAX_RATIO = 200;
// Room kept for the manifest and the state file when the size is checked before they are made.
const PACK_HEADROOM_BYTES = 2 * 1024 * 1024;
// Entries of a pack besides the attached files: six answer files, the open questions, the file list, the manifest and the state.
const PACK_OWN_ENTRIES = 10;
// Attached files, in the form, in saved data and in an export: one limit everywhere.
const MAX_ATTACHMENTS = PACK_MAX_ENTRIES - PACK_OWN_ENTRIES;
// Rows of a list. The page stops at this number, and anything beyond it is reported, never dropped quietly.
const MAX_ROWS = 500;
const MAX_NAME = 100;
const MAX_NAME_BYTES = 200;
// What the exporter of form data and its loader agree on. Base64 text of the attached files over
// the first number, and the form data is exported without the files; the file is never over the second.
const EXPORT_FILES_BUDGET = 300 * 1024 * 1024;
const IMPORT_MAX_BYTES = 400 * 1024 * 1024;
// While a pack is built, the page gets a turn after about this many bytes of work.
const YIELD_EVERY_BYTES = 8 * 1024 * 1024;
// What is left out of the room for attached files at attaching time, besides the answer files: the
// open-questions text and the new row of the file list are not known yet.
const ATTACH_EXTRA_HEADROOM_BYTES = 1024 * 1024;
// Work on a big file is done in slices of this size (a multiple of 64, the block size of SHA-256).
const WORK_SLICE_BYTES = 4 * 1024 * 1024;
const DEFLATE_SLICE_BYTES = 1024 * 1024;

// How much each kind of field may hold. The library reads lines of at most 20 000 characters and an
// answer of at most 200 KB, and escaping can make text more than twice as long (a "<" and the letter
// after it become five characters). So a line of a pack file never gets near the limit: fields are
// short, and long lines in a text are broken at WRAP_WIDTH.
const LIMITS = {
  block: { kind: 'block', max: 50000 },
  line: { kind: 'line', max: 2000 },
  item: { kind: 'line', max: 1000 },
  note: { kind: 'block', max: 4000 },
  asset: { kind: 'line', max: 500 },
  person: { kind: 'name', max: 120 },
  recipient: { kind: 'name', max: 200 },
  owner: { kind: 'name', max: 200 },
};
const WRAP_WIDTH = 4000;

// An error whose message is a text key of the form (ui.form.err.*), so the interface can show it
// in the chosen language.
class FormError extends Error {
  constructor(key, params = {}) {
    super(key);
    this.name = 'FormError';
    this.key = key;
    this.params = params;
  }
}

// ---------------------------------------------------------------------------------------------
// Cleaning text that is typed, pasted or loaded
//
// The form removes the characters the library refuses and nothing else (isControlCode and
// isHiddenCode of util.mjs, the one rule that check, answer and the manifest share): the control
// characters (all of C0 but tab and line feed, DEL, all of C1) and the characters that hide text or
// change its direction. Lone surrogates go as well, because they cannot be written as UTF-8 text.
// Joiners (ZWJ, ZWNJ), the soft hyphen, the direction marks LRM and RLM and the narrow no-break
// space are text and stay. Line and paragraph separators are line breaks, as the library reads them.

const SEPARATORS = new RegExp(`[${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`, 'g');
const LONE_SURROGATES = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

function isRefusedCode(code) {
  return isControlCode(code) || isHiddenCode(code);
}

// -> { text, removed }: the text without the refused characters, and how many were removed.
function removeRefused(value) {
  const text = typeof value === 'string' ? value : '';
  if (!hasHiddenCharacters(text) && !LONE_SURROGATE.test(text)) return { text, removed: 0 };
  let removed = 0;
  let kept = '';
  for (const char of text.replace(LONE_SURROGATES, () => { removed += 1; return ''; })) {
    if (isRefusedCode(char.codePointAt(0))) removed += 1;
    else kept += char;
  }
  return { text: kept, removed };
}

// Cuts to at most `max` UTF-16 units without leaving half a surrogate pair.
function cutUnits(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function splitLongLine(line, width) {
  const pieces = [];
  let rest = line;
  while (rest.length > width) {
    let cut = rest.lastIndexOf(' ', width);
    let skip = 1;
    if (cut < width / 2) {
      cut = width;
      skip = 0;
      const unit = rest.charCodeAt(cut - 1);
      if (unit >= 0xd800 && unit <= 0xdbff) cut -= 1;
    }
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut + skip);
  }
  pieces.push(rest);
  return pieces.join('\n');
}

// Breaks lines longer than `width` at a space when there is one near the end, else in the middle
// of a word. In markdown a line break inside a paragraph reads like a space.
function wrapLongLines(text, width) {
  if (text.length <= width) return text;
  return text.split('\n').map((line) => (line.length > width ? splitLongLine(line, width) : line)).join('\n');
}

// What is looked at of a text that may be far longer than its field takes (a loaded file can hold
// millions of characters): twice the limit, so that what is removed from it cannot leave less than
// the limit unless nearly everything is removed. The rest would be cut anyway.
function boundedText(text, max) {
  return text.length > max * 2 + 16 ? cutUnits(text, max * 2 + 16) : text;
}

// One line: breaks and tabs become spaces.
function cleanLine(value, max) {
  const text = typeof value === 'string' ? boundedText(value, max) : '';
  return cutUnits(removeRefused(text.replace(/[\t\r\n]+/g, ' ').replace(SEPARATORS, ' ')).text, max);
}

// A name of a person: the same rule as any line (the library refuses the same characters in a name).
function cleanName(value, max) {
  return cleanLine(value, max);
}

// Several lines, as in a text area.
function cleanBlock(value, max) {
  const text = typeof value === 'string' ? boundedText(value, max) : '';
  const plain = cutUnits(removeRefused(text.replace(/\r\n?/g, '\n').replace(SEPARATORS, '\n')).text, max);
  return cutUnits(wrapLongLines(plain, WRAP_WIDTH), max);
}

// `limit` is one of LIMITS.
function cleanField(value, limit) {
  return limit.kind === 'block' ? cleanBlock(value, limit.max) : cleanLine(value, limit.max);
}

// How many characters cleanField removes from what a person typed or pasted (not the ones cut for length).
function countRemoved(value) {
  return removeRefused(value).removed;
}

// ---------------------------------------------------------------------------------------------
// Bytes: UTF-8, CRC-32, SHA-256, base64

function encodeUtf8(text) {
  const source = String(text);
  const out = new Uint8Array(source.length * 3);
  let length = 0;
  for (let index = 0; index < source.length; index += 1) {
    let code = source.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < source.length) {
      const next = source.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        index += 1;
      }
    }
    if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
    if (code < 0x80) {
      out[length++] = code;
    } else if (code < 0x800) {
      out[length++] = 0xc0 | (code >> 6);
      out[length++] = 0x80 | (code & 0x3f);
    } else if (code < 0x10000) {
      out[length++] = 0xe0 | (code >> 12);
      out[length++] = 0x80 | ((code >> 6) & 0x3f);
      out[length++] = 0x80 | (code & 0x3f);
    } else {
      out[length++] = 0xf0 | (code >> 18);
      out[length++] = 0x80 | ((code >> 12) & 0x3f);
      out[length++] = 0x80 | ((code >> 6) & 0x3f);
      out[length++] = 0x80 | (code & 0x3f);
    }
  }
  return out.slice(0, length);
}

function toBytes(data) {
  return typeof data === 'string' ? encodeUtf8(data) : data;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32Update(crc, bytes, start, end) {
  let c = crc;
  for (let index = start; index < end; index += 1) c = CRC_TABLE[(c ^ bytes[index]) & 0xff] ^ (c >>> 8);
  return c;
}

function crc32(bytes) {
  return (crc32Update(0xffffffff, bytes, 0, bytes.length) ^ 0xffffffff) >>> 0;
}

// The CRC of a big file in slices, so the page gets turns while it is made. `pause` is what
// makeYielder returns.
async function crc32Async(bytes, pause) {
  let crc = 0xffffffff;
  for (let at = 0; at < bytes.length; at += WORK_SLICE_BYTES) {
    const end = Math.min(bytes.length, at + WORK_SLICE_BYTES);
    crc = crc32Update(crc, bytes, at, end);
    await pause(end - at);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const SHA_ROUNDS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value, count) {
  return (value >>> count) | (value << (32 - count));
}

// Mixes one 64-byte block of `bytes` (starting at `offset`) into the hash state.
function shaBlock(state, bytes, offset, words) {
  for (let index = 0; index < 16; index += 1) {
    const at = offset + index * 4;
    words[index] = (bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3];
  }
  for (let index = 16; index < 64; index += 1) {
    const early = words[index - 15];
    const late = words[index - 2];
    const small0 = rotateRight(early, 7) ^ rotateRight(early, 18) ^ (early >>> 3);
    const small1 = rotateRight(late, 17) ^ rotateRight(late, 19) ^ (late >>> 10);
    words[index] = words[index - 16] + small0 + words[index - 7] + small1;
  }
  let [a, b, c, d, e, f, g, h] = state;
  for (let index = 0; index < 64; index += 1) {
    const big1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
    const choose = (e & f) ^ (~e & g);
    const first = (h + big1 + choose + SHA_ROUNDS[index] + words[index]) >>> 0;
    const big0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
    const majority = (a & b) ^ (a & c) ^ (b & c);
    const second = (big0 + majority) >>> 0;
    h = g;
    g = f;
    f = e;
    e = (d + first) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (first + second) >>> 0;
  }
  [a, b, c, d, e, f, g, h].forEach((value, index) => {
    state[index] += value;
  });
}

// The last bytes of the message (fewer than 64), the 0x80 marker and the length in bits, as one or
// two blocks. The rest of the message is mixed in where it lies, so it is never copied.
function shaTail(bytes, fullLength) {
  const rest = bytes.length - fullLength;
  const tail = new Uint8Array(rest + 9 <= 64 ? 64 : 128);
  tail.set(bytes.subarray(fullLength));
  tail[rest] = 0x80;
  const view = new DataView(tail.buffer);
  view.setUint32(tail.length - 8, Math.floor(bytes.length / 0x20000000));
  view.setUint32(tail.length - 4, (bytes.length << 3) >>> 0);
  return tail;
}

function shaStart() {
  return new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
}

// Mixes in the end of the message and gives the hash as lower-case hex.
function shaFinish(state, bytes, fullLength, words) {
  const tail = shaTail(bytes, fullLength);
  for (let offset = 0; offset < tail.length; offset += 64) shaBlock(state, tail, offset, words);
  return Array.from(state, (word) => word.toString(16).padStart(8, '0')).join('');
}

// SHA-256 of a Uint8Array as lower-case hex (the manifest hashes every file with it).
function sha256Hex(bytes) {
  const state = shaStart();
  const words = new Uint32Array(64);
  const fullLength = bytes.length - (bytes.length % 64);
  for (let offset = 0; offset < fullLength; offset += 64) shaBlock(state, bytes, offset, words);
  return shaFinish(state, bytes, fullLength, words);
}

// The same, in slices, so the page gets turns while a big file is hashed.
async function sha256HexSliced(bytes, pause) {
  const state = shaStart();
  const words = new Uint32Array(64);
  const fullLength = bytes.length - (bytes.length % 64);
  for (let at = 0; at < fullLength; at += WORK_SLICE_BYTES) {
    const end = Math.min(fullLength, at + WORK_SLICE_BYTES);
    for (let offset = at; offset < end; offset += 64) shaBlock(state, bytes, offset, words);
    await pause(end - at);
  }
  return shaFinish(state, bytes, fullLength, words);
}

function hexOf(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// SHA-256 as lower-case hex. The browser does it when it can (crypto.subtle, which runs beside the
// page and is much faster than the code above); else, or when it refuses, the code above does it, in
// slices (`pause`, from makeYielder, gives the page its turns). Both give the same text.
async function sha256HexAsync(bytes, pause = async () => {}) {
  const subtle = typeof crypto === 'object' && crypto !== null ? crypto.subtle : null;
  if (subtle && typeof subtle.digest === 'function') {
    try {
      return hexOf(new Uint8Array(await subtle.digest('SHA-256', bytes)));
    } catch {
      // Not allowed here (a page that is not a secure context): the plain code does it.
    }
  }
  return sha256HexSliced(bytes, pause);
}

// -> async (bytes) => void. Lets the page have a turn (`yieldToPage`, an async function) after about
// YIELD_EVERY_BYTES of work, so a big pack does not freeze the page and the message "building" shows.
function makeYielder(yieldToPage) {
  let pending = 0;
  return async (bytes) => {
    if (typeof yieldToPage !== 'function') return;
    pending += bytes;
    if (pending < YIELD_EVERY_BYTES) return;
    pending = 0;
    await yieldToPage();
  };
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_CODES = Uint8Array.from(BASE64_ALPHABET, (symbol) => symbol.charCodeAt(0));
const BASE64_VALUES = (() => {
  const values = new Int8Array(128).fill(-1);
  for (let index = 0; index < BASE64_ALPHABET.length; index += 1) values[BASE64_ALPHABET.charCodeAt(index)] = index;
  return values;
})();
const BASE64_CHUNK_BYTES = 3 * 65536;

// The base64 text of bytes[start, end); start and end - start are multiples of 3 except at the end.
function base64Chunk(bytes, start, end) {
  const out = new Uint8Array(Math.ceil((end - start) / 3) * 4);
  let at = 0;
  for (let index = start; index < end; index += 3) {
    const chunk = (bytes[index] << 16) | ((index + 1 < end ? bytes[index + 1] : 0) << 8) | (index + 2 < end ? bytes[index + 2] : 0);
    out[at++] = BASE64_CODES[(chunk >> 18) & 63];
    out[at++] = BASE64_CODES[(chunk >> 12) & 63];
    out[at++] = index + 1 < end ? BASE64_CODES[(chunk >> 6) & 63] : 61;
    out[at++] = index + 2 < end ? BASE64_CODES[chunk & 63] : 61;
  }
  let text = '';
  for (let from = 0; from < out.length; from += 16384) text += String.fromCharCode.apply(null, out.subarray(from, from + 16384));
  return text;
}

// The base64 text of bytes in pieces of about 256 KB, so that a big file never needs one huge string.
function base64Parts(bytes) {
  const parts = [];
  for (let start = 0; start < bytes.length; start += BASE64_CHUNK_BYTES) {
    parts.push(base64Chunk(bytes, start, Math.min(bytes.length, start + BASE64_CHUNK_BYTES)));
  }
  return parts;
}

// The same in slices: `pause` (from makeYielder) gives the page its turns while a big file is made
// into text. Calls `emit` with every piece.
async function base64PartsAsync(bytes, pause, emit) {
  for (let start = 0; start < bytes.length; start += BASE64_CHUNK_BYTES) {
    const end = Math.min(bytes.length, start + BASE64_CHUNK_BYTES);
    emit(base64Chunk(bytes, start, end));
    await pause(end - start);
  }
}

function bytesToBase64(bytes) {
  return base64Parts(bytes).join('');
}

// Returns a Uint8Array, or null when the text is not base64.
function base64ToBytes(text) {
  const source = String(text);
  const clean = /\s/.test(source) ? source.replace(/\s+/g, '') : source;
  if (clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) return null;
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((clean.length / 4) * 3 - padding);
  let length = 0;
  for (let index = 0; index < clean.length; index += 4) {
    let chunk = 0;
    for (let offset = 0; offset < 4; offset += 1) {
      const code = clean.charCodeAt(index + offset);
      chunk = (chunk << 6) | (code === 61 ? 0 : BASE64_VALUES[code]);
    }
    for (const shift of [16, 8, 0]) if (length < out.length) out[length++] = (chunk >> shift) & 255;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Zip writer (FORMAT.md section 15): standard zip, no zip64, UTF-8 names, CRC-32, stored or deflate.

function dosDateTime(date) {
  const year = date.getUTCFullYear();
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 };
  if (year > 2107) return { time: (23 << 11) | (59 << 5) | 29, date: (127 << 9) | (12 << 5) | 31 };
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

// A name in the zip is checked by the library's rule (nameProblems of util.mjs): the one the team's zip
// writer and the checks of a pack use. The form has no copy of it.
function checkedZipName(name) {
  const [problem] = nameProblems(name);
  if (problem) throw new Error(`Invalid zip entry name ${JSON.stringify(name)}: ${problem.code}`);
  return encodeUtf8(name);
}

function compareBytes(first, second) {
  const shared = Math.min(first.length, second.length);
  for (let index = 0; index < shared; index += 1) {
    if (first[index] !== second[index]) return first[index] - second[index];
  }
  return first.length - second.length;
}

// Raw deflate through the browser's CompressionStream, as a list of chunks (never joined into one
// buffer). Returns null when it is not available.
// The bytes go in slices of DEFLATE_SLICE_BYTES, each waited for: a browser deflates what it is given
// at once, so one write of a big file would keep the page busy for as long as it takes. Between
// slices `pause` (from makeYielder) gives the page its turns.
async function deflateRawChunks(bytes, pause = async () => {}) {
  if (typeof CompressionStream !== 'function') return null;
  try {
    const stream = new CompressionStream('deflate-raw');
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    const reading = (async () => {
      const chunks = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return chunks;
        chunks.push(value);
      }
    })();
    try {
      for (let at = 0; at < bytes.length; at += DEFLATE_SLICE_BYTES) {
        const end = Math.min(bytes.length, at + DEFLATE_SLICE_BYTES);
        await writer.write(bytes.subarray(at, end));
        await pause(end - at);
      }
      await writer.close();
    } catch (error) {
      reading.catch(() => {});
      throw error;
    }
    return await reading;
  } catch {
    return null;
  }
}

function chunksLength(chunks) {
  return chunks.reduce((sum, chunk) => sum + chunk.length, 0);
}

// One entry of the zip: its name, CRC and size, and the body as chunks (deflated when that makes
// it smaller, but not so much smaller that a reader suspects a zip bomb).
async function prepareZipEntry(entry, compress, pause) {
  const nameBytes = checkedZipName(entry.name);
  const data = toBytes(entry.data);
  let body = [data];
  let method = 0;
  const packed = compress && data.length > 0 ? await compress(data, pause) : null;
  const chunks = packed ? (Array.isArray(packed) ? packed : [packed]) : null;
  const packedLength = chunks ? chunksLength(chunks) : 0;
  if (chunks && packedLength < data.length && data.length <= packedLength * PACK_MAX_RATIO) {
    body = chunks;
    method = 8;
  }
  return { nameBytes, body, bodyLength: chunksLength(body), method, crc: await crc32Async(data, pause), size: data.length };
}

function zipLocalHeader(entry, dos) {
  const header = new Uint8Array(30 + entry.nameBytes.length);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 0x0800, true);
  view.setUint16(8, entry.method, true);
  view.setUint16(10, dos.time, true);
  view.setUint16(12, dos.date, true);
  view.setUint32(14, entry.crc, true);
  view.setUint32(18, entry.bodyLength, true);
  view.setUint32(22, entry.size, true);
  view.setUint16(26, entry.nameBytes.length, true);
  header.set(entry.nameBytes, 30);
  return header;
}

function zipCentralHeader(entry, dos, localOffset) {
  const header = new Uint8Array(46 + entry.nameBytes.length);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, (3 << 8) | 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(8, 0x0800, true);
  view.setUint16(10, entry.method, true);
  view.setUint16(12, dos.time, true);
  view.setUint16(14, dos.date, true);
  view.setUint32(16, entry.crc, true);
  view.setUint32(20, entry.bodyLength, true);
  view.setUint32(24, entry.size, true);
  view.setUint16(28, entry.nameBytes.length, true);
  view.setUint32(38, (0o100644 << 16) >>> 0, true);
  view.setUint32(42, localOffset, true);
  header.set(entry.nameBytes, 46);
  return header;
}

function zipEndRecord(count, centralSize, centralOffset) {
  const record = new Uint8Array(22);
  const view = new DataView(record.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, count, true);
  view.setUint16(10, count, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, centralOffset, true);
  return record;
}

// entries: [{ name, data }] with data a string (UTF-8) or a Uint8Array. options: { date, compress,
// yieldToPage } where compress is false (store only), an async function Uint8Array -> chunks|null,
// or omitted (deflate through CompressionStream when the browser has it, else store).
// Returns { parts, size }: the zip as a list of pieces (headers and bodies) that a Blob can take as
// they are, so no second copy of a big file is made. Entries are written sorted by name.
async function createZipParts(entries, options = {}) {
  if (entries.length > ZIP_MAX_ENTRIES) throw new FormError('ui.form.err.tooManyFiles', { count: entries.length, max: ZIP_MAX_ENTRIES });
  const dos = dosDateTime(options.date || new Date());
  const compress = options.compress === false ? null : options.compress || deflateRawChunks;
  // Two names that are one file on Windows or macOS (case, the way an accent is written), or a file
  // where another entry needs a folder: the library's rule, as in the team's zip writer.
  const clash = entryNameProblems(entries.map((entry) => entry.name)).find((problem) => problem.code === 'duplicate' || problem.code === 'fileAndFolder');
  if (clash) {
    throw new Error(clash.code === 'duplicate' ? `The name ${JSON.stringify(clash.name)} appears twice` : `The name ${JSON.stringify(clash.name)} is a file and also a folder`);
  }
  const prepared = [];
  const pause = makeYielder(options.yieldToPage);
  for (const entry of entries) prepared.push(await prepareZipEntry(entry, compress, pause));
  prepared.sort((first, second) => compareBytes(first.nameBytes, second.nameBytes));

  const parts = [];
  const central = [];
  let offset = 0;
  for (const entry of prepared) {
    central.push(zipCentralHeader(entry, dos, offset));
    const header = zipLocalHeader(entry, dos);
    parts.push(header, ...entry.body);
    offset += header.length + entry.bodyLength;
  }
  const centralSize = chunksLength(central);
  const size = offset + centralSize + 22;
  if (size > ZIP_MAX_BYTES) throw new FormError('ui.form.err.tooLarge');
  parts.push(...central, zipEndRecord(prepared.length, centralSize, offset));
  return { parts, size };
}

function joinParts(parts, size) {
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}

// The same zip as one Uint8Array (tests, small packs).
async function createZipBytes(entries, options = {}) {
  const { parts, size } = await createZipParts(entries, options);
  return joinParts(parts, size);
}

// ---------------------------------------------------------------------------------------------
// Names of attached files
//
// A name must pass three readers: the zip writer (nameProblems), the list of files in the pack
// (isStorableAssetName: no control or hidden character, no space at an end) and the pack reader
// (isPackFile: no hidden or temporary name). assetNameProblem asks all three; safeAssetName makes
// any name pass them.

// Characters that cannot be in a file name and are taken out of it: those the library refuses in a
// name (control and hidden characters, joiners and direction marks, line separators: the rule is
// nameProblems, asked for one character) and lone surrogates. The characters Windows cannot store
// (< > : " | ? *) are not taken out but made into a dash (repairName).
const NAME_CHARACTERS = new Map();

function isForbiddenNameChar(char) {
  const code = char.codePointAt(0);
  if (code >= 0xd800 && code <= 0xdfff) return true;
  if ('<>:"|?*'.includes(char)) return false;
  if (!NAME_CHARACTERS.has(char)) {
    NAME_CHARACTERS.set(char, nameProblems(`a${char}`).some((problem) => problem.code === 'forbiddenCharacter' || problem.code === 'notText'));
  }
  return NAME_CHARACTERS.get(char);
}

function isForbiddenNameCode(code) {
  return isForbiddenNameChar(String.fromCodePoint(code));
}

function nameMarker(code) {
  return `<U+${code.toString(16).toUpperCase().padStart(4, '0')}>`;
}

// The name with every character that a file name may not hold written as <U+XXXX>, so a person can
// see what was taken out.
function showNameCharacters(value) {
  let shown = '';
  for (const char of String(value ?? '')) {
    const code = char.codePointAt(0);
    shown += isForbiddenNameChar(char) ? nameMarker(code) : char;
  }
  return shown;
}

function removeNameCharacters(value) {
  let kept = '';
  for (const char of String(value ?? '')) if (!isForbiddenNameChar(char)) kept += char;
  return kept;
}

// Why `name`, a file name in the folder `directory` of the pack, is refused by the zip writer, the
// list of files or the reader of a pack: a short code, or '' when it is fine everywhere.
function assetNameProblem(name, directory) {
  const [zip] = nameProblems(`${directory}/${name}`);
  if (zip) return zip.code;
  if (!isStorableAssetName(name)) return 'storable';
  return isPackFile(`${directory}/${name}`) ? '' : 'hidden';
}

// At most MAX_NAME characters (not units: no emoji is cut in two) and MAX_NAME_BYTES bytes of UTF-8,
// keeping a short extension.
function limitName(name) {
  const points = Array.from(name);
  const dot = points.lastIndexOf('.');
  const extension = dot > 0 && points.length - dot <= 10 ? points.slice(dot) : [];
  const stem = dot > 0 && extension.length > 0 ? points.slice(0, dot) : points;
  let kept = stem.slice(0, Math.max(1, MAX_NAME - extension.length));
  while (kept.length > 1 && encodeUtf8(kept.concat(extension).join('')).length > MAX_NAME_BYTES) kept = kept.slice(0, -1);
  return kept.concat(extension).join('');
}

function trimNameEnd(name) {
  return name.replace(/[. ]+$/, '');
}

// What a name needs after it was cut or numbered, or was given: no dot at the front, none of the
// characters Windows refuses, nothing at the end that Windows drops (dot, space), a name left, no
// ".tmp" ending and no device name.
function repairName(value) {
  let name = value.trim().replace(/[<>:"|?*#%]/g, '-').replace(/\s+/g, '-');
  name = trimNameEnd(name.replace(/-{2,}/g, '-').replace(/^\.+/, ''));
  if (/^-*$/.test(name)) name = 'file';
  if (nameProblems(name).some((problem) => problem.code === 'deviceName')) name = `_${name}`;
  if (name.toLowerCase().endsWith('.tmp')) name = `${name.slice(0, -4)}-tmp`;
  return name;
}

// `stem` and `extension` with "-number" between them, the stem made shorter when the whole would be
// longer than a name may be.
function numberedName(stem, extension, number) {
  const points = Array.from(stem);
  for (;;) {
    const candidate = trimNameEnd(`${points.join('')}-${number}${extension}`);
    const fits = Array.from(candidate).length <= MAX_NAME + 1 && encodeUtf8(candidate).length <= MAX_NAME_BYTES + 1;
    if (fits || points.length <= 1) return candidate;
    points.pop();
  }
}

function uniqueName(name, taken) {
  if (!taken.has(foldPackName(name))) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  for (let number = 2; ; number += 1) {
    const candidate = numberedName(stem, extension, number);
    if (!taken.has(foldPackName(candidate))) return candidate;
  }
}

// A file name that is safe inside docs/assets on every system, unique among the folded names
// (NFC, lower case) in `taken`. The folder part of a path is dropped, and so are control characters,
// invisible and direction characters and lone surrogates. A name that was cut or numbered is made
// whole again: it never ends in a dot or a space. `directory` is the folder in the pack.
function safeAssetName(rawName, taken, directory = 'docs/assets') {
  const base = String(rawName ?? '').normalize('NFC').split(/[\\/]/).pop();
  const cleaned = cutUnits(removeNameCharacters(base), 4 * MAX_NAME_BYTES);
  const name = uniqueName(repairName(limitName(repairName(cleaned))), taken);
  return assetNameProblem(name, directory) === '' ? name : uniqueName('file', taken);
}

// ---------------------------------------------------------------------------------------------
// Texts of a record that came from outside (saved data, an imported file)

// Cleans a value and counts it in notes.cleaned when cleaning changed what was given.
// A value that is not text at all (a number, a list) is dropped and counted too.
function cleanTracked(value, limit, notes) {
  const cleaned = cleanField(value, limit);
  if (notes && value !== undefined && value !== null && (typeof value !== 'string' || cleaned !== value)) notes.cleaned += 1;
  return cleaned;
}

// What loading changed in the data it was given, so the page can say so: values that were cleaned or
// cut (cleaned), entries that do not belong in this form (ignored), list entries and attached files
// beyond the limits (droppedItems, droppedFiles) and the names of files that came without their
// content and must be attached again (reattach).
function newNotes() {
  return { cleaned: 0, ignored: 0, droppedItems: 0, droppedFiles: 0, reattach: [] };
}

function cleanItems(raw, withNote, notes) {
  if (!Array.isArray(raw)) return [];
  if (notes && raw.length > MAX_ROWS) notes.droppedItems += raw.length - MAX_ROWS;
  return raw.slice(0, MAX_ROWS).map((item) => ({
    text: cleanTracked(isPlainObject(item) ? item.text : item, LIMITS.item, notes),
    note: withNote && isPlainObject(item) ? cleanTracked(item.note, LIMITS.item, notes) : '',
  }));
}

function cleanChoices(question, raw) {
  const wanted = Array.isArray(raw) ? raw.filter((id) => typeof id === 'string') : [];
  const known = uniq(wanted.filter((id) => (question.choices ?? []).includes(id)));
  return question.type === 'choice' ? known.slice(0, 1) : known;
}

// The answer of one question, as the form keeps it. Only fields that fit the question type stay.
// notes (optional, see newNotes) counts what cleaning changed or left out.
function cleanRecord(question, raw, notes) {
  if (!isPlainObject(raw)) return null;
  const record = {};
  const type = question.type;
  if (type === 'text' || type === 'longtext') record.text = cleanTracked(raw.text, type === 'longtext' ? LIMITS.block : LIMITS.line, notes);
  if (type === 'list' || type === 'urllist') record.items = cleanItems(raw.items, type === 'urllist', notes);
  if (type === 'choice' || type === 'multichoice') {
    record.choice = cleanChoices(question, raw.choice);
    record.note = cleanTracked(raw.note, LIMITS.note, notes);
  }
  if (type === 'date') {
    record.date = isValidDate(raw.date) ? raw.date : '';
    record.note = cleanTracked(raw.note, LIMITS.note, notes);
  }
  record.unknown = raw.unknown === true;
  record.owner = OWNER_CHOICES.includes(raw.owner) ? raw.owner : 'client';
  record.ownerName = cleanTracked(raw.ownerName, LIMITS.owner, notes);
  record.due = isValidDate(raw.due) ? raw.due : '';
  record.tbdNote = cleanTracked(raw.tbdNote, LIMITS.note, notes);
  return record;
}

// ---------------------------------------------------------------------------------------------
// The engine

// data: { schema, dictionaries: { da, en }, toolVersion }. Returns the functions the form needs;
// none of them reads or writes the page.
function createEngine(data) {
  const schema = data.schema;
  const toolVersion = data.toolVersion;
  const storageKey = data.storageKey;
  const dictionaries = {};
  for (const lang of schema.languages) dictionaries[lang] = makeI18n(data.dictionaries[lang], lang);
  const ordered = questionsInOrder(schema);
  const byId = new Map(ordered.map((question) => [question.id, question]));

  function i18n(lang) {
    return dictionaries[lang];
  }

  function newState(options = {}) {
    return {
      format: FORM_FORMAT,
      language: schema.languages.includes(options.language) ? options.language : 'en',
      depth: Object.hasOwn(schema.depths, options.depth) ? options.depth : 'standard',
      respondent: { name: '', role: '' },
      recipient: '',
      currentModule: schema.moduleOrder[0],
      createdAt: isoDateTime(options.now || new Date()),
      answers: {},
      assets: [],
    };
  }

  // The record of a question, created when it is first needed for writing.
  function record(state, id) {
    if (!state.answers[id]) state.answers[id] = {};
    return state.answers[id];
  }

  function assetsOf(state, id) {
    return state.assets.filter((asset) => asset.qid === id);
  }

  function nextAssetId(state) {
    const numbers = state.assets.map((asset) => Number(String(asset.id).replace(/^a/, '')) || 0);
    return `a${Math.max(0, ...numbers) + 1}`;
  }

  // The size of the attached files that have their content.
  function attachedBytes(state) {
    return state.assets.reduce((sum, asset) => sum + (asset.data ? asset.data.length : 0), 0);
  }

  // Why a file cannot be attached, as { key, params }, or null. Looks at the name and size only, so a
  // file that is too big is never read into memory. A pack holds at most PACK_MAX_BYTES in all and
  // needs PACK_HEADROOM_BYTES for its own files, so a single file over the difference can never fit,
  // and the files together may not go over it either. `textBytes` (optional) is what the answer files
  // take at the moment; the page passes it, so what is allowed here is what the build allows.
  function attachmentProblem(state, file, textBytes = 0) {
    const name = cleanLine(file.name, MAX_NAME_BYTES);
    const nominal = PACK_MAX_BYTES - PACK_HEADROOM_BYTES - ATTACH_EXTRA_HEADROOM_BYTES;
    const room = nominal - textBytes;
    const limit = `${Math.floor(nominal / (1024 * 1024))} MB`;
    if (file.size > room) return { key: 'ui.form.files.tooBig', params: { name, limit } };
    if (state.assets.length >= MAX_ATTACHMENTS) return { key: 'ui.form.files.tooMany', params: { name, max: MAX_ATTACHMENTS } };
    if (attachedBytes(state) + file.size > room) return { key: 'ui.form.files.totalTooBig', params: { name, limit } };
    return null;
  }

  // Adds a file. The name is cleaned (safeAssetName); when that changes it, `renamedFrom` keeps the
  // name the person gave, with the characters that were hidden made visible, so the page can say so.
  function addAsset(state, qid, file) {
    const taken = new Set(state.assets.map((asset) => foldPackName(asset.name)));
    const name = safeAssetName(file.name, taken, schema.generatedFiles.assetsDir);
    const asset = {
      id: nextAssetId(state),
      qid,
      name,
      renamedFrom: file.name === name ? '' : cutUnits(showNameCharacters(file.name), MAX_NAME_BYTES),
      what: '',
      owner: '',
      rights: '',
      restrictions: '',
      size: file.data.length,
      data: file.data,
    };
    state.assets.push(asset);
    return asset;
  }

  function removeAsset(state, id) {
    state.assets = state.assets.filter((asset) => asset.id !== id);
  }

  // ----- from the form's answers to answer.mjs style inputs

  function ownerOf(rec, respondent) {
    if (rec.owner === 'other') return oneLine(rec.ownerName);
    if (rec.owner === 'me') return oneLine(cleanField(respondent.name, LIMITS.person));
    return 'client';
  }

  function itemsOf(rec, question) {
    const withNote = question.type === 'urllist';
    return (rec.items ?? [])
      .map((item) => ({ text: oneLine(item.text), note: withNote ? oneLine(item.note) : '' }))
      .filter((item) => item.text !== '');
  }

  function contentInput(question, rec, state) {
    switch (question.type) {
      case 'text':
      case 'longtext': {
        const text = normalizeText(rec.text);
        return text === '' ? null : { text };
      }
      case 'list':
      case 'urllist': {
        const items = itemsOf(rec, question);
        return items.length === 0 ? null : { items };
      }
      case 'choice':
      case 'multichoice': {
        const ids = cleanChoices(question, rec.choice);
        return ids.length === 0 ? null : { choice: ids, note: normalizeText(rec.note) };
      }
      case 'date':
        return isValidDate(rec.date) ? { date: rec.date, note: normalizeText(rec.note) } : null;
      case 'files': {
        const items = assetsOf(state, question.id)
          .filter((asset) => asset.data)
          .map((asset) => ({ text: `assets/${asset.name}`, note: oneLine(cleanField(asset.what, LIMITS.asset)) }));
        return items.length === 0 ? null : { items };
      }
      default:
        return null;
    }
  }

  function answerInput(question, rec, state) {
    const own = cleanRecord(question, rec || {});
    if (own.unknown) {
      const due = isValidDate(own.due) ? own.due : '';
      return { id: question.id, status: 'tbd', owner: ownerOf(own, state.respondent), due, note: own.tbdNote || '' };
    }
    const content = contentInput(question, own, state);
    return content ? { id: question.id, status: 'complete', ...content } : null;
  }

  // Rows beyond MAX_ROWS that hold something. The page stops at the limit, so this finds state that
  // was changed some other way; it is reported as a problem and never dropped quietly.
  function overflowProblem(question, rec) {
    if (question.type !== 'list' && question.type !== 'urllist') return null;
    const rows = rec && Array.isArray(rec.items) ? rec.items.slice(MAX_ROWS) : [];
    const filled = (value) => typeof value === 'string' && value.trim() !== '';
    const lost = rows.filter((item) => (isPlainObject(item) ? filled(item.text) || filled(item.note) : filled(item))).length;
    return lost > 0 ? { key: 'ui.form.problem.tooManyRows', params: { id: question.id, count: lost, max: MAX_ROWS } } : null;
  }

  // -> { inputs, problems }: one input per answered question, in schema order. `problems` is
  // empty unless the state holds something the library rejects (it never does for cleaned state)
  // or something that would be left out (more list rows than the form takes).
  function inputsFromState(state) {
    const inputs = [];
    const problems = [];
    for (const question of ordered) {
      const overflow = overflowProblem(question, state.answers[question.id]);
      if (overflow) {
        problems.push(overflow);
        continue;
      }
      const input = answerInput(question, state.answers[question.id], state);
      if (!input) continue;
      const found = checkAnswerInput(question, input);
      if (found.length > 0) problems.push(...found);
      else inputs.push(input);
    }
    return { inputs, problems };
  }

  // ----- the pack, analysed

  // "Name, Role" as the interviewer writes it (respondentLabel of fs-pack.mjs): one line, no
  // semicolons (they separate people), every ampersand escaped, and a comma in the name written as
  // &#44; (encodeListName), so renderFile and the manifest read the name back whole.
  function respondentLabel(person) {
    const name = joinLines(cleanField(person.name, LIMITS.person)).replace(/;/g, ',');
    const role = joinLines(cleanField(person.role, LIMITS.person)).replace(/;/g, ',');
    if (name === '') return '';
    return role === '' ? encodeListName(name) : `${encodeListName(name)}, ${encodeListPart(role)}`;
  }

  function parsedFile(file, text) {
    return { path: file.path, exists: true, ...parseFile(text, schema) };
  }

  // Renders the six answer files and the assets table, reads them back the way the checking
  // script reads a pack from disk, and validates that. options: { now, today }.
  //
  // Only answers and files of questions that are in scope go into the pack: the level of the
  // question (after showIf and requiredIf) must be part of the chosen depth. The others stay in
  // the state, are counted in `leftOut`, and come back when the depth or the answers change.
  function analyze(state, options = {}) {
    const now = options.now || new Date();
    const today = options.today || localDate(now);
    const dictionary = dictionaries[state.language];
    const everything = inputsFromState(state);
    const known = {};
    for (const input of everything.inputs) known[input.id] = entryFromInput(byId.get(input.id), input);
    const inScope = (id) => {
      if (!byId.has(id)) return false;
      const level = effectiveLevel(byId.get(id), known, schema);
      return level !== 'skipped' && inDepth(level, state.depth, schema);
    };
    const inputs = everything.inputs.filter((input) => inScope(input.id));
    const problems = everything.problems.filter((problem) => inScope(problem.params.id));
    const entries = {};
    for (const input of inputs) entries[input.id] = known[input.id];
    const touched = new Set(inputs.map((input) => byId.get(input.id).file));
    const respondent = respondentLabel(state.respondent);
    const usable = state.assets.filter((asset) => asset.data && inScope(asset.qid));
    const leftOut = {
      answers: everything.inputs.length - inputs.length,
      files: state.assets.filter((asset) => asset.data && !inScope(asset.qid)).length,
    };
    // Attached files that belong in the pack but have no content on this page (after a reload, or
    // loaded from form data without them): they are left out, and the person is told which.
    const lacking = state.assets.filter((asset) => !asset.data && inScope(asset.qid)).map((asset) => asset.name);
    const rows = usable.map((asset) => ({
      file: `assets/${asset.name}`,
      what: cleanField(asset.what, LIMITS.asset),
      owner: cleanField(asset.owner, LIMITS.asset),
      rights: cleanField(asset.rights, LIMITS.asset),
      restrictions: cleanField(asset.restrictions, LIMITS.asset),
    }));
    const assetsText = renderAssets(rows, dictionary);
    const packData = {
      language: state.language,
      depth: state.depth,
      files: {},
      assets: { rows: parseAssets(assetsText), present: usable.map((asset) => asset.name) },
      manifest: null,
      state: null,
    };
    const files = schema.files.map((file) => {
      const meta = { language: state.language, respondent: touched.has(file.id) ? respondent : '', updated: today };
      const text = renderFile(schema, dictionary, file.id, entries, meta);
      packData.files[file.id] = parsedFile(file, text);
      return { id: file.id, path: file.path, text };
    });
    const report = validatePackData(packData, schema, { depth: state.depth, today });
    return { now, today, inputs, problems, leftOut, lacking, entries, respondent, files, assetsText, rows, usable, packData, report };
  }

  function isVisible(report, id, depth) {
    const entry = report.questions[id];
    return Boolean(entry) && entry.level !== 'skipped' && inDepth(entry.level, depth, schema);
  }

  // Per module: how many questions are in scope, how many are answered (complete or partial) and
  // how many are deferred. Also the same for the whole form.
  function progress(report, depth) {
    const total = { total: 0, done: 0, tbd: 0 };
    const perModule = Object.fromEntries(schema.moduleOrder.map((id) => [id, { total: 0, done: 0, tbd: 0 }]));
    for (const question of ordered) {
      if (!isVisible(report, question.id, depth)) continue;
      const status = report.questions[question.id].status;
      for (const bucket of [total, perModule[question.module]]) {
        bucket.total += 1;
        if (status === 'complete' || status === 'partial') bucket.done += 1;
        if (status === 'tbd') bucket.tbd += 1;
      }
    }
    return { total, perModule };
  }

  // The size of the first field of an answer that has reached its limit, or 0. What is typed or pasted
  // beyond a limit is cut, so the person is told when a field is full.
  function fullFieldSize(question, own) {
    const full = [];
    const check = (value, limit) => {
      if (typeof value === 'string' && value.length >= limit.max) full.push(limit.max);
    };
    if (question.type === 'text' || question.type === 'longtext') check(own.text, question.type === 'longtext' ? LIMITS.block : LIMITS.line);
    for (const item of own.items ?? []) {
      check(item.text, LIMITS.item);
      check(item.note, LIMITS.item);
    }
    check(own.note, LIMITS.note);
    check(own.tbdNote, LIMITS.note);
    check(own.ownerName, LIMITS.owner);
    return full[0] ?? 0;
  }

  // Soft hints for one question: [{ key, params }]. They never block anything.
  function hints(question, state, report) {
    const own = cleanRecord(question, state.answers[question.id] || {});
    const found = [];
    const full = fullFieldSize(question, own);
    if (full > 0) found.push({ key: 'ui.form.hint.atLimit', params: { max: full } });
    if (own.unknown) return found;
    const rules = question.rules || {};
    const text = question.type === 'text' || question.type === 'longtext' ? normalizeText(own.text) : '';
    if (rules.minChars && textLength(text) < rules.minChars) {
      found.push({ key: 'ui.form.hint.minChars', params: { actual: textLength(text), min: rules.minChars } });
    }
    if (rules.minItems) {
      const attached = assetsOf(state, question.id).filter((asset) => asset.data).length;
      const count = question.type === 'files' ? attached : itemsOf(own, question).length;
      if (count < rules.minItems) found.push({ key: 'ui.form.hint.minItems', params: { actual: count, min: rules.minItems } });
    }
    const flags = (report.questions[question.id] && report.questions[question.id].flags) || [];
    for (const flag of flags) {
      if (flag.id === 'rule.notUrl') found.push({ key: 'ui.form.hint.notUrl', params: { item: flag.params.item } });
      if (flag.id === 'rule.dateInPast') found.push({ key: 'ui.form.hint.datePast', params: { date: flag.params.date } });
    }
    return found;
  }

  // ----- the files of the pack

  function lastModule(analysis) {
    const last = analysis.inputs.length > 0 ? byId.get(analysis.inputs[analysis.inputs.length - 1].id) : null;
    return last ? last.module : schema.moduleOrder[0];
  }

  function firstLine(text) {
    return String(text ?? '').split('\n')[0].trim();
  }

  function findAnswerIn(packData, id) {
    for (const file of Object.values(packData.files)) {
      if (file.answers && file.answers[id]) return file.answers[id];
    }
    return null;
  }

  function answeredValue(packData, id) {
    const entry = findAnswerIn(packData, id);
    const counts = entry && (entry.status === 'complete' || entry.status === 'partial') && entry.value;
    return counts ? entry.value : null;
  }

  // "Anna Jensen, Marketing; Peter Holm, IT" in the front matter -> people with their latest update.
  function manifestRespondents(packData) {
    const people = new Map();
    for (const file of Object.values(packData.files)) {
      const frontMatter = file.frontMatter;
      if (!file.exists || !frontMatter || !frontMatter.respondent) continue;
      for (const part of frontMatter.respondent.split(RESPONDENT_LINE_SEPARATOR)) {
        const [name, ...roleParts] = part.split(',');
        const person = { name: decodeListPart(name.trim()), role: decodeListPart(roleParts.join(',').trim()), updated: frontMatter.updated ?? '' };
        if (person.name === '') continue;
        const key = `${person.name}\n${person.role}`;
        const known = people.get(key);
        if (!known || person.updated > known.updated) people.set(key, person);
      }
    }
    return [...people.values()];
  }

  function manifestOf(state, analysis, hashes, stamp) {
    const { packData, report } = analysis;
    const name = answeredValue(packData, 'B.name');
    const kind = answeredValue(packData, 'A.project-kind');
    return {
      schema: schema.schema,
      toolVersion,
      language: report.language,
      depth: report.depth,
      project: { name: name ? firstLine(name.text) : '', kind: kind ? (kind.choice ?? [])[0] ?? '' : '' },
      respondents: manifestRespondents(packData),
      createdAt: state.createdAt || stamp,
      updatedAt: stamp,
      completeness: manifestCompleteness(report),
      files: hashes,
    };
  }

  function stateFileOf(state, analysis, stamp) {
    return {
      schema: schema.schema,
      language: state.language,
      depth: state.depth,
      currentModule: lastModule(analysis),
      focus: [],
      recipient: cleanField(state.recipient, LIMITS.recipient).trim(),
      notes: '',
      updatedAt: stamp,
    };
  }

  function jsonText(value) {
    return `${JSON.stringify(value, null, 2)}\n`;
  }

  // Refuses a pack that the team's reader would refuse: too many entries, a file in the pack that is
  // not a pack file (hidden or temporary name), an answer file over 2 MB, or a total over 500 MB.
  // Looks at names and sizes only, so nothing big is read or hashed first.
  function checkPackLimits(texts, usable) {
    const count = texts.length + usable.length + 2;
    if (count > PACK_MAX_ENTRIES) throw new FormError('ui.form.err.tooManyFiles', { count, max: PACK_MAX_ENTRIES });
    const unfit = usable.find((asset) => assetNameProblem(asset.name, schema.generatedFiles.assetsDir) !== '');
    if (unfit) throw new FormError('ui.form.err.fileName', { name: unfit.name });
    const large = texts.find((entry) => entry.data.length > MAX_TEXT_FILE_BYTES);
    if (large) throw new FormError('ui.form.err.fileTooLarge', { file: large.name, limit: '2 MB' });
    const bytes = [...texts.map((entry) => entry.data), ...usable.map((asset) => asset.data)].reduce((sum, data) => sum + data.length, 0);
    if (bytes + PACK_HEADROOM_BYTES > PACK_MAX_BYTES) throw new FormError('ui.form.err.tooLarge');
  }

  // Everything that goes into the zip, as [{ name, data }] (names with the docs/ prefix), plus the
  // objects it was made from. The manifest and the state file are not listed in the manifest.
  // options: { yieldToPage, beforeWork } as for buildPack.
  async function packEntries(live, analysis, options = {}) {
    // The page may change while the hashes are made (another language, a recipient typed): what goes
    // into the pack is what was there when it began.
    const state = { language: live.language, depth: live.depth, recipient: live.recipient, createdAt: live.createdAt };
    const generated = schema.generatedFiles;
    const stamp = isoDateTime(analysis.now);
    const openText = renderOpenQuestions(analysis.report, dictionaries[state.language]);
    const texts = [
      ...analysis.files.map((file) => ({ name: file.path, data: encodeUtf8(file.text) })),
      { name: generated.openQuestions, data: encodeUtf8(openText) },
      { name: generated.assets, data: encodeUtf8(analysis.assetsText) },
    ];
    checkPackLimits(texts, analysis.usable);
    // Here, with what the pack is made of read and checked, the page may be given a frame (so that a
    // message written before the build is drawn before the long work starts).
    if (typeof options.beforeWork === 'function') await options.beforeWork();
    const hashed = [...texts, ...analysis.usable.map((asset) => ({ name: `${generated.assetsDir}/${asset.name}`, data: asset.data }))];
    const pause = makeYielder(options.yieldToPage);
    const hashes = [];
    for (const entry of hashed) {
      hashes.push({ path: entry.name, sha256: await sha256HexAsync(entry.data, pause) });
    }
    hashes.sort((first, second) => (first.path < second.path ? -1 : first.path > second.path ? 1 : 0));
    const manifest = manifestOf(state, analysis, hashes, stamp);
    const stateFile = stateFileOf(state, analysis, stamp);
    const entries = [
      ...hashed,
      { name: generated.manifest, data: encodeUtf8(jsonText(manifest)) },
      { name: generated.state, data: encodeUtf8(jsonText(stateFile)) },
    ];
    return { entries, manifest, stateFile, openText };
  }

  // The error for answers that the library would drop from the pack: the person must fix them.
  function droppedError(state, analysis) {
    const ids = uniq(analysis.problems.map((problem) => problem.params.id));
    const questions = ids.map((id) => questionLabel(dictionaries[state.language], id)).join(', ');
    return new FormError('ui.form.err.dropped', { count: ids.length, questions });
  }

  // The zip of the whole pack. Throws FormError when an answer would be dropped, when nothing is
  // answered or when the pack is too big. options: { now, today, compress, yieldToPage, beforeWork }
  // where beforeWork is an async function that is waited for before the long work starts.
  async function buildPack(state, options = {}) {
    const analysis = analyze(state, options);
    if (analysis.problems.length > 0) throw droppedError(state, analysis);
    if (!hasAnyAnswer(analysis.packData)) throw new FormError('ui.form.err.nothing');
    // The library's own check of the file names (assets.badName, assets.notPackable): a pack that
    // `check` would flag for a name is not made. Names from safeAssetName never are; this is the net.
    const unfit = analysis.report.flags.find((flag) => flag.id === 'assets.notPackable' || flag.id === 'assets.badName');
    if (unfit) throw new FormError('ui.form.err.fileName', { name: unfit.params.file });
    const built = await packEntries(state, analysis, options);
    const totalBytes = built.entries.reduce((sum, entry) => sum + entry.data.length, 0);
    if (totalBytes > PACK_MAX_BYTES) throw new FormError('ui.form.err.tooLarge');
    const zip = await createZipParts(built.entries, { date: analysis.now, compress: options.compress, yieldToPage: options.yieldToPage });
    const pack = {
      name: `intake-pack-${analysis.today}.zip`,
      parts: zip.parts,
      size: zip.size,
      entries: built.entries.map((entry) => ({ name: entry.name, size: entry.data.length })),
      manifest: built.manifest,
      report: analysis.report,
      leftOut: analysis.leftOut,
      lacking: analysis.lacking,
      totalBytes,
      large: totalBytes > SIZE_WARNING_BYTES,
    };
    // The zip as one array, made only when asked for (tests, small packs): a big pack stays in pieces.
    Object.defineProperty(pack, 'bytes', {
      get: () => joinParts(zip.parts, zip.size),
    });
    return pack;
  }

  // ----- saving and loading the form's own data

  // The state as plain data for saving. options: { files, savedAt, revision, writeId }. With
  // files: false no content of any file is in it, only names, descriptions and sizes (the saved
  // copy in the browser is made this way). revision and writeId (when given) tell a page which copy
  // in the browser it wrote or read last; see the page's persistState.
  function serializeState(state, options = {}) {
    const withFiles = options.files !== false;
    const answers = {};
    for (const question of ordered) {
      const rec = state.answers[question.id];
      if (rec) answers[question.id] = JSON.parse(JSON.stringify(rec));
    }
    const saved = {
      format: FORM_FORMAT,
      language: state.language,
      depth: state.depth,
      respondent: { name: state.respondent.name, role: state.respondent.role },
      recipient: state.recipient,
      currentModule: state.currentModule,
      createdAt: state.createdAt,
      savedAt: options.savedAt || '',
    };
    if (options.revision !== undefined) {
      saved.revision = options.revision;
      saved.writeId = options.writeId || '';
    }
    saved.answers = answers;
    saved.assets = state.assets.map((asset) => {
      const entry = {
        id: asset.id,
        qid: asset.qid,
        name: asset.name,
        renamedFrom: asset.renamedFrom || '',
        what: asset.what,
        owner: asset.owner,
        rights: asset.rights,
        restrictions: asset.restrictions,
        size: asset.size,
      };
      if (withFiles && asset.data) entry.data = bytesToBase64(asset.data);
      return entry;
    });
    return saved;
  }

  function base64Length(byteCount) {
    return Math.ceil(byteCount / 3) * 4;
  }

  // The form data as a file, planned: { parts, bytes, withFiles, reattach }. parts are pieces for a
  // Blob, so big files never become one huge string; joined, they are the JSON of serializeState with
  // the files. The file never goes over what the loader accepts: when the base64 text of the attached
  // files would be over EXPORT_FILES_BUDGET, none of the files go in. The answers and the list of
  // files (names, descriptions, sizes) always do. `reattach` lists the files that are not in the
  // file and must be attached again, by name (a file of no bytes comes back by itself and is not
  // listed). options: { yieldToPage }, as for buildPack.
  async function exportPlan(state, savedAt, options = {}) {
    const withData = state.assets.filter((asset) => asset.data);
    const base64Total = withData.reduce((sum, asset) => sum + base64Length(asset.data.length), 0);
    const withFiles = base64Total <= EXPORT_FILES_BUDGET;
    const saved = serializeState(state, { files: false, savedAt });
    const token = 'EMFC-ASSETS-PLACEHOLDER';
    const text = JSON.stringify({ ...saved, assets: token }, null, 2);
    const at = text.lastIndexOf(`"${token}"`);
    const pause = makeYielder(options.yieldToPage);
    const parts = [];
    let bytes = 0;
    const literal = (piece) => {
      parts.push(piece);
      bytes += encodeUtf8(piece).length;
    };
    literal(text.slice(0, at));
    literal('[');
    for (const [index, asset] of state.assets.entries()) {
      const meta = JSON.stringify(saved.assets[index]);
      if (index > 0) literal(',');
      if (withFiles && asset.data) {
        literal(`${meta.slice(0, -1)},"data":"`);
        await base64PartsAsync(asset.data, pause, (piece) => {
          parts.push(piece);
          bytes += piece.length;
        });
        literal('"}');
      } else {
        literal(meta);
      }
    }
    literal(']');
    literal(text.slice(at + token.length + 2));
    literal('\n');
    if (bytes > IMPORT_MAX_BYTES) throw new FormError('ui.form.err.exportTooLarge');
    return {
      parts,
      bytes,
      withFiles,
      reattach: state.assets.filter((asset) => (!withFiles || !asset.data) && asset.size > 0).map((asset) => asset.name),
    };
  }

  // The pieces of exportPlan alone.
  async function exportParts(state, savedAt, options = {}) {
    return (await exportPlan(state, savedAt, options)).parts;
  }

  // Puts the files of saved data into state. Nothing is dropped without being counted in notes.
  // A file that came without its content must be attached again: its name goes into notes.reattach.
  // `decoded` has the content of every file that came with one, decoded once (see savedShapeIsValid).
  function restoreAssets(list, state, notes, decoded) {
    if (list.length > MAX_ATTACHMENTS) notes.droppedFiles += list.length - MAX_ATTACHMENTS;
    const taken = new Set();
    for (const item of list.slice(0, MAX_ATTACHMENTS)) {
      const question = isPlainObject(item) ? byId.get(item.qid) : null;
      if (!question || question.type !== 'files') {
        notes.ignored += 1;
        continue;
      }
      const name = safeAssetName(item.name, taken, schema.generatedFiles.assetsDir);
      taken.add(foldPackName(name));
      if (name !== item.name) notes.cleaned += 1;
      const size = Math.max(0, Math.floor(Number(item.size)) || 0);
      let data = typeof item.data === 'string' ? decoded.get(item) ?? null : null;
      if (!data && item.data === undefined && item.size === 0) data = new Uint8Array(0);
      if (!data) notes.reattach.push(name);
      state.assets.push({
        id: `a${state.assets.length + 1}`,
        qid: question.id,
        name,
        renamedFrom: cleanLine(item.renamedFrom, MAX_NAME_BYTES),
        what: cleanTracked(item.what, LIMITS.asset, notes),
        owner: cleanTracked(item.owner, LIMITS.asset, notes),
        rights: cleanTracked(item.rights, LIMITS.asset, notes),
        restrictions: cleanTracked(item.restrictions, LIMITS.asset, notes),
        size: data ? data.length : size,
        data,
      });
    }
  }

  // Whether the parts of saved data have the right shape. Anything else means the data is damaged.
  // An answer under a question this form does not have is not looked at (it is skipped and counted
  // later, whatever it holds). The content of the files is decoded here, once, into `decoded`
  // (file record -> bytes); a content that is not base64 makes the data damaged.
  function savedShapeIsValid(raw, decoded) {
    const objectOrAbsent = (value) => value === undefined || isPlainObject(value);
    if (!objectOrAbsent(raw.answers) || !objectOrAbsent(raw.respondent)) return false;
    if (raw.assets !== undefined && !Array.isArray(raw.assets)) return false;
    const answers = raw.answers ?? {};
    if (Object.entries(answers).some(([id, record]) => byId.has(id) && !isPlainObject(record))) return false;
    for (const item of raw.assets ?? []) {
      if (!isPlainObject(item) || item.data === undefined) continue;
      const bytes = typeof item.data === 'string' ? base64ToBytes(item.data) : null;
      if (bytes === null) return false;
      decoded.set(item, bytes);
    }
    return true;
  }

  // raw: the parsed JSON of a saved or exported form.
  // -> { ok: true, state, notes: { cleaned, ignored } } | { ok: false, key }.
  // All of it is checked first. Damaged data is refused as a whole. What is merely not usable (a
  // question this form does not have, a text with characters that cannot be saved, a text that is too
  // long) is cleaned or left out and counted in notes, so the person can be told.
  function restoreState(raw) {
    if (!isPlainObject(raw) || raw.format !== FORM_FORMAT) return { ok: false, key: 'ui.form.err.importFormat' };
    const decoded = new Map();
    if (!savedShapeIsValid(raw, decoded)) return { ok: false, key: 'ui.form.err.importInvalid' };
    const notes = newNotes();
    const state = newState({ language: raw.language, depth: raw.depth });
    const person = raw.respondent ?? {};
    state.respondent = { name: cleanTracked(person.name, LIMITS.person, notes), role: cleanTracked(person.role, LIMITS.person, notes) };
    state.recipient = cleanTracked(raw.recipient, LIMITS.recipient, notes);
    const isStamp = typeof raw.createdAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(raw.createdAt) && isRealStamp(raw.createdAt);
    if (isStamp) state.createdAt = raw.createdAt;
    const known = schema.moduleOrder.includes(raw.currentModule) || raw.currentModule === 'finish';
    state.currentModule = known ? raw.currentModule : schema.moduleOrder[0];
    const answers = raw.answers ?? {};
    notes.ignored += Object.keys(answers).filter((id) => !byId.has(id)).length;
    for (const question of ordered) {
      if (Object.hasOwn(answers, question.id)) state.answers[question.id] = cleanRecord(question, answers[question.id], notes);
    }
    restoreAssets(raw.assets ?? [], state, notes, decoded);
    return { ok: true, state, notes, copy: savedCopyOf(raw) };
  }

  // A time like 2026-10-22T08:15:30Z that exists (not the 31st of February, not hour 25).
  function isRealStamp(value) {
    const time = Date.parse(value);
    return !Number.isNaN(time) && `${new Date(time).toISOString().slice(0, 19)}Z` === value;
  }

  // Which copy in the browser's storage saved data is: { revision, writeId, savedAt }, with 0 and ''
  // for what is missing or not of the right kind.
  function savedCopyOf(raw) {
    if (!isPlainObject(raw)) return { revision: 0, writeId: '', savedAt: '' };
    const revision = Number.isSafeInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0;
    const writeId = typeof raw.writeId === 'string' && /^[0-9a-f]{1,40}$/.test(raw.writeId) ? raw.writeId : '';
    return { revision, writeId, savedAt: typeof raw.savedAt === 'string' ? raw.savedAt.slice(0, 40) : '' };
  }

  // The number of the copy that follows `revision`. It starts again at 1 after the largest number a
  // script can count exactly, so a copy is never refused for having a number that is too big.
  function nextRevision(revision) {
    return Number.isSafeInteger(revision) && revision >= 0 && revision < Number.MAX_SAFE_INTEGER ? revision + 1 : 1;
  }

  // Files of `from` that `to` lists without content (loaded from the browser's storage, which keeps no
  // content): the content is taken over when the name, the question and the size are the same.
  function adoptFiles(from, to) {
    for (const asset of to.assets) {
      if (asset.data) continue;
      const same = from.assets.find((old) => old.data && old.qid === asset.qid && old.name === asset.name && old.data.length === asset.size);
      if (same) asset.data = same.data;
    }
    return to;
  }

  // The text of saved or exported form data -> the same as restoreState. The state it gives has been
  // analysed once, so a page that shows it will not meet an error it could have found here.
  function parseSavedText(text) {
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      return { ok: false, key: 'ui.form.err.importRead' };
    }
    const result = restoreState(raw);
    if (!result.ok) return result;
    try {
      analyze(result.state);
    } catch {
      return { ok: false, key: 'ui.form.err.importInvalid' };
    }
    return result;
  }

  function hasAnswers(state) {
    return hasAnyAnswer(analyze(state).packData);
  }

  return {
    schema,
    toolVersion,
    storageKey,
    ordered,
    byId,
    i18n,
    newState,
    record,
    assetsOf,
    attachmentProblem,
    attachedBytes,
    addAsset,
    removeAsset,
    inputsFromState,
    analyze,
    isVisible,
    progress,
    hints,
    buildPack,
    packEntries,
    serializeState,
    exportParts,
    exportPlan,
    adoptFiles,
    copyOf: savedCopyOf,
    nextRevision,
    restoreState,
    parseSavedText,
    hasAnswers,
  };
}

const EMFC_LIBRARY = {
  LIMITS,
  WRAP_WIDTH,
  MAX_ROWS,
  MAX_ATTACHMENTS,
  EXPORT_FILES_BUDGET,
  IMPORT_MAX_BYTES,
  PACK_HEADROOM_BYTES,
  YIELD_EVERY_BYTES,
  assetNameProblem,
  cleanBlock,
  cleanField,
  cleanLine,
  cleanName,
  countRemoved,
  foldPackName,
  isForbiddenNameCode,
  nameProblems,
  removeRefused,
  showNameCharacters,
  base64Parts,
  bytesToBase64,
  base64ToBytes,
  crc32,
  createZipBytes,
  createZipParts,
  encodeUtf8,
  FormError,
  ATTACH_EXTRA_HEADROOM_BYTES,
  safeAssetName,
  sha256Hex,
  sha256HexAsync,
  FORM_FORMAT,
  ZIP_MAX_ENTRIES,
  PACK_MAX_ENTRIES,
  PACK_MAX_BYTES,
  PACK_MAX_RATIO,
  joinParts,
};
