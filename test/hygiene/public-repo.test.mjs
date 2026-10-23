// Guards the rules for this public repository so they cannot drift after a later edit:
// no e-mail addresses, no "gate" wording a client could read, no em dashes or exclamation marks in
// visible strings, one version number, and a package manifest without install-time code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const TEXT_EXT = new Set(['.md', '.json', '.mjs', '.js', '.css', '.html', '.yaml', '.yml', '.txt']);
const SELF = path.join('test', 'hygiene', 'public-repo.test.mjs');

function listFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, out);
    else if (entry.isFile() && TEXT_EXT.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

const files = listFiles(ROOT).map((full) => ({ full, rel: path.relative(ROOT, full) }))
  .filter((f) => f.rel !== SELF);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('no e-mail addresses in the repository', () => {
  const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/;
  const hits = files.filter((f) => email.test(fs.readFileSync(f.full, 'utf8'))).map((f) => f.rel);
  assert.deepEqual(hits, []);
});

test('visible strings in the dictionaries have no "gate", em dash, en dash or exclamation mark', () => {
  const schemaDir = path.join(ROOT, 'skill', 'everything-mapped', 'schema');
  const problems = [];
  for (const name of fs.readdirSync(schemaDir).filter((n) => /\.(da|en)\.json$/.test(n))) {
    const dict = JSON.parse(fs.readFileSync(path.join(schemaDir, name), 'utf8'));
    for (const [key, value] of Object.entries(dict)) {
      if (typeof value !== 'string') continue;
      if (/\bgate\b/i.test(value)) problems.push(`${name} ${key}: gate`);
      if (/[–—]/.test(value)) problems.push(`${name} ${key}: dash`);
      if (value.includes('!')) problems.push(`${name} ${key}: exclamation mark`);
    }
  }
  assert.deepEqual(problems, []);
});

test('the README, guides and changelog never say "gate" and use no em dashes', () => {
  const docs = ['README.md', 'CHANGELOG.md', path.join('docs', 'GUIDE.en.md'), path.join('docs', 'GUIDE.da.md')];
  const problems = [];
  for (const rel of docs) {
    const text = read(rel);
    if (/\bgate\b/i.test(text)) problems.push(`${rel}: gate`);
    if (/—/.test(text)) problems.push(`${rel}: em dash`);
  }
  assert.deepEqual(problems, []);
});

test('the tool version in the manifest module equals package.json', () => {
  const pkg = JSON.parse(read('package.json'));
  const manifest = read(path.join('skill', 'everything-mapped', 'scripts', 'lib', 'manifest.mjs'));
  const match = manifest.match(/TOOL_VERSION\s*=\s*['"]([^'"]+)['"]/);
  assert.ok(match, 'TOOL_VERSION not found');
  assert.equal(match[1], pkg.version);
});

test('package.json has no dependencies, no install-time scripts, one bin and the right Node floor', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.private, undefined, 'the package must not be private');
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    assert.equal(pkg[field], undefined, field);
  }
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly']) {
    assert.equal(pkg.scripts?.[hook], undefined, hook);
  }
  assert.equal(Object.keys(pkg.bin).length, 1);
  const floor = pkg.engines.node.match(/(\d+)\.(\d+)/);
  assert.ok(floor, 'engines.node must name a minimum');
  assert.ok(Number(floor[1]) > 22 || (Number(floor[1]) === 22 && Number(floor[2]) >= 2), 'zlib.crc32 needs Node 22.2');
  for (const entry of ['bin', 'cli', 'skill', 'docs', 'README.md', 'CHANGELOG.md']) {
    assert.ok(pkg.files.includes(entry), `files must include ${entry}`);
  }
});

test('no shipped file uses the network, child processes, eval or dynamic import', () => {
  // A dynamic import is fine only with a fixed string literal (the CLI's table of script paths).
  const risky = /\bchild_process\b|\bnode:(http|https|net|tls|dgram|dns)\b|\beval\s*\(|new Function\s*\(|\bimport\s*\(\s*[^'"\s]/;
  const hits = [];
  for (const f of files) {
    if (!f.rel.endsWith('.mjs') && !f.rel.endsWith('.js')) continue;
    if (f.rel.startsWith('test' + path.sep)) continue;
    const text = fs.readFileSync(f.full, 'utf8');
    text.split('\n').forEach((line, i) => {
      if (risky.test(line) && !line.trim().startsWith('//')) hits.push(`${f.rel}:${i + 1}: ${line.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(hits, []);
});
