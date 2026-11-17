// Shared helpers for the CI scripts.
//
// Besides the helpers the Python module had (currentBranch, laneSlug, changedFiles, fail, ok) this file holds the small
// Python-compatibility primitives the CI scripts rely on, so each script can stay a line-for-line port:
// Python's whitespace class, str.strip()/str.split(), repr(), int(), truthiness, pathlib-style joins, subprocess text mode.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as K from './kitlib.js';
import { ArgumentParser } from './args.js';

// ---------------------------------------------------------------------------
// Python-compatible text primitives
// ---------------------------------------------------------------------------

// Python's \s / str.isspace() for str patterns. JS's \s differs (it has U+FEFF, lacks \x1c-\x1f and \x85).
const PY_SPACE_CHARS = String.raw`\t\n\v\f\r\x1c-\x1f \x85\xa0  -     　`;
/** Regex source for one Python whitespace character (Python \s). */
export const WS = `[${PY_SPACE_CHARS}]`;
/** Regex source for one non-whitespace character (Python \S). */
export const NWS = `[^${PY_SPACE_CHARS}]`;
const WS_RUN = new RegExp(`${WS}+`);
const WS_ENDS = new RegExp(`^${WS}+|${WS}+$`, 'g');

/** Python str.strip() with no arguments. */
export function pyStrip(s) {
  return s.replace(WS_ENDS, '');
}

/** Python str.split() with no arguments. */
export function pySplit(s) {
  return s.split(WS_RUN).filter((x) => x !== '');
}

/** Python str.lstrip(chars). */
export function lstripChars(s, chars) {
  const set = new Set(chars);
  let a = 0;
  while (a < s.length && set.has(s[a])) a++;
  return s.slice(a);
}

/** Python str.rstrip(chars). */
export function rstripChars(s, chars) {
  const set = new Set(chars);
  let b = s.length;
  while (b > 0 && set.has(s[b - 1])) b--;
  return s.slice(0, b);
}

/** Number of code points (Python len(str)). */
export function pyLen(s) {
  let n = 0;
  for (const _ of s) n++; // eslint-disable-line no-unused-vars
  return n;
}

/** Python repr() of a str. */
export function pyRepr(s) {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ch === quote || ch === '\\') out += '\\' + ch;
    else if (ch === '\t') out += '\\t';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (cp < 0x20 || cp === 0x7f) out += '\\x' + cp.toString(16).padStart(2, '0');
    else if (cp < 0x7f) out += ch;
    else if (!/[\p{C}\p{Z}]/u.test(ch)) out += ch;
    else if (cp <= 0xff) out += '\\x' + cp.toString(16).padStart(2, '0');
    else if (cp <= 0xffff) out += '\\u' + cp.toString(16).padStart(4, '0');
    else out += '\\U' + cp.toString(16).padStart(8, '0');
  }
  return out + quote;
}

/** Python repr() of a list of str, e.g. ['a', 'b']. */
export function pyListRepr(items) {
  return '[' + items.map(pyRepr).join(', ') + ']';
}

/** Python sorted() of strings: by code point. */
export function sortedStrings(items) {
  const cmp = (a, b) => {
    const x = [...a];
    const y = [...b];
    const n = Math.min(x.length, y.length);
    for (let i = 0; i < n; i++) {
      const p = x[i].codePointAt(0);
      const q = y[i].codePointAt(0);
      if (p !== q) return p < q ? -1 : 1;
    }
    return x.length - y.length;
  };
  return [...items].sort(cmp);
}

/** Python truthiness of a JSON value. */
export function truthy(v) {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Python type name of a decoded JSON value (for AttributeError messages). */
export function pyTypeName(v) {
  if (v === null || v === undefined) return 'NoneType';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float';
  if (typeof v === 'string') return 'str';
  if (Array.isArray(v)) return 'list';
  return 'dict';
}

/** Python dict.get(key, default) on a decoded JSON object (own keys only). */
export function dictGet(d, key, dflt) {
  return Object.prototype.hasOwnProperty.call(d, key) ? d[key] : dflt;
}

/** Python int(v) for a decoded JSON value. Throws (like Python's ValueError/TypeError) when int() would. */
export function pyInt(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('cannot convert float infinity to integer');
    return Math.trunc(v) + 0;
  }
  if (typeof v === 'string') {
    const s = pyStrip(v);
    if (/^[+-]?[0-9]+(_[0-9]+)*$/.test(s)) return parseInt(s.replaceAll('_', ''), 10);
    throw new Error(`invalid literal for int() with base 10: ${pyRepr(v)}`);
  }
  throw new TypeError(`int() argument must be a string, a bytes-like object or a real number, not '${pyTypeName(v)}'`);
}

// ---------------------------------------------------------------------------
// pathlib-style paths (plain POSIX strings)
// ---------------------------------------------------------------------------

const pathParts = (p) => p.split('/').filter((x) => x !== '' && x !== '.');

/** pathlib: Path(base) / rel / ...  Drops '' and '.' components, keeps '..', an absolute right-hand side replaces the left. */
export function joinPath(base, ...rels) {
  let cur = base;
  for (const rel of rels) cur = rel.startsWith('/') ? rel : cur + '/' + rel;
  const body = pathParts(cur).join('/');
  return cur.startsWith('/') ? '/' + body : body || '.';
}

/** pathlib: Path(p).parent as a string. */
export function pyParent(p) {
  const parts = pathParts(p);
  parts.pop();
  const body = parts.join('/');
  return p.startsWith('/') ? '/' + body : body || '.';
}

/** pathlib: Path(p).name. */
export function pyName(p) {
  const parts = pathParts(p);
  return parts.length ? parts[parts.length - 1] : '';
}

/** pathlib: Path(p).suffix. */
export function pySuffix(p) {
  const name = pyName(p);
  const i = name.lastIndexOf('.');
  return i > 0 && i < name.length - 1 ? name.slice(i) : '';
}

/** Path.relative_to(root) for a path built with joinPath(root, ...); throws like Python's ValueError when outside root. */
export function relativeTo(p, root) {
  const prefix = root === '/' ? '/' : root + '/';
  if (p === root) return '.';
  if (!p.startsWith(prefix)) throw new Error(`${pyRepr(p)} is not in the subpath of ${pyRepr(root)}`);
  return p.slice(prefix.length);
}

/** Path.read_text(): UTF-8 (invalid bytes replaced) with universal newlines. */
export function readText(p) {
  return fs.readFileSync(p, 'utf8').replace(/\r\n?/g, '\n');
}

/** SHA-256 hex digest of a file's bytes (hashlib.sha256(p.read_bytes()).hexdigest()). */
export function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

// ---------------------------------------------------------------------------
// git with subprocess.run(..., text=True, check=True) semantics
// ---------------------------------------------------------------------------

/** True for the Node equivalent of subprocess.CalledProcessError (git ran and exited non-zero). */
export function isCalledProcessError(e) {
  return Boolean(e) && typeof e.status === 'number';
}

/** The text Python's str(exception) would show for a failed `git` call. */
export function pyErrorMessage(e, args, cwd) {
  if (isCalledProcessError(e)) return `Command '${pyListRepr(['git', ...args])}' returned non-zero exit status ${e.status}.`;
  if (e && e.code === 'ENOENT') {
    return K.isDir(cwd) ? "[Errno 2] No such file or directory: 'git'" : `[Errno 2] No such file or directory: PosixPath(${pyRepr(String(cwd))})`;
  }
  return String(e && e.message);
}

/** Python's strict UTF-8 decode failure (UnicodeDecodeError) location, or null if `buf` is valid UTF-8. */
export function utf8DecodeError(buf) {
  const n = buf.length;
  const cont = (b) => (b & 0xc0) === 0x80;
  const bad = (start, end, reason) => ({ start, end, reason });
  let i = 0;
  while (i < n) {
    const ch = buf[i];
    if (ch < 0x80) {
      i++;
      continue;
    }
    if (ch < 0xc2) return bad(i, i + 1, 'invalid start byte');
    const left = n - i;
    if (ch < 0xe0) {
      if (left < 2) return bad(i, n, 'unexpected end of data');
      if (!cont(buf[i + 1])) return bad(i, i + 1, 'invalid continuation byte');
      i += 2;
      continue;
    }
    if (ch < 0xf0) {
      if (left < 3) {
        if (left < 2) return bad(i, n, 'unexpected end of data');
        const c2 = buf[i + 1];
        if (!cont(c2) || (c2 < 0xa0 ? ch === 0xe0 : ch === 0xed)) return bad(i, i + 1, 'invalid continuation byte');
        return bad(i, n, 'unexpected end of data');
      }
      const c2 = buf[i + 1];
      if (!cont(c2) || (ch === 0xe0 && c2 < 0xa0) || (ch === 0xed && c2 >= 0xa0)) return bad(i, i + 1, 'invalid continuation byte');
      if (!cont(buf[i + 2])) return bad(i, i + 2, 'invalid continuation byte');
      i += 3;
      continue;
    }
    if (ch < 0xf5) {
      if (left < 4) {
        if (left < 2) return bad(i, n, 'unexpected end of data');
        const c2 = buf[i + 1];
        if (!cont(c2) || (c2 < 0x90 ? ch === 0xf0 : ch === 0xf4)) return bad(i, i + 1, 'invalid continuation byte');
        if (left < 3) return bad(i, n, 'unexpected end of data');
        if (!cont(buf[i + 2])) return bad(i, i + 2, 'invalid continuation byte');
        return bad(i, n, 'unexpected end of data');
      }
      const c2 = buf[i + 1];
      if (!cont(c2) || (ch === 0xf0 && c2 < 0x90) || (ch === 0xf4 && c2 >= 0x90)) return bad(i, i + 1, 'invalid continuation byte');
      if (!cont(buf[i + 2])) return bad(i, i + 2, 'invalid continuation byte');
      if (!cont(buf[i + 3])) return bad(i, i + 3, 'invalid continuation byte');
      i += 4;
      continue;
    }
    return bad(i, i + 1, 'invalid start byte');
  }
  return null;
}

/** Strict UTF-8 decode; the thrown error carries Python's UnicodeDecodeError text in `pyMessage`. */
export function decodeUtf8Strict(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
  } catch (e) {
    const info = utf8DecodeError(buf);
    if (!info) throw e;
    const where = info.end === info.start + 1
      ? `byte 0x${buf[info.start].toString(16).padStart(2, '0')} in position ${info.start}`
      : `bytes in position ${info.start}-${info.end - 1}`;
    const err = new Error(`'utf-8' codec can't decode ${where}: ${info.reason}`);
    err.pyMessage = err.message;
    throw err;
  }
}

/**
 * K.git as the Python kit ran it: stdout decoded strictly as UTF-8 with universal newlines.
 * A failure carries `pyMessage`, the text Python's str(exception) would show; CalledProcessError-like failures have `status`.
 */
export function gitPy(args, cwd) {
  let buf;
  try {
    buf = execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 512 * 1024 * 1024 });
  } catch (e) {
    e.pyMessage = pyErrorMessage(e, args, cwd);
    throw e;
  }
  return decodeUtf8Strict(buf).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** Lines of a file at a ref (or the working tree when `ref` is empty/null). null if missing. Mirrors kitlib.file_lines_at. */
export function fileLinesAt(root, rel, ref) {
  if (ref) {
    try {
      return K.splitlines(gitPy(['show', `${ref}:${rel}`], root));
    } catch (e) {
      if (isCalledProcessError(e)) return null;
      throw e;
    }
  }
  const p = joinPath(root, rel);
  if (!K.isFile(p)) return null;
  try {
    return K.splitlines(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// argparse look-alike for the CI scripts: argparse's usage/help text, and its unique-prefix option abbreviations (--ba -> --base)
// ---------------------------------------------------------------------------

const ARGPARSE_WIDTH = 78; // argparse wraps at COLUMNS - 2; COLUMNS is 80 when there is no terminal

function argparseUsage(prog, optParts) {
  const prefix = 'usage: ';
  const indent = ' '.repeat(prefix.length + prog.length + 1);
  const lines = [];
  let line = [];
  let lineLen = prefix.length - 1;
  for (const part of [prog, ...optParts]) {
    if (lineLen + 1 + part.length > ARGPARSE_WIDTH && line.length) {
      lines.push(line.join(' '));
      line = [];
      lineLen = indent.length - 1;
    }
    line.push(part);
    lineLen += part.length + 1;
  }
  lines.push(line.join(' '));
  return prefix + lines.map((l, i) => (i ? indent + l : l)).join('\n');
}

/**
 * ArgumentParser for a CI script whose options are all `--name VALUE` (specs: [{flag, default, int?}]), with argparse's own
 * usage line and -h text (the shared args.js prints a simplified usage). `int: true` is argparse's type=int.
 */
export function makeParser(prog, specs) {
  const ap = new ArgumentParser({ prog });
  const meta = (s) => s.flag.slice(2).replaceAll('-', '_').toUpperCase();
  for (const s of specs) {
    const type = s.int
      ? (raw) => {
          try {
            return pyInt(raw);
          } catch {
            return ap.fail(`argument ${s.flag}: invalid int value: ${pyRepr(raw)}`);
          }
        }
      : undefined;
    ap.addArgument(s.flag, { default: s.default, ...(type ? { type } : {}) });
  }
  ap.usage = () => argparseUsage(prog, ['[-h]', ...specs.map((s) => `[${s.flag} ${meta(s)}]`)]);
  const invocations = ['-h, --help', ...specs.map((s) => `${s.flag} ${meta(s)}`)];
  const helpPos = Math.min(Math.max(...invocations.map((i) => i.length)) + 2 + 2, 24);
  const width = helpPos - 4;
  ap.description = 'options:\n' + invocations.map((inv, i) => (i === 0 ? `  ${inv.padEnd(width)}  show this help message and exit` : `  ${inv}`)).join('\n');
  ap.longFlags = ['--help', ...specs.map((s) => s.flag)];
  return ap;
}

/** The arguments argparse reports as "unrecognized", in command-line order (no positionals are defined: everything not an option or its value). */
function unrecognized(ap, argv) {
  const known = new Set(ap.longFlags);
  const extras = [];
  let i = 0;
  while (i < argv.length) {
    const tok = argv[i];
    if (tok === '--') {
      extras.push(...argv.slice(i));
      break;
    }
    if (tok.startsWith('-') && tok !== '-' && !/^-\d+(\.\d+)?$/.test(tok)) {
      const eq = tok.startsWith('--') ? tok.indexOf('=') : -1;
      if (known.has(eq === -1 ? tok : tok.slice(0, eq))) {
        i += eq === -1 ? 2 : 1; // the option and its value
        continue;
      }
    }
    extras.push(tok);
    i++;
  }
  return extras;
}

/** Parse like argparse (allow_abbrev=True): a unique prefix of a long option stands for the option. */
export function parseArgs(ap, argv) {
  const out = [];
  let rest = false;
  for (const tok of argv) {
    if (rest || !tok.startsWith('--') || tok === '--') {
      if (tok === '--') rest = true;
      out.push(tok);
      continue;
    }
    const eq = tok.indexOf('=');
    const name = eq === -1 ? tok : tok.slice(0, eq);
    if (ap.longFlags.includes(name)) {
      out.push(tok);
      continue;
    }
    const cands = ap.longFlags.filter((f) => f.startsWith(name));
    if (cands.length === 1) out.push(cands[0] + (eq === -1 ? '' : tok.slice(eq)));
    else if (cands.length > 1) ap.fail(`ambiguous option: ${tok} could match ${cands.join(', ')}`);
    else out.push(tok);
  }
  const [ns, extra] = ap.parseKnown(out);
  const dashes = rest ? 1 : 0; // parseKnown drops the '--' terminator
  if (extra.length + dashes) ap.fail(`unrecognized arguments: ${unrecognized(ap, out).join(' ')}`);
  return ns;
}

// ---------------------------------------------------------------------------

/** The repo's own branch. CI checks out PRs with a detached HEAD; only then fall back to the CI env var. */
export function currentBranch(root) {
  let b;
  try {
    b = pyStrip(gitPy(['rev-parse', '--abbrev-ref', 'HEAD'], root));
  } catch {
    b = '';
  }
  if (b !== '' && b !== 'HEAD') return b;
  for (const env of ['GITHUB_HEAD_REF', 'CI_COMMIT_REF_NAME']) {
    if (process.env[env]) return process.env[env];
  }
  return b;
}

/** Slug from .claude/lane.json (local) or from a wt/<slug> branch name (CI). null if neither. */
export function laneSlug(root) {
  const lane = K.findLane(root);
  if (lane && truthy(lane.slug)) return lane.slug;
  const b = currentBranch(root);
  const m = /^(?:wt|lane|feature)\/([A-Za-z0-9._-]+)\n?$/.exec(b);
  return m ? m[1] : null;
}

/** True when `git <args>` exits 0. Output is discarded; stdin is closed. */
function gitOk(args, cwd) {
  try {
    execFileSync('git', args, { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Make `base` usable for a `base...HEAD` diff, or say why it is not. A CI checkout made at depth 1 or for one branch
 * has neither the base ref nor the history down to the merge-base, and changedFiles() then either throws or falls back
 * to a two-dot diff against the wrong commits. So: fetch the base from its remote when the ref is missing, unshallow
 * when there is no merge-base, and report whatever is still missing. Returns null when ready, else the reason; a
 * missing base is never treated as "nothing changed". Fetches are non-interactive (no prompt, stdin closed).
 */
export function ensureBase(root, base) {
  const errors = [];
  const fetch = (args) => {
    try {
      execFileSync('git', ['fetch', '--no-tags', '-q', ...args], {
        cwd: root, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
    } catch (e) {
      errors.push(pyStrip(String(e.stderr ?? e.message)));
    }
  };
  const resolves = () => gitOk(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], root);
  const m = /^([^/]+)\/(.+)$/.exec(base);
  const remote = m && gitOk(['remote', 'get-url', m[1]], root) ? m[1] : null;
  const tail = () => (errors.length ? `: ${errors.join('; ')}` : '');
  if (!resolves() && remote) fetch([remote, `+refs/heads/${m[2]}:refs/remotes/${remote}/${m[2]}`]);
  if (!resolves()) return `base '${base}' not found${remote ? ` and could not be fetched from '${remote}'` : ''}${tail()}`;
  const mergeBase = () => gitOk(['merge-base', base, 'HEAD'], root);
  if (!mergeBase() && remote && pyStrip(gitPy(['rev-parse', '--is-shallow-repository'], root)) === 'true') fetch(['--unshallow', remote]);
  if (!mergeBase()) return `base '${base}' and HEAD have no common ancestor in this checkout${tail()}`;
  return null;
}

export function changedFiles(root, base) {
  let out;
  try {
    out = gitPy(['diff', '--name-only', `${base}...HEAD`], root);
  } catch (e) {
    if (!isCalledProcessError(e)) throw e;
    out = gitPy(['diff', '--name-only', base], root);
  }
  return K.splitlines(out).map(pyStrip).filter((l) => l !== '');
}

export function fail(msg) {
  process.stderr.write(msg + '\n');
  return 1;
}

export function ok(msg) {
  process.stdout.write(msg + '\n');
  return 0;
}
