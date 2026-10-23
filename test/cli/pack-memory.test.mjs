// Packing streams every file into the zip in chunks, so the memory used must not grow with the size
// of the pack. This is its own test file because `node --test` runs each file in its own process,
// and the peak memory of that process (process.resourceUsage().maxRSS) is what is measured.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyAnswers } from '../../skill/everything-mapped/scripts/lib/index.mjs';
import { main as packMain } from '../../skill/everything-mapped/scripts/pack.mjs';
import { makeTempDir, writeFile, writeFilled } from './helpers.mjs';
import { unzip } from './unzip.mjs';

const MB = 1024 * 1024;
const NOW = new Date(2026, 9, 23, 12, 0, 0);

// Peak resident memory of this process so far, in bytes (the value is in kilobytes).
const peakBytes = () => process.resourceUsage().maxRSS * 1024;

const ENOUGH_FREE_MEMORY = 3 * 1024 * MB;

test('a 50 MB pack is made without holding the pack in memory', { skip: os.freemem() < ENOUGH_FREE_MEMORY && 'less than 3 GB of free memory: the measurement would be unreliable' }, async (t) => {
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
  for (let i = 0; i < 5; i += 1) {
    writeFilled(path.join(root, 'docs', 'assets', `file-${i}.bin`), 10, i % 2 === 0 ? 'text' : 'random');
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
  for (let i = 0; i < 5; i += 1) assert.equal(entries.get(`docs/assets/file-${i}.bin`).data.length, 10 * MB);

  // Holding the pack in memory costs at least 3 times its size (the files, the zip, the zip read back),
  // so 150 MB for this pack. Streaming costs a fixed amount, whatever the size of the pack.
  assert.ok(growth < 50 * MB * 1.5, `the peak memory grew by ${Math.round(growth / MB)} MB while packing 50 MB`);
});
