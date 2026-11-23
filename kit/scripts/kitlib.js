// Shared helpers for kit scripts. Node >= 20, standard library only.
// Behaviour (exit codes, stdout/stderr text, file formats) is identical to the former Python implementation.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Regexes. Python's \b is Unicode-aware; JS's is ASCII-only, so word boundaries are spelled out.
// ---------------------------------------------------------------------------
const WB_START = '(?<![\\p{L}\\p{N}_])';
const WB_END = '(?![\\p{L}\\p{N}_])';

export const HEDGE_WORDS = new RegExp(
  `${WB_START}(should|probably|likely|i think|i assume|assume|assuming|presumably|might be|seems to|appears to)${WB_END}`,
  'iu',
);
export const PLACEHOLDER = /\{\{[^}]*\}\}/;

export const TAG_VERIFIED_LINES = /\[verified:\s*([^\]\s:]+):(\d+)(?:-(\d+))?\]/;
export const TAG_VERIFIED_CMD = /\[verified:\s*cmd\]/;
export const TAG_DOCS = /\[docs:\s*(\S+)\s*@\s*([^\]]+)\]/;
export const TAG_INFERRED = /\[inferred:\s*from\s+([^\]]+)\]/;
export const TAG_UNKNOWN = /\[unknown\]/;
export const ANY_TAG = new RegExp(`\\[(verified|docs|inferred|unknown)${WB_END}[^\\]]*\\]`, 'u');

export const DEFAULT_HIGH_RISK_PATHS = ['auth', 'payment', 'billing', 'migration', 'migrations', 'infra', 'deploy', 'secrets', 'public-api', 'api/public'];
export const HIGH_RISK_KEYWORDS = new RegExp(
  `${WB_START}(auth(entication|orization)?|payment|billing|delete|drop table|migration|public api|secret|credential|token)${WB_END}`,
  'iu',
);

// ---------------------------------------------------------------------------
// Python-compatible primitives
// ---------------------------------------------------------------------------

/** Python str.splitlines(): splits on \n \r \r\n \v \f \x1c \x1d \x1e \x85 \u2028 \u2029, no trailing empty item. */
export function splitlines(s) {
  if (s === '') return [];
  const parts = s.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** Python str.strip(chars): remove any of `chars` from both ends. */
export function stripChars(s, chars) {
  const set = new Set(chars);
  let a = 0;
  let b = s.length;
  while (a < b && set.has(s[a])) a++;
  while (b > a && set.has(s[b - 1])) b--;
  return s.slice(a, b);
}

/** Python fnmatch.fnmatchcase on POSIX: '*' matches everything including '/', '?', '[seq]', '[!seq]'. */
export function fnmatch(name, pat) {
  let re = '';
  let i = 0;
  const n = pat.length;
  while (i < n) {
    const c = pat[i++];
    if (c === '*') {
      re += '.*';
      while (i < n && pat[i] === '*') i++;
    } else if (c === '?') {
      re += '.';
    } else if (c === '[') {
      let j = i;
      if (j < n && pat[j] === '!') j++;
      if (j < n && pat[j] === ']') j++;
      while (j < n && pat[j] !== ']') j++;
      if (j >= n) {
        re += '\\[';
      } else {
        let body = pat.slice(i, j);
        i = j + 1;
        const neg = body[0] === '!';
        if (neg) body = body.slice(1);
        body = body.replace(/[\\\][]/g, '\\$&');
        if (!neg && body[0] === '^') body = '\\' + body;
        if (body === '') re += neg ? '.' : '(?!)';
        else re += `[${neg ? '^' : ''}${body}]`;
      }
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    }
  }
  return new RegExp(`^(?:${re})$`, 's').test(name);
}

/** Local time as Python's datetime.now().isoformat(timespec="seconds"), e.g. 2026-11-08T10:00:00. */
export function isoSeconds(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getFullYear(), 4)}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function pyString(s, ensureAscii) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const code = s.charCodeAt(i);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (code < 0x20 || (ensureAscii && code > 0x7e)) out += '\\u' + code.toString(16).padStart(4, '0');
    else out += ch;
  }
  return out + '"';
}

/**
 * Python-compatible json.dumps: ", " and ": " separators, optional indent, ensure_ascii.
 * Keeps generated files and hook output byte-identical to what the Python kit wrote.
 */
export function jsonDumps(value, { indent = null, ensureAscii = true, sortKeys = false } = {}) {
  const step = indent == null ? null : ' '.repeat(indent);
  const enc = (v, level) => {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null';
    if (typeof v === 'string') return pyString(v, ensureAscii);
    if (typeof v.toJSON === 'function') return enc(v.toJSON(), level);
    const nl = step === null ? '' : '\n' + step.repeat(level + 1);
    const nlEnd = step === null ? '' : '\n' + step.repeat(level);
    const sep = step === null ? ', ' : ',' + nl;
    if (Array.isArray(v)) {
      if (v.length === 0) return '[]';
      return '[' + nl + v.map((x) => enc(x, level + 1)).join(sep) + nlEnd + ']';
    }
    let keys = Object.keys(v);
    if (sortKeys) keys = keys.sort();
    if (keys.length === 0) return '{}';
    return '{' + nl + keys.map((k) => pyString(k, ensureAscii) + ': ' + enc(v[k], level + 1)).join(sep) + nlEnd + '}';
  };
  return enc(value, 0);
}

/** Python's `if __name__ == "__main__"`: true when `metaUrl` (import.meta.url) is the script node was started with. Follows symlinks. */
export function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

export function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Python Path.resolve(): absolute, symlinks resolved for the part that exists, rest kept as is. */
export function realResolve(p) {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch {
    const parent = path.dirname(abs);
    if (parent === abs) return abs;
    return path.join(realResolve(parent), path.basename(abs));
  }
}

const toPosix = (p) => p.split(path.sep).join('/');

// ---------------------------------------------------------------------------
// Violations and markdown parsing
// ---------------------------------------------------------------------------

export class Violation {
  constructor(p, line, rule, message) {
    this.path = p;
    this.line = line;
    this.rule = rule;
    this.message = message;
  }

  toString() {
    return `${this.path}:${this.line}: ${this.rule}: ${this.message}`;
  }
}

export class Section {
  /** @param {string} title @param {number} start 1-based heading line */
  constructor(title, start) {
    this.title = title;
    this.start = start;
    /** @type {Array<[number, string]>} (lineno, text) */
    this.lines = [];
  }

  /** @returns {Array<[number, string]>} */
  bullets() {
    return this.lines.filter(([, t]) => t.trimStart().startsWith('- '));
  }

  /** @returns {Array<[number, string[]]>} table rows without the header row */
  tableRows() {
    const rows = [];
    for (const [n, t] of this.lines) {
      const s = t.trim();
      if (s.startsWith('|') && !/^\|\s*-{2,}/.test(s)) {
        const cells = s.replace(/^\|+|\|+$/g, '').split('|').map((c) => c.trim());
        rows.push([n, cells]);
      }
    }
    return rows.length ? rows.slice(1) : [];
  }

  text() {
    return this.lines.map(([, t]) => t).join('\n');
  }
}

export function readLines(p) {
  return splitlines(fs.readFileSync(p, 'utf8'));
}

/** Split a markdown document into '## ' sections. Keys are lowercase titles. Returns Map<string, Section>. */
export function parseSections(lines) {
  const sections = new Map();
  let current = null;
  let inFence = false;
  lines.forEach((raw, idx) => {
    const i = idx + 1;
    if (raw.trim().startsWith('```')) inFence = !inFence;
    if (!inFence && raw.startsWith('## ')) {
      current = new Section(raw.slice(3).trim(), i);
      sections.set(current.title.toLowerCase(), current);
      return;
    }
    if (current !== null) current.lines.push([i, raw]);
  });
  return sections;
}

/** Collect '- Key: value' lines before the first '## ' heading. Returns Map<string, [lineno, value]>. */
export function headerFields(lines) {
  const fields = new Map();
  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx];
    if (raw.startsWith('## ')) break;
    const m = /^-\s*([A-Za-z][A-Za-z ]*):\s*(.*)$/.exec(raw);
    if (m) fields.set(m[1].trim().toLowerCase(), [idx + 1, m[2].trim()]);
  }
  return fields;
}

export function stripHtmlComments(lines) {
  const out = [];
  let inComment = false;
  for (const raw of lines) {
    let s = raw;
    if (inComment) {
      if (s.includes('-->')) {
        s = s.slice(s.indexOf('-->') + 3);
        inComment = false;
      } else {
        out.push('');
        continue;
      }
    }
    while (s.includes('<!--')) {
      const at = s.indexOf('<!--');
      const before = s.slice(0, at);
      const rest = s.slice(at + 4);
      if (rest.includes('-->')) {
        s = before + rest.slice(rest.indexOf('-->') + 3);
      } else {
        s = before;
        inComment = true;
        break;
      }
    }
    out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------------------
// git + paths
// ---------------------------------------------------------------------------

/** Run git and return stdout. Throws (like subprocess.CalledProcessError) on a non-zero exit. */
export function git(args, cwd, env) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 512 * 1024 * 1024,
    ...(env ? { env } : {}),
  });
}

export function repoRoot(start) {
  const dir = isDir(start) ? start : path.dirname(start);
  try {
    return git(['rev-parse', '--show-toplevel'], dir).trim();
  } catch {
    return dir;
  }
}

/** Lines of a file at a commit (or the working tree). null if missing. */
export function fileLinesAt(root, rel, commit) {
  if (commit) {
    try {
      return splitlines(git(['show', `${commit}:${rel}`], root));
    } catch {
      return null;
    }
  }
  const p = path.join(root, rel);
  if (!isFile(p)) return null;
  try {
    return splitlines(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function normalize(s) {
  return s.replace(/\s+/g, ' ').trim();
}

/** A decoded JSON value if it is a plain object, else {} (null, lists and scalars are not usable as config). */
function plainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

export function loadKitJson(root) {
  const p = path.join(root, '.claude', 'kit.json');
  if (isFile(p)) {
    try {
      return plainObject(JSON.parse(fs.readFileSync(p, 'utf8')));
    } catch {
      return {};
    }
  }
  return {};
}

// ---------------------------------------------------------------------------
// Security floor (kit/security/floor.json). Kit-owned minimum; projects add, never remove. KIT-SPEC 10.9.
// ---------------------------------------------------------------------------

export const KIT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const FLOOR_PATH = path.join(KIT_DIR, 'security', 'floor.json');

let floorCache = null;
/** The floor as shipped with this kit. Throws when the file is missing or invalid: a kit without a floor must not run. */
export function loadFloor() {
  if (floorCache) return floorCache;
  const f = plainObject(JSON.parse(fs.readFileSync(FLOOR_PATH, 'utf8')));
  const list = (k) => (Array.isArray(f[k]) ? f[k].filter((x) => typeof x === 'string' && x) : []);
  floorCache = {
    version: Number.isInteger(f.version) ? f.version : 0,
    deny: list('deny'),
    secret_read_patterns: list('secret_read_patterns'),
    credential_patterns: list('credential_patterns'),
    network: plainObject(f.network),
    second_family: typeof f.second_family === 'string' && f.second_family ? f.second_family : null,
    max_researchers: Number.isInteger(f.max_researchers) ? f.max_researchers : 8,
  };
  return floorCache;
}

/** Secret-path patterns in force: the kit's built-ins, the floor's, and the project's additions from kit.json. Never fewer than the floor. */
export function effectiveSecretPatterns(root) {
  const extra = loadKitJson(root)?.secret_patterns;
  const own = Array.isArray(extra) ? extra.filter((x) => typeof x === 'string' && x) : [];
  return [...new Set([...SECRET_READ_PATTERNS, ...loadFloor().secret_read_patterns, ...own])];
}

/** One regex matching any credential-looking content the floor names. */
export function credentialRegex() {
  return new RegExp(loadFloor().credential_patterns.map((p) => `(?:${p})`).join('|'));
}

/** Where this project's lane artifacts live (KIT-SPEC 10.11): kit.json paths.work, default the historical docs/specs. */
export function workRoot(root) {
  const p = loadKitJson(root)?.paths?.work;
  return typeof p === 'string' && p ? p.replace(/\/+$/, '') : 'docs/specs';
}

/** Where this project's decisions live: kit.json paths.decisions, default docs/decisions. */
export function decisionsRoot(root) {
  const p = loadKitJson(root)?.paths?.decisions;
  return typeof p === 'string' && p ? p.replace(/\/+$/, '') : 'docs/decisions';
}

/** Patterns that identify a lane artifact by name, wherever it sits. */
export const LANE_ARTIFACT_PATTERNS = ['*.progress.md', '*.review.md', '*.events.jsonl'];

export function readHookInput() {
  let data = '';
  try {
    data = fs.readFileSync(0, 'utf8');
  } catch {
    return {};
  }
  if (!data.trim()) return {};
  try {
    return JSON.parse(data);
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Lane state (one feature in one worktree). Created by /zi-implement.
// ---------------------------------------------------------------------------

export const LANE_FILE = path.join('.claude', 'lane.json');
export const SESSION_DIR = path.join('.claude', 'session');
export const ALWAYS_BLOCKED_EDIT = ['.claude/settings.json', '.claude/settings.local.json', '.claude/lane.json', '.claude/kit.json', '.claude/hooks/*', '.github/workflows/*'];
export const SECRET_READ_PATTERNS = [
  '.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', 'id_rsa*', 'id_ed25519*', '*.keystore',
  '**/secrets/**', '**/secret/**', '**/credentials*', '**/.aws/**', '**/.ssh/**', '**/.gnupg/**',
  '**/*token*.json', '**/service-account*.json', '**/.netrc', '**/.npmrc', '**/.pypirc',
];

export class Lane {
  /** @param {string} root worktree root containing .claude/lane.json @param {object} data */
  constructor(root, data) {
    this.root = root;
    this.data = data;
  }

  get slug() {
    return typeof this.data.feature === 'string' ? this.data.feature : '';
  }

  get specPath() {
    const spec = typeof this.data.spec === 'string' && this.data.spec ? this.data.spec : `${this.work}/${this.slug}.md`;
    return path.resolve(this.root, spec);
  }

  /**
   * Where this lane's artifacts live (KIT-SPEC 10.11). The directory of the spec `lane.js start` recorded, so every
   * reader inside the lane agrees with the writer even if the project's paths.work changed afterwards: .claude/kit.json
   * is tracked, so a worktree sees the value at its base commit, and ALWAYS_BLOCKED_EDIT means a lane can never
   * update it. Falls back to the project's current setting for a lane.json written before this field existed.
   */
  get work() {
    const spec = typeof this.data.spec === 'string' && this.data.spec ? this.data.spec : null;
    return spec ? path.dirname(spec) : workRoot(this.root);
  }

  get progressPath() {
    return path.join(this.root, this.work, `${this.slug}.progress.md`);
  }

  /**
   * Check output is machine output: it lives with the session files, not in docs/ (field test #44: a project's own
   * structure check rejects *.log under docs/). References keep the form `<slug>.log#<line>`.
   *
   * ADVISORY, NOT ENFORCED, IN EVERY SANDBOX MODE (KIT-SPEC 10.14). done-check reads the exit code on the line a
   * progress cell names, and this file sits inside the worktree, which is writable in all three modes: degraded has
   * no boundary at all, and under srt and in a container the worktree is precisely what the lane is given to write.
   * It has to be: post-edit-check runs the project's checks from inside the lane and appends them here, and that is
   * the only path by which evidence is produced (kit/agents/implementer.md:50,53 — the agent copies a line number
   * from this file into the Red run and Green run cells).
   *
   * Moving this file outside the worktree would not fix that and would break it: the writer is in-lane, so it would
   * lose the ability to write, and no host-side process witnesses the run. Signing the lines would not fix it either,
   * because any key the in-lane writer can read, the agent can read. Real enforcement needs the command to be RUN on
   * the host — see the note on lane.js check, and KIT-SPEC 10.14 for what that would take.
   */
  get logPath() {
    return path.join(this.root, '.claude', 'session', `${this.slug}.log`);
  }

  get eventsPath() {
    return path.join(this.root, this.work, `${this.slug}.events.jsonl`);
  }

  alwaysAllowed() {
    return laneArtifacts(this.work, this.slug, this.root);
  }
}

export function findLane(start) {
  let d = isDir(start) ? start : path.dirname(start);
  for (;;) {
    const f = path.join(d, LANE_FILE);
    if (isFile(f)) {
      try {
        return new Lane(d, plainObject(JSON.parse(fs.readFileSync(f, 'utf8'))));
      } catch {
        return new Lane(d, {});
      }
    }
    const parent = path.dirname(d);
    if (parent === d) return null;
    d = parent;
  }
}

/** The directory holding .claude/ (lane root if in a lane, else git toplevel, else cwd). */
export function projectRoot(start) {
  const lane = findLane(start);
  if (lane) return lane.root;
  return repoRoot(start);
}

/** Posix path of `p` relative to `root`; if outside root, the absolute posix path (callers treat as foreign). */
export function relTo(root, p) {
  const abs = path.isAbsolute(p) ? p : path.join(root, p);
  const rp = realResolve(abs);
  const rr = realResolve(root);
  const rel = path.relative(rr, rp);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return toPosix(rp);
  return rel === '' ? '.' : toPosix(rel);
}

export function globMatch(rel, patterns) {
  for (let pat of patterns) {
    pat = stripChars(pat.trim(), '`');
    if (!pat) continue;
    if (fnmatch(rel, pat) || rel === pat || rel.startsWith(pat.replace(/\/+$/, '') + '/')) return true;
    // '**/' prefix should also match at the top level
    if (pat.startsWith('**/') && fnmatch(rel, pat.slice(3))) return true;
  }
  return false;
}

// --- permission rules -------------------------------------------------------------------------------------
// Claude Code evaluates rules deny -> ask -> allow and the first match wins, so an allow rule can never carve an
// exception out of a deny rule [docs: https://code.claude.com/docs/en/permissions.md @ 2026-11-13]. The kit relies
// on that twice: the floor's deny list stays the ceiling whatever a project allows (ci_security_floor), and the
// generator refuses to WRITE an allow rule that would overlap the floor at all (bootstrap), so the two never
// disagree. Both call allowLoosens, which is why it lives here and not in either of them.

const WILDCARD_ONLY = new Set(['', '*', '**', '*:*']);

/** Split "Tool(pattern)" into [tool, pattern]; a bare "Tool" is the whole tool. */
export function splitRule(rule) {
  const m = /^([A-Za-z_]+)(?:\(([\s\S]*)\))?$/.exec(rule.trim());
  if (!m) return null;
  return [m[1], (m[2] ?? '').trim()];
}

/** True when an allow rule grants something a floor deny rule forbids. */
export function allowLoosens(allowRule, denyRule) {
  const a = splitRule(allowRule);
  const d = splitRule(denyRule);
  if (!a || !d || a[0] !== d[0]) return false;
  const [, ap] = a;
  const [, dp] = d;
  if (WILDCARD_ONLY.has(ap)) return true; // the whole tool
  if (ap === dp) return true;
  // the deny names a concrete path or command prefix and the allow's glob covers it
  const concrete = !/[*?[]/.test(dp.replace(/\*$/, ''));
  if (concrete && globMatch(dp.replace(/\*$/, ''), [ap])) return true;
  return false;
}

/**
 * True when an allow rule and a floor deny rule overlap at all, in either direction. The two directions are
 * different faults and both disqualify a generated rule:
 *   - the allow is WIDER than the deny (`Bash` vs `Bash(sudo *)`): at runtime deny still wins, but the rule claims
 *     a grant the floor refuses, which is what ci_security_floor fails a project for.
 *   - the allow is INSIDE the deny (`Bash(sudo make install *)` vs `Bash(sudo *)`): the rule can never take effect,
 *     so writing it only tells a reader the lane may do something it may not.
 * ci_security_floor judges a project's own settings and so asks the first question only; the generator must not
 * write either, because a rule it writes is the kit speaking.
 */
export function ruleOverlapsFloor(allowRule, denyRule) {
  return allowLoosens(allowRule, denyRule) || allowLoosens(denyRule, allowRule);
}

/**
 * True for a rule Claude Code accepts and then never matches: it checks file permissions against `Edit(path)` and
 * `Read(path)` only, so a path rule for Write, NotebookEdit, Glob or MultiEdit does nothing
 * [docs: https://code.claude.com/docs/en/permissions.md @ 2026-11-13]. `Edit` already covers every built-in tool
 * that edits files and `Read` covers those that read them, so the rule is not merely redundant but misleading: it
 * reads like a guard and is not one. A bare tool name (no pattern) is a real rule and not inert.
 */
const INERT_PATH_TOOLS = new Set(['Write', 'NotebookEdit', 'Glob', 'MultiEdit']);
export function inertPathRule(rule) {
  if (typeof rule !== 'string') return false;
  const parts = splitRule(rule);
  return parts !== null && INERT_PATH_TOOLS.has(parts[0]) && parts[1] !== '';
}

/** Domains the spec declares under an optional `## Network` section (one per list item). */
export function specNetwork(specPath) {
  if (!isFile(specPath)) return [];
  const sec = parseSections(stripHtmlComments(readLines(specPath))).get('network');
  if (!sec) return [];
  const out = [];
  for (const [, line] of sec.lines ?? []) {
    const m = /^\s*[-*]\s+`?([a-z0-9.-]+\.[a-z]{2,}|\*)`?/i.exec(line);
    if (m) out.push(m[1].toLowerCase());
  }
  return out;
}

/** (read_first, change, create) path lists from a spec, as repo-relative strings. */
export function specFileLists(specPath) {
  if (!isFile(specPath)) return [[], [], []];
  const lines = stripHtmlComments(readLines(specPath));
  const sections = parseSections(lines);
  const pathsIn = (name) => {
    const sec = sections.get(name);
    if (!sec) return [];
    const out = [];
    for (const [, t] of sec.bullets()) {
      const m = /^\s*-\s*`([^`]+)`/.exec(t);
      if (m) out.push(m[1].trim());
    }
    return out;
  };
  return [pathsIn('files to read first'), pathsIn('files to change'), pathsIn('files to create')];
}

/**
 * The read log guard-edit consults. ADVISORY in every sandbox mode: the event it records — this session called Read
 * on this file — happens inside the lane and has no witness outside it. Relocating the file or signing its lines
 * would move the forgery, not remove it, because whatever can write a true entry can write a false one. Planted
 * fault 1 proves the gate fires on the honest path; it does not prove the path cannot be faked (KIT-SPEC 10.14).
 */
export function readsLogPath(root, sessionId) {
  const d = path.join(root, SESSION_DIR);
  fs.mkdirSync(d, { recursive: true });
  const safe = (sessionId || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(d, `${safe}.reads`);
}

export function recordRead(root, sessionId, rel) {
  fs.appendFileSync(readsLogPath(root, sessionId), rel + '\n', 'utf8');
}

export function wasRead(root, sessionId, rel) {
  const p = readsLogPath(root, sessionId);
  if (!isFile(p)) return false;
  return new Set(splitlines(fs.readFileSync(p, 'utf8')).map((l) => l.trim())).has(rel);
}

export function appendEvent(p, event) {
  if (!('ts' in event)) event.ts = isoSeconds();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, jsonDumps(event, { ensureAscii: false }) + '\n', 'utf8');
}

/** Append a titled block to the lane log. Returns the 1-based line number where the block starts. */
/**
 * Result lines a test run printed, as `{ok, name}`, from the patterns the stacks declare plus any the project adds
 * in kit.json `results`.
 *
 * This is what makes a cited run evidence rather than an exit code. In the field run 33 of 36 "red" runs failed on
 * MODULE_NOT_FOUND before a single assertion ran, and one was npm failing to find package.json (exit 254), yet all
 * of them satisfied done-check because it read only the `-> exit N` header.
 *
 * Note what is deliberately NOT here: a list of infrastructure failures to exclude. "MODULE_NOT_FOUND", "Could not
 * read package.json" and whatever comes next are all covered by one property -- a run that crashed before testing
 * emits no result line for the row's test -- so requiring that line rejects the whole class without naming any
 * member of it. A pattern list would have to be extended for every new way a runner can fail to start.
 */
export function resultLines(lines, patterns) {
  const out = [];
  for (const raw of lines) {
    for (const p of patterns) {
      const fail = new RegExp(p.fail).exec(raw);
      if (fail) { out.push({ ok: false, name: (fail[1] ?? '').trim() }); break; }
      const pass = new RegExp(p.pass).exec(raw);
      if (pass) { out.push({ ok: true, name: (pass[1] ?? '').trim() }); break; }
    }
  }
  return out;
}

/** Result-line patterns from every stack config, plus the project's own kit.json `results` additions. */
export function resultPatterns(root) {
  const out = [];
  const dir = path.join(KIT_DIR, 'stacks');
  if (isDir(dir)) {
    for (const n of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
      try {
        for (const p of JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')).results ?? []) {
          if (typeof p?.fail === 'string' && typeof p?.pass === 'string') out.push(p);
        }
      } catch { /* a stack file that will not parse is bootstrap's problem to report, not this gate's */ }
    }
  }
  // A project whose runner none of the stacks describe declares its own pair here rather than being unable to
  // finish a lane. The gate stays on; what changes is that it can read that runner's output.
  for (const p of (root ? plainObject(loadKitJson(root)).results : null) ?? []) {
    if (typeof p?.fail === 'string' && typeof p?.pass === 'string') out.push(p);
  }
  return out;
}

const TEST_SEP = /\s+[>›]\s+|::/;
const TEST_FILE = /^\S+\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|kt|php)$/i;
const normTest = (s) => s.trim().replace(/^[`'"]+|[`'"]+$/g, '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * A test name as a progress cell or a runner writes it, split into its file (when it shows one) and its path of
 * names: `tests/a.test.ts::adds`, `tests/a.test.ts > outer > adds` (vitest), `outer › adds` (jest),
 * `tests/test_a.py::TestA::test_adds` (pytest) all split the same way.
 */
export function splitTestName(s) {
  const segs = String(s ?? '').trim().replace(/^[`'"]+|[`'"]+$/g, '').split(TEST_SEP).map(normTest).filter(Boolean);
  const file = segs.length && TEST_FILE.test(segs[0]) ? segs.shift() : null;
  return { file, segs };
}

/** Two paths name the same file: equal, or one ends with the other (a runner may print it relative to another root). */
export function samePath(a, b) {
  if (!a || !b) return false;
  const [x, y] = [a, b].map((p) => normTest(p).replace(/\\/g, '/').replace(/^\.\//, ''));
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
}

/**
 * A runner's result is the criterion's test: the test name matches, the describe blocks (or classes) either side shows
 * agree with the trailing names of the other's, and the files agree when both show one.
 */
export function sameTest(want, result) {
  const [a, b] = want.segs.length <= result.segs.length ? [want.segs, result.segs] : [result.segs, want.segs];
  if (!a.length || !a.every((seg, i) => seg === b[b.length - a.length + i])) return false;
  return !(want.file && result.file && !samePath(want.file, result.file));
}

/**
 * The results a test run printed, each as `{ok, name, file, segs}`, read the way the runners print them. The
 * stacks' patterns (and a project's kit.json `results`) find the result lines; this adds what those lines leave to
 * their context, so a result is tied to its own test and file:
 * - vitest's default reporter prints a failed test as `× describe > name` under its file's `❯ file (N tests | M
 *   failed)` line, and a passing file as one `✓ file (N tests)` line without its tests; `verbose` prints every test
 *   as `✓|× file > describe > name`; `tap` nests describes as indented subtests inside `{ … }`; `tap-flat` prints
 *   `ok N - file > describe > name` (https://vitest.dev/guide/reporters).
 * - jest prints `PASS|FAIL file`, then for one file each test indented under its describes (`✓ name (2 ms)`), and
 *   for a failure `● describe › name`.
 * A file-level pass (`fileLevel`) is recorded only when the runner says every test in that file passed with none
 * skipped (vitest's count, jest's run summary); a skipped or todo test is never a result.
 */
export function testResults(lines, patterns) {
  const out = [];
  const stack = []; // enclosing TAP subtests and jest describes: {indent, name}
  let file = null;
  let jestDescribes = false;
  let skipsInRun = false;
  const pop = (indent) => {
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
  };
  const result = (ok, name, indent) => {
    const own = splitTestName(name.replace(/\s+\(\d+(?:\.\d+)?\s*m?s\)$/, ''));
    const outer = stack.filter((g) => g.indent < indent);
    const outerFile = outer.find((g) => TEST_FILE.test(g.name))?.name ?? null;
    const segs = [...outer.filter((g) => !TEST_FILE.test(g.name)).map((g) => normTest(g.name)), ...own.segs];
    out.push({ ok, name: name.trim(), file: own.file ?? outerFile ?? file, segs });
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const t = line.trimStart();
    const indent = line.length - t.length;
    if (!t || t === '}') continue;
    if (/^Tests:\s/.test(t) && /\b(?:skipped|todo)\b/.test(t)) skipsInRun = true;
    // vitest's per-file line: ✓ passed, ❯ failed, ↓ skipped
    let m = /^([✓❯×↓])\s+(\S+)\s+\((\d+) tests?(?:\s*\|\s*([^)]*))?\)/u.exec(t);
    if (m && TEST_FILE.test(m[2])) {
      file = m[2];
      stack.length = 0;
      if (m[1] === '✓' && !/failed|skipped|todo/.test(m[4] ?? '')) out.push({ ok: true, name: t, file, segs: [], fileLevel: true });
      continue;
    }
    // jest's per-file line
    m = /^(PASS|FAIL)\s(\S+)/.exec(t);
    if (m && indent === 0 && TEST_FILE.test(m[2])) {
      file = m[2];
      stack.length = 0;
      jestDescribes = true;
      if (m[1] === 'PASS') out.push({ ok: true, name: t, file, segs: [], fileLevel: true, jest: true });
      continue;
    }
    // jest's failure heading names the whole path
    m = /^●\s+(.+)$/u.exec(t);
    if (m && file) {
      jestDescribes = false;
      if (!/^test suite failed to run$/i.test(m[1].trim())) { stack.length = 0; result(false, m[1], 0); }
      continue;
    }
    if (/#\s*(?:SKIP|TODO)\b/i.test(t)) continue;
    let matched = false;
    for (const p of patterns) {
      const fail = new RegExp(p.fail).exec(t);
      const pass = fail ? null : new RegExp(p.pass).exec(t);
      const hit = fail ?? pass;
      if (!hit) continue;
      matched = true;
      pop(indent);
      // a TAP subtest that holds others (vitest's tap reporter: a file or a describe) is context, not a result
      if (/\{$/.test(t)) stack.push({ indent, name: (hit[1] ?? '').replace(/\s*\{$/, '').trim() });
      else result(Boolean(pass), hit[1] ?? '', indent);
      break;
    }
    // a jest describe: an indented plain line between a file line and the results under it
    if (!matched && jestDescribes && indent > 0 && !/^[✓✕○√×↓]/u.test(t)) {
      pop(indent);
      stack.push({ indent, name: t });
    }
  }
  // jest gives a file's skips only in the run's summary
  return skipsInRun ? out.filter((r) => !(r.fileLevel && r.jest)) : out;
}

/** The body of the log entry whose `=== … -> exit N` header is at 1-based line `at`: up to the next entry. */
export function logEntry(lines, at) {
  const out = [];
  for (let i = at; i < lines.length; i++) {
    if (/^=== \d{4}-\d\d-\d\d/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out;
}

/**
 * Why a progress row's red or green cell does not prove its run, or null when it does. The cell must name a line of
 * the lane's check log that is a logged run (`=== … -> exit N`) whose exit agrees with the column, and whose output
 * reports this row's test failing (red) or passing (green). A cell that merely contains `#` proves nothing (#56).
 * Shared by done-check (inside the lane) and by lane.js advance and next-step (in the main checkout).
 */
export function runRefProblem(lane, logLines, cells, label) {
  const rid = cells[0];
  const ref = label === 'red' ? cells[3] : cells[4];
  const logName = path.basename(lane.logPath);
  const m = /#(\d+)/.exec(ref);
  if (!m) return `${rid}: no ${label} run reference (expected ${logName}#<line>)`;
  const at = Number(m[1]);
  if (at > logLines.length) return `${rid}: ${label} run ref ${ref} points past the end of ${logName} (${logLines.length} lines)`;
  // The reference must point at a logged run whose exit code says what the cell claims: red failed, green passed.
  const ex = /-> exit (-?\d+)\s*$/.exec(logLines[at - 1] ?? '');
  if (!ex) return `${rid}: ${label} run ref ${ref} is not a logged run (=== … -> exit N); log it with post-edit-check or kit lane check`;
  if (label === 'red' && Number(ex[1]) === 0) return `${rid}: red run ref ${ref} passed (exit 0); a red run must fail`;
  if (label === 'green' && Number(ex[1]) !== 0) return `${rid}: green run ref ${ref} failed (exit ${ex[1]}); a green run must pass`;
  // ...and the run must have actually tested THIS row's test. An exit code says only that a process ended: in
  // the field run 33 of 36 red runs crashed on a missing module before any assertion, and one was npm unable to
  // find package.json, yet every one of them satisfied this gate.
  const results = testResults(logEntry(logLines, at), resultPatterns(lane.root));
  if (!results.length) {
    return `${rid}: ${label} run ref ${ref} logged no test result at all (exit ${ex[1]}), so nothing in it says whether '${cells[2].trim()}' ran; a runner that fails to start is not a ${label} run. If this project's runner reports results in a form the kit does not know, add a {"fail": "...", "pass": "..."} pair to "results" in .claude/kit.json`;
  }
  const want = splitTestName(cells[2]);
  // a named result for the row's test decides; a red run must always name it. A green run may instead show the row's
  // file passing whole (see testResults): every test in it ran and passed, and the red run named this one in it.
  const hit = results.find((x) => !x.fileLevel && sameTest(want, x)) ??
    (label === 'green' && want.file ? results.find((x) => x.fileLevel && samePath(want.file, x.file)) : undefined);
  if (!hit) return `${rid}: ${label} run ref ${ref} has no result for '${cells[2].trim()}'; it reported ${results.map((x) => `${x.ok ? 'ok' : 'not ok'} ${x.name}`).slice(0, 3).join(', ')}`;
  if (hit.ok !== (label === 'green')) return `${rid}: ${label} run ref ${ref} reports '${hit.name}' as ${hit.ok ? 'passing' : 'failing'}; a ${label} run must have it ${label === 'green' ? 'pass' : 'fail'}`;
  return null;
}

export function appendLog(p, title, body) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const existing = isFile(p) ? (fs.readFileSync(p, 'utf8').match(/\n/g) || []).length : 0;
  fs.appendFileSync(p, `=== ${isoSeconds()} ${title}\n${body.replace(/\s+$/, '')}\n\n`, 'utf8');
  return existing + 1;
}

/** PreToolUse / SubagentStop / ConfigChange: exit 2 with the reason on stderr. Caller sets process.exitCode. */
export function block(reason) {
  process.stderr.write(reason + '\n');
  return 2;
}

/**
 * Entry point for blocking hooks (PreToolUse guards, ConfigChange). Claude Code treats any exit code other than 2
 * as "carry on", so an unexpected error must block (exit 2) instead of letting the action through (exit 1).
 */
export function runGuard(name, main) {
  try {
    process.exitCode = main();
  } catch (e) {
    process.stderr.write(`${name}: internal error, blocking for safety: ${e?.stack ?? e}\n`);
    process.exitCode = 2;
  }
}

/**
 * Kit script names that hook commands in `settings` point at but that do not exist under `kitDir/scripts`.
 * Hooks written by an older kit version (for example `.py` scripts) show up here, because a hook whose script is
 * missing fails without blocking anything.
 */
export function staleHookScripts(settings, kitDir) {
  const missing = new Set();
  const hooks = settings && typeof settings === 'object' ? settings.hooks : null;
  for (const groups of Object.values(hooks && typeof hooks === 'object' ? hooks : {})) {
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const h of Array.isArray(group?.hooks) ? group.hooks : []) {
        const m = /kit\/scripts\/([A-Za-z0-9_.-]+)/.exec(typeof h?.command === 'string' ? h.command : '');
        if (m && !isFile(path.join(kitDir, 'scripts', m[1]))) missing.add(m[1]);
      }
    }
  }
  return [...missing].sort();
}

/** PostToolUse / Stop: JSON decision on stdout, exit 0. */
export function feedbackBlock(reason) {
  process.stdout.write(jsonDumps({ decision: 'block', reason }) + '\n');
  return 0;
}

/** Modified or untracked files under docs/ and LESSONS.md, per git status. */
export function changedDocs(root) {
  let out;
  try {
    out = git(['status', '--porcelain', '--untracked-files=all'], root);
  } catch {
    return [];
  }
  const paths = [];
  for (const line of splitlines(out)) {
    let rel = line.slice(3).trim();
    if (rel.includes(' -> ')) rel = rel.slice(rel.indexOf(' -> ') + 4);
    if ((rel.startsWith('docs/') && rel.endsWith('.md')) || rel === 'LESSONS.md') paths.push(path.join(root, rel));
  }
  return paths;
}

/**
 * The files a lane may write that its own spec does not list: its progress file, its review report, its event log,
 * and the decision records a lane is allowed to add.
 *
 * ONE list, because two consumers need it and the two hand-kept copies had already drifted. ci_scope_diff allowed
 * `<slug>.review.md` in a lane's diff and Lane.alwaysAllowed did not, so `/zi-review` wrote the file CI was waiting
 * for and the edit guard refused the write. A lane could not produce the report its own merge gate required.
 *
 * The check log is deliberately NOT here. It lives at Lane.logPath -- `.claude/session/<slug>.log`, where field
 * test #44 moved it because a project's structure check rejects *.log under docs/ -- and every writer and reader
 * agrees on that path (lane.js check, hook_post_edit_check, hook_done_check). `.claude/session/` is gitignored, so
 * it never reaches a diff for CI to allow; the hooks write it directly, so no agent edit needs permitting; and the
 * floor denies `Edit(.claude/**)` regardless. Both copies carried a `<work>/<slug>.log` entry left over from before
 * the move, naming a path nothing has written since. Pointing it at the real log instead of dropping it would hand
 * the agent write access to the evidence done-check reads (KIT-SPEC 10.14), which is the opposite of the fix.
 */
export function laneArtifacts(work, slug, root) {
  return [
    `${work}/${slug}.progress.md`,
    `${work}/${slug}.review.md`,
    `${work}/${slug}.events.jsonl`,
    // the committed copy of the check log. The live log is gitignored (see above), so once the worktree is removed
    // it is the only thing a `log#N` citation in the merged progress and review files can still resolve against,
    // and the retro has nothing to read without it (#35). Line numbers are preserved, so the refs keep pointing.
    `${work}/${slug}.checks.txt`,
    `${decisionsRoot(root)}/*.md`,
  ];
}

/** Files a review commit may touch without making the review stale: the lane's own artifacts under `work`, and tests. */
export function reviewOnlyFile(work) {
  const w = work.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${w}/[^/]+\\.(review\\.md|progress\\.md|log|events\\.jsonl)$|(^|/)(tests?|__tests__|spec)/|\\.(test|spec)\\.[a-z]+$|(^|/)test_[^/]+\\.py$|_test\\.(go|py|rb|rs)$`);
}

/**
 * A review names the commit it reviewed. It is current if that is the branch head, or the head's parent and
 * the head commit only touched the review report, lane-owned docs (progress, log, events written by hooks
 * during review) and test files. `head` defaults to HEAD; CI on a pull request passes the PR's head commit,
 * because there HEAD is GitHub's synthetic merge commit, which no review can name (issue #69).
 */
export function reviewHeadOk(root, reviewedSha, head = 'HEAD') {
  let headSha;
  try {
    headSha = git(['rev-parse', '--verify', `${head}^{commit}`], root).trim();
  } catch {
    return false;
  }
  if (headSha.startsWith(reviewedSha)) return true;
  let parent;
  let changed;
  try {
    parent = git(['rev-parse', `${headSha}~1`], root).trim();
    changed = git(['diff', '--name-only', `${headSha}~1`, headSha], root).split(/\s+/).filter(Boolean);
  } catch {
    return false;
  }
  const reviewOnly = reviewOnlyFile(workRoot(root));
  return parent.startsWith(reviewedSha) && changed.every((f) => reviewOnly.test(f));
}

/** A settings.json hook entry belongs to the kit when one of its commands runs a script from the installed kit (any version). */
export const isKitHookEntry = (entry) =>
  Array.isArray(entry?.hooks) && entry.hooks.some((h) => typeof h?.command === 'string' && /\.claude\/kit\/scripts\//.test(h.command));

/**
 * The lane a tool call acts on: the lane that holds the file (a subagent started from the main checkout may edit a
 * worktree's files), else the lane of the session's working directory (field test #37).
 */
export function laneFor(cwd, absPath) {
  return (absPath ? findLane(absPath) : null) ?? (cwd ? findLane(cwd) : null);
}

/** Lanes kit.json records as open whose recorded worktree still holds a lane.json. */
export function activeLanes(root) {
  const lanes = plainObject(loadKitJson(root)?.lanes ?? {});
  const out = [];
  for (const v of Object.values(lanes)) {
    const wt = typeof plainObject(v).worktree === 'string' ? plainObject(v).worktree : '';
    const lane = wt && isFile(path.join(wt, LANE_FILE)) ? findLane(wt) : null;
    if (lane) out.push(lane);
  }
  return out;
}

/**
 * The lane a hook is acting on, in three tiers, with the reason it was chosen.
 *
 * A subagent started by the main session reports the MAIN repo as `cwd`, not the worktree. Every hook that asked
 * `findLane(d.cwd)` therefore found nothing and returned 0 for the tester, implementer and reviewer: the field run
 * logged 373 events with `lane: null`, a 1-hour budget reached 6h43m with no `budget_exceeded`, the lane's own
 * network declaration did not bind a subagent's Bash, and the gate protecting `.claude/settings.json` was blind in
 * the one directory that file lives in. Five gates, one wrong derivation, repeated five times.
 *
 *   tool-path     the file the tool is touching is inside a worktree -- the strongest signal, and the only one
 *                 hook_guard_edit ever used, which is why scope checking kept working when nothing else did
 *   cwd           the session really is in the worktree (an attended lane session)
 *   single-active kit.json records exactly one open lane: the subagent case, where no path and no cwd can help
 *
 * `ambiguous` (two or more open lanes) is NOT resolved by guessing. Each caller decides: the gates block, because a
 * gate that cannot tell which lane it is protecting must not wave work through; the event log records the ambiguity
 * instead of inventing an owner. `laneFor` stays the two-tier form, for hooks that always have the tool's path and
 * where tier 3 would start gating edits made outside any lane.
 */
export function laneForHook(d) {
  const data = plainObject(d);
  const cwd = typeof data.cwd === 'string' && data.cwd ? data.cwd : '.';
  const ti = plainObject(data.tool_input);
  const p = ['file_path', 'notebook_path', 'path'].map((k) => ti[k]).find((v) => typeof v === 'string' && v);
  const byPath = p ? findLane(path.isAbsolute(p) ? p : path.join(cwd, p)) : null;
  if (byPath) return { lane: byPath, via: 'tool-path', slugs: [byPath.slug] };
  const byCwd = findLane(cwd);
  if (byCwd) return { lane: byCwd, via: 'cwd', slugs: [byCwd.slug] };
  const active = activeLanes(repoRoot(cwd));
  if (active.length === 1) return { lane: active[0], via: 'single-active', slugs: [active[0].slug] };
  return { lane: null, via: active.length ? 'ambiguous' : 'none', slugs: active.map((l) => l.slug) };
}
