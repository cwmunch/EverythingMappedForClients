// answer.mjs --from <file.json> [--delete] [--root <dir>] [--lang da|en]
// Merges answers into the pack, creating it on first use, and refreshes state, manifest and the
// open-questions file. With --delete the input file is removed after a successful write.
// Prints { written, gate1, overall, next } as JSON. Exit codes: 0 ok, 2 bad input (nothing is
// written), 3 unreadable pack. (FORMAT.md section 12)

import fs from 'node:fs';
import path from 'node:path';
import {
  applyAnswers,
  failWith,
  isMainModule,
  nextQuestions,
  openScriptContext,
  printProblems,
  readInputFile,
  reportSwept,
  stringifyJson,
} from './lib/index.mjs';
import { InputError, localDate } from './lib/util.mjs';

const OPTIONS = { from: 'string', delete: 'boolean' };
const NEXT_COUNT = 3;

const READ_PROBLEMS = { notFile: 'ui.answer.err.notAFile', tooLarge: 'ui.answer.err.fileTooLarge', unreadable: 'ui.answer.err.cannotRead' };

function readInput(file) {
  const { text, problem } = readInputFile(file);
  if (problem) throw new InputError([{ key: READ_PROBLEMS[problem], params: { path: file, limit: '2 MB' } }]);
  try {
    return JSON.parse(text);
  } catch {
    throw new InputError([{ key: 'ui.answer.err.badJson', params: { path: file } }]);
  }
}

// --lang names the language of a new pack when the input does not.
function withLanguage(input, context) {
  const { values, pack } = context;
  const canTakeLanguage = input && typeof input === 'object' && !Array.isArray(input) && input.language === undefined;
  return canTakeLanguage && values.lang && !pack.language ? { ...input, language: values.lang } : input;
}

function run(context, io) {
  const { values, root, schema, schemaDir, now } = context;
  if (values.from === undefined) throw new InputError([{ key: 'ui.answer.err.fromRequired', params: {} }]);
  const file = path.resolve(context.cwd, values.from);
  const input = withLanguage(readInput(file), context);
  const result = applyAnswers(root, input, { schema, schemaDir, now, today: localDate(now) });
  const next = nextQuestions(result.pack, schema, result.report, { count: NEXT_COUNT }).map((question) => question.id);
  const summary = {
    written: result.written,
    gate1: result.report.gate1,
    overall: result.report.completeness.overall,
    next,
  };
  io.stdout.write(`${stringifyJson(summary)}\n`);
  reportSwept(io.stderr, context.i18n, result.swept);
  // The answers are saved. A file that cannot be removed is a warning, not a failure.
  if (values.delete) {
    try {
      fs.rmSync(file, { force: true });
    } catch (error) {
      printProblems(io.stderr, context.i18n, [{ key: 'ui.answer.warn.deleteFailed', params: { path: file, code: error && error.code ? String(error.code) : 'EIO' } }]);
    }
  }
  return 0;
}

export async function main(argv, io = { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin }) {
  let context = null;
  try {
    context = openScriptContext(argv, io, OPTIONS);
    if (context.exitCode !== undefined) return context.exitCode;
    return run(context, io);
  } catch (error) {
    return failWith(error, io, context && context.i18n);
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
