// The Board tab (hardening plan Step 10, "A Runs view"; item 3f). It runs against this checkout's own server and
// built page (serve.js target 'work'), on the fixture data, because the board reads routes and fields this branch
// adds. Expected values come from the fixture build (build-fixtures.js) and from kit/workflows/*.json.
//   PARITY_TARGET=work npx playwright test --config parity/playwright.config.js parity/board.spec.js
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { serve, FIXTURE } from './serve.js';
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

// ---------------------------------------------------------------------------------------------------- 3g the drawer
const openDrawer = async (page, slug) => { await card(page, slug).click(); await expect(page.locator('.drawer')).toHaveAttribute('data-lane', slug); };

test('3g: the drawer header: slug, stage, round, cost, elapsed, PR link', async ({ page }) => {
  await open(page, await url('rounds'), '#/board', { width: 1600 });
  await openDrawer(page, 'webhooks');
  const h = page.locator('.drawer .dhead');
  await expect(h.locator('.dslug')).toHaveText('webhooks');
  await expect(h.locator('.dstage')).toHaveText('parked');
  await expect(h.locator('.dround')).toHaveText('round 3 of 3');
  await expect(h.locator('.dcost')).toHaveText('cost hidden');
  await expect(h.locator('.delapsed')).toHaveText(/^\d+\.\dh$/);
});

test('3g: files grouped Lane / Round N, a verdict dot each; Summary first, then the full file; no Summary is said', async ({ page }) => {
  await open(page, await url('live2'), '#/board', { width: 1600 });
  await openDrawer(page, 'audit-log');
  await expect(page.locator('.drawer .dgroup-h')).toHaveText(['Lane', 'Round 1']);
  const lane = page.locator('.drawer .dgroup[data-group="Lane"] .dfile');
  await expect(lane).toHaveText([/docs\/specs\/audit-log\.md/, /docs\/specs\/audit-log\.progress\.md/]);
  await expect(page.locator('.drawer .dgroup[data-group="Round 1"] .dfile')).toHaveText([/audit-log\.review\.md/]);
  for (const f of await page.locator('.drawer .dfile').all()) await expect(f.locator('.vdot')).toHaveCount(1);
  // the spec has a Summary: it is shown first, alone, until "Open full file"
  await page.locator('.drawer .dfile', { hasText: 'docs/specs/audit-log.md' }).click();
  const view = page.locator('.drawer .dview');
  await expect(view.locator('h2').first()).toHaveText('Summary');
  await expect(view).not.toContainText('Done-criteria');
  await view.getByRole('button', { name: 'Open full file' }).click();
  await expect(view).toContainText('Done-criteria');
  // a progress file from before the Summary section: said so, and the whole file is shown
  await page.locator('.drawer .dfile', { hasText: 'audit-log.progress.md' }).click();
  await expect(view.locator('.dnosum')).toHaveText('This file has no ## Summary.');
  await expect(view).toContainText('Done-criteria');
});

test('3g: Markdown is rendered without any raw HTML from the file', async ({ page }) => {
  const prog = path.join(FIXTURE.worktrees.wtSearch, 'docs', 'specs', 'search-index.progress.md');
  const before = fs.readFileSync(prog);
  fs.writeFileSync(prog, '# Progress\n\n## Summary\n\n<img src=x onerror="window.__xss=1"> **bold** and `<script>window.__xss=2</script>`\n\n<b>raw</b>\n');
  try {
    await open(page, await url('rounds'), '#/board', { width: 1600 });
    await openDrawer(page, 'search-index');
    await page.locator('.drawer .dfile', { hasText: 'search-index.progress.md' }).click();
    const view = page.locator('.drawer .dview');
    await expect(view).toContainText('<img src=x onerror="window.__xss=1">');
    await expect(view).toContainText('<b>raw</b>');
    await expect(view.locator('strong')).toHaveText('bold');
    await expect(view.locator('img, script, b')).toHaveCount(0);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  } finally {
    fs.writeFileSync(prog, before);
  }
});

test('3g: Escape and the scrim close the drawer', async ({ page }) => {
  await open(page, await url('rounds'), '#/board', { width: 1600 });
  await openDrawer(page, 'search-index');
  await page.keyboard.press('Escape');
  await expect(page.locator('.drawer')).toHaveCount(0);
  await openDrawer(page, 'search-index');
  await page.locator('.scrim').click({ position: { x: 20, y: 20 } });
  await expect(page.locator('.drawer')).toHaveCount(0);
});
