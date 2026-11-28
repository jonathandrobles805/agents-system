#!/usr/bin/env node
/**
 * Live dashboard server. Built-in Node modules only. Local use.
 *
 *   node ~/.claude/kit/dashboard/server.js --repo PATH [--repo PATH ...] [--port 8765] [--no-open]
 *   node ~/.claude/kit/dashboard/server.js --all          projects from ~/.claude/kit-projects.json
 *
 * Endpoints
 *   GET  /                      the dashboard page
 *   GET  /api/status            status for all served projects (kit_status.projectStatus), recomputed on change
 *   GET  /api/events/<slug>?project=NAME   the lane's events.jsonl as JSON (last 500)
 *   GET  /api/architecture      the kit's component map (scripts/arch_manifest.js), git state, and one overlay per served project
 *   GET  /api/history?id=ID     the last commits that touched a component of the map
 *   GET  /api/lane-files/<slug>?project=NAME             the lane's own files that exist: path, size, verdict
 *   GET  /api/lane-file/<slug>?project=NAME&path=REL     one of them, read-only; any other path is refused (403)
 *   GET  /api/stream            Server-Sent Events: {"type":"status"} on any change, {"type":"architecture"} when the kit's files change, {"type":"event","lane":slug} per new event line
 *   POST /api/open/<slug>?project=NAME     open a terminal running `claude` in the lane worktree (localhost only)
 *
 * Everything shown is read from files and git. The server never asks an agent anything.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ArgumentParser } from '../scripts/args.js';
import * as K from '../scripts/kitlib.js';
import * as KS from '../scripts/kit_status.js';
import * as CI from '../scripts/lane_ci.js';
import * as L from '../scripts/lane.js';
import { buildManifest } from '../scripts/arch_manifest.js';
import { fileHistory, gitInfo, projectOverlay } from '../scripts/arch_live.js';

const HERE = path.dirname(K.realResolve(fileURLToPath(import.meta.url)));
export const INDEX = path.join(HERE, 'index.html');
export const MODEL = path.join(HERE, 'model.js');
export const KIT_DIR = path.dirname(HERE);
const SERVER_VERSION = `agent-kit-dashboard/0.1 Node/${process.versions.node}`;

export const DOC = [
  'Live dashboard server. Standard library only. Local use.',
  '',
  '  node ~/.claude/kit/dashboard/server.js --repo PATH [--repo PATH ...] [--port 8765] [--no-open]',
  '  node ~/.claude/kit/dashboard/server.js --all          projects from ~/.claude/kit-projects.json',
  '',
  'Endpoints',
  '  GET  /                      the dashboard page',
  '  GET  /api/status            status for all served projects (kit_status.project_status), recomputed on change',
  '  GET  /api/events/<slug>?project=NAME   the lane\'s events.jsonl as JSON (last 500)',
  '  GET  /api/architecture      the kit\'s component map (scripts/arch_manifest.js), git state, and one overlay per served project',
  '  GET  /api/history?id=ID     the last commits that touched a component of the map',
  '  GET  /api/lane-files/<slug>?project=NAME             the lane\'s own files that exist: path, size, verdict',
  '  GET  /api/lane-file/<slug>?project=NAME&path=REL     one of them, read-only; any other path is refused (403)',
  '  GET  /api/stream            Server-Sent Events: {"type":"status"} on any change, {"type":"architecture"} when the kit\'s files change, {"type":"event","lane":slug} per new event line',
  '  POST /api/open/<slug>?project=NAME     open a terminal running `claude` in the lane worktree (localhost only)',
  '',
  'Everything shown is read from files and git. The server never asks an agent anything.',
].join('\n');

const USAGE = 'usage: server.js [-h] [--repo REPO] [--all] [--port PORT] [--no-open]';
const OPTIONS_HELP = 'options:\n  -h, --help   show this help message and exit\n  --repo REPO\n  --all\n  --port PORT\n  --no-open';

// ---------------------------------------------------------------------------------------------- state

export class State {
  /** @param {string[]} repos */
  constructor(repos) {
    this.repos = repos;
    this.status = [];
    this.listeners = []; // per-client queues: functions taking one serialized SSE message
    this.eventOffsets = new Map();
    this.fingerprint = '';
    this.arch = null; // { fp, manifest }: rebuilt only when a file the manifest reads has changed
    this.archFp = '';
  }

  recompute() {
    this.status = this.repos.map((r) => KS.projectStatus(r));
  }

  project(name) {
    if (this.status.length === 0) return null;
    if (name === null || name === undefined) return this.status[0];
    return this.status.find((s) => s.root === name) ?? this.status.find((s) => s.project === name) ?? null; // two projects can share a name; the root is unique
  }

  broadcast(msg) {
    const data = K.jsonDumps(msg);
    for (const send of [...this.listeners]) send(data);
  }
}

// ---------------------------------------------------------------------------------------------- watching

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Sorted full paths of the entries of `dir` accepted by `keep(name)` (Python: sorted(dir.glob(pattern))). */
function listDir(dir, keep) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter(keep).sort(byName).map((n) => path.join(dir, n));
}

export function watchedFiles(repos) {
  const files = [];
  for (const r of repos) {
    for (const rel of ['ROADMAP.md', 'LESSONS.md', 'CLAUDE.md', path.join('.claude', 'kit.json')]) files.push(path.join(r, rel));
    const specs = path.join(r, 'docs', 'specs');
    if (K.isDir(specs)) files.push(...listDir(specs, () => true));
    const research = path.join(r, 'docs', 'research');
    if (K.isDir(research)) files.push(...listDir(research, (n) => n.endsWith('.md')));
    // the lane store: lane.js advance writes each lane's stage there, and kit_status reads it
    files.push(...listDir(L.storeDir(r), (n) => n.endsWith('.json')));
    const kit = K.loadKitJson(r);
    const lanes = kit.lanes ?? {};
    for (const [slug, info] of Object.entries(lanes)) {
      const wt = info.worktree ?? ''; // Python: Path("") is "." (the current directory)
      const wtDir = wt === '' ? '.' : wt;
      if (K.isDir(wtDir)) {
        files.push(...listDir(path.join(wtDir, 'docs', 'specs'), (n) => n.startsWith(slug)));
        files.push(path.join(wtDir, '.claude', 'lane.json'));
        files.push(path.join(wtDir, '.git')); // worktree HEAD pointer file
      }
    }
  }
  return files;
}

export function fingerprint(files) {
  const parts = [];
  for (const f of files) {
    try {
      const st = fs.statSync(f, { bigint: true });
      parts.push(`${f}:${st.mtimeNs}:${st.size}`);
    } catch {
      parts.push(`${f}:missing`);
    }
  }
  return parts.join('|');
}

/**
 * New events of an events.jsonl since byte `offset`: [events, newOffset, rewritten]. Only complete lines are consumed:
 * the offset stops after the last newline, so a line a writer has half written is read whole on a later tick.
 * Unparseable complete lines are skipped. A file smaller than `offset` was rewritten (or replaced) under us: nothing is
 * read from it, the offset restarts after its last complete line and `rewritten` is true, so the caller can say so.
 */
export function tailEvents(p, offset) {
  if (!K.isFile(p)) return [[], 0, false];
  const fd = fs.openSync(p, 'r');
  let chunk;
  let rewritten = false;
  try {
    const size = fs.fstatSync(fd).size;
    if (size < offset) {
      rewritten = true;
      offset = 0; // the whole file is the "new" part; only its end is kept, below
    }
    const len = Math.max(0, size - offset);
    chunk = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const n = fs.readSync(fd, chunk, got, len - got, offset + got);
      if (n === 0) break;
      got += n;
    }
    if (got < len) chunk = chunk.subarray(0, got);
  } finally {
    fs.closeSync(fd);
  }
  const end = chunk.lastIndexOf(0x0a) + 1; // 0 when no newline yet: nothing complete to read
  if (rewritten) return [[], offset + end, true];
  const out = [];
  for (const line of K.splitlines(chunk.subarray(0, end).toString('utf8'))) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // not JSON: skip
    }
  }
  return [out, offset + end, false];
}

/**
 * The event files of one lane, each tagged with where it comes from: the committed events file, at the path the kit
 * itself uses (Lane.eventsPath: the work root the lane was started under), and the worktree's session events file,
 * where lane.js writes start/launch/resume/risk/reroute.
 */
export function laneEventFiles(l) {
  const found = K.findLane(l.worktree);
  const lane = found && found.root === l.worktree ? found : new K.Lane(l.worktree, { feature: l.slug });
  return [
    { path: lane.eventsPath, source: 'committed' },
    { path: path.join(l.worktree, K.SESSION_DIR, 'events.jsonl'), source: 'session' },
  ];
}

/** One watcher pass: recompute + broadcast on a changed fingerprint, then stream new event lines. */
function watchTick(state) {
  const fp = fingerprint(watchedFiles(state.repos));
  if (fp !== state.fingerprint) {
    state.fingerprint = fp;
    state.recompute();
    state.broadcast({ type: 'status', data: state.status });
  }
  const archFp = fingerprint(archWatchList(KIT_DIR, state.arch?.manifest));
  if (archFp !== state.archFp) {
    if (state.archFp !== '') state.broadcast({ type: 'architecture' });
    state.archFp = archFp;
  }
  for (const s of state.status) {
    for (const l of s.lanes) {
      if (!l.worktree) continue;
      for (const f of laneEventFiles(l)) {
        // offsets are per file, not per slug: two projects can have a lane of the same name
        const [fresh, off, rewritten] = tailEvents(f.path, state.eventOffsets.get(f.path) ?? 0);
        state.eventOffsets.set(f.path, off);
        const send = (data) => state.broadcast({ type: 'event', lane: l.slug, project: s.project, root: s.root, data });
        if (rewritten) {
          send({ ts: new Date().toISOString(), event: 'events_file_rewritten', source: f.source, file: path.relative(l.worktree, f.path), summary: `${path.basename(f.path)} was rewritten; events written before the rewrite may be missing here` });
        }
        for (const e of fresh) send(e !== null && typeof e === 'object' && !Array.isArray(e) ? { ...e, source: f.source } : { value: e, source: f.source });
      }
    }
  }
}

/** Start the watcher; returns a function that stops it. */
export function startWatcher(state, interval) {
  // seed offsets so we stream only new events
  for (const s of state.status) {
    for (const l of s.lanes) {
      if (l.worktree) {
        for (const f of laneEventFiles(l)) state.eventOffsets.set(f.path, K.isFile(f.path) ? tailEvents(f.path, 0)[1] : 0);
      }
    }
  }
  let timer = null;
  let stopped = false;
  const tick = () => {
    try {
      watchTick(state);
    } catch (exc) {
      process.stderr.write(`watcher: ${exc?.message ?? exc}\n`);
    }
    if (!stopped) schedule();
  };
  const schedule = () => {
    timer = setTimeout(tick, interval * 1000);
    timer.unref();
  };
  schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

// ---------------------------------------------------------------------------------------------- architecture

/** Files and directories whose change can change the manifest. */
export function archWatchList(kitDir, manifest) {
  const base = path.dirname(kitDir);
  const files = ['agents', 'skills', 'scripts', path.join('scripts', 'tests'), 'templates', 'ci', 'hooks', 'dashboard', 'manifest.json'].map((p) => path.join(kitDir, p));
  files.push(path.join(base, 'package.json'), path.join(base, 'VERSION'), path.join(base, '.github', 'workflows', 'kit.yml'));
  for (const n of manifest ? manifest.nodes : []) files.push(path.join(base, n.path));
  return files;
}

/** The manifest of the kit this server belongs to, rebuilt when a file it reads changed. */
export function currentManifest(state, kitDir = KIT_DIR) {
  const fp = fingerprint(archWatchList(kitDir, state.arch?.manifest));
  if (!state.arch || state.arch.fp !== fp) {
    const manifest = buildManifest(kitDir);
    state.arch = { fp: fingerprint(archWatchList(kitDir, manifest)), manifest };
  }
  return state.arch.manifest;
}

/** The lanes of one project with the stage `lane.js next-step` answers for each: derived from files and git. */
async function laneStages(proj) {
  const out = [];
  for (const l of proj.lanes ?? []) {
    let step = null;
    try {
      step = await L.nextStep(proj.root, l.slug, { reroute: false }); // a GET never writes: no reroute, no event
    } catch {
      // a lane whose files are unreadable shows without a stage
    }
    out.push({ slug: l.slug, position: l.position, stage: step?.stage ?? null, reroute_pending: step?.reroute_pending ?? null, needs_human: Boolean(step?.needs_human), last_check: l.last_check ?? null, blocked: l.events?.blocked ?? 0 });
  }
  return out;
}

/** The whole answer of GET /api/architecture. One overlay per project; projects are never merged. */
export async function architecture(state, kitDir = KIT_DIR) {
  const manifest = currentManifest(state, kitDir);
  if (state.status.length === 0) state.recompute();
  const projects = [];
  for (const s of state.status) projects.push({ project: s.project, root: s.root, ...projectOverlay(manifest, kitDir, s.root), lanes: await laneStages(s) });
  return { manifest, git: gitInfo(path.dirname(kitDir)), projects };
}

// ---------------------------------------------------------------------------------------------- open a terminal

/** shutil.which(cmd) */
export function which(cmd) {
  const accessible = (fn) => {
    try {
      if (K.isDir(fn)) return false;
      fs.accessSync(fn, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (cmd.includes('/') || (process.platform === 'win32' && cmd.includes('\\'))) return accessible(cmd) ? cmd : null;
  const envPath = process.env.PATH ?? '/bin:/usr/bin';
  if (envPath === '') return null;
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(path.delimiter).filter(Boolean) : [];
  const names = process.platform === 'win32' && !exts.some((e) => cmd.toLowerCase().endsWith(e.toLowerCase())) ? exts.map((e) => cmd + e) : [cmd];
  for (const dir of envPath.split(path.delimiter)) {
    for (const name of names) {
      const full = path.join(dir, name);
      if (accessible(full)) return full;
    }
  }
  return null;
}

/** subprocess.Popen: resolves once the process started, rejects when it could not be spawned. */
function popen(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.removeListener('error', reject);
      child.on('error', () => {});
      child.unref();
      resolve();
    });
  });
}

const platformName = () => {
  const t = os.type();
  return t === 'Windows_NT' ? 'Windows' : t;
};

/** Open a terminal window running `claude` in the worktree. Best effort per platform. -> [ok, message] */
export async function openTerminal(worktree, _slug) {
  if (!K.isDir(worktree)) return [false, `worktree ${worktree} does not exist`];
  const claude = which('claude');
  if (!claude) return [false, 'claude CLI not found on PATH'];
  const cmd = `cd "${worktree}" && claude`;
  const sysname = platformName();
  try {
    if (sysname === 'Darwin') {
      const script = `tell application "Terminal" to do script "${cmd.replaceAll('"', '\\"')}"`;
      await popen('osascript', ['-e', script]);
    } else if (sysname === 'Linux') {
      const term = ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm'].find((t) => which(t));
      if (!term) return [false, 'no terminal emulator found'];
      const args = ['gnome-terminal', 'x-terminal-emulator'].includes(term) ? [term, '--', 'bash', '-lc', `${cmd}; exec bash`] : [term, '-e', `bash -lc '${cmd}; exec bash'`];
      await popen(args[0], args.slice(1));
    } else if (sysname === 'Windows') {
      await popen('cmd', ['/c', 'start', 'cmd', '/k', `cd /d "${worktree}" && claude`]);
    } else {
      return [false, `unsupported platform ${sysname}`];
    }
  } catch (exc) {
    return [false, String(exc?.message ?? exc)];
  }
  return [true, `opened claude in ${worktree}`];
}

/** webbrowser.open(url), best effort and silent. */
function openBrowserTab(url) {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  popen(cmd, args).catch(() => {});
}

// ---------------------------------------------------------------------------------------------- request parsing (urllib.parse semantics)

const USES_PARAMS = new Set(['', 'ftp', 'hdl', 'prospero', 'http', 'imap', 'https', 'shttp', 'rtsp', 'rtspu', 'sip', 'sips', 'mms', 'sftp', 'tel']);

/** urllib.parse.urlparse(target) -> {path, query} for a request target (`;params` of the last segment are not part of the path). */
export function splitTarget(raw) {
  let url = raw.replace(/^[\x00-\x20]+/, '').replace(/[\t\r\n]/g, '');
  let scheme = '';
  const i = url.indexOf(':');
  if (i > 0 && /^[A-Za-z]/.test(url) && /^[A-Za-z0-9+\-.]*$/.test(url.slice(0, i))) {
    scheme = url.slice(0, i).toLowerCase();
    url = url.slice(i + 1);
  }
  if (url.startsWith('//')) {
    let end = url.length;
    for (const c of '/?#') {
      const at = url.indexOf(c, 2);
      if (at >= 0) end = Math.min(end, at);
    }
    url = url.slice(end);
  }
  const hash = url.indexOf('#');
  if (hash >= 0) url = url.slice(0, hash);
  let query = '';
  const q = url.indexOf('?');
  if (q >= 0) {
    query = url.slice(q + 1);
    url = url.slice(0, q);
  }
  if (USES_PARAMS.has(scheme) && url.includes(';')) {
    const semi = url.includes('/') ? url.indexOf(';', url.lastIndexOf('/')) : url.indexOf(';');
    if (semi >= 0) url = url.slice(0, semi);
  }
  return { path: url, query };
}

/** urllib.parse.unquote (utf-8, errors="replace"): invalid %xx sequences stay as they are. */
function unquote(s) {
  if (!s.includes('%')) return s;
  return s.replace(/(?:%[0-9a-fA-F]{2})+/g, (m) => Buffer.from(m.replace(/%/g, ''), 'hex').toString('utf8'));
}

/** urllib.parse.parse_qs(query): Map name -> list of values; blank values are dropped. */
export function parseQs(query) {
  const out = new Map();
  if (!query) return out;
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const value = pair.slice(eq + 1);
    if (value === '') continue;
    const name = unquote(pair.slice(0, eq).replaceAll('+', ' '));
    const val = unquote(value.replaceAll('+', ' '));
    if (!out.has(name)) out.set(name, []);
    out.get(name).push(val);
  }
  return out;
}

const firstParam = (q, name) => (q.get(name) ?? [null])[0];
const lastSegment = (p) => p.slice(p.lastIndexOf('/') + 1); // path.rsplit("/", 1)[1]

// ---------------------------------------------------------------------------------------------- HTTP

function sendJson(res, code, obj) {
  const body = Buffer.from(K.jsonDumps(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': body.length });
  res.end(body);
}

const ERROR_PAGE = (code, message, explain) =>
  `<!DOCTYPE HTML>\n<html lang="en">\n    <head>\n        <meta charset="utf-8">\n        <title>Error response</title>\n    </head>\n    <body>\n` +
  `        <h1>Error response</h1>\n        <p>Error code: ${code}</p>\n        <p>Message: ${message}.</p>\n        <p>Error code explanation: ${code} - ${explain}.</p>\n    </body>\n</html>\n`;

/** BaseHTTPRequestHandler's answer to a method without a do_ handler. */
function sendUnsupported(res, method) {
  const message = `Unsupported method ('${method}')`;
  const body = Buffer.from(ERROR_PAGE(501, message, 'Server does not support this operation'), 'utf8');
  res.writeHead(501, message, { Connection: 'close', 'Content-Type': 'text/html;charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

function isLocal(req) {
  return ['127.0.0.1', '::1'].includes(req.socket.remoteAddress);
}

/**
 * The lane's own files the board's drawer may read (hardening plan Step 10), relative to `base` (the lane's worktree,
 * else the project root), from the kit's path functions: the goal, the spec, the research files its spec names, and
 * kitlib laneArtifacts (progress, review, events, checks; the decisions folder is not a lane's own). Nothing else.
 */
export function laneFileAllowlist(root, slug, base) {
  const work = K.findLane(base)?.work ?? K.workRoot(root);
  const spec = `${work}/${slug}.md`;
  const research = String(L.specHeader(path.join(base, spec)).get('research') ?? '').split(',').map((s) => s.trim())
    .filter((s) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s) && s.toLowerCase() !== 'none').map((s) => `docs/research/${s}.md`);
  return [...new Set([`docs/goals/${slug}.md`, spec, ...research, ...K.laneArtifacts(work, slug, root).filter((p) => !p.includes('*'))])];
}

const OUTSIDE = Symbol('outside');

/**
 * The text of base/rel, read-only; null when there is no such file; OUTSIDE when its real path is not exactly
 * base/rel (a symlink anywhere on the way, to outside the worktree or to another file in it).
 */
function readLaneFile(base, rel) {
  const want = path.join(base, rel);
  let real;
  try {
    real = fs.realpathSync(want);
  } catch {
    return null;
  }
  if (real !== path.join(fs.realpathSync(base), rel)) return OUTSIDE;
  try {
    return fs.statSync(real).isFile() ? fs.readFileSync(real, 'utf8') : null;
  } catch {
    return null;
  }
}

async function doGet(state, req, res, u, q) {
  if (u.path === '/model.js') {
    const body = fs.readFileSync(MODEL);
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Content-Length': body.length });
    res.end(body);
    return;
  }
  if (u.path === '/' || u.path === '/index.html') {
    const body = fs.readFileSync(INDEX);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length });
    res.end(body);
    return;
  }
  if (u.path === '/api/status') {
    if (state.status.length === 0) state.recompute();
    sendJson(res, 200, state.status.length > 1 ? state.status : state.status.length ? state.status[0] : {});
    return;
  }
  if (u.path.startsWith('/api/events/')) {
    const slug = lastSegment(u.path);
    const proj = state.project(firstParam(q, 'project'));
    if (!proj) return sendJson(res, 404, { error: 'project not found' });
    const lane = proj.lanes.find((l) => l.slug === slug);
    const root = lane && lane.worktree ? lane.worktree : proj.root;
    const [events] = tailEvents(path.join(root, 'docs', 'specs', `${slug}.events.jsonl`), 0);
    return sendJson(res, 200, events.slice(-500));
  }
  if (u.path.startsWith('/api/lane-files/') || u.path.startsWith('/api/lane-file/')) {
    // a page on another site must not read a lane's files through the user's browser (step 0: the same rule as POST)
    if (!originAllowed(req)) return sendJson(res, 403, { error: 'cross-site request refused: Origin is not this server' });
    const slug = lastSegment(u.path);
    const proj = state.project(firstParam(q, 'project'));
    const lane = (proj?.lanes ?? []).find((l) => l.slug === slug);
    if (!lane) return sendJson(res, 404, { error: 'lane not found' });
    const base = lane.worktree || proj.root;
    const allowed = laneFileAllowlist(proj.root, slug, base);
    if (u.path.startsWith('/api/lane-files/')) {
      const files = [];
      for (const rel of allowed) {
        const text = readLaneFile(base, rel);
        if (typeof text === 'string') files.push({ path: rel, size: Buffer.byteLength(text, 'utf8'), verdict: KS.reviewVerdict(text) });
      }
      return sendJson(res, 200, files);
    }
    const rel = firstParam(q, 'path') ?? '';
    if (!allowed.includes(rel)) return sendJson(res, 403, { error: 'not one of the lane\'s files' });
    const text = readLaneFile(base, rel);
    if (text === OUTSIDE) return sendJson(res, 403, { error: 'not one of the lane\'s files' });
    if (text === null) return sendJson(res, 404, { error: 'no such file' });
    return sendJson(res, 200, { path: rel, size: Buffer.byteLength(text, 'utf8'), text });
  }
  if (u.path === '/api/architecture') {
    return sendJson(res, 200, await architecture(state));
  }
  if (u.path === '/api/history') {
    const id = firstParam(q, 'id');
    const node = id ? currentManifest(state).nodes.find((n) => n.id === id) : null;
    if (!node) return sendJson(res, 404, { error: 'unknown component' });
    return sendJson(res, 200, { id: node.id, path: node.path, commits: fileHistory(path.dirname(KIT_DIR), node.path) });
  }
  if (u.path === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.flushHeaders();
    req.socket.setNoDelay(true);
    const send = (data) => {
      try {
        res.write(`data: ${data}\n\n`);
      } catch {
        // client already gone; its 'close' handler removes the listener
      }
    };
    state.listeners.push(send);
    res.write(': connected\n\n');
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    res.on('close', () => {
      clearInterval(ping);
      const at = state.listeners.indexOf(send);
      if (at >= 0) state.listeners.splice(at, 1);
    });
    return;
  }
  sendJson(res, 404, { error: 'not found' });
}

async function doPost(state, req, res, u, q) {
  // the socket is local for any page the user's own browser loads, so "localhost only" cannot tell a cross-site POST from the dashboard's own
  if (!originAllowed(req)) return sendJson(res, 403, { ok: false, error: 'cross-site request refused: Origin is not this server' });
  if (u.path.startsWith('/api/open/')) {
    if (!isLocal(req)) return sendJson(res, 403, { ok: false, error: 'localhost only' });
    const slug = lastSegment(u.path);
    const proj = state.project(firstParam(q, 'project'));
    const lane = (proj?.lanes ?? []).find((l) => l.slug === slug);
    if (!lane || !lane.worktree) return sendJson(res, 404, { ok: false, error: 'lane has no worktree' });
    const [ok, msg] = await openTerminal(lane.worktree, slug);
    return sendJson(res, ok ? 200 : 500, { ok, error: ok ? null : msg, message: msg });
  }
  sendJson(res, 404, { ok: false, error: 'not found' });
}

/** True when the Host header names this server: 127.0.0.1:<port> or localhost:<port>, the port it listens on. */
export function hostAllowed(req) {
  const host = (req.headers.host ?? '').toLowerCase();
  const port = req.socket.localPort;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/** True when the request carries no Origin, or an Origin that is this server's own (http://127.0.0.1:<port> or http://localhost:<port>). */
export function originAllowed(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  const port = req.socket.localPort;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

export function makeHandler(state) {
  return async (req, res) => {
    try {
      res.setHeader('Server', SERVER_VERSION);
      req.resume(); // request bodies are never read
      if (!hostAllowed(req)) return sendJson(res, 421, { error: 'misdirected request: Host must be 127.0.0.1 or localhost with this server\'s port' }); // DNS rebinding guard
      let target = req.url ?? '/';
      if (target.startsWith('//')) target = `/${target.replace(/^\/+/, '')}`; // http.server reduces a leading '//' to '/'
      const u = splitTarget(target);
      const q = parseQs(u.query);
      if (req.method === 'GET') await doGet(state, req, res, u, q);
      else if (req.method === 'POST') await doPost(state, req, res, u, q);
      else sendUnsupported(res, req.method);
    } catch (exc) {
      // like socketserver.handle_error: report on stderr and drop the connection
      process.stderr.write(`Exception occurred during processing of request from ${req.socket.remoteAddress}\n${exc?.stack ?? exc}\n`);
      res.socket?.destroy();
    }
  };
}

/**
 * Start the dashboard on 127.0.0.1:port and return the http.Server (listening starts at once; wait for its 'listening' event).
 * `server.state` holds the State; `server.close()` also stops the watcher and ends open event streams.
 */
export function serve(repos, port, openBrowser = false, interval = 1.0) {
  const state = new State(repos);
  // CI on each lane's PR is read in the background (lane_ci.js); a changed answer is pushed like any status change
  CI.enableRefresh(() => {
    state.recompute();
    state.broadcast({ type: 'status', data: state.status });
  });
  state.recompute();
  state.fingerprint = fingerprint(watchedFiles(repos));
  const stopWatcher = startWatcher(state, interval);
  const httpd = http.createServer(makeHandler(state));
  httpd.state = state;
  httpd.on('close', stopWatcher);
  const origClose = httpd.close.bind(httpd);
  httpd.close = (cb) => {
    const r = origClose(cb);
    httpd.closeAllConnections();
    return r;
  };
  httpd.listen(port, '127.0.0.1');
  if (openBrowser) setTimeout(() => openBrowserTab(`http://127.0.0.1:${port}/`), 500).unref();
  return httpd;
}

// ---------------------------------------------------------------------------------------------- CLI

const expandUser = (p) => (p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p);

export function main(argv) {
  const ap = new ArgumentParser({ prog: 'server.js', description: `${DOC}\n\n${OPTIONS_HELP}` });
  ap.usage = () => USAGE;
  ap.addArgument('--repo', { action: 'append', default: [] });
  ap.addArgument('--all', { action: 'store_true' });
  ap.addArgument('--port', { type: Number, default: 8765 });
  ap.addArgument('--no-open', { action: 'store_true' });
  const a = ap.parseArgs(argv);
  let repos = a.repo.map((r) => K.realResolve(expandUser(r)));
  if (a.all || repos.length === 0) {
    const reg = path.join(process.env.CLAUDE_HOME ?? path.join(os.homedir(), '.claude'), 'kit-projects.json');
    if (K.isFile(reg)) {
      const listed = JSON.parse(fs.readFileSync(reg, 'utf8'));
      repos = repos.concat((Array.isArray(listed) ? listed : Object.keys(listed)).map((p) => K.realResolve(expandUser(p))));
    }
  }
  repos = repos.filter((r) => K.isDir(r));
  if (repos.length === 0) {
    process.stderr.write('no projects: pass --repo PATH or register projects in ~/.claude/kit-projects.json (bootstrap does this)\n');
    return 1;
  }
  const httpd = serve(repos, a.port, !a.no_open);
  httpd.on('listening', () => process.stdout.write(`agent-kit dashboard: http://127.0.0.1:${a.port}/  (${repos.length} project(s))\n`));
  httpd.on('error', (err) => {
    process.stderr.write(`agent-kit dashboard: cannot listen on 127.0.0.1:${a.port} (${err.code ?? err.message})\n`);
    process.exitCode = 1;
  });
  process.on('SIGINT', () => httpd.close()); // Ctrl-C ends the server; exit code stays 0, like Python's KeyboardInterrupt handling
  return 0;
}

if (K.isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
