// A small zip writer (FORMAT.md section 15). Standard zip, no zip64.
//
//   createZip(entries, options?) -> Buffer                 everything in memory (small zips, tests)
//   writeZip(filePath, entries, options?) -> Buffer        the same, written to a file
//   writeZipFile(filePath, entries, options?) -> Promise   streams every entry; only the central
//                                                          directory is kept in memory
//
// An entry is { name, data, date? } or, for writeZipFile, { name, path, date? } to read the content
// from a file in chunks. `name` uses forward slashes and is relative ("docs/00-brief.md").
// `data` is a Buffer, a Uint8Array or a string (written as UTF-8). Entries are written sorted by
// name, so the same input always gives the same bytes. Each file is deflated, or stored when
// deflate would not make it smaller. Names are flagged as UTF-8 (bit 11).
//
// Times: an entry's own `date`, else options.date, else now. The DOS time has no time zone;
// the UTC fields of the date are stored, so the same date gives the same bytes on every computer.
// DOS time has a two-second step and covers 1980 to 2107; dates outside that are clamped.
//
// Files are written under a temporary name (a hidden name with a random part, created so that it
// cannot already exist) and renamed when complete. A file that was already there is never deleted
// because of a failure; only the temporary file this call created is.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';

export const MAX_ENTRIES = 0xffff;
export const MAX_BYTES = 0xffffffff;
// The tools that open the zip refuse longer names (FORMAT.md section 15).
export const MAX_NAME_PART_BYTES = 255;
export const MAX_NAME_CHARACTERS = 240;

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const VERSION_NEEDED = 20;
const MADE_BY_UNIX = 3;
const UTF8_FLAG = 0x0800;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const REGULAR_FILE_MODE = 0o100644;
const LOCAL_HEADER_SIZE = 30;
const READ_CHUNK_BYTES = 256 * 1024;
const TEMPORARY_ATTEMPTS = 8;

// code is one of: needsNewerNode, badInput, badName, nameTooLong, duplicateName, tooManyEntries,
// tooLarge, packTooLarge, fileChanged.
export class ZipError extends Error {
  constructor(code, message, params = {}) {
    super(message);
    this.name = 'ZipError';
    this.code = code;
    this.params = params;
  }
}

// Windows treats these names as devices, with or without an extension (nul.png is the device too).
// The superscript digits (code points 185, 178, 179) are reserved as well.
const DEVICE_NAMES = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9\xb9\xb2\xb3]|LPT[1-9\xb9\xb2\xb3])$/;

// Characters that may not appear in a name, as code point ranges: control characters (also the C1
// range), and the invisible characters that make a name look like another one: bidi marks,
// overrides and isolates, zero-width characters, the line and paragraph separators and the byte order mark.
const FORBIDDEN_RANGES = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x61c, 0x61c],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];
// Characters Windows cannot store in a file name.
const WINDOWS_FORBIDDEN = '<>:"|?*';

function hasForbiddenCharacter(name) {
  for (const character of name) {
    const code = character.codePointAt(0);
    if (WINDOWS_FORBIDDEN.includes(character)) return true;
    if (FORBIDDEN_RANGES.some(([first, last]) => code >= first && code <= last)) return true;
  }
  return false;
}

function isDeviceName(segment) {
  const base = segment.split('.')[0].trimEnd();
  return DEVICE_NAMES.test(base.toUpperCase());
}

// Names must work on Linux, macOS and Windows, must not be able to land outside the folder the
// zip is unpacked into, and must be short enough for the tools that open the zip.
export function checkName(name) {
  const fail = (reason) => new ZipError('badName', `Invalid zip entry name ${JSON.stringify(name)}: ${reason}`, { name });
  const tooLong = (reason) => new ZipError('nameTooLong', `Zip entry name ${JSON.stringify(name)} is too long: ${reason}`, {
    name,
    partBytes: MAX_NAME_PART_BYTES,
    characters: MAX_NAME_CHARACTERS,
  });
  if (typeof name !== 'string' || name === '') throw fail('the name is empty');
  if (!name.isWellFormed()) throw fail('the name is not valid text');
  if (name.includes('\\')) throw fail('use forward slashes');
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw fail('the name must be relative');
  if (hasForbiddenCharacter(name)) {
    throw fail('control characters, invisible characters and the characters < > : " | ? * are not allowed');
  }
  for (const segment of name.split('/')) {
    if (segment === '') throw fail('empty folder name or trailing slash');
    if (segment === '.' || segment === '..') throw fail('"." and ".." are not allowed');
    if (/[. ]$/.test(segment)) throw fail('a name may not end with a dot or a space');
    if (isDeviceName(segment)) throw fail('the name is reserved on Windows');
    if (Buffer.byteLength(segment, 'utf8') > MAX_NAME_PART_BYTES) {
      throw tooLong(`a part is longer than ${MAX_NAME_PART_BYTES} bytes`);
    }
  }
  if ([...name].length > MAX_NAME_CHARACTERS) throw tooLong(`the path is longer than ${MAX_NAME_CHARACTERS} characters`);
  return Buffer.from(name, 'utf8');
}

// Two names that differ only in case (or in how an accent is written) are one file on Windows and macOS.
function foldName(name) {
  return name.normalize('NFC').toLowerCase();
}

function toBuffer(data, name) {
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  throw new ZipError('badInput', `Entry ${JSON.stringify(name)} needs data as a string, Buffer or Uint8Array`, { name });
}

function dosDateTime(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new ZipError('badInput', 'The date for the zip entries is not a valid Date', {});
  }
  const year = date.getUTCFullYear();
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 };
  if (year > 2107) return { time: (23 << 11) | (59 << 5) | 29, date: (127 << 9) | (12 << 5) | 31 };
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

// Checks every entry name and date, refuses duplicates, and returns the entries sorted by name:
// [{ entry, nameBytes, dos }]. No content is read here, so nothing is written before this passes.
export function checkEntries(entries, defaultDate = new Date()) {
  if (!Array.isArray(entries)) throw new ZipError('badInput', 'The entries must be an array', {});
  if (typeof zlib.crc32 !== 'function') {
    throw new ZipError('needsNewerNode', 'zlib.crc32 is missing: Node.js 22.2 or newer is needed', {});
  }
  if (entries.length > MAX_ENTRIES) {
    throw new ZipError('tooManyEntries', `A zip file without zip64 holds at most ${MAX_ENTRIES} entries, got ${entries.length}`, {
      count: entries.length,
      max: MAX_ENTRIES,
    });
  }

  const seen = new Map();
  const checked = entries.map((entry) => {
    const nameBytes = checkName(entry.name);
    const folded = foldName(entry.name);
    if (seen.has(folded)) {
      const other = seen.get(folded);
      throw new ZipError('duplicateName', `The names ${JSON.stringify(other)} and ${JSON.stringify(entry.name)} are the same or differ only in case`, {
        name: entry.name,
        other,
      });
    }
    seen.set(folded, entry.name);
    return { entry, nameBytes, dos: dosDateTime(entry.date ?? defaultDate) };
  });
  return checked.sort((a, b) => Buffer.compare(a.nameBytes, b.nameBytes));
}

// record: { method, crc, compressedSize, size, dos, nameBytes }
function localHeader(record) {
  const header = Buffer.alloc(LOCAL_HEADER_SIZE);
  header.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0);
  header.writeUInt16LE(VERSION_NEEDED, 4);
  header.writeUInt16LE(UTF8_FLAG, 6);
  header.writeUInt16LE(record.method, 8);
  header.writeUInt16LE(record.dos.time, 10);
  header.writeUInt16LE(record.dos.date, 12);
  header.writeUInt32LE(record.crc, 14);
  header.writeUInt32LE(record.compressedSize, 18);
  header.writeUInt32LE(record.size, 22);
  header.writeUInt16LE(record.nameBytes.length, 26);
  header.writeUInt16LE(0, 28);
  return header;
}

function centralHeader(record, localOffset) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(CENTRAL_HEADER_SIGNATURE, 0);
  header.writeUInt16LE((MADE_BY_UNIX << 8) | VERSION_NEEDED, 4);
  header.writeUInt16LE(VERSION_NEEDED, 6);
  header.writeUInt16LE(UTF8_FLAG, 8);
  header.writeUInt16LE(record.method, 10);
  header.writeUInt16LE(record.dos.time, 12);
  header.writeUInt16LE(record.dos.date, 14);
  header.writeUInt32LE(record.crc, 16);
  header.writeUInt32LE(record.compressedSize, 20);
  header.writeUInt32LE(record.size, 24);
  header.writeUInt16LE(record.nameBytes.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE((REGULAR_FILE_MODE << 16) >>> 0, 38);
  header.writeUInt32LE(localOffset, 42);
  return header;
}

function endRecord(count, centralSize, centralOffset) {
  const record = Buffer.alloc(22);
  record.writeUInt32LE(END_SIGNATURE, 0);
  record.writeUInt16LE(0, 4);
  record.writeUInt16LE(0, 6);
  record.writeUInt16LE(count, 8);
  record.writeUInt16LE(count, 10);
  record.writeUInt32LE(centralSize, 12);
  record.writeUInt32LE(centralOffset, 16);
  record.writeUInt16LE(0, 20);
  return record;
}

function assertFits(total) {
  if (total > MAX_BYTES) {
    throw new ZipError('tooLarge', 'The zip file would be larger than 4 GiB, which needs zip64', { max: MAX_BYTES });
  }
}

// ---------------------------------------------------------------------------------------------
// In memory

// Compresses one entry in memory. Returns the record the headers need plus the bytes to store.
function compressInMemory({ entry, nameBytes, dos }) {
  const data = toBuffer(entry.data, entry.name);
  if (data.length > MAX_BYTES) {
    throw new ZipError('tooLarge', `${JSON.stringify(entry.name)} is larger than 4 GiB, which needs zip64`, { name: entry.name });
  }
  const deflated = data.length === 0 ? data : zlib.deflateRawSync(data, { level: 9 });
  const useDeflate = deflated.length < data.length;
  const body = useDeflate ? deflated : data;
  return {
    nameBytes,
    dos,
    body,
    method: useDeflate ? METHOD_DEFLATE : METHOD_STORED,
    crc: zlib.crc32(data),
    size: data.length,
    compressedSize: body.length,
  };
}

export function createZip(entries, options = {}) {
  const checked = checkEntries(entries, options.date ?? new Date());
  const parts = [];
  const centralParts = [];
  let offset = 0;

  for (const item of checked) {
    const record = compressInMemory(item);
    centralParts.push(centralHeader(record, offset), record.nameBytes);
    parts.push(localHeader(record), record.nameBytes, record.body);
    offset += LOCAL_HEADER_SIZE + record.nameBytes.length + record.body.length;
    assertFits(offset);
  }

  const central = Buffer.concat(centralParts);
  assertFits(offset + central.length + 22);
  return Buffer.concat([...parts, central, endRecord(checked.length, central.length, offset)]);
}

// ---------------------------------------------------------------------------------------------
// The temporary file

// Creates the temporary file for filePath, next to it, with a hidden name that has a random part.
// The file is opened so that it must not exist yet, so it is always one this call created.
// options.randomSuffix() may be given by tests to force a name.
function createTemporaryFile(filePath, randomSuffix = () => crypto.randomBytes(8).toString('hex')) {
  for (let attempt = 0; attempt < TEMPORARY_ATTEMPTS; attempt += 1) {
    const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomSuffix()}.tmp`);
    try {
      return { fd: fs.openSync(temporary, 'wx'), path: temporary };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new ZipError('badInput', `Could not find a free temporary name next to ${filePath}`, {});
}

// Runs write(fd) and renames the temporary file to filePath when it is done. On any failure only the
// temporary file made here is removed.
async function writeThroughTemporaryFile(filePath, options, write) {
  const temporary = createTemporaryFile(filePath, options.randomSuffix);
  let closed = false;
  try {
    const result = await write(temporary.fd);
    fs.closeSync(temporary.fd);
    closed = true;
    fs.renameSync(temporary.path, filePath);
    return result;
  } catch (error) {
    if (!closed) closeQuietly(temporary.fd);
    fs.rmSync(temporary.path, { force: true });
    throw error;
  }
}

function closeQuietly(fd) {
  try {
    fs.closeSync(fd);
  } catch {
    // already closed: the error that matters is the one being reported
  }
}

function writeFully(fd, buffer, position) {
  let written = 0;
  while (written < buffer.length) {
    written += fs.writeSync(fd, buffer, written, buffer.length - written, position + written);
  }
}

// Writes the zip to a file under a temporary name first, then renames it, so a failed write never
// leaves a half-written file under the real name. An existing file with the same name is replaced.
export function writeZip(filePath, entries, options = {}) {
  const zip = createZip(entries, options);
  const temporary = createTemporaryFile(filePath, options.randomSuffix);
  let closed = false;
  try {
    writeFully(temporary.fd, zip, 0);
    fs.closeSync(temporary.fd);
    closed = true;
    fs.renameSync(temporary.path, filePath);
  } catch (error) {
    if (!closed) closeQuietly(temporary.fd);
    fs.rmSync(temporary.path, { force: true });
    throw error;
  }
  return zip;
}

// ---------------------------------------------------------------------------------------------
// Streaming

// Writes what flows through it to the file at a growing position, and counts the bytes.
class FileSink extends Writable {
  constructor(fd, position) {
    super();
    this.fd = fd;
    this.position = position;
    this.bytes = 0;
  }

  _write(chunk, encoding, callback) {
    try {
      writeFully(this.fd, chunk, this.position + this.bytes);
      this.bytes += chunk.length;
      callback();
    } catch (error) {
      callback(error);
    }
  }
}

// Passes data through unchanged and measures it: size, CRC-32, and the running total of the whole zip.
class Measure extends Transform {
  constructor(entryName, budget) {
    super();
    this.entryName = entryName;
    this.budget = budget;
    this.size = 0;
    this.crc = 0;
  }

  _transform(chunk, encoding, callback) {
    this.size += chunk.length;
    this.crc = zlib.crc32(chunk, this.crc);
    if (this.size > MAX_BYTES) {
      callback(new ZipError('tooLarge', `${JSON.stringify(this.entryName)} is larger than 4 GiB, which needs zip64`, { name: this.entryName }));
      return;
    }
    if (this.budget) {
      this.budget.used += chunk.length;
      if (this.budget.max !== undefined && this.budget.used > this.budget.max) {
        callback(new ZipError('packTooLarge', 'The files are larger than the limit', { size: this.budget.used, max: this.budget.max }));
        return;
      }
    }
    callback(null, chunk);
  }
}

function openContent(entry) {
  if (typeof entry.path === 'string') return fs.createReadStream(entry.path, { highWaterMark: READ_CHUNK_BYTES });
  return Readable.from([toBuffer(entry.data, entry.name)], { objectMode: false });
}

// Streams one entry into the file at `start`: a placeholder header, the content (deflated, or stored
// when deflate does not make it smaller), then the real header over the placeholder.
// Returns the record for the central directory.
async function streamEntry(fd, item, start, budget) {
  const { entry, nameBytes, dos } = item;
  const record = { nameBytes, dos, method: METHOD_DEFLATE, crc: 0, size: 0, compressedSize: 0 };
  const dataStart = start + LOCAL_HEADER_SIZE + nameBytes.length;
  writeFully(fd, Buffer.concat([localHeader(record), nameBytes]), start);

  const measure = new Measure(entry.name, budget);
  const sink = new FileSink(fd, dataStart);
  await pipeline(openContent(entry), measure, zlib.createDeflateRaw({ level: 9 }), sink);
  record.crc = measure.crc;
  record.size = measure.size;

  if (measure.size > 0 && sink.bytes < measure.size) {
    record.compressedSize = sink.bytes;
  } else {
    fs.ftruncateSync(fd, dataStart);
    record.method = METHOD_STORED;
    record.compressedSize = measure.size;
    if (measure.size > 0) await copyStored(fd, entry, dataStart, record);
  }
  writeFully(fd, localHeader(record), start);
  return record;
}

// The second pass for a file that deflate did not shrink: copy it as it is, and check that it is the
// same content as the first pass saw.
async function copyStored(fd, entry, dataStart, record) {
  const measure = new Measure(entry.name, null);
  const sink = new FileSink(fd, dataStart);
  await pipeline(openContent(entry), measure, sink);
  if (measure.size !== record.size || measure.crc !== record.crc) {
    throw new ZipError('fileChanged', `${JSON.stringify(entry.name)} changed while the zip file was being made`, { name: entry.name });
  }
}

// Streams the entries into a zip file. entries: [{ name, path | data, date? }]. Names, duplicates and
// the entry count are checked before the file is created, and a failure removes the temporary file.
// options: { date?, maxUncompressedBytes? }. Resolves to { bytes, entries, uncompressed }.
export async function writeZipFile(filePath, entries, options = {}) {
  const checked = checkEntries(entries, options.date ?? new Date());
  const budget = { used: 0, max: options.maxUncompressedBytes };

  return writeThroughTemporaryFile(filePath, options, async (fd) => {
    const central = [];
    let offset = 0;
    for (const item of checked) {
      const record = await streamEntry(fd, item, offset, budget);
      central.push(centralHeader(record, offset), record.nameBytes);
      offset += LOCAL_HEADER_SIZE + record.nameBytes.length + record.compressedSize;
      assertFits(offset);
    }
    const centralBuffer = Buffer.concat(central);
    const total = offset + centralBuffer.length + 22;
    assertFits(total);
    writeFully(fd, centralBuffer, offset);
    writeFully(fd, endRecord(checked.length, centralBuffer.length, offset), offset + centralBuffer.length);
    return { bytes: total, entries: checked.length, uncompressed: budget.used };
  });
}
