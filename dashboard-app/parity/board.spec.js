// The Board tab (hardening plan Step 10, "A Runs view"; item 3f). It runs against this checkout's own server and
// built page (serve.js target 'work'), on the fixture data, because the board reads routes and fields this branch
// adds. Expected values come from the fixture build (build-fixtures.js) and from kit/workflows/*.json.
//   PARITY_TARGET=work npx playwright test --config parity/playwright.config.js parity/board.spec.js
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { serve } from './serve.js';
import { open } from './helpers.js';

const KIT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'kit');
const COLUMNS = ['Research', 'Plan', 'Approve', 'Build', 'Review', 'Merge', 'Needs you', 'Done'];
const servers = {};
const url = async (scenario) => (servers[scenario] ??= await serve('work', scenario)).url;
test.afterAll(async () => { for (const s of Object.values(servers)) await s.close(); });

const card = (page, slug) => page.locator(`.bcard[data-lane="${slug}"]`);

test('3f: a Board tab; eight columns in order, each with its stages\' agents and models and its card count', async ({ page }) => {
  await open(page, await url('live2'), '#/board', { width: 1600 });
  await expect(page.locator('#tab-board')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.bcol .bcol-h .bname')).toHaveText(COLUMNS);
  // agents per stage from kit/workflows/*.json, models from kit/agents/*.md
  const models = Object.fromEntries(fs.readdirSync(path.join(KIT, 'agents')).map((f) => [f.slice(0, -3), /^model:\s*(\S+)/m.exec(fs.readFileSync(path.join(KIT, 'agents', f), 'utf8'))?.[1]]));
  const build = page.locator('.bcol[data-col="Build"] .bagents');
  await expect(build).toContainText(`implementer · ${models.implementer}`);
  await expect(build).toContainText(`tester · ${models.tester}`);
  await expect(build).toContainText('skill-smith · no agent file');
  for (const c of COLUMNS) {
    const col = page.locator(`.bcol[data-col="${c}"]`);
    await expect(col.locator('.bcount')).toHaveText(String(await col.locator('.bcard').count()));
  }
});

test('3f: stages with no column are named in a banner, and a lane at such a stage shows there, not hidden', async ({ page }) => {
  await open(page, await url('live2'), '#/board', { width: 1600 });
  const banner = page.locator('.bbanner');
  for (const s of ['inspect', 'report', 'security-signoff', 'verify-ui']) await expect(banner).toContainText(s);
  // every ROADMAP row of node-api is drawn exactly once: in its column, or in the banner when no column holds its stage
  const slugs = await page.locator('.bcard').evaluateAll((els) => els.map((e) => e.getAttribute('data-lane')).sort());
  expect(slugs).toEqual(['audit-log', 'export-csv', 'other', 'rate-limits', 'refund-route']);
});

test('3f: a card: slug, title, flag, rounds, risk, cost, elapsed; each fact marked host or reported by the lane', async ({ page }) => {
  await open(page, await url('rounds'), '#/board', { width: 1600 });
  const parked = card(page, 'webhooks');
  await expect(page.locator('.bcol[data-col="Needs you"] .bcard[data-lane="webhooks"]')).toHaveCount(1);
  await expect(parked.locator('.bslug')).toHaveText('webhooks');
  await expect(parked.locator('.btitle')).toHaveText('Webhooks');
  await expect(parked.locator('.bflag')).toHaveText('your call');
  await expect(parked.locator('.bround')).toHaveCount(3); // round 1 to 3, as rounds_detail sends them
  await expect(parked.locator('.brisk')).toHaveText('high-risk');
  await expect(parked.locator('.bcost')).toHaveText('cost hidden');
  await expect(parked.locator('.belapsed')).toHaveText(/^\d+\.\dh$/);
  await expect(parked.locator('.bpulse')).toHaveCount(0); // no agent running
  for (const f of await parked.locator('[data-src]').all()) expect(['host', 'lane']).toContain(await f.getAttribute('data-src'));
  await expect(parked.locator('[data-src="host"]').first()).toBeVisible();
  const search = card(page, 'search-index');
  await expect(search.locator('.bflag')).toHaveCount(0);
  await expect(search.locator('.bround')).toHaveCount(2);
  await expect(page.locator('.bfoot')).toHaveText('0 running · cost hidden');
});

test('3f: the header has a live dot with the time of the last update', async ({ page }) => {
  await open(page, await url('rounds'), '#/board', { width: 1600 });
  await expect(page.locator('.bhead .dot')).toHaveCount(1);
  await expect(page.locator('.bhead .btime')).toHaveText(/^updated \d\d:\d\d:\d\d$/);
});

test('3f: cards are focusable; Enter opens the drawer for that card', async ({ page }) => {
  await open(page, await url('rounds'), '#/board', { width: 1600 });
  const c = card(page, 'search-index');
  await c.focus();
  await expect(c).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.drawer')).toHaveAttribute('data-lane', 'search-index');
});
