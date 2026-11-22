// Probe: which permission rules does Claude Code itself approve in a headless run (claude -p, default mode)?
// Five tiny sessions, each in a throwaway repo with one allow rule; each asks Claude to run one harmless command.
// Nothing is written outside a temp folder; your own ~/.claude and ~/.claude.json are not touched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) { console.error('set CLAUDE_CODE_OAUTH_TOKEN first'); process.exit(1); }
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kit-probe-')));
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'kitprobe'), '#!/bin/sh\necho "KITPROBE-RAN $*"\n', { mode: 0o755 });
const home = os.homedir();
const lane = '"$HOME/.claude/kit/scripts/lane.js"';
const cases = [
  { id: 1, where: 'project settings, trusted', rule: 'Bash(node "$HOME/.claude/kit/scripts/*)', cmd: `node ${lane} --help` },
  { id: 2, where: 'project settings, trusted', rule: `Bash(node ${home}/.claude/kit/scripts/*)`, cmd: `node ${home}/.claude/kit/scripts/lane.js --help` },
  { id: 3, where: 'project settings, trusted', rule: 'Bash(kitprobe *)', cmd: 'kitprobe lane --help' },
  { id: 4, where: '--settings file, repo not trusted', rule: 'Bash(kitprobe *)', cmd: 'kitprobe lane --help' },
  { id: 5, where: 'no rule (control)', rule: null, cmd: 'kitprobe lane --help' },
];
const out = [];
for (const c of cases) {
  const dir = path.join(tmp, `case${c.id}`);
  const repo = path.join(dir, 'repo');
  const config = path.join(dir, 'config');
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
  fs.mkdirSync(config, { recursive: true });
  spawnSync('git', ['init', '-q', repo]);
  const settings = { permissions: { allow: c.rule ? [c.rule] : [] } };
  const args = ['-p', `Use the Bash tool to run exactly this command, once, with nothing added or changed, then reply DONE:\n${c.cmd}`, '--permission-mode', 'default', '--output-format', 'json'];
  if (c.id === 4) {
    fs.writeFileSync(path.join(dir, 'probe-settings.json'), JSON.stringify(settings));
    args.push('--settings', path.join(dir, 'probe-settings.json'));
    fs.writeFileSync(path.join(config, '.claude.json'), '{}');
  } else {
    fs.writeFileSync(path.join(repo, '.claude', 'settings.json'), JSON.stringify(settings));
    fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true } } }));
  }
  const r = spawnSync('claude', args, { cwd: repo, encoding: 'utf8', timeout: 180000, env: { ...process.env, CLAUDE_CONFIG_DIR: config, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
  let j = null;
  try { j = JSON.parse(r.stdout); } catch { /* not json */ }
  const denials = (j?.permission_denials ?? []).map((d) => d.tool_input?.command ?? JSON.stringify(d.tool_input));
  // what the Bash tool actually returned, from the session transcript
  const results = [];
  const proj = path.join(config, 'projects');
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.jsonl')) files.push(p); } };
  if (fs.existsSync(proj)) walk(proj);
  for (const file of files) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
      let e; try { e = JSON.parse(line); } catch { continue; }
      for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
        if (b.type === 'tool_use') results.push(`CALL ${b.name}: ${JSON.stringify(b.input).slice(0, 200)}`);
        if (b.type === 'tool_result') results.push(`RESULT${b.is_error ? ' (error)' : ''}: ${String(Array.isArray(b.content) ? b.content.map((x) => x.text ?? '').join(' ') : b.content).slice(0, 200).replace(/\s+/g, ' ')}`);
      }
    }
  }
  const ran = results.some((x) => /^RESULT(?! \(error\)).*(KITPROBE-RAN|usage: lane\.js)/.test(x));
  out.push(`case ${c.id} | ${c.where} | rule: ${c.rule ?? 'none'}\n  command: ${c.cmd}\n  VERDICT: ${ran ? 'APPROVED (ran)' : denials.length ? 'DENIED' : 'NOT RUN'}  exit=${r.status}\n  denials: ${JSON.stringify(denials)}\n  ${results.join('\n  ') || '(no tool calls)'}\n  ${r.status !== 0 ? 'stderr: ' + (r.stderr || '').slice(0, 300) : ''}`);
  console.log(`case ${c.id}: ${ran ? 'APPROVED' : denials.length ? 'DENIED' : 'NOT RUN'}`);
}
const report = path.join(home, 'Desktop', 'kit-permission-probe.txt');
const text = `claude ${spawnSync('claude', ['--version'], { encoding: 'utf8' }).stdout.trim()} on ${process.platform}\n\n${out.join('\n\n')}\n`;
fs.writeFileSync(fs.existsSync(path.dirname(report)) ? report : path.join(os.tmpdir(), 'kit-permission-probe.txt'), text.replaceAll(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-[REDACTED]'));
console.log(`report -> ${fs.existsSync(path.dirname(report)) ? report : path.join(os.tmpdir(), 'kit-permission-probe.txt')}`);
fs.rmSync(tmp, { recursive: true, force: true });
