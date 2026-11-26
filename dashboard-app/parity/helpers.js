// Shared by capture.spec.js and interactions.spec.js. Nothing here changes the page under test.
import { NOW } from './serve.js';

export const TARGET = process.env.PARITY_TARGET ?? 'original';
export const WIDTHS = [375, 768, 1024, 1440, 1920];
export const HEIGHT = 900;
export { NOW }; // the browser's frozen clock and the server's starting one (serve.js)
export const TZ = 'America/Los_Angeles'; // the fixture's event timestamps are local time without an offset

/**
 * Record every request and console message of a page. `pending` excludes /api/stream, the one request that never ends.
 * Returns {requests, console, pending: Set}.
 */
export function watch(page) {
  const w = { requests: [], console: [], pageErrors: [], pending: new Set() };
  const isStream = (r) => r.url().endsWith('/api/stream');
  page.on('request', (r) => { w.requests.push(`${r.method()} ${new URL(r.url()).pathname}`); if (!isStream(r)) w.pending.add(r); });
  page.on('requestfinished', (r) => w.pending.delete(r));
  page.on('requestfailed', (r) => w.pending.delete(r));
  page.on('response', (r) => { const u = new URL(r.url()); w.requests.push(`  → ${r.status()} ${u.pathname}`); });
  page.on('console', (m) => w.console.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => w.pageErrors.push(String(e)));
  return w;
}

/**
 * "Network idle" for a page that holds an EventSource open: no request other than /api/stream in flight for `ms`.
 * Playwright's own 'networkidle' never settles while the stream is open, so it cannot be used here.
 */
export async function quiet(page, w, ms = 500, timeout = 15000) {
  const end = Date.now() + timeout;
  let since = Date.now();
  while (Date.now() < end) {
    if (w.pending.size) since = Date.now();
    else if (Date.now() - since >= ms) {
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      return;
    }
    await page.waitForTimeout(50);
  }
  throw new Error(`network not quiet after ${timeout} ms: ${[...w.pending].map((r) => r.url()).join(', ')}`);
}

/** Open `hash` on a server with a frozen clock and wait until it is quiet. */
export async function open(page, base, hash = '', { width = 1440 } = {}) {
  await page.setViewportSize({ width, height: HEIGHT });
  await page.clock.setFixedTime(NOW);
  // about:blank first: goto() to the same URL with the same #hash is a fragment navigation in Chrome, not a load,
  // so every capture would inherit the previous one's state
  await page.goto('about:blank');
  const w = watch(page);
  await page.goto(base + hash);
  await quiet(page, w);
  return w;
}

/**
 * The normalised DOM (register 80b). Rules, and nothing else:
 *  1. Elements: tag name lower-case; attributes sorted by name; values verbatim, except
 *     a. `class`: tokens split on whitespace and sorted (token order and spacing do not reach the screen or selectors);
 *     b. `style`: the browser's own serialisation of the declarations (element.style.cssText), which fixes spacing and
 *        the trailing semicolon but keeps every property and value.
 *  2. Text: whitespace runs collapsed to one space; text nodes that are only whitespace are dropped. Rendered whitespace
 *     (register #65) is checked separately by `renderedText` (innerText is layout-aware) and by the screenshots.
 *  3. Comments dropped. <script> and <style> contents replaced by their length (the React build inlines a bundle).
 *  4. Live state that is not markup is appended as pseudo-attributes: `:value` for input/select, `:disabled`.
 * Output: one line per node, indented by depth.
 */
export async function normalizedDom(page, selector = 'body') {
  return page.evaluate((sel) => {
    const out = [];
    const walk = (n, d) => {
      const pad = '  '.repeat(d);
      if (n.nodeType === 3) {
        const t = n.textContent.replace(/\s+/g, ' ');
        if (t.trim()) out.push(pad + JSON.stringify(t));
        return;
      }
      if (n.nodeType !== 1) return;
      const tag = n.tagName.toLowerCase();
      const attrs = [...n.attributes].map((a) => {
        let v = a.value;
        if (a.name === 'class') v = v.split(/\s+/).filter(Boolean).sort().join(' ');
        if (a.name === 'style') v = n.style.cssText;
        return [a.name, v];
      }).sort((a, b) => (a[0] < b[0] ? -1 : 1));
      if (tag === 'input' || tag === 'select') attrs.push([':value', n.value]);
      if ('disabled' in n && n.disabled) attrs.push([':disabled', 'true']);
      out.push(`${pad}<${tag}${attrs.map(([k, v]) => ` ${k}=${JSON.stringify(v)}`).join('')}>`);
      if (tag === 'script' || tag === 'style') { out.push(`${pad}  #${n.textContent.length} chars`); return; }
      for (const c of n.childNodes) walk(c, d + 1);
    };
    const root = document.querySelector(sel);
    if (!root) return `(no ${sel})`;
    walk(root, 0);
    return out.join('\n');
  }, selector);
}

/** innerText of the visible screen: what a reader sees, including rendered whitespace between inline elements. */
export async function renderedText(page) {
  return page.evaluate(() => document.body.innerText);
}

/** Every computed property of the first element matching each selector (register #9–#21, #76). */
export const STYLE_PROBES = [
  'html', 'body', '.top', '.brand', '.tab[aria-selected=true]', '.tab[aria-selected=false]', '#projectSel', '.livepill', '.dot', '#refresh',
  '#arch', '.side', '.side h3', '.vi[aria-current=true]', '.vi:not([aria-current])', '.lg', '.sw.next', '.proj', '.stagearea', '.sh h2', '.sh p',
  '.vp', '.insp', '.insp h2', '.big div', '.big b', '.kv', '.kv>span:nth-child(1)', '.kv>span:nth-child(2)', '.itab[aria-selected=true]', '.itab[aria-selected=false]',
  '.node rect.box', '.node text', '.node text.k', '.edge', '.band', '.ac', '.chip', '.hk', '.stg', '.arrow', '.feed div', '.vio', '.listbox', '.li', '.depwrap .item', '.depwrap .core',
  '#worktrees', '#worktrees main', '.card', '.lbl', '.pill', '.row', '.row:last-child', '.pipe', '.stage', '.stage .mk', '.grid', '.m', '.ev', 'table', 'td', 'th', '.crumbs a', '.hist div',
  '#root',
];

export async function computedStyles(page) {
  return page.evaluate((sels) => {
    const out = {};
    for (const s of sels) {
      const el = document.querySelector(s);
      if (!el) continue;
      const cs = getComputedStyle(el);
      const props = {};
      for (let i = 0; i < cs.length; i++) props[cs[i]] = cs.getPropertyValue(cs[i]);
      const r = el.getBoundingClientRect();
      props[':rect'] = `${r.x},${r.y},${r.width},${r.height}`;
      out[s] = props;
    }
    return out;
  }, STYLE_PROBES);
}
