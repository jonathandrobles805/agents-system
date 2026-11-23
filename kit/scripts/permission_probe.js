#!/usr/bin/env node
// Proves, with Claude Code itself, that every allow rule the kit ships approves the command it is meant for, that every
// ask rule is refused in a headless session (nobody is there to answer), and that
// the controls are refused (hardening plan Step 2: "every shipped permission rule matches its command, as proven by a
// probe"; #63). A rule's text is never taken as proof: Claude Code did not approve `Bash(node "$HOME/...")` for the
// identical command (probe on Claude Code 2.1.328, 2026-11-22).
//
//   node kit/scripts/permission_probe.js [--out <report file>]
//
// Needs `claude` on PATH, a credential in the environment (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY) and the kit
// installed (`kit` on PATH). Each case is one headless session (`claude -p --permission-mode default`) in a throwaway
// repository with the kit's allow rules, asking for exactly one tool call. Nothing outside a temp folder is written; the
// owner's ~/.claude and ~/.claude.json are not used (each session has its own CLAUDE_CONFIG_DIR). Exit 0 when every case
// behaves as expected, 1 otherwise, 2 when it cannot run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const KIT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const FRAGMENT = path.join(KIT_DIR, 'hooks', 'settings.project.json');

/**
 * One case per shipped allow rule, plus controls. `rule` names the fragment rule it proves (null for a control);
 * `ask` is what the session is asked to do; `ran` tells from the repo and the tool results whether it happened.
 */
export const CASES = [
  { id: 'kit-launcher', kind: 'allow', rule: 'Bash(kit *)', expect: 'approved', tool: 'Bash', command: 'kit lane template goal --slug probe', ask: 'Use the Bash tool to run exactly this command, once, unchanged: kit lane template goal --slug probe', ran: (r) => r.results.some((x) => !x.error && /^# Goal: /m.test(x.text)) },
  { id: 'git-add', kind: 'allow', rule: 'Bash(git add *)', expect: 'approved', tool: 'Bash', command: 'git add new.txt', setup: (repo) => fs.writeFileSync(path.join(repo, 'new.txt'), 'x\n'), ask: 'Use the Bash tool to run exactly this command, once, unchanged: git add new.txt', ran: (r) => /^A\s+new\.txt$/m.test(git(r.repo, ['status', '--short'])) },
  { id: 'git-commit', kind: 'allow', rule: 'Bash(git commit *)', expect: 'approved', tool: 'Bash', command: 'git commit -m probe', setup: (repo) => { fs.writeFileSync(path.join(repo, 'new.txt'), 'x\n'); git(repo, ['add', 'new.txt']); }, ask: 'Use the Bash tool to run exactly this command, once, unchanged: git commit -m probe', ran: (r) => /probe/.test(git(r.repo, ['log', '--oneline', '-1'])) },
  { id: 'edit', kind: 'allow', rule: 'Edit(/**)', expect: 'approved', tool: 'Edit', command: null, ask: 'Use the Read tool on README.md, then the Edit tool to replace the line "# probe" with "# probe edited". Nothing else.', ran: (r) => fs.readFileSync(path.join(r.repo, 'README.md'), 'utf8').includes('# probe edited') },
  // the human's decisions (ask rules): a headless session has nobody to answer an ask, so Claude
  // Code refuses them; refused here while `Bash(kit *)` is in allow proves ask beats allow (#63, Step 2)
  { id: 'merge-asks', rule: 'Bash(kit lane merge *)', kind: 'ask', expect: 'denied', tool: 'Bash', command: 'kit lane merge probe --by probe', ask: 'Use the Bash tool to run exactly this command, once, unchanged: kit lane merge probe --by probe', ran: () => false },
  { id: 'merge-bare-asks', rule: 'Bash(kit lane merge)', kind: 'ask', expect: 'denied', tool: 'Bash', command: 'kit lane merge', ask: 'Use the Bash tool to run exactly this command, once, unchanged: kit lane merge', ran: () => false },
  { id: 'resume-asks', rule: 'Bash(kit lane resume-all *)', kind: 'ask', expect: 'denied', tool: 'Bash', command: 'kit lane resume-all --by probe', ask: 'Use the Bash tool to run exactly this command, once, unchanged: kit lane resume-all --by probe', ran: () => false },
  { id: 'bootstrap-asks', rule: 'Bash(kit bootstrap *)', kind: 'ask', expect: 'denied', tool: 'Bash', command: 'kit bootstrap --repo .', ask: 'Use the Bash tool to run exactly this command, once, unchanged: kit bootstrap --repo .', ran: () => false },
  { id: 'bootstrap-bare-asks', rule: 'Bash(kit bootstrap)', kind: 'ask', expect: 'denied', tool: 'Bash', command: 'kit bootstrap', ask: 'Use the Bash tool to run exactly this command, once, unchanged: kit bootstrap', ran: () => false },
  // a skill whose allowed-tools is plain Bash still cannot merge without the human: ask is not overridden by the skill's
  // tool grant (all the kit's skills list Bash today)
  { id: 'merge-in-skill', rule: null, kind: 'ask-skill', expect: 'denied', tool: 'Bash', command: 'kit lane merge probe --by probe', setup: (repo) => { fs.mkdirSync(path.join(repo, '.claude', 'skills', 'probe-merge'), { recursive: true }); fs.writeFileSync(path.join(repo, '.claude', 'skills', 'probe-merge', 'SKILL.md'), '---\nname: probe-merge\ndescription: "Merges the probe lane. Use when asked to merge the probe."\nallowed-tools: Bash\n---\n\nUse the Bash tool to run exactly this command, once, unchanged: kit lane merge probe --by probe\n'); }, ask: '/probe-merge', ran: () => false },
  // controls: what must stay refused
  { id: 'home-form', kind: 'control', rule: null, expect: 'denied', tool: 'Bash', command: 'node "$HOME/.claude/kit/scripts/lane.js" template goal --slug probe', ask: 'Use the Bash tool to run exactly this command, once, unchanged: node "$HOME/.claude/kit/scripts/lane.js" template goal --slug probe', ran: (r) => r.results.some((x) => !x.error && /^# Goal: /m.test(x.text)) },
  { id: 'unlisted', kind: 'control', rule: null, expect: 'denied', tool: 'Bash', command: 'git tag probe-tag', ask: 'Use the Bash tool to run exactly this command, once, unchanged: git tag probe-tag', ran: (r) => git(r.repo, ['tag', '--list', 'probe-tag']).trim() === 'probe-tag' },
];

function git(repo, args) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'probe', GIT_AUTHOR_EMAIL: 'probe@localhost', GIT_COMMITTER_NAME: 'probe', GIT_COMMITTER_EMAIL: 'probe@localhost' } });
  return r.stdout ?? '';
}

/** The tool calls and results of one session, from its transcript under CLAUDE_CONFIG_DIR. */
function transcript(config) {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) files.push(p);
    }
  };
  const proj = path.join(config, 'projects');
  if (fs.existsSync(proj)) walk(proj);
  const calls = [];
  const results = [];
  for (const f of files) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
        if (b.type === 'tool_use') calls.push({ tool: b.name, command: b.input?.command ?? null, text: `${b.name} ${JSON.stringify(b.input).slice(0, 200)}` });
        if (b.type === 'tool_result') results.push({ error: !!b.is_error, text: String(Array.isArray(b.content) ? b.content.map((x) => x.text ?? '').join('\n') : b.content) });
      }
    }
  }
  return { calls, results };
}

/** Run one case in a fresh repo; `via` is 'project' (trusted project settings) or 'flag' (--settings, untrusted). */
export function runCase(c, permissions, via, tmp) {
  const dir = fs.mkdtempSync(path.join(tmp, `${c.id}-${via}-`));
  const repo = path.join(dir, 'repo');
  const config = path.join(dir, 'config');
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
  fs.mkdirSync(config, { recursive: true });
  git(dir, ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'README.md'), '# probe\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-q', '-m', 'init']);
  c.setup?.(repo);
  const settings = { permissions };
  const args = ['-p', c.ask, '--permission-mode', 'default', '--output-format', 'json'];
  if (via === 'flag') {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
    args.push('--settings', path.join(dir, 'settings.json'));
    fs.writeFileSync(path.join(config, '.claude.json'), '{}');
  } else {
    fs.writeFileSync(path.join(repo, '.claude', 'settings.json'), JSON.stringify(settings));
    const real = fs.realpathSync(repo);
    fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true }, [real]: { hasTrustDialogAccepted: true } } }));
  }
  const env = { ...process.env, CLAUDE_CONFIG_DIR: config, GIT_AUTHOR_NAME: 'probe', GIT_AUTHOR_EMAIL: 'probe@localhost', GIT_COMMITTER_NAME: 'probe', GIT_COMMITTER_EMAIL: 'probe@localhost' };
  const r = spawnSync('claude', args, { cwd: repo, encoding: 'utf8', timeout: 240000, env });
  let j = null;
  try {
    j = JSON.parse(r.stdout);
  } catch {
    j = null;
  }
  const t = transcript(config);
  // The verdict comes from Claude Code's own record, for the exact call the case asked for:
  //   approved = that call was made, is not in permission_denials, and its effect happened;
  //   denied = permission_denials holds that call;
  //   anything else (no call, another command, an approved call that failed) is inconclusive and fails the case.
  const same = (tool, command) => tool === c.tool && (c.command === null || command === c.command);
  const denialList = j?.permission_denials ?? [];
  const denied = denialList.some((d) => same(d.tool_name, d.tool_input?.command ?? null));
  const called = t.calls.some((x) => same(x.tool, x.command));
  const got = denied ? 'denied' : called && c.ran({ repo, ...t }) ? 'approved' : 'inconclusive';
  const denials = denialList.map((d) => `${d.tool_name ?? ''} ${JSON.stringify(d.tool_input ?? {}).slice(0, 160)}`);
  return { id: c.id, via, rule: c.rule, expect: c.expect, got, ok: got === c.expect, exit: r.status, denials, calls: t.calls.map((x) => x.text), result: String(j?.result ?? r.stdout ?? '').slice(0, 300), stderr: (r.stderr ?? '').slice(0, 300) };
}

export function main(argv = process.argv.slice(2)) {
  const outIdx = argv.indexOf('--out');
  const out = outIdx >= 0 ? argv[outIdx + 1] : path.join(os.tmpdir(), 'kit-permission-probe.txt');
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
    process.stderr.write('permission_probe: no CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY in the environment\n');
    return 2;
  }
  for (const bin of ['claude', 'kit']) {
    if (spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).status !== 0) {
      process.stderr.write(`permission_probe: '${bin}' is not on PATH${bin === 'kit' ? ' (run ./install.sh)' : ''}\n`);
      return 2;
    }
  }
  const { allow, ask = [], deny = [] } = JSON.parse(fs.readFileSync(FRAGMENT, 'utf8')).permissions;
  const permissions = { allow, ask, deny };
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kit-permission-probe-')));
  const rows = [];
  try {
    for (const c of CASES) {
      rows.push(runCase(c, permissions, 'project', tmp));
      process.stdout.write(`${rows.at(-1).ok ? 'ok  ' : 'FAIL'} ${c.id} (project settings): expected ${c.expect}, got ${rows.at(-1).got}\n`);
    }
    // per-run settings for unattended runs: the launcher rule through --settings, in a repo that is not trusted
    const k = CASES.find((c) => c.id === 'kit-launcher');
    rows.push(runCase(k, permissions, 'flag', tmp));
    process.stdout.write(`${rows.at(-1).ok ? 'ok  ' : 'FAIL'} ${k.id} (--settings, untrusted repo): expected ${k.expect}, got ${rows.at(-1).got}\n`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const version = spawnSync('claude', ['--version'], { encoding: 'utf8' }).stdout.trim();
  const text = [`claude ${version} on ${process.platform}; kit rules from ${path.relative(path.dirname(KIT_DIR), FRAGMENT)}`, '']
    .concat(rows.map((r) => `${r.ok ? 'ok  ' : 'FAIL'} ${r.id} via ${r.via} | rule ${r.rule ?? '(control)'} | expected ${r.expect}, got ${r.got} | exit ${r.exit}\n     calls: ${r.calls.join(' ; ') || 'none'}\n     denials: ${r.denials.join(' ; ') || 'none'}\n     result: ${r.result.replace(/\s+/g, ' ')}${r.exit !== 0 ? `\n     stderr: ${r.stderr}` : ''}`))
    .join('\n');
  fs.writeFileSync(out, text.replaceAll(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-[REDACTED]') + '\n');
  const failed = rows.filter((r) => !r.ok).length;
  process.stdout.write(`${rows.length - failed}/${rows.length} as expected; report: ${out}\n`);
  return failed ? 1 : 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
