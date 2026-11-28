// The page. Markup and order follow kit/dashboard/index.html:184-216; each section draws from its own snapshot
// (store.ts), so it changes exactly when the original's section would.
import { useEffect } from 'react';
import { useSection, projectOf, VIEWS, type Snap, start, onHashChange, clickTab, changeProject, refresh, clickView } from './store';
import { Inspector } from './Inspector';
import { Worktrees } from './Worktrees';
import { Board } from './Board';
import { VIEW } from './Views';

// ------------------------------------------------------------------------------------------------ top bar (index.html:184-194, 303-313)
function TopBar() {
  const c = useSection('chrome');
  const d = useSection('dot');
  const drawn = c.n > 0;
  return (
    <header className="top">
      <span className="brand">AGENT-KIT</span>
      <nav className="tabs" role="tablist" aria-label="Screens">
        <button className="tab" role="tab" id="tab-arch" data-tab="arch" aria-selected={drawn ? c.tab === 'arch' : undefined} onClick={() => clickTab('arch')}>Architecture Canvas</button>
        <button className="tab" role="tab" id="tab-worktrees" data-tab="worktrees" aria-selected={drawn ? c.tab === 'worktrees' : undefined} onClick={() => clickTab('worktrees')}>Worktrees</button>
        <button className="tab" role="tab" id="tab-board" data-tab="board" aria-selected={drawn ? c.tab === 'board' : undefined} onClick={() => clickTab('board')}>Board</button>
      </nav>
      <span className="grow"></span>
      <select id="projectSel" aria-label="Project" hidden={!drawn || c.status.length < 2} value={drawn ? c.root ?? '' : ''} onChange={(e) => changeProject(e.target.value)}>
        {drawn && c.status.map((p) => (
          <option key={p.root} value={p.root}>{`${p.project}${c.status.filter((q) => q.project === p.project).length > 1 ? ' · ' + p.root : ''}`}</option>
        ))}
      </select>
      <span className="livepill" id="live"><span className={d.dot!.cls} id="livedot"></span><span id="livetext">{d.dot!.text}</span></span>
      <button id="refresh" onClick={() => { void refresh(); }}>Refresh</button>
    </header>
  );
}

// ------------------------------------------------------------------------------------------------ side (index.html:315-325)
function ProjectCard({ s }: { s: Snap }) {
  if (!s.n) return null;
  const a = s.arch;
  if (!a) return <div className="muted">Needs the live server.</div>;
  const g = a.git;
  const p = projectOf(s);
  return (
    <>
      <b>{p ? p.project : 'no project'}</b><div className="muted">{`kit ${a.manifest.kit_version || '?'} · map ${a.manifest.digest.slice(0, 8)}`}</div>
      <div className="muted mono">{g && g.branch ? g.branch + ' @ ' + g.commit : 'not a git checkout'}</div>
      <div className="muted" style={{ marginTop: 6 }}>{`${a.manifest.nodes.length} components · ${a.manifest.edges.length} links · each read from a file`}</div>
    </>
  );
}

function Side() {
  const s = useSection('side');
  return (
    <aside className="side" aria-label="Views">
      <div className="cap" style={{ marginBottom: 8 }}>Views</div>
      <div id="views">{s.n ? VIEWS.map(([k, t], i) => (
        <button className="vi" data-view={k} aria-current={s.view === k ? 'true' : undefined} key={k} onClick={() => clickView(k)}><span className="n">{`0${i + 1}`}</span>{t}</button>
      )) : null}</div>
      <h3 className="cap">Legend</h3>
      <div className="lg"><span className="sw run"></span>Running: lane events in the last 2 min</div>
      <div className="lg"><span className="sw next"></span>Next up: a lane&apos;s next stage</div>
      <div className="lg"><span className="sw bad"></span>Violation or failing check</div>
      <div className="lg"><span className="sw warn"></span>Warning or modified in git</div>
      <div className="lg"><span className="sw miss"></span>Not installed in this project</div>
      <h3 className="cap">Project</h3>
      <div className="proj" id="projcard"><ProjectCard s={s} /></div>
    </aside>
  );
}

// ------------------------------------------------------------------------------------------------ stage (index.html:209-212, 538-551)
function Stage() {
  const s = useSection('view');
  const View = VIEW[s.view];
  return (
    <section className="stagearea">
      <div className="sh"><h2 id="vtitle">{s.n ? s.title : ''}</h2><p id="vsub">{s.n ? s.sub : ''}</p></div>
      <div className="vp" id="view">{
        !s.n ? null
          : s.body === 'static' ? <div className="empty">The architecture map is built from the repository by the live server. Start it with <code>node ~/.claude/kit/dashboard/server.js --repo .</code>. The Worktrees screen also works from a static status.json.</div>
            : s.body === 'reading' ? <div className="empty">Reading the repository…</div>
              : <View s={s} />
      }</div>
    </section>
  );
}

function Arch() {
  const c = useSection('chrome');
  return (
    <div id="arch" hidden={c.n === 0 || c.tab !== 'arch'}>
      <Side />
      <Stage />
      <Inspector />
    </div>
  );
}

export function App() {
  useEffect(() => {
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  useEffect(() => { void start(); }, []);
  return (
    <>
      <TopBar />
      <Arch />
      <Worktrees />
      <Board />
    </>
  );
}
