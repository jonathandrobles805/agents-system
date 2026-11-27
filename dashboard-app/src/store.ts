// The page's state and behaviour, ported from kit/dashboard/index.html:218-738.
//
// The original keeps one mutable object S and redraws a part of the page with innerHTML when it calls renderChrome,
// renderSide, renderInspector, renderArch or renderWorktrees. Which part is redrawn, and when, is behaviour: an event
// on the System view, for example, does not redraw it (index.html:731). So the port keeps S and the same render calls,
// and each call publishes a snapshot of S for one section. A section's component renders only from its snapshot, so it
// changes exactly when the original's section would. Snapshots are taken when the render is called, like innerHTML.
import { useSyncExternalStore } from 'react';
import type { Arch, Commit, Index, KitEvent, Model, NodeState, Overlay, Project } from './types';

export const esc = (v: unknown) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

export const VIEWS: [string, string][] = [
  ['system', 'System architecture'],
  ['agents', 'Agent organization'],
  ['pipeline', 'Execution pipeline'],
  ['deps', 'Dependencies'],
  ['activity', 'Live activity'],
];

interface State {
  live: boolean; V: Model | null; tab: string; view: string; selected: string | null; itab: string; blast: boolean;
  status: Project[]; root: string | null;
  arch: Arch | null; idx: Index | null;
  feed: KitEvent[]; lastEventAt: Record<string, number>; history: Map<string, Commit[] | null>; query: string; kind: string;
  laneSel: string | null; laneEvents: KitEvent[];
  groupOpen: string | null;
  updated: number;
}

export const S: State = {
  live: false, V: null, tab: 'arch', view: 'system', selected: null, itab: 'overview', blast: false,
  status: [], root: null,
  arch: null, idx: null,
  feed: [], lastEventAt: {}, history: new Map(), query: '', kind: '',
  laneSel: null, laneEvents: [],
  groupOpen: null,
  updated: 0,
};

// ------------------------------------------------------------------------------------------------ snapshots
/** A frozen copy of what a section may read, taken when the original would have redrawn that section. */
export interface Snap {
  n: number; // how many times this section was drawn; 0 = the static shell, before start() renders
  now: number; // Date.now() at the time of the draw (states() reads the clock, index.html:284)
  live: boolean; V: Model | null; tab: string; view: string; selected: string | null; itab: string; blast: boolean;
  status: Project[]; root: string | null; arch: Arch | null; idx: Index | null;
  feed: KitEvent[]; lastEventAt: Record<string, number>; history: Map<string, Commit[] | null>; query: string; kind: string;
  laneSel: string | null; laneEvents: KitEvent[]; groupOpen: string | null;
  // section-specific
  dot?: { cls: string; text: string };
  insp?: 'blank' | 'full';
  title?: string; sub?: string; body?: 'static' | 'reading' | 'view';
}

type Section = 'chrome' | 'dot' | 'side' | 'view' | 'inspector' | 'worktrees';
const snaps: Record<Section, Snap> = {} as Record<Section, Snap>;
const listeners = new Set<() => void>();

function take(n: number, extra: Partial<Snap> = {}): Snap {
  return {
    n, now: Date.now(),
    live: S.live, V: S.V, tab: S.tab, view: S.view, selected: S.selected, itab: S.itab, blast: S.blast,
    status: S.status, root: S.root, arch: S.arch, idx: S.idx,
    feed: S.feed.slice(), lastEventAt: { ...S.lastEventAt }, history: new Map(S.history), query: S.query, kind: S.kind,
    laneSel: S.laneSel, laneEvents: S.laneEvents.slice(), groupOpen: S.groupOpen,
    ...extra,
  };
}
for (const s of ['chrome', 'dot', 'side', 'view', 'inspector', 'worktrees'] as Section[]) snaps[s] = take(0, s === 'dot' ? { dot: { cls: 'dot', text: 'STATIC' } } : {});

function publish(section: Section, extra: Partial<Snap> = {}) {
  snaps[section] = take(snaps[section].n + 1, extra);
  for (const l of listeners) l();
}
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export function useSection(section: Section): Snap {
  return useSyncExternalStore(subscribe, () => snaps[section]);
}

// ------------------------------------------------------------------------------------------------ derived (index.html:282-284)
export const projectOf = (s: Snap | State) => s.status.find((p) => p.root === s.root) || null;
export const overlayOf = (s: Snap | State): Overlay | null => (s.arch ? s.arch.projects.find((p) => p.root === s.root) || null : null);
export const statesOf = (s: Snap): Map<string, NodeState> =>
  (s.arch && s.V && s.idx ? s.V.nodeStates(s.arch.manifest, s.idx, { git: s.arch.git, overlay: overlayOf(s), lastEventAt: s.lastEventAt, now: s.now }) : new Map());

// ------------------------------------------------------------------------------------------------ data (index.html:243-280)
async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json() as Promise<T>;
}

async function loadStatus(): Promise<boolean> {
  let data: Project | Project[] | null = null;
  try { data = await getJson<Project | Project[]>(S.live ? '/api/status' : 'status.json'); } catch { /* static mode without a file */ }
  if (!data) { S.status = []; return false; }
  S.status = Array.isArray(data) ? data : [data];
  if (!S.status.find((p) => p.root === S.root)) S.root = S.status[0] ? S.status[0].root : null;
  return true;
}

async function loadArch() {
  if (!S.live || !S.V) return;
  S.arch = await getJson<Arch>('/api/architecture');
  S.idx = S.V.index(S.arch.manifest);
  S.updated = Date.now();
  if (S.selected && !S.idx.byId.has(S.selected)) S.selected = null;
  await seedEvents();
}

async function seedEvents() {
  const o = overlayOf(S);
  if (!o) return;
  const merged: KitEvent[] = [];
  for (const lane of o.lanes) {
    try {
      const evs = await getJson<KitEvent[]>(`/api/events/${encodeURIComponent(lane.slug)}?project=${encodeURIComponent(S.root ?? '')}`);
      for (const e of evs.slice(-60)) merged.push({ ...e, lane: lane.slug });
      const last = evs[evs.length - 1];
      if (last && last.ts) S.lastEventAt[lane.slug] = Date.parse(last.ts) || 0;
    } catch { /* lane without an event log */ }
  }
  S.feed = merged.sort((a, b) => ((a.ts ?? '') < (b.ts ?? '') ? -1 : 1)).slice(-200);
}

// ------------------------------------------------------------------------------------------------ routing (index.html:287-300)
function parseHash() {
  const [, tab, view, id] = location.hash.split('/');
  return { tab: tab === 'worktrees' ? 'worktrees' : 'arch', view: VIEWS.some((v) => v[0] === view) ? view : 'system', id: id ? decodeURIComponent(id) : null };
}
function go({ tab = S.tab, view = S.view, id = S.selected }: { tab?: string; view?: string; id?: string | null } = {}) {
  const h = tab === 'worktrees' ? '#/worktrees' : `#/arch/${view}${id ? '/' + encodeURIComponent(id) : ''}`;
  if (location.hash === h) render(); else location.hash = h;
}
export function onHashChange() {
  const r = parseHash();
  S.tab = r.tab; S.view = r.view;
  S.selected = r.id && S.idx && S.idx.byId.has(r.id) ? r.id : (r.id && !S.idx ? r.id : null);
  render();
}

// ------------------------------------------------------------------------------------------------ the render calls
function renderChrome() {
  publish('chrome');
  publish('dot', { dot: { cls: 'dot' + (S.live ? ' on' : ''), text: S.live ? 'LIVE' : 'STATIC' } });
}

/** index.html:356-471 set #vtitle / #vsub as a side effect of building a view; the same text, computed here. */
function viewTitle(): { title: string; sub: string } {
  const V = S.V!, m = S.arch!.manifest;
  const name = (projectOf(S) || { project: '' }).project;
  switch (S.view) {
    case 'system': {
      const shown = V.layoutBands(m, 1080).bands.reduce((n, b) => n + b.nodes.length, 0);
      return { title: 'System architecture', sub: `${shown} of ${m.nodes.length} components shown · orchestration, agents, gates, core scripts and CI · click a component to draw who spawns, guards or needs it` };
    }
    case 'agents':
      return { title: 'Agent organization', sub: `${V.orderedNodes(m, 'agent').length} agents, each with its own tools and guards · purposes are declared in kit/manifest.json, tools and hooks are read from the agent files` };
    case 'pipeline':
      return { title: 'Execution pipeline', sub: `${V.pipelineView(m, overlayOf(S)).length} stages · the stage after each is answered by lane.js next-step from files and git, never by an agent · green: a lane of ${esc(name || 'this project')} stands here` };
    case 'deps':
      return { title: 'Dependencies', sub: 'Pick a component: what it depends on on the left, what breaks if it changes on the right (amber), and which tests and CI jobs run' };
    default:
      return { title: 'Live activity', sub: `${S.live ? 'streaming' : 'not streaming'} · events written by hooks for ${esc(name || 'the selected project')} · violations come from the map, drift from this project's settings` };
  }
}

let lastTitle = { title: '', sub: '' };
function renderInspector() {
  publish('inspector', { insp: 'full' });
  // index.html:521: the History tab asks for the history while it draws
  const n = S.arch && S.selected && S.idx ? S.idx.byId.get(S.selected) : null;
  if (n && S.itab === 'history' && S.history.get(n.id) === undefined) void loadHistory(n.id);
}
function renderArch() {
  publish('side');
  if (!S.live || !S.V) {
    lastTitle = { title: 'Architecture Canvas', sub: '' };
    publish('view', { body: 'static', ...lastTitle });
    publish('inspector', { insp: 'blank' });
    return;
  }
  if (!S.arch) { publish('view', { body: 'reading', ...lastTitle }); return; }
  lastTitle = viewTitle();
  publish('view', { body: 'view', ...lastTitle });
  renderInspector();
}
function renderWorktrees() { publish('worktrees'); }
function render() {
  renderChrome();
  if (S.tab === 'arch') renderArch(); else renderWorktrees();
}

async function loadHistory(id: string) {
  try {
    const r = await getJson<{ commits: Commit[] }>(`/api/history?id=${encodeURIComponent(id)}`);
    S.history.set(id, r.commits);
  } catch { S.history.set(id, null); }
  if (S.selected === id && S.itab === 'history') renderInspector();
}

// ------------------------------------------------------------------------------------------------ actions (index.html:657-707)
export function clickView(view: string) { go({ view }); }
export function clickNode(id: string) {
  const same = S.selected === id;
  S.selected = id;
  if (!same) { S.itab = 'overview'; S.groupOpen = null; }
  go({ id: S.selected });
}
export function clickItab(t: string) { S.itab = t; renderInspector(); }
export function clickGroup(kind: string) {
  S.groupOpen = S.groupOpen === kind && S.view === 'deps' ? null : kind;
  if (S.view === 'deps') renderArch(); else go({ view: 'deps' });
}
export function clickBlast() { S.blast = !S.blast; renderArch(); }
export function inputQuery(value: string) { S.query = value; renderArch(); }
export function changeKind(value: string) { S.kind = value; renderArch(); }
export function changeProject(root: string) {
  S.root = root; S.laneSel = null; S.laneEvents = []; S.feed = [];
  void seedEvents().then(render);
  render();
}
export function clickTab(tab: string) { go({ tab }); }
export async function refresh() { await loadStatus(); await loadArch(); render(); }

export function wtProject(root: string) { S.root = root; S.laneSel = null; S.laneEvents = []; renderWorktrees(); }
export function wtBack() { S.laneSel = null; S.root = null; renderWorktrees(); }
export function wtClose() { S.laneSel = null; S.laneEvents = []; renderWorktrees(); }
export async function wtSelectLane(slug: string) {
  S.laneSel = slug; S.laneEvents = [];
  renderWorktrees();
  if (S.live) {
    try { S.laneEvents = await getJson<KitEvent[]>(`/api/events/${encodeURIComponent(slug)}?project=${encodeURIComponent(S.root ?? '')}`); } catch { /* ignore */ }
    renderWorktrees();
  }
}
/** index.html:662-666; returns the button's text after the request. */
export async function wtOpen(slug: string): Promise<string> {
  try {
    const r = await fetch(`/api/open/${encodeURIComponent(slug)}?project=${encodeURIComponent(S.root ?? '')}`, { method: 'POST' });
    const j = await r.json() as { ok?: boolean; error?: string };
    return j.ok ? 'Opened in a terminal' : ('Could not open: ' + (j.error || ''));
  } catch { return 'Could not open'; }
}

// ------------------------------------------------------------------------------------------------ start (index.html:710-737)
declare global { interface Window { __kitModel?: Promise<Model | null> } }
let started = false;
let es: EventSource | null = null;
export async function start() {
  if (started) return;
  started = true;
  S.V = (await window.__kitModel) ?? null;
  const r = parseHash();
  S.tab = r.tab; S.view = r.view; S.selected = r.id;
  if (location.protocol.startsWith('http')) {
    try { await getJson('/api/status'); S.live = true; } catch { S.live = false; }
  }
  await loadStatus();
  if (!S.live && !location.hash) S.tab = 'worktrees';
  try { await loadArch(); } catch { S.arch = null; }
  if (S.selected && S.idx && !S.idx.byId.has(S.selected)) S.selected = null;
  render();
  if (S.live && 'EventSource' in window) {
    es = new EventSource('/api/stream');
    es.onmessage = async (m) => {
      let msg: { type: string; data: unknown; root?: string; lane: string };
      try { msg = JSON.parse(m.data); } catch { return; }
      if (msg.type === 'status') { S.status = Array.isArray(msg.data) ? msg.data as Project[] : [msg.data as Project]; if (S.tab === 'worktrees' || S.arch) { try { await loadArch(); } catch { /* keep the last map */ } } render(); }
      if (msg.type === 'architecture') { try { await loadArch(); } catch { /* keep the last map */ } render(); }
      if (msg.type === 'event') {
        if (msg.root === S.root) { S.feed.push({ ...(msg.data as KitEvent), lane: msg.lane }); S.feed = S.feed.slice(-200); S.lastEventAt[msg.lane] = Date.now(); }
        if (S.laneSel && msg.lane === S.laneSel && msg.root === S.root) S.laneEvents.push(msg.data as KitEvent);
        if (S.tab === 'worktrees' && S.laneSel) renderWorktrees(); else if (S.tab === 'arch' && ['activity', 'agents', 'pipeline'].includes(S.view)) renderArch();
      }
    };
    es.onerror = () => { publish('dot', { dot: { cls: 'dot warn', text: 'RECONNECTING' } }); };
    es.onopen = () => { publish('dot', { dot: { cls: 'dot on', text: 'LIVE' } }); };
  }
}
