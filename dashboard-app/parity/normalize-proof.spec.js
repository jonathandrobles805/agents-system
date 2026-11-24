// Register 80b: the DOM normalisation must ignore only what it says it ignores, and catch everything else.
// Each case mutates the live original page, then compares normalizedDom / renderedText against the unmutated page.
import { test, expect } from '@playwright/test';
import { serve } from './serve.js';
import { open, normalizedDom, renderedText } from './helpers.js';

let srv;
test.beforeAll(async () => { srv = await serve('original', 'live2'); });
test.afterAll(async () => { await srv.close(); });

async function compare(page, hash, mutate) {
  await open(page, srv.url, hash);
  const dom0 = await normalizedDom(page, 'html');
  const text0 = await renderedText(page);
  await page.evaluate(mutate);
  const dom1 = await normalizedDom(page, 'html');
  const text1 = await renderedText(page);
  const changed = dom0.split('\n').filter((l, i) => l !== dom1.split('\n')[i]).length + Math.abs(dom0.split('\n').length - dom1.split('\n').length);
  return { domChanged: changed, textChanged: text0 !== text1 };
}

// Ignored by rule: attribute order (1), class token order and spacing (1a), style spacing (1b), whitespace-only text (2).
test('ignored: attribute order, class token order, style spacing, whitespace-only text between blocks', async ({ page }) => {
  const r = await compare(page, '#/worktrees', () => {
    const row = document.querySelector('.row[data-project]');
    const attrs = [...row.attributes].map((a) => [a.name, a.value]);
    for (const [n] of attrs) row.removeAttribute(n);
    for (const [n, v] of attrs.reverse()) row.setAttribute(n, v); // same attributes, reversed order
    const card = document.querySelector('.card');
    card.setAttribute('class', '  card  '); // same token, different spacing
    const m = document.querySelector('.mk[style]');
    if (m) m.setAttribute('style', 'visibility :  hidden'); // same declaration, different spacing
    card.insertBefore(document.createTextNode('\n      '), card.firstChild); // whitespace-only text before a block
  });
  expect(r).toEqual({ domChanged: 0, textChanged: false });
});

// Caught: one deliberately broken element per kind.
for (const [name, hash, mutate, expectDom, expectText] of [
  ['a removed attribute (role="button" on one node)', '#/arch/system', () => document.querySelector('[data-node]').removeAttribute('role'), true, false],
  ['an attribute value (aria-selected "true" → "True")', '#/arch/system', () => document.querySelector('#tab-arch').setAttribute('aria-selected', 'True'), true, false],
  ['an extra class token', '#/arch/system', () => document.querySelector('.vi').classList.add('x'), true, false],
  ['a style value (visibility:hidden → visible)', '#/worktrees', () => { document.querySelector('.mk[style]').style.visibility = 'visible'; }, true, true], // the hidden '·' becomes visible text,
  ['one character of text', '#/arch/system', () => { const h = document.querySelector('#vtitle'); h.textContent = h.textContent.replace('S', 's'); }, true, true],
  ['a wrapper element (div around the brand)', '#/arch/system', () => { const b = document.querySelector('.brand'); const d = document.createElement('div'); b.replaceWith(d); d.append(b); }, true, false],
  // Whitespace between inline elements is dropped by rule 2 in the DOM and caught by the rendered text (register #65):
  ['the space between two inline spans (rule 2: DOM ignores, rendered text catches)', '#/worktrees', () => {
    const name = document.querySelector('.row[data-lane] .name');
    if (name && name.nextSibling && name.nextSibling.nodeType === 3) name.nextSibling.remove();
  }, false, true],
]) {
  test(`caught: ${name}`, async ({ page }) => {
    const r = await compare(page, hash, mutate);
    expect(r.domChanged > 0).toBe(expectDom);
    expect(r.textChanged).toBe(expectText);
  });
}
