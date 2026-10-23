// A small stand-in for the browser, just enough for the form's script: elements with children,
// attributes, properties and event listeners, a window with timers, storage, Blob and URL.
// It lets the tests run the real page code without a real browser.

class FakeText {
  constructor(text) {
    this.nodeType = 3;
    this.data = String(text);
    this.parentNode = null;
  }

  get textContent() {
    return this.data;
  }
}

export class FakeElement {
  constructor(document, tag) {
    this.ownerDocument = document;
    this.nodeType = 1;
    this.localName = tag;
    this.tagName = tag.toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.style = {};
    this.className = '';
    this.hidden = false;
    this.disabled = false;
    this.checkedState = false;
    this.multiple = false;
    this.open = false;
    this.value = '';
    this.files = [];
  }

  get id() {
    return this.attributes.get('id') ?? '';
  }

  get checked() {
    return this.checkedState;
  }

  // Like a browser: choosing a radio button clears the others in its group.
  set checked(value) {
    this.checkedState = Boolean(value);
    const name = this.getAttribute('name');
    if (!this.checkedState || this.getAttribute('type') !== 'radio' || !name) return;
    const others = findAll(this.ownerDocument.body, (element) => element !== this && element.getAttribute('type') === 'radio' && element.getAttribute('name') === name);
    for (const other of others) other.checkedState = false;
  }

  get children() {
    return this.childNodes.filter((node) => node.nodeType === 1);
  }

  get textContent() {
    return this.childNodes.map((node) => node.textContent).join('');
  }

  set textContent(value) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    if (String(value) !== '') this.appendChild(new FakeText(value));
  }

  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  removeChild(node) {
    this.childNodes = this.childNodes.filter((child) => child !== node);
    node.parentNode = null;
    return node;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  replaceChildren(...nodes) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    for (const node of nodes) this.appendChild(typeof node === 'string' ? new FakeText(node) : node);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  // Calls the listeners the way a browser would and returns the event.
  fire(type, extra = {}) {
    const event = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return event;
  }

  click() {
    if (this.localName === 'a' && this.attributes.has('download')) {
      this.ownerDocument.downloads.push({ name: this.getAttribute('download'), href: this.getAttribute('href') });
    }
    return this.fire('click');
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  scrollIntoView() {
    this.ownerDocument.scrolledTo = this;
  }
}

export class FakeDocument {
  constructor() {
    this.activeElement = null;
    this.scrolledTo = null;
    this.downloads = [];
    this.title = '';
    this.visibilityState = 'visible';
    this.listeners = new Map();
    this.documentElement = { lang: '' };
    this.body = this.createElement('body');
  }

  addEventListener(type, listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  // Calls the document's listeners (like "visibilitychange"). Changes the visibility state when given.
  fire(type, extra = {}) {
    if (type === 'visibilitychange' && extra.visibilityState) this.visibilityState = extra.visibilityState;
    for (const listener of this.listeners.get(type) ?? []) listener({ type, ...extra });
  }

  createElement(tag) {
    return new FakeElement(this, tag);
  }

  createTextNode(text) {
    return new FakeText(text);
  }

  getElementById(id) {
    return findAll(this.body, (element) => element.id === id)[0] ?? null;
  }

  getElementsByClassName(name) {
    return findAll(this.body, (element) => element.className.split(/\s+/).includes(name));
  }
}

// Asserts that two elements are the same one. assert.equal on elements would, when it fails, write
// out both of them with their whole page around them (the owner document, every listener), which
// can take gigabytes; this says which two elements were meant, in a few words.
export function same(actual, expected, message = 'not the same element') {
  if (actual === expected) return;
  const name = (element) => (element === null || element === undefined ? String(element) : `${element.localName ?? typeof element}${element.id ? `#${element.id}` : ''}${element.className ? `.${element.className}` : ''}`);
  const error = new Error(`${message}: got ${name(actual)}, wanted ${name(expected)}`);
  error.name = 'AssertionError';
  throw error;
}

// Every element below `root` (and `root` itself) that the test accepts.
export function findAll(root, accept) {
  const found = [];
  const visit = (node) => {
    if (node.nodeType !== 1) return;
    if (accept(node)) found.push(node);
    for (const child of node.childNodes) visit(child);
  };
  visit(root);
  return found;
}

export function findOne(root, accept) {
  const found = findAll(root, accept);
  if (found.length !== 1) throw new Error(`Expected one element, found ${found.length}`);
  return found[0];
}

export function byTag(root, tag) {
  return findAll(root, (element) => element.localName === tag);
}

export function byClass(root, name) {
  return findAll(root, (element) => element.className.split(/\s+/).includes(name));
}

// All text below an element. With visibleOnly, elements with `hidden` set are left out.
export function textOf(root, visibleOnly = false) {
  const parts = [];
  const visit = (node) => {
    if (node.nodeType === 3) parts.push(node.data);
    if (node.nodeType !== 1 || (visibleOnly && node.hidden)) return;
    for (const child of node.childNodes) visit(child);
  };
  visit(root);
  return parts.join('');
}

// Every string a person can read or hear from the elements below root: text, aria-label,
// placeholder and title attributes.
export function readableStrings(root) {
  const strings = [];
  const visit = (node) => {
    if (node.nodeType === 3) strings.push(node.data);
    if (node.nodeType !== 1) return;
    for (const name of ['aria-label', 'placeholder', 'title', 'alt']) {
      if (node.attributes.has(name)) strings.push(node.attributes.get(name));
    }
    for (const child of node.childNodes) visit(child);
  };
  visit(root);
  return strings;
}

// A window with a clock that only moves when the test says so, storage, Blob and URL.
export function createFakeWindow(options = {}) {
  const timers = new Map();
  const blobs = new Map();
  const listeners = new Map();
  let nextId = 1;
  const win = {
    reloads: 0,
    location: options.noLocation ? undefined : { protocol: options.protocol ?? 'https:', reload: () => { win.reloads += 1; } },
    addEventListener: (type, listener) => listeners.set(type, [...(listeners.get(type) ?? []), listener]),
    removeEventListener: (type, listener) => listeners.set(type, (listeners.get(type) ?? []).filter((entry) => entry !== listener)),
    navigator: { language: options.language ?? 'en-GB' },
    localStorage: options.storage === undefined ? createMemoryStorage() : options.storage,
    matchMedia: () => ({ matches: Boolean(options.narrow) }),
    confirm: options.confirm ?? (() => true),
    // A timer with a delay of 0 runs by itself on the next turn (the page uses it to give the browser
    // a turn); the others wait until the test runs them.
    setTimeout: (callback, delay) => {
      if (delay === 0) {
        setTimeout(callback, 0);
        return 0;
      }
      const id = nextId;
      nextId += 1;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    requestAnimationFrame: (callback) => setTimeout(() => callback(0), 0),
    Blob: class FakeBlob {
      constructor(parts, init = {}) {
        this.parts = parts;
        this.type = init.type;
      }
    },
    URL: {
      createObjectURL: (blob) => {
        const url = `blob:fake/${blobs.size + 1}`;
        blobs.set(url, blob);
        return url;
      },
      revokeObjectURL: () => {},
    },
  };
  return {
    win,
    blobs,
    // Runs the timers that are waiting (the page's debounced refresh and save).
    runTimers() {
      for (const [id, callback] of [...timers]) {
        timers.delete(id);
        callback();
      }
    },
    pendingTimers: () => timers.size,
    listenerCount: (type) => (listeners.get(type) ?? []).length,
    // Fires an event on the window (like "load" or "pagehide"); `extra` is added to the event.
    fire(type, extra = {}) {
      for (const listener of listeners.get(type) ?? []) listener({ type, ...extra });
    },
  };
}

export function createMemoryStorage() {
  const data = new Map();
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

// A storage that refuses everything, like a browser with site data blocked.
export function createBrokenStorage() {
  const fail = () => {
    throw new Error('storage is blocked');
  };
  return { getItem: fail, setItem: fail, removeItem: fail };
}

// A File as the page sees it: a name, a size and the content.
export function fakeFile(name, content) {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  return {
    name,
    size: bytes.length,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    text: async () => new TextDecoder().decode(bytes),
  };
}
