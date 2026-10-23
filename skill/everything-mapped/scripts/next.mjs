// next.mjs [--root <dir>] [--lang da|en] [--count N] [--module X] [--depth essentials|standard|full]
// Prints as JSON the questions to ask next (FORMAT.md section 12). Only missing questions are
// returned, unless state.focus names the questions to ask. An empty folder is fine: everything is missing.
// Exit codes: 0 ok, 2 wrong use, 3 unreadable pack.

import {
  failWith,
  isMainModule,
  nextQuestions,
  openScriptContext,
  printProblems,
  remainingByLevel,
  stringifyJson,
  textOr,
  validatePack,
} from './lib/index.mjs';
import { localDate } from './lib/util.mjs';

const OPTIONS = { count: 'string', module: 'string', depth: 'string' };
const DEFAULT_COUNT = 5;

function describeQuestion(question, i18n) {
  const text = (part) => textOr(i18n, `q.${question.id}.${part}`, '');
  return {
    id: question.id,
    type: question.type,
    level: question.level,
    area: question.area,
    design: question.design === true,
    label: text('label') || question.id,
    ask: text('ask'),
    help: text('help'),
    example: text('example'),
    choices: (question.choices ?? []).map((id) => ({ id, label: textOr(i18n, `choice.${question.id}.${id}`, id) })),
    rules: question.rules ?? {},
  };
}

// Returns { options } or { error: { key, params } } for the values of --count, --module and --depth.
function readOptions(values, schema, pack) {
  const count = values.count === undefined ? DEFAULT_COUNT : Number(values.count);
  if (values.count !== undefined && (!/^\d+$/.test(values.count) || count < 1)) {
    return { error: { key: 'ui.next.err.badCount', params: { value: values.count } } };
  }
  const moduleId = values.module === undefined ? undefined : values.module.toUpperCase();
  if (moduleId !== undefined && !schema.moduleOrder.includes(moduleId)) {
    return { error: { key: 'ui.next.err.unknownModule', params: { module: values.module } } };
  }
  const depth = values.depth ?? pack.depth;
  if (!Object.hasOwn(schema.depths, depth)) return { error: { key: 'ui.check.err.badDepth', params: { depth } } };
  return { options: { count, module: moduleId, depth } };
}

function run(context, io) {
  const { values, schema, pack, i18n, language, now } = context;
  const { options, error } = readOptions(values, schema, pack);
  if (error) {
    printProblems(io.stderr, i18n, [error]);
    return 2;
  }
  const report = validatePack(pack, schema, { depth: options.depth, today: localDate(now) });
  const questions = nextQuestions(pack, schema, report, options);
  const remaining = remainingByLevel(report, schema, options.depth);
  const focusActive = Boolean(pack.state && Array.isArray(pack.state.focus) && pack.state.focus.length > 0);
  const result = {
    language,
    depth: options.depth,
    module: questions.length > 0 ? questions[0].module : (options.module ?? null),
    done: !focusActive && remaining.gate1 + remaining.recommended + remaining.optional === 0,
    remaining,
    questions: questions.map((question) => describeQuestion(question, i18n)),
  };
  io.stdout.write(`${stringifyJson(result)}\n`);
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
