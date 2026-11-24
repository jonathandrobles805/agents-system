// The five views of the Architecture Canvas (kit/dashboard/index.html:328-471), drawn from the 'view' snapshot.
import type { KeyboardEvent, ReactNode } from 'react';
import { changeKind, clickGroup, clickNode, inputQuery, overlayOf, projectOf, statesOf, type Snap } from './store';
import type { KitNode, NodeState, PipelineBox, Placed } from './types';

export const clip = (s: unknown, n: number) => (String(s).length > n ? String(s).slice(0, Math.max(1, n - 1)) + '…' : String(s));

/** index.html:693-695: Enter or Space on a component acts as a click on it. */
export const nodeKey = (id: string) => (e: KeyboardEvent) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); clickNode(id); }
};

// ------------------------------------------------------------------------------------------------ svg node (index.html:328-353)
function NodeSvg({ s, n, pos, st, flags }: { s: Snap; n: KitNode; pos: Placed; st: NodeState | undefined; flags: { sel: boolean; dim: boolean; rad: boolean } }) {
  const tone = st ? st.tone : 'idle';
  const miss = st && st.tags.some((t) => t.key === 'missing');
  const cls = ['node', tone === 'bad' ? 't-bad' : tone === 'warn' ? (miss ? 't-miss' : 't-warn') : tone === 'run' ? 't-run' : tone === 'next' ? 't-next' : '', flags.sel ? 'sel' : '', flags.dim ? 'dim' : '', flags.rad ? 'rad' : ''].filter(Boolean).join(' ');
  const { x, y, w, h } = pos;
  let inner;
  if (n.kind === 'agent') {
    const hooks = (s.idx!.out.get(n.id) || []).filter((e) => e.kind === 'hook').length;
    inner = <><text className="k" x={x + 12} y={y + 18}>AGENT</text><text className="b" x={x + 12} y={y + 40}>{clip(n.label, 20)}</text><text className="s" x={x + 12} y={y + 60}>{`tools ${n.attrs.tools.length} · hooks ${hooks} · ${n.attrs.model ?? ''}`}</text></>;
  } else if (n.kind === 'hook') {
    inner = <><text x={x + 10} y={y + 20}>{clip(n.label, 20)}</text><text className="s" x={x + 10} y={y + 37}>{clip((n.attrs.events || []).join(' · '), 21)}</text></>;
  } else if (n.kind === 'skill') {
    inner = <text className="mono" x={x + 10} y={y + 24}>{'/' + n.label}</text>;
  } else {
    inner = <><text x={x + 10} y={y + 18}>{clip(n.label, Math.floor(w / 7.4))}</text><text className="s" x={x + 10} y={y + 33}>{n.kind === 'ci-job' ? clip(n.id.split('/')[0].replace('ci-job:', ''), 22) : n.stats && n.stats.lines ? n.stats.lines + ' lines' : ''}</text></>;
  }
  const tag = st && st.tags.find((t) => ['running', 'next', 'failing', 'violation', 'missing', 'modified'].includes(t.key));
  const tagColor = tag && (tag.tone === 'run' || tag.tone === 'next' ? 'var(--green)' : tag.tone === 'bad' ? 'var(--red)' : 'var(--amber)');
  const tagSvg = !tag ? null : n.kind === 'agent'
    ? <text className="tag" x={x + w - 8} y={y + 16} textAnchor="end" style={{ fill: tagColor }}>{tag.label.toUpperCase()}</text>
    : <circle cx={x + w - 11} cy={y + 11} r="4" style={{ fill: tagColor }} />;
  const tip = [n.purpose || n.id, ...(st ? st.tags.map((t) => `${t.label}: ${t.detail}`) : [])].join('\n');
  return (
    <g className={cls} data-node={n.id} tabIndex={0} role="button" aria-label={n.id} onClick={() => clickNode(n.id)} onKeyDown={nodeKey(n.id)}>
      <title>{tip}</title><rect className="box" x={x} y={y} width={w} height={h} rx={n.kind === 'skill' ? 10 : 12} />{inner}{tagSvg}
    </g>
  );
}

// ------------------------------------------------------------------------------------------------ System (index.html:356-380)
export function ViewSystem({ s }: { s: Snap }) {
  const m = s.arch!.manifest, V = s.V!;
  const layout = V.layoutBands(m, 1080);
  const pos = new Map(layout.bands.flatMap((b) => b.nodes).map((n) => [n.id, n]));
  const st = statesOf(s);
  const sel = s.selected;
  const rad = s.blast && sel ? new Set([sel, ...V.blastRadius(m, s.idx!, sel).dependents]) : null;
  const edges = [];
  for (const [i, e] of m.edges.entries()) {
    const a = pos.get(e.from), b = pos.get(e.to);
    if (!a || !b) continue;
    const base = e.kind === 'spawns';
    const out = sel && e.from === sel, inn = sel && e.to === sel;
    const inRad = rad && rad.has(e.from) && rad.has(e.to);
    if (!base && !out && !inn && !inRad) continue;
    const cls = inn || inRad ? 'in' : out ? 'out' : sel || rad ? 'faint' : '';
    edges.push(<path className={`edge ${cls}`} d={V.edgePath(a, b)} key={i} />);
  }
  return (
    <svg viewBox={`0 0 ${layout.width} ${layout.height}`} width="100%" style={{ maxWidth: layout.width }} role="group" aria-label="System architecture">
      {layout.bands.map((b) => <text className="band" x="20" y={b.y + 14} key={b.title}>{b.title}</text>)}
      {edges}
      {layout.bands.flatMap((b) => b.nodes).map((p) => (
        <NodeSvg key={p.id} s={s} n={s.idx!.byId.get(p.id)!} pos={p} st={st.get(p.id)} flags={{ sel: p.id === sel, dim: !!rad && !rad.has(p.id), rad: !!rad && rad.has(p.id) && p.id !== sel }} />
      ))}
    </svg>
  );
}


// ------------------------------------------------------------------------------------------------ Agents (index.html:382-402)
export function ViewAgents({ s }: { s: Snap }) {
  const m = s.arch!.manifest, V = s.V!, st = statesOf(s), idx = s.idx!;
  return (
    <div className="cards">
      {m.pipeline.filter((x) => x.pause).map((x) => (
        <div className="ac you" key={'pause:' + x.id}><div className="cap">{`YOU · pause ${x.pause}`}</div><h4>{x.pause === 1 ? 'Approve the spec' : 'Merge the pull request'}</h4>
          <p>{`The ${x.id} stage of `}<code>/zi-run</code> stops here until a human acts.</p><div className="src">{`${idx.byId.get('skill:zi-run')!.path}:${x.line}`}</div></div>
      ))}
      {V.orderedNodes(m, 'agent').map((a) => {
        const hooks = (idx.out.get(a.id) || []).filter((e) => e.kind === 'hook');
        const stages = m.pipeline.filter((x) => x.agents.includes(a.label));
        const tags = (st.get(a.id) || { tags: [] }).tags;
        const lanes = tags.filter((t) => t.key === 'running' || t.key === 'next');
        const tone = st.get(a.id)!.tone;
        return (
          <div className={`ac ${tone === 'idle' ? '' : 't-' + tone} ${a.id === s.selected ? 'sel' : ''}`} data-node={a.id} tabIndex={0} role="button" key={a.id} onClick={() => clickNode(a.id)} onKeyDown={nodeKey(a.id)}>
            <div className="cap">{`AGENT${tags.map((t) => ` · ${t.label.toUpperCase()}`).join('')}`}</div><h4>{a.label}</h4>
            <p>{a.purpose || a.attrs.description}</p>
            {a.writes ? <p className="muted">{`writes: ${a.writes} `}<span className="prov">DECLARED</span></p> : null}
            <div>{a.attrs.tools.map((t, i) => <span className="chip static" key={i}>{t}</span>)}<span className="chip static">{a.attrs.model}</span></div>
            <div className="hk">{hooks.length
              ? hooks.flatMap((h, i) => [<span key={i + ':e'}>{`${h.event ?? ''}${h.matcher ? ' ' + h.matcher : ''}`}</span>, <b key={i + ':b'}>{idx.byId.get(h.to)!.label}</b>])
              : <><span>no hooks of its own</span><b></b></>}</div>
            <div className="muted" style={{ marginTop: 8 }}>{`stages: ${stages.map((x) => x.id).join(', ') || 'none'}${lanes.length ? ' · ' + lanes.map((l) => l.detail).join('; ') : ''}`}</div></div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ Pipeline (index.html:404-419)
export function ViewPipeline({ s }: { s: Snap }) {
  const m = s.arch!.manifest, V = s.V!;
  const stages = V.pipelineView(m, overlayOf(s));
  const runPath = s.idx!.byId.get('skill:zi-run')!.path;
  const box = (x: PipelineBox) => (
    <div className={`stg ${x.pause ? 'human' : ''} ${x.lanes.length ? 'here' : ''}`} key={x.id}>
      <h5>{x.id}</h5>{x.pause ? <div className="chip a static">{`YOU · pause ${x.pause}`}</div> : null}
      <div>{x.agents.map((a) => <button className="chip" data-node={`agent:${a}`} key={'a:' + a} onClick={() => clickNode(`agent:${a}`)} onKeyDown={nodeKey(`agent:${a}`)}>{a}</button>)}{x.skills.map((c) => <button className="chip" data-node={`skill:${c}`} key={'s:' + c} onClick={() => clickNode(`skill:${c}`)} onKeyDown={nodeKey(`skill:${c}`)}>{'/' + c}</button>)}</div>
      {x.lanes.map((l) => <span className="chip g static" key={l}>{l}</span>)}
      <div className="evd">{`${runPath}:${x.line}`}</div></div>
  );
  const loop = stages.filter((x) => !['escalated', 'done', 'start'].includes(x.id));
  const side = stages.filter((x) => ['start', 'escalated', 'done'].includes(x.id));
  return (
    <>
      <div className="flow">{loop.flatMap((x, i) => (i < loop.length - 1 ? [box(x), <span className="arrow" key={'→' + x.id}>→</span>] : [box(x)]))}</div>
      <div className="cap" style={{ margin: '22px 0 8px' }}>Outside the loop</div><div className="flow">{side.map(box)}</div>
    </>
  );
}

// ------------------------------------------------------------------------------------------------ Activity (index.html:453-471)
export function ViewActivity({ s }: { s: Snap }) {
  const m = s.arch!.manifest;
  const o = overlayOf(s);
  const errs = m.problems.filter((p) => p.severity === 'error'), warns = m.problems.filter((p) => p.severity === 'warn');
  const drift: [string, string, string][] = [];
  if (o) {
    if (o.settings !== true) drift.push(['error', 'no hooks', `${(projectOf(s) || { project: '' }).project ?? ''} has no usable .claude/settings.json: none of the ${o.hooks.expected} kit hooks run there`]);
    if (o.hooks.missing.length && o.settings === true) drift.push(['error', 'missing hooks', `${o.hooks.missing.length} of ${o.hooks.expected} kit hooks are not registered: ${o.hooks.missing.slice(0, 4).map((h) => h.node.replace('hook:', '') + '@' + h.event).join(', ')}${o.hooks.missing.length > 4 ? '…' : ''}`]);
    if (o.hooks.stale.length) drift.push(['error', 'stale hooks', `hooks name kit scripts that no longer exist: ${o.hooks.stale.join(', ')}. Run /zi-bootstrap --upgrade`]);
    if (o.kit_version.project && o.kit_version.kit && o.kit_version.project !== o.kit_version.kit) drift.push(['warn', 'kit version', `project set up with kit ${o.kit_version.project}; installed kit is ${o.kit_version.kit}`]);
  }
  const evs = s.feed.slice().reverse().slice(0, 120);
  return (
    <div className="tblk"><div><div className="cap" style={{ marginBottom: 8 }}>Events</div><div className="feed">{evs.length
      ? evs.map((e, i) => <div key={i}><span className="t">{(e.ts || '').slice(11, 19)}</span><span className="w">{e.lane || ''}</span><span className={`k ${e.result === 'blocked' || e.result === 'fail' ? 'kr' : e.event === 'test' ? 'kg' : ''}`}>{e.event}</span><span>{e.path || e.command || e.summary || e.agent || ''}</span></div>)
      : <div className="empty">No events yet. Hooks write one line per tool call inside a lane.</div>}</div></div>
      <div><div className="cap" style={{ marginBottom: 8 }}>This project vs the kit</div>{drift.length
        ? drift.map(([sev, id, msg]) => <div className={`vio ${sev}`} key={id}><b>{`${sev.toUpperCase()} · ${id}`}</b><div>{msg}</div></div>)
        : <div className="vio" style={{ borderColor: 'var(--green)' }}><b>IN STEP</b><div>Every kit hook is registered, none is stale.</div></div>}
        <div className="cap" style={{ margin: '16px 0 8px' }}>{`Violations in the map (${errs.length} errors, ${warns.length} warnings)`}</div>{errs.length + warns.length
          ? [...errs, ...warns].map((p, i) => <div className={`vio ${p.severity}`} data-node={p.component} key={i} onClick={p.component ? () => clickNode(p.component!) : undefined}><b>{`${p.severity.toUpperCase()} · ${p.id}`}</b><div>{p.message}</div></div>)
          : <div className="vio" style={{ borderColor: 'var(--green)' }}><b>NONE</b><div>Every component is declared and every reference resolves.</div></div>}</div></div>
  );
}

// ------------------------------------------------------------------------------------------------ Dependencies (index.html:421-451)
export function ViewDeps({ s }: { s: Snap }) {
  const m = s.arch!.manifest, V = s.V!, idx = s.idx!;
  const list = V.searchNodes(m, s.query, s.kind || null);
  const kinds = [...new Set(m.nodes.map((n) => n.kind))].sort();
  const left = (
    <div style={{ width: 240, flex: 'none' }}><div style={{ display: 'flex', gap: 6, marginBottom: 8 }}><input id="q" placeholder="Search components" value={s.query} style={{ flex: 1, minWidth: 0 }} aria-label="Search components" onChange={(e) => inputQuery(e.target.value)} />
      <select id="kindSel" aria-label="Kind" value={s.kind} onChange={(e) => changeKind(e.target.value)}><option value="">all</option>{kinds.map((k) => <option value={k} key={k}>{V.kindLabel(k).toLowerCase()}</option>)}</select></div>
      <div className="listbox">{list.length
        ? list.map((n) => <div className={`li ${n.id === s.selected ? 'sel' : ''}`} data-node={n.id} tabIndex={0} role="button" key={n.id} onClick={() => clickNode(n.id)} onKeyDown={nodeKey(n.id)}><span>{n.label}</span><small>{V.kindLabel(n.kind)}</small></div>)
        : <div className="empty" style={{ padding: 12 }}>No match.</div>}</div></div>
  );
  if (!s.selected) return <div style={{ display: 'flex', gap: 20 }}>{left}<div className="empty" style={{ flex: 1 }}>Select a component to see its blast radius.</div></div>;
  const b = V.blastRadius(m, idx, s.selected), n = idx.byId.get(s.selected)!;
  const RH = 46, GH = 62, W = 600, LW = 170, CL = 215, CW = 170, RW = 200;
  const L = b.dependsOn.slice(0, 14), R = b.groups;
  const height = Math.max(L.length * RH, R.length * GH, 200) + 20;
  const cy = height / 2;
  const lines = [
    ...L.map((_, i) => { const y = 10 + i * RH + (RH - 8) / 2; return <path className="edge out" d={`M${LW} ${y} C${LW + 22} ${y} ${CL - 22} ${cy} ${CL} ${cy}`} key={'l' + i} />; }),
    ...R.map((_, i) => { const y = 10 + i * GH + (GH - 10) / 2; return <path className="edge in" d={`M${CL + CW} ${cy} C${CL + CW + 14} ${cy} ${W - RW - 14} ${y} ${W - RW} ${y}`} key={'r' + i} />; }),
  ];
  const sentence = b.tests.length ? `A change here runs ${b.cases} test cases in ${b.tests.length} test files${b.jobs.length ? ` and ${b.jobs.length} CI job${b.jobs.length > 1 ? 's' : ''}` : ''}.` : (b.dependents.length ? 'No test file sits in this component\'s blast radius.' : 'Nothing else needs this component.');
  const open = s.groupOpen ? b.groups.find((g) => g.kind === s.groupOpen) : null;
  return (
    <div style={{ display: 'flex', gap: 20 }}>{left}<div style={{ flex: 1, minWidth: 0 }}><div className="depwrap" style={{ height, width: W }}><svg width={W} height={height} style={{ position: 'absolute', left: 0, top: 0 }}>{lines}</svg>
      {L.map((d, i) => <div data-node={d.id} className="item" tabIndex={0} role="button" style={{ left: 0, width: LW, top: 10 + i * RH, height: RH - 8 }} key={'L' + i} onClick={() => clickNode(d.id)} onKeyDown={nodeKey(d.id)}><b>{clip(d.label, 22)}</b><div className="src">{`${d.kind}${d.event ? ' ' + d.event : ''}`}</div></div>)}
      {R.map((g, i) => <div className="item in" data-group={g.kind} tabIndex={0} role="button" style={{ left: W - RW, width: RW, top: 10 + i * GH, height: GH - 10 }} key={'R' + g.kind} onClick={() => clickGroup(g.kind)}><b>{`${g.count} of ${g.total} ${g.label}`}</b><div className="src">{`${clip(g.first, 22)}${g.more ? ` +${g.more}` : ''}`}</div></div>)}
      <div className="core" style={{ left: CL, top: cy - 44, width: CW }}><div className="cap">{V.kindLabel(n.kind)}</div><b>{n.label}</b><div className="muted">{`${b.dependents.length} dependents`}</div></div></div>
      <p style={{ margin: '12px 0 4px', color: 'var(--text2)' }}>{`${sentence}${b.dependsOn.length > L.length ? ` Showing ${L.length} of ${b.dependsOn.length} dependencies.` : ''}${b.dependsOn.length === 0 ? ' It depends on nothing else in the kit.' : ''}`}</p>
      {open
        ? <><div className="cap" style={{ margin: '12px 0 6px' }}>{`${open.label} that need ${n.label}`}</div><div>{open.ids.map((id) => <button className="chip" data-node={id} key={id} onClick={() => clickNode(id)} onKeyDown={nodeKey(id)}>{idx.byId.get(id)!.label}</button>)}</div></>
        : <div className="muted">Click a group to list its members.</div>}</div></div>
  );
}

/** index.html:549 */
export const VIEW: Record<string, (p: { s: Snap }) => ReactNode> = { system: ViewSystem, agents: ViewAgents, pipeline: ViewPipeline, deps: ViewDeps, activity: ViewActivity };
