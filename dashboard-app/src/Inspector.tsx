// The inspector (kit/dashboard/index.html:474-527). Drawn from the 'inspector' snapshot, which store.ts publishes
// where the original calls renderInspector() or clears #inspector.
import { clickBlast, clickGroup, clickItab, clickNode, overlayOf, projectOf, statesOf, useSection } from './store';
import type { KitNode } from './types';

const TABS = ['overview', 'impact', 'tests', 'history'];
const capStyle = { margin: '14px 0 6px' };

export function Inspector() {
  const s = useSection('inspector');
  if (s.n === 0 || s.insp === 'blank') return <aside className="insp" id="inspector" aria-label="Inspector"></aside>;
  return <aside className="insp" id="inspector" aria-label="Inspector"><Body /></aside>;
}

function Body() {
  const s = useSection('inspector');
  if (!s.arch) return <div className="muted">Select a component once the live server is running.</div>;
  const m = s.arch.manifest;
  const n = s.selected ? s.idx!.byId.get(s.selected) : null;
  if (!n) {
    const errs = m.problems.filter((p) => p.severity === 'error').length, warns = m.problems.filter((p) => p.severity === 'warn').length;
    return (
      <>
        <div className="cap">Inspector</div><h2>Nothing selected</h2><p className="muted">Click a component to see what it is for, what depends on it, which tests cover it, and its history.</p>
        <div className="big"><div><b>{m.nodes.length}</b><span>COMPONENTS</span></div><div><b style={{ color: errs ? 'var(--red)' : 'var(--green)' }}>{errs}</b><span>VIOLATIONS</span></div><div><b>{warns}</b><span>WARNINGS</span></div></div>
        <p className="muted">The map comes from <code>kit/manifest.json</code> (what each component is for) and from the files themselves (who uses whom). A component not declared there is a violation.</p>
      </>
    );
  }
  const V = s.V!, idx = s.idx!, b = V.blastRadius(m, idx, n.id), st = statesOf(s).get(n.id)!;
  const name = (id: string) => idx.byId.get(id)!;
  let body;
  if (s.itab === 'overview') {
    const attrs: [string, string][] = [];
    if (n.kind === 'agent') attrs.push(['tools', n.attrs.tools.join(', ')], ['model', String(n.attrs.model)]);
    if (n.kind === 'hook') attrs.push(['runs on', (n.attrs.events || []).join(', ') || 'no event'], ['registered by', (idx.inn.get(n.id) || []).filter((e) => e.kind === 'hook').map((e) => idx.byId.get(e.from)!.label).join(', ') || 'nothing']);
    if (n.kind === 'skill') attrs.push(['arguments', n.attrs.argument_hint || 'none'], ['allowed tools', (n.attrs.allowed_tools || []).join(', ') || 'default']);
    if (n.kind === 'ci-job') attrs.push(['pipeline', String(n.attrs.pipeline)], ['steps', String(n.attrs.steps)]);
    if (n.kind === 'settings') attrs.push(['deny rules', String(n.attrs.deny_rules)]);
    const o = overlayOf(s);
    if (o && n.kind === 'hook') attrs.push(['in ' + ((projectOf(s) || { project: '' }).project || 'project'), o.installed_nodes.includes(n.id) ? 'registered' : 'not registered']);
    body = (
      <>
        {n.purpose ? <p>{`${n.purpose} `}<span className="prov">DECLARED</span></p> : n.attrs.description ? <p>{n.attrs.description}</p> : null}
        {n.writes ? <p className="muted">{`writes: ${n.writes} `}<span className="prov">DECLARED</span></p> : null}
        <div className="kv">{attrs.flatMap(([k, v]) => [<span key={k + ':k'}>{k}</span>, <span key={k + ':v'}>{v}</span>])}<span>defined in</span><span className="src">{`${n.path}${n.stats && n.stats.lines ? ` · ${n.stats.lines} lines` : ''} `}<span className="prov">OBSERVED</span></span></div>
        {st.tags.map((t, i) => <div className={`vio ${t.tone === 'bad' ? 'error' : t.tone === 'warn' ? 'warn' : ''}`} key={i}><b>{t.label.toUpperCase()}</b><div>{t.detail}</div></div>)}
      </>
    );
  } else if (s.itab === 'impact') {
    body = (
      <>
        <div className="big"><div><b>{b.dependents.length}</b><span>DEPENDENTS</span></div><div><b>{st.tags.filter((t) => t.key === 'violation').length}</b><span>VIOLATIONS</span></div><div><b>{b.cases}</b><span>TEST CASES</span></div></div>
        <div className="cap" style={capStyle}>If this changes</div>
        {b.groups.length
          ? b.groups.map((g) => <div className="li" data-group={g.kind} key={g.kind} onClick={() => clickGroup(g.kind)}><span>{`${g.count} of ${g.total} ${g.label}`}</span><small>{`${g.first}${g.more ? ' +' + g.more : ''}`}</small></div>)
          : <div className="empty">Nothing else needs it.</div>}
        <div className="cap" style={capStyle}>Depends on</div>
        {b.dependsOn.length
          ? b.dependsOn.map((d, i) => <div className="li" data-node={d.id} key={i} onClick={() => clickNode(d.id)}><span>{`${d.label} `}<small>{`${d.kind}${d.event ? ' ' + d.event : ''}`}</small></span><small>{`${d.evidence.file.split('/').pop()}:${d.evidence.line}`}</small></div>)
          : <div className="empty">Nothing in the kit.</div>}
        <div className="btnrow"><button id="blastBtn" aria-pressed={s.blast} onClick={clickBlast}>Highlight blast radius</button></div>
      </>
    );
  } else if (s.itab === 'tests') {
    const row = (t: string, small: string) => <div className="li" data-node={t} key={t} onClick={() => clickNode(t)}><span>{name(t).label}</span><small>{small}</small></div>;
    const cases = (t: KitNode) => `${t.stats!.cases} cases`;
    body = (
      <>
        <div className="cap" style={{ marginBottom: 6 }}>Test files that name or import it</div>
        {b.directTests.length ? b.directTests.map((t) => row(t, cases(name(t)))) : <div className="vio warn"><b>NOT COVERED DIRECTLY</b><div>No test file imports or names this component.</div></div>}
        <div className="cap" style={capStyle}>{`All tests a change can reach (${b.cases} cases)`}</div>
        {b.tests.length ? b.tests.map((t) => row(t, cases(name(t)))) : <div className="empty">None.</div>}
        <div className="cap" style={capStyle}>CI jobs that run them</div>{b.jobs.length ? b.jobs.map((j) => row(j, j.split('/')[0].replace('ci-job:', ''))) : <div className="empty">None.</div>}
        <p className="muted">Case counts are a static count of <code>test(</code> calls in each file.</p>
      </>
    );
  } else {
    const h = s.history.get(n.id);
    body = h === undefined ? <div className="empty">Loading history…</div> : h === null ? <div className="empty">History unavailable.</div>
      : (
        <>
          <div className="hist">{h.length ? h.map((c) => <div key={c.sha}><b>{c.sha}</b>{`${c.date} · ${c.author}`}<br />{c.subject}</div>) : <div className="empty">No commits touch this file.</div>}</div><p className="muted">From <code>{`git log -- ${n.path}`}</code></p>
        </>
      );
  }
  const url = V.githubFileUrl(s.arch.git, n);
  return (
    <>
      <div className="cap">{`${V.kindLabel(n.kind)}${st.tags.length ? ' · ' + st.tags[0].label.toUpperCase() : ''}`}</div><h2>{n.label}</h2><div className="src">{n.path}</div>
      <div className="itabs" role="tablist">{TABS.map((t) => <button className="itab" role="tab" data-itab={t} aria-selected={s.itab === t} key={t} onClick={() => clickItab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>)}</div>{body}
      {url ? <div className="btnrow"><a href={url} target="_blank" rel="noopener"><button>Open on GitHub ↗</button></a></div> : null}
    </>
  );
}
