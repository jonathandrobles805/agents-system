// A small Markdown renderer for the drawer (hardening plan Step 10). It builds React elements only: every piece of a
// file is a text node, so HTML in a file is shown as text, never parsed (the page's own rule, store.ts esc). Headings,
// paragraphs, lists, tables, fenced code, inline `code`, **bold**. Anything else stays as text.
import type { ReactNode } from 'react';

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(m[1] !== undefined ? <code key={`${key}c${i++}`}>{m[1]}</code> : <strong key={`${key}b${i++}`}>{m[2]}</strong>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const cells = (row: string) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    const k = `b${i}`;
    if (/^```/.test(l)) {
      const body: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) body.push(lines[i]);
      i++;
      blocks.push(<pre key={k}><code>{body.join('\n')}</code></pre>);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) {
      const level = Math.max(2, h[1].length); // the page's own h2 is the top heading inside the drawer
      const Tag = `h${level}` as 'h2';
      blocks.push(<Tag key={k}>{inline(h[2], k)}</Tag>);
      i++;
      continue;
    }
    if (/^\s*\|/.test(l)) {
      const rows: string[] = [];
      for (; i < lines.length && /^\s*\|/.test(lines[i]); i++) rows.push(lines[i]);
      const body = rows.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r));
      const [head, ...rest] = body;
      blocks.push(
        <table key={k}><tbody>
          {head ? <tr>{cells(head).map((c, j) => <th key={j}>{inline(c, `${k}h${j}`)}</th>)}</tr> : null}
          {rest.map((r, ri) => <tr key={ri}>{cells(r).map((c, j) => <td key={j}>{inline(c, `${k}r${ri}c${j}`)}</td>)}</tr>)}
        </tbody></table>,
      );
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      const items: string[] = [];
      for (; i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i]); i++) items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''));
      blocks.push(<ul key={k}>{items.map((t, j) => <li key={j}>{inline(t, `${k}i${j}`)}</li>)}</ul>);
      continue;
    }
    if (!l.trim()) { i++; continue; }
    const para: string[] = [];
    for (; i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*\||\s*([-*]|\d+\.)\s)/.test(lines[i]); i++) para.push(lines[i]);
    blocks.push(<p key={k}>{inline(para.join(' '), k)}</p>);
  }
  return <>{blocks}</>;
}

/** The text of the `## Summary` section (its heading included), or null when the file has none. */
export function summaryOf(text: string): string | null {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const at = lines.findIndex((l) => /^##\s+Summary\s*$/i.test(l));
  if (at < 0) return null;
  let end = at + 1;
  while (end < lines.length && !/^##\s/.test(lines[end])) end++;
  return lines.slice(at, end).join('\n');
}
