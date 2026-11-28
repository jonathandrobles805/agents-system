// The Board tab (hardening plan Step 10, "A Runs view"). One card per ROADMAP row, in columns by stage group.
//
// Where each fact comes from is shown on it: data-src="host" for what the kit computed from files, git and the store
// (/api/status, /api/architecture, /api/workflows), data-src="lane" for what a lane's own events reported (which agent
// is running). Nothing here is computed from what an agent says about itself, except the events, which are marked.
import { useEffect, useState, type KeyboardEvent } from 'react';
import { boardOpen, overlayOf, projectOf, useSection, type Snap } from './store';
import type { KitEvent, Lane, Workflows } from './types';
import { Drawer } from './Drawer';

/** The columns, in order, and the stage names each holds (stage names as lane.js next-step and kit/workflows use them). */
export const GROUPS: [string, string[]][] = [
  ['Research', ['start', 'research']],
  ['Plan', ['plan', 'reproduce', 'scope']],
  ['Approve', ['approve', 'you']],
  ['Build', ['lane', 'test', 'build']],
  ['Review', ['review']],
  ['Merge', ['wait-merge', 'you']],
  ['Needs you', ['parked', 'needs_you', 'stopped']],
  ['Done', ['retro', 'done']],
];
const columnOf = (stage: string | null) => (stage === null ? null : GROUPS.find(([, st]) => st.includes(stage))?.[0] ?? null);

/**
 * The board stage of a lane: the stage lane.js next-step answers (from /api/architecture), except a lane the store
 * holds parked, which next-step reports as 'escalated': it is 'parked' here, so it sits under Needs you.
 */
function boardStage(l: Lane, next: string | null | undefined): string | null {
  if (l.stage === 'parked') return 'parked';
  return next ?? null;
}

/** The agents of a column's stages, from every route, each with its model from kit/agents/*.md (via the map). */
function columnAgents(stages: string[], wf: Workflows | null, s: Snap): string[] {
  if (!wf) return [];
  const names = new Set<string>();
  for (const w of Object.values(wf)) for (const st of stages) if (w.agents[st]) names.add(w.agents[st]);
  return [...names].sort().map((a) => {
    const n = s.arch?.manifest.nodes.find((x) => x.id === `agent:${a}`);
    return n ? `${a} · ${n.attrs.model || 'no model'}` : `${a} · no agent file`;
  });
}

/** Agents running in a lane, from its events: a subagent_start whose agent_id has no subagent_stop yet. */
export function running(feed: KitEvent[], slug: string): { id: string; type: string }[] {
  const open = new Map<string, string>();
  for (const e of feed) {
    if (e.lane !== slug || !e.agent_id) continue;
    if (e.event === 'subagent_start') open.set(e.agent_id, e.agent_type || e.agent || 'agent');
    else if (e.event === 'subagent_stop') open.delete(e.agent_id);
  }
  return [...open].map(([id, type]) => ({ id, type }));
}

/**
 * The review reports of a round, one chip each. Today a lane has at most one report, for its current round
 * (/api/status rounds_detail); reports added later reach the board through this one function.
 */
export function reviewReports(r: { review: { verdict: string | null } | null }): { name: string; verdict: string | null }[] {
  return r.review ? [{ name: 'review', verdict: r.review.verdict }] : [];
}

const tone = (v: string | null | undefined) => (v === 'PASS' || v === 'pass' ? 'ok' : v === 'FAIL' || v === 'fail' ? 'bad' : v === 'pending' || v === 'stale' ? 'you-p' : 'neutral');
const Fact = ({ src, cls, children, title }: { src: 'host' | 'lane'; cls: string; children: React.ReactNode; title?: string }) => (
  <span className={`bfact ${cls}`} data-src={src} title={title ?? (src === 'host' ? 'host: computed by the kit from files, git and the store' : 'reported by the lane: from its events')}>{children}</span>
);

export function costText(l: Lane): string | null {
  if (!l.worktree) return null;
  if (!l.cost) return 'cost hidden';
  if (l.cost.usd === null || l.cost.usd === undefined) return 'no telemetry';
  return `$${l.cost.usd.toFixed(2)}`;
}

function Card({ l, run, onOpen }: { l: Lane; run: { id: string; type: string }[]; onOpen: () => void }) {
  const yourCall = l.needs_you || l.stage === 'parked';
  const cost = costText(l);
  const key = (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); onOpen(); } };
  return (
    <div className="bcard" data-lane={l.slug} tabIndex={0} role="button" aria-label={`${l.slug}: open its files`} onClick={onOpen} onKeyDown={key}>
      <div className="bline">
        {run.length ? <Fact src="lane" cls="brun"><span className="bpulse" aria-hidden="true"></span>{run.map((r) => `${r.type} ${r.id.slice(0, 6)}`).join(', ')}</Fact> : null}
        <Fact src="host" cls="bslug">{l.slug}</Fact>
        {yourCall ? <Fact src="host" cls="bflag">your call</Fact> : null}
      </div>
      <Fact src="host" cls="btitle">{l.feature}</Fact>
      {l.pr ? <div className="bline"><Fact src="host" cls="bpr"><a href={l.pr} target="_blank" rel="noopener" onClick={(e) => e.stopPropagation()}>PR</a></Fact></div> : null}
      {(l.rounds_detail ?? []).map((r) => (
        <div className="bround" key={r.round}>
          <span className="bfact" data-src="host">{`Round ${r.round}`}</span>
          {r.gates.length ? r.gates.map((g, i) => <Fact src="host" cls={`chip ${tone(g.verdict)}`} key={`g${i}`} title={`gate ${g.verdict ?? '—'} on ${(g.commit ?? '').slice(0, 7)}`}>{`gate ${g.verdict ?? '—'}`}</Fact>) : <Fact src="host" cls="chip neutral">no gate</Fact>}
          {reviewReports(r).map((v) => <Fact src="host" cls={`chip ${tone(v.verdict)}`} key={v.name}>{`${v.name} ${v.verdict ?? '—'}`}</Fact>)}
        </div>
      ))}
      <div className="bline bmeta">
        {l.risk ? <Fact src="host" cls="brisk">{l.risk}</Fact> : null}
        {cost ? <Fact src="host" cls="bcost">{cost}</Fact> : null}
        {l.elapsed_hours == null ? null : <Fact src="host" cls="belapsed">{`${l.elapsed_hours.toFixed(1)}h`}</Fact>}
        {l.ci ? <Fact src="host" cls={`bci chip ${tone(l.ci.state)}`}>{`CI ${l.ci.state}`}</Fact> : null}
      </div>
    </div>
  );
}

const hhmmss = (t: number) => new Date(t).toTimeString().slice(0, 8);

function Header({ s }: { s: Snap }) {
  const [now, setNow] = useState(() => Date.now());
  // the only timer on the page, and only while the Board is shown: it greys the dot 5 s after the last update
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const stale = !s.lastUpdate || now - s.lastUpdate > 5000;
  const cls = s.streamError ? 'dot bad' : stale ? 'dot' : 'dot on';
  return (
    <div className="bhead">
      <span className={cls}></span>
      {s.streamError ? <span className="berr">{s.streamError}</span> : <span className="btime">{s.lastUpdate ? `updated ${hhmmss(s.lastUpdate)}` : 'no update yet'}</span>}
      <span className="grow"></span>
      <span className="muted blegend"><span className="bfact" data-src="host">host</span> computed by the kit · <span className="bfact" data-src="lane">lane</span> reported by the lane</span>
    </div>
  );
}

export function Board() {
  const s = useSection('board');
  const c = useSection('chrome');
  if (c.n === 0 || c.tab !== 'board') return null;
  const p = projectOf(s);
  if (!s.live || !p) return <div id="board"><main className="bmain"><div className="empty">The board needs the live server: node ~/.claude/kit/dashboard/server.js --repo .</div></main></div>;
  const lanes = p.lanes ?? [];
  const next = new Map((overlayOf(s)?.lanes ?? []).map((l) => [l.slug, l.stage ?? null]));
  const placed = lanes.map((l) => ({ l, stage: boardStage(l, next.get(l.slug)), run: running(s.feed, l.slug) }));
  const routeStages = new Set(Object.values(s.workflows ?? {}).flatMap((w) => w.stages));
  const unmappedStages = [...routeStages].filter((st) => !columnOf(st)).sort();
  const unplaced = placed.filter((x) => !columnOf(x.stage));
  const nRunning = placed.filter((x) => x.run.length).length;
  const costs = lanes.map(costText).filter((x) => x !== null);
  const usd = lanes.reduce((n, l) => n + (l.cost?.usd ?? 0), 0);
  const costFoot = costs.length && costs.every((x) => x === 'cost hidden') ? 'cost hidden' : `$${usd.toFixed(2)}`;
  const sel = s.boardSel ? placed.find((x) => x.l.slug === s.boardSel) : undefined;
  return (
    <div id="board">
      <main className="bmain">
        <Header s={s} />
        {unmappedStages.length || unplaced.length ? (
          <div className="bbanner" role="status">
            {unmappedStages.length ? <div>{`Stages with no column on this board: ${unmappedStages.join(', ')}`}</div> : null}
            {unplaced.map((x) => (
              <div key={x.l.slug} className="bline">{`${x.l.slug} is at stage ${x.stage ?? 'unknown'}, which no column holds:`}<Card l={x.l} run={x.run} onOpen={() => boardOpen(x.l.slug)} /></div>
            ))}
          </div>
        ) : null}
        <div className="bcols">
          {GROUPS.map(([name, stages]) => {
            const here = placed.filter((x) => columnOf(x.stage) === name);
            return (
              <section className="bcol" data-col={name} key={name} aria-label={name}>
                <div className="bcol-h"><span className="bname">{name}</span><span className="bcount">{here.length}</span></div>
                <div className="bagents">{columnAgents(stages, s.workflows, s).map((a) => <div key={a}>{a}</div>)}</div>
                {here.map((x) => <Card key={x.l.slug} l={x.l} run={x.run} onOpen={() => boardOpen(x.l.slug)} />)}
              </section>
            );
          })}
        </div>
        <div className="bfoot">{`${nRunning} running · ${costFoot}`}</div>
      </main>
      {sel ? <Drawer s={s} l={sel.l} stage={sel.stage} /> : null}
    </div>
  );
}
