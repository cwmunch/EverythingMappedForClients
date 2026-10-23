import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { applyAnswers } from '../../skill/everything-mapped/scripts/lib/index.mjs';
import { main as packMain } from '../../skill/everything-mapped/scripts/pack.mjs';
import { makeTempDir, runCli, snapshot, tryLinkFolder, trySymlink, writeFile, writeFilled } from './helpers.mjs';
import { unzip } from './unzip.mjs';

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
// Noon in the local time zone, so the local date is 2026-10-23 wherever the test runs.
const NOW = new Date(2026, 9, 23, 12, 0, 0);
const ZIP_NAME = 'intake-pack-2026-10-23.zip';
const onPosix = process.platform !== 'win32';
const MB = 1024 * 1024;

// A file that claims to be `bytes` long but takes (almost) no disk space.
function makeSparseFile(filePath, bytes) {
  writeFile(filePath, '');
  fs.truncateSync(filePath, bytes);
}

const BUSINESS = 'We run a family bakery in Aarhus and sell bread and cakes to private customers and cafes.';

// Runs pack.mjs main() with a fixed clock and collects what it prints.
async function runPack(args, { cwd, env = {}, now = NOW } = {}) {
  const out = [];
  const err = [];
  const io = {
    stdout: { write: (text) => out.push(String(text)) },
    stderr: { write: (text) => err.push(String(text)) },
    stdin: process.stdin,
    cwd,
    env,
    now: () => now,
  };
  const code = await packMain(args, io);
  return { code, stdout: out.join(''), stderr: err.join('') };
}

// A pack folder with a few real answers, an asset (also with a non-ASCII name) and an out folder.
function makePack(t, { language = 'en', answers } = {}) {
  const base = makeTempDir(t);
  const root = path.join(base, 'pack');
  const out = path.join(base, 'out');
  fs.mkdirSync(root);
  fs.mkdirSync(out);
  applyAnswers(
    root,
    {
      language,
      respondent: { name: 'Anna Jensen', role: 'Marketing' },
      answers: answers ?? [
        { id: 'A.business', status: 'complete', text: BUSINESS },
        { id: 'A.project-kind', status: 'complete', choice: ['redesign'] },
      ],
    },
    { now: NOW },
  );
  writeFile(path.join(root, 'docs', 'assets', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
  writeFile(path.join(root, 'docs', 'assets', 'Billede æøå.txt'), 'foto\n');
  writeFile(path.join(root, 'DESIGN.md'), 'not part of a pack\n');
  return { base, root, out };
}

// Every file below root/docs as { 'docs/...': Buffer }.
function docsFiles(root) {
  const files = {};
  const walk = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const absolute = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else files[path.relative(root, absolute).split(path.sep).join('/')] = fs.readFileSync(absolute);
    }
  };
  walk(path.join(root, 'docs'));
  return files;
}

test('writes intake-pack-YYYY-MM-DD.zip with the docs tree, and prints its absolute path on its own line', async (t) => {
  const { root, out } = makePack(t);
  const result = await runPack(['--root', root, '--out', out]);

  assert.equal(result.code, 0, result.stderr);
  const zipPath = path.join(out, ZIP_NAME);
  assert.ok(path.isAbsolute(zipPath));
  assert.ok(result.stdout.split('\n').includes(zipPath), 'the absolute path must be a line of its own');
  assert.deepEqual(fs.readdirSync(out), [ZIP_NAME]);

  const entries = unzip(fs.readFileSync(zipPath));
  const expected = docsFiles(root);
  assert.deepEqual([...entries.keys()].sort(), Object.keys(expected).sort());
  for (const [name, data] of Object.entries(expected)) {
    assert.ok(entries.get(name).data.equals(data), `${name} differs`);
  }
  for (const name of [
    'docs/00-brief.md',
    'docs/01-brand/brand.md',
    'docs/intake-manifest.json',
    'docs/intake-state.json',
    'docs/07-risks-and-open-questions.md',
    'docs/assets.md',
    'docs/assets/logo.svg',
    'docs/assets/Billede æøå.txt',
  ]) {
    assert.ok(entries.has(name), `${name} is missing from the zip`);
  }
  assert.ok(![...entries.keys()].some((name) => !name.startsWith('docs/')), 'only the docs tree belongs in the zip');
  assert.ok(![...entries.keys()].some((name) => name.includes('\\')), 'names use forward slashes');
});

test('prints the SHA-256 of the zip, what to send and a size', async (t) => {
  const { root, out } = makePack(t);
  const result = await runPack(['--root', root, '--out', out]);
  const hash = sha256(fs.readFileSync(path.join(out, ZIP_NAME)));

  assert.match(result.stdout, /Send this one file:/);
  assert.ok(result.stdout.includes(hash));
  assert.match(result.stdout, new RegExp(`Made ${ZIP_NAME}: \\d+ files`));
  assert.match(result.stdout, /Questions: \d+ complete/);
});

test('--json prints exactly { zip, sha256, bytes, entries } and nothing else', async (t) => {
  const { root, out } = makePack(t);
  const result = await runPack(['--root', root, '--out', out, '--json']);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  const data = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(data).sort(), ['bytes', 'entries', 'sha256', 'zip']);

  const zipPath = path.join(out, ZIP_NAME);
  const file = fs.readFileSync(zipPath);
  assert.equal(data.zip, zipPath);
  assert.ok(path.isAbsolute(data.zip));
  assert.equal(data.sha256, sha256(file));
  assert.equal(data.bytes, file.length);
  assert.equal(data.entries, Object.keys(docsFiles(root)).length);
  assert.equal(unzip(file).size, data.entries);
});

test('it refreshes the manifest and the open-questions file, and puts the fresh ones in the zip', async (t) => {
  const { root, out } = makePack(t);
  fs.rmSync(path.join(root, 'docs', 'intake-manifest.json'));
  fs.rmSync(path.join(root, 'docs', '07-risks-and-open-questions.md'));

  const result = await runPack(['--root', root, '--out', out]);
  assert.equal(result.code, 0, result.stderr);

  const entries = unzip(fs.readFileSync(path.join(out, ZIP_NAME)));
  const manifest = JSON.parse(entries.get('docs/intake-manifest.json').data.toString('utf8'));
  assert.equal(manifest.schema, 'everything-mapped-for-clients/1');
  assert.equal(manifest.language, 'en');
  assert.ok(manifest.completeness.counts.complete >= 2);
  assert.ok(entries.get('docs/07-risks-and-open-questions.md').data.toString('utf8').includes('<!-- generated:start -->'));
  assert.ok(fs.existsSync(path.join(root, 'docs', 'intake-manifest.json')));
});

test('the same pack on the same day gives the same zip bytes', async (t) => {
  const { root, out } = makePack(t);
  const first = JSON.parse((await runPack(['--root', root, '--out', out, '--json'])).stdout);
  const second = JSON.parse((await runPack(['--root', root, '--out', out, '--json'])).stdout);
  assert.equal(first.sha256, second.sha256);
});

test('the zip entries carry the pack day as their time', async (t) => {
  const { root, out } = makePack(t);
  await runPack(['--root', root, '--out', out]);
  const entry = unzip(fs.readFileSync(path.join(out, ZIP_NAME))).get('docs/00-brief.md');
  assert.equal((entry.dosDate >> 9) + 1980, 2026);
  assert.equal((entry.dosDate >> 5) & 0x0f, 10);
  assert.equal(entry.dosDate & 0x1f, 23);
});

test('a pack with no answers at all is refused with exit 2 and no zip', async (t) => {
  const base = makeTempDir(t);
  const root = path.join(base, 'pack');
  const out = path.join(base, 'out');
  fs.mkdirSync(root);
  fs.mkdirSync(out);

  const nothing = await runPack(['--root', root, '--out', out]);
  assert.equal(nothing.code, 2);
  assert.match(nothing.stderr, /no answers yet/);
  assert.deepEqual(fs.readdirSync(out), []);
  assert.deepEqual(snapshot(root), {}, 'a refused pack must not create files');

  applyAnswers(root, { language: 'en', answers: [] }, { now: NOW });
  const skeleton = await runPack(['--root', root, '--out', out]);
  assert.equal(skeleton.code, 2);
  assert.deepEqual(fs.readdirSync(out), []);
});

test('a pack with only "for later" answers can be sent', async (t) => {
  const { root, out } = makePack(t, {
    answers: [{ id: 'I.domain', status: 'tbd', owner: 'client', due: '2026-11-05', note: 'Ask IT' }],
  });
  const result = await runPack(['--root', root, '--out', out]);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(out, ZIP_NAME)));
});

test('the output folder must exist and must not be inside docs', async (t) => {
  const { base, root } = makePack(t);
  const missing = await runPack(['--root', root, '--out', path.join(base, 'nowhere')]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /does not exist/);
  assert.equal(fs.existsSync(path.join(base, 'nowhere')), false);

  const inside = await runPack(['--root', root, '--out', path.join(root, 'docs', 'assets')]);
  assert.equal(inside.code, 2);
  assert.match(inside.stderr, /outside the docs folder/);
  const insideDocs = await runPack(['--root', root, '--out', path.join(root, 'docs')]);
  assert.equal(insideDocs.code, 2);
  assert.ok(!Object.keys(docsFiles(root)).some((name) => name.endsWith('.zip')));
});

test('without --out the zip goes to the current folder, and --root defaults to it too', async (t) => {
  const { root } = makePack(t);
  const result = await runPack([], { cwd: root });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(root, ZIP_NAME)));

  // The zip is in the pack root, outside docs/, so it is not packed into itself.
  const entries = unzip(fs.readFileSync(path.join(root, ZIP_NAME)));
  assert.ok(![...entries.keys()].some((name) => name.endsWith('.zip')));
});

test('a link inside docs stops the packing with exit 3 and no zip', async (t) => {
  const { base, root, out } = makePack(t);
  const secret = path.join(base, 'secret.txt');
  writeFile(secret, 'private');
  if (!trySymlink(secret, path.join(root, 'docs', 'assets', 'link.txt'), 'file')) return t.skip('symbolic links are not available here');

  const result = await runPack(['--root', root, '--out', out]);
  assert.equal(result.code, 3);
  assert.match(result.stderr, /link\.txt/);
  assert.deepEqual(fs.readdirSync(out), []);
});

test('the texts follow the pack language, and --lang overrides it', async (t) => {
  const { root, out } = makePack(t, { language: 'da' });
  const fromPack = await runPack(['--root', root, '--out', out]);
  assert.match(fromPack.stdout, /Det skal du sende/);
  assert.ok(fromPack.stdout.split('\n').includes(path.join(out, ZIP_NAME)));

  const forced = await runPack(['--root', root, '--out', out, '--lang', 'en']);
  assert.match(forced.stdout, /What to send/);
});

test('--lang changes the messages but never the language of the generated files', async (t) => {
  const { root, out } = makePack(t, { language: 'da' });
  await runPack(['--root', root, '--out', out]);
  const openQuestions = path.join(root, 'docs', '07-risks-and-open-questions.md');
  const before = fs.readFileSync(openQuestions, 'utf8');

  const forced = await runPack(['--root', root, '--out', out, '--lang', 'en']);
  assert.equal(forced.code, 0, forced.stderr);
  assert.equal(fs.readFileSync(openQuestions, 'utf8'), before);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'docs', 'intake-manifest.json'), 'utf8'));
  assert.equal(manifest.language, 'da');
});

test('unknown options, a missing value and extra words are usage errors with exit 2', async (t) => {
  const { root, out } = makePack(t);
  for (const args of [['--bogus'], ['--out'], ['--lang', 'fr'], ['surprise'], ['--json=yes']]) {
    const result = await runPack(['--root', root, '--out', out, ...args]);
    assert.equal(result.code, 2, JSON.stringify(args));
  }
  assert.deepEqual(fs.readdirSync(out), []);
});

test('a large pack prints a warning, in JSON mode on stderr', async (t) => {
  const { root, out } = makePack(t);
  writeFilled(path.join(root, 'docs', 'assets', 'big.bin'), 51, 'random'); // does not shrink: the zip is as large as the file

  const human = await runPack(['--root', root, '--out', out]);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /The pack is 51 MB/);

  const json = await runPack(['--root', root, '--out', out, '--json']);
  assert.match(json.stderr, /The pack is 51 MB/);
  assert.doesNotThrow(() => JSON.parse(json.stdout));
});

test('everything-mapped pack runs the real script through the command line entry', async (t) => {
  const { root, out } = makePack(t);
  const result = await runCli(['pack', '--root', root, '--out', out, '--json']);

  assert.equal(result.code, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.match(path.basename(data.zip), /^intake-pack-\d{4}-\d{2}-\d{2}\.zip$/);
  assert.equal(path.dirname(data.zip), out);
  assert.equal(sha256(fs.readFileSync(data.zip)), data.sha256);
});

// ---------------------------------------------------------------------------------------------
// What goes into the zip, where it may be written, limits, and exit codes

const LAYOUT_FILES = [
  'docs/00-brief.md',
  'docs/01-brand/brand.md',
  'docs/02-audience-and-competitors.md',
  'docs/03-content-inventory.md',
  'docs/04-scope-and-structure.md',
  'docs/05-technical-and-compliance.md',
  'docs/07-risks-and-open-questions.md',
  'docs/assets.md',
  'docs/intake-manifest.json',
  'docs/intake-state.json',
  'docs/assets/Billede æøå.txt',
  'docs/assets/logo.svg',
];

test('only the section 3 layout goes into the zip; everything else is skipped and named', async (t) => {
  const { root, out } = makePack(t);
  const extras = [
    'docs/06-decisions.md',
    'docs/.hidden-note',
    'docs/assets/.DS_Store',
    'docs/07-risks-and-open-questions.md.4711.tmp',
    'docs/assets/leftover.tmp',
    'docs/assets/UPPER.TMP',
    'docs/notes/other.txt',
    'docs/01-brand/extra.md',
    'docs/.git/config',
    'docs/.cache/deep/file.txt',
  ];
  for (const name of extras) writeFile(path.join(root, ...name.split('/')), 'not for the pack');

  const result = await runPack(['--root', root, '--out', out]);
  assert.equal(result.code, 0, result.stderr);

  const entries = unzip(fs.readFileSync(path.join(out, ZIP_NAME)));
  assert.deepEqual([...entries.keys()].sort(), [...LAYOUT_FILES].sort());

  const printed = result.stdout.split('\n');
  for (const name of LAYOUT_FILES) assert.ok(printed.includes(`  ${name}`), `${name} must be printed as part of the zip`);
  const skipped = ['docs/06-decisions.md', 'docs/.hidden-note', 'docs/assets/.DS_Store', 'docs/07-risks-and-open-questions.md.4711.tmp', 'docs/assets/leftover.tmp', 'docs/assets/UPPER.TMP', 'docs/notes/other.txt', 'docs/01-brand/extra.md', 'docs/.git/', 'docs/.cache/'];
  for (const name of skipped) assert.ok(printed.includes(`Not put in the zip file: ${name}`), `${name} must be named as skipped`);
  assert.ok(!printed.some((line) => line.includes('Not put in the zip file') && LAYOUT_FILES.some((name) => line.endsWith(name))));
});

test('in --json mode the skipped files are named on stderr and stdout stays one JSON document', async (t) => {
  const { root, out } = makePack(t);
  writeFile(path.join(root, 'docs', '06-decisions.md'), 'internal');
  const result = await runPack(['--root', root, '--out', out, '--json']);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /Not put in the zip file: docs\/06-decisions\.md/);
  assert.equal(JSON.parse(result.stdout).entries, LAYOUT_FILES.length);
});

test('a link outside the layout is skipped and never followed; a link in the layout stops the packing', async (t) => {
  const { base, root, out } = makePack(t);
  const secret = path.join(base, 'secret.txt');
  writeFile(secret, 'TOP-SECRET-MARKER');
  if (!trySymlink(secret, path.join(root, 'docs', 'sneaky.txt'), 'file')) return t.skip('symbolic links are not available here');

  const skippedLink = await runPack(['--root', root, '--out', out]);
  assert.equal(skippedLink.code, 0, skippedLink.stderr);
  assert.match(skippedLink.stdout, /Not put in the zip file: docs\/sneaky\.txt/);
  const entries = unzip(fs.readFileSync(path.join(out, ZIP_NAME)));
  assert.ok(![...entries.values()].some((entry) => entry.data.toString().includes('TOP-SECRET-MARKER')));

  fs.rmSync(path.join(root, 'docs', 'assets', 'logo.svg'));
  trySymlink(secret, path.join(root, 'docs', 'assets', 'logo.svg'), 'file');
  fs.rmSync(path.join(out, ZIP_NAME));
  const stopped = await runPack(['--root', root, '--out', out]);
  assert.equal(stopped.code, 3);
  assert.deepEqual(fs.readdirSync(out), []);
});

test('--out is compared by real path: a link that leads into docs/ is refused', async (t) => {
  const { base, root } = makePack(t);
  const linkToAssets = path.join(base, 'outlink');
  const linkToDocs = path.join(base, 'docslink');
  if (!tryLinkFolder(path.join(root, 'docs', 'assets'), linkToAssets)) return t.skip('links are not available here');
  tryLinkFolder(path.join(root, 'docs'), linkToDocs);
  const before = snapshot(path.join(root, 'docs'));

  for (const link of [linkToAssets, linkToDocs]) {
    const result = await runPack(['--root', root, '--out', link]);
    assert.equal(result.code, 2, link);
    assert.match(result.stderr, /outside the docs folder/);
  }
  assert.deepEqual(snapshot(path.join(root, 'docs')), before, 'no zip may appear in docs/');
});

test('a single file above 500 MB is refused before any file is read', { skip: !onPosix || process.getuid?.() === 0 }, async (t) => {
  const { root, out } = makePack(t);
  const big = path.join(root, 'docs', 'assets', 'huge.bin');
  makeSparseFile(big, 501 * MB);
  fs.chmodSync(big, 0o000); // reading it would fail with a different error, so the limit message proves nothing was read
  t.after(() => {
    if (fs.existsSync(big)) fs.chmodSync(big, 0o644);
  });

  const result = await runPack(['--root', root, '--out', out]);
  assert.equal(result.code, 3);
  assert.match(result.stderr, /docs\/assets\/huge\.bin is 501 MB\. Files above 500 MB cannot be put in the pack/);
  assert.deepEqual(fs.readdirSync(out), []);
});

test('a pack above 500 MB in total is refused with the limit in the message', async (t) => {
  const { root, out } = makePack(t);
  for (const name of ['a.bin', 'b.bin', 'c.bin']) makeSparseFile(path.join(root, 'docs', 'assets', name), 200 * MB);

  const result = await runPack(['--root', root, '--out', out]);
  assert.equal(result.code, 3);
  assert.match(result.stderr, /add up to 600 MB\. The limit is 500 MB/);
  assert.deepEqual(fs.readdirSync(out), []);
});

test('a pack with more than 5000 files is refused', async (t) => {
  const { root, out } = makePack(t);
  for (let i = 0; i < 5000; i += 1) fs.writeFileSync(path.join(root, 'docs', 'assets', `f${i}.txt`), 'x');

  const result = await runPack(['--root', root, '--out', out]);
  assert.equal(result.code, 3);
  assert.match(result.stderr, /The pack has 5012 files\. The limit is 5000/);
  assert.deepEqual(fs.readdirSync(out), []);
});

test('the size warning is about the zip, not about the files before they are zipped', async (t) => {
  const { root, out } = makePack(t);
  writeFilled(path.join(root, 'docs', 'assets', 'text.txt'), 52, 'text'); // 52 MB of text, a few MB as a zip

  const human = await runPack(['--root', root, '--out', out]);
  assert.equal(human.code, 0, human.stderr);
  assert.doesNotMatch(human.stdout, /Many e-mail services refuse/, 'the zip is small, so there is no warning');
  const sizeOfZip = fs.statSync(path.join(out, ZIP_NAME)).size;
  assert.ok(sizeOfZip < 20 * MB, `the zip is ${sizeOfZip} bytes`);

  const json = await runPack(['--root', root, '--out', out, '--json']);
  assert.doesNotMatch(json.stderr, /Many e-mail services refuse/);
});

test('a file that would shrink by more than 200 to 1 is stored, so the zip never holds an entry the receiving tools refuse', async (t) => {
  const { root, out } = makePack(t);
  writeFilled(path.join(root, 'docs', 'assets', 'zeros.bin'), 2, 'zeros');
  const result = await runPack(['--root', root, '--out', out]);
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /200 to 1/, 'there is no ratio warning any more');

  const entries = unzip(fs.readFileSync(path.join(out, ZIP_NAME)));
  assert.equal(entries.get('docs/assets/zeros.bin').method, 0);
  assert.equal(entries.get('docs/assets/zeros.bin').data.length, 2 * MB);
  for (const [name, entry] of entries) {
    if (entry.method === 8) assert.ok(entry.data.length <= entry.compressedSize * 200, `${name} is over the ratio limit`);
  }
});

test('a zip that cannot be written exits 3', { skip: !onPosix || process.getuid?.() === 0 }, async (t) => {
  const { base, root } = makePack(t);
  const readOnly = path.join(base, 'read-only');
  fs.mkdirSync(readOnly);
  fs.chmodSync(readOnly, 0o555);
  t.after(() => {
    if (fs.existsSync(readOnly)) fs.chmodSync(readOnly, 0o755);
  });

  const result = await runPack(['--root', root, '--out', readOnly]);
  assert.equal(result.code, 3);
  assert.match(result.stderr, /Could not write the zip file/);
  assert.deepEqual(fs.readdirSync(readOnly), []);
});

test('a name the zip cannot hold exits 3, like a failed write', async (t) => {
  const { root, out } = makePack(t);
  writeFile(path.join(root, 'docs', 'assets', 'CON.txt'), 'device name');
  const result = await runPack(['--root', root, '--out', out]);
  assert.equal(result.code, 3);
  assert.match(result.stderr, /CON\.txt/);
  assert.deepEqual(fs.readdirSync(out), []);
});

test('a pack whose only answer is outside the depth in use still counts as having answers', async (t) => {
  const { root, out } = makePack(t, {
    answers: [{ id: 'J.anything-else', status: 'complete', text: 'Nothing else to add.' }],
  });
  const result = await runPack(['--root', root, '--out', out]);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(out, ZIP_NAME)));
});

test('a pack where every question is still missing is refused, whatever the depth', async (t) => {
  const base = makeTempDir(t);
  const root = path.join(base, 'pack');
  const out = path.join(base, 'out');
  fs.mkdirSync(root);
  fs.mkdirSync(out);
  applyAnswers(root, { language: 'en', depth: 'essentials', answers: [] }, { now: NOW });
  const result = await runPack(['--root', root, '--out', out]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /no answers yet/);
});

// ---------------------------------------------------------------------------------------------
// Terminal safety: nothing from the pack is printed raw

const ESC = String.fromCharCode(27);
const ESC_MARKER = '<U+001B>'; // how a file name shows the ESC character, here and in check

// Writes a file whose name holds an escape sequence; false where the file system does not allow that name.
function writeHostile(filePath) {
  try {
    writeFile(filePath, 'x');
    return true;
  } catch {
    return false;
  }
}

test('a skipped file name with an escape sequence is shown safely, in both output modes', async (t) => {
  const { root, out } = makePack(t);
  if (!writeHostile(path.join(root, 'docs', `other${ESC}[2Jname.txt`))) return t.skip('this file system does not allow control characters in names');

  const human = await runPack(['--root', root, '--out', out]);
  assert.equal(human.code, 0, human.stderr);
  assert.ok(!human.stdout.includes(ESC) && !human.stderr.includes(ESC), 'no raw ESC may reach the terminal');
  assert.ok(human.stdout.includes(`Not put in the zip file: docs/other${ESC_MARKER}[2Jname.txt`));

  const json = await runPack(['--root', root, '--out', out, '--json']);
  assert.ok(!json.stdout.includes(ESC) && !json.stderr.includes(ESC));
  assert.ok(json.stderr.includes(ESC_MARKER));
  assert.doesNotThrow(() => JSON.parse(json.stdout));
});

test('an error that names a file with an escape sequence is shown safely', async (t) => {
  const { root, out } = makePack(t);
  if (!writeHostile(path.join(root, 'docs', 'assets', `asset${ESC}[2Jname.txt`))) return t.skip('this file system does not allow control characters in names');

  const result = await runPack(['--root', root, '--out', out]);
  assert.equal(result.code, 3);
  assert.ok(!result.stdout.includes(ESC) && !result.stderr.includes(ESC), 'no raw ESC may reach the terminal');
  assert.ok(result.stderr.includes(ESC_MARKER));
  assert.deepEqual(fs.readdirSync(out), []);
});

test('a link in the pack with an escape sequence in its name is shown safely (exit 3)', async (t) => {
  const { base, root, out } = makePack(t);
  const target = path.join(base, 'target.txt');
  writeFile(target, 'x');
  const link = path.join(root, 'docs', 'assets', `link${ESC}[2J.txt`);
  let linked = false;
  try {
    linked = trySymlink(target, link, 'file');
  } catch {
    linked = false;
  }
  if (!linked) return t.skip('links, or control characters in names, are not available here');

  const result = await runPack(['--root', root, '--out', out]);
  assert.equal(result.code, 3);
  assert.ok(!result.stdout.includes(ESC) && !result.stderr.includes(ESC));
  assert.ok(result.stderr.includes(ESC_MARKER));
});

// ---------------------------------------------------------------------------------------------
// Linked folders, name length, JSON output

test('a linked docs/assets stops the packing before anything is listed or written (exit 3)', async (t) => {
  const { root, out } = makePack(t);
  fs.renameSync(path.join(root, 'docs', 'assets'), path.join(root, 'real-assets'));
  if (!tryLinkFolder(path.join(root, 'real-assets'), path.join(root, 'docs', 'assets'))) return t.skip('links are not available here');
  const before = snapshot(root);

  for (const args of [[], ['--json']]) {
    const result = await runPack(['--root', root, '--out', out, ...args]);
    assert.equal(result.code, 3, args.join(' '));
    assert.match(result.stderr, /docs\/assets is a (symbolic )?link/);
    assert.doesNotMatch(result.stdout + result.stderr, /Not put in the zip file/, 'nothing is listed first');
  }
  assert.deepEqual(fs.readdirSync(out), []);
  assert.deepEqual(snapshot(root), before, 'not even the manifest is rewritten');
});

test('a linked docs folder stops the packing the same way (exit 3)', async (t) => {
  const { base, root, out } = makePack(t);
  const real = path.join(base, 'real-docs');
  fs.renameSync(path.join(root, 'docs'), real);
  if (!tryLinkFolder(real, path.join(root, 'docs'))) return t.skip('links are not available here');

  const result = await runPack(['--root', root, '--out', out]);
  assert.equal(result.code, 3, result.stderr);
  assert.deepEqual(fs.readdirSync(out), []);
});

test('a path part over 255 bytes or a path over 240 characters is refused before anything is written (exit 3)', async (t) => {
  const { root, out } = makePack(t);
  const longName = `${'x'.repeat(236)}.txt`; // docs/assets/ + this is more than 240 characters
  writeFile(path.join(root, 'docs', 'assets', longName), 'x');
  const before = snapshot(root);

  const result = await runPack(['--root', root, '--out', out]);
  assert.equal(result.code, 3);
  assert.match(result.stderr, /Some files cannot be put in the zip file\. Rename or remove them/);
  assert.ok(result.stderr.includes(`- docs/assets/${longName}: the path is longer than 240 characters`), 'the file is named with the reason');
  assert.deepEqual(fs.readdirSync(out), []);
  assert.deepEqual(snapshot(root), before, 'nothing in the pack is rewritten either');
});

test('--json is written with stringifyJson: control characters in the path are escaped', async (t) => {
  const { base, root } = makePack(t);
  const c1 = String.fromCodePoint(0x85);
  const out = path.join(base, `out${c1}dir`);
  try {
    fs.mkdirSync(out);
  } catch {
    return t.skip('this file system does not allow control characters in names');
  }

  const result = await runPack(['--root', root, '--out', out, '--json']);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(!result.stdout.includes(c1), 'no raw control character in the JSON text');
  assert.match(result.stdout, /\\u0085/);
  assert.equal(JSON.parse(result.stdout).zip, path.join(out, ZIP_NAME));
});

test('the zip is written under a temporary name and only the finished file is left', async (t) => {
  const { root, out } = makePack(t);
  writeFile(path.join(out, '.intake-pack-2026-10-23.zip.keep.tmp'), 'not ours');
  const result = await runPack(['--root', root, '--out', out]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(fs.readdirSync(out).sort(), ['.intake-pack-2026-10-23.zip.keep.tmp', ZIP_NAME].sort());
  assert.equal(fs.readFileSync(path.join(out, '.intake-pack-2026-10-23.zip.keep.tmp'), 'utf8'), 'not ours');
});

// ---------------------------------------------------------------------------------------------
// Every name the zip would refuse is listed at once

test('all offending names are listed in one run, each with its reason, before anything is written (exit 3)', async (t) => {
  const { root, out } = makePack(t);
  const assets = path.join(root, 'docs', 'assets');
  const esc = String.fromCharCode(27);
  const longName = `${'y'.repeat(236)}.txt`;
  const hostile = ['a<b.png', '>lead.png', `esc${esc}[31m.png`, 'CON.txt', 'trailing.', 'Dup.txt', 'dup.txt', 'Logo', 'logo/x.png', longName];
  for (const name of hostile) writeFile(path.join(assets, ...name.split('/')), 'x');
  let invalidCreated = true;
  try {
    fs.writeFileSync(Buffer.concat([Buffer.from(`${assets}${path.sep}lat`), Buffer.from([0xe9]), Buffer.from('.png')]), 'x');
  } catch {
    invalidCreated = false; // this file system does not allow names that are not valid UTF-8
  }
  const generated = ['intake-manifest.json', '07-risks-and-open-questions.md'].map((name) => path.join(root, 'docs', name));
  const before = generated.map((file) => fs.readFileSync(file, 'utf8'));

  const result = await runPack(['--root', root, '--out', out]);
  assert.equal(result.code, 3, result.stderr);
  assert.match(result.stderr, /Some files cannot be put in the zip file\. Rename or remove them and try again:/);
  const lines = result.stderr.split('\n');
  const expected = [
    '- docs/assets/a<b.png: the name contains a character that is not allowed on every system',
    '- docs/assets/>lead.png: the name contains a character that is not allowed on every system',
    '- docs/assets/esc<U+001B>[31m.png: the name contains a character that is not allowed on every system',
    '- docs/assets/CON.txt: the name is reserved on Windows',
    '- docs/assets/trailing.: the name ends with a dot or a space',
    '- docs/assets/dup.txt: the name differs from docs/assets/Dup.txt only in case or in how an accent is written',
    '- docs/assets/Logo: the name is also the name of a folder that holds docs/assets/logo/x.png',
    `- docs/assets/${longName}: the path is longer than 240 characters`,
  ];
  if (invalidCreated) expected.push('- docs/assets/lat<0xE9>.png: the name is not valid text');
  for (const line of expected) assert.ok(lines.some((candidate) => candidate.startsWith(line)), `missing: ${line}`);
  assert.ok(!result.stderr.includes(esc), 'no raw ESC reaches the terminal');

  assert.deepEqual(fs.readdirSync(out), [], 'no zip and no temporary file');
  assert.deepEqual(generated.map((file) => fs.readFileSync(file, 'utf8')), before, 'the pack is not rewritten either');
});

test('a name with a reason on its own is listed with that reason (exit 3), and fine names do not appear', async (t) => {
  const { root, out } = makePack(t);
  writeFile(path.join(root, 'docs', 'assets', 'nul.png'), 'x');
  const result = await runPack(['--root', root, '--out', out]);
  assert.equal(result.code, 3);
  assert.ok(result.stderr.includes('- docs/assets/nul.png: the name is reserved on Windows'));
  assert.ok(!result.stderr.includes('logo.svg'));
});

test('a file and a folder with the same name (ignoring case) clash even when both names are fine alone', async (t) => {
  const { root, out } = makePack(t);
  writeFile(path.join(root, 'docs', 'assets', 'Photos'), 'a file');
  writeFile(path.join(root, 'docs', 'assets', 'photos', 'one.jpg'), 'x');
  const result = await runPack(['--root', root, '--out', out]);
  assert.equal(result.code, 3);
  assert.ok(result.stderr.includes('- docs/assets/Photos: the name is also the name of a folder that holds docs/assets/photos/one.jpg'));
  assert.deepEqual(fs.readdirSync(out), []);
});

test('a name that is not valid UTF-8 outside docs/assets is only skipped, and shown with markers', async (t) => {
  const { root, out } = makePack(t);
  try {
    fs.writeFileSync(Buffer.concat([Buffer.from(`${path.join(root, 'docs')}${path.sep}notes-`), Buffer.from([0xe9]), Buffer.from('.txt')]), 'x');
  } catch {
    return t.skip('this file system does not allow names that are not valid UTF-8');
  }
  const result = await runPack(['--root', root, '--out', out]);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stdout.includes('Not put in the zip file: docs/notes-<0xE9>.txt'));
});

test('file names are shown with <U+XXXX> markers everywhere, the same way check shows them', async (t) => {
  const { root, out } = makePack(t);
  const esc = String.fromCharCode(27);
  if (!writeHostile(path.join(root, 'docs', `other${esc}.txt`))) return t.skip('this file system does not allow control characters in names');
  const result = await runPack(['--root', root, '--out', out]);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stdout.includes('Not put in the zip file: docs/other<U+001B>.txt'));
  assert.ok(!/[\u2400-\u243f]/.test(result.stdout), 'no control pictures: one display only');
});
