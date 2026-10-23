// Installing without ever leaving a half-built skill where a tool would load it.
//
// The new copy is built in a staging folder next to the skills folder (inside .claude or .agents, never
// inside skills/), with its install record, and checked file by file. Only then is it moved into place:
// one rename of the whole folder. A process that stops at any point before that leaves nothing inside
// skills/ but the old copy, and a staging folder that later runs name (and never use or delete).
//
// With --force the order is: build the new copy, move the old one aside (a backup next to skills/),
// move the new one into place, remove the backup last (and only as well as it can be done).
//
// `hooks.step(name, details)` is called after each step ('staging', 'copy', 'record', 'aside', 'place',
// 'placed', 'installed'). Nothing sets it in normal use; tests use it to look at the folders at every point.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assertInside, fillStaging } from './copy.mjs';
import { CliError } from './errors.mjs';
import { RECORD_NAME, toSlashes } from './record.mjs';
import { STAGING_PREFIX, TOOLS, moveAside, sideFolder } from './skill-folder.mjs';

const SKILL_FILE = 'SKILL.md';
const STAGING_ATTEMPTS = 8;

// Makes a new, empty staging folder next to the skills folder. The name has a random part and the
// folder is created so that it cannot already exist.
export function createStaging(folder) {
  const parent = sideFolder(folder);
  for (let attempt = 0; attempt < STAGING_ATTEMPTS; attempt += 1) {
    const stage = path.join(parent, `${STAGING_PREFIX}${crypto.randomBytes(6).toString('hex')}`);
    try {
      fs.mkdirSync(stage);
      return stage;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new CliError('ui.install.error.writeFailed', { path: parent, message: 'no free name for a staging folder' }, 3);
}

// Removes a staging folder this run made. Only a folder named like one, directly inside .claude or
// .agents, is ever removed.
export function discardStaging(stage) {
  const toolFolder = path.basename(path.dirname(stage));
  const looksRight = path.basename(stage).startsWith(STAGING_PREFIX) && Object.values(TOOLS).some((tool) => tool.folder === toolFolder);
  if (!looksRight) throw new CliError('ui.install.error.unsafeRemove', { path: stage });
  fs.rmSync(stage, { recursive: true, force: true });
}

// Every file below folder, as forward-slash paths.
function listFiles(folder, prefix = '') {
  const files = [];
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    if (entry.isDirectory()) files.push(...listFiles(path.join(folder, entry.name), `${prefix}${entry.name}/`));
    else files.push(`${prefix}${entry.name}`);
  }
  return files.sort();
}

// Creates the missing folders from root down to folder, remembering which it made. A folder that is
// there must be a real one: a link is never written through.
function makeFoldersBelow(folder, root, made) {
  const parts = path.relative(root, folder).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat) {
      if (!stat.isDirectory()) throw new CliError('ui.install.error.notRealFolder', { path: current });
    } else {
      fs.mkdirSync(current);
      made.push(current);
    }
  }
}

// The skill folder still holds some of the person's own files: the staged files are moved in one by one.
// The record goes first and SKILL.md last, so a stop in the middle leaves a folder that no tool loads
// (it has no SKILL.md yet) and that the record can repair. Failing undoes what was moved.
function mergeStaging(stage, folder, hooks) {
  const files = listFiles(stage);
  const order = [
    ...files.filter((file) => file === RECORD_NAME),
    ...files.filter((file) => file !== RECORD_NAME && file !== SKILL_FILE),
    ...files.filter((file) => file === SKILL_FILE),
  ];
  const placed = [];
  const made = [];
  try {
    for (const relative of order) {
      const target = path.join(folder, ...relative.split('/'));
      assertInside(folder, target);
      makeFoldersBelow(path.dirname(target), folder, made);
      if (fs.lstatSync(target, { throwIfNoEntry: false })) throw new CliError('ui.install.error.inTheWay', { path: target });
      fs.renameSync(path.join(stage, ...relative.split('/')), target);
      placed.push(target);
      hooks?.step?.('place');
    }
  } catch (error) {
    for (const file of placed.reverse()) fs.rmSync(file, { force: true });
    for (const dir of made.reverse()) {
      try {
        fs.rmdirSync(dir);
      } catch {
        // not empty: leave it
      }
    }
    throw error;
  }
  discardStaging(stage);
  hooks?.step?.('placed');
}

// Moves the finished staging folder to the skill folder: when nothing is there (or an empty folder),
// in one rename. When the person's own files are still in it, see mergeStaging.
export function placeStaging(stage, folder, hooks) {
  const stat = fs.lstatSync(folder, { throwIfNoEntry: false });
  if (stat && !stat.isDirectory()) throw new CliError('ui.install.error.notRealFolder', { path: folder });
  if (stat && fs.readdirSync(folder).length > 0) {
    mergeStaging(stage, folder, hooks);
    return;
  }
  if (stat) fs.rmdirSync(folder);
  try {
    fs.renameSync(stage, folder);
  } catch (error) {
    if (stat) fs.mkdirSync(folder);
    throw error;
  }
  hooks?.step?.('placed');
}

function removeQuietly(action) {
  try {
    action();
  } catch {
    // a leftover that later runs name
  }
}

// Installs one scope and tool: builds the new copy, moves the old one aside when replacing, places the
// new one, removes the backup. plan: { baseDir, folder, removal } with removal from planRemoval (or null).
// Returns { written, backupLeft } where backupLeft is the path of a backup that could not be removed
// (the new copy is installed all the same). When anything fails, the old copy is put back, the staging
// folder is removed, and the folders this run made are removed if they are empty. Throws a CliError.
export function installCopy(plan, tree, onFile, hooks) {
  const skillsFolder = path.dirname(plan.folder);
  const toolFolder = path.dirname(skillsFolder);
  const missing = [toolFolder, skillsFolder].filter((folder) => !fs.lstatSync(folder, { throwIfNoEntry: false }));
  const fresh = missing.map((folder) => toSlashes(path.relative(plan.baseDir, folder)));
  const inherited = plan.removal?.record.ancestors ?? [];
  const ancestors = [...new Set([...inherited, ...fresh])].sort((a, b) => a.split('/').length - b.split('/').length);

  const created = [];
  let stage = null;
  let aside = null;
  let written;
  try {
    for (const folder of missing) {
      fs.mkdirSync(folder);
      created.push(folder);
    }
    stage = createStaging(plan.folder);
    hooks?.step?.('staging');
    written = fillStaging(tree, stage, plan.folder, onFile, { ancestors, hooks });
    if (plan.removal) {
      aside = moveAside(plan.folder, plan.removal);
      hooks?.step?.('aside');
    }
    placeStaging(stage, plan.folder, hooks);
    stage = null;
  } catch (error) {
    let failure = error instanceof CliError ? error : new CliError('ui.install.error.writeFailed', { path: plan.folder, message: error.message }, 3);
    try {
      aside?.restore();
    } catch (restoreError) {
      failure = restoreError;
    }
    if (stage) removeQuietly(() => discardStaging(stage));
    for (const folder of created.reverse()) removeQuietly(() => fs.rmdirSync(folder));
    throw failure;
  }

  hooks?.step?.('installed', { backup: aside?.path });
  let backupLeft = null;
  if (aside) {
    try {
      aside.discard();
    } catch {
      backupLeft = aside.path;
    }
  }
  return { written, backupLeft };
}
