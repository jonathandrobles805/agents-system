// Ground-truth capture (Step 2) and the same capture of the React build (Step 3).
// For every state: a screenshot at each width (900 high), the normalised DOM, the rendered text, computed styles,
// the request log and the console. Written to results/<target>/capture/. The baseline is a frozen copy of
// results/original/capture taken once; compare.js diffs a target against it. Nothing here edits the baseline.
import fs from 'node:fs';
import path from 'node:path';
import { test } from '@playwright/test';
import { serve, HERE } from './serve.js';
import { TARGET, WIDTHS, HEIGHT, NOW, open, quiet, watch, normalizedDom, renderedText, computedStyles } from './helpers.js';

const OUT = path.join(HERE, 'results', TARGET, 'capture');
fs.mkdirSync(OUT, { recursive: true });

const servers = {};
const base = async (scenario) => (servers[scenario] ??= await serve(TARGET, scenario)).url;
test.afterAll(async () => { for (const s of Object.values(servers)) await s.close(); });

async function record(page, w, name, width, { styles = true, requestsOnly = false } = {}) {
  const f = (ext) => path.join(OUT, `${name}@${width}.${ext}`);
  await page.screenshot({ path: f('png'), animations: 'disabled', caret: 'hide' });
  fs.writeFileSync(f('dom.txt'), (await normalizedDom(page, 'html')) + '\n');
  fs.writeFileSync(f('text.txt'), (await renderedText(page)) + '\n');
  if (styles) fs.writeFileSync(f('styles.json'), JSON.stringify(await computedStyles(page), null, 1) + '\n');
  fs.writeFileSync(f('log.txt'), [...(requestsOnly ? w.requests.filter((r) => !r.startsWith('  →')) : w.requests), '-- console', ...w.console, '-- pageerror', ...w.pageErrors].join('\n') + '\n');
}

/** Press Tab until `selector` has focus, so :focus-visible applies the way a keyboard user sees it. */
async function tabTo(page, selector, max = 120) {
  // starts from a freshly loaded page (focus on <body>); blur() there moves the sequential-focus start point in Chrome
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    if (await page.evaluate((s) => document.activeElement && document.activeElement.matches(s), selector)) return;
  }
  throw new Error(`could not reach ${selector} with Tab`);
}

// [name, scenario, hash, steps]
const STATES = [
  ['arch-system', 'live2', '#/arch/system'],
  ['arch-system-sel', 'live2', '#/arch/system/agent%3Aimplementer'],
  ['insp-impact', 'live2', '#/arch/system/agent%3Aimplementer', async (p) => p.click('[data-itab=impact]')],
  ['insp-tests', 'live2', '#/arch/system/agent%3Aimplementer', async (p) => p.click('[data-itab=tests]')],
  ['insp-history', 'live2', '#/arch/system/agent%3Aimplementer', async (p) => p.click('[data-itab=history]')],
  ['blast', 'live2', '#/arch/system/script%3Alane', async (p) => { await p.click('[data-itab=impact]'); await p.click('#blastBtn'); }],
  ['arch-agents', 'live2', '#/arch/agents'],
  ['arch-pipeline', 'live2', '#/arch/pipeline'],
  ['arch-deps', 'live2', '#/arch/deps'],
  ['arch-deps-sel', 'live2', '#/arch/deps/script%3Alane', async (p) => p.click('.depwrap [data-group]')],
  ['arch-activity', 'live2', '#/arch/activity'],
  ['wt-index', 'live2', '#/worktrees'],
  ['wt-lane-building', 'live2', '#/worktrees', async (p) => p.click('.mk[data-lane=refund-route]')],
  ['wt-lane-escalated', 'live2', '#/worktrees', async (p) => p.click('.mk[data-lane=export-csv]')],
  ['wt-python', 'live2', '#/worktrees', async (p) => p.selectOption('#projectSel', { label: 'python-service' })],
  ['live1-wt', 'live1', '#/worktrees'],
  ['live1-arch', 'live1', '#/arch/system'],
  ['dup-wt', 'livedup', '#/worktrees'],
  // review rounds (#126): the lane list's round pills, a lane at round 2, a parked lane with its Parked row
  ['rounds-wt', 'rounds', '#/worktrees'],
  ['rounds-lane', 'rounds', '#/worktrees', async (p) => p.click('.mk[data-lane=search-index]')],
  ['rounds-parked', 'rounds', '#/worktrees', async (p) => p.click('.mk[data-lane=webhooks]')],
  ['pages-wt', 'pages', ''],
  ['pages-arch', 'pages', '#/arch/system'],
  ['empty-wt', 'empty', ''],
];

for (const [name, scenario, hash, steps] of STATES) {
  test(`capture ${name}`, async ({ page }) => {
    const url = await base(scenario);
    for (const width of WIDTHS) {
      const w = await open(page, url, hash, { width });
      if (steps) { await steps(page); await quiet(page, w); }
      await record(page, w, name, width);
    }
  });
}

// Scrolled captures (#79): the three scroll containers, scrolled to the end.
for (const [name, scenario, hash, sel, steps] of [
  ['scroll-vp', 'live2', '#/arch/system/agent%3Aimplementer', '.vp'],
  ['scroll-insp', 'live2', '#/arch/system/agent%3Aimplementer', '.insp', async (p) => p.click('[data-itab=tests]')],
  ['scroll-worktrees', 'live2', '#/worktrees', '#worktrees', async (p) => p.click('.mk[data-lane=refund-route]')],
]) {
  test(`capture ${name}`, async ({ page }) => {
    const url = await base(scenario);
    for (const width of WIDTHS) {
      const w = await open(page, url, hash, { width });
      if (steps) { await steps(page); await quiet(page, w); }
      await page.$eval(sel, (el) => { el.scrollTop = el.scrollHeight; });
      await quiet(page, w);
      await record(page, w, name, width, { styles: false });
    }
  });
}

// Hover, focus and disabled states (#13–#15), at 1440 and 1920 (both sides of the one breakpoint).
const POINTER = [
  ['hover-button', 'live2', '#/arch/system', async (p) => p.hover('#refresh')],
  ['hover-node', 'live2', '#/arch/system', async (p) => p.hover('.node[data-node="agent:implementer"]')],
  ['hover-ac', 'live2', '#/arch/agents', async (p) => p.hover('.ac[data-node="agent:planner"]')],
  ['hover-li', 'live2', '#/arch/deps', async (p) => p.hover('.li >> nth=2')],
  ['hover-row', 'live2', '#/worktrees', async (p) => p.hover('.row[data-project] >> nth=1')],
  ['focus-tab', 'live2', '#/arch/system', async (p) => tabTo(p, '#tab-worktrees')],
  ['focus-select', 'live2', '#/arch/system', async (p) => tabTo(p, '#projectSel')],
  ['focus-node', 'live2', '#/arch/system', async (p) => tabTo(p, '[data-node]')],
  ['focus-input', 'live2', '#/arch/deps', async (p) => tabTo(p, '#q')],
  ['disabled-open', 'live2', '#/worktrees', async (p) => { await p.click('.mk[data-lane=refund-route]'); await p.click('[data-open]'); await p.waitForFunction(() => /Could not|Opened/.test(document.querySelector('[data-open]').textContent)); }],
];
for (const [name, scenario, hash, act] of POINTER) {
  test(`capture ${name}`, async ({ page }) => {
    const url = await base(scenario);
    for (const width of [1440, 1920]) {
      const w = await open(page, url, hash, { width });
      await act(page);
      await quiet(page, w);
      await record(page, w, name, width);
    }
  });
}

// 80a: what paints before the script has data. (1) JavaScript disabled. (2) First paint: the first data request
// (/api/status, or status.json in static mode) is held until the screenshot is taken, then released.
test.describe('pre-JS paint', () => {
  test.use({ javaScriptEnabled: false });
  test('capture nojs', async ({ page }) => {
    const url = await base('live2');
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: HEIGHT });
      const w = watch(page);
      await page.goto(url);
      await record(page, w, 'nojs', width);
    }
  });
});

for (const scenario of ['live2', 'pages']) {
  test(`capture firstpaint-${scenario}`, async ({ page }) => {
    const url = await base(scenario);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: HEIGHT });
      await page.clock.setFixedTime(NOW);
      const w = watch(page);
      let release;
      const held = new Promise((r) => { release = r; });
      let seen;
      const reached = new Promise((r) => { seen = r; });
      await page.route(/\/(api\/status|status\.json)$/, async (route) => { seen(); await held; await route.continue(); });
      await page.goto(url, { waitUntil: 'commit' });
      await reached;
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      // which responses have arrived while the first data request is held is a race on the same build; only the
      // requests made up to that point are recorded
      await record(page, w, `firstpaint-${scenario}`, width, { requestsOnly: true });
      release();
      await page.unrouteAll({ behavior: 'wait' });
      await quiet(page, w);
    }
  });
}
