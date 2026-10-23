// The pure part of i18n: wrap a flat dictionary of "dotted.key": "text with {placeholders}".
// Loading the dictionary from disk is in i18n.mjs. This file must stay pure (no node: imports).

export function makeI18n(dict, lang) {
  const entries = new Map(Object.entries(dict ?? {}));

  function has(key) {
    return entries.has(key);
  }

  // A missing key returns the key itself, so a gap is visible instead of fatal.
  // A placeholder without a value is left as written.
  function t(key, params) {
    const template = entries.get(key);
    if (typeof template !== 'string') return key;
    const values = params ?? {};
    return template.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, name) =>
      Object.hasOwn(values, name) ? String(values[name]) : whole,
    );
  }

  function keys() {
    return [...entries.keys()];
  }

  return { lang, t, has, keys };
}
