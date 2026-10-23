// Packing streams every file into the zip in chunks, so the memory used must not grow with the size
// of the pack. This is its own test file because `node --test` runs each file in its own process,
// and the peak memory of that process (process.resourceUsage().maxRSS) is what is measured.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { applyAnswers } from '../../skill/everything-mapped/scripts/lib/index.mjs';
import { main as packMain } from '../../skill/everything-mapped/scripts/pack.mjs';
import { makeTempDir, writeFile } from './helpers.mjs';
import { unzip } from './unzip.mjs';

const MB = 1024 * 1024;
const NOW = new Date(2026, 9, 23, 12, 0, 0);

// Peak resident memory of this process so far, in bytes (the value is in kilobytes).
const peakBytes = () => process.resourceUsage().maxRSS * 1024;

function writeBigFile(filePath, bytes, kind) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fs.openSync(filePath, 'w');
  try {
    const piece = kind === 'text' ? Buffer.alloc(MB, 'Det her er en lang linje om bageriet og kagerne. ') : crypto.randomBytes(MB);
    for (let written = 0; written < bytes; written += MB) fs.writeSync(fd, piece);
  } finally {
    fs.closeSync(fd);
  }
}

test('a 100 MB pack is made without holding the pack in memory', async (t) => {
  const base = makeTempDir(t);
  const root = path.join(base, 'pack');
  const out = path.join(base, 'out');
  fs.mkdirSync(root);
  fs.mkdirSync(out);
  applyAnswers(
    root,
    { language: 'en', answers: [{ id: 'A.business', status: 'complete', text: 'We run a family bakery in Aarhus and sell bread and cakes to private customers and cafes.' }] },
    { now: NOW },
  );
  for (let i = 0; i < 10; i += 1) {
    writeBigFile(path.join(root, 'docs', 'assets', `file-${i}.bin`), 10 * MB, i % 2 === 0 ? 'text' : 'random');
  }
  writeFile(path.join(root, 'docs', 'assets', 'small.txt'), 'x');

  const stdout = [];
  const io = {
    stdout: { write: (text) => stdout.push(String(text)) },
    stderr: { write: () => true },
    stdin: process.stdin,
    env: {},
    now: () => NOW,
  };
  const before = peakBytes();
  const code = await packMain(['--root', root, '--out', out, '--json'], io);
  const growth = peakBytes() - before;

  assert.equal(code, 0);
  const result = JSON.parse(stdout.join(''));
  const entries = unzip(fs.readFileSync(result.zip));
  assert.equal(entries.size, result.entries);
  for (let i = 0; i < 10; i += 1) assert.equal(entries.get(`docs/assets/file-${i}.bin`).data.length, 10 * MB);

  // Holding the pack in memory costs at least 3 times its size (the files, the zip, the zip read back).
  assert.ok(growth < 100 * MB * 1.5, `the peak memory grew by ${Math.round(growth / MB)} MB while packing 100 MB`);
});
