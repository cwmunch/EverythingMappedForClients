// An independent, minimal unzip for the tests. It follows the zip specification (end of central
// directory, central directory, local headers) and shares no code with zip.mjs.

import assert from 'node:assert/strict';
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function findEndRecord(zip) {
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 65535); at -= 1) {
    if (zip.readUInt32LE(at) === 0x06054b50) return at;
  }
  throw new Error('end of central directory not found');
}

// Returns a Map: name -> { data, method, flags, dosTime, dosDate, compressedSize, mode, versionMadeBy }
export function unzip(zip) {
  const end = findEndRecord(zip);
  assert.equal(zip.readUInt16LE(end + 4), 0, 'single disk');
  const count = zip.readUInt16LE(end + 10);
  assert.equal(zip.readUInt16LE(end + 8), count);
  const centralSize = zip.readUInt32LE(end + 12);
  const centralOffset = zip.readUInt32LE(end + 16);
  assert.equal(centralOffset + centralSize, end, 'the central directory ends where the end record starts');

  const entries = new Map();
  let at = centralOffset;
  for (let i = 0; i < count; i += 1) {
    assert.equal(zip.readUInt32LE(at), 0x02014b50, 'central header signature');
    const flags = zip.readUInt16LE(at + 8);
    const method = zip.readUInt16LE(at + 10);
    const dosTime = zip.readUInt16LE(at + 12);
    const dosDate = zip.readUInt16LE(at + 14);
    const crc = zip.readUInt32LE(at + 16);
    const compressedSize = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const externalAttributes = zip.readUInt32LE(at + 38);
    const localOffset = zip.readUInt32LE(at + 42);
    const rawName = zip.subarray(at + 46, at + 46 + nameLength);
    const name = flags & 0x0800 ? rawName.toString('utf8') : rawName.toString('latin1');

    assert.equal(zip.readUInt32LE(localOffset), 0x04034b50, 'local header signature');
    assert.equal(zip.readUInt16LE(localOffset + 26), nameLength, 'local name length');
    assert.equal(zip.readUInt32LE(localOffset + 14), crc, 'local crc matches central crc');
    const dataStart = localOffset + 30 + nameLength + zip.readUInt16LE(localOffset + 28);
    const stored = zip.subarray(dataStart, dataStart + compressedSize);

    let data;
    if (method === 0) data = Buffer.from(stored);
    else if (method === 8) data = zlib.inflateRawSync(stored);
    else throw new Error(`unsupported method ${method}`);

    assert.equal(data.length, size, `${name}: size`);
    assert.equal(crc32(data), crc, `${name}: crc`);
    assert.ok(!entries.has(name), `${name}: duplicate`);
    entries.set(name, {
      data,
      method,
      flags,
      dosTime,
      dosDate,
      compressedSize,
      mode: externalAttributes >>> 16,
      versionMadeBy: zip.readUInt16LE(at + 4),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(at, end, 'the central directory has no gaps');
  return entries;
}
