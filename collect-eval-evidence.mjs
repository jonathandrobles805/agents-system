// Collects the evidence from kept eval runs (KIT_EVAL_KEEP=1) into one text file. Read-only; redacts tokens.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const out = [];
const red = (s) => String(s).replace(/sk-ant-[A-Za-z0-9_\-]+/g, 'sk-ant-[REDACTED]').replace(/(token|key|secret)(["'=:\s]+)[A-Za-z0-9_\-]{20,}/gi, '$1$2[REDACTED]');
const clip = (s, n) => { s = red(typeof s === 'string' ? s : JSON.stringify(s)); return s.length > n ? s.slice(0, n) + ' …' : s; };
const dirs = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('kit-eval-')).map((d) => path.join(os.tmpdir(), d)).filter((d) => fs.statSync(d).isDirectory()).sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
function transcripts(home) {
  const p = path.join(home, '.claude', 'projects');
  if (!fs.existsSync(p)) return [];
  return fs.readdirSync(p).flatMap((d) => fs.readdirSync(path.join(p, d)).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(p, d, f)));
}
function showTranscript(file) {
  out.push(`  transcript ${path.basename(file)}`);
  for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    const msg = e.message; if (!msg || !Array.isArray(msg.content)) { if (msg && typeof msg.content === 'string') out.push(`    ${e.type}: ${clip(msg.content, 600)}`); continue; }
    for (const c of msg.content) {
      if (c.type === 'text' && c.text.trim()) out.push(`    ${e.type} text: ${clip(c.text, 800)}`);
      else if (c.type === 'tool_use') out.push(`    TOOL ${c.name}: ${clip(c.input, 400)}`);
      else if (c.type === 'tool_result') out.push(`    RESULT${c.is_error ? ' (error)' : ''}: ${clip(Array.isArray(c.content) ? c.content.map((x) => x.text ?? '').join(' ') : c.content, 400)}`);
    }
  }
}
for (const dir of dirs) {
  out.push(`\n==================== ${path.basename(dir)}`);
  const repo = fs.readdirSync(dir).map((d) => path.join(dir, d)).find((d) => fs.existsSync(path.join(d, '.git')));
  if (repo) {
    try { out.push('git status:\n' + execFileSync('git', ['-C', repo, 'status', '--short'], { encoding: 'utf8' })); } catch (e) { out.push('git status failed'); }
    try { out.push('git log:\n' + execFileSync('git', ['-C', repo, 'log', '--oneline', '-5'], { encoding: 'utf8' })); } catch {}
    const ev = path.join(repo, '.claude', 'session', 'events.jsonl');
    out.push(`events (${ev.replace(dir, '<dir>')}):`);
    if (fs.existsSync(ev)) for (const l of fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean)) { try { const e = JSON.parse(l); out.push(`  ${e.hook ?? ''} ${e.event} ${e.tool ?? ''} ${e.result ?? ''} ${clip(e.path ?? e.command ?? e.summary ?? '', 200)}`); } catch {} }
    else out.push('  (no events file)');
  }
  out.push('--- WORKER');
  for (const t of transcripts(path.join(dir, 'home'))) showTranscript(t);
  out.push('--- JUDGE');
  for (const t of transcripts(path.join(dir, 'judge', 'home'))) showTranscript(t);
}
const file = path.join(os.homedir(), 'Desktop', 'kit-eval-evidence.txt');
fs.writeFileSync(fs.existsSync(path.dirname(file)) ? file : '/tmp/kit-eval-evidence.txt', out.join('\n'));
console.log(`${dirs.length} run folders -> ${fs.existsSync(path.dirname(file)) ? file : '/tmp/kit-eval-evidence.txt'}`);
