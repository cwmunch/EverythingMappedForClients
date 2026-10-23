// The page of the static form: it builds every element with createElement and textContent (no
// HTML is ever assembled from text), keeps the form's state in one object and talks to the
// engine for everything that is not about elements.
//
// tools/build-form.mjs inlines this file after engine.js, so it shares that scope. All browser
// objects reach it through `doc` (the document) and `win` (the window), so a test can pass a
// stand-in for both. The last lines expose window.__emfc and start the form when a page is there.

const BROKEN_SUFFIX = '.broken';
// Whether this browser keeps the answers: '1' or '0', stored next to the answers.
const KEEP_SUFFIX = '.keep';
const REFRESH_DELAY = 150;
const SAVE_DELAY = 500;
// The longest list of names that a message holds before it says "and N more".
const LISTED_NAMES = 8;
const NARROW_SCREEN = '(max-width: 56rem)';
const GROUPED_TYPES = ['list', 'urllist', 'choice', 'multichoice', 'files'];
const DIRECT_PROPERTIES = ['value', 'checked', 'disabled', 'hidden', 'multiple'];
const EMPTY_RECORD = Object.freeze({});
const LEVEL_KEYS = { gate1: 'level.gate1.short', recommended: 'level.recommended', optional: 'level.optional' };
const OWNER_KEYS = { client: 'ui.form.unknown.owner.client', me: 'ui.form.unknown.owner.me', other: 'ui.form.unknown.owner.other' };
const LANGUAGE_KEYS = { da: 'ui.form.lang.da', en: 'ui.form.lang.en' };

// ---------------------------------------------------------------------------------------------
// Small helpers

function appendChildren(doc, element, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) appendChildren(doc, element, child);
    else if (typeof child === 'object') element.appendChild(child);
    else element.appendChild(doc.createTextNode(String(child)));
  }
}

// props: attributes, with `class`, `on<event>` handlers and a few element properties. Put `type`
// before `value` so an input has its type when it gets its value.
function buildElement(doc, tag, props, children) {
  const element = doc.createElement(tag);
  for (const [name, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (name === 'class') element.className = value;
    else if (name.startsWith('on')) element.addEventListener(name.slice(2), value);
    else if (DIRECT_PROPERTIES.includes(name)) element[name] = value;
    else element.setAttribute(name, value === true ? '' : String(value));
  }
  appendChildren(doc, element, children);
  return element;
}

function fieldId(questionId) {
  return `f-${questionId}`;
}

function setText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

function formatBytes(bytes, lang) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = String(Math.round(value * 10) / 10);
  return `${lang === 'da' ? text.replace('.', ',') : text} ${units[unit]}`;
}

function languageFromBrowser(win) {
  const language = win.navigator && typeof win.navigator.language === 'string' ? win.navigator.language : '';
  return language.toLowerCase().startsWith('da') ? 'da' : 'en';
}

// The storage object, or null when the browser has none or refuses it (private windows, blocked
// site data). The form works without it.
function safeStorage(win, key) {
  try {
    const storage = win.localStorage;
    if (!storage) return null;
    storage.setItem(`${key}.probe`, '1');
    storage.removeItem(`${key}.probe`);
    return storage;
  } catch {
    return null;
  }
}

function readEmbeddedData(doc) {
  const read = (id) => JSON.parse(doc.getElementById(id).textContent);
  const schema = read('emfc-schema');
  const dictionaries = {};
  for (const lang of schema.languages) dictionaries[lang] = read(`emfc-texts-${lang}`);
  const config = read('emfc-config');
  return { schema, dictionaries, toolVersion: config.toolVersion, storageKey: config.storageKey };
}

function isNarrowScreen(win) {
  return typeof win.matchMedia === 'function' && win.matchMedia(NARROW_SCREEN).matches;
}

function supportsAutoSizing(win) {
  return Boolean(win.CSS && typeof win.CSS.supports === 'function' && win.CSS.supports('field-sizing', 'content'));
}

function autosize(app, field) {
  if (supportsAutoSizing(app.win) || !field.scrollHeight) return;
  field.style.height = 'auto';
  field.style.height = `${field.scrollHeight + 2}px`;
}

function clockText(app) {
  try {
    return new Date().toLocaleTimeString(app.state.language, { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

// A dictionary that never shows a key: a text the dictionary does not have is replaced by the
// general message, so a gap in the texts cannot put "ui.form.something" in front of a person.
function guardedI18n(base) {
  return {
    lang: base.lang,
    has: base.has,
    keys: base.keys,
    t: (key, params) => (base.has(key) ? base.t(key, params) : base.t('ui.form.err.unexpected')),
  };
}

// What was typed or pasted into a field, cleaned (see cleanField). The field is changed to show the
// cleaned text, so what is on the screen is what goes into the pack. `note` (optional, see
// buildRemovedNote) is told how many hidden characters were taken out.
function typedValue(field, limit, note) {
  const typed = field.value;
  const cleaned = cleanField(typed, limit);
  if (cleaned !== typed) field.value = cleaned;
  if (note) note.add(countRemoved(typed));
  return cleaned;
}

// One quiet line next to a group of fields that says how many hidden characters were taken out of
// what was typed or pasted there. It stays empty until that happens.
function buildRemovedNote(app) {
  const note = app.h('p', { class: 'hint', role: 'status', hidden: true });
  note.total = 0;
  note.add = (count) => {
    if (count <= 0) return;
    note.total += count;
    setText(note, app.t('ui.form.hint.removed', { count: note.total }));
    note.hidden = false;
  };
  return note;
}

// "a.png, b.png and 3 more": the first names of a list, for a message.
function namesText(app, names) {
  const shown = names.slice(0, LISTED_NAMES).join(', ');
  return names.length > LISTED_NAMES ? `${shown} ${app.t('ui.form.more', { count: names.length - LISTED_NAMES })}` : shown;
}

// The message for an error: its own text when it is one of ours, else the general message. The
// message of an error is never shown, because a library error carries a text key.
function errorText(app, error, fallbackKey) {
  if (error instanceof FormError && app.i18n.has(error.key)) return app.t(error.key, error.params);
  if (typeof console !== 'undefined') console.error(error);
  return app.t(fallbackKey);
}

// ---------------------------------------------------------------------------------------------
// The app object

function createApp(env) {
  const app = {
    doc: env.doc,
    win: env.win,
    engine: env.engine,
    storage: env.storage,
    key: env.engine.storageKey,
    state: env.state,
    restored: Boolean(env.restored),
    recovered: Boolean(env.recovered),
    notes: env.notes || null,
    broken: env.broken ?? null,
    // Whether the answers are kept in this browser (see readKeepSetting), which copy in the storage
    // this window read or wrote last (revision, writeId; revision -1 means none was read), and whether
    // the storage holds another copy that has not been dealt with yet (conflict).
    keep: Boolean(env.keep),
    revision: env.copy ? env.copy.revision : env.storage && env.keep ? 0 : -1,
    writeId: env.copy ? env.copy.writeId : '',
    conflict: false,
    i18n: null,
    root: null,
    analysis: null,
    parts: new Map(),
    sections: new Map(),
    navItems: new Map(),
    refs: {},
    pending: new Map(),
  };
  app.h = (tag, props, ...children) => buildElement(app.doc, tag, props, children);
  app.t = (key, params) => app.i18n.t(key, params);
  app.read = (id) => app.state.answers[id] || EMPTY_RECORD;
  app.edit = (id) => app.engine.record(app.state, id);
  app.render = () => renderApp(app);
  app.refresh = () => refreshApp(app);
  app.changed = (immediate) => scheduleWork(app, immediate);
  app.flush = () => flushWork(app);
  app.showModule = (id, options) => showModule(app, id, options);
  app.goTo = (id) => goToQuestion(app, id);
  app.notify = (message) => showNotice(app.refs.top, 'status', message);
  app.fail = (message) => showNotice(app.refs.top, 'alert', message);
  app.download = () => downloadPack(app);
  app.exportData = () => exportFormData(app);
  app.importFile = (file) => importFormData(app, file);
  app.clearSaved = () => clearSavedData(app);
  app.removeSaved = () => removeSavedAnswers(app);
  app.setKeep = (on) => setKeep(app, on);
  app.showOtherAnswers = () => showOtherAnswers(app);
  app.keepThisWindow = () => keepThisWindow(app);
  app.checkStorage = () => checkStorage(app);
  app.setLanguage = (lang) => setLanguage(app, lang);
  app.yieldToPage = () => nextTurn(app.win);
  return app;
}

// A message area is a status line and an alert line next to what the message is about. Both stay
// in the page (empty ones take no room), so screen readers announce a message when its text changes.
function buildNotices(app) {
  const status = app.h('p', { class: 'notice', role: 'status' });
  const alert = app.h('p', { class: 'notice notice-error', role: 'alert' });
  return { status, alert, element: app.h('div', { class: 'notices' }, status, alert) };
}

function showNotice(area, kind, message) {
  setText(area.status, kind === 'status' ? message : '');
  setText(area.alert, kind === 'alert' ? message : '');
}

// ---------------------------------------------------------------------------------------------
// Refreshing and saving (debounced, so typing stays smooth)

// Something changed: refresh the page (at once, or after a short pause while typing) and save later.
function scheduleWork(app, immediate) {
  if (immediate) {
    cancelPending(app, 'refresh');
    refreshApp(app);
  } else {
    schedule(app, 'refresh', REFRESH_DELAY, () => refreshApp(app));
  }
  schedule(app, 'save', SAVE_DELAY, () => persistState(app));
}

function cancelPending(app, name) {
  const entry = app.pending.get(name);
  if (!entry) return;
  app.win.clearTimeout(entry.timer);
  app.pending.delete(name);
}

function schedule(app, name, delay, task) {
  cancelPending(app, name);
  const entry = { task, timer: null };
  entry.timer = app.win.setTimeout(() => runPending(app, name), delay);
  app.pending.set(name, entry);
}

function runPending(app, name) {
  const entry = app.pending.get(name);
  if (!entry) return;
  cancelPending(app, name);
  entry.task();
}

// Runs what is waiting now (a test, or before the page is left; then only the save matters).
function flushWork(app, names = ['refresh', 'save']) {
  for (const name of names) runPending(app, name);
}

function cancelWork(app) {
  for (const name of [...app.pending.keys()]) cancelPending(app, name);
}

// ---------------------------------------------------------------------------------------------
// Keeping the answers in this browser
//
// What goes into the browser's storage: the answers, and of an attached file its name, description
// and size, never its content. Each copy carries a number (revision) and a mark of its own
// (writeId). A window only writes over the copy it read or wrote last; if the storage holds another
// one (a second window saved, or the copy was removed), the person chooses (raiseConflict).

// A page opened from a file shares its storage with every other page opened from a file on this
// computer, so other pages could read the answers.
function isFilePage(win) {
  return Boolean(win.location) && win.location.protocol === 'file:';
}

// Whether the answers are kept in this browser: what the person chose last, else off for a page
// opened from a file and on for a web address.
function readKeepSetting(storage, key, win) {
  try {
    const value = storage.getItem(key + KEEP_SUFFIX);
    if (value === '1') return true;
    if (value === '0') return false;
  } catch {
    // Nothing chosen yet, or the storage refuses: the default below.
  }
  return !isFilePage(win);
}

function writeKeepSetting(app, on) {
  try {
    app.storage.setItem(app.key + KEEP_SUFFIX, on ? '1' : '0');
  } catch {
    // The choice holds for this visit only.
  }
}

function attachedCount(state) {
  return state.assets.filter((asset) => asset.data).length;
}

function saveStatusText(app, result) {
  if (!app.storage) return app.t('ui.form.save.unavailable');
  if (!app.keep) return app.t('ui.form.save.off');
  if (app.conflict) return app.t('ui.form.save.paused');
  if (!result.ok) return app.t('ui.form.save.failed');
  const time = clockText(app);
  return result.files ? app.t('ui.form.save.savedNoFiles', { time }) : app.t('ui.form.save.saved', { time });
}

function showSaveStatus(app, result) {
  if (app.refs.panel) setText(app.refs.panel.save, saveStatusText(app, result));
}

// What the storage holds under our key: { exists, revision, writeId, damaged }, or null when the
// storage cannot be read.
function readStoredCopy(app) {
  let text;
  try {
    text = app.storage.getItem(app.key);
  } catch {
    return null;
  }
  if (text === null || text === undefined) return { exists: false, revision: 0, writeId: '', damaged: false };
  try {
    const raw = JSON.parse(text);
    if (!isPlainObject(raw)) throw new Error('not saved form data');
    return { exists: true, damaged: false, ...app.engine.copyOf(raw) };
  } catch {
    return { exists: true, revision: 0, writeId: '', damaged: true };
  }
}

// Whether the stored copy is not the one this window read or wrote last.
function isForeign(app, stored) {
  if (!stored.exists) return app.revision > 0;
  return stored.damaged || stored.revision !== app.revision || stored.writeId !== app.writeId;
}

function newWriteId() {
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
}

function removeStored(storage, key) {
  for (const name of [key, key + BROKEN_SUFFIX]) {
    try {
      storage.removeItem(name);
    } catch {
      // The form works without storage, so there is nothing more to do.
    }
  }
}

function storeCopy(app, revision) {
  const writeId = newWriteId();
  try {
    const saved = app.engine.serializeState(app.state, { files: false, savedAt: isoDateTime(new Date()), revision, writeId });
    app.storage.setItem(app.key, JSON.stringify(saved));
  } catch {
    return { ok: false, files: false };
  }
  app.revision = revision;
  app.writeId = writeId;
  return { ok: true, files: attachedCount(app.state) > 0 };
}

// Another copy is in the storage: saving stops and the person is asked (the notice with two buttons).
function raiseConflict(app) {
  if (app.conflict) return;
  app.conflict = true;
  cancelPending(app, 'save');
  if (app.refs.sync) app.refs.sync.element.hidden = false;
  if (app.refs.top) showNotice(app.refs.top, 'status', '');
  showSaveStatus(app, { ok: false });
}

function clearConflict(app) {
  app.conflict = false;
  if (app.refs.sync) app.refs.sync.element.hidden = true;
}

// Writes the state to the browser's storage, unless the person does not keep answers here, the page
// waits for a choice, or the storage holds a copy this window did not write. Returns { ok, files }.
function writeState(app) {
  if (!app.storage || !app.keep || app.conflict) return { ok: false, files: false };
  const stored = readStoredCopy(app);
  if (stored === null) return { ok: false, files: false };
  if (isForeign(app, stored)) {
    raiseConflict(app);
    return { ok: false, files: false };
  }
  return storeCopy(app, Math.max(app.revision, 0) + 1);
}

function persistState(app) {
  const result = writeState(app);
  showSaveStatus(app, result);
  return result;
}

// A second window saved (or removed) the answers: look at the storage now, so the notice shows at once.
function checkStorage(app) {
  if (!app.storage || !app.keep || app.conflict) return false;
  const stored = readStoredCopy(app);
  if (stored === null || !isForeign(app, stored)) return false;
  raiseConflict(app);
  return true;
}

// "Show the other window's answers": the page shows what the storage holds. Attached files that this
// window has and the stored copy lists (storage never holds their content) stay.
function showOtherAnswers(app) {
  const loaded = loadSavedState(app.engine, app.storage, app.key);
  if (loaded.text) {
    app.fail(app.t('ui.form.sync.unreadable'));
    return;
  }
  const state = loaded.state ? app.engine.adoptFiles(app.state, loaded.state) : app.engine.newState({ language: app.state.language });
  const before = { revision: app.revision, writeId: app.writeId, conflict: app.conflict };
  app.revision = loaded.copy ? loaded.copy.revision : 0;
  app.writeId = loaded.copy ? loaded.copy.writeId : '';
  app.conflict = false;
  try {
    replaceState(app, state);
  } catch (error) {
    Object.assign(app, before);
    renderApp(app);
    app.fail(errorText(app, error, 'ui.form.err.importInvalid'));
    return;
  }
  app.notify(app.t('ui.form.sync.shown'));
}

// "Keep what is in this window": this window's answers replace the stored ones, on purpose.
function keepThisWindow(app) {
  const stored = readStoredCopy(app);
  if (stored === null) {
    app.fail(app.t('ui.form.save.failed'));
    return;
  }
  cancelPending(app, 'save');
  const result = storeCopy(app, Math.max(stored.revision, app.revision, 0) + 1);
  if (!result.ok) {
    showSaveStatus(app, result);
    app.fail(app.t('ui.form.save.failed'));
    return;
  }
  clearConflict(app);
  showSaveStatus(app, result);
  app.notify(app.t('ui.form.sync.kept'));
}

// The box "Keep my answers in this browser". Off removes what is stored; the page keeps what it shows.
// `notices` is where the message goes (the top of the page by default).
function setKeep(app, on, notices = app.refs.top) {
  if (!app.storage) return;
  app.keep = on;
  writeKeepSetting(app, on);
  if (app.refs.keepBox) app.refs.keepBox.checked = on;
  if (on) {
    cancelPending(app, 'save');
    persistState(app);
    return;
  }
  cancelPending(app, 'save');
  removeStored(app.storage, app.key);
  app.revision = 0;
  app.writeId = '';
  clearConflict(app);
  showSaveStatus(app, { ok: false });
  showNotice(notices, 'status', app.t('ui.form.keep.removed'));
}

// The button after a download: the same as turning the box off.
function removeSavedAnswers(app) {
  setKeep(app, false, app.refs.finish.notices);
  app.refs.finish.afterDownload.hidden = true;
}

// Reads what an earlier visit saved. -> { state, notes, copy } when it is whole, { text } when there
// is something that cannot be used (the text is kept so the person can download it), {} when there is
// nothing. The saved data comes from outside, so all of it is checked first (parseSavedText).
function loadSavedState(engine, storage, key) {
  let text;
  try {
    text = storage.getItem(key);
  } catch {
    return {};
  }
  if (!text) return {};
  try {
    const result = engine.parseSavedText(text);
    if (result.ok) return { state: result.state, notes: result.notes, copy: result.copy };
  } catch (error) {
    if (typeof console !== 'undefined') console.error(error);
  }
  return { text };
}

// Puts unusable saved data aside: under another key, so a copy is kept, and out of the way of the
// next start. Returns the text.
function setAsideBrokenData(storage, key, text) {
  try {
    storage.setItem(key + BROKEN_SUFFIX, text);
  } catch {
    // The copy stays in the page only.
  }
  try {
    storage.removeItem(key);
  } catch {
    // Nothing more can be done.
  }
  return text;
}

function readBrokenData(storage, key) {
  try {
    return storage.getItem(key + BROKEN_SUFFIX);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Building the page

function renderApp(app) {
  const { doc, engine, state } = app;
  app.i18n = guardedI18n(engine.i18n(state.language));
  app.parts.clear();
  app.sections.clear();
  app.navItems.clear();
  app.refs = {};
  doc.documentElement.lang = state.language;
  doc.title = app.t('ui.form.title');
  if (!app.root) app.root = doc.getElementById('app');
  app.refs.top = buildNotices(app);
  app.refs.sync = buildSyncNotice(app);
  app.root.replaceChildren(
    app.h('a', { class: 'skip', href: '#main' }, app.t('ui.form.skip')),
    buildTop(app),
    app.refs.sync.element,
    app.refs.top.element,
    buildPrivacy(app),
    buildSetup(app),
    buildLayout(app),
  );
  applyModuleVisibility(app);
  refreshApp(app);
  if (!app.storage || !app.keep || app.conflict) showSaveStatus(app, { ok: false });
  showStartNotice(app);
}

// What to tell the person once, when the page starts with saved data.
function showStartNotice(app) {
  const { t } = app;
  const kind = app.recovered ? 'alert' : 'status';
  const sentences = [];
  if (app.recovered) sentences.push(t('ui.form.save.broken'));
  else if (app.restored) sentences.push(t('ui.form.save.restored'));
  if (app.notes) sentences.push(...changeNotes(app, app.notes));
  app.recovered = false;
  app.restored = false;
  app.notes = null;
  if (sentences.length > 0) showNotice(app.refs.top, kind, sentences.join(' '));
}

// What loading changed: values that were cleaned or cut, entries that were left out, and files that
// came without their content and must be attached again.
function changeNotes(app, notes) {
  const sentences = [];
  if (notes.cleaned > 0) sentences.push(app.t('ui.form.import.cleaned', { count: notes.cleaned }));
  if (notes.ignored > 0) sentences.push(app.t('ui.form.import.ignored', { count: notes.ignored }));
  if (notes.droppedItems > 0) sentences.push(app.t('ui.form.import.droppedItems', { count: notes.droppedItems, max: MAX_ROWS }));
  if (notes.droppedFiles > 0) sentences.push(app.t('ui.form.import.droppedFiles', { count: notes.droppedFiles, max: MAX_ATTACHMENTS }));
  if (notes.reattach.length > 0) sentences.push(app.t('ui.form.import.reattach', { names: namesText(app, notes.reattach) }));
  return sentences;
}

// The notice with two buttons that shows when the storage holds answers this window did not write.
function buildSyncNotice(app) {
  const { h, t } = app;
  const element = h(
    'div',
    { class: 'sync', role: 'alert', hidden: !app.conflict },
    h('p', {}, t('ui.form.sync.changed')),
    h(
      'div',
      { class: 'actions' },
      h('button', { type: 'button', class: 'btn', onclick: () => showOtherAnswers(app) }, t('ui.form.sync.show')),
      h('button', { type: 'button', class: 'btn secondary', onclick: () => keepThisWindow(app) }, t('ui.form.sync.keep')),
    ),
  );
  return { element };
}

function buildTop(app) {
  const { h, t } = app;
  app.refs.langButtons = {};
  const buttons = app.engine.schema.languages.map((lang) => {
    const button = h(
      'button',
      { type: 'button', class: 'seg', lang, 'aria-pressed': String(lang === app.state.language), onclick: () => setLanguage(app, lang) },
      t(LANGUAGE_KEYS[lang]),
    );
    app.refs.langButtons[lang] = button;
    return button;
  });
  return h(
    'header',
    { class: 'top' },
    h('div', { class: 'top-text' }, h('h1', {}, t('ui.form.title')), h('p', { class: 'lede' }, t('ui.form.lede'))),
    h('div', { class: 'lang', role: 'group', 'aria-label': t('ui.form.language') }, buttons),
  );
}

function setLanguage(app, lang) {
  if (lang === app.state.language) return;
  app.state.language = lang;
  renderApp(app);
  app.refs.langButtons[lang].focus();
  app.changed();
}

// The box that says whether the answers are kept in this browser. It is only there when the browser
// has storage; the text is plainer about who can read the answers when the page is a file.
function buildKeepBox(app) {
  app.refs.keepBox = null;
  if (!app.storage) return null;
  const box = app.h('input', { type: 'checkbox', checked: app.keep, onchange: () => setKeep(app, box.checked) });
  app.refs.keepBox = box;
  const label = isFilePage(app.win) ? 'ui.form.keep.labelFile' : 'ui.form.keep.label';
  return app.h('label', { class: 'option keep' }, box, app.h('span', {}, app.t(label)));
}

function buildPrivacy(app) {
  const { h, t } = app;
  const broken = app.broken
    ? h('button', { type: 'button', class: 'btn quiet', onclick: () => downloadBrokenData(app) }, t('ui.form.privacy.downloadBroken'))
    : null;
  return h(
    'section',
    { class: 'privacy', 'aria-labelledby': 'privacy-title' },
    h('h2', { id: 'privacy-title' }, t('ui.form.privacy.title')),
    h('p', {}, t('ui.form.privacy.text')),
    buildKeepBox(app),
    h('button', { type: 'button', class: 'btn quiet', onclick: () => clearSavedData(app) }, t('ui.form.privacy.clear')),
    broken,
  );
}

function labelled(app, textKey, control, extraClass) {
  return app.h('label', { class: extraClass ? `lbl ${extraClass}` : 'lbl' }, app.h('span', { class: 'lbl-text' }, app.t(textKey)), control);
}

// A line of text. `limit` is one of LIMITS; the field takes no more than that, and what is typed or
// pasted is cleaned before onValue gets it. `removed` is the quiet line for hidden characters.
function textField(app, props, limit, onValue, removed) {
  const field = app.h('input', { type: 'text', class: 'field', autocomplete: 'off', maxlength: limit.max, ...props });
  field.addEventListener('input', () => onValue(typedValue(field, limit, removed)));
  return field;
}

// A line under a group of fields that says when one of them is full.
function buildLimitNote(app, fields) {
  const note = app.h('p', { class: 'hint', hidden: true });
  note.refresh = () => {
    const full = fields().find(([value, limit]) => value.length >= limit.max);
    setText(note, full ? app.t('ui.form.hint.atLimit', { max: full[1].max }) : '');
    note.hidden = !full;
  };
  return note;
}

function buildDepthChoice(app, depth) {
  const { h, t } = app;
  const input = h('input', {
    type: 'radio',
    name: 'depth',
    value: depth,
    checked: app.state.depth === depth,
    onchange: () => {
      app.state.depth = depth;
      app.changed(true);
    },
  });
  return h('label', { class: 'option' }, input, h('span', {}, h('strong', {}, t(`depth.${depth}`)), h('span', { class: 'desc' }, t(`depth.${depth}.desc`))));
}

function buildImport(app) {
  const { h, t } = app;
  const input = h('input', { type: 'file', id: 'import-file', class: 'file', accept: '.json,application/json' });
  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    if (file) importFormData(app, file).then(() => (input.value = ''));
  });
  return h(
    'div',
    { class: 'import' },
    h('label', { class: 'lbl-text', for: 'import-file' }, t('ui.form.import.label')),
    input,
    h('p', { class: 'muted' }, t('ui.form.import.hint')),
  );
}

function buildSetup(app) {
  const { h, t, state } = app;
  const limitNote = buildLimitNote(app, () => [
    [state.respondent.name, LIMITS.person],
    [state.respondent.role, LIMITS.person],
    [state.recipient, LIMITS.recipient],
  ]);
  const removed = buildRemovedNote(app);
  const changed = () => {
    limitNote.refresh();
    app.changed();
  };
  const name = textField(app, { id: 'respondent-name', autocomplete: 'name', value: state.respondent.name }, LIMITS.person, (value) => {
    state.respondent.name = value;
    changed();
  }, removed);
  const role = textField(app, { id: 'respondent-role', autocomplete: 'organization-title', value: state.respondent.role }, LIMITS.person, (value) => {
    state.respondent.role = value;
    changed();
  }, removed);
  const recipient = textField(app, { id: 'recipient', value: state.recipient }, LIMITS.recipient, (value) => {
    state.recipient = value;
    changed();
  }, removed);
  limitNote.refresh();
  const depths = Object.keys(app.engine.schema.depths).map((depth) => buildDepthChoice(app, depth));
  return h(
    'section',
    { class: 'setup card', 'aria-labelledby': 'setup-title' },
    h('h2', { id: 'setup-title' }, t('ui.form.setup.title')),
    h(
      'div',
      { class: 'grid-2' },
      h('label', { class: 'lbl', for: 'respondent-name' }, h('span', { class: 'lbl-text' }, t('ui.form.setup.name')), name),
      h('label', { class: 'lbl', for: 'respondent-role' }, h('span', { class: 'lbl-text' }, t('ui.form.setup.role')), role),
    ),
    h('label', { class: 'lbl', for: 'recipient' }, h('span', { class: 'lbl-text' }, t('ui.form.setup.recipient')), recipient),
    limitNote,
    removed,
    h('fieldset', { class: 'depths' }, h('legend', { class: 'lbl-text' }, t('ui.form.setup.depth')), depths),
    buildImport(app),
  );
}

function buildLayout(app) {
  const modules = app.engine.schema.moduleOrder.map((id) => buildModuleSection(app, id));
  return app.h(
    'div',
    { class: 'layout' },
    buildSide(app),
    app.h('main', { id: 'main', tabindex: '-1' }, modules, buildFinish(app)),
  );
}

// ----- the side column: status and navigation

function buildSide(app) {
  return app.h('aside', { class: 'side' }, buildPanel(app), buildNav(app));
}

function buildPanel(app) {
  const { h, t } = app;
  const panel = {
    bar: h('div', { class: 'bar-fill' }),
    text: h('p', { class: 'progress-text' }),
    must: h('p', { class: 'must', 'aria-live': 'polite' }),
    deferred: h('p', { class: 'muted' }),
    list: h('ul', { class: 'plain-list' }),
    save: h('p', { class: 'muted save-state' }),
  };
  panel.track = h(
    'div',
    { class: 'bar', role: 'progressbar', 'aria-label': t('ui.form.progress.label'), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' },
    panel.bar,
  );
  panel.listBox = h('details', { class: 'must-list' }, h('summary', {}, t('ui.form.panel.show')), panel.list);
  app.refs.panel = panel;
  return h(
    'section',
    { class: 'panel card', 'aria-labelledby': 'panel-title' },
    h('h2', { id: 'panel-title' }, t('ui.form.panel.title')),
    panel.track,
    panel.text,
    panel.must,
    panel.deferred,
    panel.listBox,
    h('button', { type: 'button', class: 'btn', onclick: () => showModule(app, 'finish', { focus: true }) }, t('ui.form.panel.finish')),
    panel.save,
  );
}

function buildNav(app) {
  const { h, t } = app;
  const ids = [...app.engine.schema.moduleOrder, 'finish'];
  const items = ids.map((id) => {
    const count = h('span', { class: 'nav-count' });
    const title = id === 'finish' ? t('ui.form.nav.finish') : t(`module.${id}.title`);
    const button = h(
      'button',
      { type: 'button', class: 'nav-item', onclick: () => showModule(app, id, { focus: true }) },
      h('span', { class: 'nav-id' }, id === 'finish' ? '' : id),
      h('span', { class: 'nav-title' }, title),
      count,
    );
    app.navItems.set(id, { button, count });
    return h('li', {}, button);
  });
  const box = h('details', { class: 'nav-box' }, h('summary', {}, t('ui.form.nav.title')), h('ol', { class: 'nav-list' }, items));
  box.open = !isNarrowScreen(app.win);
  app.refs.navBox = box;
  return h('nav', { 'aria-label': t('ui.form.nav.title') }, box);
}

// ----- modules

function neighbours(app, id) {
  const ids = [...app.engine.schema.moduleOrder, 'finish'];
  const index = ids.indexOf(id);
  return { previous: ids[index - 1] || null, next: ids[index + 1] || null };
}

function buildModuleFooter(app, id) {
  const { h, t } = app;
  const { previous, next } = neighbours(app, id);
  const go = (target) => () => showModule(app, target, { focus: true });
  const nextLabel = next === 'finish' ? t('ui.form.nav.toFinish') : t('ui.form.nav.next');
  return h(
    'footer',
    { class: 'module-foot' },
    previous ? h('button', { type: 'button', class: 'btn secondary', onclick: go(previous) }, t('ui.form.nav.prev')) : null,
    next ? h('button', { type: 'button', class: 'btn', onclick: go(next) }, nextLabel) : null,
  );
}

function buildModuleSection(app, id) {
  const { h, t } = app;
  const module = app.engine.schema.modules.find((entry) => entry.id === id);
  const step = app.engine.schema.moduleOrder.indexOf(id) + 1;
  const heading = h('h2', { id: `module-${id}-title`, tabindex: '-1' }, t(`module.${id}.title`));
  const count = h('p', { class: 'module-count' });
  const questions = module.questions.map((question) => buildQuestion(app, app.engine.byId.get(question.id)));
  const section = h(
    'section',
    { class: 'module', id: `module-${id}`, 'aria-labelledby': `module-${id}-title`, hidden: true },
    h(
      'header',
      { class: 'module-head' },
      h('p', { class: 'eyebrow' }, t('ui.form.module.step', { n: step, total: app.engine.schema.moduleOrder.length })),
      heading,
      h('p', { class: 'intro' }, t(`module.${id}.intro`)),
      count,
    ),
    h('div', { class: 'questions' }, questions),
    buildModuleFooter(app, id),
  );
  app.sections.set(id, { section, heading, count });
  return section;
}

// ----- one question

function buildHelp(app, question) {
  const entries = [
    ['ui.form.q.help', `q.${question.id}.help`],
    ['ui.form.q.example', `q.${question.id}.example`],
  ].filter(([, key]) => app.i18n.has(key));
  return app.h(
    'div',
    { class: 'aids' },
    entries.map(([title, key]) => app.h('details', {}, app.h('summary', {}, app.t(title)), app.h('p', {}, app.t(key)))),
  );
}

function buildControl(app, question, part) {
  switch (question.type) {
    case 'text':
    case 'longtext':
      return textControl(app, question, part);
    case 'list':
    case 'urllist':
      return listControl(app, question, part);
    case 'choice':
    case 'multichoice':
      return choiceControl(app, question, part);
    case 'date':
      return dateControl(app, question, part);
    case 'files':
      return filesControl(app, question, part);
    default:
      return null;
  }
}

function buildQuestion(app, question) {
  const { h, t } = app;
  const id = fieldId(question.id);
  const grouped = GROUPED_TYPES.includes(question.type);
  const part = { level: h('span', { class: 'tag' }), status: h('span', { class: 'status' }) };
  const label = t(`q.${question.id}.label`);
  const title = grouped ? h('legend', { class: 'q-label' }, label) : h('label', { class: 'q-label', for: `${id}-input` }, label);
  part.hint = h('p', { class: 'hint', id: `${id}-hint`, hidden: true });
  part.removed = buildRemovedNote(app);
  part.controls = h('div', { class: 'controls' }, buildControl(app, question, part));
  buildUnknown(app, question, part);
  part.root = h(
    grouped ? 'fieldset' : 'div',
    { class: 'q', id: `q-${question.id}`, 'aria-describedby': grouped ? `${id}-ask ${id}-hint` : null },
    title,
    h('p', { class: 'q-meta' }, part.level, part.status),
    h('p', { class: 'ask', id: `${id}-ask` }, t(`q.${question.id}.ask`)),
    buildHelp(app, question),
    part.controls,
    part.hint,
    part.removed,
    part.unknown,
  );
  app.parts.set(question.id, part);
  return part.root;
}

function describedBy(question) {
  const id = fieldId(question.id);
  return `${id}-ask ${id}-hint`;
}

function noteControl(app, question, part) {
  const label = app.t('ui.form.note');
  const field = app.h('textarea', {
    class: 'field',
    rows: 2,
    maxlength: LIMITS.note.max,
    'aria-label': label,
    value: app.read(question.id).note || '',
    oninput: () => {
      app.edit(question.id).note = typedValue(field, LIMITS.note, part.removed);
      autosize(app, field);
      app.changed();
    },
  });
  const box = app.h('details', { class: 'note-box' }, app.h('summary', {}, label), field);
  box.open = Boolean(app.read(question.id).note);
  return box;
}

function textControl(app, question, part) {
  const multiline = question.type === 'longtext';
  const limit = multiline ? LIMITS.block : LIMITS.line;
  const field = app.h(multiline ? 'textarea' : 'input', {
    type: multiline ? null : 'text',
    id: `${fieldId(question.id)}-input`,
    class: 'field',
    rows: multiline ? 5 : null,
    maxlength: limit.max,
    autocomplete: 'off',
    'aria-describedby': describedBy(question),
    value: app.read(question.id).text || '',
    oninput: () => {
      app.edit(question.id).text = typedValue(field, limit, part.removed);
      autosize(app, field);
      app.changed();
    },
  });
  part.focus = () => field;
  return field;
}

function dateControl(app, question, part) {
  const field = app.h('input', {
    type: 'date',
    id: `${fieldId(question.id)}-input`,
    class: 'field field-date',
    'aria-describedby': describedBy(question),
    value: app.read(question.id).date || '',
    onchange: () => {
      app.edit(question.id).date = field.value;
      app.changed(true);
    },
  });
  part.focus = () => field;
  return app.h('div', {}, field, noteControl(app, question, part));
}

function choiceControl(app, question, part) {
  const multiple = question.type === 'multichoice';
  const selected = () => app.read(question.id).choice || [];
  const inputs = [];
  const clear = app.h('button', { type: 'button', class: 'btn quiet small', hidden: true }, app.t('ui.form.choice.clear'));
  const sync = () => {
    clear.hidden = multiple || selected().length === 0;
  };
  const pick = () => {
    app.edit(question.id).choice = inputs.filter((input) => input.checked).map((input) => input.value);
    sync();
    app.changed(true);
  };
  const options = question.choices.map((choiceId) => {
    const input = app.h('input', {
      type: multiple ? 'checkbox' : 'radio',
      name: `${fieldId(question.id)}-choice`,
      value: choiceId,
      checked: selected().includes(choiceId),
      onchange: pick,
    });
    inputs.push(input);
    return app.h('label', { class: 'option' }, input, app.h('span', {}, app.t(`choice.${question.id}.${choiceId}`)));
  });
  clear.addEventListener('click', () => {
    for (const input of inputs) input.checked = false;
    pick();
    inputs[0].focus();
  });
  part.focus = () => inputs[0];
  part.sync = sync;
  sync();
  return app.h('div', {}, app.h('div', { class: 'options' }, options), clear, noteControl(app, question, part));
}

// ----- lists: one row per item; a link list has a note beside each link

function listItems(app, question) {
  return app.read(question.id).items || [];
}

function listMinRows(question) {
  return Math.min(3, Math.max(1, (question.rules && question.rules.minItems) || 1));
}

function writeListItem(editor, index, field, value) {
  const record = editor.app.edit(editor.question.id);
  record.items = record.items || [];
  while (record.items.length <= index) record.items.push({ text: '', note: '' });
  record.items[index][field] = value;
  editor.app.changed();
}

// A list takes at most MAX_ROWS rows. At the limit the button is off and a line says why.
function syncListLimit(editor) {
  const full = editor.count >= MAX_ROWS;
  editor.add.disabled = full;
  editor.full.hidden = !full;
  setText(editor.full, full ? editor.app.t('ui.form.list.full', { max: MAX_ROWS }) : '');
}

function addListRow(editor) {
  if (editor.count >= MAX_ROWS) {
    syncListLimit(editor);
    return;
  }
  editor.count += 1;
  drawListRows(editor, editor.count - 1);
}

function removeListRow(editor, index) {
  const record = editor.app.state.answers[editor.question.id];
  if (record && record.items && index < record.items.length) record.items.splice(index, 1);
  editor.count = Math.max(1, editor.count - 1);
  drawListRows(editor, Math.min(index, editor.count - 1));
  editor.app.changed(true);
}

// Enter in the last row adds a row; in any other row it moves on to the next one.
function onListEnter(editor, index) {
  return (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (index + 1 < editor.count) editor.mains[index + 1].focus();
    else addListRow(editor);
  };
}

function buildListRow(editor, index) {
  const { app, question, withNote } = editor;
  const item = listItems(app, question)[index] || { text: '', note: '' };
  const label = app.t(`q.${question.id}.label`);
  const number = index + 1;
  const main = app.h('input', {
    type: 'text',
    class: 'field',
    autocomplete: 'off',
    maxlength: LIMITS.item.max,
    value: item.text,
    'aria-label': app.t(withNote ? 'ui.form.urllist.item' : 'ui.form.list.item', { label, n: number }),
    'aria-describedby': describedBy(question),
    oninput: () => writeListItem(editor, index, 'text', typedValue(main, LIMITS.item, editor.part.removed)),
    onkeydown: onListEnter(editor, index),
  });
  editor.mains[index] = main;
  const note = withNote
    ? app.h('input', {
        type: 'text',
        class: 'field',
        autocomplete: 'off',
        maxlength: LIMITS.item.max,
        value: item.note,
        'aria-label': app.t('ui.form.urllist.note', { label, n: number }),
        placeholder: app.t('ui.form.urllist.notePlaceholder'),
        oninput: () => writeListItem(editor, index, 'note', typedValue(note, LIMITS.item, editor.part.removed)),
        onkeydown: onListEnter(editor, index),
      })
    : null;
  const remove = app.h(
    'button',
    { type: 'button', class: 'btn quiet', 'aria-label': app.t('ui.form.list.removeN', { n: number }), onclick: () => removeListRow(editor, index) },
    app.t('ui.form.list.remove'),
  );
  return app.h('li', { class: withNote ? 'row row-note' : 'row' }, main, note, remove);
}

function drawListRows(editor, focusIndex) {
  editor.mains.length = 0;
  editor.rows.replaceChildren(...Array.from({ length: editor.count }, (unused, index) => buildListRow(editor, index)));
  if (editor.add) syncListLimit(editor);
  if (focusIndex !== undefined && editor.mains[focusIndex]) editor.mains[focusIndex].focus();
}

function listControl(app, question, part) {
  const editor = {
    app,
    question,
    part,
    withNote: question.type === 'urllist',
    rows: app.h('ol', { class: 'rows' }),
    mains: [],
    count: Math.max(listItems(app, question).length, listMinRows(question)),
    add: null,
    full: app.h('p', { class: 'hint', role: 'status', hidden: true }),
  };
  editor.add = app.h(
    'button',
    { type: 'button', class: 'btn secondary', onclick: () => addListRow(editor) },
    app.t(editor.withNote ? 'ui.form.urllist.add' : 'ui.form.list.add'),
  );
  drawListRows(editor);
  part.focus = () => editor.mains[0];
  return app.h('div', { class: 'list' }, editor.rows, editor.add, editor.full);
}

// ----- attached files

// What the answer files of the pack take at the moment (they share the 500 MB of a pack with the files).
function answerTextBytes(app) {
  const texts = app.analysis ? [...app.analysis.files.map((file) => file.text), app.analysis.assetsText] : [];
  return texts.reduce((sum, content) => sum + encodeUtf8(content).length, 0);
}

// Reads the chosen files into memory, one at a time. A file that cannot be attached is not read at
// all, and every refusal is said out loud, next to the file field.
async function attachFiles(app, question, input, redraw, notices) {
  const problems = [];
  let added = 0;
  for (const file of Array.from(input.files || [])) {
    const refusal = app.engine.attachmentProblem(app.state, file, answerTextBytes(app));
    if (refusal) {
      problems.push(app.t(refusal.key, refusal.params));
      continue;
    }
    try {
      const buffer = await file.arrayBuffer();
      app.engine.addAsset(app.state, question.id, { name: file.name, data: new Uint8Array(buffer) });
      added += 1;
    } catch {
      problems.push(app.t('ui.form.files.readError', { name: cleanLine(file.name, MAX_NAME_BYTES) }));
    }
  }
  input.value = '';
  redraw();
  app.changed(true);
  // Files are never kept in the browser; say so each time one is attached, quietly.
  setText(notices.status, added > 0 ? app.t('ui.form.files.notSaved') : '');
  setText(notices.alert, problems.join(' '));
}

function assetField(app, asset, key, labelKey, placeholderKey, onChange, removed) {
  const props = { value: asset[key], placeholder: placeholderKey ? app.t(placeholderKey) : null };
  const field = textField(app, props, LIMITS.asset, (value) => {
    asset[key] = value;
    onChange();
    app.changed();
  }, removed);
  const label = labelled(app, labelKey, field);
  label.inputField = field;
  return label;
}

// redraw(index) draws the list again and puts the focus on the card that is now at `index`, or on
// the file field when there is none (a removed file would otherwise take the focus with it).
function buildAssetCard(app, asset, redraw) {
  const { h, t } = app;
  const limitNote = buildLimitNote(app, () => ['what', 'owner', 'rights', 'restrictions'].map((key) => [asset[key], LIMITS.asset]));
  const removed = buildRemovedNote(app);
  const field = (key, labelKey, placeholderKey) => assetField(app, asset, key, labelKey, placeholderKey, limitNote.refresh, removed);
  const remove = h(
    'button',
    {
      type: 'button',
      class: 'btn quiet',
      'aria-label': t('ui.form.files.removeN', { name: asset.name }),
      onclick: () => {
        const index = app.engine.assetsOf(app.state, asset.qid).findIndex((entry) => entry.id === asset.id);
        app.engine.removeAsset(app.state, asset.id);
        redraw(index);
        app.changed(true);
      },
    },
    t('ui.form.files.remove'),
  );
  limitNote.refresh();
  const what = field('what', 'ui.form.files.what', 'ui.form.files.whatPlaceholder');
  const card = h(
    'li',
    { class: 'asset' },
    h(
      'div',
      { class: 'asset-head' },
      h('strong', { class: 'asset-name' }, asset.name),
      h('span', { class: 'muted' }, formatBytes(asset.size, app.state.language)),
      remove,
    ),
    asset.renamedFrom ? h('p', { class: 'hint' }, t('ui.form.files.renamed', { from: asset.renamedFrom, name: asset.name })) : null,
    asset.data ? null : h('p', { class: 'hint warn' }, t('ui.form.files.noData')),
    h(
      'div',
      { class: 'grid-2' },
      what,
      field('owner', 'ui.form.files.owner', null),
      field('rights', 'ui.form.files.rights', 'ui.form.files.rightsPlaceholder'),
      field('restrictions', 'ui.form.files.restrictions', 'ui.form.files.restrictionsPlaceholder'),
    ),
    limitNote,
    removed,
  );
  card.focusTarget = what.inputField;
  return card;
}

function filesControl(app, question, part) {
  const list = app.h('ul', { class: 'assets' });
  const input = app.h('input', {
    type: 'file',
    id: `${fieldId(question.id)}-input`,
    class: 'file',
    multiple: true,
    'aria-describedby': describedBy(question),
  });
  const draw = (focusIndex) => {
    const assets = app.engine.assetsOf(app.state, question.id);
    const cards = assets.map((asset) => buildAssetCard(app, asset, draw));
    list.replaceChildren(...cards);
    list.hidden = assets.length === 0;
    if (focusIndex !== undefined) (cards[Math.min(focusIndex, cards.length - 1)]?.focusTarget ?? input).focus();
  };
  part.notices = buildNotices(app);
  input.addEventListener('change', () => attachFiles(app, question, input, draw, part.notices));
  draw();
  part.focus = () => input;
  return app.h('div', { class: 'files' }, list, labelled(app, 'ui.form.files.attach', input), part.notices.element);
}

// ----- "I don't know"

function ownerChoice(app, question, ownerId) {
  const input = app.h('input', {
    type: 'radio',
    name: `${fieldId(question.id)}-owner`,
    value: ownerId,
    checked: (app.read(question.id).owner || 'client') === ownerId,
    onchange: () => {
      app.edit(question.id).owner = ownerId;
      app.changed(true);
    },
  });
  return app.h('label', { class: 'option' }, input, app.h('span', {}, app.t(OWNER_KEYS[ownerId])));
}

function buildUnknown(app, question, part) {
  const { h, t } = app;
  const id = fieldId(question.id);
  const record = () => app.read(question.id);
  part.toggle = h('input', {
    type: 'checkbox',
    checked: Boolean(record().unknown),
    onchange: () => {
      app.edit(question.id).unknown = part.toggle.checked;
      app.changed(true);
    },
  });
  part.ownerName = textField(
    app,
    { 'aria-label': t('ui.form.unknown.otherName'), placeholder: t('ui.form.unknown.otherName'), value: record().ownerName || '', hidden: true },
    LIMITS.owner,
    (value) => {
      app.edit(question.id).ownerName = value;
      app.changed();
    },
    part.removed,
  );
  part.ownerHint = h('p', { class: 'hint', hidden: true });
  const due = h('input', {
    type: 'date',
    id: `${id}-due`,
    class: 'field field-date',
    value: record().due || '',
    onchange: () => {
      app.edit(question.id).due = due.value;
      app.changed(true);
    },
  });
  const note = h('textarea', {
    class: 'field',
    rows: 2,
    maxlength: LIMITS.note.max,
    value: record().tbdNote || '',
    oninput: () => {
      app.edit(question.id).tbdNote = typedValue(note, LIMITS.note, part.removed);
      autosize(app, note);
      app.changed();
    },
  });
  part.tbd = h(
    'div',
    { class: 'tbd', hidden: true },
    h('fieldset', { class: 'owner' }, h('legend', { class: 'lbl-text' }, t('ui.form.unknown.who')), Object.keys(OWNER_KEYS).map((ownerId) => ownerChoice(app, question, ownerId)), part.ownerName, part.ownerHint),
    h('label', { class: 'lbl', for: `${id}-due` }, h('span', { class: 'lbl-text' }, t('ui.form.unknown.due')), due),
    labelled(app, 'ui.form.unknown.note', note),
  );
  part.unknown = h('div', { class: 'unknown' }, h('label', { class: 'option' }, part.toggle, h('span', {}, t('ui.form.unknown.toggle'))), part.tbd);
}

// ----- the last step

function buildFinish(app) {
  const { h, t } = app;
  const finish = {
    summary: h('p', { class: 'finish-summary' }),
    leftOut: h('p', { class: 'notice', hidden: true }),
    openHeading: h('h3', {}, t('level.gate1')),
    openList: h('ul', { class: 'plain-list' }),
    openEmpty: h('p', { class: 'muted' }, t('ui.form.finish.noneOpen')),
    deferredHeading: h('h3', {}, t('ui.form.finish.deferred')),
    deferredList: h('ul', { class: 'plain-list' }),
    deferredEmpty: h('p', { class: 'muted' }, t('ui.form.finish.noneDeferred')),
    checksHeading: h('h3', {}, t('ui.form.finish.checks')),
    checksList: h('ul', { class: 'plain-list' }),
    checksEmpty: h('p', { class: 'muted' }, t('ui.form.finish.noChecks')),
    nameHint: h('p', { class: 'hint' }, t('ui.form.finish.needName')),
    sendHint: h('p', { class: 'muted' }),
    download: h('button', { type: 'button', class: 'btn', onclick: () => downloadPack(app) }, t('ui.form.finish.download')),
    notices: buildNotices(app),
  };
  // After a download: remove the saved answers from this browser (shown when there are some).
  finish.afterDownload = h(
    'div',
    { class: 'after-download', hidden: true },
    h('button', { type: 'button', class: 'btn secondary', onclick: () => removeSavedAnswers(app) }, t('ui.form.finish.removeSaved')),
    h('p', { class: 'muted' }, t('ui.form.finish.removeSavedHint')),
  );
  app.refs.finish = finish;
  const heading = h('h2', { id: 'module-finish-title', tabindex: '-1' }, t('ui.form.finish.title'));
  const count = h('p', { class: 'module-count' });
  const section = h(
    'section',
    { class: 'module', id: 'module-finish', 'aria-labelledby': 'module-finish-title', hidden: true },
    h('header', { class: 'module-head' }, heading, h('p', { class: 'intro' }, t('ui.form.finish.intro')), finish.summary, finish.leftOut),
    h(
      'div',
      { class: 'finish' },
      h('section', { class: 'finish-block' }, finish.openHeading, finish.openList, finish.openEmpty),
      h('section', { class: 'finish-block' }, finish.deferredHeading, finish.deferredList, finish.deferredEmpty),
      h('section', { class: 'finish-block' }, finish.checksHeading, finish.checksList, finish.checksEmpty),
      h(
        'section',
        { class: 'finish-block actions' },
        h('h3', {}, t('ui.form.finish.get')),
        finish.nameHint,
        finish.download,
        finish.sendHint,
        h('button', { type: 'button', class: 'btn secondary', onclick: () => exportFormData(app) }, t('ui.form.finish.export')),
        h('p', { class: 'muted' }, t('ui.form.finish.exportHint')),
        finish.notices.element,
        finish.afterDownload,
      ),
    ),
    buildModuleFooter(app, 'finish'),
  );
  app.sections.set('finish', { section, heading, count });
  return section;
}

function ownerText(app, owner) {
  if (owner === '') return app.t('ui.form.finish.noOwner');
  return owner === 'client' ? app.t('ui.form.finish.ownerClient') : owner;
}

function linkButton(app, text, onclick) {
  return app.h('li', {}, app.h('button', { type: 'button', class: 'link', onclick }, text));
}

function refreshFinish(app, report, progress) {
  const { t, state, engine } = app;
  const finish = app.refs.finish;
  const total = progress.total;
  const missing = Math.max(0, total.total - total.done - total.tbd);
  setText(finish.summary, t('ui.form.finish.summary', { done: total.done, tbd: total.tbd, missing }));
  const open = report.gate1.blocking;
  finish.openList.replaceChildren(...open.map((id) => linkButton(app, t(`q.${id}.label`), () => goToQuestion(app, id))));
  finish.openEmpty.hidden = open.length > 0;
  const deferred = engine.ordered.filter((question) => engine.isVisible(report, question.id, state.depth) && report.questions[question.id].status === 'tbd');
  finish.deferredList.replaceChildren(
    ...deferred.map((question) => {
      const entry = report.questions[question.id];
      const details = t('ui.form.finish.deferredItem', { owner: ownerText(app, entry.owner), due: entry.due || t('ui.form.finish.noDue') });
      const line = t('ui.form.finish.deferredLine', { label: t(`q.${question.id}.label`), details });
      return linkButton(app, line, () => goToQuestion(app, question.id));
    }),
  );
  finish.deferredEmpty.hidden = deferred.length > 0;
  const left = app.analysis.leftOut;
  setText(finish.leftOut, left.answers + left.files === 0 ? '' : t('ui.form.finish.leftOut', left));
  finish.leftOut.hidden = left.answers + left.files === 0;
  const flags = report.flags.filter((flag) => flag.severity === 'block' || flag.severity === 'warn').slice(0, MAX_LISTED_ITEMS);
  const dropped = app.analysis.problems.map((problem) => {
    const label = t(`q.${problem.params.id}.label`);
    return app.h('li', {}, t('ui.form.finish.problemLine', { label, reason: problemText(app, problem) }));
  });
  finish.checksList.replaceChildren(...dropped, ...flags.map((flag) => app.h('li', {}, describeFlag(flag, app.i18n))));
  finish.checksEmpty.hidden = flags.length + dropped.length > 0;
  finish.nameHint.hidden = oneLine(state.respondent.name) !== '';
  const recipient = oneLine(state.recipient);
  setText(finish.sendHint, recipient === '' ? t('ui.form.finish.sendHint') : t('ui.form.finish.sendTo', { recipient }));
}

// ---------------------------------------------------------------------------------------------
// Refreshing what depends on the answers

function levelLabel(app, level) {
  return app.t(LEVEL_KEYS[level]);
}

// The reason an answer cannot go into the pack, in plain words.
const PROBLEM_KEYS = { 'ui.answer.err.controlChars': 'ui.form.problem.controlChars', 'ui.answer.err.tooLong': 'ui.form.problem.tooLong' };

function problemText(app, problem) {
  if (problem.key.startsWith('ui.form.')) return app.t(problem.key, problem.params);
  return app.t(PROBLEM_KEYS[problem.key] || 'ui.form.problem.other');
}

function ownerProblem(app, record) {
  if (!record.unknown) return '';
  if (record.owner === 'other' && oneLine(record.ownerName) === '') return app.t('ui.form.unknown.needName');
  if (record.owner === 'me' && oneLine(app.state.respondent.name) === '') return app.t('ui.form.unknown.needMyName');
  return '';
}

function refreshQuestions(app, report) {
  const { engine, state } = app;
  for (const question of engine.ordered) {
    const part = app.parts.get(question.id);
    const visible = engine.isVisible(report, question.id, state.depth);
    part.root.hidden = !visible;
    if (!visible) continue;
    const entry = report.questions[question.id];
    const record = app.read(question.id);
    setText(part.level, levelLabel(app, entry.level));
    setText(part.status, entry.status === 'missing' ? '' : app.t(`status.${entry.status}`));
    part.root.setAttribute('data-status', entry.status);
    part.controls.hidden = Boolean(record.unknown);
    part.tbd.hidden = !record.unknown;
    part.ownerName.hidden = record.owner !== 'other';
    const problem = ownerProblem(app, record);
    setText(part.ownerHint, problem);
    part.ownerHint.hidden = problem === '';
    const hints = engine.hints(question, state, report).map((hint) => app.t(hint.key, hint.params));
    const dropped = app.analysis.problems.filter((problem) => problem.params.id === question.id);
    const lines = [...dropped.map((problem) => app.t('ui.form.hint.dropped', { reason: problemText(app, problem) })), ...hints];
    setText(part.hint, lines.join(' '));
    part.hint.hidden = lines.length === 0;
    part.hint.className = dropped.length > 0 ? 'hint warn' : 'hint';
    if (part.sync) part.sync();
  }
}

function refreshNav(app, progress) {
  const { t, state } = app;
  for (const [id, item] of app.navItems) {
    if (id === 'finish') continue;
    const { done, total } = progress.perModule[id];
    setText(item.count, t('ui.form.nav.count', { done, total }));
    const section = app.sections.get(id);
    setText(section.count, t('ui.form.module.count', { done, total }));
  }
  for (const [id, item] of app.navItems) {
    if (id === state.currentModule) item.button.setAttribute('aria-current', 'step');
    else item.button.removeAttribute('aria-current');
  }
}

function refreshPanel(app, report, progress) {
  const { t, state } = app;
  const panel = app.refs.panel;
  const total = progress.total;
  const percent = total.total === 0 ? 0 : Math.round((total.done / total.total) * 100);
  panel.track.setAttribute('aria-valuenow', String(percent));
  panel.bar.style.width = `${percent}%`;
  setText(panel.text, t('ui.form.progress.text', { done: total.done, total: total.total }));
  const open = report.gate1.blocking;
  const label = t('level.gate1');
  setText(panel.must, open.length === 0 ? t('ui.form.panel.allDone', { label }) : t('ui.form.panel.open', { label, count: open.length }));
  const deferred = open.filter((id) => report.questions[id].status === 'tbd').length;
  setText(panel.deferred, deferred === 0 ? '' : t('ui.form.panel.deferred', { count: deferred }));
  panel.deferred.hidden = deferred === 0;
  panel.list.replaceChildren(...open.map((id) => linkButton(app, t(`q.${id}.label`), () => goToQuestion(app, id))));
  panel.listBox.hidden = open.length === 0;
  if (state.currentModule === 'finish') refreshFinish(app, report, progress);
}

// Brings the page in line with the answers. If that fails, the page stays as it was and the person
// is told, with a way out: the buttons for saving the form data and for clearing it are still there.
function refreshApp(app) {
  const { engine, state } = app;
  try {
    app.analysis = engine.analyze(state);
    const report = app.analysis.report;
    const progress = engine.progress(report, state.depth);
    refreshQuestions(app, report);
    refreshNav(app, progress);
    refreshPanel(app, report, progress);
  } catch (error) {
    if (typeof console !== 'undefined') console.error(error);
    if (app.refs.top) showNotice(app.refs.top, 'alert', app.t('ui.form.err.refresh'));
  }
}

// ---------------------------------------------------------------------------------------------
// Moving around

function applyModuleVisibility(app) {
  for (const [id, entry] of app.sections) entry.section.hidden = id !== app.state.currentModule;
}

function showModule(app, id, options = {}) {
  app.state.currentModule = id;
  applyModuleVisibility(app);
  refreshApp(app);
  const entry = app.sections.get(id);
  if (options.focus && entry) {
    if (isNarrowScreen(app.win)) app.refs.navBox.open = false;
    entry.heading.focus();
    if (typeof entry.heading.scrollIntoView === 'function') entry.heading.scrollIntoView({ block: 'start' });
  }
  app.changed();
}

function goToQuestion(app, id) {
  const question = app.engine.byId.get(id);
  showModule(app, question.module);
  const part = app.parts.get(id);
  const target = part.tbd.hidden ? part.focus() : part.toggle;
  if (target) target.focus();
  if (typeof part.root.scrollIntoView === 'function') part.root.scrollIntoView({ block: 'center' });
}

// ---------------------------------------------------------------------------------------------
// Download, export, import, clear

function triggerDownload(app, name, blob) {
  const url = app.win.URL.createObjectURL(blob);
  const link = app.h('a', { href: url, download: name });
  app.doc.body.appendChild(link);
  link.click();
  link.remove();
  app.win.setTimeout(() => app.win.URL.revokeObjectURL(url), 10000);
}

// The pack is handed over in pieces (pack.parts) and the browser puts them together, so a big pack
// is never in memory as one array next to the files it was made from.
// A turn of the page: other tasks (typing, clicks) run before the work goes on. A message channel
// does that without the delay of a timer, and without the slowing down of timers in a tab that is
// not shown. Without one, a timer of 0 does.
function nextTurn(win) {
  return new Promise((resolve) => {
    if (typeof win.MessageChannel === 'function') {
      const channel = new win.MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        resolve();
      };
      channel.port2.postMessage(0);
    } else {
      win.setTimeout(resolve, 0);
    }
  });
}

// The browser draws a frame, so what the page has just written (the message "building") is on the
// screen before a long piece of work starts. A tab that is not shown draws no frames, so a timer
// answers then.
function nextFrame(win) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    if (typeof win.requestAnimationFrame === 'function') win.requestAnimationFrame(() => win.setTimeout(finish, 0));
    win.setTimeout(finish, 100);
  });
}

async function downloadPack(app) {
  const button = app.refs.finish.download;
  const notices = app.refs.finish.notices;
  button.disabled = true;
  app.refs.finish.afterDownload.hidden = true;
  showNotice(notices, 'status', app.t('ui.form.finish.building'));
  try {
    await nextFrame(app.win);
    const pack = await app.engine.buildPack(app.state, { now: new Date(), yieldToPage: app.yieldToPage });
    triggerDownload(app, pack.name, new app.win.Blob(pack.parts, { type: 'application/zip' }));
    const message = app.t('ui.form.finish.done', { name: pack.name, size: formatBytes(pack.size, app.state.language) });
    showNotice(notices, 'status', pack.large ? `${message} ${app.t('ui.form.files.big')}` : message);
    app.refs.finish.afterDownload.hidden = !(app.storage && (app.keep || readStoredCopy(app)?.exists));
  } catch (error) {
    showNotice(notices, 'alert', errorText(app, error, 'ui.form.err.build'));
  } finally {
    button.disabled = false;
  }
}

// The form data as a file, with the attached files when they fit (see exportPlan); when they do not,
// the file lists them and the person is told which ones to attach again after loading it. The text
// is made in pieces.
function exportFormData(app) {
  const notices = app.refs.finish.notices;
  try {
    const now = new Date();
    const plan = app.engine.exportPlan(app.state, isoDateTime(now));
    const blob = new app.win.Blob(plan.parts, { type: 'application/json' });
    triggerDownload(app, `everything-mapped-form-${localDate(now)}.json`, blob);
    let message = app.t('ui.form.finish.exported');
    if (plan.reattach.length > 0) {
      message = app.t(plan.withFiles ? 'ui.form.finish.exportedMissing' : 'ui.form.finish.exportedNoFiles', { names: namesText(app, plan.reattach) });
    }
    showNotice(notices, 'status', message);
  } catch (error) {
    if (typeof console !== 'undefined') console.error(error);
    showNotice(notices, 'alert', app.t('ui.form.err.exportTooLarge'));
  }
}

function downloadBrokenData(app) {
  const blob = new app.win.Blob([app.broken], { type: 'text/plain' });
  triggerDownload(app, `everything-mapped-form-unreadable-${localDate(new Date())}.txt`, blob);
}

// Replaces the state and the page. If the page cannot be built from the new state, the old state and
// page are put back and the error is passed on.
function replaceState(app, state) {
  const previous = app.state;
  cancelWork(app);
  app.state = state;
  try {
    renderApp(app);
  } catch (error) {
    app.state = previous;
    renderApp(app);
    throw error;
  }
}

// Loads form data from a file. All of it is read and checked first (parseSavedText); only when it is
// whole is anything changed. Otherwise nothing changes and the person is told why.
async function importFormData(app, file) {
  if (file.size > IMPORT_MAX_BYTES) {
    app.fail(app.t('ui.form.err.importTooLarge'));
    return;
  }
  let text;
  try {
    text = await file.text();
  } catch {
    app.fail(app.t('ui.form.err.importRead'));
    return;
  }
  const result = app.engine.parseSavedText(text);
  if (!result.ok) {
    app.fail(app.t(result.key));
    return;
  }
  const mayReplace = !app.engine.hasAnswers(app.state) || typeof app.win.confirm !== 'function' || app.win.confirm(app.t('ui.form.import.confirm'));
  if (!mayReplace) return;
  try {
    replaceState(app, result.state);
  } catch (error) {
    app.fail(errorText(app, error, 'ui.form.err.importInvalid'));
    return;
  }
  app.changed();
  app.notify([app.t('ui.form.import.done'), ...changeNotes(app, result.notes)].join(' '));
}

function clearSavedData(app) {
  const confirmed = typeof app.win.confirm !== 'function' || app.win.confirm(app.t('ui.form.privacy.confirm'));
  if (!confirmed) return;
  cancelWork(app);
  if (app.storage) removeStored(app.storage, app.key);
  app.broken = null;
  app.revision = app.storage && app.keep ? 0 : -1;
  app.writeId = '';
  app.conflict = false;
  app.state = app.engine.newState({ language: app.state.language });
  renderApp(app);
  app.notify(app.t('ui.form.privacy.cleared'));
}

// ---------------------------------------------------------------------------------------------
// Start

// What happens when the page is left or put away: a save that is waiting is done now (the last
// half second of typing would be lost otherwise). It writes nothing when the answers are not kept
// here or the storage holds another copy (persistState sees to both). And when another window saves
// or removes the answers, this window looks at once and shows the notice.
function watchPage(app) {
  const saveNow = () => flushWork(app, ['save']);
  app.win.addEventListener('pagehide', saveNow);
  app.doc.addEventListener('visibilitychange', () => {
    if (app.doc.visibilityState === 'hidden') saveNow();
  });
  app.win.addEventListener('storage', (event) => {
    if (event && event.key !== null && event.key !== undefined && event.key !== app.key) return;
    checkStorage(app);
  });
}

// doc and win are the page's document and window (or stand-ins in a test). data is optional; it
// is read from the page's JSON blocks when left out.
function startForm(doc, win, data) {
  const engine = createEngine(data || readEmbeddedData(doc));
  const storage = safeStorage(win, engine.storageKey);
  const keep = Boolean(storage) && readKeepSetting(storage, engine.storageKey, win);
  const loaded = keep ? loadSavedState(engine, storage, engine.storageKey) : {};
  const fresh = () => engine.newState({ language: languageFromBrowser(win) });
  const base = { doc, win, engine, storage, keep };
  const broken = loaded.text ? setAsideBrokenData(storage, engine.storageKey, loaded.text) : keep ? readBrokenData(storage, engine.storageKey) : null;
  let app = createApp({ ...base, state: loaded.state || fresh(), restored: Boolean(loaded.state), notes: loaded.notes, copy: loaded.copy, recovered: Boolean(loaded.text), broken });
  try {
    app.render();
  } catch (error) {
    // Saved data that passed the checks but still cannot be shown: put it aside and start empty.
    if (!loaded.state || !storage) throw error;
    const text = setAsideBrokenData(storage, engine.storageKey, JSON.stringify(engine.serializeState(loaded.state, { files: false })));
    app = createApp({ ...base, state: fresh(), recovered: true, broken: text });
    app.render();
  }
  watchPage(app);
  return app;
}

// When the form cannot start (an old browser, for instance), the hidden message that the build put
// into the page is shown instead of an empty page.
function showStartFailure(doc, error) {
  const message = doc.getElementById('emfc-failed');
  if (message) message.hidden = false;
  if (typeof console !== 'undefined') console.error(error);
}

const EMFC_HOST = typeof window !== 'undefined' ? window : globalThis;
EMFC_HOST.__emfc = { createEngine, startForm, readEmbeddedData, library: EMFC_LIBRARY };
if (typeof document !== 'undefined' && document && typeof document.getElementById === 'function' && document.getElementById('app')) {
  try {
    EMFC_HOST.__emfc.app = startForm(document, EMFC_HOST);
  } catch (error) {
    showStartFailure(document, error);
  }
}
