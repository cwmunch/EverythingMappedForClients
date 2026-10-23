// Small command line parser. It knows only the options a command declares and
// reports every problem as a UsageError that carries a text key, so the caller
// can print it in the chosen language.

export class UsageError extends Error {
  constructor(key, params = {}) {
    super(key);
    this.name = 'UsageError';
    this.key = key;
    this.params = params;
  }
}

const LANGUAGES = ['da', 'en'];

// spec: { booleans: ['force'], strings: ['dir', 'lang'], aliases: { h: 'help' } }
// Returns { values, positionals }. Boolean options are true when present.
export function parseArgs(argv, spec) {
  const booleans = new Set(spec.booleans ?? []);
  const strings = new Set(spec.strings ?? []);
  const aliases = spec.aliases ?? {};
  const values = {};
  const positionals = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      i += readLongOption(argv, i, { booleans, strings, aliases }, values);
    } else if (arg.length === 2 && arg.startsWith('-') && Object.hasOwn(aliases, arg[1])) {
      values[aliases[arg[1]]] = true;
    } else if (arg.startsWith('-') && arg.length > 1) {
      throw new UsageError('ui.cli.error.unknownOption', { option: arg });
    } else {
      positionals.push(arg);
    }
  }
  return { values, positionals };
}

// Reads one --name or --name=value option. Returns how many extra arguments it used.
function readLongOption(argv, index, { booleans, strings, aliases }, values) {
  const arg = argv[index];
  const equals = arg.indexOf('=');
  const name = equals === -1 ? arg.slice(2) : arg.slice(2, equals);
  const inlineValue = equals === -1 ? undefined : arg.slice(equals + 1);

  if (booleans.has(name)) {
    if (inlineValue !== undefined) {
      throw new UsageError('ui.cli.error.unexpectedValue', { option: `--${name}` });
    }
    values[name] = true;
    return 0;
  }
  if (!strings.has(name)) {
    throw new UsageError('ui.cli.error.unknownOption', { option: `--${name}` });
  }
  if (inlineValue !== undefined) {
    values[name] = requireValue(name, inlineValue);
    return 0;
  }
  const next = argv[index + 1];
  if (next === undefined || looksLikeOption(next, aliases)) {
    throw new UsageError('ui.cli.error.missingValue', { option: `--${name}` });
  }
  values[name] = requireValue(name, next);
  return 1;
}

// An option name is never taken as the value of the option before it: "--dir -g" is a missing value,
// not a folder called -g. (A folder that starts with a dash can be written "--dir=-name" or "./-name".)
function looksLikeOption(argument, aliases) {
  if (argument.startsWith('--')) return true;
  return argument.length === 2 && argument.startsWith('-') && Object.hasOwn(aliases, argument[1]);
}

function requireValue(name, value) {
  if (value === '') {
    throw new UsageError('ui.cli.error.missingValue', { option: `--${name}` });
  }
  return value;
}

export function assertNoPositionals(positionals) {
  if (positionals.length > 0) {
    throw new UsageError('ui.cli.error.unexpectedArgument', { value: positionals[0] });
  }
}

export function checkLanguage(value) {
  if (!LANGUAGES.includes(value)) {
    throw new UsageError('ui.cli.error.badLang', { value });
  }
  return value;
}

// Finds --lang in a raw argument list without needing the command's own option
// list. Returns undefined when absent. Throws UsageError for a missing or bad value.
export function findLangOption(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') return undefined;
    if (arg === '--lang') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new UsageError('ui.cli.error.missingValue', { option: '--lang' });
      }
      return checkLanguage(next);
    }
    if (arg.startsWith('--lang=')) return checkLanguage(arg.slice('--lang='.length));
  }
  return undefined;
}

// Language for messages: --lang, then LC_ALL, then LANG (starting with "da"), else English.
export function chooseLanguage(explicit, env = {}) {
  if (explicit) return explicit;
  const locale = String(env.LC_ALL || env.LANG || '');
  return /^da(?:[_.@-]|$)/i.test(locale) ? 'da' : 'en';
}
