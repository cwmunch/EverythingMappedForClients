// Finds out which tools are installed by looking through the folders on PATH.
// No process is started: the files are only looked up.

import fs from 'node:fs';
import path from 'node:path';

const WINDOWS_EXTENSIONS = ['.exe', '.cmd', '.bat'];

// Environment variable names are case-insensitive on Windows ("Path"), so look both ways.
function readEnv(env, name) {
  if (typeof env[name] === 'string') return env[name];
  const match = Object.keys(env).find((key) => key.toUpperCase() === name);
  return match ? String(env[match]) : '';
}

function pathFolders(env, platform) {
  const delimiter = platform === 'win32' ? ';' : ':';
  return readEnv(env, 'PATH')
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter((entry) => entry !== '' && path.isAbsolute(entry));
}

function candidateNames(tool, platform) {
  return platform === 'win32' ? WINDOWS_EXTENSIONS.map((ext) => tool + ext) : [tool];
}

function isRunnableFile(filePath, platform) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    return platform === 'win32' || (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

// Returns the full path of the first match, or null. Relative PATH entries
// (for example ".") are ignored so a file in the current folder is never mistaken for the tool.
export function findOnPath(tool, { env = process.env, platform = process.platform } = {}) {
  for (const folder of pathFolders(env, platform)) {
    for (const name of candidateNames(tool, platform)) {
      const candidate = path.join(folder, name);
      if (isRunnableFile(candidate, platform)) return candidate;
    }
  }
  return null;
}

// Returns { claude: <path or null>, codex: <path or null> }.
export function detectTools(options = {}) {
  return {
    claude: findOnPath('claude', options),
    codex: findOnPath('codex', options),
  };
}
