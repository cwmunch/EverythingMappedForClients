import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { UsageError, chooseLanguage, findLangOption, parseArgs } from '../../cli/args.mjs';
import { defaultContext } from '../../bin/cli.mjs';
import { REPO_ROOT, makeTempDir, runCli, snapshot } from './helpers.mjs';

const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
const COMMANDS = ['install', 'uninstall', 'check', 'next', 'answer', 'assets', 'pack', 'version', 'help'];

test('help lists every command and exits 0 (English by default)', async () => {
  const result = await runCli(['help']);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /Usage: everything-mapped <command>/);
  for (const command of COMMANDS) assert.match(result.stdout, new RegExp(`^  ${command}\\s`, 'm'), command);
  assert.match(result.stdout, /--dry-run/);
});

test('no command, --help and -h all show the help and exit 0', async () => {
  const expected = (await runCli(['help'])).stdout;
  for (const args of [[], ['--help'], ['-h']]) {
    const result = await runCli(args);
    assert.equal(result.code, 0, JSON.stringify(args));
    assert.equal(result.stdout, expected);
  }
});

test('--help after a command shows the help and does nothing else', async (t) => {
  const work = makeTempDir(t);
  const result = await runCli(['install', '--claude', '--help'], { cwd: work });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage:/);
  assert.deepEqual(snapshot(work), {});
});

test('help is Danish with --lang da or a Danish locale, and --lang beats the locale', async () => {
  const flagged = await runCli(['help', '--lang', 'da']);
  assert.match(flagged.stdout, /Brug: everything-mapped <kommando>/);

  const fromLang = await runCli(['help'], { env: { LANG: 'da_DK.UTF-8' } });
  assert.match(fromLang.stdout, /Kommandoer:/);

  const fromLcAll = await runCli(['help'], { env: { LC_ALL: 'da_DK.UTF-8', LANG: 'en_US.UTF-8' } });
  assert.match(fromLcAll.stdout, /Kommandoer:/);

  const lcAllWins = await runCli(['help'], { env: { LC_ALL: 'en_US.UTF-8', LANG: 'da_DK.UTF-8' } });
  assert.match(lcAllWins.stdout, /Commands:/);

  const flagWins = await runCli(['help', '--lang', 'en'], { env: { LANG: 'da_DK.UTF-8' } });
  assert.match(flagWins.stdout, /Commands:/);
});

test('language choice: --lang, then LC_ALL or LANG starting with da, else English', () => {
  assert.equal(chooseLanguage('da', { LANG: 'en_US' }), 'da');
  assert.equal(chooseLanguage('en', { LANG: 'da_DK' }), 'en');
  assert.equal(chooseLanguage(undefined, { LANG: 'da_DK.UTF-8' }), 'da');
  assert.equal(chooseLanguage(undefined, { LANG: 'da' }), 'da');
  assert.equal(chooseLanguage(undefined, { LANG: 'DA_DK' }), 'da');
  assert.equal(chooseLanguage(undefined, { LC_ALL: 'da_DK.UTF-8', LANG: 'en_US.UTF-8' }), 'da');
  assert.equal(chooseLanguage(undefined, { LC_ALL: 'C', LANG: 'da_DK.UTF-8' }), 'en');
  assert.equal(chooseLanguage(undefined, { LANG: 'de_DE.UTF-8' }), 'en');
  assert.equal(chooseLanguage(undefined, { LANG: 'dansk' }), 'da', 'the rule of the scripts: the locale starts with da');
  assert.equal(chooseLanguage(undefined, { LANG: 'Danish_Denmark.1252' }), 'da');
  assert.equal(chooseLanguage(undefined, { LANG: 'nl_NL.UTF-8' }), 'en');
  assert.equal(chooseLanguage(undefined, {}), 'en');
});

test('version prints the package version and exits 0', async () => {
  assert.equal(packageJson.version, '1.0.0');
  for (const args of [['version'], ['--version'], ['-v']]) {
    const result = await runCli(args);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, `everything-mapped ${packageJson.version}\n`);
  }
});

test('an unknown command exits 2, names the command and points to help', async () => {
  const result = await runCli(['frobnicate']);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Unknown command: frobnicate/);
  assert.match(result.stderr, /everything-mapped help/);

  const danish = await runCli(['frobnicate', '--lang', 'da']);
  assert.equal(danish.code, 2);
  assert.match(danish.stderr, /Ukendt kommando: frobnicate/);

  const flagFirst = await runCli(['--frobnicate']);
  assert.equal(flagFirst.code, 2);
});

test('an unknown command cannot reach Object.prototype names', async () => {
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const result = await runCli([name]);
    assert.equal(result.code, 2, name);
  }
});

test('a bad or missing --lang value exits 2', async () => {
  const bad = await runCli(['help', '--lang', 'fr']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /da or en/);
  const missing = await runCli(['help', '--lang']);
  assert.equal(missing.code, 2);
  const inline = await runCli(['help', '--lang=xx']);
  assert.equal(inline.code, 2);
});

test('check, next, answer, assets and pack hand their arguments to the script main and return its exit code', async () => {
  for (const [index, name] of ['check', 'next', 'answer', 'assets', 'pack'].entries()) {
    const calls = [];
    const loadScript = async (requested) => {
      assert.equal(requested, name);
      return {
        main: async (argv, io) => {
          calls.push({ argv, io });
          return index + 1;
        },
      };
    };
    const result = await runCli([name, '--root', '/some/where', '--strict', '--json'], { loadScript });
    assert.equal(result.code, index + 1, name);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].argv, ['--root', '/some/where', '--strict', '--json']);
    assert.equal(typeof calls[0].io.stdout.write, 'function');
    assert.equal(typeof calls[0].io.stderr.write, 'function');
  }
});

test('a script that cannot be loaded, or that throws, gives exit 3 (never 1, which is check --strict) and a message', async () => {
  const missing = await runCli(['check'], {
    loadScript: async () => {
      throw new Error('Cannot find module check.mjs');
    },
  });
  assert.equal(missing.code, 3);
  assert.match(missing.stderr, /Could not start the check command/);

  const throwing = await runCli(['pack'], {
    loadScript: async () => ({
      main: async () => {
        throw new Error('boom');
      },
    }),
  });
  assert.equal(throwing.code, 3);
  assert.match(throwing.stderr, /Something went wrong: boom/);
});

test('the scripts that exist in the package export main(argv, io)', async (t) => {
  const context = defaultContext();
  const present = ['check', 'next', 'answer', 'assets', 'pack'].filter((name) =>
    fs.existsSync(path.join(REPO_ROOT, 'skill', 'everything-mapped', 'scripts', `${name}.mjs`)),
  );
  if (present.length === 0) return t.skip('no script exists yet');
  if (!fs.existsSync(path.join(REPO_ROOT, 'skill', 'everything-mapped', 'scripts', 'lib', 'index.mjs'))) {
    return t.skip('the pack library (lib/index.mjs) does not exist yet');
  }
  for (const name of present) {
    const script = await context.loadScript(name);
    assert.equal(typeof script.main, 'function', `${name}.mjs must export main`);
  }
});

test('bin/cli.mjs starts with the node shebang', () => {
  const first = fs.readFileSync(path.join(REPO_ROOT, 'bin', 'cli.mjs'), 'utf8').split('\n')[0];
  assert.equal(first, '#!/usr/bin/env node');
});

test('parseArgs: values, equals form, booleans, double dash and errors', () => {
  const spec = { booleans: ['force', 'dry-run'], strings: ['dir', 'lang'], aliases: { h: 'help' } };

  assert.deepEqual(parseArgs(['--dir', 'a b', '--force'], spec), { values: { dir: 'a b', force: true }, positionals: [] });
  assert.deepEqual(parseArgs(['--dir=x=y', '--dry-run'], spec).values, { dir: 'x=y', 'dry-run': true });
  assert.deepEqual(parseArgs(['one', '--', '--force', 'two'], spec), { values: {}, positionals: ['one', '--force', 'two'] });
  assert.deepEqual(parseArgs(['-h'], spec).values, { help: true });

  const key = (args) => {
    try {
      parseArgs(args, spec);
    } catch (error) {
      assert.ok(error instanceof UsageError);
      return error.key;
    }
    return null;
  };
  assert.equal(key(['--nope']), 'ui.cli.error.unknownOption');
  assert.equal(key(['-x']), 'ui.cli.error.unknownOption');
  assert.equal(key(['--dir']), 'ui.cli.error.missingValue');
  assert.equal(key(['--dir', '--force']), 'ui.cli.error.missingValue');
  assert.equal(key(['--dir=']), 'ui.cli.error.missingValue');
  assert.equal(key(['--force=yes']), 'ui.cli.error.unexpectedValue');
  assert.equal(key(['--toString']), 'ui.cli.error.unknownOption');
});

test('findLangOption reads --lang anywhere before a double dash', () => {
  assert.equal(findLangOption(['install', '--lang', 'da']), 'da');
  assert.equal(findLangOption(['install', '--lang=en']), 'en');
  assert.equal(findLangOption(['install']), undefined);
  assert.equal(findLangOption(['--', '--lang', 'da']), undefined);
  assert.throws(() => findLangOption(['--lang', 'fr']), UsageError);
});

test('what the person typed is never sent raw to the terminal in an error message', async () => {
  const esc = String.fromCharCode(27);
  const picture = String.fromCodePoint(0x241b);
  for (const args of [[`${esc}[2J`], ['install', `--bogus${esc}[2J`], ['install', '--dir', `/nowhere${esc}[2J`]]) {
    const result = await runCli(args);
    assert.equal(result.code, 2, JSON.stringify(args));
    assert.ok(!result.stdout.includes(esc) && !result.stderr.includes(esc), JSON.stringify(args));
    assert.ok(result.stderr.includes(picture), JSON.stringify(args));
  }
});

test('-v is a top-level shortcut for the version, not an option of a command', async (t) => {
  const top = await runCli(['-v']);
  assert.equal(top.code, 0);
  for (const command of ['install', 'uninstall']) {
    const result = await runCli([command, '-v', '--claude']);
    assert.equal(result.code, 2, command);
    assert.match(result.stderr, /Unknown option: -v/);
  }
  assert.ok(t);
});
