#!/usr/bin/env node
// PreToolUse on Bash: block destructive and policy-violating commands. Exit 2 blocks.
//
// Blocked everywhere:
//   git push --force / -f, git push to main/master, git reset --hard, git clean -f, git checkout -- . ,
//   rm -rf on anything outside /tmp or the worktree, sudo, curl|sh / wget|sh, --no-verify,
//   writes into .claude/ or .github/workflows via redirection, sed -i, tee, cp, mv,
//   chmod/chown on .claude/hooks, printing secrets (cat .env), git commit when staged files match secret patterns.
// In a lane additionally: git worktree remove/prune, git branch -D, checkout/switch to another branch.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as K from './kitlib.js';

// The patterns were written for Python's re, where \s and \b are Unicode-aware; JS's are not, so they are spelled out.
const WS = '\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const S = `[${WS}]`; // \s
const B = '(?<![\\p{L}\\p{N}_])'; // \b before a word character
const E = '(?![\\p{L}\\p{N}_])'; // \b after a word character

const rule = (pattern, why) => [new RegExp(pattern, 'u'), why];

export const RULES = [
  rule(`${B}git${S}+push${E}[^|;&]*${S}(--force|-f|--force-with-lease)${E}`, 'force push'),
  rule(`${B}git${S}+push${E}[^|;&]*${S}(origin${S}+)?(main|master)${E}`, 'direct push to main; open a PR'),
  rule(`${B}git${S}+reset${S}+--hard${E}`, 'git reset --hard discards work'),
  rule(`${B}git${S}+clean${S}+-[a-zA-Z]*f`, 'git clean -f deletes untracked files'),
  rule(`${B}git${S}+checkout${S}+--${S}+\\.`, 'git checkout -- . discards all changes'),
  rule(`${B}git${S}+(commit|push|merge|rebase)${E}[^|;&]*--no-verify`, '--no-verify skips hooks'),
  rule(`${B}sudo${E}`, 'sudo'),
  rule(`${B}(curl|wget)${E}[^|;&]*\\|${S}*(ba|z|da)?sh${E}`, 'piping a download into a shell'),
  rule(`(>|>>|${B}tee${E}|${B}sed${S}+-i|${B}cp${E}|${B}mv${E})[^|;&]*\\.claude/`, 'writing into .claude/ (kit configuration)'),
  rule(`(>|>>|${B}tee${E}|${B}sed${S}+-i|${B}cp${E}|${B}mv${E})[^|;&]*\\.github/workflows`, 'writing into CI configuration'),
  rule(`${B}ch(mod|own)${E}[^|;&]*\\.claude/`, 'changing permissions on kit hooks'),
  rule(`${B}(cat|less|more|head|tail|bat|grep|rg)${E}[^|;&]*(\\.env${E}|\\.env\\.|\\.pem${E}|id_rsa|\\.aws/credentials|\\.netrc)`, 'printing a secrets file'),
  rule(`${B}(printenv|env)${S}*$`, 'dumping the environment (may contain secrets)'),
  rule(`${B}echo${S}+\\$\\{?[A-Z_]*(KEY|TOKEN|SECRET|PASSWORD)`, 'echoing a secret variable'),
];
export const LANE_RULES = [
  rule(`${B}git${S}+worktree${S}+(remove|prune)${E}`, 'removing worktrees from inside a lane'),
  rule(`${B}git${S}+branch${S}+-D${E}`, 'deleting branches from inside a lane'),
  rule(`${B}git${S}+(checkout|switch)${S}+(?!-b${E})(?!--${S})[A-Za-z0-9._/-]+${S}*$`, 'switching branches inside a lane; each lane stays on its branch'),
];
export const RM_RF = new RegExp(`${B}rm${S}+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*)${S}+([^\\n]+)`, 'gu');
export const SECRET_CONTENT = /(AKIA[0-9A-Z]{16}|sk_live_[0-9a-zA-Z]{10,}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|ghp_[0-9A-Za-z]{20,}|xox[baprs]-[0-9A-Za-z-]{10,}|AIza[0-9A-Za-z_-]{30,})/;
export const GIT_COMMIT = new RegExp(`${B}git${S}+commit${E}`, 'u');
const WHITESPACE = new RegExp(`${S}+`, 'u');

const inside = (p, root) => p === root || p.startsWith(root.endsWith('/') ? root : root + '/');

/** The reason when an `rm -rf` in `cmd` targets something that must not be deleted, else null. */
export function rmTargetsOk(cmd, root, cwd) {
  for (const m of cmd.matchAll(RM_RF)) {
    for (let tok of m[2].split(WHITESPACE)) {
      if (tok === '' || tok.startsWith('-')) continue;
      tok = K.stripChars(tok, '\'"');
      if (['/', '~', '$HOME', '*', '.', '..'].includes(tok) || (tok.startsWith('/') && !tok.startsWith('/tmp'))) return `rm -rf ${tok}`;
      const target = path.isAbsolute(tok) ? tok : path.join(cwd, tok);
      // Only an explicit absolute /tmp path may be removed outside the project.
      if (!inside(K.realResolve(target), K.realResolve(root)) && !tok.startsWith('/tmp/')) return `rm -rf outside the project: ${tok}`;
      if (tok.startsWith('.git') || tok.startsWith('.claude') || tok.startsWith('docs')) return `rm -rf ${tok}`;
    }
  }
  return null;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
/** stdout of a git command as text; throws when git is missing or the output is not UTF-8 (such files are not scanned). */
function gitText(args, cwd) {
  const r = spawnSync('git', args, { cwd, timeout: 20000, maxBuffer: 1 << 28 });
  if (r.error) throw r.error;
  return utf8.decode(r.stdout);
}

export function stagedSecrets(cwd) {
  let names;
  try {
    names = gitText(['diff', '--cached', '--name-only'], cwd).split(/\s+/).filter(Boolean);
  } catch {
    return [];
  }
  // Path and content patterns: the kit's built-ins plus the floor's (KIT-SPEC 10.9); the project may add in kit.json, never remove.
  const pathPats = K.effectiveSecretPatterns(K.projectRoot(cwd));
  const nameOnly = pathPats.filter((p) => !p.includes('/'));
  const content = new RegExp(`${SECRET_CONTENT.source}|${K.credentialRegex().source}`);
  const hits = [];
  for (const n of names) {
    if (K.globMatch(n, pathPats) || K.globMatch(path.basename(n), nameOnly)) {
      hits.push(`${n} (secret-looking filename)`);
      continue;
    }
    try {
      if (content.test(gitText(['show', `:${n}`], cwd))) hits.push(`${n} (secret-looking content)`);
    } catch {
      // unreadable or binary: skipped
    }
  }
  return hits;
}

export function main() {
  const d = K.readHookInput();
  if (!d || Object.keys(d).length === 0) return 0;
  const cmd = d.tool_input?.command;
  if (typeof cmd !== 'string' || !cmd) return 0;
  const cwd = (typeof d.cwd === 'string' && d.cwd) || '.';
  const root = K.projectRoot(cwd);
  // kill switch (KIT-SPEC 10.13): a STOP flag in the lane's session or the project refuses every mutation
  if (K.isFile(path.join(cwd, '.claude', 'session', 'STOP')) || K.isFile(path.join(root, '.claude', 'STOP'))) {
    process.stderr.write(`guard-bash: the kill switch is set; no mutations until lane.js resume-all --by <name>\n`);
    return 2;
  }
  const lane = K.findLane(cwd);
  const events = lane ? lane.eventsPath : path.join(root, '.claude', 'session', 'events.jsonl');

  const deny = (reason) => {
    K.appendEvent(events, { event: 'blocked', tool: 'Bash', command: [...cmd].slice(0, 200).join(''), result: 'blocked', summary: reason });
    return K.block(`guard-bash: blocked (${reason}).\nCommand: ${cmd}`);
  };

  for (const [re, why] of RULES) if (re.test(cmd)) return deny(why);
  if (lane) for (const [re, why] of LANE_RULES) if (re.test(cmd)) return deny(why);
  const bad = rmTargetsOk(cmd, root, cwd);
  if (bad) return deny(bad);
  if (GIT_COMMIT.test(cmd)) {
    const hits = stagedSecrets(cwd);
    if (hits.length) return deny('staged files look like secrets: ' + hits.join('; '));
  }
  return 0;
}

if (K.isMain(import.meta.url)) K.runGuard('guard-bash', main);
