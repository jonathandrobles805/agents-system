// The Board's cases (hardening plan Step 10; item 3i), on the board-api fixture project that build-fixtures.js makes
// with this checkout's own kit scripts, served by this checkout's server (serve.js target 'work'):
//   PARITY_DATA=parity/.data-board PARITY_TARGET=work npx playwright test --config parity/playwright.config.js parity/board-cases.spec.js
// Screenshots of the Board and the drawer at 1600 and 900 px go to parity/results/board/.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { serve, HERE } from './serve.js';
import { open } from './helpers.js';

let srv;
const url = async () => (srv ??= await serve('work', 'board')).url;
test.afterAll(async () => { if (srv) await srv.close(); });
const card = (page, slug) => page.locator(`.bcard[data-lane="${slug}"]`);
const OUT = path.join(HERE, 'results', 'board');

test('3i: an agent running: a pulse with its type and the first 6 characters of its id, reported by the lane', async ({ page }) => {
  await open(page, await url(), '#/board', { width: 1600 });
  const run = card(page, 'running').locator('.brun');
  await expect(run).toHaveText('implementer a1b2c3');
  await expect(run).toHaveAttribute('data-src', 'lane');
  await expect(card(page, 'running').locator('.bpulse')).toHaveCount(1);
  for (const s of ['gated', 'stale', 'rounds', 'parked', 'billing']) await expect(card(page, s).locator('.bpulse')).toHaveCount(0);
  await expect(page.locator('.bfoot')).toHaveText('1 running · cost hidden');
});

test('3i: gate pass, gate stale, a FAIL round then a PASS round, parked, needs you, cost hidden', async ({ page }) => {
  await open(page, await url(), '#/board', { width: 1600 });
  const chips = (slug) => card(page, slug).locator('.bround').evaluateAll((rs) => rs.map((r) => [...r.querySelectorAll('.bchip')].map((c) => c.textContent)));
  expect(await chips('gated')).toEqual([['gate PASS']]);
  expect(await chips('stale')).toEqual([['gate PASS', 'gate stale']]);
  expect(await chips('rounds')).toEqual([['gate FAIL'], ['gate PASS']]);
  await expect(page.locator('.bcol[data-col="Needs you"] .bcard[data-lane="parked"] .bflag')).toHaveText('your call');
  await expect(card(page, 'billing').locator('.bflag')).toHaveText('your call');
  for (const s of ['running', 'gated', 'stale', 'rounds', 'parked']) await expect(card(page, s).locator('.bcost')).toHaveText('cost hidden');
  await expect(card(page, 'billing').locator('.bcost')).toHaveCount(0); // no worktree, no cost to show
});

test('3i: a lane with no events: its drawer lists no events file', async ({ page }) => {
  await open(page, await url(), '#/board', { width: 1600 });
  await card(page, 'gated').click();
  await expect(page.locator('.drawer .dfile').first()).toBeVisible();
  await expect(page.locator('.drawer .dfile', { hasText: '.events.jsonl' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await card(page, 'running').click();
  await expect(page.locator('.drawer .dfile', { hasText: 'running.events.jsonl' })).toHaveCount(1);
});

test('3i: axe: the Board and the drawer add no violation beyond the page\'s own (no <h1>, as every screen)', async ({ page }) => {
  await open(page, await url(), '#/board', { width: 1600 });
  const ids = async () => (await new AxeBuilder({ page }).analyze()).violations.map((v) => `${v.id} ×${v.nodes.length}`).sort();
  const board = await ids();
  await card(page, 'rounds').click();
  await page.locator('.drawer .dfile').first().click();
  await expect(page.locator('.drawer .dview')).toBeVisible();
  const drawer = await ids();
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'axe.json'), JSON.stringify({ board, drawer }, null, 2) + '\n');
  // the page's own violation on every screen: no <h1> (a11y-original.json); nothing else, on the Board or in the drawer
  for (const v of [...board, ...drawer]) expect(v).toMatch(/^page-has-heading-one ×1$/);
});

for (const width of [1600, 900]) {
  test(`3i: screenshots of the Board and the drawer at ${width} px`, async ({ page }) => {
    await open(page, await url(), '#/board', { width });
    fs.mkdirSync(OUT, { recursive: true });
    await page.screenshot({ path: path.join(OUT, `board@${width}.png`), fullPage: false });
    await card(page, 'rounds').click();
    await page.locator('.drawer .dfile', { hasText: 'rounds.progress.md' }).click();
    await expect(page.locator('.drawer .dview')).toContainText('Summary');
    await page.screenshot({ path: path.join(OUT, `drawer@${width}.png`), fullPage: false });
  });
}
