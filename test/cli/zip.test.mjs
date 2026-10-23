import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { MAX_BYTES, MAX_ENTRIES, ZipError, assertEntryFits, createZip, writeZip, writeZipFile } from '../../skill/everything-mapped/scripts/lib/zip.mjs';
import { makeTempDir, wordSalad, writeFile } from './helpers.mjs';
import { unzip } from './unzip.mjs';

const fixedDate = new Date(Date.UTC(2026, 9, 23, 14, 7, 9));


// ---------------------------------------------------------------------------

test('round trip: several files come back byte for byte', () => {
  const files = {
    'docs/00-brief.md': Buffer.from('# Brief\n\nSvar på spørgsmål.\n'.repeat(40)),
    'docs/01-brand/brand.md': Buffer.from('Brand\n'),
    'docs/assets/logo.bin': crypto.randomBytes(5000),
    'docs/intake-state.json': Buffer.from('{"schema":"everything-mapped-for-clients/1"}\n'),
  };
  const zip = createZip(Object.entries(files).map(([name, data]) => ({ name, data })), { date: fixedDate });
  const entries = unzip(zip);

  assert.deepEqual([...entries.keys()].sort(), Object.keys(files).sort());
  for (const [name, data] of Object.entries(files)) {
    assert.ok(entries.get(name).data.equals(data), name);
  }
});

test('deflate is used when it makes the file smaller, stored when it does not', () => {
  const compressible = Buffer.from('Hello zip. '.repeat(500));
  const random = crypto.randomBytes(3000);
  const tiny = Buffer.from('a');
  const zip = createZip(
    [
      { name: 'compressible.txt', data: compressible },
      { name: 'random.bin', data: random },
      { name: 'tiny.txt', data: tiny },
    ],
    { date: fixedDate },
  );
  const entries = unzip(zip);

  assert.equal(entries.get('compressible.txt').method, 8);
  assert.ok(entries.get('compressible.txt').compressedSize < compressible.length / 10);
  assert.equal(entries.get('random.bin').method, 0);
  assert.equal(entries.get('random.bin').compressedSize, random.length);
  assert.equal(entries.get('tiny.txt').method, 0, 'one byte deflates to more than one byte');
  assert.ok(entries.get('random.bin').data.equals(random));
});

test('non-ASCII names (æøå) are stored as UTF-8 with bit 11 set and read back exactly', () => {
  const names = ['docs/æøå.md', 'docs/Ærø/Ål og Øl.txt', 'docs/assets/日本語.txt'];
  const zip = createZip(names.map((name) => ({ name, data: `indhold i ${name}` })), { date: fixedDate });
  const entries = unzip(zip);

  for (const name of names) {
    assert.ok(entries.has(name), name);
    assert.equal(entries.get(name).flags & 0x0800, 0x0800, `${name}: UTF-8 flag`);
    assert.equal(entries.get(name).data.toString('utf8'), `indhold i ${name}`);
  }
  // The raw bytes of the name in the file are UTF-8, not a legacy code page.
  assert.ok(zip.includes(Buffer.from('docs/æøå.md', 'utf8')));
});

test('an empty file is stored with size 0 and CRC 0', () => {
  const entries = unzip(createZip([{ name: 'docs/empty.txt', data: '' }], { date: fixedDate }));
  const empty = entries.get('docs/empty.txt');
  assert.equal(empty.method, 0);
  assert.equal(empty.compressedSize, 0);
  assert.equal(empty.data.length, 0);
});

test('a zip without entries is a valid empty archive', () => {
  const zip = createZip([], { date: fixedDate });
  assert.equal(zip.length, 22);
  assert.equal(unzip(zip).size, 0);
});

test('a 2 MB file round trips, both compressible and random', () => {
  const size = 2 * 1024 * 1024;
  const text = wordSalad(size);
  const noise = crypto.randomBytes(size);
  const mixed = Buffer.concat([crypto.randomBytes(size / 2), Buffer.alloc(size / 2, 'x')]);
  const zip = createZip(
    [
      { name: 'text.txt', data: text },
      { name: 'noise.bin', data: noise },
      { name: 'mixed.bin', data: mixed },
    ],
    { date: fixedDate },
  );
  const entries = unzip(zip);

  assert.ok(entries.get('text.txt').data.equals(text));
  assert.equal(entries.get('text.txt').method, 8);
  assert.ok(entries.get('noise.bin').data.equals(noise));
  assert.equal(entries.get('noise.bin').method, 0);
  assert.ok(entries.get('mixed.bin').data.equals(mixed));
  assert.equal(entries.get('mixed.bin').method, 8);
});

test('strings and Uint8Array data are accepted', () => {
  const entries = unzip(
    createZip(
      [
        { name: 'a.txt', data: 'tekst æ' },
        { name: 'b.bin', data: new Uint8Array([1, 2, 3, 250]) },
      ],
      { date: fixedDate },
    ),
  );
  assert.equal(entries.get('a.txt').data.toString('utf8'), 'tekst æ');
  assert.deepEqual([...entries.get('b.bin').data], [1, 2, 3, 250]);
});

test('entries are sorted by name and the output does not depend on the input order', () => {
  const list = ['docs/b.md', 'docs/a.md', 'docs/assets/z.png', 'docs/00-brief.md', 'docs/æ.md'];
  const make = (names) => createZip(names.map((name) => ({ name, data: `x ${name}` })), { date: fixedDate });
  const forward = make(list);
  const backward = make([...list].reverse());

  assert.ok(forward.equals(backward));
  assert.deepEqual(
    [...unzip(forward).keys()],
    ['docs/00-brief.md', 'docs/a.md', 'docs/assets/z.png', 'docs/b.md', 'docs/æ.md'],
  );
});

test('the DOS time comes from the supplied date (UTC fields, two-second steps)', () => {
  const entry = unzip(createZip([{ name: 'a.txt', data: 'x' }], { date: fixedDate })).get('a.txt');
  assert.equal(entry.dosTime >> 11, 14);
  assert.equal((entry.dosTime >> 5) & 0x3f, 7);
  assert.equal((entry.dosTime & 0x1f) * 2, 8);
  assert.equal((entry.dosDate >> 9) + 1980, 2026);
  assert.equal((entry.dosDate >> 5) & 0x0f, 10);
  assert.equal(entry.dosDate & 0x1f, 23);
});

test('an entry date overrides the default date, and dates outside 1980 to 2107 are clamped', () => {
  const entries = unzip(
    createZip(
      [
        { name: 'own.txt', data: 'x', date: new Date(Date.UTC(2001, 1, 3, 4, 5, 6)) },
        { name: 'default.txt', data: 'x' },
        { name: 'old.txt', data: 'x', date: new Date(Date.UTC(1970, 0, 1)) },
        { name: 'future.txt', data: 'x', date: new Date(Date.UTC(2200, 5, 5)) },
      ],
      { date: fixedDate },
    ),
  );
  assert.equal((entries.get('own.txt').dosDate >> 9) + 1980, 2001);
  assert.equal((entries.get('default.txt').dosDate >> 9) + 1980, 2026);
  assert.equal(entries.get('old.txt').dosDate, (1 << 5) | 1, '1980-01-01');
  assert.equal(entries.get('old.txt').dosTime, 0);
  assert.equal(entries.get('future.txt').dosDate, (127 << 9) | (12 << 5) | 31, '2107-12-31');
});

test('files are marked as regular files from Unix with mode 644', () => {
  const entry = unzip(createZip([{ name: 'a.txt', data: 'x' }], { date: fixedDate })).get('a.txt');
  assert.equal(entry.versionMadeBy >> 8, 3);
  assert.equal(entry.mode, 0o100644);
});

test('names that are absolute, contain .. or are otherwise unsafe are rejected', () => {
  const bad = [
    '/etc/passwd',
    '\\windows\\system32',
    'C:/Users/x.txt',
    'c:evil.txt',
    '../outside.txt',
    'docs/../../outside.txt',
    'docs/./a.txt',
    'docs//a.txt',
    'docs/folder/',
    'docs\\a.txt',
    'docs/a\0.txt',
    'docs/a\n.txt',
    '',
    '\ud800broken.txt',
  ];
  for (const name of bad) {
    assert.throws(
      () => createZip([{ name, data: 'x' }], { date: fixedDate }),
      (error) => error instanceof ZipError && error.code === 'badName',
      `${JSON.stringify(name.slice(0, 40))} should be rejected`,
    );
  }
});

// Characters are written as code points so that invisible ones are visible in this file.
const cp = (...codes) => String.fromCodePoint(...codes);
const isBadName = (error) => error instanceof ZipError && error.code === 'badName';

test('names that are device names or break on Windows or macOS are rejected', () => {
  const bad = [
    'CON',
    'docs/nul.png',
    'docs/NUL',
    'docs/Aux.txt',
    'docs/prn',
    'docs/COM1',
    'docs/com9.txt',
    'docs/LPT1.log',
    'docs/lpt9',
    'docs/con.tar.gz',
    'docs/CON .txt',
    'docs/CON/inner.txt',
    'CONIN$',
    `docs/COM${cp(0xb9)}.txt`,
    `docs/LPT${cp(0xb2)}`,
    `docs/com${cp(0xb3)}.md`,
    'docs/a:b.txt',
    'docs/x. ',
    'docs/x.',
    'docs/x ',
    'docs/folder./a.txt',
    'docs/a?b',
    'docs/a*b',
    'docs/a<b',
    'docs/a>b',
    'docs/a"b',
    'docs/a|b',
    `docs/ab${cp(0x202e)}cod.txt`,
    `docs/${cp(0x2066)}x.txt`,
    `docs/a${cp(0x200b)}b.txt`,
    `docs/a${cp(0x200d)}b.txt`,
    `docs/a${cp(0x2060)}b.txt`,
    `docs/a${cp(0xfeff)}b.txt`,
    `docs/a${cp(0x200e)}b.txt`,
    `docs/a${cp(0x2028)}b.txt`,
    `docs/a${cp(0x85)}b.txt`,
    `docs/a${cp(0x7f)}b.txt`,
  ];
  for (const name of bad) {
    assert.throws(() => createZip([{ name, data: 'x' }], { date: fixedDate }), isBadName, `${JSON.stringify(name)} should be rejected`);
  }
});

test('ordinary names that merely look like device names are accepted', () => {
  const good = [
    'docs/console.txt',
    'docs/communication.md',
    'docs/COM10.txt',
    'docs/NULL.txt',
    'docs/nullable',
    'docs/CONFIG',
    'docs/aux-plan.md',
    'docs/lpt.txt',
    'docs/com.txt',
    'docs/.gitkeep',
    'docs/a.b.c',
    'docs/Mit billede 1.png',
    'docs/Ærø og Åen.md',
  ];
  const entries = unzip(createZip(good.map((name) => ({ name, data: 'x' })), { date: fixedDate }));
  assert.deepEqual([...entries.keys()].sort(), [...good].sort());
});

test('names that differ only in case, or in how an accent is written, are rejected as duplicates', () => {
  const isDuplicate = (error) => error instanceof ZipError && error.code === 'duplicateName';
  const pairs = [
    ['docs/A.txt', 'docs/a.txt'],
    ['docs/Æ.md', 'docs/æ.md'],
    [`docs/${cp(0xe9)}.md`, `docs/e${cp(0x301)}.md`],
    ['Docs/a.txt', 'docs/A.txt'],
  ];
  for (const [first, second] of pairs) {
    assert.throws(
      () => createZip([{ name: first, data: '1' }, { name: second, data: '2' }]),
      (error) => isDuplicate(error) && error.params.name === second && error.params.other === first,
      `${JSON.stringify([first, second])}`,
    );
  }
  assert.doesNotThrow(() => createZip([{ name: 'Docs/a.txt', data: '1' }, { name: 'docs/b.txt', data: '2' }]));
});

test('a duplicate name is rejected', () => {
  assert.throws(
    () => createZip([{ name: 'a.txt', data: '1' }, { name: 'a.txt', data: '2' }]),
    (error) => error instanceof ZipError && error.code === 'duplicateName',
  );
});

test('bad data and a bad date are rejected with a clear error', () => {
  assert.throws(() => createZip([{ name: 'a.txt', data: 42 }]), (error) => error.code === 'badInput');
  assert.throws(() => createZip([{ name: 'a.txt', data: 'x' }], { date: new Date('nope') }), (error) => error.code === 'badInput');
  assert.throws(() => createZip('not a list'), (error) => error.code === 'badInput');
});

test('65535 entries are allowed, 65536 are refused with a clear message (no zip64)', () => {
  const make = (count) => Array.from({ length: count }, (_, i) => ({ name: `f/${i}`, data: '' }));
  const zip = createZip(make(MAX_ENTRIES), { date: fixedDate });
  assert.equal(unzip(zip).size, MAX_ENTRIES);

  assert.throws(
    () => createZip(make(MAX_ENTRIES + 1)),
    (error) => error instanceof ZipError && error.code === 'tooManyEntries' && /65535/.test(error.message),
  );
});

test('a single entry above 4 GiB is refused with a clear message (no zip64); checked with numbers, not with a 4 GiB buffer', () => {
  assert.doesNotThrow(() => assertEntryFits(MAX_BYTES, 'edge.bin'));
  assert.throws(
    () => assertEntryFits(MAX_BYTES + 1, 'huge.bin'),
    (error) => error instanceof ZipError && error.code === 'tooLarge' && error.params.name === 'huge.bin' && /zip64/.test(error.message),
  );
});

test('writeZip writes a readable file, replaces an older one and leaves no temporary file', (t) => {
  const folder = makeTempDir(t);
  const target = path.join(folder, 'intake-pack-2026-10-23.zip');

  writeZip(target, [{ name: 'docs/a.md', data: 'first' }], { date: fixedDate });
  const returned = writeZip(target, [{ name: 'docs/a.md', data: 'second' }], { date: fixedDate });

  const onDisk = fs.readFileSync(target);
  assert.ok(onDisk.equals(returned));
  assert.equal(unzip(onDisk).get('docs/a.md').data.toString(), 'second');
  assert.deepEqual(fs.readdirSync(folder), ['intake-pack-2026-10-23.zip']);
});

test('writeZip with an invalid entry writes nothing and keeps an existing file', (t) => {
  const folder = makeTempDir(t);
  const target = path.join(folder, 'pack.zip');
  writeZip(target, [{ name: 'a.txt', data: 'keep' }], { date: fixedDate });
  const before = fs.readFileSync(target);

  assert.throws(() => writeZip(target, [{ name: '../evil', data: 'x' }]), ZipError);
  assert.ok(fs.readFileSync(target).equals(before));
  assert.deepEqual(fs.readdirSync(folder), ['pack.zip']);
});

// ---------------------------------------------------------------------------------------------
// Name length limits

test('a path part of more than 255 bytes, or a path of more than 240 characters, is refused', () => {
  const isTooLong = (error) => error instanceof ZipError && error.code === 'nameTooLong';
  const tooLong = [
    `docs/${'x'.repeat(236)}`, // 241 characters in total
    `${'a'.repeat(100)}/${'b'.repeat(140)}`, // 241 characters in total
    `docs/${cp(0xe6).repeat(128)}.txt`, // one part of 256 + 4 bytes: 128 characters but more than 255 bytes
    `docs/${cp(0x65e5).repeat(86)}`, // three bytes each: 258 bytes in one part
  ];
  for (const name of tooLong) {
    assert.throws(() => createZip([{ name, data: 'x' }]), isTooLong, `${name.slice(0, 30)} should be refused`);
  }
  const fine = [
    `docs/${'x'.repeat(235)}`, // exactly 240 characters
    `docs/${cp(0xe6).repeat(125)}`, // 250 bytes in the part
    `${cp(0x65e5).repeat(85)}/a.txt`, // 255 bytes in the first part
  ];
  const entries = unzip(createZip(fine.map((name) => ({ name, data: 'x' })), { date: fixedDate }));
  assert.equal(entries.size, fine.length);
});

test('the refusal carries the limits, so the message can name them', () => {
  assert.throws(
    () => createZip([{ name: `docs/${'x'.repeat(300)}`, data: 'x' }]),
    (error) => error.code === 'nameTooLong' && error.params.partBytes === 255 && error.params.characters === 240 && error.params.name.startsWith('docs/'),
  );
});

// ---------------------------------------------------------------------------------------------
// Streaming writer

const date = new Date(Date.UTC(2026, 9, 23));

function makeContentFiles(t) {
  const dir = makeTempDir(t);
  const text = wordSalad(3 * 1024 * 1024);
  const noise = crypto.randomBytes(1024 * 1024 + 123);
  writeFile(path.join(dir, 'text.txt'), text);
  writeFile(path.join(dir, 'noise.bin'), noise);
  writeFile(path.join(dir, 'empty.txt'), '');
  writeFile(path.join(dir, 'tiny.txt'), 'a');
  return { dir, text, noise };
}

function fileEntries(dir, extra = []) {
  return [
    { name: 'docs/text.txt', path: path.join(dir, 'text.txt') },
    { name: 'docs/noise.bin', path: path.join(dir, 'noise.bin') },
    { name: 'docs/empty.txt', path: path.join(dir, 'empty.txt') },
    { name: 'docs/tiny.txt', path: path.join(dir, 'tiny.txt') },
    ...extra,
  ];
}

test('writeZipFile streams files from disk: round trip, deflate or stored as for the in-memory writer', async (t) => {
  const { dir, text, noise } = makeContentFiles(t);
  const target = path.join(dir, 'out.zip');
  const entries = fileEntries(dir, [{ name: 'docs/in-memory-æøå.md', data: 'indhold' }]);

  const result = await writeZipFile(target, entries, { date });
  const disk = fs.readFileSync(target);
  const read = unzip(disk);

  assert.deepEqual(result, { bytes: disk.length, entries: 5, uncompressed: text.length + noise.length + 1 + 'indhold'.length });
  assert.ok(read.get('docs/text.txt').data.equals(text));
  assert.equal(read.get('docs/text.txt').method, 8);
  assert.ok(read.get('docs/noise.bin').data.equals(noise));
  assert.equal(read.get('docs/noise.bin').method, 0, 'random data is stored, not deflated');
  assert.equal(read.get('docs/noise.bin').compressedSize, noise.length);
  assert.equal(read.get('docs/empty.txt').data.length, 0);
  assert.equal(read.get('docs/tiny.txt').method, 0);
  assert.equal(read.get('docs/in-memory-æøå.md').data.toString(), 'indhold');
  assert.equal(read.get('docs/in-memory-æøå.md').flags & 0x0800, 0x0800);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), [], 'no temporary file is left');
});

test('writeZipFile gives exactly the bytes that createZip gives for the same content', async (t) => {
  const { dir, text, noise } = makeContentFiles(t);
  const target = path.join(dir, 'out.zip');
  await writeZipFile(target, fileEntries(dir), { date });
  const inMemory = createZip(
    [
      { name: 'docs/text.txt', data: text },
      { name: 'docs/noise.bin', data: noise },
      { name: 'docs/empty.txt', data: '' },
      { name: 'docs/tiny.txt', data: 'a' },
    ],
    { date },
  );
  assert.ok(fs.readFileSync(target).equals(inMemory));
});

test('writeZipFile checks all names before it creates any file', async (t) => {
  const { dir } = makeContentFiles(t);
  const target = path.join(dir, 'out.zip');
  const before = fs.readdirSync(dir).sort();
  const bad = [
    [{ name: 'docs/ok.txt', path: path.join(dir, 'tiny.txt') }, { name: 'docs/CON.txt', path: path.join(dir, 'tiny.txt') }],
    [{ name: `docs/${'x'.repeat(300)}`, path: path.join(dir, 'tiny.txt') }],
    [{ name: 'docs/A.txt', path: path.join(dir, 'tiny.txt') }, { name: 'docs/a.txt', path: path.join(dir, 'tiny.txt') }],
  ];
  for (const entries of bad) {
    await assert.rejects(() => writeZipFile(target, entries, { date }), ZipError);
    assert.deepEqual(fs.readdirSync(dir).sort(), before, 'nothing may be created');
  }
});

test('writeZipFile stops when the total goes over the limit, and removes its temporary file', async (t) => {
  const { dir } = makeContentFiles(t);
  const target = path.join(dir, 'out.zip');
  const before = fs.readdirSync(dir).sort();
  await assert.rejects(
    () => writeZipFile(target, fileEntries(dir), { date, maxUncompressedBytes: 1024 * 1024 }),
    (error) => error instanceof ZipError && error.code === 'packTooLarge' && error.params.max === 1024 * 1024,
  );
  assert.deepEqual(fs.readdirSync(dir).sort(), before);
});

test('writeZipFile reports a missing source file and leaves no temporary file', async (t) => {
  const { dir } = makeContentFiles(t);
  const before = fs.readdirSync(dir).sort();
  await assert.rejects(() => writeZipFile(path.join(dir, 'out.zip'), [{ name: 'docs/gone.txt', path: path.join(dir, 'nope.txt') }], { date }), /ENOENT/);
  assert.deepEqual(fs.readdirSync(dir).sort(), before);
});

test('the temporary name is random, and a failure never deletes a file that was already there', async (t) => {
  const { dir } = makeContentFiles(t);
  const target = path.join(dir, 'out.zip');

  // Two runs get two different temporary names (the name is not predictable from the target).
  const seen = new Set();
  const spy = () => {
    const value = crypto.randomBytes(8).toString('hex');
    seen.add(value);
    return value;
  };
  await writeZipFile(target, [{ name: 'a.txt', data: 'x' }], { date, randomSuffix: spy });
  await writeZipFile(target, [{ name: 'a.txt', data: 'x' }], { date, randomSuffix: spy });
  assert.equal(seen.size, 2);

  // A file already sitting at the first temporary name is skipped over, not overwritten or deleted.
  const taken = path.join(dir, '.out.zip.same.tmp');
  writeFile(taken, 'precious');
  let calls = 0;
  const colliding = () => (calls++ < 2 ? 'same' : 'fresh');
  await writeZipFile(target, [{ name: 'a.txt', data: 'x' }], { date, randomSuffix: colliding });
  assert.equal(fs.readFileSync(taken, 'utf8'), 'precious');
  assert.equal(unzip(fs.readFileSync(target)).get('a.txt').data.toString(), 'x');

  // When every name collides it gives up, and still does not touch the file that is there.
  await assert.rejects(() => writeZipFile(target, [{ name: 'a.txt', data: 'x' }], { date, randomSuffix: () => 'same' }), ZipError);
  assert.equal(fs.readFileSync(taken, 'utf8'), 'precious');
});

test('writeZip (in memory) also keeps a file that sits at a colliding temporary name', (t) => {
  const dir = makeTempDir(t);
  const taken = path.join(dir, '.pack.zip.same.tmp');
  writeFile(taken, 'precious');
  assert.throws(() => writeZip(path.join(dir, 'pack.zip'), [{ name: 'a.txt', data: 'x' }], { date, randomSuffix: () => 'same' }), ZipError);
  assert.equal(fs.readFileSync(taken, 'utf8'), 'precious');
});

test('writeZipFile replaces an older zip with the same name', async (t) => {
  const { dir } = makeContentFiles(t);
  const target = path.join(dir, 'out.zip');
  await writeZipFile(target, [{ name: 'a.txt', data: 'first' }], { date });
  await writeZipFile(target, [{ name: 'a.txt', data: 'second' }], { date });
  assert.equal(unzip(fs.readFileSync(target)).get('a.txt').data.toString(), 'second');
});

// ---------------------------------------------------------------------------------------------
// The ratio rule: an entry that deflate would shrink by more than 200 to 1 is stored

test('an entry that would shrink by more than 200 to 1 is stored, the others are deflated', () => {
  const zeros = Buffer.alloc(1024 * 1024);
  const sentence = Buffer.alloc(300 * 1024, 'Det her er en lang linje med tekst. ');
  const salad = wordSalad(300 * 1024);
  const zip = createZip(
    [
      { name: 'zeros.bin', data: zeros },
      { name: 'sentence.txt', data: sentence },
      { name: 'salad.txt', data: salad },
    ],
    { date: fixedDate },
  );
  const entries = unzip(zip);

  assert.equal(entries.get('zeros.bin').method, 0);
  assert.equal(entries.get('sentence.txt').method, 0);
  assert.equal(entries.get('salad.txt').method, 8);
  assert.ok(entries.get('zeros.bin').data.equals(zeros), 'a stored entry is the file itself');
  for (const [name, entry] of entries) {
    if (entry.method === 8) assert.ok(entry.data.length <= entry.compressedSize * 200, `${name} would be refused by the receiving side`);
  }
});

test('writeZipFile applies the same ratio rule and gives the same bytes as createZip', async (t) => {
  const dir = makeTempDir(t);
  const zeros = Buffer.alloc(2 * 1024 * 1024);
  const salad = wordSalad(500 * 1024);
  writeFile(path.join(dir, 'zeros.bin'), zeros);
  writeFile(path.join(dir, 'salad.txt'), salad);

  const target = path.join(dir, 'out.zip');
  await writeZipFile(target, [{ name: 'docs/zeros.bin', path: path.join(dir, 'zeros.bin') }, { name: 'docs/salad.txt', path: path.join(dir, 'salad.txt') }], { date });
  const entries = unzip(fs.readFileSync(target));
  assert.equal(entries.get('docs/zeros.bin').method, 0);
  assert.equal(entries.get('docs/salad.txt').method, 8);
  assert.ok(entries.get('docs/zeros.bin').data.equals(zeros));

  const inMemory = createZip([{ name: 'docs/zeros.bin', data: zeros }, { name: 'docs/salad.txt', data: salad }], { date });
  assert.ok(fs.readFileSync(target).equals(inMemory));
});

// ---------------------------------------------------------------------------------------------
// Files are opened without following links and without waiting

test('writeZipFile refuses a link in place of a file, naming it, and writes nothing', async (t) => {
  const dir = makeTempDir(t);
  writeFile(path.join(dir, 'secret.txt'), 'private');
  const link = path.join(dir, 'link.txt');
  try {
    fs.symlinkSync(path.join(dir, 'secret.txt'), link, 'file');
  } catch {
    return t.skip('symbolic links are not available here');
  }
  const before = fs.readdirSync(dir).sort();

  await assert.rejects(
    () => writeZipFile(path.join(dir, 'out.zip'), [{ name: 'docs/link.txt', path: link }], { date }),
    (error) => error instanceof ZipError && error.code === 'unreadableFile' && error.params.name === 'docs/link.txt',
  );
  assert.deepEqual(fs.readdirSync(dir).sort(), before, 'no zip and no temporary file');
});

test('writeZipFile refuses anything that is not a regular file (a folder, a device) without waiting', async (t) => {
  const dir = makeTempDir(t);
  const targets = [dir];
  if (process.platform !== 'win32') targets.push('/dev/null');
  for (const target of targets) {
    await assert.rejects(
      () => writeZipFile(path.join(dir, 'out.zip'), [{ name: 'docs/odd', path: target }], { date }),
      (error) => error instanceof ZipError && error.code === 'unreadableFile',
      target,
    );
  }
  assert.equal(fs.existsSync(path.join(dir, 'out.zip')), false);
});
