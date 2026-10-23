// Copies the skill folder. The source is walked first and any link or special file
// stops the whole install, so nothing outside the source tree can ever be read.

import fs from 'node:fs';
import path from 'node:path';
import { CliError } from './errors.mjs';
import { sha256File, sha256Hex } from './hash.mjs';
import { RECORD_NAME, buildRecord } from './record.mjs';

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

// Fills a staging folder (new, empty, made by createStaging) with the files of the tree and the install
// record. Nothing is ever written into the skill folder itself: the finished staging folder is moved
// into place in one step by placeStaging. onFile({ relative, destinationPath, sha256 }) is called for
// each file and for the record, with the path the file will have once installed (finalFolder).
// Every file is read back and compared with its source before it counts as copied.
// options: { ancestors, hooks } - ancestors are the folders above the skill folder that this install
// creates (they go into the record); hooks.step(name) is called after each step (see stage.mjs).
export function fillStaging(tree, stage, finalFolder, onFile = () => {}, options = {}) {
  const { hooks } = options;
  for (const dir of tree.dirs) {
    const target = path.join(stage, dir);
    assertInside(stage, target);
    fs.mkdirSync(target, { recursive: true });
  }

  const written = [];
  for (const relative of tree.files) {
    const source = path.join(tree.root, relative);
    const target = path.join(stage, relative);
    assertInside(stage, target);
    // COPYFILE_EXCL refuses to write through, or over, anything that already exists at the target.
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target, fileMode(source));
    const sha256 = sha256File(target);
    if (sha256 !== sha256File(source)) {
      throw new CliError('ui.install.error.hashMismatch', { path: path.join(finalFolder, relative) }, 3);
    }
    written.push({ relative, destinationPath: path.join(finalFolder, relative), sha256 });
    onFile(written.at(-1));
    hooks?.step?.('copy');
  }

  const text = `${JSON.stringify(buildRecord(written, tree.dirs, options.ancestors ?? []), null, 2)}\n`;
  fs.writeFileSync(path.join(stage, RECORD_NAME), text, { flag: 'wx' });
  onFile({ relative: RECORD_NAME, destinationPath: path.join(finalFolder, RECORD_NAME), sha256: sha256Hex(text) });
  hooks?.step?.('record');
  return written;
}
