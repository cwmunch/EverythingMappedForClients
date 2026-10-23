// Decides where the skill goes: the project folder (local, the default), the user's home folder
// (global), or both in one run.

import fs from 'node:fs';
import path from 'node:path';
import { CliError } from './errors.mjs';

// options: { user?: boolean, dir?: string }, ctx: { cwd, homedir() }
// Returns { baseDir, scope: 'user' | 'project' }. The folder must already exist.
export function resolveBaseDir(options, ctx) {
  if (options.user && options.dir !== undefined) {
    throw new CliError('ui.install.error.dirNeedsLocal');
  }
  if (options.dir !== undefined && options.dir.includes('\0')) {
    throw new CliError('ui.install.error.badDir');
  }

  const baseDir = options.user ? ctx.homedir() : path.resolve(ctx.cwd, options.dir ?? '.');
  const scope = options.user ? 'user' : 'project';
  // A relative HOME would be read against the folder the command is run in, which is not the home folder.
  if (options.user && baseDir !== '' && !path.isAbsolute(baseDir)) throw new CliError('ui.install.error.homeNotAbsolute', { dir: baseDir });

  let stat;
  try {
    stat = fs.statSync(baseDir);
  } catch {
    throw new CliError('ui.install.error.dirMissing', { dir: baseDir });
  }
  if (!stat.isDirectory()) {
    throw new CliError('ui.install.error.dirNotFolder', { dir: baseDir });
  }
  return { baseDir, scope };
}

// The scopes a run works on, from -g / --global / --user and --local. No flag means local only;
// both flags mean both, local first. --dir belongs to the local scope.
// values: { global?, user?, local?, dir? }. Returns [{ scope, baseDir }].
export function resolveScopes(values, ctx) {
  const wantGlobal = values.global === true || values.user === true;
  const wantLocal = values.local === true || !wantGlobal;
  if (values.dir !== undefined && !wantLocal) throw new CliError('ui.install.error.dirNeedsLocal');

  const scopes = [];
  if (wantLocal) scopes.push(resolveBaseDir({ dir: values.dir }, ctx));
  if (wantGlobal) scopes.push(resolveBaseDir({ user: true }, ctx));

  if (scopes.length === 2 && isSameFolder(scopes[0].baseDir, scopes[1].baseDir)) {
    throw new CliError('ui.install.error.sameFolder', { dir: scopes[0].baseDir });
  }
  return scopes;
}

// True when both paths lead to the same folder: the native real path is the same (it also fixes the
// letter case on Windows and macOS, where "c:\users\bob" and "C:\Users\Bob" are one folder), or both
// have the same device and file number (a bind mount or another way to reach the same folder).
function isSameFolder(first, second) {
  if (fs.realpathSync.native(first) === fs.realpathSync.native(second)) return true;
  const a = fs.statSync(first, { bigint: true });
  const b = fs.statSync(second, { bigint: true });
  return a.ino !== 0n && a.ino === b.ino && a.dev === b.dev;
}
