// shell_changes: which files in a lane's worktree a Bash call changed, judged by comparing a snapshot taken before the
// call with one taken after it. Used by guard-bash (PreToolUse: the snapshot before) and post-edit-check
// (PostToolUse: the snapshot after, the difference, and the lane's last known state).
//
// Why a difference and not `git status`. `git status` answers "what differs from HEAD", which is everything the lane,
// the setup, a human or the sandbox left in the worktree, not what this command did. The first real-agent eval
// (main 516ffdd) showed the cost: in a lane run under srt the scope check blocked `ls` and `npx tsc` twice, naming
// `.bashrc`, `.gitconfig`, `.mcp.json` and eight more paths nobody had written, and told the agent to
// `git checkout --` paths that were not tracked.
//
// Why only regular files and symlinks. Those eleven paths were character devices 1,3 owned by `nobody`: srt
// (@anthropic-ai/sandbox-runtime, bubblewrap on Linux) protects deny paths that do not exist yet by mounting
// /dev/null on them ("This is used to block creation of non-existent deny paths by mounting /dev/null", and "When
// bwrap does --ro-bind /dev/null /nonexistent/path, it creates an empty file on the host as a mount point"
// [source: @anthropic-ai/sandbox-runtime 0.0.83 dist/sandbox/linux-sandbox-utils.js, findFirstNonExistentComponent
// and bwrapMountPoints; the masked names are DANGEROUS_FILES and the dangerous directories in sandbox-utils.js]).
// Git lists such a path as an untracked file because the directory entry underneath is that empty regular file, but
// inside the sandbox lstat says character device. A device, FIFO or socket has no content a command can have edited
// and no remedy an agent can apply, so it is never a change here. lstat, not stat: a symlink is judged by its target
// string, never by what it points at, and reading a FIFO would hang.
//
// How a regular file is compared: by a SHA-256 of its content, so a command that rewrites a file with the same bytes
// (a formatter run over the tree, `git stash && git stash pop`) changes nothing, and a write that keeps the size and
// lands in the same timestamp tick is still seen. Hashing is kept cheap the way git keeps its index cheap: a file
// whose (size, mtime, ctime, inode) are those recorded in the previous snapshot reuses that snapshot's hash, unless
// its ctime was within RACY_MS of when that snapshot was taken (a write in the same tick would not have moved it).
// Only paths git reports as differing from HEAD are snapshotted, so the cost follows the size of the lane's change,
// not of the repository. A file over HASH_MAX_BYTES is compared by (size, mtime, ctime, inode) alone.
//
// The baseline, best first:
//   before   the snapshot guard-bash took for this tool_use_id (PreToolUse), the same mechanism the read log uses to
//            hand PreToolUse state to PostToolUse: a file under .claude/session/
//   last     the lane's last known state, written by post-edit-check at the end of every run it makes in the lane
//            (a session whose guard-bash predates this file, or a call with no tool_use_id)
//   session  neither exists: only a regular file or symlink whose ctime is after the session started (the
//            transcript's first timestamp, else the lane stage's `started`) counts, and no deletion does, so nothing
//            that existed before the session is ever blamed on it
//
// Calls that run in parallel share a window: a file written by one is reported by every call whose window covers
// the write. It was still written by a shell command of this session, which is what the scope check is for.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as K from './kitlib.js';

export const SCHEMA = 1;
export const HASH_MAX_BYTES = 8 * 1024 * 1024;
/** Timestamp granularity to allow for: ext4 and APFS are well under it; FAT's 2 s is the coarsest a worktree may sit on. */
export const RACY_MS = 2000;
/** Before-snapshots of calls that never reached PostToolUse (a guard refused, the human denied) are pruned after this. */
export const STALE_BEFORE_MS = 24 * 3600 * 1000;
const STATE_DIR = path.join(K.SESSION_DIR, 'shell');
const SESSION_PREFIX = K.SESSION_DIR.split(path.sep).join('/') + '/';

/** The only kinds that have content a shell command can change. */
export const CONTENT_KINDS = new Set(['file', 'symlink']);

/** 'file' | 'symlink' | 'dir' | 'special' (character or block device, FIFO, socket) | null (absent), from an lstat result. */
export function kindOf(st) {
  if (!st) return null;
  if (st.isSymbolicLink()) return 'symlink';
  if (st.isFile()) return 'file';
  if (st.isDirectory()) return 'dir';
  return 'special';
}

function lstatOrNull(lstat, p) {
  try {
    return lstat(p, { bigint: true });
  } catch (e) {
    if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') return null;
    throw e;
  }
}

const ns = (st, key) => {
  const v = st[`${key}Ns`];
  return typeof v === 'bigint' ? v : BigInt(Math.round(Number(st[`${key}Ms`] ?? 0) * 1e6));
};

/** SHA-256 of a regular file's content; null when it is not a regular file by the time it is opened. Never blocks on a FIFO. */
function hashFile(abs) {
  let fd;
  try {
    fd = fs.openSync(abs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  } catch {
    return null;
  }
  try {
    if (!fs.fstatSync(fd).isFile()) return null;
    const h = crypto.createHash('sha256');
    const buf = Buffer.allocUnsafe(1 << 16);
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n));
    return h.digest('hex');
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * One path's state. `prev` is the same path's entry in the previous snapshot and `prevTaken` when that snapshot was
 * taken, so an unchanged file is not hashed again. `lstat` is injectable for tests.
 */
export function entryFor(abs, { prev = null, prevTaken = 0, lstat = fs.lstatSync } = {}) {
  const st = lstatOrNull(lstat, abs);
  const k = kindOf(st);
  if (k === null) return { k: null };
  const ctimeNs = ns(st, 'ctime');
  const e = { k, c: Number(ctimeNs / 1000000n) };
  if (k === 'symlink') {
    try {
      e.t = fs.readlinkSync(abs);
    } catch {
      e.t = null;
    }
  } else if (k === 'file') {
    const size = BigInt(st.size);
    e.m = `${size}:${ns(st, 'mtime')}:${ctimeNs}:${st.ino}`;
    if (size <= BigInt(HASH_MAX_BYTES)) {
      const reuse = prev && prev.k === 'file' && prev.m === e.m && prev.h && prev.c < prevTaken - RACY_MS;
      e.h = reuse ? prev.h : hashFile(abs);
    }
  }
  return e;
}

/**
 * Paths git reports as differing from HEAD or untracked, each with its status code: Map rel -> 'XY'. A rename or copy
 * contributes both paths (the source as deleted). null when git cannot answer.
 */
export function dirtyPaths(root) {
  const p = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: root, encoding: 'utf8', timeout: 20000, maxBuffer: 1 << 28 });
  if (p.status !== 0 || typeof p.stdout !== 'string') return null;
  const out = new Map();
  const parts = p.stdout.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    out.set(rec.slice(3), xy);
    if (xy[0] === 'R' || xy[0] === 'C') {
      const src = parts[++i];
      if (src && xy[0] === 'R' && !out.has(src)) out.set(src, ' D');
    }
  }
  return out;
}

/** Snapshot of the lane's changed paths: { v, taken, entries: { rel: entry } }. null when git cannot answer. */
export function snapshot(root, prev = null, { lstat = fs.lstatSync, now = Date.now } = {}) {
  const taken = now();
  const dirty = dirtyPaths(root);
  if (!dirty) return null;
  const prevEntries = prev?.entries ?? {};
  const prevTaken = Number(prev?.taken) || 0;
  const entries = {};
  for (const [rel, xy] of dirty) {
    if (rel.startsWith(SESSION_PREFIX)) continue; // the hooks' own state, these snapshots included, never a command's
    entries[rel] = { xy, ...entryFor(path.join(root, rel), { prev: prevEntries[rel] ?? null, prevTaken, lstat }) };
  }
  return { v: SCHEMA, taken, entries };
}

function sameContent(a, b) {
  if (a.k !== b.k) return false;
  if (a.k === 'file') return a.h && b.h ? a.h === b.h : a.m === b.m;
  if (a.k === 'symlink') return a.t === b.t;
  return true; // absent, directory, special: no content to compare
}

/**
 * The paths whose content changed between `before` and `after`: [{ rel, xy, kind }] (kind null = deleted).
 *
 * A path in `before` is changed when its content differs. A path git did not list in `before` was then identical to
 * HEAD, so it changed if it is gone now, or if its ctime is after `before` was taken: a path that differs from HEAD
 * without having been written since (a commit or reset moved HEAD under it) did not change in this window. A
 * `before` with `partial: true` (the session-start fallback) knows nothing about deletions and claims none.
 * Directories, devices, FIFOs and sockets never count.
 */
export function changedPaths(before, after) {
  const out = [];
  const prior = before?.entries ?? {};
  const since = Number(before?.taken) || 0;
  for (const [rel, a] of Object.entries(after?.entries ?? {})) {
    const b = Object.hasOwn(prior, rel) ? prior[rel] : null;
    let changed;
    if (b) {
      changed = (CONTENT_KINDS.has(a.k) || (a.k === null && CONTENT_KINDS.has(b.k))) && !sameContent(b, a);
    } else if (a.k === null) {
      changed = !before?.partial;
    } else {
      changed = CONTENT_KINDS.has(a.k) && a.c >= since - RACY_MS;
    }
    if (changed) out.push({ rel, xy: a.xy, kind: a.k });
  }
  return out.sort((x, y) => (x.rel < y.rel ? -1 : x.rel > y.rel ? 1 : 0));
}

const stateDir = (laneRoot) => path.join(laneRoot, STATE_DIR);
const safeId = (id) => String(id).replace(/[^A-Za-z0-9_.-]/g, '_');
export const beforePath = (laneRoot, toolUseId) => path.join(stateDir(laneRoot), `before.${safeId(toolUseId)}.json`);
export const lastPath = (laneRoot) => path.join(stateDir(laneRoot), 'last.json');

function readJson(p) {
  try {
    const v = JSON.parse(fs.readFileSync(p, 'utf8'));
    return v && typeof v === 'object' && v.v === SCHEMA && v.entries && typeof v.entries === 'object' ? v : null;
  } catch {
    return null;
  }
}

/** Write via a temporary file and rename, so a parallel reader never sees half a snapshot. */
function writeJson(p, value) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, p);
}

/** The lane post-edit-check would judge this call in: for a Bash call, the one holding the hook's cwd. */
export function laneOf(d) {
  const cwd = typeof d?.cwd === 'string' && d.cwd ? d.cwd : '.';
  return K.laneFor(cwd, null);
}

/** PreToolUse on Bash (guard-bash, once it lets the call through): record the lane's state for this tool_use_id. */
export function recordBefore(d) {
  const id = typeof d?.tool_use_id === 'string' && d.tool_use_id ? d.tool_use_id : null;
  const lane = id ? laneOf(d) : null;
  if (!lane) return null;
  const snap = snapshot(lane.root, readJson(lastPath(lane.root)));
  if (!snap) return null;
  writeJson(beforePath(lane.root, id), snap);
  const dir = stateDir(lane.root);
  for (const f of fs.readdirSync(dir)) {
    if (!f.startsWith('before.')) continue;
    try {
      if (Date.now() - fs.statSync(path.join(dir, f)).mtimeMs > STALE_BEFORE_MS) fs.rmSync(path.join(dir, f), { force: true });
    } catch {
      // another hook removed it
    }
  }
  return snap;
}

/** Local wall-clock 'YYYY-MM-DDTHH:MM:SS' (lane.json `started`) as epoch ms; NaN when unreadable. */
function wallClockMs(s) {
  const m = /^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)(?::(\d\d))?/.exec(typeof s === 'string' ? s : '');
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0)).getTime() : NaN;
}

/** When the session started: the transcript's first timestamp, else the lane stage's `started`; NaN when neither is known. */
export function sessionStartMs(d, lane) {
  const tp = typeof d?.transcript_path === 'string' ? d.transcript_path : '';
  if (tp) {
    try {
      const fd = fs.openSync(tp, 'r');
      const buf = Buffer.alloc(64 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const m = /"timestamp"\s*:\s*"([^"]+)"/.exec(buf.subarray(0, n).toString('utf8'));
      const t = m ? Date.parse(m[1]) : NaN;
      if (Number.isFinite(t)) return t;
    } catch {
      // no transcript
    }
  }
  return wallClockMs(lane?.data?.started);
}

/**
 * The state to compare this call's end state with: { snap, via: 'before' | 'last' | 'session' | 'none' }. With 'none'
 * (no snapshot and no known session start) nothing can be attributed and nothing is.
 */
export function baselineFor(lane, d) {
  const id = typeof d?.tool_use_id === 'string' && d.tool_use_id ? d.tool_use_id : null;
  const before = id ? readJson(beforePath(lane.root, id)) : null;
  if (before) return { snap: before, via: 'before' };
  const last = readJson(lastPath(lane.root));
  if (last) return { snap: last, via: 'last' };
  const start = sessionStartMs(d, lane);
  if (Number.isFinite(start)) return { snap: { v: SCHEMA, taken: start + RACY_MS, partial: true, entries: {} }, via: 'session' };
  return { snap: null, via: 'none' };
}

/**
 * PostToolUse on Bash: what this call changed. { changed, after, via }. The before-snapshot is left in place (a
 * project's settings and an agent's frontmatter can both register post-edit-check, and both runs must see it) and
 * pruned later by recordBefore.
 */
export function changedByCall(lane, d) {
  const { snap, via } = baselineFor(lane, d);
  const last = via === 'last' ? snap : readJson(lastPath(lane.root));
  const after = snapshot(lane.root, via === 'before' ? snap : last);
  if (!after || !snap) return { changed: [], after, via };
  return { changed: changedPaths(snap, after), after, via };
}

/** Record the lane's state after a post-edit-check run, as the baseline for a later call that has no before-snapshot. */
export function saveLast(lane, prev = null) {
  const snap = snapshot(lane.root, prev ?? readJson(lastPath(lane.root)));
  if (snap) writeJson(lastPath(lane.root), snap);
  return snap;
}
