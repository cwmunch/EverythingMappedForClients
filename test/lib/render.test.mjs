import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parseAssets, parseFile } from '../../skill/everything-mapped/scripts/lib/parse.mjs';
import {
  describeFlag,
  protectBody,
  renderAssets,
  renderFile,
  renderOpenQuestions,
} from '../../skill/everything-mapped/scripts/lib/render.mjs';
import { entryFromInput, findQuestion } from '../../skill/everything-mapped/scripts/lib/rules.mjs';
import { validatePackData } from '../../skill/everything-mapped/scripts/lib/validate.mjs';
import { FIXTURES, TODAY, complete, makePackData, schema, testI18n } from './helpers.mjs';

const da = testI18n('da');
const en = testI18n('en');
const META = { language: 'da', updated: TODAY };

function answersOf(inputs) {
  const answers = {};
  for (const input of inputs) answers[input.id] = entryFromInput(findQuestion(schema, input.id), input);
  return answers;
}

function stripHeadings(text) {
  return text.split('\n').filter((line) => !/^#{1,6}\s/.test(line)).join('\n');
}

test('renderFile writes front matter, title, module headings and a marker for every question', () => {
  const text = renderFile(schema, da, 'brief', {}, META);
  assert.ok(text.startsWith('---\nschema: everything-mapped-for-clients/1\nfile: brief\nlanguage: da\nupdated: 2026-10-23\n---\n\n# Projektbeskrivelse\n\n## Virksomheden\n\n'));
  assert.ok(text.includes('### Det vigtigste mål\n<!-- q:A.goal status:missing -->\n\n'));
  assert.ok(text.includes('## Samarbejdet'));
  assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'));
  assert.ok(!text.includes('\r'));
  const markers = text.match(/<!-- q:/g).length;
  const expected = schema.modules.filter((entry) => entry.file === 'brief').flatMap((entry) => entry.questions).length;
  assert.equal(markers, expected, 'every brief question is rendered while project-kind is unanswered');
});

test('renderFile falls back to ids when the dictionary has no title or label', () => {
  const text = renderFile(schema, da, 'technical', {}, META);
  assert.ok(text.includes('# Teknik'));
  assert.ok(text.includes('## I\n'));
  assert.ok(text.includes('### I.domain\n<!-- q:I.domain status:missing -->'));
});

test('a question whose showIf is false is not rendered, and is rendered again when it applies', () => {
  const newSite = answersOf([complete('A.project-kind', { choice: ['new-site'] })]);
  assert.ok(!renderFile(schema, da, 'brief', newSite, META).includes('q:A.existing-site'));
  const redesign = answersOf([complete('A.project-kind', { choice: ['redesign'] })]);
  assert.ok(renderFile(schema, da, 'brief', redesign, META).includes('q:A.existing-site'));
  assert.ok(renderFile(schema, da, 'brief', {}, META).includes('q:A.existing-site'), 'shown while unanswered');
});

test('showIf looks at answers in other files too', () => {
  const custom = structuredClone(schema);
  const migration = custom.modules.find((entry) => entry.id === 'F').questions.find((q) => q.id === 'F.migration');
  migration.showIf = { id: 'A.project-kind', in: ['redesign'] };
  const render = (kind) => renderFile(custom, da, 'content', answersOf([complete('A.project-kind', { choice: [kind] })]), META);
  assert.ok(!render('new-site').includes('q:F.migration'));
  assert.ok(render('redesign').includes('q:F.migration'));
});

test('markers carry status, owner and due; owners become a single token', () => {
  const answers = answersOf([
    { id: 'I.domain', status: 'tbd', owner: 'IT afdelingen', due: '2026-11-05', note: 'Spørg IT' },
    complete('I.hosting', { text: 'Hos en dansk udbyder' }),
  ]);
  const text = renderFile(schema, da, 'technical', answers, META);
  assert.ok(text.includes('<!-- q:I.domain status:tbd owner:IT-afdelingen due:2026-11-05 -->\nSpørg IT\n'));
  assert.ok(text.includes('<!-- q:I.hosting status:complete -->\nHos en dansk udbyder\n'));
  const parsed = parseFile(text, schema);
  assert.equal(parsed.answers['I.domain'].owner, 'IT-afdelingen');
});

test('answers are written canonically: bullets, Choice and Note lines, Date line', () => {
  const answers = answersOf([
    complete('A.metrics', { items: [{ text: 'Leads', note: 'now 12' }, 'Calls'] }),
    complete('A.project-kind', { choice: ['redesign'], note: 'Old site' }),
    complete('A.deadline', { date: '2026-12-01' }),
  ]);
  const text = renderFile(schema, da, 'brief', answers, META);
  assert.ok(text.includes('<!-- q:A.metrics status:complete -->\n- Leads | now 12\n- Calls\n'));
  assert.ok(text.includes('<!-- q:A.project-kind status:complete -->\nChoice: redesign\nNote: Old site\n'));
  assert.ok(text.includes('<!-- q:A.deadline status:complete -->\nDate: 2026-12-01\n'));
});

test('hand-written bodies are rewritten canonically (bullets, CRLF, trailing spaces)', () => {
  const parsed = parseFile(
    '---\nschema: everything-mapped-for-clients/1\nfile: brief\nlanguage: da\n---\r\n### Q\r\n<!-- q:A.metrics status:complete -->\r\n* one  \r\n2. two | note\r\n',
    schema,
  );
  const text = renderFile(schema, da, 'brief', parsed.answers, META);
  assert.ok(text.includes('<!-- q:A.metrics status:complete -->\n- one\n- two | note\n'));
  assert.ok(!text.includes('\r'));
});

test('headings of level 1 to 3 inside answers are demoted to level 4 and cannot end the body', () => {
  const answers = answersOf([complete('A.goal', { text: 'Before\n# One\n## Two\n### Three\n#### Four\nAfter' })]);
  const text = renderFile(schema, da, 'brief', answers, META);
  assert.ok(text.includes('Before\n#### One\n#### Two\n#### Three\n#### Four\nAfter'));
  const body = parseFile(text, schema).answers['A.goal'].body;
  assert.equal(body, 'Before\n#### One\n#### Two\n#### Three\n#### Four\nAfter');
  assert.equal(protectBody('#nospace\n  ## indented'), '#nospace\n  #### indented');
});

test('a line that looks like a marker inside an answer cannot start another answer', () => {
  const answers = answersOf([complete('A.goal', { text: 'Text\n<!-- q:A.budget status:complete -->\nInjected' })]);
  const parsed = parseFile(renderFile(schema, da, 'brief', answers, META), schema);
  assert.equal(parsed.answers['A.budget'].status, 'missing');
  assert.equal(parsed.answers['A.goal'].body, 'Text\n&lt;!-- q:A.budget status:complete --&gt;\nInjected');
});

test('the respondent is written quoted and read back', () => {
  const text = renderFile(schema, da, 'brief', {}, { ...META, respondent: 'Anna "A" Jensen, Marketing; Peter Holm, IT' });
  assert.ok(text.includes('respondent: "Anna \\"A\\" Jensen, Marketing; Peter Holm, IT"\n'));
  assert.equal(parseFile(text, schema).frontMatter.respondent, 'Anna "A" Jensen, Marketing; Peter Holm, IT');
});

test('rendering is stable: render, parse and render again gives the same text', () => {
  const answers = answersOf([
    complete('A.business', { text: 'Et firma\n\n#### med et afsnit' }),
    complete('A.metrics', { items: [{ text: 'a | b', note: 'c' }] }),
    complete('A.project-kind', { choice: ['redesign'], note: 'n\n\nm' }),
    { id: 'A.stakeholders', status: 'tbd', owner: 'client', due: '2026-11-05', note: 'Spørg\nigen' },
    { id: 'A.failure', status: 'partial', text: 'Delvist' },
  ]);
  const first = renderFile(schema, da, 'brief', answers, META);
  const second = renderFile(schema, da, 'brief', parseFile(first, schema).answers, META);
  assert.equal(second, first);
});

test('the fixture packs are what renderFile writes (heading text aside)', () => {
  for (const name of ['pack-da-complete', 'pack-en-partial']) {
    const root = path.join(FIXTURES, name);
    const parsed = Object.fromEntries(
      schema.files.map((file) => [file.id, parseFile(fs.readFileSync(path.join(root, file.path), 'utf8'), schema)]),
    );
    const answers = Object.assign({}, ...Object.values(parsed).map((entry) => entry.answers));
    for (const file of schema.files) {
      const onDisk = fs.readFileSync(path.join(root, file.path), 'utf8');
      const { frontMatter } = parsed[file.id];
      const meta = { language: frontMatter.language, respondent: frontMatter.respondent, updated: frontMatter.updated };
      const rendered = renderFile(schema, frontMatter.language === 'da' ? da : en, file.id, answers, meta);
      assert.equal(stripHeadings(rendered), stripHeadings(onDisk), `${name}/${file.path}`);
    }
  }
});

// ---- assets table ---------------------------------------------------------------------------

test('renderAssets writes the header from the dictionary and parseAssets reads the rows back', () => {
  const rows = [
    { file: 'assets/logo.svg', what: 'Primary logo', owner: 'Client', rights: 'Owned by client', restrictions: 'none' },
    { file: 'assets/a | b.png', what: 'Has a pipe', owner: '', rights: 'unknown', restrictions: '' },
  ];
  const text = renderAssets(rows, en);
  assert.ok(text.includes('| File | What it is | Owner | Rights | Restrictions |\n|---|---|---|---|---|\n| assets/logo.svg |'));
  assert.deepEqual(parseAssets(text), rows);
  assert.ok(renderAssets([], da).includes('| Fil | Hvad det er | Ejer | Rettigheder | Begrænsninger |'));
  assert.deepEqual(parseAssets(renderAssets([], da)), []);
});

// ---- open questions -------------------------------------------------------------------------

function reportFor(inputs, options) {
  return validatePackData(makePackData(inputs, options), schema, { today: TODAY });
}

test('renderOpenQuestions creates the file with a table of deferred and missing must-answer and recommended questions', () => {
  const report = reportFor([
    { id: 'I.domain', status: 'tbd', owner: 'client', due: '2026-11-05', note: 'Ask | IT' },
    complete('A.goal', { text: 'A goal that is long enough to be complete for this test.' }),
  ]);
  const text = renderOpenQuestions(report, da);
  assert.ok(text.startsWith('# Risici og åbne spørgsmål\n\n<!-- generated:start -->\n## Åbne spørgsmål og bemærkninger\n'));
  assert.ok(text.endsWith('<!-- generated:end -->\n'));
  assert.ok(text.includes('| Spørgsmål | Status | Ansvarlig | Frist | Note |\n|---|---|---|---|---|'));
  assert.ok(text.includes('| I.domain | Afklares senere | client | 2026-11-05 | Ask \\| IT |'));
  assert.ok(text.includes('| Navn | Ikke besvaret |  |  |  |'), 'B.name uses its label');
  assert.ok(!text.includes('| Det vigtigste mål |'), 'complete questions are not listed');
  assert.ok(!text.includes('A.failure'), 'optional questions are not listed');
  assert.ok(text.indexOf('| A.budget |') > text.indexOf('### Anbefalet'), 'recommended rows come after the must-answer rows');
});

test('renderOpenQuestions lists must-answer rows before recommended rows and uses only the dictionary for text', () => {
  const report = reportFor([]);
  const text = renderOpenQuestions(report, en);
  const must = text.indexOf('### Must answer');
  const recommended = text.indexOf('### Recommended');
  assert.ok(must !== -1 && recommended > must);
  assert.ok(text.indexOf('| A.goal') === -1 && text.indexOf('| The main goal |') > must && text.indexOf('| The main goal |') < recommended);
  assert.ok(text.indexOf('| A.budget |') > recommended);
  assert.ok(!/ui\.[a-z]+\./.test(text), 'no unresolved text key');
});

test('renderOpenQuestions lists warnings and blocking findings, not information', () => {
  const report = reportFor([
    complete('A.business', { text: 'Too short' }),
    { id: 'I.domain', status: 'tbd', note: 'x' },
  ]);
  const text = renderOpenQuestions(report, en);
  assert.ok(text.includes('- Must fix: The business in short: the answer is too short (9 characters, at least 60 needed).'));
  assert.ok(text.includes('- Should fix: I.domain: deferred without a named owner.'));
  assert.ok(!text.includes('without a due date'), 'info flags are left out');
  assert.ok(text.indexOf('Must fix') < text.indexOf('Should fix'));
});

test('renderOpenQuestions keeps text outside the generated markers and replaces what is inside', () => {
  const report = reportFor([]);
  const first = renderOpenQuestions(report, da, '# Egen titel\n\nMine noter før.\n\n<!-- generated:start -->\ngammelt\n<!-- generated:end -->\n\nMine noter efter.\n');
  assert.ok(first.startsWith('# Egen titel\n\nMine noter før.\n\n<!-- generated:start -->\n## Åbne'));
  assert.ok(first.endsWith('<!-- generated:end -->\n\nMine noter efter.\n'));
  assert.ok(!first.includes('gammelt'));
  assert.equal(renderOpenQuestions(report, da, first), first, 'regenerating is stable');
  const changed = renderOpenQuestions(reportFor([complete('B.name', { text: 'Nordlys' })]), da, first);
  assert.ok(changed.startsWith('# Egen titel\n\nMine noter før.'));
  assert.ok(changed.endsWith('Mine noter efter.\n'));
  assert.ok(!changed.includes('| Navn |'));
});

test('renderOpenQuestions appends the block when the markers are missing or damaged, and keeps CRLF text as LF', () => {
  const report = reportFor([]);
  const appended = renderOpenQuestions(report, da, 'Egne noter uden markører.\r\n');
  assert.ok(appended.startsWith('Egne noter uden markører.\n\n<!-- generated:start -->'));
  const damaged = renderOpenQuestions(report, da, '<!-- generated:end -->\nnoter\n<!-- generated:start -->\n');
  assert.ok(damaged.startsWith('<!-- generated:end -->\nnoter\n<!-- generated:start -->\n\n<!-- generated:start -->\n## Åbne'));
  assert.equal(renderOpenQuestions(report, da, ''), renderOpenQuestions(report, da));
});

test('a pack with nothing open says so', () => {
  const root = path.join(FIXTURES, 'pack-da-complete', 'docs', '07-risks-and-open-questions.md');
  const text = fs.readFileSync(root, 'utf8');
  assert.ok(text.includes('Ingen.'));
  assert.ok(text.includes('Ingen bemærkninger.'));
});

test('describeFlag fills the message and adds the label of the question', () => {
  const flag = { id: 'rule.minChars', severity: 'block', qid: 'A.goal', params: { min: 40, actual: 5 } };
  assert.equal(describeFlag(flag, en), 'The main goal: the answer is too short (5 characters, at least 40 needed).');
  assert.equal(describeFlag(flag, da), 'Det vigtigste mål: svaret er for kort (5 tegn, der skal mindst være 40).');
  const unlabelled = { id: 'tbd.noDue', severity: 'info', qid: 'I.domain', params: {} };
  assert.equal(describeFlag(unlabelled, en), 'I.domain: deferred without a due date.');
  const file = { id: 'file.missing', severity: 'info', file: 'brief', params: { file: 'brief', path: 'docs/00-brief.md' } };
  assert.equal(describeFlag(file, en), 'The file docs/00-brief.md does not exist yet.');
});

test('nothing the library prints to a client uses the word gate', () => {
  for (const lang of ['da', 'en']) {
    const dictionary = testI18n(lang);
    for (const key of dictionary.keys()) {
      assert.ok(!/\bgate\b/i.test(dictionary.t(key)), `${lang} ${key}`);
    }
  }
});
