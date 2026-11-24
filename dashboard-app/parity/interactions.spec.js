// Interaction tests (register D, #40–#64, plus #69, #78, #80c, #61). Every expected value below was read from the
// ORIGINAL page (kit/dashboard/index.html at 9b47008) running on the fixture data in PARITY_DATA, and is hard-coded
// with a note on where it came from. The same file runs against the React build (PARITY_TARGET=react) unchanged.
//
//   PARITY_DATA=parity/.data-int PARITY_TARGET=original npx playwright test --config parity/playwright.config.js parity/interactions.spec.js
//
// Tests that change fixture files (event logs, progress files, a goal file) restore the exact bytes afterwards and run
// on a server of their own, so the server's event-log offsets never point past a restored file.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test as base, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { serve, DATA, FIXTURE, HERE } from './serve.js';
import { TARGET, NOW, open, quiet } from './helpers.js';

const NODE_API = FIXTURE.repos.nodeApi;
const PY = FIXTURE.repos.pySvc;
const WT_REFUND = FIXTURE.worktrees.wtRefund;
const HOOK = path.join(DATA, 'kit-original', 'kit', 'scripts', 'hook_event_log.js');

// ---------------------------------------------------------------------------------------------------- instrumentation
// Counts, recorded in the page before any page script runs (#58, #62, #69). Nothing here changes behaviour.
const INSTRUMENT = () => {
  const name = (t) => (t === document ? 'document' : t === window ? 'window' : t && t.id ? `#${t.id}` : t && t.constructor ? t.constructor.name : '?');
  window.__parity = { es: 0, listeners: [], timers: 0, storage: 0, observers: 0 };
  const P = window.__parity;
  const ES = window.EventSource;
  window.EventSource = class extends ES { constructor(...a) { super(...a); P.es++; } };
  const add = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, ...rest) { P.listeners.push(`${name(this)}:${type}`); return add.call(this, type, ...rest); };
  for (const t of ['setTimeout', 'setInterval', 'requestIdleCallback']) {
    const f = window[t];
    // Playwright's own clock (page.clock) calls setTimeout from its ClockController; only page code is counted
    if (f) window[t] = function (...a) { if (!/ClockController/.test(new Error().stack)) P.timers++; return f.apply(this, a); };
  }
  for (const o of ['IntersectionObserver', 'ResizeObserver', 'MutationObserver']) {
    const C = window[o];
    if (C) window[o] = class extends C { constructor(...a) { super(...a); P.observers++; } };
  }
  for (const s of ['localStorage', 'sessionStorage']) {
    const real = Object.getOwnPropertyDescriptor(window, s);
    Object.defineProperty(window, s, { configurable: true, get() { P.storage++; return real.get.call(window); } });
  }
};

/** 404s the original itself causes, and so the only console errors allowed (observed on the original):
 *  every page load asks for /favicon.ico (no <link rel=icon>, #80c); the static Pages copy has no model.js (#64). */
const ALLOWED_404 = [/\/favicon\.ico$/, /\/model\.js$/];
const CONSOLE_404 = 'error: Failed to load resource: the server responded with a status of 404 (Not Found)';

/** Extra 4xx/5xx URLs and console lines one test expects, because the original causes them in that situation. */
const ALLOW = new WeakMap();
function allow(page, { status = [], console = [] }) {
  const a = ALLOW.get(page) ?? { status: [], console: [] };
  a.status.push(...status); a.console.push(...console);
  ALLOW.set(page, a);
}

const test = base.extend({
  page: async ({ page }, use) => {
    const seen = { console: [], errors: [], bad: [] };
    page.on('console', (m) => seen.console.push(`${m.type()}: ${m.text()}`));
    page.on('pageerror', (e) => seen.errors.push(String(e)));
    page.on('response', (r) => { if (r.status() >= 400 && !ALLOWED_404.some((re) => re.test(r.url())) && !(ALLOW.get(page)?.status ?? []).some((re) => re.test(r.url()))) seen.bad.push(`${r.status()} ${r.url()}`); });
    await page.addInitScript(INSTRUMENT);
    await use(page);
    expect(seen.errors, 'page errors').toEqual([]);
    expect(seen.bad, 'unexpected 4xx/5xx').toEqual([]);
    expect(seen.console.filter((c) => c !== CONSOLE_404 && !(ALLOW.get(page)?.console ?? []).includes(c)), 'console messages other than the allowed ones').toEqual([]);
  },
});

const servers = {};
const shared = async (scenario) => (servers[scenario] ??= await serve(TARGET, scenario)).url;
test.afterAll(async () => { for (const s of Object.values(servers)) await s.close(); });

/** A server of the test's own, closed afterwards. */
async function own(page, scenario, fn) {
  const s = await serve(TARGET, scenario);
  let closed = null; // a test may stop the server itself (#46); stopping twice would wait for an exit that already happened
  const srv = { ...s, close: () => (closed ??= s.close()) };
  try { return await fn(s.url, srv); } finally { await page.goto('about:blank'); await srv.close(); }
}

/** Snapshot files, run fn, restore exact bytes (or remove files that did not exist). */
async function restoring(files, fn) {
  const saved = files.map((f) => [f, fs.existsSync(f) ? fs.readFileSync(f) : null]);
  try { return await fn(); } finally {
    for (const [f, b] of saved) { if (b === null) fs.rmSync(f, { force: true }); else fs.writeFileSync(f, b); }
  }
}

/** One real Claude Code hook call: the JSON the CLI sends on stdin to the kit's event-log hook. */
function hookEvent(payload) {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: 'parity-int', ...payload }), cwd: payload.cwd, encoding: 'utf8', env: { ...process.env, CLAUDE_HOME: path.join(DATA, 'claude-home') } });
  expect(r.status, r.stderr).toBe(0);
}

const text = (page, sel) => page.locator(sel).first().innerText();
const hash = (page) => page.evaluate(() => location.hash);
const parity = (page) => page.evaluate(() => window.__parity);
const nonEventRequests = (w) => w.requests.filter((r) => !r.startsWith('  ') && !r.endsWith('/favicon.ico'));

// ---------------------------------------------------------------------------------------------------- routing
test('#40 hash routes, fallback view, re-render on the same hash', async ({ page }) => {
  const url = await shared('live2');
  await open(page, url, '#/arch/agents');
  expect(await text(page, '#vtitle')).toBe('Agent organization');
  expect(await text(page, '.vi[aria-current=true]')).toBe('02\nAgent organization');
  await open(page, url, '#/arch/bogus');
  expect(await text(page, '#vtitle')).toBe('System architecture');
  await open(page, url, '#/worktrees');
  expect(await page.locator('#worktrees').isVisible()).toBe(true);
  expect(await page.locator('#arch').isHidden()).toBe(true);
  await open(page, url, '#/arch/system/agent%3Aimplementer');
  expect(await text(page, '.insp h2')).toBe('implementer');
  // go() with the hash already current re-renders in place: clicking the current view keeps the hash
  await page.click('.vi[data-view=system]');
  expect(await hash(page)).toBe('#/arch/system/agent%3Aimplementer');
  expect(await text(page, '.insp h2')).toBe('implementer');
});

test('#41 back and forward; an unknown component id is dropped', async ({ page }) => {
  const url = await shared('live2');
  const w = await open(page, url, '#/arch/system');
  await page.click('.vi[data-view=agents]');
  expect(await text(page, '#vtitle')).toBe('Agent organization');
  await page.goBack(); await quiet(page, w);
  expect(await text(page, '#vtitle')).toBe('System architecture');
  await page.goForward(); await quiet(page, w);
  expect(await text(page, '#vtitle')).toBe('Agent organization');
  await open(page, url, '#/arch/system/agent%3Anope');
  expect(await text(page, '.insp h2')).toBe('Nothing selected');
});

// ---------------------------------------------------------------------------------------------------- startup
test('#42 startup: live with no hash opens the canvas, in this request order', async ({ page }) => {
  const url = await shared('live2');
  const w = await open(page, url, '');
  expect(await hash(page)).toBe(''); // observed: no hash is written on load
  expect(await page.getAttribute('#tab-arch', 'aria-selected')).toBe('true');
  expect(await page.getAttribute('#tab-worktrees', 'aria-selected')).toBe('false');
  // observed on the original (favicon excluded: the browser schedules it on its own)
  expect(nonEventRequests(w)).toEqual([
    'GET /', 'GET /model.js', 'GET /api/status', 'GET /api/status', 'GET /api/architecture',
    'GET /api/events/refund-route', 'GET /api/events/export-csv', 'GET /api/events/audit-log', 'GET /api/events/rate-limits', 'GET /api/events/other',
    'GET /api/stream',
  ]);
  expect(await text(page, '#livetext')).toBe('LIVE');
  expect(await page.getAttribute('#livedot', 'class')).toBe('dot on');
});

test('#43 #64 #7 static Pages copy: status.json, no model, canvas needs the live server', async ({ page }) => {
  allow(page, { status: [/\/api\/status$/] }); // index.html:715 probes the live API first, on any http(s) origin
  const url = await shared('pages');
  let w = await open(page, url, '');
  expect(await page.getAttribute('#tab-worktrees', 'aria-selected')).toBe('true'); // no hash + not live → Worktrees
  expect(nonEventRequests(w)).toEqual(['GET /', 'GET /model.js', 'GET /api/status', 'GET /status.json']); // observed
  expect(await text(page, '#livetext')).toBe('STATIC');
  expect(await page.getAttribute('#livedot', 'class')).toBe('dot');
  expect(await text(page, '#main .lbl')).toBe('node-api · kit 0.3.0 · WIP 3 / 3');
  w = await open(page, url, '#/arch/system');
  expect(await text(page, '#vtitle')).toBe('Architecture Canvas');
  expect(await text(page, '#vsub')).toBe('');
  expect(await text(page, '#view')).toBe('The architecture map is built from the repository by the live server. Start it with node ~/.claude/kit/dashboard/server.js --repo .. The Worktrees screen also works from a static status.json.');
  expect(await text(page, '#projcard')).toBe('Needs the live server.');
  expect(await page.locator('#inspector').innerHTML()).toBe('');
});

test('#36 static copy without status.json', async ({ page }) => {
  allow(page, { status: [/\/api\/status$/, /\/status\.json$/] }); // observed: both 404 on a host with index.html alone
  const url = await shared('empty');
  await open(page, url, '');
  expect(await text(page, '#main')).toBe('No status.json found. Run node ~/.claude/kit/scripts/kit_status.js --repo . --out dashboard/status.json, or start the live server: node ~/.claude/kit/dashboard/server.js --repo .');
});

// ---------------------------------------------------------------------------------------------------- data
test('#44 #54 Refresh keeps the chosen project and reloads status, map and events', async ({ page }) => {
  const url = await shared('live2');
  const w = await open(page, url, '#/worktrees');
  await page.selectOption('#projectSel', PY); await quiet(page, w);
  const before = w.requests.length;
  await page.click('#refresh'); await quiet(page, w);
  expect(await page.inputValue('#projectSel')).toBe(PY);
  expect(nonEventRequests({ requests: w.requests.slice(before) })).toEqual([
    'GET /api/status', 'GET /api/architecture', 'GET /api/events/billing-export', 'GET /api/events/health-check',
  ]);
});

test('#45 #59 seeded feed: 8 events newest first, HH:MM:SS times', async ({ page }) => {
  const url = await shared('live2');
  await open(page, url, '#/arch/activity');
  const rows = await page.locator('.feed > div').allInnerTexts();
  // observed: 7 refund-route lines + 1 export-csv line, as the fixture's hook calls wrote them, newest first
  expect(rows.map((r) => r.split(/\s*\n\s*|\t/).slice(1).join(' | '))).toEqual([
    'export-csv | read | src/domain/payment.ts',
    'refund-route | edit | src/domain/payment.ts',
    'refund-route | bash | npm run typecheck',
    'refund-route | bash | npm test',
    'refund-route | blocked | src/routes/refund.ts',
    'refund-route | search | src/domain/payment.ts',
    'refund-route | read | src/domain/payment.ts',
    'refund-route | subagent_start | implementer',
  ]);
  for (const r of rows) expect(r).toMatch(/^\d\d:\d\d:\d\d\b/);
  // event kind colours: bash failure → kr, blocked → kr (result blocked), none green here
  expect(await page.locator('.feed .k.kr').count()).toBe(2);
});

// ---------------------------------------------------------------------------------------------------- stream
test('#46 stream: a real hook event and a progress-file change reach the page; RECONNECTING on loss', async ({ page }) => {
  const events = path.join(WT_REFUND, 'docs', 'specs', 'refund-route.events.jsonl');
  const prog = path.join(WT_REFUND, 'docs', 'specs', 'refund-route.progress.md');
  await restoring([events, prog], () => own(page, 'live2', async (url, srv) => {
    const w = await open(page, url, '#/worktrees');
    await page.click('.mk[data-lane=refund-route]'); await quiet(page, w);
    const n = await page.locator('#events .ev').count();
    hookEvent({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'echo parity-stream' }, tool_response: { stdout: 'parity-stream' }, cwd: WT_REFUND });
    await expect(page.locator('#events .ev').first()).toContainText('echo parity-stream', { timeout: 8000 });
    expect(await page.locator('#events .ev').count()).toBe(n + 1);
    // escalate the lane the way the kit's own test does (dashboard.test.js:131-134) → status event → Needs you
    fs.writeFileSync(prog, fs.readFileSync(prog, 'utf8').replaceAll('- Attempts: {{n}} of 3', '- Attempts: 3 of 3').replaceAll('- Failure: {{what fails}}', '- Failure: parity escalation'));
    await expect(page.locator('.card:has(.lbl:text-is("Needs you")) .row[data-lane=refund-route]')).toContainText('escalated — parity escalation', { timeout: 8000 });
    // server goes away → onerror → amber dot, RECONNECTING (observed; nothing re-renders)
    allow(page, { console: ['error: Failed to load resource: net::ERR_INCOMPLETE_CHUNKED_ENCODING'] }); // the stream breaks
    await srv.close();
    await expect(page.locator('#livetext')).toHaveText('RECONNECTING', { timeout: 8000 });
    expect(await page.getAttribute('#livedot', 'class')).toBe('dot warn');
  }));
});

test('#46 stream: an event while on Live activity adds a feed row', async ({ page }) => {
  const events = path.join(WT_REFUND, 'docs', 'specs', 'refund-route.events.jsonl');
  await restoring([events], () => own(page, 'live2', async (url) => {
    await open(page, url, '#/arch/activity');
    expect(await page.locator('.feed > div').count()).toBe(8);
    hookEvent({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: path.join(WT_REFUND, 'README.md') }, tool_response: { content: 'x' }, cwd: WT_REFUND });
    await expect(page.locator('.feed > div').first()).toContainText('README.md', { timeout: 8000 });
    expect(await page.locator('.feed > div').count()).toBe(9);
  }));
});

// Observed on the original (parity/.data-int built by build-fixtures.js with goal files), 2026-11-23.
const EXPECT_TAGS_NOW = ['agent:implementer=NEXT UP', 'agent:reviewer=NEXT UP', 'agent:tester=RUNNING'];
const EXPECT_TAGS_LATER = ['agent:implementer=NEXT UP', 'agent:reviewer=NEXT UP', 'agent:tester=NEXT UP'];

test('#47 running window: RUNNING inside 2 minutes of the last event, NEXT UP after', async ({ page }) => {
  // The fixture writes goal files for refund-route and audit-log (build-fixtures.js), so lane.js next-step gives them
  // stages with agents. refund-route has events at the fixture's build time; audit-log has none.
  const url = await shared('live2');
  const w = await open(page, url, '#/arch/system'); // clock = fixture build + 60 s
  const tags = () => page.evaluate(() => [...document.querySelectorAll('.node text.tag')].map((t) => `${t.closest('[data-node]').dataset.node}=${t.textContent}`).sort());
  // observed on the original at fixture build + 60 s
  expect(await tags()).toEqual(EXPECT_TAGS_NOW);
  await page.clock.setFixedTime(NOW + 3 * 60_000);
  await page.click('#refresh'); await quiet(page, w);
  // observed on the original at fixture build + 3 min: the running agent falls back to NEXT UP
  expect(await tags()).toEqual(EXPECT_TAGS_LATER);
});

// ---------------------------------------------------------------------------------------------------- clicks
test('#48 node, inspector tab, group and blast-radius clicks', async ({ page }) => {
  const url = await shared('live2');
  const w = await open(page, url, '#/arch/system');
  await page.click('[data-node="script:lane"]'); await quiet(page, w);
  expect(await hash(page)).toBe('#/arch/system/script%3Alane');
  expect(await page.getAttribute('[data-itab=overview]', 'aria-selected')).toBe('true');
  await page.click('[data-itab=impact]');
  expect(await page.getAttribute('[data-itab=impact]', 'aria-selected')).toBe('true');
  // observed groups of script:lane, in order
  expect(await page.locator('.insp .li[data-group]').allInnerTexts()).toEqual([
    // re-observed on the original at 0ae872a: main added a test file and a core script since 9b47008
    '22 of 23 skills\nzi-architecture +21', '15 of 27 test files\napp_token.test.js +14', '5 of 8 agents\nimplementer +4', '4 of 16 CI jobs\neval-smoke +3',
    '2 of 22 core scripts\ndashboard/server.js +1', '2 of 2 tools\naudit/boards.js +1', '1 of 14 CI checks\nmutation-gate', '1 of 2 shell scripts\nrelease.sh',
  ]);
  // clicking the selected node again keeps the tab
  await page.click('[data-node="script:lane"]'); await quiet(page, w);
  expect(await page.getAttribute('[data-itab=impact]', 'aria-selected')).toBe('true');
  // blast radius on/off
  await page.click('#blastBtn');
  expect(await page.getAttribute('#blastBtn', 'aria-pressed')).toBe('true');
  expect(await page.locator('.node.dim').count()).toBeGreaterThan(0);
  expect(await page.locator('.node.rad').count()).toBeGreaterThan(0);
  await page.click('#blastBtn');
  expect(await page.getAttribute('#blastBtn', 'aria-pressed')).toBe('false');
  expect(await page.locator('.node.dim').count()).toBe(0);
  // a group from the inspector opens the Dependencies view with its members
  await page.click('.insp .li[data-group=agent]'); await quiet(page, w);
  expect(await hash(page)).toBe('#/arch/deps/script%3Alane');
  await expect(page.locator('#view .cap').last()).toHaveText('agents that need lane.js');
  expect(await page.locator('#view button.chip').allInnerTexts()).toHaveLength(5);
  // same group again inside Dependencies closes it
  await page.click('.depwrap [data-group=agent]');
  await expect(page.getByText('Click a group to list its members.')).toHaveCount(1);
  // a different node resets the tab to Overview
  await page.click('.depwrap [data-node]'); await quiet(page, w);
  expect(await page.getAttribute('[data-itab=overview]', 'aria-selected')).toBe('true');
});

test('#49 screen tabs', async ({ page }) => {
  const url = await shared('live2');
  const w = await open(page, url, '#/arch/pipeline');
  await page.click('#tab-worktrees'); await quiet(page, w);
  expect(await hash(page)).toBe('#/worktrees');
  await page.click('#tab-arch'); await quiet(page, w);
  expect(await hash(page)).toBe('#/arch/system'); // observed: #/worktrees parses to view system (index.html:289), so the view is not remembered
});

test('#50 Enter and Space activate [data-node] only', async ({ page }) => {
  const url = await shared('live2');
  const w = await open(page, url, '#/arch/deps');
  await page.focus('.li[data-node="agent:planner"]');
  await page.keyboard.press('Enter'); await quiet(page, w);
  expect(await hash(page)).toBe('#/arch/deps/agent%3Aplanner');
  await page.focus('.li[data-node="agent:tester"]');
  await page.keyboard.press(' '); await quiet(page, w);
  expect(await hash(page)).toBe('#/arch/deps/agent%3Atester');
  // a group item (role=button, tabindex=0) is not keyboard-activated (observed)
  const g = page.locator('.depwrap [data-group]').first();
  await g.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Click a group to list its members.')).toHaveCount(1);
});

test('#51 #52 search keeps focus and caret; kind filter', async ({ page }) => {
  const url = await shared('live2');
  await open(page, url, '#/arch/deps');
  expect(await page.locator('.li').count()).toBe(140); // re-observed on the original at 0ae872a (138 at 9b47008)
  await page.click('#q');
  await page.keyboard.type('lane');
  expect(await page.locator('.li').count()).toBe(20); // re-observed on the original at 0ae872a (19 at 9b47008): id, label or purpose contains "lane"
  await page.evaluate(() => document.querySelector('#q').setSelectionRange(2, 2));
  await page.keyboard.type('x');
  expect(await page.inputValue('#q')).toBe('laxne');
  expect(await page.evaluate(() => [document.activeElement.id, document.activeElement.selectionStart])).toEqual(['q', 3]);
  await page.fill('#q', '');
  await page.selectOption('#kindSel', 'agent');
  expect(await page.locator('.li').count()).toBe(8); // observed
});

test('#53 #57 project picker resets lane and feed; lane selection fetches its events', async ({ page }) => {
  const url = await shared('live2');
  const w = await open(page, url, '#/worktrees');
  let before = w.requests.length;
  await page.click('.mk[data-lane=refund-route]'); await quiet(page, w);
  expect(nonEventRequests({ requests: w.requests.slice(before) })[0]).toBe('GET /api/events/refund-route');
  expect(await page.locator('#events .ev').count()).toBe(7);
  before = w.requests.length;
  await page.selectOption('#projectSel', PY); await quiet(page, w);
  expect(nonEventRequests({ requests: w.requests.slice(before) })).toEqual(['GET /api/events/billing-export', 'GET /api/events/health-check']);
  expect(await page.locator('#events').count()).toBe(0);
  expect(await text(page, '#main .card .lbl')).toBe('All projects · click one');
  expect(await page.locator('.crumbs').innerText()).toBe('All projects › python-service');
});

test('#55 worktrees clicks: project row, breadcrumb, lane row, Close', async ({ page }) => {
  const url = await shared('live2');
  const w = await open(page, url, '#/worktrees');
  await page.click('.row[data-project] >> nth=1');
  expect(await text(page, '.crumbs')).toBe('All projects › python-service');
  await page.click('.crumbs a');
  expect(await page.locator('.crumbs').count()).toBe(0);
  expect(await page.locator('#main > .card').count()).toBe(1); // only the index card, no project selected
  await page.click('.row[data-project] >> nth=0');
  await page.click('.row[data-lane=export-csv]'); await quiet(page, w);
  expect(await text(page, '#main .card:has([data-close]) .lbl')).toBe('Lane · wt/export-csv · escalated · stage build');
  expect(await page.getAttribute('.mk[data-lane=export-csv]', 'class')).toBe('mk sel');
  await page.click('[data-close]');
  expect(await page.locator('[data-close]').count()).toBe(0);
});

test('#56 Open Claude button', async ({ page }) => {
  // server.js:509 answers 500 when it cannot open a terminal; the browser logs that response
  allow(page, { status: [/\/api\/open\//], console: ['error: Failed to load resource: the server responded with a status of 500 (Internal Server Error)'] });
  const url = await shared('live2');
  const w = await open(page, url, '#/worktrees');
  await page.click('.mk[data-lane=refund-route]'); await quiet(page, w);
  const b = page.locator('[data-open]');
  expect(await b.innerText()).toBe('Open Claude in this worktree ↗');
  await b.click();
  await expect(b).toHaveText('Could not open: claude CLI not found on PATH'); // server.js:324, PATH without claude
  expect(await b.isDisabled()).toBe(true);
});

// ---------------------------------------------------------------------------------------------------- listeners and globals
test('#58 #62 #69 listeners, one EventSource, no timers, storage or observers', async ({ page }) => {
  const url = await shared('live2');
  const w = await open(page, url, '#/arch/system');
  // observed on the original after load
  const DOC = ['window:hashchange', 'document:click', 'document:keydown', 'document:input', 'document:change', 'document:click', '#refresh:click'];
  let p = await parity(page);
  expect(p.es).toBe(1);
  expect(p.listeners.filter((l) => /^(window|document|#refresh):/.test(l))).toEqual(DOC);
  expect([p.timers, p.storage, p.observers]).toEqual([0, 0, 0]);
  for (const v of ['agents', 'pipeline', 'deps', 'activity', 'system']) { await page.click(`.vi[data-view=${v}]`); await quiet(page, w); }
  await page.click('#refresh'); await quiet(page, w);
  p = await parity(page);
  expect(p.es).toBe(1);
  expect(p.listeners.filter((l) => /^(window|document|#refresh):/.test(l))).toEqual(DOC);
  expect([p.timers, p.storage, p.observers]).toEqual([0, 0, 0]);
});

// ---------------------------------------------------------------------------------------------------- attributes and names
test('#60 aria-selected strings; absent before the script runs', async ({ browser }) => {
  const url = await shared('live2');
  const ctx = await browser.newContext({ javaScriptEnabled: false });
  const p = await ctx.newPage();
  await p.goto(url);
  expect(await p.getAttribute('#tab-arch', 'aria-selected')).toBeNull();
  expect(await p.getAttribute('#tab-worktrees', 'aria-selected')).toBeNull();
  await ctx.close();
});

test('#63 duplicate project names carry their root', async ({ page }) => {
  const url = await shared('livedup');
  await open(page, url, '#/worktrees');
  expect(await page.locator('#projectSel option').allInnerTexts()).toEqual([`node-api · ${NODE_API}`, `node-api · ${FIXTURE.repos.dup}`]);
});

test('#59 clipped labels in the System view', async ({ page }) => {
  const url = await shared('live2');
  await open(page, url, '#/arch/system');
  const clipped = await page.evaluate(() => [...document.querySelectorAll('.node text')].map((t) => t.textContent).filter((t) => t.includes('…')));
  expect(clipped).toEqual(['PostToolUse · PostTo…', 'eval/runners/claude…', 'eval/runners/fixtur…', 'telemetry/collector…']); // observed
  await open(page, url, '#/worktrees');
  expect(await page.locator('.m').nth(4).innerText()).toBe('—\nCI on main');
});

test('#35 history tab loads, then lists commits', async ({ page }) => {
  const url = await shared('live2');
  const w = await open(page, url, '#/arch/system/script%3Alane');
  const before = w.requests.length;
  await page.click('[data-itab=history]'); await quiet(page, w);
  expect(nonEventRequests({ requests: w.requests.slice(before) })).toEqual(['GET /api/history']);
  expect(await page.locator('.hist > div').count()).toBeGreaterThan(0);
  expect(await text(page, '.insp p.muted:last-of-type')).toBe('From git log -- kit/scripts/lane.js');
});

// ---------------------------------------------------------------------------------------------------- 80c favicon
test('#80c no favicon link; /favicon.ico is the server 404', async ({ page }) => {
  const url = await shared('live2');
  await open(page, url, '');
  expect(await page.locator('link').count()).toBe(0);
  // observed on the original: 404, application/json, {"error": "not found"} (server.js:498)
  expect(await page.evaluate(() => fetch('/favicon.ico').then(async (r) => `${r.status} ${r.headers.get('content-type')} ${await r.text()}`))).toBe('404 application/json {"error": "not found"}');
});

// ---------------------------------------------------------------------------------------------------- 78 deviation
test('#78 keyboard focus survives a stream event (intentional deviation D1)', async ({ page }) => {
  test.fail(TARGET === 'original', 'intentional deviation D1: the original loses focus');
  const events = path.join(WT_REFUND, 'docs', 'specs', 'refund-route.events.jsonl');
  await restoring([events], () => own(page, 'live2', async (url) => {
    await open(page, url, '#/arch/agents'); // the agents view re-renders on every event (index.html:731)
    await page.focus('.ac[data-node="agent:planner"]');
    hookEvent({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: path.join(WT_REFUND, 'README.md') }, tool_response: { content: 'x' }, cwd: WT_REFUND });
    await page.waitForTimeout(3000); // the server polls files every 1 s; one event must have been rendered
    expect(await page.evaluate(() => document.activeElement && document.activeElement.dataset.node)).toBe('agent:planner');
  }));
});

// ---------------------------------------------------------------------------------------------------- 61 accessibility
const A11Y = path.join(HERE, 'a11y-original.json');
const A11Y_STATES = [
  ['arch-system', 'live2', '#/arch/system'],
  ['arch-system-sel', 'live2', '#/arch/system/agent%3Aimplementer'],
  ['arch-agents', 'live2', '#/arch/agents'],
  ['arch-deps-sel', 'live2', '#/arch/deps/script%3Alane'],
  ['wt-lane', 'live2', '#/worktrees', async (p) => p.click('.mk[data-lane=refund-route]')],
  ['pages-wt', 'pages', ''],
];
test('#61 axe: no violation id or count beyond the original', async ({ page }) => {
  allow(page, { status: [/\/api\/status$/] }); // the pages-wt state probes the live API (index.html:715)
  const found = {};
  for (const [name, scenario, h, act] of A11Y_STATES) {
    const w = await open(page, await shared(scenario), h);
    if (act) { await act(page); await quiet(page, w); }
    const r = await new AxeBuilder({ page }).analyze();
    found[name] = Object.fromEntries(r.violations.map((v) => [v.id, v.nodes.length]).sort());
  }
  // recorded once from the original; later original runs must reproduce it exactly, and it is never rewritten
  if (TARGET === 'original' && !fs.existsSync(A11Y)) fs.writeFileSync(A11Y, JSON.stringify(found, null, 2) + '\n');
  const base = JSON.parse(fs.readFileSync(A11Y, 'utf8'));
  if (TARGET === 'original') expect(found).toEqual(base);
  for (const [name, ids] of Object.entries(found)) {
    for (const [id, n] of Object.entries(ids)) expect(n, `${name}: ${id}`).toBeLessThanOrEqual(base[name]?.[id] ?? 0);
  }
});
