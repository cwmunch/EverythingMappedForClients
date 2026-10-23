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

  if (scopes.length === 2 && fs.realpathSync(scopes[0].baseDir) === fs.realpathSync(scopes[1].baseDir)) {
    throw new CliError('ui.install.error.sameFolder', { dir: scopes[0].baseDir });
  }
  return scopes;
}
