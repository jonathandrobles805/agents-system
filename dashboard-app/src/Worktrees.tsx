// The Worktrees screen (kit/dashboard/index.html:559-676). Text that the original builds as one string inside one
// element is built as one string here too, so the DOM has the same text nodes; whitespace between inline elements
// that the original's template puts on the screen is written as {' '} (register #65).
import { useState, type MouseEvent } from 'react';
import { projectOf, useSection, wtBack, wtClose, wtOpen, wtProject, wtSelectLane, type Snap } from './store';
import type { Lane, Project } from './types';

const STAGES = [
  { id: 'research', label: 'Research', match: ['researching'] },
  { id: 'plan', label: 'Plan', match: ['planning'] },
  { id: 'approve', label: 'You approve', cls: 'you', match: ['waiting-approval'] },
  { id: 'build', label: 'Build', match: ['approved', 'building', 'escalated'] },
  { id: 'review', label: 'Review + CI', cls: 'gate', match: ['in-review'] },
  { id: 'merge', label: 'You merge', cls: 'you', match: ['ready-to-merge'] },
];
const POS_CLASS: Record<string, string> = { 'waiting-approval': 'you-p', 'ready-to-merge': 'you-p', escalated: 'bad', building: 'agent', 'in-review': 'gate', merged: 'ok', approved: 'agent', researching: 'agent', planning: 'agent', queued: 'neutral' };

const Pill = ({ txt, cls }: { txt: string; cls: string }) => <span className={`pill ${cls}`}>{txt}</span>;

/** index.html:660: a lane click does not reach the elements around it. */
const laneClick = (slug: string) => (e: MouseEvent) => { e.stopPropagation(); void wtSelectLane(slug); };

function Index({ s }: { s: Snap }) {
  return (
    <div className="card"><div className="lbl">All projects · click one</div>{s.status.map((p) => {
      const ci = p.ci_main ? (p.ci_main.conclusion || p.ci_main.status) : null;
      return (
        <div className="row" data-project={p.root} key={p.root} onClick={() => wtProject(p.root)}><span className="name">{p.project}</span><span>
          {' '}{p.needs_you.length ? <Pill txt={`${p.needs_you.length} waiting on you`} cls="you-p" /> : <Pill txt="0 waiting" cls="ok" />}
          {' '}<Pill txt={`${p.wip.in_flight} / ${p.wip.limit} lanes`} cls="agent" />
          {' '}{ci ? <Pill txt={`CI ${ci}`} cls={ci === 'success' ? 'ok' : 'bad'} /> : null}
          {' '}{p.debt.text_only_lessons ? <Pill txt={`${p.debt.text_only_lessons} debt`} cls="neutral" /> : null}</span></div>
      );
    })}</div>
  );
}

/** index.html:662-666. Redrawing the screen gives a fresh button, so it is keyed by the snapshot. */
function OpenButton({ slug }: { slug: string }) {
  const [state, setState] = useState({ disabled: false, text: 'Open Claude in this worktree ↗' });
  const click = async () => {
    setState({ disabled: true, text: 'Opening…' });
    const text = await wtOpen(slug);
    setState({ disabled: true, text });
  };
  return <button data-open={slug} disabled={state.disabled} onClick={() => { void click(); }}>{state.text}</button>;
}

function LaneCard({ s, l }: { s: Snap; l: Lane }) {
  const pr = l.progress, rv = l.review, ev = l.events;
  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <div><div className="lbl" style={{ margin: 0 }}>{`Lane · ${l.branch || l.slug} · ${l.position}${l.stage ? ' · stage ' + l.stage : ''}`}</div><div style={{ fontSize: 15, fontWeight: 500 }}>{l.feature}</div></div>
        <div style={{ display: 'flex', gap: 8 }}>{s.live && l.worktree ? <OpenButton key={s.n} slug={l.slug} /> : null}{l.pr ? <a href={l.pr} target="_blank" rel="noopener"><button>PR</button></a> : null}<button data-close="" onClick={wtClose}>Close</button></div></div>
      <div className="grid">
        <div className="m"><div className="n">{pr.criteria ? `${pr.green} / ${pr.criteria}` : '—'}</div><div className="t">criteria green</div></div>
        <div className="m"><div className="n">{l.worktree ? l.behind_base : '—'}</div><div className="t">commits behind base</div></div>
        <div className="m"><div className="n">{ev.blocked}</div><div className="t">edits blocked by hooks</div></div>
        <div className="m"><div className="n">{`${ev.tests_green} `}<span className="muted">{`/ ${ev.tests_red} red`}</span></div><div className="t">test runs</div></div>
        <div className="m"><div className="n">{ev.stop_refused}</div><div className="t">stop refused</div></div>
      </div>
      <table>
        <tbody>
          <tr><td style={{ width: 150 }}>Spec</td><td>{`${l.spec || '—'} `}{l.approved ? <Pill txt="approved" cls="ok" /> : <Pill txt="not approved" cls="you-p" />}{' '}{l.risk === 'high-risk' ? <Pill txt="high-risk" cls="bad" /> : null}</td></tr>
          <tr><td>Worktree</td><td>{`${l.worktree || '—'}${l.head ? ' ' : ''}`}{l.head ? <span className="muted">{`@ ${l.head}`}</span> : null}</td></tr>
          {pr.criteria ? <tr><td>Done-criteria</td><td>{`${pr.green} green / ${pr.red} red / ${pr.criteria} total`}</td></tr> : null}
          {rv.exists
            ? <tr><td>Review</td><td>{`${rv.verdict || '—'} · ${rv.valid ? 'valid' : 'invalid report'} · ${rv.head_matches ? 'matches HEAD' : 'stale (code changed after review)'}${rv.fails ? ` · ${rv.fails} FAIL` : ''}`}</td></tr>
            : <tr><td>Review</td><td>none yet</td></tr>}
          {pr.escalated ? <tr><td className="kr">Escalation</td><td><b>{pr.attempts}</b>{` attempts — ${pr.failure ?? ''}`}</td></tr> : null}
          {l.last_check
            ? <tr><td>Last check</td><td className={l.last_check.result === 'ok' ? 'kg' : 'kr'}>{`${l.last_check.kind}: ${l.last_check.result} — ${l.last_check.summary || ''} `}<span className="muted">{(l.last_check.ts || '').replace('T', ' ')}</span></td></tr>
            : null}
          <tr><td>Current step</td><td>{pr.current_step || '—'}</td></tr>
        </tbody>
      </table>
      <div className="lbl" style={{ marginTop: 12 }}>Live events · written by hooks on every tool call</div>
      <div id="events">{s.laneEvents.length
        ? s.laneEvents.slice(-40).reverse().map((e, i) => (
          <div className="ev" key={i}><span className="t">{(e.ts || '').slice(11, 19)}</span><span className={`k ${e.result === 'blocked' || e.result === 'fail' ? 'kr' : e.event === 'test' ? 'kg' : e.event === 'read' ? 'kb' : ''}`}>{e.event}</span><span>{`${e.path || e.command || e.summary || e.agent || ''}${e.summary && (e.path || e.command) ? ' · ' + e.summary : ''}`}</span></div>
        ))
        : <div className="empty">{s.live ? 'No events yet.' : 'Event stream needs the live server (events.jsonl is read from the worktree).'}</div>}</div>
    </div>
  );
}

function ProjectPage({ s, p }: { s: Snap; p: Project }) {
  const lanes = p.lanes || [];
  const active = lanes.filter((l) => !['queued', 'merged'].includes(l.position));
  const queued = lanes.filter((l) => l.position === 'queued').map((l) => l.slug).join(', ');
  const d = p.debt, r = p.research;
  const sel = s.laneSel ? lanes.find((l) => l.slug === s.laneSel) : undefined;
  return (
    <>
      {s.status.length > 1 ? <div className="crumbs"><a data-back="" onClick={wtBack}>All projects</a>{` › ${p.project}`}</div> : null}
      <div className="card"><div className="lbl">{`${p.project} · kit ${p.kit_version || ''} · WIP ${p.wip.in_flight} / ${p.wip.limit}`}</div>
        <div className="pipe">{STAGES.map((st) => {
          const here = lanes.filter((l) => st.match.includes(l.position));
          return (
            <div className={`stage ${st.cls || ''}`} key={st.id}>{st.label}{here.length
              ? here.map((l) => <span className={`mk ${l.slug === s.laneSel ? 'sel' : POS_CLASS[l.position] || 'agent'}`} data-lane={l.slug} title={l.position} key={l.slug} onClick={laneClick(l.slug)}>{l.slug}</span>)
              : <span className="mk" style={{ visibility: 'hidden' }}>·</span>}</div>
          );
        })}</div>
        <div className="muted" style={{ marginTop: 8 }}>Position is derived from the spec, worktree, progress file, review report, and git. Agents do not report it. Click a marker.</div></div>
      {sel ? <LaneCard s={s} l={sel} /> : null}
      <div className="card"><div className="lbl">Needs you</div>{p.needs_you.length
        ? p.needs_you.map((n) => (
          <div className="row" data-lane={n.slug} key={n.slug} onClick={laneClick(n.slug)}><span><span className="name">{n.slug}</span>{' '}<span className="muted">{`${n.position}${n.failure ? ' — ' + n.failure : ''}`}</span></span><Pill txt={n.position === 'escalated' ? 'read escalation' : n.position === 'waiting-approval' ? 'approve spec' : 'merge PR'} cls={n.position === 'escalated' ? 'bad' : 'you-p'} /></div>
        ))
        : <div className="empty">Nothing waits on you.</div>}</div>
      <div className="card"><div className="lbl">Lanes</div>{active.length
        ? active.map((l) => (
          <div className="row" data-lane={l.slug} key={l.slug} onClick={laneClick(l.slug)}><span><span className="name">{l.slug}</span>{' '}<span className="muted">{l.feature}</span></span><span>
            {' '}<Pill txt={l.position} cls={POS_CLASS[l.position] || 'agent'} />
            {' '}{l.worktree ? <Pill txt={`${l.behind_base} behind`} cls={l.behind_base > 0 ? 'bad' : 'neutral'} /> : null}
            {' '}{l.progress.criteria ? <Pill txt={`${l.progress.green}/${l.progress.criteria} green`} cls={l.progress.green === l.progress.criteria ? 'ok' : 'neutral'} /> : null}
            {' '}{l.events.blocked ? <Pill txt={`${l.events.blocked} blocked`} cls="bad" /> : null}
            {' '}{l.risk === 'high-risk' ? <Pill txt="high-risk" cls="bad" /> : null}</span></div>
        ))
        : <div className="empty">No active lanes.</div>}{queued ? <div className="muted" style={{ marginTop: 8 }}>{`Queued: ${queued}`}</div> : null}</div>
      <div className="card"><div className="lbl">Health</div><div className="grid">
        <div className="m"><div className="n">{d.text_only_lessons}</div><div className="t">text-only lessons (debt)</div></div>
        <div className="m"><div className="n">{`${d.claude_md_bytes} `}<span className="muted">{`/ ${d.claude_md_cap}`}</span></div><div className="t">CLAUDE.md bytes</div></div>
        <div className="m"><div className="n">{d.bootstrap_todos}</div><div className="t">bootstrap TODOs</div></div>
        <div className="m"><div className="n">{`${r.questions} `}<span className="muted">{`· ${r.stale} stale`}</span></div><div className="t">research questions</div></div>
        <div className="m"><div className="n">{p.ci_main ? (p.ci_main.conclusion || p.ci_main.status) : '—'}</div><div className="t">CI on main</div></div>
      </div></div>
    </>
  );
}

export function Worktrees() {
  const c = useSection('chrome');
  const s = useSection('worktrees');
  const p = projectOf(s);
  return (
    <div id="worktrees" hidden={c.n === 0 || c.tab !== 'worktrees'}><main id="main">{
      s.n === 0 ? <div className="empty">Loading status…</div>
        : !s.status.length ? <div className="card"><div className="empty">No status.json found. Run <code>node ~/.claude/kit/scripts/kit_status.js --repo . --out dashboard/status.json</code>, or start the live server: <code>node ~/.claude/kit/dashboard/server.js --repo .</code></div></div>
          : <>{s.status.length > 1 ? <Index s={s} /> : null}{p ? <ProjectPage s={s} p={p} /> : null}</>
    }</main></div>
  );
}
