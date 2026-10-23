// The page code of the form, run against a stand-in for the browser: building the form, typing,
// choosing, deferring, attaching files, navigating, saving, loading and downloading the pack.

import assert from 'node:assert/strict';
import test from 'node:test';
import { localDate } from '../../skill/everything-mapped/scripts/lib/util.mjs';
import {
  FakeDocument,
  byTag,
  createBrokenStorage,
  createFakeWindow,
  createMemoryStorage,
  fakeFile,
  findAll,
  readableStrings,
  textOf,
} from './fake-dom.mjs';
import { LOGO_SVG, blobBytes, loadBrowserScript, plain, schema, textOfEntry, unzipPack } from './helpers.mjs';

const { emfc, data } = loadBrowserScript();
const STORAGE_KEY = data.storageKey;

function fill(template, params = {}) {
  return template.replace(/\{(\w+)\}/g, (whole, name) => (name in params ? String(params[name]) : whole));
}

function text(lang, key, params) {
  assert.ok(Object.hasOwn(data.dictionaries[lang], key), `missing text ${key} in ${lang}`);
  return fill(data.dictionaries[lang][key], params);
}

// A page with the form started in it. options go to the stand-in window.
function openForm(options = {}) {
  const doc = new FakeDocument();
  const root = doc.createElement('div');
  root.setAttribute('id', 'app');
  doc.body.appendChild(root);
  const fake = createFakeWindow(options);
  const app = emfc.startForm(doc, fake.win, data);
  return { app, doc, root, fake };
}

function typeInto(field, value) {
  field.value = value;
  field.fire('input');
}

function pick(input, checked = true) {
  input.checked = checked;
  input.fire('change');
}

function flush(page) {
  page.app.flush();
}

async function until(condition, what) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function inputsOf(root, type) {
  return findAll(root, (element) => element.localName === 'input' && element.getAttribute('type') === type);
}

function buttonByText(root, label) {
  const found = findAll(root, (element) => element.localName === 'button' && element.textContent === label);
  assert.ok(found.length >= 1, `no button "${label}"`);
  return found[0];
}

function part(page, id) {
  return page.app.parts.get(id);
}

function visibleIds(page) {
  return [...page.app.parts].filter(([, entry]) => !entry.root.hidden).map(([id]) => id);
}

test('the form starts in Danish for a Danish browser and in English otherwise', () => {
  const danish = openForm({ language: 'da-DK' });
  assert.equal(danish.app.state.language, 'da');
  assert.equal(danish.doc.documentElement.lang, 'da');
  assert.equal(danish.doc.title, text('da', 'ui.form.title'));
  const english = openForm({ language: 'en-GB' });
  assert.equal(english.app.state.language, 'en');
  assert.equal(english.doc.documentElement.lang, 'en');
  assert.equal(english.doc.title, text('en', 'ui.form.title'));
  assert.equal(openForm({ language: 'de-DE' }).app.state.language, 'en');
  assert.equal(openForm({ language: 'DA' }).app.state.language, 'da');
  assert.equal(openForm({ language: undefined }).app.state.language, 'en');
});

test('the script starts the form by itself when the page has a document', () => {
  const doc = new FakeDocument();
  const root = doc.createElement('div');
  root.setAttribute('id', 'app');
  doc.body.appendChild(root);
  for (const [id, content] of [
    ['emfc-schema', data.schema],
    ['emfc-texts-da', data.dictionaries.da],
    ['emfc-texts-en', data.dictionaries.en],
    ['emfc-config', { toolVersion: data.toolVersion }],
  ]) {
    const block = doc.createElement('script');
    block.setAttribute('id', id);
    block.textContent = JSON.stringify(content);
    doc.body.appendChild(block);
  }
  const fake = createFakeWindow({ language: 'da' });
  const loaded = loadBrowserScript({ document: doc, window: fake.win });
  assert.ok(loaded.window.__emfc.app, 'window.__emfc.app exists');
  assert.equal(doc.documentElement.lang, 'da');
  assert.ok(root.children.length > 3);
});

test('when the form cannot start, the message in the page is shown instead of an empty page', () => {
  const doc = new FakeDocument();
  for (const id of ['app', 'emfc-failed']) {
    const element = doc.createElement('div');
    element.setAttribute('id', id);
    doc.body.appendChild(element);
  }
  const failed = doc.getElementById('emfc-failed');
  failed.hidden = true;
  const logged = [];
  const loaded = loadBrowserScript({ document: doc, window: createFakeWindow().win, console: { error: (error) => logged.push(error) } });
  assert.equal(failed.hidden, false, 'no data blocks in the page, so the form cannot start');
  assert.equal(logged.length, 1);
  assert.equal(loaded.window.__emfc.app, undefined);
  assert.equal(typeof loaded.window.__emfc.createEngine, 'function');
});

test('every question of the schema gets its label, its question, help and example', () => {
  const page = openForm({ language: 'da' });
  const ids = schema.modules.flatMap((entry) => entry.questions.map((question) => question.id));
  assert.equal(page.app.parts.size, ids.length);
  for (const id of ids) {
    const entry = part(page, id);
    const content = textOf(entry.root);
    assert.ok(content.includes(text('da', `q.${id}.label`)), `${id}: label`);
    assert.ok(content.includes(text('da', `q.${id}.ask`)), `${id}: ask`);
    const details = byTag(entry.root, 'details').filter((element) => element.className !== 'note-box');
    assert.deepEqual(
      details.map((element) => textOf(element)),
      [text('da', 'ui.form.q.help') + text('da', `q.${id}.help`), text('da', 'ui.form.q.example') + text('da', `q.${id}.example`)],
      `${id}: collapsible help and example`,
    );
  }
});

test('one section per module, in the order of the schema, plus a last step to review', () => {
  const page = openForm({ language: 'en' });
  const sections = byTag(page.root, 'section').filter((element) => element.className === 'module');
  assert.deepEqual(
    sections.map((element) => element.id),
    [...schema.moduleOrder.map((id) => `module-${id}`), 'module-finish'],
  );
  for (const id of schema.moduleOrder) {
    const section = page.app.sections.get(id).section;
    assert.equal(section.getAttribute('aria-labelledby'), `module-${id}-title`);
    assert.ok(textOf(section).includes(text('en', `module.${id}.title`)));
  }
  assert.deepEqual(
    [...page.app.sections].filter(([, entry]) => !entry.section.hidden).map(([id]) => id),
    ['A'],
    'only the current module is shown',
  );
});

test('each question type gets the right control', () => {
  const page = openForm({ language: 'en' });
  const count = (id) => {
    const root = part(page, id).root;
    return {
      text: inputsOf(root, 'text').length,
      textarea: byTag(root, 'textarea').length,
      radio: inputsOf(root, 'radio').length,
      checkbox: inputsOf(root, 'checkbox').length,
      date: inputsOf(root, 'date').length,
      file: inputsOf(root, 'file').length,
    };
  };
  // Every question has the same "I do not know" block: a checkbox, three owner buttons, a name,
  // a date and a note. What is left over is the control of the question itself.
  const own = (id) => {
    const found = count(id);
    return { ...found, text: found.text - 1, textarea: found.textarea - 1, radio: found.radio - 3, checkbox: found.checkbox - 1, date: found.date - 1 };
  };
  const none = { text: 0, textarea: 0, radio: 0, checkbox: 0, date: 0, file: 0 };
  assert.deepEqual(own('A.budget'), { ...none, text: 1 }, 'text: one line');
  assert.deepEqual(own('A.business'), { ...none, textarea: 1 }, 'longtext: one text area');
  assert.deepEqual(own('A.project-kind'), { ...none, radio: 5, textarea: 1 }, 'choice: one radio per choice, and a note');
  assert.deepEqual(own('D.languages'), { ...none, checkbox: 6, textarea: 1 }, 'multichoice: one checkbox per choice, and a note');
  assert.deepEqual(own('A.deadline'), { ...none, date: 1, textarea: 1 }, 'date: a date field and a note');
  assert.deepEqual(own('B.logo'), { ...none, file: 1 }, 'files: a file field');
  assert.deepEqual(own('A.metrics'), { ...none, text: 1 }, 'a list starts with one row');
  assert.deepEqual(own('B.personality'), { ...none, text: 3 }, 'a list with a minimum shows up to three rows');
  assert.deepEqual(own('E.like'), { ...none, text: 6 }, 'a link list has a link and a note in each of three rows');
});

test('every control has a name, every group a legend, and the ids and references fit together', () => {
  const page = openForm({ language: 'da' });
  const everything = findAll(page.root, () => true);
  const ids = everything.map((element) => element.id).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  const labelTargets = new Set(byTag(page.root, 'label').map((label) => label.getAttribute('for')).filter(Boolean));
  const insideLabel = (element) => {
    for (let node = element.parentNode; node; node = node.parentNode) if (node.localName === 'label') return true;
    return false;
  };
  for (const control of findAll(page.root, (element) => ['input', 'textarea', 'select'].includes(element.localName))) {
    const named = control.hasAttribute('aria-label') || insideLabel(control) || (control.id && labelTargets.has(control.id));
    assert.ok(named, `a ${control.localName} (${control.getAttribute('type')}) has no name`);
  }
  for (const fieldset of byTag(page.root, 'fieldset')) {
    assert.equal(fieldset.children[0].localName, 'legend', 'a fieldset starts with its legend');
  }
  for (const element of everything) {
    for (const name of ['aria-describedby', 'aria-labelledby']) {
      for (const reference of (element.getAttribute(name) || '').split(' ').filter(Boolean)) {
        assert.ok(ids.includes(reference), `${name} points at ${reference}, which does not exist`);
      }
    }
    if (element.localName === 'label' && element.hasAttribute('for')) assert.ok(ids.includes(element.getAttribute('for')), `label for ${element.getAttribute('for')}`);
  }
  for (const button of byTag(page.root, 'button')) {
    assert.ok(button.hasAttribute('aria-label') || textOf(button) !== '', 'a button has a name');
    assert.equal(button.getAttribute('type'), 'button');
  }
  for (const details of byTag(page.root, 'details')) assert.equal(details.children[0].localName, 'summary');
  assert.equal(byTag(page.root, 'h1').length, 1);
  assert.equal(page.root.children[0].getAttribute('href'), '#main', 'the first element is the skip link');
});

test('the progress bar and the module navigation start empty and count in the chosen depth', () => {
  const page = openForm({ language: 'en' });
  const bar = page.app.refs.panel.track;
  assert.equal(bar.getAttribute('role'), 'progressbar');
  assert.equal(bar.getAttribute('aria-valuenow'), '0');
  assert.equal(bar.getAttribute('aria-valuemin'), '0');
  assert.equal(bar.getAttribute('aria-valuemax'), '100');
  const total = visibleIds(page).length;
  assert.equal(page.app.refs.panel.text.textContent, text('en', 'ui.form.progress.text', { done: 0, total }));
  const nav = page.app.navItems.get('A');
  assert.equal(nav.button.getAttribute('aria-current'), 'step');
  assert.equal(page.app.navItems.get('B').button.hasAttribute('aria-current'), false);
  assert.match(nav.count.textContent, /^0 of \d+$/);
  assert.equal(page.app.navItems.size, schema.moduleOrder.length + 1);
});

test('the depth choice decides which questions are shown', () => {
  const page = openForm({ language: 'en' });
  const level = (id) => page.app.analysis.report.questions[id].level;
  const radios = inputsOf(page.root, 'radio').filter((input) => input.getAttribute('name') === 'depth');
  assert.deepEqual(radios.map((input) => input.value), ['essentials', 'standard', 'full']);
  assert.equal(radios[1].checked, true, 'standard is the default');
  pick(radios[0]);
  let shown = visibleIds(page);
  assert.ok(shown.length > 0 && shown.every((id) => level(id) === 'gate1'));
  pick(radios[2]);
  assert.equal(visibleIds(page).length, page.app.engine.ordered.length, 'every question');
  pick(inputsOf(part(page, 'A.project-kind').root, 'radio')[0]);
  assert.equal(visibleIds(page).length, page.app.engine.ordered.length - 1, 'all but the one switched off by showIf');
  pick(radios[1]);
  shown = visibleIds(page);
  assert.ok(shown.every((id) => level(id) !== 'optional'));
  assert.equal(page.app.state.depth, 'standard');
});

test('typing fills the state, updates the hint, the counts and the panel, and saves a moment later', () => {
  const page = openForm({ language: 'en' });
  const goal = part(page, 'A.goal');
  const field = goal.focus();
  assert.equal(goal.hint.hidden, false);
  assert.equal(goal.hint.textContent, text('en', 'ui.form.hint.minChars', { actual: 0, min: 40 }));
  const before = page.app.refs.panel.must.textContent;
  assert.equal(before, text('en', 'ui.form.panel.open', { label: text('en', 'level.gate1'), count: 36 }));

  typeInto(field, 'Kort');
  assert.equal(page.app.state.answers['A.goal'].text, 'Kort');
  assert.equal(page.fake.pendingTimers(), 2, 'refresh and save are waiting');
  assert.equal(page.fake.win.localStorage.getItem(STORAGE_KEY), null);
  page.fake.runTimers();
  assert.equal(goal.hint.textContent, text('en', 'ui.form.hint.minChars', { actual: 4, min: 40 }), 'the hint follows after the refresh');
  assert.equal(goal.status.textContent, text('en', 'status.partial'), 'a too short answer is partial');
  assert.equal(page.app.refs.panel.must.textContent, before, 'a partial answer still counts as open');

  typeInto(field, 'At få flere henvendelser fra private kunder, så vi kan fylde kalenderen.');
  page.fake.runTimers();
  assert.equal(goal.hint.hidden, true);
  assert.equal(goal.status.textContent, text('en', 'status.complete'));
  assert.equal(page.app.refs.panel.must.textContent, text('en', 'ui.form.panel.open', { label: text('en', 'level.gate1'), count: 35 }));
  assert.equal(page.app.refs.panel.bar.style.width, `${Math.round((1 / visibleIds(page).length) * 100)}%`);
  assert.match(page.app.refs.panel.save.textContent, /^Saved in this browser at /);
  const saved = JSON.parse(page.fake.win.localStorage.getItem(STORAGE_KEY));
  assert.equal(saved.answers['A.goal'].text.slice(0, 5), 'At få');
  assert.equal(saved.format, 'everything-mapped-form/1');
  assert.ok(!page.app.refs.panel.list.textContent.includes(text('en', 'q.A.goal.label')), 'an answered question leaves the list');
  assert.ok(page.app.refs.panel.list.textContent.includes(text('en', 'q.A.business.label')));
});

test('the level and status tags follow the question', () => {
  const page = openForm({ language: 'da' });
  assert.equal(part(page, 'A.goal').level.textContent, text('da', 'level.gate1.short'));
  assert.equal(part(page, 'A.budget').level.textContent, text('da', 'level.recommended'));
  pick(inputsOf(page.root, 'radio').find((input) => input.getAttribute('name') === 'depth' && input.value === 'full'));
  assert.equal(part(page, 'A.failure').level.textContent, text('da', 'level.optional'));
  assert.equal(part(page, 'A.goal').status.textContent, '', 'nothing is said about an unanswered question');
  pick(inputsOf(part(page, 'A.project-kind').root, 'radio')[1]);
  assert.equal(part(page, 'A.project-kind').status.textContent, text('da', 'status.complete'));
  assert.equal(part(page, 'F.migration').level.textContent, text('da', 'level.gate1.short'), 'requiredIf raises the level live');
});

test('showIf works live: choosing a project kind shows or hides the follow-up question', () => {
  const page = openForm({ language: 'en' });
  const kind = inputsOf(part(page, 'A.project-kind').root, 'radio').filter((input) => input.getAttribute('name') === 'f-A.project-kind-choice');
  assert.deepEqual(kind.map((input) => input.value), ['new-site', 'redesign', 'landing-page', 'small-app', 'other']);
  const site = part(page, 'A.existing-site');
  assert.equal(site.root.hidden, false, 'shown while the project kind is not answered');
  pick(kind[0]);
  assert.equal(site.root.hidden, true);
  pick(kind[1]);
  assert.equal(site.root.hidden, false);
  pick(kind[2]);
  assert.equal(site.root.hidden, true);
  pick(kind[4]);
  assert.equal(site.root.hidden, false);
  const clear = byTag(part(page, 'A.project-kind').root, 'button').find((button) => button.textContent === text('en', 'ui.form.choice.clear'));
  assert.equal(clear.hidden, false);
  clear.click();
  assert.deepEqual(plain(page.app.state.answers['A.project-kind'].choice), []);
  assert.equal(clear.hidden, true);
  assert.equal(kind.some((input) => input.checked), false);
});

test('"I do not know" hides the answer, asks who and by when, and counts as deferred', () => {
  const page = openForm({ language: 'da' });
  const domain = part(page, 'I.domain');
  assert.equal(domain.tbd.hidden, true);
  assert.equal(domain.controls.hidden, false);
  assert.equal(domain.toggle.getAttribute('type'), 'checkbox');
  pick(domain.toggle);
  assert.equal(domain.tbd.hidden, false);
  assert.equal(domain.controls.hidden, true);
  assert.equal(domain.status.textContent, text('da', 'status.tbd'));
  assert.equal(page.app.refs.panel.deferred.hidden, false);
  assert.equal(page.app.refs.panel.deferred.textContent, text('da', 'ui.form.panel.deferred', { count: 1 }));

  const owners = inputsOf(domain.tbd, 'radio');
  assert.deepEqual(owners.map((input) => input.value), ['client', 'me', 'other']);
  assert.equal(owners[0].checked, true, 'the organisation is the default owner');
  assert.equal(domain.ownerName.hidden, true);
  pick(owners[2]);
  assert.equal(domain.ownerName.hidden, false);
  assert.equal(domain.ownerHint.textContent, text('da', 'ui.form.unknown.needName'));
  typeInto(domain.ownerName, 'Peter Holm');
  const due = inputsOf(domain.tbd, 'date')[0];
  due.value = '2026-11-05';
  due.fire('change');
  const note = byTag(domain.tbd, 'textarea')[0];
  typeInto(note, 'Spørg IT-afdelingen');
  flush(page);
  assert.equal(domain.ownerHint.hidden, true);
  const entry = page.app.analysis.entries['I.domain'];
  assert.deepEqual(plain({ status: entry.status, owner: entry.owner, due: entry.due, body: entry.body }), {
    status: 'tbd',
    owner: 'Peter-Holm',
    due: '2026-11-05',
    body: 'Spørg IT-afdelingen',
  });

  pick(owners[1]);
  assert.equal(domain.ownerHint.textContent, text('da', 'ui.form.unknown.needMyName'));
  typeInto(inputsOf(page.root, 'text').find((input) => input.id === 'respondent-name'), 'Anna Jensen');
  flush(page);
  assert.equal(domain.ownerHint.hidden, true);
  assert.equal(page.app.analysis.entries['I.domain'].owner, 'Anna-Jensen');

  pick(domain.toggle, false);
  assert.equal(domain.tbd.hidden, true);
  assert.equal(domain.controls.hidden, false);
  assert.equal(page.app.refs.panel.deferred.hidden, true);
});

test('lists: rows are added and removed, Enter moves on or adds a row, empty rows are not answers', () => {
  const page = openForm({ language: 'en' });
  const metrics = part(page, 'A.metrics');
  const rows = () => findAll(metrics.root, (element) => element.localName === 'li' && element.className === 'row');
  assert.equal(rows().length, 1);
  const first = rows()[0].children[0];
  typeInto(first, 'Leads per month');
  const add = buttonByText(metrics.root, text('en', 'ui.form.list.add'));
  add.click();
  assert.equal(rows().length, 2);
  assert.equal(page.app.doc.activeElement, rows()[1].children[0], 'the new row has focus');
  typeInto(rows()[1].children[0], 'Sales online');
  const enter = rows()[1].children[0].fire('keydown', { key: 'Enter' });
  assert.equal(enter.defaultPrevented, true);
  assert.equal(rows().length, 3, 'Enter in the last row adds a row');
  const move = rows()[0].children[0].fire('keydown', { key: 'Enter' });
  assert.equal(move.defaultPrevented, true);
  assert.equal(page.app.doc.activeElement, rows()[1].children[0], 'Enter in another row moves to the next');
  flush(page);
  assert.deepEqual(plain(page.app.state.answers['A.metrics'].items.map((item) => item.text)), ['Leads per month', 'Sales online']);
  assert.equal(page.app.analysis.entries['A.metrics'].body, '- Leads per month\n- Sales online');

  rows()[0].children[1].click();
  assert.equal(rows().length, 2);
  assert.equal(rows()[0].children[0].value, 'Sales online');
  assert.deepEqual(plain(page.app.state.answers['A.metrics'].items.map((item) => item.text)), ['Sales online']);
  assert.equal(rows()[0].children[1].getAttribute('aria-label'), text('en', 'ui.form.list.removeN', { n: 1 }));
  assert.equal(rows()[0].children[0].getAttribute('aria-label'), text('en', 'ui.form.list.item', { label: text('en', 'q.A.metrics.label'), n: 1 }));
});

test('link lists have a note per row and write "link | note"', () => {
  const page = openForm({ language: 'en' });
  const like = part(page, 'E.like');
  const rows = findAll(like.root, (element) => element.localName === 'li' && element.className === 'row row-note');
  assert.equal(rows.length, 3);
  typeInto(rows[0].children[0], 'https://example.com');
  typeInto(rows[0].children[1], 'Calm layout');
  typeInto(rows[1].children[0], 'https://example.org');
  flush(page);
  assert.equal(page.app.analysis.entries['E.like'].body, '- https://example.com | Calm layout\n- https://example.org');
  typeInto(rows[2].children[0], 'just some words');
  flush(page);
  assert.equal(like.hint.textContent, `${text('en', 'ui.form.hint.notUrl', { item: 'just some words' })}`);
});

test('choice, multichoice, date and note write the lines the library expects', () => {
  const page = openForm({ language: 'en' });
  const languages = inputsOf(part(page, 'D.languages').root, 'checkbox').filter((input) => input.getAttribute('name') === 'f-D.languages-choice');
  pick(languages[1]);
  pick(languages[0]);
  assert.deepEqual(plain(page.app.state.answers['D.languages'].choice), ['da', 'en'], 'the order of the schema, not of the clicks');
  const note = byTag(part(page, 'D.languages').root, 'textarea')[0];
  typeInto(note, 'Mostly Danish');
  const deadline = inputsOf(part(page, 'A.deadline').root, 'date')[0];
  deadline.value = '2026-12-01';
  deadline.fire('change');
  flush(page);
  assert.equal(page.app.analysis.entries['D.languages'].body, 'Choice: da, en\nNote: Mostly Danish');
  assert.equal(page.app.analysis.entries['A.deadline'].body, 'Date: 2026-12-01');
  pick(languages[0], false);
  assert.deepEqual(plain(page.app.state.answers['D.languages'].choice), ['en']);
  deadline.value = '';
  deadline.fire('change');
  assert.equal(page.app.analysis.entries['A.deadline'], undefined, 'an empty date is not an answer');
});

test('attaching files: they are read, described and listed in the pack', async () => {
  const page = openForm({ language: 'en' });
  const logo = part(page, 'B.logo');
  const input = inputsOf(logo.root, 'file')[0];
  assert.equal(input.multiple, true);
  input.files = [fakeFile('Logo final.svg', LOGO_SVG), fakeFile('Logo final.svg', 'second')];
  input.fire('change');
  await until(() => findAll(logo.root, (element) => element.className === 'asset').length === 2, 'two files');
  const cards = findAll(logo.root, (element) => element.className === 'asset');
  assert.deepEqual(cards.map((card) => byTag(card, 'strong')[0].textContent), ['Logo-final.svg', 'Logo-final-2.svg']);
  const fields = byTag(cards[0], 'input');
  assert.equal(fields.length, 4);
  typeInto(fields[0], 'Primary logo');
  typeInto(fields[1], 'Nordlys Cykler');
  typeInto(fields[2], 'Owned by us');
  typeInto(fields[3], 'None');
  byTag(cards[1], 'button')[0].click();
  assert.equal(findAll(logo.root, (element) => element.className === 'asset').length, 1);
  const assets = plain(page.app.state.assets.map(({ name, what, owner, rights, restrictions, size }) => ({ name, what, owner, rights, restrictions, size })));
  assert.deepEqual(assets, [{ name: 'Logo-final.svg', what: 'Primary logo', owner: 'Nordlys Cykler', rights: 'Owned by us', restrictions: 'None', size: LOGO_SVG.length }]);
  flush(page);
  assert.equal(page.app.analysis.entries['B.logo'].body, '- assets/Logo-final.svg | Primary logo');
  assert.deepEqual(plain(page.app.analysis.packData.assets.rows.map((row) => row.file)), ['assets/Logo-final.svg']);
  assert.equal(input.value, '', 'the file input is emptied so the same file can be chosen again');
});

test('a file that cannot be read gives a message and the others are kept', async () => {
  const page = openForm({ language: 'en' });
  const input = inputsOf(part(page, 'B.logo').root, 'file')[0];
  const broken = { name: 'broken.png', size: 3, arrayBuffer: async () => Promise.reject(new Error('disk')) };
  input.files = [broken, fakeFile('ok.png', 'abc')];
  input.fire('change');
  await until(() => page.app.state.assets.length === 1, 'the readable file');
  assert.equal(page.app.state.assets[0].name, 'ok.png');
    assert.equal(part(page, 'B.logo').notices.alert.textContent, text('en', 'ui.form.files.readError', { name: 'broken.png' }));
});

test('moving between modules: the navigation, the buttons and the focus', () => {
  const page = openForm({ language: 'en', narrow: true });
  assert.equal(page.app.refs.navBox.open, false, 'the navigation starts closed on a narrow screen');
  const shown = () => [...page.app.sections].filter(([, entry]) => !entry.section.hidden).map(([id]) => id);
  page.app.navItems.get('C').button.click();
  assert.deepEqual(shown(), ['C']);
  assert.equal(page.app.navItems.get('C').button.getAttribute('aria-current'), 'step');
  assert.equal(page.app.navItems.get('A').button.hasAttribute('aria-current'), false);
  assert.equal(page.app.doc.activeElement, page.app.sections.get('C').heading, 'the module heading gets focus');
  assert.equal(page.app.state.currentModule, 'C');
  const section = page.app.sections.get('C').section;
  buttonByText(section, text('en', 'ui.form.nav.next')).click();
  assert.deepEqual(shown(), ['D']);
  buttonByText(page.app.sections.get('D').section, text('en', 'ui.form.nav.prev')).click();
  assert.deepEqual(shown(), ['C']);
  page.app.navItems.get('J').button.click();
  buttonByText(page.app.sections.get('J').section, text('en', 'ui.form.nav.toFinish')).click();
  assert.deepEqual(shown(), ['finish']);
  assert.equal(findAll(page.app.sections.get('finish').section, (element) => element.localName === 'button' && element.textContent === text('en', 'ui.form.nav.next')).length, 0);
  assert.equal(page.app.sections.get('A').section.getAttribute('id'), 'module-A');
});

test('the open must-answer questions are listed, and a click goes to the question', () => {
  const page = openForm({ language: 'da' });
  const links = byTag(page.app.refs.panel.list, 'button');
  assert.equal(links.length, 36);
  assert.equal(links[0].textContent, text('da', 'q.A.business.label'));
  page.app.navItems.get('D').button.click();
  links[0].click();
  assert.equal(page.app.state.currentModule, 'A');
  assert.equal(page.app.doc.activeElement, part(page, 'A.business').focus());
  const target = byTag(page.app.refs.panel.list, 'button').find((button) => button.textContent === text('da', 'q.I.domain.label'));
  pick(part(page, 'I.domain').toggle);
  target.click();
  assert.equal(page.app.state.currentModule, 'I');
  assert.equal(page.app.doc.activeElement, part(page, 'I.domain').toggle, 'a deferred question focuses its toggle');
});

test('the review step lists what is open, deferred and worth checking', () => {
  const page = openForm({ language: 'en' });
  typeInto(inputsOf(page.root, 'text').find((input) => input.id === 'recipient'), 'Jonas Berg');
  pick(part(page, 'I.domain').toggle);
  pick(inputsOf(part(page, 'I.domain').tbd, 'radio')[2]);
  typeInto(part(page, 'I.domain').ownerName, 'Peter');
  inputsOf(part(page, 'I.domain').tbd, 'date')[0].value = '2026-11-05';
  inputsOf(part(page, 'I.domain').tbd, 'date')[0].fire('change');
  typeInto(part(page, 'A.goal').focus(), 'x'.repeat(10));
  page.app.navItems.get('finish').button.click();
  const finish = page.app.refs.finish;
  assert.equal(finish.summary.textContent, text('en', 'ui.form.finish.summary', { done: 1, tbd: 1, missing: 73 }));
  assert.equal(byTag(finish.openList, 'li').length, 36);
  assert.equal(finish.openEmpty.hidden, true);
  assert.equal(
    textOf(finish.deferredList),
    text('en', 'ui.form.finish.deferredLine', {
      label: text('en', 'q.I.domain.label'),
      details: text('en', 'ui.form.finish.deferredItem', { owner: 'Peter', due: '2026-11-05' }),
    }),
  );
  assert.ok(textOf(finish.checksList).includes('too short'), 'the library message for the short answer');
  assert.equal(finish.nameHint.hidden, false);
  assert.equal(finish.sendHint.textContent, text('en', 'ui.form.finish.sendTo', { recipient: 'Jonas Berg' }));
  assert.equal(finish.download.textContent, text('en', 'ui.form.finish.download'));
});

test('downloading builds the zip in the browser and hands it over as a file', async () => {
  const page = openForm({ language: 'da' });
  typeInto(inputsOf(page.root, 'text').find((input) => input.id === 'respondent-name'), 'Anna Jensen');
  typeInto(inputsOf(page.root, 'text').find((input) => input.id === 'respondent-role'), 'Marketing');
  typeInto(part(page, 'A.goal').focus(), 'At få flere henvendelser fra private kunder, så vi kan fylde kalenderen to måneder frem.');
  pick(part(page, 'I.domain').toggle);
  page.app.navItems.get('finish').button.click();
  page.app.refs.finish.download.click();
  await until(() => page.doc.downloads.length === 1, 'the download');
  const name = `intake-pack-${localDate(new Date())}.zip`;
  assert.equal(page.doc.downloads[0].name, name);
  const blob = page.fake.blobs.get(page.doc.downloads[0].href);
  assert.equal(blob.type, 'application/zip');
  const entries = unzipPack(blobBytes(blob));
  assert.ok(entries.has('docs/00-brief.md') && entries.has('docs/intake-manifest.json') && entries.has('docs/assets.md'));
  const brief = textOfEntry(entries, 'docs/00-brief.md');
  assert.ok(brief.includes('respondent: "Anna Jensen, Marketing"'));
  assert.ok(brief.includes('At få flere henvendelser'));
  assert.match(page.app.refs.finish.notices.status.textContent, new RegExp(`^Pakken er hentet som ${name}`));
  assert.equal(page.app.refs.finish.download.disabled, false);
  assert.equal(page.app.refs.finish.notices.alert.textContent, '');
});

test('downloading before anything is answered gives a clear message and no file', async () => {
  const page = openForm({ language: 'en' });
  page.app.refs.finish.download.click();
  await until(() => page.app.refs.finish.notices.alert.textContent !== '', 'the message');
  assert.equal(page.app.refs.finish.notices.alert.textContent, text('en', 'ui.form.err.nothing'));
  assert.equal(page.doc.downloads.length, 0);
  assert.equal(page.app.refs.finish.download.disabled, false);
});

test('form data can be saved to a file and carried to another page', async () => {
  const source = openForm({ language: 'da' });
  typeInto(inputsOf(source.root, 'text').find((input) => input.id === 'respondent-name'), 'Anna Jensen');
  typeInto(part(source, 'A.budget').focus(), '150.000 kr.');
  pick(inputsOf(part(source, 'A.project-kind').root, 'radio')[1]);
  const logoInput = inputsOf(part(source, 'B.logo').root, 'file')[0];
  logoInput.files = [fakeFile('logo.svg', LOGO_SVG)];
  logoInput.fire('change');
  await until(() => source.app.state.assets.length === 1, 'the file');
  source.app.exportData();
  assert.equal(source.doc.downloads[0].name, `everything-mapped-form-${localDate(new Date())}.json`);
  const blob = source.fake.blobs.get(source.doc.downloads[0].href);
  assert.equal(blob.type, 'application/json');
  const json = blobBytes(blob).toString('utf8');
  assert.equal(JSON.parse(json).format, 'everything-mapped-form/1');

  const target = openForm({ language: 'en' });
  await target.app.importFile(fakeFile('saved.json', json));
  assert.equal(target.app.state.language, 'da', 'the saved language wins');
  assert.equal(target.doc.documentElement.lang, 'da');
  assert.equal(target.app.refs.top.status.textContent, text('da', 'ui.form.import.done'));
  assert.equal(part(target, 'A.budget').focus().value, '150.000 kr.');
  assert.equal(inputsOf(part(target, 'A.project-kind').root, 'radio')[1].checked, true);
  assert.equal(Buffer.from(target.app.state.assets[0].data).toString(), LOGO_SVG);
  assert.equal(findAll(part(target, 'B.logo').root, (element) => element.className === 'asset').length, 1);
  assert.equal(inputsOf(target.root, 'text').find((input) => input.id === 'respondent-name').value, 'Anna Jensen');
});

test('loading a file that is not form data changes nothing and says why', async () => {
  const page = openForm({ language: 'en' });
  typeInto(part(page, 'A.budget').focus(), '10');
  await page.app.importFile(fakeFile('x.json', '{"hello": 1}'));
  assert.equal(page.app.refs.top.alert.textContent, text('en', 'ui.form.err.importFormat'));
  await page.app.importFile(fakeFile('x.json', 'not json'));
  assert.equal(page.app.refs.top.alert.textContent, text('en', 'ui.form.err.importRead'));
  assert.equal(page.app.state.answers['A.budget'].text, '10');
  await page.app.importFile({ text: async () => Promise.reject(new Error('gone')) });
  assert.equal(page.app.refs.top.alert.textContent, text('en', 'ui.form.err.importRead'));
});

test('loading form data asks before it replaces answers that are in the form', async () => {
  const asked = [];
  const page = openForm({ language: 'en', confirm: (message) => asked.push(message) && false });
  typeInto(part(page, 'A.budget').focus(), '10');
  const other = openForm({ language: 'en' });
  typeInto(part(other, 'A.budget').focus(), '20');
  const json = JSON.stringify(other.app.engine.serializeState(other.app.state));
  await page.app.importFile(fakeFile('x.json', json));
  assert.deepEqual(asked, [text('en', 'ui.form.import.confirm')]);
  assert.equal(page.app.state.answers['A.budget'].text, '10');
});

test('answers are saved in the browser and come back on the next visit', () => {
  const storage = createMemoryStorage();
  const first = openForm({ language: 'da', storage });
  typeInto(part(first, 'A.budget').focus(), '150.000 kr.');
  pick(part(first, 'I.domain').toggle);
  first.app.navItems.get('E').button.click();
  first.fake.runTimers();
  assert.ok(storage.getItem(STORAGE_KEY));

  const second = openForm({ language: 'en-GB', storage });
  assert.equal(second.app.state.language, 'da', 'the saved language is used');
  assert.equal(part(second, 'A.budget').focus().value, '150.000 kr.');
  assert.equal(part(second, 'I.domain').toggle.checked, true);
  assert.equal(second.app.state.currentModule, 'E');
  assert.equal(second.app.refs.top.status.textContent, text('da', 'ui.form.save.restored'));
  assert.equal(second.app.sections.get('E').section.hidden, false);
});

test('the form works without storage: blocked, missing or refusing to write', () => {
  const blocked = openForm({ language: 'en', storage: createBrokenStorage() });
  assert.equal(blocked.app.storage, null);
  assert.equal(blocked.app.refs.panel.save.textContent, text('en', 'ui.form.save.unavailable'));
  typeInto(part(blocked, 'A.budget').focus(), '10');
  blocked.fake.runTimers();
  assert.equal(blocked.app.analysis.entries['A.budget'].body, '10');

  const missing = openForm({ language: 'en', storage: null });
  assert.equal(missing.app.storage, null);
  typeInto(part(missing, 'A.budget').focus(), '10');
  missing.fake.runTimers();

  const denied = openForm({ language: 'en' });
  Object.defineProperty(denied.fake.win, 'localStorage', { get: () => { throw new Error('SecurityError'); } });
  const doc = new FakeDocument();
  const root = doc.createElement('div');
  root.setAttribute('id', 'app');
  doc.body.appendChild(root);
  const app = emfc.startForm(doc, denied.fake.win, data);
  assert.equal(app.storage, null);

  const memory = createMemoryStorage();
  const full = {
    getItem: (key) => memory.getItem(key),
    removeItem: (key) => memory.removeItem(key),
    setItem: (key, value) => {
      if (key === STORAGE_KEY) throw new Error('QuotaExceededError');
      memory.setItem(key, value);
    },
  };
  const quota = openForm({ language: 'en', storage: full });
  typeInto(part(quota, 'A.budget').focus(), '10');
  quota.fake.runTimers();
  assert.equal(quota.app.refs.panel.save.textContent, text('en', 'ui.form.save.failed'));
});

test('attached files are never saved in the browser: only their names, descriptions and sizes', async () => {
  const storage = createMemoryStorage();
  const page = openForm({ language: 'en', storage });
  const input = inputsOf(part(page, 'B.logo').root, 'file')[0];
  input.files = [fakeFile('logo.svg', LOGO_SVG)];
  input.fire('change');
  await until(() => page.app.state.assets.length === 1, 'the file');
  const description = findAll(part(page, 'B.logo').root, (element) => element.localName === 'input' && element.getAttribute('type') === 'text')[0];
  typeInto(description, 'Hovedlogo');
  page.fake.runTimers();
  const text64 = Buffer.from(LOGO_SVG).toString('base64');
  const saved = JSON.parse(storage.getItem(STORAGE_KEY));
  assert.equal(saved.assets.length, 1);
  assert.equal(Object.hasOwn(saved.assets[0], 'data'), false, 'no content of the file');
  assert.equal(saved.assets[0].name, 'logo.svg');
  assert.equal(saved.assets[0].what, 'Hovedlogo');
  assert.equal(saved.assets[0].size, LOGO_SVG.length);
  assert.ok(!storage.getItem(STORAGE_KEY).includes(text64), 'the content is nowhere in the stored text');
  assert.match(page.app.refs.panel.save.textContent, /^Saved in this browser at .+\. Attached files are never kept in the browser\./);

  input.files = [fakeFile('photo.jpg', new Uint8Array(1600000))];
  input.fire('change');
  await until(() => page.app.state.assets.length === 2, 'the big file');
  page.fake.runTimers();
  const bigger = JSON.parse(storage.getItem(STORAGE_KEY));
  assert.equal(bigger.assets.length, 2);
  assert.equal(bigger.assets.some((asset) => asset.data), false);
  assert.ok(storage.getItem(STORAGE_KEY).length < 20000, 'the stored text stays small however big the files are');

  const next = openForm({ language: 'en', storage });
  const cards = findAll(part(next, 'B.logo').root, (element) => element.className === 'asset');
  assert.equal(cards.length, 2);
  assert.ok(textOf(cards[0]).includes(text('en', 'ui.form.files.noData')));
  assert.equal(next.app.analysis.usable.length, 0, 'files without content stay out of the pack');
  assert.ok(next.app.refs.top.status.textContent.includes('logo.svg, photo.jpg'), 'the notice names the files to attach again');
});

test('"Clear saved data" asks first, then empties the form and the storage', () => {
  const storage = createMemoryStorage();
  const answers = [false, true];
  const page = openForm({ language: 'en', storage, confirm: () => answers.shift() });
  typeInto(part(page, 'A.budget').focus(), '10');
  page.fake.runTimers();
  assert.ok(storage.getItem(STORAGE_KEY));
  const clear = buttonByText(page.root, text('en', 'ui.form.privacy.clear'));
  clear.click();
  assert.equal(page.app.state.answers['A.budget'].text, '10', 'nothing happens when the person says no');
  assert.ok(storage.getItem(STORAGE_KEY));
  clear.click();
  assert.equal(storage.getItem(STORAGE_KEY), null);
  assert.equal(page.app.state.answers['A.budget'], undefined);
  assert.equal(part(page, 'A.budget').focus().value, '');
  assert.equal(page.app.refs.top.status.textContent, text('en', 'ui.form.privacy.cleared'));
  page.fake.runTimers();
  const reopened = openForm({ language: 'en', storage });
  assert.equal(reopened.app.state.answers['A.budget'], undefined);
});

test('switching language rebuilds the texts, keeps the answers and the place, and moves focus to the button', () => {
  const page = openForm({ language: 'da' });
  typeInto(part(page, 'A.budget').focus(), '10');
  page.app.navItems.get('C').button.click();
  const english = page.app.refs.langButtons.en;
  assert.equal(english.getAttribute('aria-pressed'), 'false');
  assert.equal(english.getAttribute('lang'), 'en');
  assert.equal(page.app.refs.langButtons.da.getAttribute('aria-pressed'), 'true');
  english.click();
  assert.equal(page.app.state.language, 'en');
  assert.equal(page.doc.documentElement.lang, 'en');
  assert.equal(page.doc.title, text('en', 'ui.form.title'));
  assert.equal(page.app.refs.langButtons.en.getAttribute('aria-pressed'), 'true');
  assert.equal(page.doc.activeElement, page.app.refs.langButtons.en);
  assert.equal(page.app.state.currentModule, 'C');
  assert.equal(page.app.sections.get('C').section.hidden, false);
  assert.equal(part(page, 'A.budget').focus().value, '10');
  assert.ok(textOf(part(page, 'A.goal').root).includes(text('en', 'q.A.goal.label')));
  assert.ok(!textOf(page.root).includes(text('da', 'q.A.goal.label')));
  page.fake.runTimers();
  assert.equal(JSON.parse(page.fake.win.localStorage.getItem(STORAGE_KEY)).language, 'en');
});

test('nothing a person can read contains the word gate or a missing text key, in either language', () => {
  for (const lang of ['da', 'en']) {
    const page = openForm({ language: lang });
    pick(inputsOf(page.root, 'radio').find((input) => input.getAttribute('name') === 'depth' && input.value === 'full'));
    typeInto(part(page, 'A.goal').focus(), 'Kort');
    pick(part(page, 'I.domain').toggle);
    page.app.navItems.get('finish').button.click();
    page.app.refs.finish.download.click();
    const strings = readableStrings(page.root).join('\n');
    assert.ok(strings.length > 20000);
    assert.equal(/gate/i.test(strings), false, `${lang}: the word "gate" is visible`);
    assert.equal(/\bui\.form\.|\bq\.[A-J]\.|\bmodule\.[A-J]\.|\blevel\.|\bstatus\.|\bdepth\.|\bchoice\.[A-J]\./.test(strings), false, `${lang}: a text key shows through`);
    assert.equal(strings.includes('undefined') || strings.includes('[object'), false, `${lang}: a value is missing`);
    assert.equal(strings.includes(String.fromCharCode(0x2014)), false, `${lang}: an em dash is visible`);
  }
});

test('every text of the form exists in both languages and the page shows no raw placeholders', () => {
  for (const lang of ['da', 'en']) {
    const page = openForm({ language: lang });
    page.app.navItems.get('finish').button.click();
    const strings = readableStrings(page.root).join('\n');
    assert.equal(/\{[A-Za-z]+\}/.test(strings), false, `${lang}: a placeholder was left as written`);
  }
});

test('the page code never assembles HTML from text', () => {
  const page = openForm({ language: 'en' });
  typeInto(part(page, 'A.business').focus(), '<img src=x onerror=alert(1)><script>alert(1)</script>');
  typeInto(inputsOf(page.root, 'text').find((input) => input.id === 'respondent-name'), '<b>Anna</b>');
  page.app.navItems.get('finish').button.click();
  page.app.flush();
  assert.equal(byTag(page.root, 'img').length, 0);
  assert.equal(byTag(page.root, 'script').length, 0);
  assert.equal(byTag(page.root, 'b').length, 0);
});

test('a visit that ended on the review step comes back to it, with the lists filled in', () => {
  const storage = createMemoryStorage();
  const first = openForm({ language: 'en', storage });
  typeInto(part(first, 'A.budget').focus(), '10');
  pick(part(first, 'I.domain').toggle);
  first.app.navItems.get('finish').button.click();
  first.fake.runTimers();
  const second = openForm({ language: 'en', storage });
  assert.equal(second.app.state.currentModule, 'finish');
  assert.equal(second.app.sections.get('finish').section.hidden, false);
  assert.equal(second.app.refs.finish.summary.textContent, text('en', 'ui.form.finish.summary', { done: 1, tbd: 1, missing: 73 }));
  assert.equal(byTag(second.app.refs.finish.deferredList, 'li').length, 1);
});

test('the choice of depth is kept, and the pack records it', async () => {
  const storage = createMemoryStorage();
  const first = openForm({ language: 'da', storage });
  pick(inputsOf(first.root, 'radio').find((input) => input.getAttribute('name') === 'depth' && input.value === 'essentials'));
  typeInto(part(first, 'A.goal').focus(), 'At få flere henvendelser fra private kunder, så vi kan fylde kalenderen.');
  first.fake.runTimers();
  const second = openForm({ language: 'da', storage });
  assert.equal(inputsOf(second.root, 'radio').find((input) => input.getAttribute('name') === 'depth' && input.value === 'essentials').checked, true);
  assert.ok(visibleIds(second).every((id) => second.app.analysis.report.questions[id].level === 'gate1'));
  second.app.refs.finish.download.click();
  await until(() => second.doc.downloads.length === 1, 'the download');
  const entries = unzipPack(blobBytes(second.fake.blobs.get(second.doc.downloads[0].href)));
  assert.equal(JSON.parse(textOfEntry(entries, 'docs/intake-manifest.json')).depth, 'essentials');
  assert.equal(JSON.parse(textOfEntry(entries, 'docs/intake-state.json')).depth, 'essentials');
});
