// shell_changes: which files in a lane's worktree a Bash call changed, judged by comparing a snapshot taken before the
// call with one taken after it, and which out-of-scope changes are still there. Used by guard-bash (PreToolUse: the
// snapshot before), post-edit-check (PostToolUse: the snapshot after, the difference, the flagged paths) and
// done-check (Stop: no "done" while a flagged path is still there).
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
// How a regular file is compared: by a hash of its content, so a command that rewrites a file with the same bytes
// (a formatter run over the tree, `git stash && git stash pop`) changes nothing, and a write that keeps the size and
// lands in the same timestamp tick is still seen. A file whose (size, mtime, ctime, inode) are those of the previous
// snapshot is not hashed again; the one exception is git's "racy" case, a file whose ctime was within RACY_MS of
// when that snapshot was taken, which a same-tick write would not have moved (only files touched in the two seconds
// before the previous snapshot). Only paths git reports as differing from HEAD are snapshotted, so the cost follows
// the size of the lane's change, not of the repository. A file over HASH_MAX_BYTES is compared by its stat tuple.
//
// The baseline, best first:
//   before   the snapshot guard-bash took for this tool_use_id (PreToolUse), the same mechanism the read log uses to
//            hand PreToolUse state to PostToolUse: a file under .claude/session/. It is a reference, not a copy, when
//            the worktree is as the lane's last state recorded it, which is the usual case.
//   last     the lane's last known state, written by post-edit-check after every run it makes in the lane, and
//            rewritten only when it changed (a session whose guard-bash predates this file, or no tool_use_id)
//   session  neither exists: only a regular file or symlink whose ctime is after the session started (the
//            transcript's first timestamp, else the lane stage's `started`) counts, and no deletion does, so nothing
//            that existed before the session is ever blamed on it
//
// Calls that overlap. Claude Code runs a message's tool calls in parallel, and a write by one lands in the window of
// every call running alongside it. When another call was in flight during this one (its before-file is there and
// the transcript has no result for it) or finished inside this one's window, a change is reported as having
// appeared during overlapping calls, not as written by this command. It still blocks.
//
// Out-of-scope changes. post-edit-check reports, and done-check refuses "done" on, every path in which the lane
// differs from its base commit (lane.json base_commit) outside the spec: commits since the base, the working tree, and
// untracked files the session wrote. git is the source; flagged.json only caches which call made each change and an
// untracked file's earlier content, and is rebuilt when missing or unreadable (reconcile). A path clears when its
// content equals the base again (or it is gone, if the base lacked it), or when the spec allows it; a commit does not
// clear it. The list is for the lane, not only the session: the worktree is shared, and all of it is the lane's diff.
//
// Duplicate runs. Claude Code runs "the same handler in more than one settings file" once; it says nothing of the
// same command in settings and in an agent's frontmatter [docs: https://code.claude.com/docs/en/hooks @ 2026-11-23],
// and the kit registers post-edit-check in both. The first run claims the before-file by renaming it (atomic: one
// run wins) and deletes it when done; a second run waits for the claim to go and then reads the flags the first
// one recorded, so both report the same thing and nothing is kept for the duplicate.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as K from './kitlib.js';

export const SCHEMA = 2;
export const HASH_MAX_BYTES = 8 * 1024 * 1024;
/** Timestamp granularity to allow for: ext4 and APFS are well under it; FAT's 2 s is the coarsest a worktree may sit on. */
export const RACY_MS = 2000;
/** Claude Code's Bash tool runs at most 10 minutes; a before-file older than this belongs to a call that never got a PostToolUse. */
export const ORPHAN_MS = 15 * 60 * 1000;
/** A temporary file is renamed within milliseconds of being written; one this old was left by a killed process. */
export const TMP_ORPHAN_MS = 60 * 1000;
/** How long a duplicate post-edit-check run waits for the run that claimed the before-file. */
export const DUPLICATE_WAIT_MS = 20 * 1000;
const STATE_DIR = path.join(K.SESSION_DIR, 'shell');
const SESSION_PREFIX = K.SESSION_DIR.split(path.sep).join('/') + '/';
const TRANSCRIPT_TAIL = 4 * 1024 * 1024;

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
    return lstat(p);
  } catch (e) {
    if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') return null;
    throw e;
  }
}

/** Hash of a regular file's content (128 bits of SHA-256); null when it is not a regular file by the time it is opened. Never blocks on a FIFO. */
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
    return h.digest('hex').slice(0, 32);
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * One path's state: { k, c, m?, h?, t? } (kind, ctime ms, stat tuple, content hash, symlink target). `prev` is the
 * same path's entry in the previous snapshot and `prevTaken` when that was taken. `lstat` is injectable for tests.
 */
export function entryFor(abs, { prev = null, prevTaken = 0, lstat = fs.lstatSync } = {}) {
  const st = lstatOrNull(lstat, abs);
  const k = kindOf(st);
  if (k === null) return { k: null };
  const e = { k, c: Math.floor(Number(st.ctimeMs)) };
  if (k === 'symlink') {
    try {
      e.t = fs.readlinkSync(abs);
    } catch {
      e.t = null;
    }
  } else if (k === 'file') {
    const size = Number(st.size);
    e.m = `${size}:${Number(st.mtimeMs)}:${Number(st.ctimeMs)}:${st.ino}`;
    if (size <= HASH_MAX_BYTES) {
      const reuse = prev && prev.k === 'file' && prev.m === e.m && prev.h && prev.c < prevTaken - RACY_MS;
      e.h = reuse ? prev.h : hashFile(abs);
    }
  }
  return e;
}

/**
 * Paths git reports as differing from HEAD or untracked, each with its status code: Map rel -> 'XY' (porcelain v1
 * letters), with `.head` set to HEAD's commit. A rename or copy contributes both paths (the source as deleted). null
 * when git cannot answer. Porcelain v2 because it reports HEAD in the same call.
 */
export function dirtyPaths(root) {
  const p = spawnSync('git', ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], { cwd: root, encoding: 'utf8', timeout: 20000, maxBuffer: 1 << 28 });
  if (p.status !== 0 || typeof p.stdout !== 'string') return null;
  const out = new Map();
  out.head = null;
  const keep = (rel) => rel && !rel.startsWith(SESSION_PREFIX); // the hooks' own state, these files included, never a command's
  const v1 = (xy) => xy.replaceAll('.', ' ');
  const parts = p.stdout.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    const kind = rec[0];
    if (rec.startsWith('# branch.oid ')) {
      const oid = rec.slice(13).trim();
      out.head = /^[0-9a-f]{7,64}$/.test(oid) ? oid : null;
    } else if (kind === '?') {
      if (keep(rec.slice(2))) out.set(rec.slice(2), '??');
    } else if (kind === '1' || kind === 'u') {
      const fields = kind === '1' ? 8 : 10;
      const rel = rec.split(' ').slice(fields).join(' ');
      if (keep(rel)) out.set(rel, v1(rec.slice(2, 4)));
    } else if (kind === '2') {
      const rel = rec.split(' ').slice(9).join(' ');
      const xy = v1(rec.slice(2, 4));
      const src = parts[++i];
      if (xy[0] === 'R' && keep(src) && !out.has(src)) out.set(src, ' D');
      if (keep(rel)) out.set(rel, xy);
    }
  }
  return out;
}

/** Snapshot of the lane's changed paths: { taken, entries: { rel: entry } }. null when git cannot answer. */
export function snapshot(root, prev = null, { lstat = fs.lstatSync, now = Date.now } = {}) {
  const taken = now();
  const dirty = dirtyPaths(root);
  if (!dirty) return null;
  const prevEntries = prev?.entries ?? {};
  const prevTaken = Number(prev?.taken) || 0;
  const entries = {};
  for (const [rel, xy] of dirty) {
    entries[rel] = { xy, ...entryFor(path.join(root, rel), { prev: prevEntries[rel] ?? null, prevTaken, lstat }) };
  }
  return { taken, head: dirty.head, entries };
}

export function sameContent(a, b) {
  if (!a || !b) return !a && !b;
  if (a.k !== b.k) return false;
  if (a.k === 'file') return a.h && b.h ? a.h === b.h : a.m === b.m;
  if (a.k === 'symlink') return a.t === b.t;
  return true; // absent, directory, special: no content to compare
}

/**
 * The paths whose content changed between `before` and `after`: [{ rel, xy, kind, prior }] (kind null = deleted;
 * prior = the path's entry in `before`, null when git did not list it there).
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
    if (changed) out.push({ rel, xy: a.xy, kind: a.k, prior: b });
  }
  return out.sort((x, y) => (x.rel < y.rel ? -1 : x.rel > y.rel ? 1 : 0));
}

// ---------------------------------------------------------------------------------------------- storage

const stateDir = (laneRoot) => path.join(laneRoot, STATE_DIR);
const safeId = (id) => String(id).replace(/[^A-Za-z0-9_.-]/g, '_');
export const beforePath = (laneRoot, toolUseId) => path.join(stateDir(laneRoot), `before.${safeId(toolUseId)}.json`);
const claimPath = (laneRoot, toolUseId) => path.join(stateDir(laneRoot), `claim.${safeId(toolUseId)}.json`);
export const lastPath = (laneRoot) => path.join(stateDir(laneRoot), 'last.json');
export const flaggedPath = (laneRoot) => path.join(stateDir(laneRoot), 'flagged.json');
const windowsPath = (laneRoot) => path.join(stateDir(laneRoot), 'windows.json');

/** Entries on disk: one array per path, [xy, kind, ctime, stat tuple, hash or link target]. */
const pack = (e) => [e.xy ?? '', e.k, e.c ?? 0, e.m ?? null, e.k === 'symlink' ? e.t ?? null : e.h ?? null];
function unpack(a) {
  if (!Array.isArray(a)) return null;
  const [xy, k, c, m, x] = a;
  const e = { xy, k, c };
  if (m !== null) e.m = m;
  if (k === 'symlink') e.t = x;
  else if (x !== null) e.h = x;
  return e;
}
const packEntries = (entries) => Object.fromEntries(Object.entries(entries).map(([rel, e]) => [rel, pack(e)]));
const unpackEntries = (packed) => Object.fromEntries(Object.entries(packed ?? {}).map(([rel, a]) => [rel, unpack(a)]));

/** The packed entries and their digest: two snapshots with the same digest record the same state. */
function serialize(snap) {
  const packed = packEntries(snap.entries);
  const text = JSON.stringify(packed);
  return { packed, digest: crypto.createHash('sha256').update(text).digest('hex').slice(0, 32) };
}

function readJson(p) {
  try {
    const v = JSON.parse(fs.readFileSync(p, 'utf8'));
    return v && typeof v === 'object' && v.v === SCHEMA ? v : null;
  } catch {
    return null;
  }
}

/** Write via a temporary file and rename, so a parallel reader never sees half a file. */
function writeJson(p, value) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, p);
}

/** The lane's last known state: { taken, digest, entries } or null. */
export function readLast(laneRoot) {
  const v = readJson(lastPath(laneRoot));
  return v && v.entries ? { taken: Number(v.taken) || 0, digest: v.digest, entries: unpackEntries(v.entries) } : null;
}

/** True when two snapshots record the same entries (compared field by field: cheaper than serializing them). */
export function sameEntries(a, b) {
  const ka = Object.keys(a.entries);
  if (ka.length !== Object.keys(b.entries).length) return false;
  for (const rel of ka) {
    const x = a.entries[rel];
    const y = b.entries[rel];
    if (!y || x.xy !== y.xy || x.k !== y.k || x.c !== y.c || x.m !== y.m || x.h !== y.h || x.t !== y.t) return false;
  }
  return true;
}

/** Whether `last` holds a hash that was "racy" when taken (see entryFor) but would not be now: worth recording again once. */
const settles = (last, now) => Object.values(last.entries).some((e) => e.h && e.c >= last.taken - RACY_MS && e.c < now - RACY_MS);

/**
 * Record `snap` as the lane's last state, unless it is the state already recorded: an unchanged worktree costs no
 * write. It is rewritten once more when that lets recently written files' hashes be reused from then on.
 */
export function writeLast(laneRoot, snap, last = readLast(laneRoot)) {
  if (last && sameEntries(snap, last) && !settles(last, snap.taken)) return last.digest;
  const { packed, digest } = serialize(snap);
  writeJson(lastPath(laneRoot), { v: SCHEMA, taken: snap.taken, digest, entries: packed });
  return digest;
}

/** Remove what a killed or refused call left: before- and claim-files past ORPHAN_MS, temporary files past TMP_ORPHAN_MS. */
export function prune(laneRoot, now = Date.now()) {
  const dir = stateDir(laneRoot);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const f of names) {
    const limit = f.endsWith('.tmp') ? TMP_ORPHAN_MS : f.startsWith('before.') || f.startsWith('claim.') ? ORPHAN_MS : null;
    if (limit === null) continue;
    try {
      if (now - fs.statSync(path.join(dir, f)).mtimeMs > limit) fs.rmSync(path.join(dir, f), { force: true });
    } catch {
      // another hook removed it
    }
  }
}

/** The lane post-edit-check would judge this call in: for a Bash call, the one holding the hook's cwd. */
export function laneOf(d) {
  const cwd = typeof d?.cwd === 'string' && d.cwd ? d.cwd : '.';
  return K.laneFor(cwd, null);
}

const toolUseId = (d) => (typeof d?.tool_use_id === 'string' && d.tool_use_id ? d.tool_use_id : null);

/** PreToolUse on Bash (guard-bash, once it lets the call through): record the lane's state for this tool_use_id. */
export function recordBefore(d) {
  const id = toolUseId(d);
  const lane = id ? laneOf(d) : null;
  if (!lane) return null;
  const last = readLast(lane.root);
  const snap = snapshot(lane.root, last);
  if (!snap) return null;
  ensureOrigin(lane, d, snap.entries);
  const rec = { v: SCHEMA, session: typeof d.session_id === 'string' ? d.session_id : '', taken: snap.taken };
  // The usual case: nothing changed since post-edit-check recorded the lane's state, so a reference is enough.
  if (last && sameEntries(snap, last)) Object.assign(rec, { same_as_last: true, digest: last.digest });
  else rec.entries = packEntries(snap.entries);
  writeJson(beforePath(lane.root, id), rec);
  prune(lane.root);
  return snap;
}

/** Local wall-clock 'YYYY-MM-DDTHH:MM:SS' (lane.json `started`) as epoch ms; NaN when unreadable. */
function wallClockMs(s) {
  const m = /^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)(?::(\d\d))?/.exec(typeof s === 'string' ? s : '');
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0)).getTime() : NaN;
}

function readHead(p, n) {
  try {
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.alloc(n);
      return buf.subarray(0, fs.readSync(fd, buf, 0, n, 0)).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function readTail(p, n) {
  try {
    const fd = fs.openSync(p, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, n);
      const buf = Buffer.alloc(len);
      return buf.subarray(0, fs.readSync(fd, buf, 0, len, size - len)).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** When the session started: the transcript's first timestamp, else the lane stage's `started`; NaN when neither is known. */
export function sessionStartMs(d, lane) {
  const tp = typeof d?.transcript_path === 'string' ? d.transcript_path : '';
  const head = tp ? readHead(tp, 64 * 1024) : null;
  const m = head ? /"timestamp"\s*:\s*"([^"]+)"/.exec(head) : null;
  const t = m ? Date.parse(m[1]) : NaN;
  return Number.isFinite(t) ? t : wallClockMs(lane?.data?.started);
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Take this call's before-file for this run alone; null when there is none (or another run of the same hook took it). */
function claimBefore(laneRoot, id) {
  const claim = claimPath(laneRoot, id);
  try {
    fs.renameSync(beforePath(laneRoot, id), claim);
  } catch {
    return null;
  }
  return readJson(claim);
}

/**
 * Whether another Bash call ran during [from, to]: one still in flight (its before- or claim-file is there, is not an
 * orphan, and the transcript has no result for it) or one that finished inside the window.
 */
function overlapped(lane, d, id, from, to) {
  const wins = readJson(windowsPath(lane.root))?.calls ?? [];
  if (wins.some((w) => w.id !== id && w.to > from && w.from < to)) return true;
  let names;
  try {
    names = fs.readdirSync(stateDir(lane.root));
  } catch {
    return false;
  }
  const others = [];
  for (const f of names) {
    const m = /^(?:before|claim)\.(.+)\.json$/.exec(f);
    if (!m || m[1] === safeId(id)) continue;
    try {
      const st = fs.statSync(path.join(stateDir(lane.root), f));
      if (to - st.mtimeMs < ORPHAN_MS && st.mtimeMs < to) others.push(m[1]);
    } catch {
      // finished meanwhile
    }
  }
  if (!others.length) return false;
  // A call the human or a permission rule refused never gets a PostToolUse, but the transcript has its result; so does
  // a call whose hook run died after claiming its record. Neither is in flight. Once the result is older than a
  // duplicate run would wait, the file is stale and is removed, so later calls are not told of an overlap either.
  const tp = typeof d?.transcript_path === 'string' ? d.transcript_path : '';
  const tail = tp ? readTail(tp, TRANSCRIPT_TAIL) : null;
  const done = (o) => Boolean(tail) && new RegExp(`"tool_use_id"\\s*:\\s*"${o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(tail);
  let any = false;
  for (const o of others) {
    if (!done(o)) {
      any = true;
      continue;
    }
    for (const f of [`before.${o}.json`, `claim.${o}.json`]) {
      const fp = path.join(stateDir(lane.root), f);
      try {
        if (to - fs.statSync(fp).mtimeMs > DUPLICATE_WAIT_MS) fs.rmSync(fp, { force: true });
      } catch {
        // not there
      }
    }
  }
  return any;
}

function recordWindow(laneRoot, w) {
  const cutoff = w.to - ORPHAN_MS;
  const calls = (readJson(windowsPath(laneRoot))?.calls ?? []).filter((x) => x.to > cutoff && x.id !== w.id).slice(-199);
  writeJson(windowsPath(laneRoot), { v: SCHEMA, calls: [...calls, w] });
}

/**
 * PostToolUse on Bash: what this call changed. { changed, after, via, overlap, from, claimed }.
 * Call release() once the result is recorded.
 */
export function assess(lane, d) {
  const id = toolUseId(d);
  let rec = id ? claimBefore(lane.root, id) : null;
  let duplicate = false;
  if (!rec && id && fs.existsSync(claimPath(lane.root, id))) {
    // another run of this same hook claimed it: wait for it to record what it found, then report the same
    duplicate = true;
    const age = () => {
      try {
        return Date.now() - fs.statSync(claimPath(lane.root, id)).mtimeMs;
      } catch {
        return Infinity;
      }
    };
    while (fs.existsSync(claimPath(lane.root, id)) && age() < DUPLICATE_WAIT_MS) sleep(25);
    // the run that claimed it died: its claim must not read as a call in flight for the next quarter hour
    fs.rmSync(claimPath(lane.root, id), { force: true });
  }
  // A run of this call that finished first recorded what it reported; a second run reports exactly that.
  const done = id ? (readJson(windowsPath(lane.root))?.calls ?? []).find((w) => w.id === id && w.report) : null;
  if (!rec && done) return { changed: [], after: null, via: 'duplicate', overlap: false, from: done.from, claimed: false, duplicate: true, report: done.report };
  const last = readLast(lane.root);
  let base = null;
  let via;
  let overlap = false;
  if (rec?.entries) {
    base = { taken: rec.taken, entries: unpackEntries(rec.entries) };
    via = 'before';
  } else if (rec?.same_as_last && last) {
    base = last.digest === rec.digest ? { taken: rec.taken, entries: last.entries } : last;
    // the recorded state moved on between this call's start and now: another call finished in between
    overlap = last.digest !== rec.digest;
    via = 'before';
  } else if (last) {
    base = last;
    via = 'last';
  } else {
    const start = sessionStartMs(d, lane);
    if (Number.isFinite(start)) base = { taken: start + RACY_MS, partial: true, entries: {} };
    via = base ? 'session' : 'none';
  }
  ensureOrigin(lane, d, base && !base.partial ? base.entries : null);
  const after = snapshot(lane.root, base?.partial ? last : base);
  const from = rec ? rec.taken : base?.taken ?? 0;
  if (!after || !base) return { changed: [], after, via, overlap: false, from, claimed: Boolean(rec), duplicate };
  const changed = changedPaths(base, after);
  if (changed.length && !overlap) overlap = overlapped(lane, d, id, from, after.taken);
  return { changed, after, via, overlap, from, claimed: Boolean(rec), duplicate };
}

/**
 * After assess(): record the call's window, with what it reported (`report`: the rels this call was judged to have
 * changed and those that appeared while it overlapped others), and delete its claim, so the directory holds no
 * per-call file afterwards and a duplicate run of the hook can report the same.
 */
export function release(lane, d, r, report = null) {
  const id = toolUseId(d);
  if (id && r?.claimed) {
    recordWindow(lane.root, { id, from: r.from, to: r.after?.taken ?? Date.now(), ...(report ? { report } : {}) });
    fs.rmSync(claimPath(lane.root, id), { force: true });
  }
  prune(lane.root);
}

// ---------------------------------------------------------------------------------------------- flagged paths

/** The spec's allow-list as a predicate: true for a path no Bash call in this lane may change. */
export function outsideSpec(lane) {
  const [, change, create] = K.specFileLists(lane.specPath);
  const allowed = [...change, ...create, ...lane.alwaysAllowed(), 'ROADMAP.md'];
  return (rel) => !rel.startsWith('.claude/') && !K.globMatch(rel, allowed);
}

function gitZ(args, cwd) {
  const p = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 20000, maxBuffer: 1 << 28 });
  return p.status === 0 && typeof p.stdout === 'string' ? p.stdout.split('\0').filter(Boolean) : null;
}

/**
 * The commit the lane started from: lane.json `base_commit` (what `lane.js start` resolved the base to), else
 * `start_commit`. null for a lane.json that records neither, or names a commit this clone does not have; the lane's
 * changes are then judged against HEAD, which misses what the lane already committed.
 */
export function laneBase(lane) {
  for (const c of [lane?.data?.base_commit, lane?.data?.start_commit]) {
    if (typeof c !== 'string' || !/^[0-9a-f]{7,64}$/.test(c)) continue;
    const p = spawnSync('git', ['rev-parse', '--verify', '-q', `${c}^{commit}`], { cwd: lane.root, encoding: 'utf8', timeout: 20000 });
    if (p.status === 0) return p.stdout.trim();
  }
  return null;
}

const checksWrotePath = (laneRoot) => path.join(stateDir(laneRoot), 'checks.json');

/** Untracked files the project's own checks (run by post-edit-check) created: theirs, not the lane's change. */
export function recordChecksWrote(laneRoot, before, end) {
  const prev = new Set(readJson(checksWrotePath(laneRoot))?.paths ?? []);
  const next = new Set([...prev].filter((rel) => end.entries[rel]?.xy === '??'));
  for (const [rel, e] of Object.entries(end.entries)) if (e.xy === '??' && !before.entries[rel]) next.add(rel);
  if (next.size !== prev.size || [...next].some((r) => !prev.has(r))) writeJson(checksWrotePath(laneRoot), { v: SCHEMA, paths: [...next].sort() });
}

/**
 * Every path in which the lane differs from its base, as git sees it: Map rel -> { untracked }. Committed changes
 * (base..HEAD), the working tree against the base (tracked paths), and untracked regular files or symlinks written
 * since the lane was created and the session started (so a sandbox mask or a file that was already there is not the
 * session's), minus what the project's own checks wrote. null when git cannot answer.
 */
export function laneChanges(lane, d = null) {
  const base = laneBase(lane);
  const out = new Map();
  out.base = base;
  const add = (rels, info) => {
    for (const rel of rels ?? []) if (!rel.startsWith(SESSION_PREFIX)) out.set(rel, { untracked: false, committed: false, ...out.get(rel), ...info });
  };
  const work = gitZ(['diff', '--name-only', '-z', '--no-renames', base ?? 'HEAD'], lane.root);
  if (!work) return null;
  add(work, {});
  if (base) {
    const committed = gitZ(['diff', '--name-only', '-z', '--no-renames', base, 'HEAD'], lane.root);
    if (!committed) return null;
    add(committed, { committed: true });
  }
  // An untracked file is the session's change unless it was already there: written before the lane was created or
  // this session started (a sandbox mask, a setup's or a human's file), or still the content it had when this
  // session's hooks first looked (origin.json; a rewrite with the same bytes moves the ctime, not the content).
  const floor = sessionFloor(lane, d);
  const origin = ensureOrigin(lane, d, null, floor);
  const byChecks = new Set(readJson(checksWrotePath(lane.root))?.paths ?? []);
  for (const rel of gitZ(['ls-files', '--others', '--exclude-standard', '-z'], lane.root) ?? []) {
    if (byChecks.has(rel) || rel.startsWith(SESSION_PREFIX)) continue;
    let st;
    try {
      st = fs.lstatSync(path.join(lane.root, rel));
    } catch {
      continue;
    }
    if (!CONTENT_KINDS.has(kindOf(st))) continue;
    const preexisting = st.ctimeMs < floor || (Object.hasOwn(origin, rel) && sameContent(unpack(origin[rel]), entryFor(path.join(lane.root, rel))));
    out.set(rel, { untracked: true, committed: false, preexisting });
  }
  return out;
}

/** Untracked files older than this are not the session's: when the lane was created or the session started, whichever is later. */
function sessionFloor(lane, d) {
  return Math.max(wallClockMs(lane.data?.created ?? lane.data?.started) || 0, sessionStartMs(d, lane) || 0);
}

const originPath = (laneRoot) => path.join(stateDir(laneRoot), 'origin.json');

/**
 * The untracked files that were there before this session started, with their content, recorded the first time a hook
 * looks in the session: { rel: packed entry }. Only files older than the session go in, so a file the session wrote
 * never does, even if this record is deleted and made again later (it can then only miss a file, never hide one).
 */
export function ensureOrigin(lane, d, entries = null, floor = sessionFloor(lane, d)) {
  const session = typeof d?.session_id === 'string' ? d.session_id : '';
  const cur = readJson(originPath(lane.root));
  if (cur && cur.session === session && cur.paths && typeof cur.paths === 'object') return cur.paths;
  const paths = {};
  if (entries) {
    for (const [rel, e] of Object.entries(entries)) if (e.xy === '??' && CONTENT_KINDS.has(e.k) && e.c < floor) paths[rel] = pack(e);
  } else {
    for (const rel of gitZ(['ls-files', '--others', '--exclude-standard', '-z'], lane.root) ?? []) {
      if (rel.startsWith(SESSION_PREFIX)) continue;
      const e = entryFor(path.join(lane.root, rel));
      if (CONTENT_KINDS.has(e.k) && e.c < floor) paths[rel] = pack({ xy: '??', ...e });
    }
  }
  writeJson(originPath(lane.root), { v: SCHEMA, session, paths });
  return paths;
}

/** The flag cache: { head, paths } or null when it is missing or unreadable (then it is rebuilt from git). */
function readFlagCache(laneRoot) {
  const v = readJson(flaggedPath(laneRoot));
  return v && v.paths && typeof v.paths === 'object' && !Array.isArray(v.paths) ? { head: v.head ?? null, paths: v.paths } : null;
}

function headOf(root) {
  const p = spawnSync('git', ['rev-parse', '-q', '--verify', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 20000 });
  return p.status === 0 ? p.stdout.trim() : null;
}

/**
 * The lane's out-of-scope changes: [{ rel, untracked, committed, inBase, base, prior, call, how, at }], judged against the lane's base
 * commit, not HEAD, so committing a flagged file does not clear it, and a commit that brings one in is found.
 *
 * flagged.json is a cache of this list with each path's history (which call changed it, and the content an untracked
 * file had before, if it was there already); git is the source. A path stays until its content equals the base (or it
 * is gone, if the base does not have it), or until the spec allows it; an untracked file that was already there
 * before the command clears when its earlier content is back. A missing or unreadable cache is rebuilt from git, so
 * deleting it changes nothing. With `force: false` the git comparison is skipped when the cache is valid, names no
 * path and HEAD has not moved since it was written: then every change since came through a Bash call, which flagged
 * it itself, or through Edit/Write, which guard-edit keeps inside the spec. done-check always forces.
 */
export function reconcile(lane, { force = true, head = undefined, d = null, outside = outsideSpec(lane) } = {}) {
  const cache = readFlagCache(lane.root);
  const flags = cache?.paths ?? {};
  const now = head === undefined ? headOf(lane.root) : head;
  if (!force && cache && cache.head && cache.head === now && !Object.keys(flags).length) return [];
  const changes = laneChanges(lane, d);
  if (!changes) {
    // git cannot answer: keep what is flagged rather than clear it
    return Object.entries(flags).map(([rel, f]) => ({ rel, untracked: false, committed: false, inBase: true, base: null, prior: null, call: f.call, how: f.how, at: f.at }));
  }
  const keep = {};
  const out = [];
  for (const rel of new Set([...Object.keys(flags), ...changes.keys()])) {
    if (!outside(rel) || !changes.has(rel)) continue;
    const { untracked, committed, preexisting } = changes.get(rel);
    if (untracked && preexisting && !flags[rel]) continue;
    const f = flags[rel] ?? { session: '', call: null, how: 'found', at: Date.now(), prior: null };
    const prior = f.prior ? unpack(f.prior) : null;
    if (untracked && prior && CONTENT_KINDS.has(prior.k) && sameContent(prior, entryFor(path.join(lane.root, rel)))) continue;
    keep[rel] = f;
    out.push({ rel, untracked, committed, base: changes.base, prior: untracked ? prior : null, call: f.call, how: f.how, at: f.at });
  }
  // which of them the base has: those go back to the base's content, the others are removed
  const tracked = out.filter((c) => !c.untracked).map((c) => c.rel);
  const inBase = new Set(tracked.length ? gitZ(['ls-tree', '-r', '-z', '--name-only', changes.base ?? 'HEAD', '--', ...tracked], lane.root) ?? [] : []);
  for (const c of out) c.inBase = inBase.has(c.rel);
  writeJson(flaggedPath(lane.root), { v: SCHEMA, head: now, paths: keep });
  return out.sort((x, y) => (x.rel < y.rel ? -1 : x.rel > y.rel ? 1 : 0));
}

/** Flag out-of-scope changes this call made (or that appeared while it overlapped others). */
export function flag(lane, d, bad, how) {
  if (!bad.length) return;
  const cache = readFlagCache(lane.root);
  const flags = cache?.paths ?? {};
  const at = Date.now();
  for (const c of bad) {
    if (Object.hasOwn(flags, c.rel) && flags[c.rel].call) continue; // first write wins: its prior is the content to go back to
    flags[c.rel] = { session: typeof d.session_id === 'string' ? d.session_id : '', call: toolUseId(d), how, at, prior: c.prior ? pack(c.prior) : null };
  }
  writeJson(flaggedPath(lane.root), { v: SCHEMA, head: cache?.head ?? null, paths: flags });
}
