// Small output helpers shared by install and uninstall.

import { sanitizeForTerminal } from '../skill/everything-mapped/scripts/lib/util.mjs';

// One line of text. Paths and file names come from the person's disk, so a control character in
// one of them (for example an escape sequence) is shown as a visible stand-in, never sent to the terminal.
export function say(io, line = '') {
  io.stdout.write(`${sanitizeForTerminal(line)}\n`);
}

// After files were removed: names every entry that was left in place because the installer did
// not create it, and says whether the skill folder itself could be removed.
export function sayLeftInPlace(io, t, folder, result) {
  for (const relative of result.changed) say(io, t('ui.install.remove.changed', { path: relative }));
  for (const relative of result.kept) say(io, t('ui.install.remove.kept', { path: relative }));
  if (!result.folderRemoved) say(io, t('ui.install.remove.keptFolder', { path: folder }));
  for (const removed of result.removedFolders ?? []) say(io, t('ui.install.remove.removedEmpty', { path: removed }));
}

// Names a backup that an earlier failed install left behind. Nothing is deleted: the person decides.
export function sayStaleBackups(io, t, backups) {
  for (const backup of backups) say(io, t('ui.install.warn.staleBackup', { path: backup }));
}
