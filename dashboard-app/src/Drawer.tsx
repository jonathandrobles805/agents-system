// The Board's drawer (hardening plan Step 10, "A drawer that opens each file at its ## Summary"). Opens on a card:
// a header with the lane's host facts, its files (GET /api/lane-files, grouped Lane / Round N, a verdict dot each), and
// the open file, Summary first. Files are read through the server's allowlist (/api/lane-file) and rendered by
// Markdown.tsx, which never parses HTML from a file.
import { useEffect, useState } from 'react';
import { boardOpen, type Snap } from './store';
import type { Lane } from './types';
import { costText } from './Board';
import { Markdown, summaryOf } from './Markdown';

interface LaneFile { path: string; size: number; verdict: string | null }

/** Which group a file belongs to: the review report is the current round's; everything else is the lane's. */
const groupOf = (f: LaneFile, l: Lane) => (f.path.endsWith('.review.md') ? `Round ${l.rounds?.round ?? 1}` : 'Lane');

function FileView({ text }: { text: string }) {
  const [full, setFull] = useState(false);
  const sum = summaryOf(text);
  if (sum === null) return <div className="dview"><p className="dnosum">This file has no ## Summary.</p><Markdown text={text} /></div>;
  return (
    <div className="dview">
      <Markdown text={full ? text : sum} />
      {full ? null : <button onClick={() => setFull(true)}>Open full file</button>}
    </div>
  );
}

export function Drawer({ s, l, stage }: { s: Snap; l: Lane; stage: string | null }) {
  const [files, setFiles] = useState<LaneFile[] | null>(null);
  const [open, setOpen] = useState<{ path: string; text: string | null } | null>(null);
  const q = `project=${encodeURIComponent(s.root ?? '')}`;
  useEffect(() => {
    const key = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') boardOpen(null); };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);
  useEffect(() => {
    let live = true;
    fetch(`/api/lane-files/${encodeURIComponent(l.slug)}?${q}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() as Promise<LaneFile[]> : []))
      .then((f) => { if (live) setFiles(f); }, () => { if (live) setFiles([]); });
    return () => { live = false; };
  }, [l.slug, q]);
  const show = (p: string) => {
    setOpen({ path: p, text: null });
    fetch(`/api/lane-file/${encodeURIComponent(l.slug)}?${q}&path=${encodeURIComponent(p)}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() as Promise<{ text: string }> : { text: `Could not read ${p} (${r.status}).` }))
      .then((j) => setOpen({ path: p, text: j.text }), () => setOpen({ path: p, text: `Could not read ${p}.` }));
  };
  const groups = new Map<string, LaneFile[]>();
  for (const f of files ?? []) { const g = groupOf(f, l); groups.set(g, [...(groups.get(g) ?? []), f]); }
  const order = [...groups.keys()].sort((a, b) => (a === 'Lane' ? -1 : b === 'Lane' ? 1 : a < b ? -1 : 1));
  const cost = costText(l);
  return (
    <>
      <div className="scrim" onClick={() => boardOpen(null)}></div>
      <div className="drawer" data-lane={l.slug} role="dialog" aria-modal="true" aria-label={`${l.slug} files`}>
        <div className="dhead">
          <b className="dslug">{l.slug}</b>
          <span className="dstage bchip neutral">{stage ?? 'unknown stage'}</span>
          {l.rounds ? <span className="dround">{`round ${l.rounds.round} of ${l.rounds.limit}`}</span> : null}
          {cost ? <span className="dcost">{cost}</span> : null}
          {l.elapsed_hours == null ? null : <span className="delapsed">{`${l.elapsed_hours.toFixed(1)}h`}</span>}
          {l.pr ? <a className="dpr" href={l.pr} target="_blank" rel="noopener">PR</a> : null}
          <span className="grow"></span>
          <button onClick={() => boardOpen(null)}>Close</button>
        </div>
        <div className="dbody">
          <nav className="dfiles" aria-label="Files">
            {files === null ? <div className="muted">Reading…</div> : files.length === 0 ? <div className="muted">No files yet.</div> : order.map((g) => (
              <div className="dgroup" data-group={g} key={g}>
                <div className="dgroup-h cap">{g}</div>
                {groups.get(g)!.map((f) => (
                  <button className={`dfile${open?.path === f.path ? ' sel' : ''}`} key={f.path} onClick={() => show(f.path)} title={`${f.size} bytes`}>
                    <span className={`vdot ${f.verdict === 'PASS' ? 'ok' : f.verdict === 'FAIL' ? 'bad' : 'none'}`} aria-label={f.verdict ? `verdict ${f.verdict}` : 'no verdict'}></span>{f.path}
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <div className="dpane">{open ? (open.text === null ? <div className="muted">Reading…</div> : <FileView key={open.path} text={open.text} />) : <div className="muted">Pick a file.</div>}</div>
        </div>
      </div>
    </>
  );
}
