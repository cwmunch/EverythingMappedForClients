// Shared helpers for the command line tests. This file has no tests of its own.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { defaultContext, main } from '../../bin/cli.mjs';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

// A temporary folder that is removed when the test (or suite) ends.
export function makeTempDir(t, label = 'work') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'emfc-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sub = path.join(dir, label);
  fs.mkdirSync(sub);
  return sub;
}

export function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

// A small stand-in for skill/everything-mapped/, with a nested folder and a non-ASCII file name.
export function makeSkillSource(dir) {
  const source = path.join(dir, 'skill-source');
  writeFile(path.join(source, 'SKILL.md'), '---\nname: everything-mapped\n---\n# Test skill\n');
  writeFile(path.join(source, 'schema', 'intake-schema.json'), '{"schema":"test"}\n');
  writeFile(path.join(source, 'scripts', 'lib', 'util.mjs'), 'export const one = 1;\n');
  writeFile(path.join(source, 'scripts', 'check.mjs'), 'export async function main() { return 0; }\n');
  writeFile(path.join(source, 'references', 'æøå.md'), 'Indhold med æøå\n');
  return source;
}

// Every file below dir as { relative path with /: content }, for comparing before and after.
export function snapshot(dir) {
  const result = {};
  const walk = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const absolute = path.join(folder, entry.name);
      const relative = path.relative(dir, absolute).split(path.sep).join('/');
      if (entry.isSymbolicLink()) {
        result[relative] = `link:${fs.readlinkSync(absolute)}`;
      } else if (entry.isDirectory()) {
        result[`${relative}/`] = 'dir';
        walk(absolute);
      } else {
        result[relative] = fs.readFileSync(absolute).toString('base64');
      }
    }
  };
  walk(dir);
  return result;
}

export const RECORD_NAME = '.everything-mapped-install.json';

// Like snapshot(), but without the install record, so an installed folder can be compared with its source.
export function installedSnapshot(dir) {
  const result = snapshot(dir);
  delete result[RECORD_NAME];
  return result;
}

export function fakeExecutable(filePath) {
  writeFile(filePath, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(filePath, 0o755);
}

// io for main(): collects what is written; stdin can be a typed answer and can pretend to be a terminal.
export function makeIo({ stdin = '', tty = false, onStdout = () => {} } = {}) {
  const out = [];
  const err = [];
  const input = Readable.from(stdin === '' ? [] : [stdin]);
  input.isTTY = tty;
  return {
    io: {
      stdout: {
        write(text) {
          out.push(String(text));
          onStdout(String(text));
          return true;
        },
      },
      stderr: {
        write(text) {
          err.push(String(text));
          return true;
        },
      },
      stdin: input,
    },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

// Runs the real command line entry with a controlled environment.
// options: cwd, env, sourceDir, platform, stdin, tty, loadScript, hooks, onStdout
export async function runCli(args, options = {}) {
  const { io, stdout, stderr } = makeIo(options);
  const context = {
    ...defaultContext(),
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? { PATH: '' },
    platform: options.platform ?? process.platform,
  };
  if (options.sourceDir) context.sourceDir = options.sourceDir;
  if (options.loadScript) context.loadScript = options.loadScript;
  if (options.hooks) context.hooks = options.hooks;
  const code = await main(args, io, context);
  return { code, stdout: stdout(), stderr: stderr() };
}

// Runs fn with HOME and USERPROFILE pointing at home, and puts the old values back afterwards.
export async function withHome(home, fn) {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await fn();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

// A link to a folder: a symbolic link on Linux and macOS, a junction on Windows (no extra rights needed there).
export function tryLinkFolder(target, linkPath) {
  return trySymlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

// Symbolic links need extra rights on Windows; returns false when they cannot be made.
export function trySymlink(target, linkPath, type) {
  try {
    fs.symlinkSync(target, linkPath, type);
    return true;
  } catch {
    return false;
  }
}

// Text that deflate shrinks to about a tenth. (A repeated sentence shrinks by more than 200 to 1, and
// such an entry is stored.) The same seed always gives the same text.
export function wordSalad(bytes, seed = 1) {
  const words = ['bageri', 'kage', 'brød', 'kunde', 'side', 'logo', 'farve', 'tekst', 'pris', 'mål', 'tid', 'plan'];
  let state = seed;
  const parts = [];
  let length = 0;
  while (length < bytes) {
    state = (state * 48271) % 2147483647;
    const word = `${words[state % words.length]} `;
    parts.push(word);
    length += word.length;
  }
  return Buffer.from(parts.join('')).subarray(0, bytes);
}

// Writes a big file in pieces of 1 MB, so the test never holds the whole file in memory.
// kind: 'zeros' (shrinks past 200 to 1), 'text' (shrinks to about a tenth) or 'random' (does not shrink).
export function writeFilled(filePath, megabytes, kind) {
  const piece = { zeros: () => Buffer.alloc(1024 * 1024), text: () => wordSalad(1024 * 1024), random: () => crypto.randomBytes(1024 * 1024) }[kind]();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fs.openSync(filePath, 'w');
  try {
    for (let index = 0; index < megabytes; index += 1) fs.writeSync(fd, piece);
  } finally {
    fs.closeSync(fd);
  }
}
