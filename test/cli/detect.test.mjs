import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { detectTools, findOnPath } from '../../cli/detect.mjs';
import { fakeExecutable, makeTempDir, writeFile } from './helpers.mjs';

const onPosix = process.platform !== 'win32';
// The file name a tool has on this machine.
const exe = (name) => (onPosix ? name : `${name}.exe`);

test('finds claude and codex in the folders on a fake PATH', (t) => {
  const first = makeTempDir(t, 'first');
  const second = makeTempDir(t, 'second');
  fakeExecutable(path.join(first, exe('claude')));
  fakeExecutable(path.join(second, exe('codex')));
  const env = { PATH: [first, second].join(path.delimiter) };

  const found = detectTools({ env, platform: process.platform });
  assert.equal(found.claude, path.join(first, exe('claude')));
  assert.equal(found.codex, path.join(second, exe('codex')));
});

test('reports null for a tool that is not on PATH', (t) => {
  const folder = makeTempDir(t);
  fakeExecutable(path.join(folder, exe('codex')));
  const found = detectTools({ env: { PATH: folder }, platform: process.platform });
  assert.equal(found.claude, null);
  assert.equal(found.codex, path.join(folder, exe('codex')));
});

test('an empty or missing PATH finds nothing', () => {
  assert.deepEqual(detectTools({ env: { PATH: '' }, platform: process.platform }), { claude: null, codex: null });
  assert.deepEqual(detectTools({ env: {}, platform: process.platform }), { claude: null, codex: null });
});

test('the first folder on PATH wins', (t) => {
  const first = makeTempDir(t, 'first');
  const second = makeTempDir(t, 'second');
  fakeExecutable(path.join(first, exe('claude')));
  fakeExecutable(path.join(second, exe('claude')));
  const found = findOnPath('claude', { env: { PATH: [first, second].join(path.delimiter) }, platform: process.platform });
  assert.equal(found, path.join(first, exe('claude')));
});

test('a folder named like the tool is not the tool', (t) => {
  const folder = makeTempDir(t);
  fs.mkdirSync(path.join(folder, exe('claude')));
  assert.equal(findOnPath('claude', { env: { PATH: folder }, platform: process.platform }), null);
});

test('a relative PATH entry is ignored', (t) => {
  const folder = makeTempDir(t);
  fakeExecutable(path.join(folder, exe('claude')));
  const relative = path.relative(process.cwd(), folder);
  assert.equal(findOnPath('claude', { env: { PATH: `.${path.delimiter}${relative}` }, platform: process.platform }), null);
});

test('a file without execute permission is not found (not on Windows)', { skip: !onPosix }, (t) => {
  const folder = makeTempDir(t);
  writeFile(path.join(folder, 'claude'), 'not executable');
  fs.chmodSync(path.join(folder, 'claude'), 0o644);
  assert.equal(findOnPath('claude', { env: { PATH: folder }, platform: 'linux' }), null);
});

test('on Windows the .exe, .cmd and .bat variants are tried and a bare name is not', (t) => {
  const folder = makeTempDir(t);
  writeFile(path.join(folder, 'claude.cmd'), '@echo off\n');
  writeFile(path.join(folder, 'codex.exe'), 'MZ');
  writeFile(path.join(folder, 'claude.txt'), 'nope');
  const found = detectTools({ env: { PATH: folder }, platform: 'win32' });
  assert.equal(found.claude, path.join(folder, 'claude.cmd'));
  assert.equal(found.codex, path.join(folder, 'codex.exe'));

  const bare = makeTempDir(t, 'bare');
  writeFile(path.join(bare, 'claude'), 'no extension');
  assert.equal(findOnPath('claude', { env: { PATH: bare }, platform: 'win32' }), null);

  const batch = makeTempDir(t, 'batch');
  writeFile(path.join(batch, 'codex.bat'), '@echo off\n');
  assert.equal(findOnPath('codex', { env: { PATH: batch }, platform: 'win32' }), path.join(batch, 'codex.bat'));
});

test('on Windows the variable may be called Path and entries may be quoted', (t) => {
  const folder = makeTempDir(t);
  writeFile(path.join(folder, 'claude.exe'), 'MZ');
  const found = findOnPath('claude', { env: { Path: `"${folder}"` }, platform: 'win32' });
  assert.equal(found, path.join(folder, 'claude.exe'));
});

test('detection starts no process: the module does not import child_process', () => {
  const source = fs.readFileSync(new URL('../../cli/detect.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /child_process/);
});
