// The Board's drawer (hardening plan Step 10): opens on a card. Its file list and file view are item 3g.
import { useEffect } from 'react';
import { boardOpen, type Snap } from './store';
import type { Lane } from './types';

export function Drawer({ l, stage }: { s: Snap; l: Lane; stage: string | null }) {
  useEffect(() => {
    const key = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') boardOpen(null); };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);
  return (
    <>
      <div className="scrim" onClick={() => boardOpen(null)}></div>
      <aside className="drawer" data-lane={l.slug} role="dialog" aria-modal="true" aria-label={`${l.slug} files`}>
        <div className="dhead"><b>{l.slug}</b><span className="muted">{` · ${stage ?? 'unknown stage'}`}</span><span className="grow"></span><button onClick={() => boardOpen(null)}>Close</button></div>
      </aside>
    </>
  );
}
