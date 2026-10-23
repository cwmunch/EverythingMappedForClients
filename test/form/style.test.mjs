// The style sheet of the form, checked as text: colour contrast in light and dark, the media
// queries the brief asks for, and the flat look. Nothing here is measured in a real browser.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFormHtml } from './helpers.mjs';

const html = readFormHtml();
const css = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
const code = css.replace(/\/\*[\s\S]*?\*\//g, '');

// The body of the block that starts at `opener` (braces counted), or null.
function block(source, opener) {
  const start = source.indexOf(opener);
  if (start === -1) return null;
  let depth = 0;
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(source.indexOf('{', start) + 1, index);
  }
  return null;
}

function tokens(body) {
  return Object.fromEntries([...body.matchAll(/--([a-z-]+)\s*:\s*(#[0-9a-f]{6})\s*;/gi)].map((match) => [match[1], match[2]]));
}

const dark = block(code, '@media (prefers-color-scheme: dark)');
const light = tokens(block(code, ':root'));
const night = { ...light, ...tokens(block(dark, ':root')) };

function channel(value) {
  const unit = value / 255;
  return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const [red, green, blue] = [1, 3, 5].map((at) => channel(parseInt(hex.slice(at, at + 2), 16)));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(first, second) {
  const [high, low] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (high + 0.05) / (low + 0.05);
}

// Text on its background (4.5:1 at least) and the parts of controls that must be seen (3:1).
const TEXT_PAIRS = [
  ['ink', 'bg'], ['ink', 'surface'], ['ink', 'tint'], ['ink', 'danger-bg'],
  ['muted', 'bg'], ['muted', 'surface'], ['muted', 'tint'],
  ['accent', 'bg'], ['accent', 'surface'], ['accent', 'tint'],
  ['accent-ink', 'accent'], ['accent-ink', 'accent-hover'],
  ['warn', 'surface'], ['warn', 'tint'],
];
const COMPONENT_PAIRS = [['field-border', 'surface'], ['field-border', 'bg'], ['focus', 'bg'], ['focus', 'surface'], ['accent', 'bg'], ['accent', 'surface'], ['danger', 'danger-bg']];

for (const [name, palette] of [['light', light], ['dark', night]]) {
  test(`text contrast is at least 4.5:1 in the ${name} colours`, () => {
    for (const [foreground, background] of TEXT_PAIRS) {
      const ratio = contrast(palette[foreground], palette[background]);
      assert.ok(ratio >= 4.5, `${foreground} on ${background}: ${ratio.toFixed(2)}`);
    }
  });

  test(`borders, focus ring and accent are at least 3:1 in the ${name} colours`, () => {
    for (const [foreground, background] of COMPONENT_PAIRS) {
      const ratio = contrast(palette[foreground], palette[background]);
      assert.ok(ratio >= 3, `${foreground} on ${background}: ${ratio.toFixed(2)}`);
    }
  });
}

test('every colour token has a value in both colour sets', () => {
  assert.deepEqual(Object.keys(light).sort(), Object.keys(night).sort());
  assert.ok(Object.keys(light).length >= 13);
  for (const [name, value] of Object.entries(light)) assert.match(value, /^#[0-9a-f]{6}$/i, name);
  assert.notDeepEqual(light, night);
  assert.ok(code.includes('color-scheme: light dark'));
});

test('the page sets its own background and text colour, so dark mode never shows browser white', () => {
  const body = block(code, '\nbody {');
  assert.match(body, /background:\s*var\(--bg\)/);
  assert.match(body, /color:\s*var\(--ink\)/);
});

test('light and dark follow the system, with no switch that could disagree with it', () => {
  assert.ok(dark, 'a prefers-color-scheme: dark block exists');
  assert.ok(!/data-theme/.test(code));
  assert.ok(!/prefers-color-scheme:\s*light/.test(code));
});

test('motion stops when the person asks for less of it', () => {
  const reduced = block(code, '@media (prefers-reduced-motion: reduce)');
  assert.ok(reduced);
  assert.match(reduced, /transition:\s*none\s*!important/);
  assert.match(reduced, /animation:\s*none\s*!important/);
  assert.match(reduced, /scroll-behavior:\s*auto\s*!important/);
  assert.ok(!/@keyframes/.test(code), 'no keyframe animation at all');
  assert.ok(!/scroll-behavior:\s*smooth/.test(code));
});

test('the page works from 360 px up: one column first, side column only on wide screens', () => {
  assert.ok(block(code, '@media (max-width: 40rem)'), 'a narrow-screen block exists');
  const wide = block(code, '@media (min-width: 56rem)');
  assert.match(wide, /grid-template-columns:\s*18rem minmax\(0, 1fr\)/);
  assert.match(block(code, '\n.layout {'), /grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(block(code, '\n.field {'), /width:\s*100%/);
  assert.match(block(code, '\n#app {'), /max-width:\s*72rem/);
  assert.ok(!/min-width:\s*(?:[4-9]\d{2}|\d{4,})px/.test(code), 'no fixed minimum width of a phone or wider');
  assert.ok(!/\bwidth:\s*\d{3,}px/.test(code), 'no fixed pixel width');
  assert.match(block(code, '\n.q {'), /overflow-wrap:\s*anywhere/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
});

test('keyboard focus is always visible and targets are at least 44 px', () => {
  const focus = block(code, ':focus-visible');
  assert.match(focus, /outline:\s*3px solid var\(--focus\)/);
  assert.ok(!/outline:\s*(?:none|0)\b/.test(code.replace(/\[tabindex="-1"\]:focus\s*\{[^}]*\}/, '')), 'outline is only removed for headings that are focused by code');
  for (const selector of ['\n.btn {', '\n.seg {', '\n.nav-item {', '\n.field {', '\n.option {']) {
    assert.match(block(code, selector), /min-height:\s*2\.75rem/, selector);
  }
  assert.match(block(code, '\n.nav-box > summary'), /min-height:\s*2\.75rem/);
});

test('there is a print style that shows every module and hides what does nothing on paper', () => {
  const print = block(code, '@media print');
  assert.ok(print);
  assert.match(print, /\.module\[hidden\]\s*\{\s*display:\s*block\s*!important/);
  assert.match(print, /\.side/);
  assert.match(print, /\.btn/);
  assert.match(print, /break-inside:\s*avoid/);
  assert.match(print, /--ink:\s*#000000/);
});

test('one system font stack, flat colour and no decoration that needs a picture', () => {
  const families = [...code.matchAll(/font(?:-family)?\s*:\s*[^;]*?(?:system-ui|sans-serif|serif|monospace)[^;]*;/g)];
  assert.equal(families.length, 1, 'font family is set once');
  assert.match(families[0][0], /system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif/);
  for (const pattern of [/gradient/i, /box-shadow/, /text-shadow/, /backdrop-filter/, /\bblur\(/, /url\(/, /@font-face/, /@import/, /filter\s*:/, /\bimage\b/i, /mask/]) {
    assert.ok(!pattern.test(code), String(pattern));
  }
  assert.ok(!/content:\s*["'][^"']*[^\x00-\x7f]/.test(code), 'no symbol or emoji inserted by the style sheet');
});

test('the hidden attribute always wins over a display rule', () => {
  assert.match(block(code, '\n[hidden] {'), /display:\s*none\s*!important/);
});

test('the controls keep a readable size: fields use the page font so phones do not zoom in', () => {
  assert.match(block(code, '\n.field {'), /font:\s*inherit/);
  assert.match(block(code, '\nbody {'), /font:\s*1rem\//);
});

test('the style sheet is well formed: balanced braces, whole declarations, known colour tokens', () => {
  assert.equal((code.match(/\{/g) || []).length, (code.match(/\}/g) || []).length, 'braces are balanced');
  assert.equal((code.match(/\(/g) || []).length, (code.match(/\)/g) || []).length, 'parentheses are balanced');
  const declarations = [...code.matchAll(/\{([^{}]*)\}/g)].flatMap((match) => match[1].split(';').map((part) => part.trim()).filter(Boolean));
  assert.ok(declarations.length > 300);
  for (const declaration of declarations) assert.match(declaration, /^(?:--)?[a-z-]+\s*:\s*\S[^:]*(?:\([^)]*\))?[^:]*$|^[a-z-]+\s*:\s*.*$/i, declaration);
  assert.ok(!/;\s*;/.test(code) && !/\{\s*\}/.test(code), 'no empty rule or declaration');
  const used = new Set([...code.matchAll(/var\(--([a-z-]+)\)/g)].map((match) => match[1]));
  for (const name of used) assert.ok(Object.hasOwn(light, name), `--${name} is used but never defined`);
  for (const name of Object.keys(light)) assert.ok(used.has(name) || name === 'color-scheme', `--${name} is defined but never used`);
});

test('the review step has one column that may shrink, and long names and addresses break instead of widening the page', () => {
  assert.match(block(code, '\n.finish {'), /grid-template-columns:\s*minmax\(0, 1fr\)/);
  const group = /([^{}]*)\{[^{}]*overflow-wrap:\s*anywhere[^{}]*\}/g;
  const selectors = [...code.matchAll(group)].map((match) => match[1]).join(',');
  for (const selector of ['.finish-block', '.plain-list li', '.notice', '.finish-summary', '.hint', '.sync p']) {
    assert.ok(selectors.includes(selector), `${selector} breaks long words`);
  }
  assert.match(block(code, '\n.finish-block {'), /min-width:\s*0/);
});

test('the notice about another window stays in view on a wide screen only, and hides like everything hidden', () => {
  assert.doesNotMatch(block(code, '\n.sync {'), /position:\s*sticky/, 'on a phone it would cover a third of the screen: it stays where it is and takes the focus');
  const wide = block(code, '@media (min-width: 40rem)');
  assert.match(block(wide, '.sync {'), /position:\s*sticky/);
  assert.match(block(wide, '.sync {'), /top:\s*0/);
  assert.ok(/\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(code), 'the hidden attribute wins over display');
});

test('the setup block and every file field shrink to a phone of 320 px instead of widening the page', () => {
  assert.match(block(code, '\n.setup {'), /grid-template-columns:\s*minmax\(0, 1fr\)/, 'the single column of the setup block may shrink');
  assert.match(block(code, 'input[type="file"]'), /max-width:\s*100%/);
  assert.match(block(code, '\n.finish {'), /grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(block(code, '\n.layout {'), /grid-template-columns:\s*minmax\(0, 1fr\)/);
});

test('a message that takes the focus shows a focus ring, though headings that are focused by code do not', () => {
  const ring = block(code, '.notice[tabindex="-1"]:focus');
  assert.match(ring, /outline:\s*3px solid var\(--focus\)/);
  assert.match(block(code, '.sync[tabindex="-1"]:focus'), /outline:\s*3px solid var\(--focus\)/);
  assert.match(block(code, '\n[tabindex="-1"]:focus {'), /outline:\s*none/, 'headings and the main area still show none');
});
