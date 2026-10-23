#!/usr/bin/env node
// everything-mapped: installs the interview skill and runs the pack tools.
// install, uninstall, version and help are handled here; check, next, answer, assets and pack
// are the scripts inside the skill folder, started through their exported main(argv, io).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageError, chooseLanguage, findLangOption } from '../cli/args.mjs';
import { CliError } from '../cli/errors.mjs';
import { helpText } from '../cli/help.mjs';
import { runInstall } from '../cli/install.mjs';
import { loadText } from '../cli/text.mjs';
import { runUninstall } from '../cli/uninstall.mjs';
import { sanitizeForTerminal } from '../skill/everything-mapped/scripts/lib/util.mjs';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

// Fixed import paths on purpose: nothing typed by the user ever decides what is loaded.
const SCRIPTS = {
  check: () => import('../skill/everything-mapped/scripts/check.mjs'),
  next: () => import('../skill/everything-mapped/scripts/next.mjs'),
  answer: () => import('../skill/everything-mapped/scripts/answer.mjs'),
  assets: () => import('../skill/everything-mapped/scripts/assets.mjs'),
  pack: () => import('../skill/everything-mapped/scripts/pack.mjs'),
};

const HELP_FLAGS = ['--help', '-h'];

export function defaultIo() {
  return { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin };
}

// Everything the command reads from the machine, so tests can supply their own.
export function defaultContext() {
  return {
    cwd: process.cwd(),
    env: process.env,
    platform: process.platform,
    homedir: () => os.homedir(),
    packageRoot,
    sourceDir: path.join(packageRoot, 'skill', 'everything-mapped'),
    loadScript: (name) => SCRIPTS[name](),
  };
}

function readVersion(ctx) {
  const manifest = JSON.parse(fs.readFileSync(path.join(ctx.packageRoot, 'package.json'), 'utf8'));
  return manifest.version;
}

async function runScript(name, argv, io, ctx) {
  let script;
  try {
    script = await ctx.loadScript(name);
  } catch (error) {
    throw new CliError('ui.cli.error.loadFailed', { command: name, message: error.message }, 3);
  }
  return script.main(argv, io);
}

// Messages can contain what the person typed or a file name from their disk, so they are made safe to print.
function printError(error, io, text) {
  const { t } = text;
  const show = (stream, message) => stream.write(`${sanitizeForTerminal(message)}\n`);
  if (error instanceof UsageError) {
    show(io.stderr, t(error.key, error.params));
    show(io.stderr, t('ui.cli.help.usage'));
    show(io.stderr, t('ui.cli.error.tryHelp'));
    return 2;
  }
  if (error instanceof CliError) {
    show(io.stderr, t(error.key, error.params));
    if (error.leftBehind) show(io.stderr, t('ui.install.error.leftBehind', { path: error.leftBehind }));
    return error.exitCode;
  }
  show(io.stderr, t('ui.cli.error.unexpected', { message: error?.message ?? String(error) }));
  return 3;
}

async function dispatch(argv, io, ctx, text) {
  const [command, ...rest] = argv;
  if (command === undefined || command === 'help' || HELP_FLAGS.includes(command)) {
    io.stdout.write(helpText(text.t));
    return 0;
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    io.stdout.write(`${text.t('ui.cli.version', { version: readVersion(ctx) })}\n`);
    return 0;
  }

  const known = command === 'install' || command === 'uninstall' || Object.hasOwn(SCRIPTS, command);
  if (!known) throw new UsageError('ui.cli.error.unknownCommand', { command });
  if (rest.some((arg) => HELP_FLAGS.includes(arg))) {
    io.stdout.write(helpText(text.t));
    return 0;
  }

  if (command === 'install') return runInstall(rest, io, ctx, text);
  if (command === 'uninstall') return runUninstall(rest, io, ctx, text);
  return runScript(command, rest, io, ctx);
}

// argv: the arguments after "everything-mapped". Returns the exit code: 0 ok, 2 wrong use or a refusal
// that changed nothing, 3 a failure while reading or writing (including a script that could not be
// started). Exit code 1 is only ever returned by `check --strict`, and it comes from the script.
export async function main(argv, io = defaultIo(), ctx = defaultContext()) {
  let text = loadText(chooseLanguage(undefined, ctx.env));
  try {
    text = loadText(chooseLanguage(findLangOption(argv), ctx.env));
    return await dispatch(argv, io, ctx, text);
  } catch (error) {
    return printError(error, io, text);
  }
}

function isEntryPoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// When the reader stops early (for example "... | head"), writing fails with EPIPE. That is not an error.
function ignoreBrokenPipe(stream) {
  stream.on('error', (error) => {
    if (error.code !== 'EPIPE') throw error;
  });
}

if (isEntryPoint()) {
  ignoreBrokenPipe(process.stdout);
  ignoreBrokenPipe(process.stderr);
  process.exitCode = await main(process.argv.slice(2));
}
