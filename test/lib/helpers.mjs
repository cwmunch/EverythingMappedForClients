// Shared helpers for the library tests: paths, a small in-memory dictionary, temp folders,
// captured script output and helpers that make in-memory pack data.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { entryFromInput, findQuestion, loadSchema, makeI18n } from '../../skill/everything-mapped/scripts/lib/index.mjs';

export const CLIENT_ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
export const SKILL_DIR = path.join(CLIENT_ROOT, 'skill', 'everything-mapped');
export const SCHEMA_DIR = path.join(SKILL_DIR, 'schema');
export const SCRIPTS_DIR = path.join(SKILL_DIR, 'scripts');
export const LIB_DIR = path.join(SCRIPTS_DIR, 'lib');
export const FIXTURES = path.join(CLIENT_ROOT, 'test', 'fixtures');

// A fixed moment, in the middle of the day so the local date is the same in every time zone.
export const NOW = new Date('2026-10-23T12:00:00Z');
export const TODAY = '2026-10-23';

export const schema = loadSchema();

// Every flag id of FORMAT.md section 14.
export const FLAG_IDS = [
  'file.missing',
  'file.badFrontMatter',
  'file.languageMismatch',
  'marker.unknownQuestion',
  'marker.duplicate',
  'marker.badStatus',
  'file.strayText',
  'text.hiddenCharacters',
  'rule.minChars',
  'rule.minItems',
  'rule.badChoice',
  'rule.noChoice',
  'rule.notUrl',
  'rule.badDate',
  'rule.dateInPast',
  'tbd.noOwner',
  'tbd.noDue',
  'assets.unlisted',
  'assets.missingFile',
  'assets.noRights',
  'assets.rightsUnknown',
  'assets.badName',
  'assets.notPackable',
  'assets.tooLarge',
  'assets.tooMany',
  'answer.notApplicable',
  'pack.tooBig',
  'cross.languagesVsMultilingual',
  'cross.redesignNoSite',
  'cross.assetsClaimedMissing',
  'cross.designInputsThin',
];

// The few question texts the tests rely on. The real texts live in texts.<lang>.json.
const TEST_TEXTS = {
  da: {
    'file.brief.title': 'Projektbeskrivelse',
    'file.brand.title': 'Brand',
    'file.audience.title': 'Målgruppe og marked',
    'file.content.title': 'Indhold',
    'file.scope.title': 'Omfang',
    'file.technical.title': 'Teknik',
    'module.A.title': 'Virksomheden',
    'module.B.title': 'Brandet',
    'module.J.title': 'Samarbejdet',
    'q.A.goal.label': 'Det vigtigste mål',
    'q.A.business.label': 'Virksomheden kort fortalt',
    'q.A.project-kind.label': 'Type af projekt',
    'q.B.name.label': 'Navn',
    'q.B.personality.label': 'Personlighed',
    'q.A.goal.ask': 'Hvad er det vigtigste mål?',
    'choice.A.project-kind.redesign': 'Redesign',
    'status.tbd': 'Afklares senere',
    'status.missing': 'Ikke besvaret',
  },
  en: {
    'file.brief.title': 'Project brief',
    'file.brand.title': 'Brand',
    'file.audience.title': 'Audience and market',
    'file.content.title': 'Content',
    'file.scope.title': 'Scope',
    'file.technical.title': 'Technical',
    'module.A.title': 'The business',
    'module.B.title': 'The brand',
    'module.J.title': 'Working together',
    'q.A.goal.label': 'The main goal',
    'q.A.business.label': 'The business in short',
    'q.A.project-kind.label': 'Kind of project',
    'q.B.name.label': 'Name',
    'q.B.personality.label': 'Personality',
    'q.A.goal.ask': 'What is the main goal?',
    'choice.A.project-kind.redesign': 'Redesign',
    'status.tbd': 'To be decided',
    'status.missing': 'Not answered',
  },
};

export function testTexts(lang) {
  const ui = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, `ui-check.${lang}.json`), 'utf8'));
  return { ...ui, ...TEST_TEXTS[lang] };
}

// An in-memory dictionary: the real ui-check texts plus the small test dictionary above.
export function testI18n(lang) {
  return makeI18n(testTexts(lang), lang);
}

// A schema folder for the scripts with the same dictionary, so tests do not depend on the real texts.
export function makeSchemaDir(t) {
  const dir = makeTempDir(t);
  fs.copyFileSync(path.join(SCHEMA_DIR, 'intake-schema.json'), path.join(dir, 'intake-schema.json'));
  for (const lang of ['da', 'en']) {
    fs.writeFileSync(path.join(dir, `texts.${lang}.json`), JSON.stringify(testTexts(lang), null, 2));
  }
  return dir;
}

export function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emfc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function copyFolder(source, target) {
  fs.cpSync(source, target, { recursive: true });
}

// Output captured from a script. io.cwd and io.env are set so the tests never depend on the real ones.
export function captureIo(options = {}) {
  const stdout = [];
  const stderr = [];
  const io = {
    stdout: { write: (text) => stdout.push(text) },
    stderr: { write: (text) => stderr.push(text) },
    stdin: null,
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? {},
    now: () => NOW,
  };
  if (options.schemaDir) io.schemaDir = options.schemaDir;
  return { io, out: () => stdout.join(''), err: () => stderr.join('') };
}

export async function runScript(main, argv, options = {}) {
  const captured = captureIo(options);
  const code = await main(argv, captured.io);
  return { code, out: captured.out(), err: captured.err() };
}

// CPU time of this process in milliseconds. The timing tests measure work, not the wait for a busy
// computer, so they use this and not the clock. Their limits are far above what the work takes on
// its own (about half a second) and far below what a pattern that backtracks would take (minutes),
// so that a computer that is busy with other work does not make them fail.
export const WORK_LIMIT_MS = 2500;
export function cpuNow() {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function writeText(root, relative, text) {
  const target = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}

// In-memory pack data (the input of validatePackData) from answers written like answer.mjs input.
export function makePackData(inputs, options = {}) {
  const language = options.language ?? 'da';
  const files = {};
  for (const file of schema.files) {
    files[file.id] = {
      path: file.path,
      exists: true,
      frontMatter: { schema: schema.schema, file: file.id, language, updated: TODAY },
      answers: {},
      flags: [],
    };
  }
  for (const input of inputs) {
    const question = findQuestion(schema, input.id);
    files[question.file].answers[input.id] = entryFromInput(question, input);
  }
  return {
    language,
    depth: options.depth ?? 'standard',
    files,
    assets: options.assets ?? { rows: [], present: [] },
    manifest: null,
    state: options.state ?? null,
  };
}

export function complete(id, fields) {
  return { id, status: 'complete', ...fields };
}

export function flagIds(report) {
  return report.flags.map((flag) => flag.id);
}

export function flagsFor(report, qid) {
  return report.flags.filter((flag) => flag.qid === qid);
}
