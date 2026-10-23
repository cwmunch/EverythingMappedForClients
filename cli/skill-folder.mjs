// Where the skill is installed, and the checks that guard writing and removing it.
// Nothing is ever deleted through a link, and only files listed in the install record are deleted.
//
// Removing is done in two steps: planRemoval() looks at the folder and works out what will be removed
// and what will remain, without changing anything; applyRemoval() and moveAside() then do it.

import fs from 'node:fs';
import path from 'node:path';
import { isInside } from './copy.mjs';
import { CliError } from './errors.mjs';
import { sha256File } from './hash.mjs';
import { RECORD_NAME, readRecord, recordedPath, toSlashes } from './record.mjs';

export const SKILL_NAME = 'everything-mapped';

// tool id -> the hidden folder that tool reads skills from
export const TOOLS = {
  claude: { folder: '.claude', label: 'ui.install.tool.claude' },
  codex: { folder: '.agents', label: 'ui.install.tool.codex' },
};

// baseDir is the project folder or the user's home folder.
export function skillFolderFor(baseDir, toolId) {
  return path.join(baseDir, TOOLS[toolId].folder, 'skills', SKILL_NAME);
}

// Refuses when <base>/.claude or <base>/.claude/skills (or the .agents pair) is a link, is not a
// folder, or resolves to somewhere outside the base folder. A link there would send writes and
// deletes to a place the person did not choose. (A Windows junction shows up as a link too.)
export function assertParentsSafe(baseDir, toolId) {
  const realBase = fs.realpathSync(baseDir);
  const toolFolder = path.join(baseDir, TOOLS[toolId].folder);
  for (const folder of [toolFolder, path.join(toolFolder, 'skills')]) {
    const stat = fs.lstatSync(folder, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new CliError('ui.install.error.parentLink', { path: folder });
    if (!stat.isDirectory()) throw new CliError('ui.install.error.parentNotFolder', { path: folder });
    const real = fs.realpathSync(folder);
    if (real !== realBase && !isInside(realBase, real)) {
      throw new CliError('ui.install.error.parentOutside', { path: folder });
    }
  }
}

// Only .../.claude/skills/everything-mapped and .../.agents/skills/everything-mapped may ever be removed.
export function assertSkillFolderPath(folder) {
  const parent = path.dirname(folder);
  const toolFolder = path.basename(path.dirname(parent));
  const looksRight =
    path.basename(folder) === SKILL_NAME &&
    path.basename(parent) === 'skills' &&
    Object.values(TOOLS).some((tool) => tool.folder === toolFolder);
  if (!looksRight) {
    throw new CliError('ui.install.error.unsafeRemove', { path: folder });
  }
}

// Describes what is at the skill folder path: 'none', 'folder', 'link' or 'other'.
export function inspectSkillFolder(folder) {
  let stat;
  try {
    stat = fs.lstatSync(folder);
  } catch (error) {
    if (error.code === 'ENOENT') return 'none';
    throw error;
  }
  if (stat.isSymbolicLink()) return 'link';
  return stat.isDirectory() ? 'folder' : 'other';
}

// Checks that folder is a real installed copy made by this installer, and returns its record:
// { files: [{ path, sha256 }], dirs: [path] }. Throws CliError when it must not be touched.
export function assertRemovable(folder) {
  assertSkillFolderPath(folder);
  const kind = inspectSkillFolder(folder);
  if (kind === 'link') throw new CliError('ui.install.error.isLink', { path: folder });
  if (kind !== 'folder') throw new CliError('ui.install.error.notFolder', { path: folder });
  return readRecord(folder);
}

// ---------------------------------------------------------------------------------------------
// Looking

function parentOf(relative) {
  const slash = relative.lastIndexOf('/');
  return slash === -1 ? '' : relative.slice(0, slash);
}

function deepestFirst(a, b) {
  return b.split('/').length - a.split('/').length;
}

// Every entry below folder, folders included (also empty ones), as { path, kind } with forward-slash
// paths. kind is 'file', 'dir', 'link' or 'other'. Links are listed and never followed. The install
// record at the top is left out.
function listAll(folder, prefix = '') {
  const entries = [];
  for (const name of fs.readdirSync(folder)) {
    if (prefix === '' && name === RECORD_NAME) continue;
    const absolute = path.join(folder, name);
    const stat = fs.lstatSync(absolute);
    let kind = 'other';
    if (stat.isSymbolicLink()) kind = 'link';
    else if (stat.isDirectory()) kind = 'dir';
    else if (stat.isFile()) kind = 'file';
    entries.push({ path: `${prefix}${name}`, kind });
    if (kind === 'dir') entries.push(...listAll(absolute, `${prefix}${name}/`));
  }
  return entries;
}

// What removing the install would do, worked out without changing anything:
//   removeFiles  recorded plain files whose content is still what was installed
//   removeDirs   recorded folders that will be empty once those files are gone (deepest first)
//   changed      recorded files the person changed (kept)
//   remaining    everything that is still there afterwards: the person's own files, changed files,
//                links, folders where a file was, folders that still hold something
// A recorded path is only treated as ours when it is a plain file found by walking real folders, so
// a link on the way, or a file or folder where something else was installed, is simply "remaining".
export function planRemoval(folder) {
  const record = assertRemovable(folder);
  const entries = listAll(folder);
  const kindOf = new Map(entries.map((entry) => [entry.path, entry.kind]));

  const removeFiles = [];
  const changed = [];
  for (const file of record.files) {
    if (kindOf.get(file.path) !== 'file') continue;
    if (sha256File(recordedPath(folder, file.path)) === file.sha256) removeFiles.push(file.path);
    else changed.push(file.path);
  }

  const gone = new Set(removeFiles);
  const children = new Map();
  for (const entry of entries) {
    const parent = parentOf(entry.path);
    children.set(parent, [...(children.get(parent) ?? []), entry.path]);
  }
  const recordedDirs = new Set(record.dirs);
  const removeDirs = [];
  const folders = entries.filter((entry) => entry.kind === 'dir').map((entry) => entry.path).sort(deepestFirst);
  for (const dir of folders) {
    if (recordedDirs.has(dir) && (children.get(dir) ?? []).every((child) => gone.has(child))) {
      gone.add(dir);
      removeDirs.push(dir);
    }
  }

  return { record, removeFiles, removeDirs, changed, remaining: entries.filter((entry) => !gone.has(entry.path)) };
}

// For a fresh install into this folder after the removal: the first remaining entry that is in the
// way of a file or folder the install needs to create, or null. Returns { path, key } where key is
// the text key of the reason.
export function findBlocking(plan, tree) {
  const sourceFiles = new Set(tree.files.map(toSlashes));
  const sourceDirs = new Set(tree.dirs.map(toSlashes));
  const recorded = new Set(plan.record.files.map((file) => file.path));
  for (const entry of plan.remaining) {
    if (sourceFiles.has(entry.path)) {
      if (plan.changed.includes(entry.path)) return { path: entry.path, key: 'ui.install.error.changedCollides' };
      if (entry.kind === 'file' && !recorded.has(entry.path)) return { path: entry.path, key: 'ui.install.error.leftoverCollides' };
      return { path: entry.path, key: 'ui.install.error.inTheWay' };
    }
    if (sourceDirs.has(entry.path) && entry.kind !== 'dir') return { path: entry.path, key: 'ui.install.error.inTheWay' };
  }
  return null;
}

// The entries to name for the person after a removal: recorded files they changed, and everything
// else that stays (files and links by name, folders only when they hold nothing else that is named).
export function describeLeftovers(plan) {
  const hasRemainingChild = new Set(plan.remaining.map((entry) => parentOf(entry.path)));
  const kept = plan.remaining
    .filter((entry) => !plan.changed.includes(entry.path))
    .filter((entry) => entry.kind !== 'dir' || !hasRemainingChild.has(entry.path))
    .map((entry) => (entry.kind === 'dir' ? `${entry.path}/` : entry.path));
  return { changed: plan.changed, kept };
}

// ---------------------------------------------------------------------------------------------
// Changing

// True when absolute lies inside the real skill folder, judged by the real path of the folder it is in
// (so a link put in the way since the plan was made is noticed).
function isReallyInside(realFolder, absolute) {
  let realParent;
  try {
    realParent = fs.realpathSync(path.dirname(absolute));
  } catch {
    return false;
  }
  return realParent === realFolder || isInside(realFolder, realParent);
}

function ignoreMissing(action) {
  try {
    action();
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

// Removes what the plan says: the recorded files that are unchanged, the folders that are empty
// then. When nothing at all remains, the install record and the skill folder go too; otherwise the
// record stays, so that running uninstall again does the same and finishes the job once the
// person's own files are gone. Returns { removed, changed, kept, folderRemoved }.
export function applyRemoval(folder, plan) {
  const realFolder = fs.realpathSync(folder);
  let removed = 0;
  for (const relative of plan.removeFiles) {
    const absolute = recordedPath(folder, relative);
    if (isReallyInside(realFolder, absolute) && ignoreMissing(() => fs.unlinkSync(absolute))) removed += 1;
  }
  for (const relative of plan.removeDirs) {
    const absolute = recordedPath(folder, relative);
    if (isReallyInside(realFolder, absolute)) {
      try {
        fs.rmdirSync(absolute);
      } catch {
        // something appeared in it since the plan was made: leave it
      }
    }
  }

  let folderRemoved = false;
  if (plan.remaining.length === 0) {
    ignoreMissing(() => fs.unlinkSync(path.join(folder, RECORD_NAME)));
    try {
      fs.rmdirSync(folder);
      folderRemoved = true;
    } catch {
      // not empty after all
    }
  }
  return { removed, ...describeLeftovers(plan), folderRemoved };
}

// Moves the old installed files (and the record) into a backup folder next to the skill folder, so that
// a new copy can be written in their place and the old one can be put back if that fails.
// Returns { restore(), discard() }: restore() puts everything back and removes the backup; discard()
// removes the backup once the new copy is in place.
export function moveAside(folder, plan) {
  const realFolder = fs.realpathSync(folder);
  const backup = fs.mkdtempSync(path.join(path.dirname(folder), `.${SKILL_NAME}-backup-`));
  const moved = [];
  const removedDirs = [];

  const move = (from, to) => {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    moved.push({ from, to });
  };

  const restore = () => {
    try {
      for (const dir of [...removedDirs].reverse()) fs.mkdirSync(dir, { recursive: true });
      for (const { from, to } of [...moved].reverse()) {
        fs.mkdirSync(path.dirname(from), { recursive: true });
        fs.renameSync(to, from);
      }
    } catch {
      throw new CliError('ui.install.error.restoreFailed', { path: backup }, 3);
    }
    fs.rmSync(backup, { recursive: true, force: true });
  };

  try {
    for (const relative of plan.removeFiles) {
      const from = recordedPath(folder, relative);
      if (isReallyInside(realFolder, from)) move(from, path.join(backup, ...relative.split('/')));
    }
    move(path.join(folder, RECORD_NAME), path.join(backup, RECORD_NAME));
    for (const relative of plan.removeDirs) {
      const absolute = recordedPath(folder, relative);
      if (isReallyInside(realFolder, absolute)) {
        fs.rmdirSync(absolute);
        removedDirs.push(absolute);
      }
    }
  } catch (error) {
    restore();
    throw error;
  }
  return { restore, discard: () => fs.rmSync(backup, { recursive: true, force: true }) };
}
