// Random use of the whole page: many clicks, entries and switches in a repeatable order. After
// every step the page must still agree with the engine, and the pack must build or say why not.

import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeDocument, byTag, createFakeWindow, createMemoryStorage, fakeFile, findAll, readableStrings } from './fake-dom.mjs';
import { loadBrowserScript, plain, unzipPack } from './helpers.mjs';

const { emfc, data } = loadBrowserScript();

// A small repeatable random number generator (mulberry32).
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ['rolig', 'varm', 'https://example.com/side', 'a | b', '# overskrift', '<b>fed</b>', '-->', 'Æblegrød', 'x'.repeat(80), '', '   '];

function openForm(seed) {
  const doc = new FakeDocument();
  const root = doc.createElement('div');
  root.setAttribute('id', 'app');
  doc.body.appendChild(root);
  const fake = createFakeWindow({ language: seed % 2 === 0 ? 'da' : 'en', storage: createMemoryStorage() });
  return { app: emfc.startForm(doc, fake.win, data), doc, root, fake };
}

function pickOne(next, list) {
  return list[Math.floor(next() * list.length)];
}

function controlsOf(page) {
  const visible = [...page.app.parts.values()].filter((part) => !part.root.hidden);
  const all = visible.flatMap((part) => findAll(part.root, (element) => !element.hidden && ['input', 'textarea', 'button', 'select'].includes(element.localName)));
  return all.filter((element) => element.getAttribute('type') !== 'file');
}

function useControl(page, element, next) {
  const type = element.getAttribute('type');
  if (element.localName === 'button') element.click();
  else if (type === 'checkbox' || type === 'radio') {
    element.checked = type === 'radio' ? true : !element.checked;
    element.fire('change');
  } else if (type === 'date') {
    element.value = pickOne(next, ['', '2026-12-01', '2020-01-01', '2027-02-30']);
    element.fire('change');
  } else {
    element.value = pickOne(next, WORDS);
    element.fire('input');
  }
}

async function oneStep(page, next) {
  const roll = next();
  if (roll < 0.62) {
    const controls = controlsOf(page);
    if (controls.length > 0) useControl(page, pickOne(next, controls), next);
  } else if (roll < 0.72) {
    page.app.navItems.get(pickOne(next, [...page.app.navItems.keys()])).button.click();
  } else if (roll < 0.76) {
    page.app.refs.langButtons[pickOne(next, ['da', 'en'])].click();
  } else if (roll < 0.8) {
    const depth = findAll(page.root, (element) => element.getAttribute('name') === 'depth');
    pickOne(next, depth).checked = true;
    pickOne(next, depth).fire('change');
  } else if (roll < 0.85) {
    const input = pickOne(next, findAll(page.root, (element) => element.getAttribute('type') === 'file' && element.id.startsWith('f-')));
    input.files = [fakeFile(pickOne(next, ['logo.svg', 'a b.png', '../x.txt']), 'content')];
    input.fire('change');
    await new Promise((resolve) => setTimeout(resolve, 2));
  } else if (roll < 0.9) {
    page.fake.runTimers();
  } else if (roll < 0.93) {
    page.app.exportData();
  }
}

function check(page) {
  page.app.flush();
  const { analysis } = page.app;
  assert.equal(analysis.problems.length, 0, 'the library accepts every input the form makes');
  const report = analysis.report;
  for (const [id, part] of page.app.parts) {
    const entry = report.questions[id];
    const visible = entry.level !== 'skipped' && page.app.engine.isVisible(report, id, page.app.state.depth);
    assert.equal(part.root.hidden, !visible, `${id}: shown or hidden`);
    if (visible) assert.equal(part.status.textContent === '', entry.status === 'missing', `${id}: status text`);
  }
  const strings = readableStrings(page.root).join('\n');
  assert.ok(!/gate/i.test(strings) && !/\bui\.form\./.test(strings) && !strings.includes('undefined'));
  const progress = page.app.engine.progress(report, page.app.state.depth);
  assert.equal(page.app.refs.panel.track.getAttribute('aria-valuenow'), String(progress.total.total === 0 ? 0 : Math.round((progress.total.done / progress.total.total) * 100)));
  assert.equal(byTag(page.root, 'h1').length, 1);
}

for (const seed of [1, 2, 3, 4, 5, 6]) {
  test(`random use of the page keeps it consistent, and the pack builds or says why not (seed ${seed})`, async () => {
    const page = openForm(seed);
    const next = random(seed);
    for (let step = 0; step < 220; step += 1) {
      await oneStep(page, next);
      check(page);
    }
    page.app.flush();
    const answered = page.app.engine.inputsFromState(page.app.state).inputs.length;
    assert.ok(answered >= 5, `only ${answered} answers after 220 steps: the random use did not reach the questions`);
    try {
      const pack = await page.app.engine.buildPack(page.app.state, { now: new Date('2026-10-23T12:00:00Z'), today: '2026-10-23' });
      const entries = unzipPack(pack.bytes);
      assert.ok(entries.has('docs/00-brief.md'));
      const saved = JSON.parse(JSON.stringify(page.app.engine.serializeState(page.app.state)));
      const restored = page.app.engine.restoreState(saved);
      assert.equal(restored.ok, true);
      assert.deepEqual(plain(page.app.engine.inputsFromState(restored.state).inputs), plain(page.app.engine.inputsFromState(page.app.state).inputs));
    } catch (error) {
      assert.equal(error.key, 'ui.form.err.nothing', String(error && error.stack));
    }
  });
}
