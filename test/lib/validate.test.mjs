import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { describeFlag, makeI18n, parsePack } from '../../skill/everything-mapped/scripts/lib/index.mjs';
import { questionsInOrder } from '../../skill/everything-mapped/scripts/lib/rules.mjs';
import {
  manifestCompleteness,
  nextQuestions,
  remainingByLevel,
  validatePack,
  validatePackData,
} from '../../skill/everything-mapped/scripts/lib/validate.mjs';
import { FIXTURES, FLAG_IDS, TODAY, complete, flagIds, flagsFor, makePackData, readJson, schema, testTexts } from './helpers.mjs';

const COMPLETE_INPUT = readJson(path.join(FIXTURES, 'inputs', 'da-complete.json')).answers;

// The one file the complete pack lists, so the assets give no findings unless a test asks for them.
const LISTED_LOGO = {
  rows: [{ file: 'assets/logo.svg', what: 'Logo', owner: 'Kunden', rights: 'Ejes af kunden', restrictions: '' }],
  present: ['logo.svg'],
};

function validate(inputs, options = {}) {
  const withAssets = { assets: LISTED_LOGO, ...options };
  return validatePackData(makePackData(inputs, withAssets), schema, { today: TODAY, depth: options.depth });
}

function without(id) {
  return COMPLETE_INPUT.filter((input) => input.id !== id);
}

function replace(id, input) {
  return COMPLETE_INPUT.map((existing) => (existing.id === id ? { id, ...input } : existing));
}

// ---- the report and Gate 1 -------------------------------------------------------------------

test('the report has the shape of FORMAT.md section 11', () => {
  const report = validate([]);
  assert.deepEqual(Object.keys(report), ['language', 'depth', 'questions', 'gate1', 'completeness', 'flags']);
  assert.equal(report.language, 'da');
  assert.equal(report.depth, 'standard');
  assert.deepEqual(Object.keys(report.completeness), ['overall', 'counts', 'byModule', 'byFile', 'byArea']);
  assert.deepEqual(Object.keys(report.completeness.counts), ['complete', 'partial', 'tbd', 'missing', 'skipped']);
  assert.deepEqual(Object.keys(report.questions['A.goal']).slice(0, 4), ['status', 'declared', 'level', 'flags']);
  assert.deepEqual(Object.keys(report.questions), questionsInOrder(schema).map((question) => question.id));
  assert.deepEqual(Object.keys(report.gate1), ['ready', 'blocking']);
});

test('a complete pack is ready at every depth with full coverage and no findings', () => {
  for (const depth of ['essentials', 'standard', 'full']) {
    const report = validate(COMPLETE_INPUT, { depth });
    assert.equal(report.gate1.ready, true, depth);
    assert.deepEqual(report.gate1.blocking, []);
    assert.equal(report.completeness.overall, 1);
    assert.deepEqual(report.flags, []);
  }
  const counts = validate(COMPLETE_INPUT, { depth: 'full' }).completeness.counts;
  assert.deepEqual(counts, { complete: 97, partial: 0, tbd: 0, missing: 0, skipped: 0 });
});

test('an empty pack is not ready and blocks on every must-answer question', () => {
  const report = validate([]);
  assert.equal(report.gate1.ready, false);
  const expected = questionsInOrder(schema).filter((question) => question.level === 'gate1').map((question) => question.id);
  assert.deepEqual(report.gate1.blocking, expected);
  assert.equal(report.completeness.overall, 0);
});

test('Gate 1 is ready exactly when every gate1 question is complete, ignoring other questions', () => {
  const full = validate(COMPLETE_INPUT, { depth: 'full' });
  const gate1Ids = new Set(Object.keys(full.questions).filter((id) => full.questions[id].level === 'gate1'));
  const onlyGate1 = COMPLETE_INPUT.filter((input) => gate1Ids.has(input.id));
  const report = validate(onlyGate1);
  assert.equal(report.gate1.ready, true);
  assert.ok(report.completeness.overall < 1 && report.completeness.overall > 0);
  const oneLess = validate(onlyGate1.filter((input) => input.id !== 'D.action'));
  assert.deepEqual(oneLess.gate1.blocking, ['D.action']);
});

test('a partial, deferred or downgraded answer does not satisfy Gate 1', () => {
  assert.deepEqual(validate(replace('A.goal', { status: 'partial', text: 'Delvist' })).gate1.blocking, ['A.goal']);
  assert.deepEqual(validate(replace('A.goal', { status: 'tbd', owner: 'client', due: '2026-11-05', note: 'Senere' })).gate1.blocking, ['A.goal']);
  assert.deepEqual(validate(replace('A.goal', { status: 'complete', text: 'For kort' })).gate1.blocking, ['A.goal']);
  assert.deepEqual(validate(without('A.goal')).gate1.blocking, ['A.goal']);
});

test('requiredIf: a redesign makes F.migration a Gate 1 question', () => {
  const redesign = validate(without('F.migration'));
  assert.equal(redesign.questions['F.migration'].level, 'gate1');
  assert.deepEqual(redesign.gate1.blocking, ['F.migration']);
  const newSite = validate(replace('A.project-kind', { status: 'complete', choice: ['new-site'] }).filter((input) => input.id !== 'F.migration' && input.id !== 'A.existing-site'));
  assert.equal(newSite.questions['F.migration'].level, 'recommended');
  assert.equal(newSite.gate1.ready, true);
});

test('showIf: A.existing-site is skipped for a new site and then neither counted nor blocking', () => {
  const report = validate(replace('A.project-kind', { status: 'complete', choice: ['new-site'] }), { depth: 'full' });
  assert.deepEqual(report.questions['A.existing-site'].level, 'skipped');
  assert.equal(report.questions['A.existing-site'].status, 'skipped');
  assert.equal(report.questions['A.existing-site'].declared, 'complete', 'the declared status is still reported');
  assert.equal(report.completeness.counts.skipped, 1);
  assert.equal(report.completeness.counts.complete, 96);
  assert.equal(report.completeness.overall, 1);
  assert.deepEqual(report.questions['A.existing-site'].flags, []);
});

test('requiredIf minSelected: two languages make G.multilingual a Gate 1 question', () => {
  const report = validate(without('G.multilingual'));
  assert.equal(report.questions['G.multilingual'].level, 'gate1');
  assert.deepEqual(report.gate1.blocking, ['G.multilingual']);
  const oneLanguage = validate([
    ...replace('D.languages', { status: 'complete', choice: ['da'] }).filter((input) => input.id !== 'G.multilingual'),
  ]);
  assert.equal(oneLanguage.questions['G.multilingual'].level, 'recommended');
  assert.equal(oneLanguage.gate1.ready, true);
});

test('requiredIf notIn: editing needs make H.who-edits a Gate 1 question unless nobody edits', () => {
  const regular = validate(without('H.who-edits'));
  assert.equal(regular.questions['H.who-edits'].level, 'gate1');
  assert.deepEqual(regular.gate1.blocking, ['H.who-edits']);
  const nobody = validate(replace('H.editing-needs', { status: 'complete', choice: ['nobody'] }).filter((input) => input.id !== 'H.who-edits'));
  assert.equal(nobody.questions['H.who-edits'].level, 'recommended');
  assert.equal(nobody.gate1.ready, true);
});

test('requiredIf in: brand material that exists makes B.logo a Gate 1 question', () => {
  const guidelines = validate(without('B.logo'));
  assert.equal(guidelines.questions['B.logo'].level, 'gate1');
  assert.deepEqual(guidelines.gate1.blocking, ['B.logo']);
  const none = validate(replace('B.assets-status', { status: 'complete', choice: ['none'] }).filter((input) => input.id !== 'B.logo'));
  assert.equal(none.questions['B.logo'].level, 'recommended');
  assert.equal(none.gate1.ready, true);
});

// ---- downgrades and rule flags ---------------------------------------------------------------

function onlyFlag(report, qid) {
  const flags = flagsFor(report, qid);
  assert.equal(flags.length, 1, `${qid}: ${flags.map((flag) => flag.id)}`);
  return flags[0];
}

test('rule.minChars: a complete answer that is too short becomes partial and blocks for a Gate 1 question', () => {
  const report = validate(replace('A.business', { status: 'complete', text: 'Kort tekst' }));
  assert.equal(report.questions['A.business'].status, 'partial');
  assert.equal(report.questions['A.business'].declared, 'complete');
  assert.deepEqual(onlyFlag(report, 'A.business'), {
    id: 'rule.minChars',
    severity: 'block',
    qid: 'A.business',
    file: 'brief',
    params: { min: 60, actual: 10 },
  });
  assert.deepEqual(report.questions['A.business'].flags, [{ id: 'rule.minChars', severity: 'block', params: { min: 60, actual: 10 } }]);
});

test('minChars counts characters after trimming and stripping bullets', () => {
  const text = `- ${'x'.repeat(60)}`;
  assert.equal(validate(replace('A.business', { status: 'complete', text })).questions['A.business'].status, 'complete');
  assert.equal(validate(replace('A.business', { status: 'complete', text: `${'x'.repeat(59)}   ` })).questions['A.business'].status, 'partial');
});

test('rule flags are warnings when the effective level is not Gate 1', () => {
  const custom = structuredClone(schema);
  custom.modules.find((entry) => entry.id === 'A').questions.find((q) => q.id === 'A.budget').rules = { minChars: 10 };
  const data = makePackData([complete('A.budget', { text: 'Lidt' })]);
  const report = validatePackData(data, custom, { today: TODAY });
  assert.equal(onlyFlag(report, 'A.budget').severity, 'warn');
  assert.equal(report.questions['A.budget'].status, 'partial');
});

test('rule.minItems: too few items make the answer partial; block for Gate 1, warn otherwise', () => {
  const blocking = validate(replace('B.personality', { status: 'complete', items: [{ text: 'Venlig' }, { text: 'Jordnær' }] }));
  assert.equal(blocking.questions['B.personality'].status, 'partial');
  assert.deepEqual(onlyFlag(blocking, 'B.personality').params, { min: 5, actual: 2 });
  assert.equal(onlyFlag(blocking, 'B.personality').severity, 'block');
  const warning = validate(replace('B.values', { status: 'complete', items: [{ text: 'Ærlighed' }] }));
  assert.equal(warning.questions['B.values'].status, 'partial');
  assert.equal(onlyFlag(warning, 'B.values').severity, 'warn');
});

test('a complete answer without any content is missing, with the rule flag when the question has a rule', () => {
  const entry = { id: 'A.metrics', status: 'complete', items: [{ text: 'x' }] };
  const data = makePackData([entry]);
  data.files.brief.answers['A.metrics'] = { status: 'complete', owner: '', due: '', body: '', value: { items: [] } };
  data.files.brief.answers['A.budget'] = { status: 'complete', owner: '', due: '', body: '', value: { text: '' } };
  const report = validatePackData(data, schema, { today: TODAY });
  assert.equal(report.questions['A.metrics'].status, 'missing');
  assert.equal(onlyFlag(report, 'A.metrics').id, 'rule.minItems');
  assert.equal(report.questions['A.budget'].status, 'missing');
  assert.deepEqual(flagsFor(report, 'A.budget'), []);
});

test('rule.noChoice: a complete choice answer without a Choice line is missing and blocks for Gate 1', () => {
  const data = makePackData([]);
  data.files.brand.answers['B.assets-status'] = { status: 'complete', owner: '', due: '', body: 'Noget', value: { choice: [], note: 'Noget' } };
  const report = validatePackData(data, schema, { today: TODAY });
  assert.equal(report.questions['B.assets-status'].status, 'missing');
  assert.equal(onlyFlag(report, 'B.assets-status').id, 'rule.noChoice');
  assert.equal(onlyFlag(report, 'B.assets-status').severity, 'block');
});

test('rule.badChoice: unknown ids are warnings; with no valid id left the answer is partial', () => {
  const data = makePackData([]);
  const put = (id, choice) => {
    const question = questionsInOrder(schema).find((q) => q.id === id);
    data.files[question.file].answers[id] = { status: 'complete', owner: '', due: '', body: '', value: { choice, note: '' } };
  };
  put('D.channels', ['search', 'bogus']);
  put('A.project-kind', ['bogus']);
  put('C.change-rate', ['weekly', 'daily']);
  const report = validatePackData(data, schema, { today: TODAY });
  assert.equal(report.questions['D.channels'].status, 'complete');
  assert.deepEqual(onlyFlag(report, 'D.channels'), { id: 'rule.badChoice', severity: 'warn', qid: 'D.channels', file: 'audience', params: { choice: 'bogus' } });
  assert.equal(report.questions['A.project-kind'].status, 'partial');
  assert.equal(onlyFlag(report, 'A.project-kind').severity, 'warn', 'badChoice is always a warning');
  assert.equal(report.questions['C.change-rate'].status, 'complete', 'the first of two single choices is used');
  assert.deepEqual(onlyFlag(report, 'C.change-rate').params, { choice: 'daily' });
});

test('rule.badDate: an invalid date makes a complete answer partial and blocks for Gate 1', () => {
  const data = makePackData([]);
  data.files.brief.answers['A.deadline'] = { status: 'complete', owner: '', due: '', body: 'Date: 1. december', value: { date: '1. december', note: '' } };
  const report = validatePackData(data, schema, { today: TODAY });
  assert.equal(report.questions['A.deadline'].status, 'partial');
  assert.deepEqual(onlyFlag(report, 'A.deadline').params, { value: '1. december' });
  assert.equal(onlyFlag(report, 'A.deadline').severity, 'block');
  data.files.brief.answers['A.deadline'] = { status: 'complete', owner: '', due: '', body: '', value: { date: '', note: '' } };
  const empty = validatePackData(data, schema, { today: TODAY });
  assert.equal(empty.questions['A.deadline'].status, 'missing');
  assert.equal(onlyFlag(empty, 'A.deadline').id, 'rule.badDate');
});

test('rule.dateInPast: a valid date before today is a warning and the answer stays complete', () => {
  const past = validate(replace('A.deadline', { status: 'complete', date: '2026-10-22' }));
  assert.equal(past.questions['A.deadline'].status, 'complete');
  assert.deepEqual(onlyFlag(past, 'A.deadline'), { id: 'rule.dateInPast', severity: 'warn', qid: 'A.deadline', file: 'brief', params: { date: '2026-10-22' } });
  assert.deepEqual(flagsFor(validate(replace('A.deadline', { status: 'complete', date: TODAY })), 'A.deadline'), [], 'today is not in the past');
  const later = validatePackData(makePackData(replace('A.deadline', { status: 'complete', date: '2026-10-22' })), schema, { today: '2026-10-22' });
  assert.deepEqual(flagsFor(later, 'A.deadline'), []);
});

test('rule.notUrl: only E.like, E.dislike, E.competitors and A.existing-site need web addresses', () => {
  const items = [{ text: 'https://example.com/a' }, { text: 'www.example.org/b', note: 'x' }, { text: 'example.net' }, { text: 'Noget roligt' }, { text: 'Se (https://example.dk/c) her' }];
  const report = validate(replace('E.like', { status: 'complete', items }));
  assert.deepEqual(flagsFor(report, 'E.like').map((flag) => [flag.id, flag.params.item]), [['rule.notUrl', 'Noget roligt']]);
  assert.equal(report.questions['E.like'].status, 'complete', 'a warning does not downgrade');
  const other = validate(replace('B.admired', { status: 'complete', items: [{ text: 'Noget roligt' }] }));
  assert.deepEqual(flagsFor(other, 'B.admired'), []);
  for (const id of ['E.dislike', 'E.competitors', 'A.existing-site']) {
    const input = { status: 'complete', items: [{ text: 'no address here' }, { text: 'x' }, { text: 'y' }] };
    assert.equal(flagsFor(validate(replace(id, input)), id).length, 3, id);
  }
});

test('a partial answer keeps its data problems but gets no size or completeness findings', () => {
  const report = validate([
    { id: 'A.business', status: 'partial', text: 'Kort' },
    { id: 'E.like', status: 'partial', items: [{ text: 'ikke en adresse' }] },
    { id: 'B.personality', status: 'partial', items: [{ text: 'Venlig' }] },
  ]);
  assert.deepEqual(flagsFor(report, 'A.business'), []);
  assert.deepEqual(flagsFor(report, 'B.personality'), []);
  assert.deepEqual(flagsFor(report, 'E.like').map((flag) => flag.id), ['rule.notUrl']);
  assert.equal(report.questions['A.business'].status, 'partial');
});

test('a partial answer without content is missing', () => {
  const data = makePackData([]);
  data.files.brief.answers['A.goal'] = { status: 'partial', owner: '', due: '', body: '', value: { text: '' } };
  assert.equal(validatePackData(data, schema, { today: TODAY }).questions['A.goal'].status, 'missing');
});

test('tbd without owner or due gives tbd.noOwner (warn) and tbd.noDue (info); with both there is nothing', () => {
  const bare = validate([{ id: 'I.domain', status: 'tbd', note: 'Spørg IT' }]);
  assert.deepEqual(flagsFor(bare, 'I.domain').map((flag) => [flag.id, flag.severity]), [['tbd.noOwner', 'warn'], ['tbd.noDue', 'info']]);
  assert.equal(bare.questions['I.domain'].status, 'tbd');
  assert.equal(bare.questions['I.domain'].note, 'Spørg IT');
  const full = validate([{ id: 'I.domain', status: 'tbd', owner: 'client', due: '2026-11-05', note: 'x' }]);
  assert.deepEqual(flagsFor(full, 'I.domain'), []);
  assert.equal(full.questions['I.domain'].owner, 'client');
  assert.equal(full.questions['I.domain'].due, '2026-11-05');
});

test('a missing answer has no findings and no note, owner or due', () => {
  const entry = validate([]).questions['I.domain'];
  assert.deepEqual(entry, { status: 'missing', declared: 'missing', level: 'gate1', flags: [], owner: '', due: '', note: '', inScope: true });
});

// ---- pack level findings ---------------------------------------------------------------------

test('cross.languagesVsMultilingual: two languages without the multilingual feature', () => {
  const features = (choice) => replace('G.features', { status: 'complete', choice });
  assert.deepEqual(flagIds(validate(features(['contact-form']))), ['cross.languagesVsMultilingual']);
  assert.deepEqual(flagIds(validate(features(['contact-form', 'multilingual']))), []);
  const oneLanguage = replace('D.languages', { status: 'complete', choice: ['da'] }).filter((i) => i.id !== 'G.multilingual');
  assert.deepEqual(flagIds(validate(oneLanguage.map((i) => (i.id === 'G.features' ? { ...i, choice: ['contact-form'] } : i)))), []);
  assert.deepEqual(validate(features(['blog'])).flags[0].params, { languages: 'da, en' });
  assert.equal(flagIds(validate(without('G.features'))).includes('cross.languagesVsMultilingual'), false, 'unanswered features say nothing');
});

test('cross.redesignNoSite: a redesign without an existing site', () => {
  assert.deepEqual(flagIds(validate(without('A.existing-site'))), ['cross.redesignNoSite']);
  assert.deepEqual(flagIds(validate(COMPLETE_INPUT)), []);
  const newSite = replace('A.project-kind', { status: 'complete', choice: ['new-site'] }).filter((i) => i.id !== 'A.existing-site');
  assert.deepEqual(flagIds(validate(newSite)), []);
});

test('cross.assetsClaimedMissing: guidelines or partial brand material but an empty assets folder', () => {
  const present = { rows: [], present: ['logo.svg'] };
  const listed = { rows: [{ file: 'assets/logo.svg', what: 'Logo', owner: 'Kunden', rights: 'Ejes', restrictions: '' }], present: ['logo.svg'] };
  assert.deepEqual(flagIds(validate(COMPLETE_INPUT, { assets: { rows: [], present: [] } })), ['cross.assetsClaimedMissing']);
  assert.deepEqual(flagIds(validate(COMPLETE_INPUT, { assets: listed })), []);
  assert.deepEqual(flagIds(validate(COMPLETE_INPUT, { assets: present })), ['assets.unlisted']);
  const partial = replace('B.assets-status', { status: 'complete', choice: ['partial'] });
  assert.deepEqual(flagIds(validate(partial, { assets: { rows: [], present: [] } })), ['cross.assetsClaimedMissing']);
  const none = replace('B.assets-status', { status: 'complete', choice: ['none'] });
  assert.deepEqual(flagIds(validate(none, { assets: { rows: [], present: [] } })), []);
});

test('cross.designInputsThin: information when E.like, E.dislike or E.feel is not complete', () => {
  const report = validate(without('E.feel'));
  const flag = report.flags.find((entry) => entry.id === 'cross.designInputsThin');
  assert.deepEqual(flag, { id: 'cross.designInputsThin', severity: 'info', params: { count: 2, min: 3 } });
  assert.equal(validate(COMPLETE_INPUT).flags.length, 0);
  const shortList = replace('E.like', { status: 'complete', items: [{ text: 'https://example.com/a' }] });
  assert.equal(validate(shortList).flags.find((entry) => entry.id === 'cross.designInputsThin').params.count, 2);
});

test('assets: unlisted files, rows without a file and empty rights', () => {
  const assets = {
    rows: [
      { file: 'assets/logo.svg', what: 'Logo', owner: 'Kunden', rights: 'Ejes', restrictions: '' },
      { file: 'assets/ghost.svg', what: '', owner: '', rights: 'unknown', restrictions: '' },
      { file: 'notes.txt', what: '', owner: '', rights: '  ', restrictions: '' },
    ],
    present: ['logo.svg', 'notes.txt', 'photos/a.jpg'],
  };
  const report = validate(COMPLETE_INPUT, { assets });
  assert.deepEqual(
    report.flags.map((flag) => [flag.id, flag.params.file]),
    [
      ['assets.unlisted', 'photos/a.jpg'],
      ['assets.missingFile', 'assets/ghost.svg'],
      ['assets.noRights', 'notes.txt'],
      ['assets.rightsUnknown', 'assets/ghost.svg'],
    ],
  );
});

test('file.missing is information for every file that does not exist', () => {
  const data = makePackData([]);
  data.files.technical = { path: 'docs/05-technical-and-compliance.md', exists: false, frontMatter: null, answers: {}, flags: [] };
  const missing = validatePackData(data, schema, { today: TODAY }).flags.filter((flag) => flag.id === 'file.missing');
  assert.deepEqual(missing, [{ id: 'file.missing', severity: 'info', file: 'technical', params: { file: 'technical', path: 'docs/05-technical-and-compliance.md' } }]);
});

test('file.languageMismatch compares the front matter language with the pack language', () => {
  const data = makePackData([]);
  data.files.scope.frontMatter.language = 'en';
  const flags = validatePackData(data, schema, { today: TODAY }).flags.filter((flag) => flag.id === 'file.languageMismatch');
  assert.deepEqual(flags.map((flag) => [flag.severity, flag.file, flag.params.found, flag.params.expected]), [['warn', 'scope', 'en', 'da']]);
});

test('flags found while parsing reach the report, with the file and path, and the question', () => {
  const data = makePackData([]);
  data.files.brand.flags = [
    { id: 'marker.badStatus', severity: 'warn', qid: 'B.name', params: { qid: 'B.name', status: 'done' } },
    { id: 'marker.unknownQuestion', severity: 'warn', params: { id: 'Z.x' } },
  ];
  const report = validatePackData(data, schema, { today: TODAY });
  assert.deepEqual(report.flags[0], {
    id: 'marker.badStatus',
    severity: 'warn',
    qid: 'B.name',
    file: 'brand',
    params: { file: 'brand', path: 'docs/01-brand/brand.md', qid: 'B.name', status: 'done' },
  });
  assert.equal(report.flags[1].params.path, 'docs/01-brand/brand.md');
  assert.deepEqual(report.questions['B.name'].flags.map((flag) => flag.id), ['marker.badStatus']);
});

test('the same question in two files is a duplicate and the first file wins', () => {
  const data = makePackData([complete('A.goal', { text: 'In the brief, a goal long enough for this test to pass.' })]);
  data.files.scope.answers['A.goal'] = { status: 'complete', owner: '', due: '', body: 'Other', value: { text: 'Other' } };
  const report = validatePackData(data, schema, { today: TODAY });
  assert.equal(report.questions['A.goal'].status, 'complete');
  assert.deepEqual(report.flags.filter((flag) => flag.id === 'marker.duplicate').map((flag) => [flag.qid, flag.file]), [['A.goal', 'scope']]);
});

// ---- depth and scoring -----------------------------------------------------------------------

function expectedOverall(report, depth) {
  let earned = 0;
  let total = 0;
  for (const entry of Object.values(report.questions)) {
    if (entry.level === 'skipped' || !schema.depths[depth].includes(entry.level)) continue;
    const weight = schema.weights[entry.level];
    total += weight;
    earned += weight * (schema.statusScores[entry.status] ?? 0);
  }
  return Math.round((earned / total) * 10000) / 10000;
}

test('scoring: weights 3, 2 and 1; statuses 1, 0.5, 0 and 0; only questions in scope of the depth count', () => {
  const inputs = [
    complete('A.goal', { text: 'A goal that is long enough to count as complete here.' }),
    { id: 'A.budget', status: 'partial', text: 'Omkring 50.000' },
    { id: 'A.failure', status: 'complete', text: 'Hvis det ikke virker' },
    { id: 'I.domain', status: 'tbd', owner: 'client', due: '2026-11-05', note: 'x' },
  ];
  for (const depth of ['essentials', 'standard', 'full']) {
    const report = validate(inputs, { depth });
    assert.equal(report.depth, depth);
    assert.equal(report.completeness.overall, expectedOverall(report, depth), depth);
  }
  const essentials = validate(inputs, { depth: 'essentials' });
  const gate1Count = Object.values(essentials.questions).filter((entry) => entry.level === 'gate1').length;
  assert.equal(essentials.completeness.overall, Math.round((3 / (3 * gate1Count)) * 10000) / 10000, 'one gate1 answer of N');
  assert.equal(essentials.completeness.counts.complete, 1, 'answers outside the depth are not counted');
  const full = validate(inputs, { depth: 'full' });
  assert.equal(full.completeness.counts.complete, 2);
  assert.equal(full.completeness.counts.partial, 1);
  assert.equal(full.completeness.counts.tbd, 1);
});

test('byFile, byModule and byArea total the questions in scope', () => {
  const report = validate([complete('B.name', { text: 'Nordlys' })], { depth: 'standard' });
  const inScope = Object.values(report.questions).filter((entry) => entry.level !== 'skipped' && schema.depths.standard.includes(entry.level)).length;
  const sum = (group) => Object.values(group).reduce((total, entry) => total + entry.total, 0);
  assert.equal(sum(report.completeness.byFile), inScope);
  assert.equal(sum(report.completeness.byModule), inScope);
  assert.equal(sum(report.completeness.byArea), inScope);
  assert.deepEqual(Object.keys(report.completeness.byFile), schema.files.map((file) => file.id));
  assert.deepEqual(Object.keys(report.completeness.byModule), schema.moduleOrder);
  assert.deepEqual(Object.keys(report.completeness.byArea), schema.areas);
  assert.equal(report.completeness.byModule.B.score, Math.round((3 / (3 * 5 + 2 * 10)) * 10000) / 10000, 'B.name is 3 of the weight of module B');
  assert.equal(report.completeness.byModule.A.score, 0);
});

test('the depth comes from the option, then from the pack data, then defaults to standard', () => {
  const data = makePackData([], { depth: 'full' });
  assert.equal(validatePackData(data, schema, { today: TODAY }).depth, 'full');
  assert.equal(validatePackData(data, schema, { today: TODAY, depth: 'essentials' }).depth, 'essentials');
  delete data.depth;
  assert.equal(validatePackData(data, schema, { today: TODAY }).depth, 'standard');
  assert.throws(() => validatePackData(data, schema, { depth: 'huge' }), /Unknown depth/);
});

test('validatePack is the same as validatePackData and the manifest completeness is derived from the report', () => {
  const data = makePackData(COMPLETE_INPUT);
  assert.deepEqual(validatePack(data, schema, { today: TODAY }), validatePackData(data, schema, { today: TODAY }));
  const report = validate(without('A.goal'));
  const completeness = manifestCompleteness(report);
  assert.deepEqual(Object.keys(completeness), ['overall', 'gate1Ready', 'gate1Blocking', 'counts', 'byFile', 'byModule']);
  assert.equal(completeness.gate1Ready, false);
  assert.deepEqual(completeness.gate1Blocking, ['A.goal']);
});

// ---- every flag, from the fixture packs ------------------------------------------------------

function fixtureReport(name) {
  const pack = parsePack(path.join(FIXTURES, name), schema);
  return validatePack(pack, schema, { today: TODAY });
}

test('together the fixture packs trigger every flag of FORMAT.md section 14', () => {
  const seen = new Set();
  for (const name of ['pack-broken', 'pack-en-partial', 'pack-da-complete']) {
    for (const flag of fixtureReport(name).flags) seen.add(flag.id);
  }
  assert.deepEqual([...seen].sort(), [...FLAG_IDS].sort());
});

test('the broken fixture reports the expected findings with the expected severities', () => {
  const report = fixtureReport('pack-broken');
  const severity = (id, qid) => report.flags.find((flag) => flag.id === id && (qid === undefined || flag.qid === qid))?.severity;
  assert.equal(severity('rule.minChars', 'A.business'), 'block');
  assert.equal(severity('rule.minItems', 'B.personality'), 'block');
  assert.equal(severity('rule.minItems', 'B.values'), 'warn');
  assert.equal(severity('rule.noChoice', 'B.assets-status'), 'block');
  assert.equal(severity('rule.noChoice', 'C.change-rate'), 'warn');
  assert.equal(severity('rule.badDate', 'A.deadline'), 'block');
  assert.equal(severity('rule.badChoice', 'C.catalogue-size'), 'warn');
  assert.equal(severity('marker.badStatus', 'A.why-now'), 'warn');
  assert.equal(severity('file.missing'), 'info');
  assert.equal(report.questions['A.why-now'].declared, 'partial');
  assert.equal(report.questions['B.name'].declared, 'complete', 'the first of two markers is used');
  assert.equal(report.language, 'da');
  assert.equal(report.gate1.ready, false);
});

test('the English partial fixture reports what is expected', () => {
  const report = fixtureReport('pack-en-partial');
  assert.equal(report.language, 'en');
  assert.equal(report.questions['B.purpose'].status, 'partial');
  assert.equal(report.questions['B.purpose'].declared, 'complete');
  assert.equal(report.questions['A.why-now'].status, 'partial');
  assert.equal(report.questions['I.domain'].status, 'tbd');
  assert.equal(report.questions['G.multilingual'].level, 'gate1');
  assert.equal(report.questions['B.logo'].level, 'gate1');
  assert.deepEqual(
    flagIds(report).filter((id) => !id.startsWith('file.')).sort(),
    ['cross.assetsClaimedMissing', 'cross.designInputsThin', 'rule.dateInPast', 'rule.minChars', 'tbd.noDue', 'tbd.noOwner'],
  );
});

test('every flag has a message in both languages and describeFlag leaves no placeholder open', () => {
  const reports = ['pack-broken', 'pack-en-partial'].map(fixtureReport);
  for (const lang of ['da', 'en']) {
    const i18n = makeI18n(testTexts(lang), lang);
    for (const id of FLAG_IDS) assert.ok(i18n.has(`flag.${id}`), `${lang} flag.${id}`);
    for (const report of reports) {
      for (const flag of report.flags) {
        const message = describeFlag(flag, i18n);
        assert.ok(!/\{[A-Za-z0-9_]+\}/.test(message), `${lang} ${flag.id}: ${message}`);
        assert.ok(!message.startsWith('flag.'), `${lang} ${flag.id} has no text`);
      }
    }
  }
});

// ---- what to ask next ------------------------------------------------------------------------

function packWith(inputs, state, options) {
  return { ...makePackData(inputs, options), state: state ?? null };
}

function next(inputs, options = {}, state = null) {
  const pack = packWith(inputs, state, options);
  const report = validatePack(pack, schema, { today: TODAY, depth: options.depth });
  return nextQuestions(pack, schema, report, options);
}

test('nextQuestions on an empty pack starts with module A, Must-answer questions first inside a module', () => {
  const ids = next([], { count: 12 }).map((question) => question.id);
  assert.deepEqual(ids.slice(0, 7), ['A.business', 'A.project-kind', 'A.why-now', 'A.goal', 'A.metrics', 'A.deadline', 'A.stakeholders']);
  assert.deepEqual(ids.slice(7), ['A.existing-site', 'A.deadline-reason', 'A.budget']);
  assert.equal(ids.length, 10, 'module A has ten questions in scope at the standard depth; the round stops at the module boundary');
});

test('a round never crosses a module boundary: the next round starts in the next module', () => {
  const answeredA = COMPLETE_INPUT.filter((input) => input.id.startsWith('A.'));
  const round = next(answeredA, { count: 100 });
  assert.ok(round.length > 0);
  assert.ok(round.every((question) => question.module === 'B'));
  assert.equal(round[0].id, 'B.name');
  const few = next(answeredA, { count: 2 });
  assert.deepEqual(few.map((question) => question.id), ['B.name', 'B.purpose']);
});

test('nextQuestions follows the depth: essentials asks only Gate 1, standard adds recommended, full adds optional', () => {
  const levels = (depth) => new Set(next([], { depth }).map((question) => question.level));
  assert.deepEqual([...levels('essentials')], ['gate1']);
  assert.deepEqual([...levels('standard')].sort(), ['gate1', 'recommended']);
  assert.deepEqual([...levels('full')].sort(), ['gate1', 'optional', 'recommended']);
  const total = schema.moduleOrder.reduce((sum, module) => sum + next([], { depth: 'full', module, count: 200 }).length, 0);
  assert.equal(total, 97, 'asked module by module, every question is asked once');
});

test('nextQuestions returns the effective level, status and module of each question', () => {
  const [first] = next([complete('A.project-kind', { choice: ['redesign'] })], { depth: 'essentials' });
  assert.equal(first.id, 'A.business');
  assert.equal(first.module, 'A');
  assert.equal(first.status, 'missing');
  const migration = next([complete('A.project-kind', { choice: ['redesign'] })], { depth: 'essentials', module: 'F', count: 200 }).find((question) => question.id === 'F.migration');
  assert.equal(migration.level, 'gate1', 'raised by requiredIf, so it is asked at the essentials depth');
});

test('nextQuestions returns only missing questions: complete, partial and deferred are left alone', () => {
  const ids = next(
    [
      complete('A.business', { text: 'x'.repeat(70) }),
      { id: 'A.project-kind', status: 'partial', choice: ['redesign'] },
      { id: 'A.why-now', status: 'tbd', owner: 'client', due: '2026-11-05', note: 'Later' },
    ],
    { depth: 'essentials', count: 3 },
  ).map((question) => question.id);
  assert.deepEqual(ids, ['A.goal', 'A.metrics', 'A.deadline']);
});

test('nextQuestions skips questions switched off by showIf and honours module and count', () => {
  const inputs = [complete('A.project-kind', { choice: ['new-site'] })];
  const all = next(inputs, { depth: 'full', module: 'A' }).map((question) => question.id);
  assert.ok(!all.includes('A.existing-site'));
  assert.ok(all.every((id) => id.startsWith('A.')));
  assert.equal(all.length, 9);
  assert.equal(next([], { module: 'B', count: 2 }).length, 2);
  assert.deepEqual(next([], { module: 'Z' }), []);
});

test('nextQuestions with state.focus returns exactly the focus ids, in focus order, whatever their status', () => {
  const inputs = [
    complete('A.business', { text: 'x'.repeat(70) }),
    { id: 'I.domain', status: 'tbd', note: 'Later' },
    { id: 'A.goal', status: 'partial', text: 'Delvist' },
  ];
  const state = { focus: ['I.domain', 'A.business', 'J.contact', 'A.goal', 'I.domain'] };
  const ids = next(inputs, { depth: 'essentials' }, state).map((question) => question.id);
  assert.deepEqual(ids, ['I.domain', 'A.business', 'J.contact', 'A.goal']);
  assert.deepEqual(next(inputs, { count: 2 }, state).map((question) => question.id), ['I.domain', 'A.business']);
  const outOfDepth = next(inputs, { depth: 'essentials' }, { focus: ['A.failure'] });
  assert.deepEqual(outOfDepth.map((question) => question.id), ['A.failure'], 'focus ignores the depth');
});

test('nextQuestions with state.focus leaves out unknown ids and questions that do not apply', () => {
  const inputs = [complete('A.project-kind', { choice: ['new-site'] })];
  const ids = next(inputs, {}, { focus: ['A.existing-site', 'nope', 'A.goal'] }).map((question) => question.id);
  assert.deepEqual(ids, ['A.goal']);
  assert.equal(next([], {}, { focus: [] }).length > 1, true, 'an empty focus changes nothing');
});

test('remainingByLevel counts missing questions in scope by effective level', () => {
  const inputs = [
    complete('A.business', { text: 'x'.repeat(70) }),
    { id: 'A.goal', status: 'partial', text: 'Delvist' },
    { id: 'A.budget', status: 'tbd', note: 'x' },
    complete('A.project-kind', { choice: ['redesign'] }),
  ];
  const pack = packWith(inputs);
  const report = validatePack(pack, schema, { today: TODAY });
  const gate1 = Object.values(report.questions).filter((entry) => entry.level === 'gate1' && entry.status === 'missing').length;
  const recommended = Object.values(report.questions).filter((entry) => entry.level === 'recommended' && entry.status === 'missing').length;
  assert.deepEqual(remainingByLevel(report, schema, 'standard'), { gate1, recommended, optional: 0 });
  assert.deepEqual(remainingByLevel(report, schema, 'essentials'), { gate1, recommended: 0, optional: 0 });
  assert.equal(remainingByLevel(report, schema, 'full').optional > 0, true);
  assert.equal(gate1, 36 + 1 - 3, '36 Must-answer questions, F.migration raised by the redesign, minus the answered and partial ones');
});
