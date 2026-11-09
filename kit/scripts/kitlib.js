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

export function loadKitJson(root) {
  const p = path.join(root, '.claude', 'kit.json');
  if (isFile(p)) {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      return {};
    }
  }
  return {};
}

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
// Lane state (one feature in one worktree). Created by /implement.
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
    return this.data.feature ?? '';
  }

  get specPath() {
    return path.join(this.root, this.data.spec ?? `docs/specs/${this.slug}.md`);
  }

  get progressPath() {
    return path.join(this.root, 'docs', 'specs', `${this.slug}.progress.md`);
  }

  get logPath() {
    return path.join(this.root, 'docs', 'specs', `${this.slug}.log`);
  }

  get eventsPath() {
    return path.join(this.root, 'docs', 'specs', `${this.slug}.events.jsonl`);
  }

  alwaysAllowed() {
    return [
      `docs/specs/${this.slug}.progress.md`,
      `docs/specs/${this.slug}.log`,
      `docs/specs/${this.slug}.events.jsonl`,
      'docs/decisions/*.md',
    ];
  }
}

export function findLane(start) {
  let d = isDir(start) ? start : path.dirname(start);
  for (;;) {
    const f = path.join(d, LANE_FILE);
    if (isFile(f)) {
      try {
        return new Lane(d, JSON.parse(fs.readFileSync(f, 'utf8')));
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

export const REVIEW_ONLY_FILE = /^docs\/specs\/[^/]+\.(review\.md|progress\.md|log|events\.jsonl)$|(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py|rb|rs)$/;

/**
 * A review names the commit it reviewed. It is current if that is HEAD, or HEAD's parent and the
 * commit at HEAD only touched the review report, lane-owned docs (progress, log, events written by hooks
 * during review) and test files.
 */
export function reviewHeadOk(root, reviewedSha) {
  let head;
  try {
    head = git(['rev-parse', 'HEAD'], root).trim();
  } catch {
    return false;
  }
  if (head.startsWith(reviewedSha)) return true;
  let parent;
  let changed;
  try {
    parent = git(['rev-parse', 'HEAD~1'], root).trim();
    changed = git(['diff', '--name-only', 'HEAD~1', 'HEAD'], root).split(/\s+/).filter(Boolean);
  } catch {
    return false;
  }
  return parent.startsWith(reviewedSha) && changed.every((f) => REVIEW_ONLY_FILE.test(f));
}
