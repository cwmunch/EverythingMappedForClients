// The one question the installer may ask: which tool to install for.
// It is only asked when both tools are found and stdin is a terminal.

import readline from 'node:readline';

const ANSWERS = {
  1: ['claude'],
  claude: ['claude'],
  2: ['codex'],
  codex: ['codex'],
  3: ['claude', 'codex'],
  both: ['claude', 'codex'],
  begge: ['claude', 'codex'],
  '': ['claude', 'codex'],
};

const MAX_ATTEMPTS = 3;

// Returns an array of tool ids, or null when no valid answer was given.
export async function askTargets(io, t) {
  const reader = readline.createInterface({ input: io.stdin, crlfDelay: Infinity });
  const lines = reader[Symbol.asyncIterator]();
  try {
    io.stdout.write(`${t('ui.install.prompt.title')}\n`);
    io.stdout.write(`  1) ${t('ui.install.tool.claude')}\n`);
    io.stdout.write(`  2) ${t('ui.install.tool.codex')}\n`);
    io.stdout.write(`  3) ${t('ui.install.prompt.both')}\n`);

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      io.stdout.write(t('ui.install.prompt.question'));
      const { value, done } = await lines.next();
      if (done) return null;
      const typed = value.trim().toLowerCase();
      if (Object.hasOwn(ANSWERS, typed)) return ANSWERS[typed];
      io.stdout.write(`${t('ui.install.prompt.invalid')}\n`);
    }
    return null;
  } finally {
    reader.close();
  }
}
