import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bodyFromInput,
  canonicalBody,
  checkAnswerInput,
  effectiveLevel,
  entryFromInput,
  findQuestion,
  inDepth,
  parseBody,
  questionsInOrder,
  selectedChoices,
  textLength,
} from '../../skill/everything-mapped/scripts/lib/rules.mjs';
import { schema } from './helpers.mjs';

const q = (id) => findQuestion(schema, id);

function answered(id, input) {
  return { [id]: entryFromInput(q(id), { id, status: 'complete', ...input }) };
}

test('questionsInOrder lists every question in module order with module and file', () => {
  const list = questionsInOrder(schema);
  assert.equal(list.length, 97);
  assert.deepEqual([...new Set(list.map((item) => item.module))], schema.moduleOrder);
  assert.equal(list[0].id, 'A.business');
  assert.equal(list[0].module, 'A');
  assert.equal(list[0].file, 'brief');
  assert.equal(list.find((item) => item.id === 'J.contact').file, 'brief');
  assert.equal(findQuestion(schema, 'nope'), null);
});

test('inDepth follows the depths of the schema', () => {
  assert.equal(inDepth('gate1', 'essentials', schema), true);
  assert.equal(inDepth('recommended', 'essentials', schema), false);
  assert.equal(inDepth('recommended', 'standard', schema), true);
  assert.equal(inDepth('optional', 'standard', schema), false);
  assert.equal(inDepth('optional', 'full', schema), true);
  assert.equal(inDepth('gate1', 'unknown', schema), false);
});

// ---- body round trips ---------------------------------------------------------------------

const ROUND_TRIPS = [
  ['A.business', { text: 'Et firma.\n\nTo afsnit med æøå.' }],
  ['A.budget', { text: 'Mellem 60.000 og 90.000 kroner' }],
  ['A.metrics', { items: [{ text: 'Leads per month', note: 'now 12' }, { text: 'Calls', note: '' }] }],
  ['A.existing-site', { items: [{ text: 'https://example.com/a?b=1', note: 'Current site' }] }],
  ['B.logo', { items: [{ text: 'assets/logo.svg', note: 'Main logo' }, { text: 'assets/mark.png', note: '' }] }],
  ['A.project-kind', { choice: ['redesign'], note: 'Old site is eight years old' }],
  ['D.channels', { choice: ['search', 'social'], note: '' }],
  ['A.deadline', { date: '2026-12-01', note: 'Before spring' }],
];

for (const [id, value] of ROUND_TRIPS) {
  test(`bodyFromInput and parseBody round trip for ${id}`, () => {
    const body = bodyFromInput(q(id), value);
    assert.deepEqual(parseBody(q(id), body), value);
    assert.equal(bodyFromInput(q(id), parseBody(q(id), body)), body, 'canonical body is stable');
  });
}

test('every question type has a round trip in this file', () => {
  const covered = new Set(ROUND_TRIPS.map(([id]) => q(id).type));
  for (const type of schema.types) assert.ok(covered.has(type), `no round trip for type ${type}`);
});

test('list bodies are written as dash bullets with an optional note after a pipe', () => {
  const body = bodyFromInput(q('A.metrics'), { items: [{ text: 'Leads', note: 'now 12' }, 'Calls'] });
  assert.equal(body, '- Leads | now 12\n- Calls');
});

test('text with a pipe, a backslash and extra white space survives in list items', () => {
  const items = [{ text: 'a | b', note: 'c \\| d' }, { text: 'C:\\temp\\', note: '' }];
  const value = parseBody(q('A.metrics'), bodyFromInput(q('A.metrics'), { items }));
  assert.deepEqual(value.items, items);
});

test('list parsing accepts -, *, +, 1. and 1) bullets, indentation, trailing spaces and CRLF', () => {
  const body = '- one  \r\n* two | note two\r\n+ three\r\n1. four\r\n2) five\r\n   - six\r\n';
  assert.deepEqual(
    parseBody(q('A.metrics'), body).items.map((item) => item.text),
    ['one', 'two', 'three', 'four', 'five', 'six'],
  );
  assert.equal(parseBody(q('A.metrics'), body).items[1].note, 'note two');
});

test('list parsing treats plain lines as items and joins indented continuation lines', () => {
  const value = parseBody(q('A.metrics'), 'first\nsecond\n   continued\n- third');
  assert.deepEqual(value.items.map((item) => item.text), ['first', 'second continued', 'third']);
});

test('list parsing does not take a number or a dash inside text for a bullet', () => {
  const value = parseBody(q('A.metrics'), '-5 degrees\n1.5 million visits\n**bold** start');
  assert.deepEqual(value.items.map((item) => item.text), ['-5 degrees', '1.5 million visits', '**bold** start']);
});

test('empty bullets and empty bodies give no items', () => {
  assert.deepEqual(parseBody(q('A.metrics'), '-\n- \n*').items, []);
  assert.deepEqual(parseBody(q('A.metrics'), '').items, []);
});

test('choice bodies read Choice and Note lines in any case and keep unknown ids', () => {
  const value = parseBody(q('D.channels'), 'choice: Search,  SOCIAL , bogus\r\nNOTE: one\r\nNote: two');
  assert.deepEqual(value, { choice: ['search', 'social', 'bogus'], note: 'one\ntwo' });
});

test('a choice body without a Choice line puts its text in the note and loses nothing', () => {
  const value = parseBody(q('A.project-kind'), 'We think a redesign');
  assert.deepEqual(value, { choice: [], note: 'We think a redesign' });
  const rewritten = bodyFromInput(q('A.project-kind'), value);
  assert.equal(rewritten, 'Note: We think a redesign');
  assert.deepEqual(parseBody(q('A.project-kind'), rewritten), value);
});

test('multi-line notes get a Note prefix on every line and come back unchanged', () => {
  const note = 'line one\n\nline three';
  const body = bodyFromInput(q('A.project-kind'), { choice: ['redesign'], note });
  assert.equal(body, 'Choice: redesign\nNote: line one\nNote:\nNote: line three');
  assert.equal(parseBody(q('A.project-kind'), body).note, note);
});

test('date bodies read the Date line and keep text that is not a date', () => {
  assert.deepEqual(parseBody(q('A.deadline'), 'Date: 2026-12-01\nNote: soft'), { date: '2026-12-01', note: 'soft' });
  assert.deepEqual(parseBody(q('A.deadline'), 'Date: 1. december'), { date: '1. december', note: '' });
  assert.deepEqual(parseBody(q('A.deadline'), '2026-12-01'), { date: '', note: '2026-12-01' });
});

test('canonicalBody rewrites answers canonically and keeps notes of deferred answers', () => {
  const list = q('A.metrics');
  assert.equal(canonicalBody(list, { status: 'complete', body: '* a  \r\n2. b | n' }), '- a\n- b | n');
  assert.equal(canonicalBody(list, { status: 'tbd', body: 'Ask   IT  \n' }), 'Ask   IT');
  assert.equal(canonicalBody(list, { status: 'missing', body: '' }), '');
});

test('textLength strips bullets and counts characters, not bytes', () => {
  assert.equal(textLength('- abc\n* def'), 7);
  assert.equal(textLength('  æøå  '), 3);
  assert.equal(textLength(''), 0);
});

// ---- effective levels ---------------------------------------------------------------------

test('effectiveLevel is the base level when nothing refers to the question', () => {
  assert.equal(effectiveLevel(q('A.goal'), {}, schema), 'gate1');
  assert.equal(effectiveLevel(q('A.budget'), {}, schema), 'recommended');
  assert.equal(effectiveLevel(q('A.failure'), {}, schema), 'optional');
});

test('showIf: A.existing-site is shown when unanswered, for redesign and other, and skipped otherwise', () => {
  const site = q('A.existing-site');
  assert.equal(effectiveLevel(site, {}, schema), 'recommended');
  assert.equal(effectiveLevel(site, answered('A.project-kind', { choice: ['redesign'] }), schema), 'recommended');
  assert.equal(effectiveLevel(site, answered('A.project-kind', { choice: ['other'] }), schema), 'recommended');
  assert.equal(effectiveLevel(site, answered('A.project-kind', { choice: ['new-site'] }), schema), 'skipped');
  const deferred = { 'A.project-kind': entryFromInput(q('A.project-kind'), { status: 'tbd', note: 'ask' }) };
  assert.equal(effectiveLevel(site, deferred, schema), 'recommended');
});

test('requiredIf in: A.project-kind redesign raises F.migration to gate1', () => {
  const migration = q('F.migration');
  assert.equal(effectiveLevel(migration, {}, schema), 'recommended');
  assert.equal(effectiveLevel(migration, answered('A.project-kind', { choice: ['new-site'] }), schema), 'recommended');
  assert.equal(effectiveLevel(migration, answered('A.project-kind', { choice: ['redesign'] }), schema), 'gate1');
});

test('requiredIf in: B.assets-status guidelines or partial raises B.logo to gate1, none does not', () => {
  const logo = q('B.logo');
  assert.equal(effectiveLevel(logo, answered('B.assets-status', { choice: ['guidelines'] }), schema), 'gate1');
  assert.equal(effectiveLevel(logo, answered('B.assets-status', { choice: ['partial'] }), schema), 'gate1');
  assert.equal(effectiveLevel(logo, answered('B.assets-status', { choice: ['none'] }), schema), 'recommended');
});

test('requiredIf minSelected: two or more D.languages raise G.multilingual to gate1', () => {
  const multilingual = q('G.multilingual');
  assert.equal(effectiveLevel(multilingual, answered('D.languages', { choice: ['da'] }), schema), 'recommended');
  assert.equal(effectiveLevel(multilingual, answered('D.languages', { choice: ['da', 'en'] }), schema), 'gate1');
  assert.equal(effectiveLevel(multilingual, answered('D.languages', { choice: ['da', 'en', 'de'] }), schema), 'gate1');
});

test('requiredIf notIn: H.editing-needs other than nobody raises H.who-edits to gate1', () => {
  const who = q('H.who-edits');
  assert.equal(effectiveLevel(who, {}, schema), 'recommended');
  assert.equal(effectiveLevel(who, answered('H.editing-needs', { choice: ['nobody'] }), schema), 'recommended');
  for (const choice of ['occasional', 'regular', 'restructure']) {
    assert.equal(effectiveLevel(who, answered('H.editing-needs', { choice: [choice] }), schema), 'gate1', choice);
  }
});

test('a deferred or unknown choice in the referenced question does not raise the level', () => {
  const deferred = { 'A.project-kind': entryFromInput(q('A.project-kind'), { status: 'tbd', note: 'Choice: redesign' }) };
  assert.equal(effectiveLevel(q('F.migration'), deferred, schema), 'recommended');
  const unknown = { 'A.project-kind': { status: 'complete', body: 'Choice: bogus' } };
  assert.deepEqual(selectedChoices(schema, unknown, 'A.project-kind'), []);
});

test('effectiveLevel never lowers a level and reads answers given only as a body', () => {
  const raised = { ...q('F.migration'), level: 'gate1', requiredIf: { id: 'A.project-kind', in: ['redesign'], level: 'optional' } };
  const answers = { 'A.project-kind': { status: 'complete', body: 'Choice: redesign' } };
  assert.equal(effectiveLevel(raised, answers, schema), 'gate1');
  assert.equal(effectiveLevel(q('F.migration'), answers, schema), 'gate1');
});

// ---- checking answer input ---------------------------------------------------------------

function problemKeys(id, input) {
  return checkAnswerInput(q(id), { id, ...input }).map((problem) => problem.key.replace('ui.answer.err.', ''));
}

test('checkAnswerInput accepts good input for every type', () => {
  assert.deepEqual(problemKeys('A.business', { status: 'complete', text: 'Some text' }), []);
  assert.deepEqual(problemKeys('A.metrics', { status: 'complete', items: [{ text: 'a', note: 'b' }, 'c'] }), []);
  assert.deepEqual(problemKeys('A.metrics', { status: 'partial', text: '- a\n- b' }), []);
  assert.deepEqual(problemKeys('B.logo', { status: 'complete', items: [{ text: 'assets/logo.svg' }] }), []);
  assert.deepEqual(problemKeys('A.project-kind', { status: 'complete', choice: ['redesign'], note: 'n' }), []);
  assert.deepEqual(problemKeys('A.project-kind', { status: 'complete', choice: 'redesign' }), []);
  assert.deepEqual(problemKeys('D.channels', { status: 'complete', choice: ['search', 'social'] }), []);
  assert.deepEqual(problemKeys('A.deadline', { status: 'complete', date: '2026-12-01' }), []);
  assert.deepEqual(problemKeys('I.domain', { status: 'tbd', owner: 'client', due: '2026-11-05', note: 'Ask IT' }), []);
  assert.deepEqual(problemKeys('A.metrics', { status: 'tbd', note: 'later' }), []);
  assert.deepEqual(problemKeys('A.goal', { status: 'missing' }), []);
});

test('checkAnswerInput reports bad input', () => {
  assert.deepEqual(problemKeys('A.goal', { status: 'done', text: 'x' }), ['badStatus']);
  assert.deepEqual(problemKeys('A.goal', { status: 'complete', text: 'x', colour: 'red' }), ['unknownField']);
  assert.deepEqual(problemKeys('A.goal', { status: 'complete' }), ['noContent']);
  assert.deepEqual(problemKeys('A.goal', { status: 'complete', text: '   ' }), ['noContent']);
  assert.deepEqual(problemKeys('A.goal', { status: 'complete', text: 5 }), ['badText']);
  assert.deepEqual(problemKeys('A.goal', { status: 'complete', text: 'x', note: 'y' }), ['wrongField']);
  assert.deepEqual(problemKeys('A.goal', { status: 'complete', items: [{ text: 'x' }] }), ['wrongField', 'noContent']);
  assert.deepEqual(problemKeys('A.metrics', { status: 'complete', items: [] }), ['noContent']);
  assert.deepEqual(problemKeys('A.metrics', { status: 'complete', items: [{ note: 'x' }] }), ['badItems']);
  assert.deepEqual(problemKeys('A.metrics', { status: 'complete', items: [{ text: 'x', extra: 1 }] }), ['badItems']);
  assert.deepEqual(problemKeys('B.logo', { status: 'complete', items: [{ text: 'logo.svg' }] }), ['badFilePath']);
  assert.deepEqual(problemKeys('B.logo', { status: 'complete', items: [{ text: 'assets/../secret' }] }), ['badFilePath']);
  assert.deepEqual(problemKeys('B.logo', { status: 'complete', items: [{ text: 'assets\\a.png' }] }), ['badFilePath']);
  assert.deepEqual(problemKeys('A.project-kind', { status: 'complete', choice: ['nope'] }), ['badChoice']);
  assert.deepEqual(problemKeys('A.project-kind', { status: 'complete', choice: ['redesign', 'other'] }), ['singleChoiceOnly']);
  assert.deepEqual(problemKeys('A.project-kind', { status: 'complete', choice: [] }), ['noContent']);
  assert.deepEqual(problemKeys('A.project-kind', { status: 'complete', choice: [5] }), ['badChoiceField']);
  assert.deepEqual(problemKeys('A.deadline', { status: 'complete', date: '1. december' }), ['badDate']);
  assert.deepEqual(problemKeys('A.deadline', { status: 'complete', date: '2026-02-30' }), ['badDate']);
  assert.deepEqual(problemKeys('A.deadline', { status: 'complete' }), ['noContent']);
  assert.deepEqual(problemKeys('I.domain', { status: 'tbd', due: 'soon' }), ['badDue']);
  assert.deepEqual(problemKeys('I.domain', { status: 'tbd', items: [] }), ['tbdContent']);
  assert.deepEqual(problemKeys('I.domain', { status: 'missing', text: 'x' }), ['missingHasContent']);
});

test('checkAnswerInput puts the question id in every problem', () => {
  const problems = checkAnswerInput(q('A.goal'), { id: 'A.goal', status: 'done' });
  assert.equal(problems[0].params.id, 'A.goal');
});

test('entryFromInput gives the shape parseFile gives', () => {
  const entry = entryFromInput(q('I.domain'), { id: 'I.domain', status: 'tbd', owner: 'Anna Jensen', due: '2026-11-05', note: 'Ask IT' });
  assert.deepEqual(entry, { status: 'tbd', owner: 'Anna-Jensen', due: '2026-11-05', body: 'Ask IT', value: { text: '' } });
  const list = entryFromInput(q('A.metrics'), { id: 'A.metrics', status: 'complete', items: [{ text: 'a', note: 'b' }] });
  assert.equal(list.body, '- a | b');
  assert.deepEqual(list.value, { items: [{ text: 'a', note: 'b' }] });
  const cleared = entryFromInput(q('A.goal'), { id: 'A.goal', status: 'missing' });
  assert.deepEqual(cleared, { status: 'missing', owner: '', due: '', body: '', value: { text: '' } });
});
