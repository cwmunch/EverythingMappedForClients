// Builds the help text from the command line texts. Command and option names stay as they are
// (they are typed by people); only the explanations come from the language file.

const COMMANDS = ['install', 'uninstall', 'check', 'next', 'answer', 'assets', 'pack', 'version', 'help'];

const OPTIONS = [
  ['--claude', 'claude'],
  ['--codex', 'codex'],
  ['-g, --global', 'global'],
  ['--local', 'local'],
  ['--dir <folder>', 'dir'],
  ['--dry-run', 'dryRun'],
  ['--force', 'force'],
  ['--lang da|en', 'lang'],
  ['--root <folder>', 'root'],
  ['--out <folder>', 'out'],
  ['--json', 'json'],
];

const EXAMPLES = [
  ['everything-mapped install', 'install'],
  ['everything-mapped install -g', 'installGlobal'],
  ['everything-mapped install -g --local', 'installBoth'],
  ['everything-mapped pack', 'pack'],
];

function table(rows) {
  const width = Math.max(...rows.map(([name]) => name.length));
  return rows.map(([name, description]) => `  ${name.padEnd(width + 2)}${description}`);
}

export function helpText(t) {
  const lines = [
    t('ui.cli.help.title'),
    '',
    t('ui.cli.help.usage'),
    '',
    t('ui.cli.help.commands'),
    ...table(COMMANDS.map((name) => [name, t(`ui.cli.help.cmd.${name}`)])),
    '',
    t('ui.cli.help.options'),
    ...table(OPTIONS.map(([flag, key]) => [flag, t(`ui.cli.help.opt.${key}`)])),
    '',
    t('ui.cli.help.examples'),
    ...table(EXAMPLES.map(([command, key]) => [command, t(`ui.cli.help.example.${key}`)])),
    '',
    t('ui.cli.help.footer'),
  ];
  return `${lines.join('\n')}\n`;
}
