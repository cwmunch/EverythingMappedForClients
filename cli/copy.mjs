// Copies the skill folder. The source is walked first and any link or special file
// stops the whole install, so nothing outside the source tree can ever be read.
// Everything the copy creates is remembered, so a failed copy can be undone without
// touching anything that was already there.

import fs from 'node:fs';
import path from 'node:path';
import { CliError } from './errors.mjs';
import { sha256File, sha256Hex } from './hash.mjs';
import { RECORD_NAME, buildRecord, toSlashes } from './record.mjs';

function compareNames(a, b) {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

export function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function assertInside(root, target) {
  if (!isInside(root, target)) {
    throw new CliError('ui.install.error.unsafePath', { root, path: target });
  }
}

// Returns { root, dirs, files }: the real source path and the sorted relative paths below it.
// Throws CliError for a symbolic link, a junction or any entry that is not a plain file or folder.
export function listTree(sourceRoot) {
  const realRoot = fs.realpathSync(sourceRoot);
  const dirs = [];
  const files = [];

  const walk = (relativeDir) => {
    const names = fs.readdirSync(path.join(realRoot, relativeDir)).sort(compareNames);
    for (const name of names) {
      const relative = path.join(relativeDir, name);
      const absolute = path.join(realRoot, relative);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        throw new CliError('ui.install.error.sourceLink', { path: absolute });
      }
      if (stat.isDirectory()) {
        dirs.push(relative);
        walk(relative);
      } else if (stat.isFile() && name !== RECORD_NAME) {
        assertInside(realRoot, fs.realpathSync(absolute));
        files.push(relative);
      } else {
        throw new CliError('ui.install.error.sourceOdd', { path: absolute });
      }
    }
  };

  walk('');
  return { root: realRoot, dirs, files };
}

function fileMode(sourcePath) {
  return (fs.statSync(sourcePath).mode & 0o111) !== 0 ? 0o755 : 0o644;
}

// Creates the missing folders above the destination, and remembers which ones it created.
// Folders that already exist there were checked by assertParentsSafe.
function makeAncestors(folder, created) {
  if (fs.lstatSync(folder, { throwIfNoEntry: false })) return;
  makeAncestors(path.dirname(folder), created);
  fs.mkdirSync(folder);
  created.dirs.push(folder);
}

// Creates one folder at or below the destination. Whatever already exists there must be a real
// folder: a link or a file is never written through, because a link can lead anywhere.
function makeFolderBelow(folder, created) {
  const stat = fs.lstatSync(folder, { throwIfNoEntry: false });
  if (stat) {
    if (stat.isDirectory()) return;
    throw new CliError('ui.install.error.notRealFolder', { path: folder });
  }
  fs.mkdirSync(folder);
  created.dirs.push(folder);
}

// Removes what this copy created: its files, then its folders if they are empty again.
// Returns the first file that could not be removed, or null.
function undoCreated(created) {
  let stuck = null;
  for (const file of created.files) {
    try {
      fs.unlinkSync(file);
    } catch (error) {
      if (error.code !== 'ENOENT') stuck ??= file;
    }
  }
  for (const folder of [...created.dirs].reverse()) {
    try {
      fs.rmdirSync(folder);
    } catch {
      // not empty (it holds someone else's files) or already gone: leave it
    }
  }
  return stuck;
}

function copyFiles(tree, destination, created, onFile) {
  const written = [];
  for (const dir of tree.dirs) {
    const target = path.join(destination, dir);
    assertInside(destination, target);
    makeFolderBelow(target, created);
  }
  for (const relative of tree.files) {
    const source = path.join(tree.root, relative);
    const target = path.join(destination, relative);
    assertInside(destination, target);
    // COPYFILE_EXCL refuses to write through, or over, anything that already exists at the target.
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    created.files.push(target);
    fs.chmodSync(target, fileMode(source));
    const sha256 = sha256File(target);
    if (sha256 !== sha256File(source)) {
      throw new CliError('ui.install.error.hashMismatch', { path: target }, 3);
    }
    written.push({ relative, destinationPath: target, sha256 });
    onFile(written.at(-1));
  }
  return written;
}

function writeRecord(tree, destination, written, created, ancestors, onFile) {
  const target = path.join(destination, RECORD_NAME);
  const text = `${JSON.stringify(buildRecord(written, tree.dirs, ancestors), null, 2)}\n`;
  fs.writeFileSync(target, text, { flag: 'wx' });
  created.files.push(target);
  onFile({ relative: RECORD_NAME, destinationPath: target, sha256: sha256Hex(text) });
}

// The folders above the destination that this copy created, as paths from baseDir with forward
// slashes, joined with the ones an earlier install of the same folder had created (inherited), top first.
function recordedAncestors(createdBefore, baseDir, inherited) {
  const fresh = baseDir
    ? createdBefore.map((folder) => path.relative(baseDir, folder)).filter((relative) => relative !== '' && !relative.startsWith('..')).map(toSlashes)
    : [];
  return [...new Set([...inherited, ...fresh])].sort((a, b) => a.split('/').length - b.split('/').length);
}

// Copies every file of the tree into destination and writes the install record there.
// destination may already exist (a --force install that left someone's own files in place);
// a file that is already there is never overwritten. Calls onFile({ relative, destinationPath, sha256 })
// after each file. When anything fails, only what this call created is removed again;
// error.leftBehind names a file that could not be removed.
// options: { baseDir, inheritedAncestors } - baseDir is the project or home folder; the folders this call
// creates between it and the destination go into the record, together with the inherited ones.
export function copyTree(tree, destination, onFile = () => {}, options = {}) {
  const created = { dirs: [], files: [] };
  try {
    makeAncestors(path.dirname(destination), created);
    const ancestors = recordedAncestors([...created.dirs], options.baseDir, options.inheritedAncestors ?? []);
    makeFolderBelow(destination, created);
    const written = copyFiles(tree, destination, created, onFile);
    writeRecord(tree, destination, written, created, ancestors, onFile);
  } catch (error) {
    const stuck = undoCreated(created);
    const failure =
      error instanceof CliError
        ? error
        : new CliError('ui.install.error.writeFailed', { path: destination, message: error.message }, 3);
    failure.leftBehind = stuck;
    throw failure;
  }
}
