// check.mjs [--root <dir>] [--lang da|en] [--depth essentials|standard|full] [--json] [--strict] [--write]
// Reads the pack and says what is missing. With --write it also refreshes the manifest and the
// open-questions file (when no answer has set the language of the pack yet it writes nothing and says
// so; the language is never taken from the console). Exit codes: 0 ok, 1 must-answer questions open (only with --strict),
// 2 wrong use, 3 no pack or an unreadable pack. (FORMAT.md section 12)

import {
  describeFlag,
  failWith,
  isEmptyPack,
  isMainModule,
  openScriptContext,
  printProblems,
  questionLabel,
  refreshPack,
  reportSwept,
  sanitizeForTerminal,
  stringifyJson,
  textOr,
  validatePack,
} from './lib/index.mjs';
import { MAX_LISTED_ITEMS, localDate } from './lib/util.mjs';

const OPTIONS = { json: 'boolean', strict: 'boolean', write: 'boolean', depth: 'string' };
const SEVERITIES = ['block', 'warn', 'info'];
const SEVERITY_KEYS = { block: 'ui.check.sev.block', warn: 'ui.check.sev.warn', info: 'ui.check.sev.info' };
const DEPTH_KEYS = {
  essentials: 'ui.check.depthName.essentials',
  standard: 'ui.check.depthName.standard',
  full: 'ui.check.depthName.full',
};

function depthName(depth, i18n) {
  return textOr(i18n, `depth.${depth}`, DEPTH_KEYS[depth] ? i18n.t(DEPTH_KEYS[depth]) : depth);
}

function nextSteps(report, i18n) {
  const steps = [];
  const hasBlockingFlag = report.flags.some((flag) => flag.severity === 'block');
  if (!report.gate1.ready) steps.push(i18n.t('ui.check.next.answer'));
  if (hasBlockingFlag) steps.push(i18n.t('ui.check.next.fix'));
  if (report.completeness.counts.tbd > 0) steps.push(i18n.t('ui.check.next.tbd'));
  if (report.flags.some((flag) => flag.id.startsWith('assets.'))) steps.push(i18n.t('ui.check.next.assets'));
  if (report.gate1.ready && !hasBlockingFlag) steps.push(i18n.t('ui.check.next.pack'));
  return steps;
}

function blockerLine(id, i18n) {
  const label = questionLabel(i18n, id);
  return label === id ? `  - ${id}` : `  - ${id}  ${label}`;
}

function formatReport(report, context) {
  const { i18n, root } = context;
  const { counts, overall } = report.completeness;
  const lines = [
    report.gate1.ready ? i18n.t('ui.check.verdict.ready') : i18n.t('ui.check.verdict.notReady', { count: report.gate1.blocking.length }),
    '',
    i18n.t('ui.check.root', { root }),
    i18n.t('ui.check.depth', { depth: depthName(report.depth, i18n) }),
    i18n.t('ui.check.overall', { percent: Math.round(overall * 100) }),
    i18n.t('ui.check.counts', counts),
  ];
  if (report.gate1.blocking.length > 0) {
    lines.push('', `${i18n.t('ui.check.blocking.heading')}:`);
    lines.push(...report.gate1.blocking.map((id) => blockerLine(id, i18n)));
  }
  for (const severity of SEVERITIES) {
    const flags = report.flags.filter((flag) => flag.severity === severity);
    if (flags.length === 0) continue;
    lines.push('', `${i18n.t(SEVERITY_KEYS[severity])}:`);
    lines.push(...flags.slice(0, MAX_LISTED_ITEMS).map((flag) => `  - ${describeFlag(flag, i18n)}`));
    if (flags.length > MAX_LISTED_ITEMS) lines.push(`  - ${i18n.t('ui.check.more', { count: flags.length - MAX_LISTED_ITEMS })}`);
  }
  const steps = nextSteps(report, i18n);
  if (steps.length > 0) {
    lines.push('', `${i18n.t('ui.check.next.heading')}:`);
    lines.push(...steps.map((step) => `  - ${step}`));
  }
  return lines;
}

function run(context, io) {
  const { values, root, schema, pack, i18n, now } = context;
  if (isEmptyPack(pack)) {
    printProblems(io.stderr, i18n, [{ key: 'ui.check.err.noPack', params: { root } }]);
    return 3;
  }
  const depth = values.depth ?? pack.depth;
  if (!Object.hasOwn(schema.depths, depth)) {
    printProblems(io.stderr, i18n, [{ key: 'ui.check.err.badDepth', params: { depth } }]);
    return 2;
  }
  const today = localDate(now);
  let report = validatePack(pack, schema, { depth, today });
  let written = [];
  if (values.write && !pack.language) {
    // The language of a pack is set by its first answer, not by the language of the console.
    io.stderr.write(`${sanitizeForTerminal(i18n.t('ui.check.noLanguageWrite'))}\n`);
  } else if (values.write) {
    const refreshed = refreshPack(root, { schema, schemaDir: context.schemaDir, depth, now, today });
    report = refreshed.report;
    written = refreshed.written;
    reportSwept(io.stderr, i18n, refreshed.swept);
  }
  if (values.json) {
    const completeness = { ...report.completeness, gate1Ready: report.gate1.ready, gate1Blocking: report.gate1.blocking };
    io.stdout.write(`${stringifyJson({ ...report, completeness, written })}\n`);
  } else {
    const lines = formatReport(report, context);
    for (const file of written) lines.push(i18n.t('ui.check.written', { path: file }));
    io.stdout.write(`${sanitizeForTerminal(lines.join('\n'), { keepLineBreaks: true })}\n`);
  }
  return values.strict && !report.gate1.ready ? 1 : 0;
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
