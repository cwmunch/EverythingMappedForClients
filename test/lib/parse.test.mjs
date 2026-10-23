import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parseAssets, parseFile } from '../../skill/everything-mapped/scripts/lib/parse.mjs';
import { FIXTURES, schema } from './helpers.mjs';

const FRONT = '---\nschema: everything-mapped-for-clients/1\nfile: brief\nlanguage: da\nupdated: 2026-10-23\n---\n';

function parse(body, front = FRONT) {
  return parseFile(`${front}\n# Title\n\n## Module\n\n${body}`, schema);
}

function flagIds(parsed) {
  return parsed.flags.map((flag) => flag.id);
}

test('parseFile reads front matter, quoted values and escaped quotes', () => {
  const text = '---\nschema: everything-mapped-for-clients/1\nfile: brief\nlanguage: en\nrespondent: "Anna \\"A\\" Jensen, Marketing"\nupdated: 2026-10-23\n---\n';
  const parsed = parseFile(text, schema);
  assert.deepEqual(parsed.frontMatter, {
    schema: 'everything-mapped-for-clients/1',
    file: 'brief',
    language: 'en',
    respondent: 'Anna "A" Jensen, Marketing',
    updated: '2026-10-23',
  });
  assert.deepEqual(parsed.flags, []);
});

test('parseFile flags missing, unterminated or unusable front matter and names the keys', () => {
  const none = parseFile('# Title\n\n### Q\n<!-- q:A.goal status:complete -->\nText\n', schema);
  assert.equal(none.frontMatter, null);
  assert.deepEqual(none.flags, [{ id: 'file.badFrontMatter', severity: 'warn', params: { keys: 'schema, file, language' } }]);
  assert.equal(none.answers['A.goal'].body, 'Text', 'answers are still read');

  const open = parseFile('---\nlanguage: da\n# never closed\n', schema);
  assert.equal(open.frontMatter, null);

  const partial = parseFile('---\nschema: everything-mapped-for-clients/1\nfile: nothing\nlanguage: fr\n---\n', schema);
  assert.equal(partial.flags[0].params.keys, 'file, language');

  const missing = parseFile('---\nfile: brief\n---\n', schema);
  assert.equal(missing.flags[0].params.keys, 'schema, language');
});

test('parseFile skips blank lines before the front matter and accepts a byte order mark', () => {
  const parsed = parseFile(`\uFEFF\n\n${FRONT}`, schema);
  assert.equal(parsed.frontMatter.language, 'da');
});

test('marker line: id, status, owner and due are read; unknown tokens are ignored', () => {
  const parsed = parse('### Q\n<!--   q:I.domain   status:tbd  owner:client due:2026-11-05  colour:red -->\nAsk IT\n');
  assert.deepEqual(parsed.answers['I.domain'], {
    status: 'tbd',
    owner: 'client',
    due: '2026-11-05',
    body: 'Ask IT',
    value: { text: '' },
  });
  assert.deepEqual(parsed.flags, []);
});

test('an unknown question id is flagged and left out of the answers', () => {
  const parsed = parse('### Q\n<!-- q:Z.nothing status:complete -->\nText\n\n### G\n<!-- q:A.goal status:complete -->\nGoal\n');
  assert.deepEqual(Object.keys(parsed.answers), ['A.goal']);
  assert.deepEqual(parsed.flags, [{ id: 'marker.unknownQuestion', severity: 'warn', params: { id: 'Z.nothing' } }]);
  assert.equal(parsed.answers['A.goal'].body, 'Goal', 'the text of an unknown marker does not leak into the next answer');
});

test('a duplicate marker is flagged, the first one wins and the second body is ignored', () => {
  const parsed = parse('### A\n<!-- q:A.goal status:complete -->\nFirst\n\n### B\n<!-- q:A.goal status:partial -->\nSecond\n');
  assert.equal(parsed.answers['A.goal'].body, 'First');
  assert.equal(parsed.answers['A.goal'].status, 'complete');
  assert.deepEqual(parsed.flags, [{ id: 'marker.duplicate', severity: 'warn', qid: 'A.goal', params: { qid: 'A.goal' } }]);
});

test('a bad status is flagged and becomes partial with text, missing without', () => {
  const parsed = parse('### A\n<!-- q:A.goal status:done -->\nSome text\n\n### B\n<!-- q:A.budget status:finished -->\n\n### C\n<!-- q:A.failure -->\nNo status at all\n');
  assert.equal(parsed.answers['A.goal'].status, 'partial');
  assert.equal(parsed.answers['A.budget'].status, 'missing');
  assert.equal(parsed.answers['A.failure'].status, 'partial');
  assert.deepEqual(
    parsed.flags.map((flag) => [flag.id, flag.qid, flag.params.status]),
    [
      ['marker.badStatus', 'A.goal', 'done'],
      ['marker.badStatus', 'A.budget', 'finished'],
      ['marker.badStatus', 'A.failure', ''],
    ],
  );
});

test('a body ends at the next marker and at headings of level 1 to 3, not at level 4 or deeper', () => {
  const parsed = parse(
    [
      '### A',
      '<!-- q:A.goal status:complete -->',
      'Line one',
      '#### Inside heading',
      '##### Deeper',
      '#hashtag is not a heading',
      '',
      '### B',
      '<!-- q:A.budget status:complete -->',
      'Budget',
      '## Next module',
      'Not part of the budget',
      '# Next title',
      'Nor this',
    ].join('\n'),
  );
  assert.equal(parsed.answers['A.goal'].body, 'Line one\n#### Inside heading\n##### Deeper\n#hashtag is not a heading');
  assert.equal(parsed.answers['A.budget'].body, 'Budget');
});

test('a marker without any heading before it still starts an answer', () => {
  const parsed = parse('<!-- q:A.goal status:complete -->\nGoal text\n');
  assert.equal(parsed.answers['A.goal'].body, 'Goal text');
});

test('CRLF files, trailing spaces and tabs parse like LF files', () => {
  const lf = parse('### A\n<!-- q:A.goal status:complete -->\nLine one  \n\nLine two\t\n\n### B\n<!-- q:A.metrics status:complete -->\n* a  \n1. b | note\n');
  const crlf = parseFile(
    `${FRONT}\n# Title\n\n## Module\n\n### A\n<!-- q:A.goal status:complete -->\nLine one  \n\nLine two\t\n\n### B\n<!-- q:A.metrics status:complete -->\n* a  \n1. b | note\n`.replace(/\n/g, '\r\n'),
    schema,
  );
  assert.deepEqual(crlf, lf);
  assert.equal(lf.answers['A.goal'].body, 'Line one\n\nLine two');
  assert.deepEqual(lf.answers['A.metrics'].value.items, [{ text: 'a', note: '' }, { text: 'b', note: 'note' }]);
});

test('values are typed: text, items, choice with note, date with note', () => {
  const parsed = parse(
    [
      '### A\n<!-- q:A.goal status:complete -->\nGoal',
      '### B\n<!-- q:A.metrics status:partial -->\n- Leads | now 12',
      '### C\n<!-- q:A.project-kind status:complete -->\nChoice: redesign\nNote: old site',
      '### D\n<!-- q:A.deadline status:complete -->\nDate: 2026-12-01\nNote: soft',
      '### E\n<!-- q:I.domain status:missing -->',
    ].join('\n\n'),
  );
  assert.deepEqual(parsed.answers['A.goal'].value, { text: 'Goal' });
  assert.deepEqual(parsed.answers['A.metrics'].value, { items: [{ text: 'Leads', note: 'now 12' }] });
  assert.deepEqual(parsed.answers['A.project-kind'].value, { choice: ['redesign'], note: 'old site' });
  assert.deepEqual(parsed.answers['A.deadline'].value, { date: '2026-12-01', note: 'soft' });
  assert.deepEqual(parsed.answers['I.domain'].value, { text: '' });
});

test('a deferred answer keeps its note as the body but has an empty value', () => {
  const parsed = parse('### A\n<!-- q:A.metrics status:tbd owner:client -->\nAsk the board\n');
  assert.equal(parsed.answers['A.metrics'].body, 'Ask the board');
  assert.deepEqual(parsed.answers['A.metrics'].value, { items: [] });
});

test('the Danish fixture pack parses without flags and every answer is complete', () => {
  const root = path.join(FIXTURES, 'pack-da-complete');
  let count = 0;
  for (const file of schema.files) {
    const parsed = parseFile(fs.readFileSync(path.join(root, file.path), 'utf8'), schema);
    assert.deepEqual(parsed.flags, [], file.path);
    assert.equal(parsed.frontMatter.language, 'da');
    for (const entry of Object.values(parsed.answers)) {
      assert.equal(entry.status, 'complete');
      count += 1;
    }
  }
  assert.equal(count, 97);
});

// ---- assets table ---------------------------------------------------------------------------

test('parseAssets reads rows whatever the language of the header', () => {
  const english = '# Files\n\n| File | What it is | Owner | Rights | Restrictions |\n|---|---|---|---|---|\n| assets/logo.svg | Primary logo | Client | Owned by client | none |\n';
  const danish = '| Fil | Hvad det er | Ejer | Rettigheder | Begrænsninger |\n|---|---|---|---|---|\n| assets/logo.svg | Hovedlogo | Kunden | Ejes af kunden | Ingen |\n';
  assert.deepEqual(parseAssets(english), [
    { file: 'assets/logo.svg', what: 'Primary logo', owner: 'Client', rights: 'Owned by client', restrictions: 'none' },
  ]);
  assert.equal(parseAssets(danish)[0].what, 'Hovedlogo');
});

test('parseAssets handles empty cells, escaped pipes, CRLF and rows without a file', () => {
  const text = '| File | What | Owner | Rights | Restrictions |\r\n|---|---|---|---|---|\r\n| assets/a.png | A \\| B | | unknown | |\r\n| | nothing | | | |\r\n| assets/b.png | B |\r\n';
  assert.deepEqual(parseAssets(text), [
    { file: 'assets/a.png', what: 'A | B', owner: '', rights: 'unknown', restrictions: '' },
    { file: 'assets/b.png', what: 'B', owner: '', rights: '', restrictions: '' },
  ]);
});

test('parseAssets returns no rows for a table with only a header or for text without a table', () => {
  assert.deepEqual(parseAssets('| File | What | Owner | Rights | Restrictions |\n|---|---|---|---|---|\n'), []);
  assert.deepEqual(parseAssets('Nothing here'), []);
  assert.deepEqual(parseAssets(''), []);
});
