#!/usr/bin/env node
// PreToolUse on Bash: block destructive and policy-violating commands. Exit 2 blocks.
//
// Blocked everywhere:
//   git push --force / -f, git push to main/master, git reset --hard, git clean -f, git checkout -- . ,
//   rm -rf on anything outside /tmp or the worktree, sudo, curl|sh / wget|sh, --no-verify,
//   writes into .claude/ or .github/workflows via redirection, sed -i, tee, cp, mv,
//   chmod/chown on .claude/hooks, printing secrets (cat .env), git commit when staged files match secret patterns,
//   merging a PR directly (gh pr merge, gh api PUT …/merge, GraphQL mergePullRequest): lane.js merge waits for CI,
//   and the owner's decisions through `kit` (merge, resume-all, bootstrap) in any form the permission ask rule misses.
// In a lane additionally: git worktree remove/prune, git branch -D, checkout/switch to another branch.
// In a lane, a call that is let through has the worktree's state recorded first, so post-edit-check can tell what the
// call itself changed (shell_changes.js).
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as K from './kitlib.js';
import { recordBefore } from './shell_changes.js';

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
  // Merging goes through `lane.js merge`, which waits for every required check (#68). Anchored at the start of a
  // command (line start, after ; & | ( or $( ), so the words inside a quoted PR or issue body do not match.
  rule(`(?:^|[\n;&|(]|\\$\\()${S}*gh${S}+pr${S}+merge${E}`, 'merging a PR directly; run kit lane merge <slug> --by <name>, which waits for CI to pass'),
  rule(`(?:^|[\n;&|(]|\\$\\()${S}*gh${S}+api${E}(?=[^|;&\n]*(?:-X${S}*|--method[=${WS}]${S}*)PUT${E})(?=[^|;&\n]*pulls/[^/${WS}]+/merge${E})`, 'merging a PR through the API; run kit lane merge <slug> --by <name>, which waits for CI to pass'),
  rule(`(?:^|[\n;&|(]|\\$\\()${S}*gh${S}+api${S}+graphql${E}[^|;&]*mergePullRequest`, 'merging a PR through GraphQL; run kit lane merge <slug> --by <name>, which waits for CI to pass'),
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
/**
 * Fetching by hand. KIT-SPEC 10.1 denies curl and wget "unless the spec declares network access", and that
 * condition is why the rule lives here and not in permissions.deny: a deny rule is unconditional, and it beats an
 * allow rule, a hook's "allow" and every permission mode, so a project-level entry would also refuse the lane whose
 * spec does declare a domain. Claude Code's own docs point at a PreToolUse hook for exactly this, and note that a
 * text rule is not a boundary around a program anyway: `/usr/bin/curl` and `sh -c 'curl …'` do not match it
 * [docs: https://code.claude.com/docs/en/permissions.md @ 2026-11-13]. The boundary is the sandbox's network
 * allowlist, which is built from the same declaration (sandbox.js sandboxConfig); this rule makes the lane's intent
 * reviewable and keeps the two from disagreeing.
 */
export const FETCH = new RegExp(`${B}(curl|wget)${E}`, 'u');
export const URL_IN = /(?:https?:\/\/|\/\/)([A-Za-z0-9._-]+\.[A-Za-z]{2,})/gu;

/** The reason a fetch must not run in this lane, or null when every host it names is declared. */
/**
 * The simple commands of a shell line, each a list of words `{ value, raw, start, end }` (offsets into `line`), split
 * on `; & | ( )`, and newlines outside quotes (a backtick stays in its word, so it is never plain). Quotes and backslashes are removed from `value` and kept in
 * `raw`. Redirections (`>f`, `2>&1`, `<f`) are dropped with their target. `cont` marks a command continued over a
 * backslash-newline. Command substitutions inside double quotes are not split here; `substitutionBodies` finds them.
 */
export function shellCommands(line) {
  const cmds = [];
  let words = [];
  let cont = false;
  let cur = null;
  let q = null;
  let redirect = false;
  const word = (i) => (cur = cur ?? { value: '', raw: '', start: i, end: i });
  const endWord = () => {
    if (cur !== null && !redirect) words.push(cur);
    else if (cur !== null) redirect = false;
    cur = null;
  };
  const endCmd = () => {
    endWord();
    redirect = false;
    if (words.length) cmds.push(Object.assign(words, { cont }));
    words = [];
    cont = false;
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      cur.raw += c;
      cur.end = i + 1;
      if (c === q) q = null;
      else if (c === '\\' && q === '"' && i + 1 < line.length) (cur.value += line[++i]), (cur.raw += line[i]), (cur.end = i + 1);
      else cur.value += c;
      continue;
    }
    if (c === '\\' && line[i + 1] === '\n') {
      endWord();
      cont = true;
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      word(i);
      cur.raw += c;
      cur.end = i + 1;
      q = c;
      continue;
    }
    if (c === '\\' && i + 1 < line.length) {
      word(i);
      cur.raw += c + line[i + 1];
      cur.value += line[++i];
      cur.end = i + 1;
      continue;
    }
    if (c === '>' || c === '<') {
      if (cur !== null && /^\d+$/.test(cur.raw)) cur = null; // the fd of `2>`
      endWord();
      while ('<>&|'.includes(line[i + 1] ?? 'x') && line[i + 1] !== undefined) i++;
      redirect = true;
      continue;
    }
    if (';&|\n()'.includes(c)) {
      endCmd();
      continue;
    }
    if (/\s/.test(c)) {
      endWord();
      continue;
    }
    word(i);
    cur.raw += c;
    cur.value += c;
    cur.end = i + 1;
  }
  endCmd();
  return cmds;
}

/** The bodies of every `$(…)` and `` `…` `` in a line, outside single quotes (inside double quotes too). */
export function substitutionBodies(line) {
  const out = [];
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && q !== "'") { i++; continue; }
    if (q === "'") { if (c === "'") q = null; continue; }
    if (c === "'" && !q) { q = "'"; continue; }
    if (c === '"') { q = q ? null : '"'; continue; }
    if (c === '`') {
      let j = i + 1;
      while (j < line.length && line[j] !== '`') j += line[j] === '\\' ? 2 : 1;
      out.push(line.slice(i + 1, j));
      i = j;
      continue;
    }
    if (c === '$' && line[i + 1] === '(') {
      let depth = 1;
      let j = i + 2;
      let sq = false;
      for (; j < line.length && depth; j++) {
        if (line[j] === "'") sq = !sq;
        else if (!sq && line[j] === '\\') j++;
        else if (!sq && line[j] === '(') depth++;
        else if (!sq && line[j] === ')') depth--;
      }
      out.push(line.slice(i + 2, depth ? j : j - 1));
      i = (depth ? j : j - 1);
    }
  }
  return out;
}

/** The here-doc delimiters a line opens: `<<` outside quotes, comments and `((…))`, and not part of `<<<`. */
function heredocDelims(text) {
  const out = [];
  let q = null;
  let arith = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '\\' && q === '"') i++;
      else if (c === q) q = null;
      continue;
    }
    if (c === '\\') { i++; continue; }
    if (c === "'" || c === '"') { q = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) break;
    if (c === '(' && text[i + 1] === '(') { arith++; i++; continue; }
    if (c === ')' && text[i + 1] === ')' && arith) { arith--; i++; continue; }
    if (c === '<' && text[i + 1] === '<' && text[i + 2] !== '<' && text[i - 1] !== '<' && !arith) {
      const m = /^<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(text.slice(i));
      if (m) { out.push(m[2]); i += m[0].length - 1; }
    }
  }
  return out;
}

/**
 * The line with each here-doc's body removed (text such as a commit message, not commands; a known miss when one is
 * fed to a shell). A body is removed only when its closing delimiter is found; otherwise every line is kept.
 */
export function withoutHeredocBodies(line) {
  const lines = line.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    for (const d of heredocDelims(lines[i])) {
      let j = i + 1;
      while (j < lines.length && lines[j].replace(/^\t+/, '') !== d) j++;
      if (j >= lines.length) continue; // no closing line: keep the rest as commands
      out.push(lines[j]);
      i = j;
    }
  }
  return out.join('\n');
}

// what may stand before the program in a simple command: assignments, the wrappers Claude Code strips (and env/exec),
// their options and the plain values those options take
const BEFORE_PROGRAM = /^(!|\{|if|then|else|elif|do|while|until|[A-Za-z_][A-Za-z0-9_]*=.*|timeout|time|nice|nohup|stdbuf|command|builtin|noglob|xargs|env|exec|-.*|[0-9.]+[smhd]?|[A-Z]+)$/;
const DECISIONS = [['bootstrap'], ['lane', 'merge'], ['lane', 'resume-all'], ['lane', 'signoff']];

/**
 * Why a line runs a kit command in a form Claude Code's ask rules (`Bash(kit lane merge *)`, …) might not match, or
 * null. `kit` counts only where it is the program of a simple command (after assignments and wrappers), in the line
 * or in any command substitution. Such a command must name its script, and for `lane` its subcommand, as plain
 * lowercase words; an owner's decision must be written exactly `kit lane merge` (single spaces, nothing between; what follows is the
 * ask rule's `*`); it
 * must not run through xargs or continue over a backslash-newline. A guardrail for common forms: the shell is parsed only
 * approximately (comments, here-docs, `$'…'`, `&>` and `xargs -I` are known misses); the ask rule and your prompt are the
 * control, and the container (Step 8) is the wall.
 */
export function kitDecisionDisguised(line, depth = 0) {
  line = withoutHeredocBodies(line);
  for (const words of shellCommands(line)) {
    const k = words.findIndex((w, i) => (w.value === 'kit' || w.raw === 'kit') && words.slice(0, i).every((x) => BEFORE_PROGRAM.test(x.value)));
    if (k < 0) continue;
    const plainWord = (w, re) => w !== undefined && w.raw === w.value && re.test(w.value);
    if (words.slice(0, k).some((w) => w.value === 'xargs')) return 'running kit through xargs (its arguments are not visible to the permission prompt); run the kit command directly';
    const [kitWord, script, sub] = [words[k], words[k + 1], words[k + 2]];
    if (kitWord.raw !== 'kit') return `the kit command written in a quoted or escaped form (${kitWord.raw}); write it plainly as \`kit <script> …\``;
    if (words.cont) return 'a kit command continued over a backslash-newline; write it on one line';
    if (script === undefined || (script.raw === script.value && /^(-h|--help)$/.test(script.value))) continue;
    if (script.raw === script.value && /^[a-z0-9_-]+$/.test(script.value) && script.value.includes('-')) return `kit script names use _ not - (${script.value}); run \`kit ${script.value.replace(/-/g, '_')} …\``;
    if (!plainWord(script, /^[a-z0-9_]+$/)) return `a kit script name written in a computed or quoted form (${script.raw}); write it plainly as \`kit <script> …\``;
    if (script.value === 'lane' && sub !== undefined && !plainWord(sub, /^[a-z][a-z0-9-]*$/)) return `a kit lane subcommand written in a computed or quoted form (${sub.raw}); write it plainly as \`kit lane <subcommand> …\``;
    const decision = DECISIONS.find((d) => d.every((x, i) => words[k + 1 + i]?.value === x));
    if (decision) {
      const want = ['kit', ...decision].join(' ');
      if (line.slice(kitWord.start, words[k + decision.length].end) !== want) return `the owner's decision (${want}) written with extra spacing or text between its words; write it plainly as \`${want} …\``;
    }
  }
  if (depth < 4) for (const body of substitutionBodies(line)) {
    const why = kitDecisionDisguised(body, depth + 1);
    if (why) return why;
  }
  return null;
}

export function fetchOk(cmd, specPath) {
  if (!FETCH.test(cmd)) return null;
  const declared = K.specNetwork(specPath);
  if (declared.includes('*')) return null;
  const hosts = [...new Set([...cmd.matchAll(URL_IN)].map((m) => m[1].toLowerCase()))];
  if (!hosts.length) return 'fetching with curl/wget; the spec must declare the host under `## Network`';
  const undeclared = hosts.filter((h) => !declared.includes(h));
  if (!undeclared.length) return null;
  return `fetching ${undeclared.join(', ')}; the lane's spec declares ${declared.length ? declared.join(', ') : 'no network access'}`;
}
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
    process.stderr.write(`guard-bash: the kill switch is set; no mutations until kit lane resume-all --by <name>\n`);
    return 2;
  }
  // A Bash call carries no file path, so a subagent -- which reports the main repo as cwd -- resolves only by
  // tier 3. Until it did, every lane rule below (the branch rules and the spec's network declaration) was off for
  // the tester, implementer and reviewer.
  //
  // Ambiguity is the one place here that does NOT fail closed, and the reason is in the rules themselves: they
  // only ADD restrictions, so with two open lanes and no worktree there is no lane whose rules apply, and blocking
  // every Bash call in a repository that is allowed two concurrent lanes by default would stop all work. The
  // residue is real and is recorded as an event: with 2+ open lanes a subagent's Bash runs under the project rules
  // alone. Closing it needs a session-to-lane record, which the kit does not keep.
  const r = K.laneForHook(d);
  const lane = r.lane;
  const events = lane ? lane.eventLogPath : path.join(root, '.claude', 'session', 'events.jsonl');
  if (r.via === 'ambiguous') {
    K.appendEvent(events, { event: 'lane_unresolved', tool: 'Bash', result: 'ok', summary: `${r.slugs.length} lanes open (${r.slugs.join(', ')}); lane rules not applied` });
  }

  const deny = (reason) => {
    K.appendEvent(events, { event: 'blocked', tool: 'Bash', command: [...cmd].slice(0, 200).join(''), result: 'blocked', summary: reason });
    return K.block(`guard-bash: blocked (${reason}).\nCommand: ${cmd}`);
  };

  for (const [re, why] of RULES) if (re.test(cmd)) return deny(why);
  const disguised = kitDecisionDisguised(cmd);
  if (disguised) return deny(disguised);
  if (lane) for (const [re, why] of LANE_RULES) if (re.test(cmd)) return deny(why);
  const bad = rmTargetsOk(cmd, root, cwd);
  if (bad) return deny(bad);
  // A lane fetches only what its own spec declares. Outside a lane this rule has nothing to evaluate against -- the
  // condition KIT-SPEC 10.1 states is the lane's spec -- and a human's session in a bootstrapped repo is not a lane,
  // so their own curl is left alone. The other rules above are unconditional and apply to every session.
  if (lane) {
    const fetch = fetchOk(cmd, lane.specPath);
    if (fetch) return deny(fetch);
  }
  if (GIT_COMMIT.test(cmd)) {
    const hits = stagedSecrets(cwd);
    if (hits.length) return deny('staged files look like secrets: ' + hits.join('; '));
  }
  // The call goes ahead: record the lane's state for post-edit-check, which reports only what changed during the call
  // (shell_changes.js). Taken here because every session that runs Bash in a lane, from the project's settings or an
  // agent's frontmatter, registers this hook. A failure only costs post-edit-check its best baseline, so it never
  // blocks the command.
  try {
    recordBefore(d);
  } catch {
    // post-edit-check falls back to the lane's last known state
  }
  return 0;
}

if (K.isMain(import.meta.url)) K.runGuard('guard-bash', main);
