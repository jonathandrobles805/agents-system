#!/usr/bin/env node
// The lane sandbox (KIT-SPEC 10.9, decision 0008): detect a runtime, build the lane's sandbox configuration from the
// floor and the spec, scan the worktree for credential-looking content, and produce the host-side launch command.
//
// Runtimes, in order of preference:
//   srt        Anthropic's sandbox runtime (@anthropic-ai/sandbox-runtime): Seatbelt on macOS, bubblewrap on Linux.
//   container  docker or podman; required when the spec is high-risk.
//   none       neither present: the lane runs `degraded` (hooks + floor only), the state is recorded, high-risk is refused.
// KIT_SANDBOX_RUNTIME=srt|container|none overrides detection (tests, CI, a developer who knows better).
//
//   node sandbox.js detect                  JSON: which runtime would be used and why
//   node sandbox.js scan --repo R           credential-looking content under R (exit 2 when found)
//   node sandbox.js config <slug> --repo R  JSON: the sandbox configuration a lane for <slug> would get
//   node sandbox.js probe --repo R          run `true` through the detected runtime with a lane's settings; JSON; exit 1 when it cannot
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ArgumentParser } from './args.js';
import * as K from './kitlib.js';

export const RUNTIMES = ['srt', 'container'];
const MAX_SCAN_BYTES = 1 << 20;
/** A line carrying this marker is a reviewed fixture (a fake key in a test); the scan skips it. Reviewers check the marker is honest. */
export const ALLOW_MARKER = 'kit:allow-secret';
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', 'target', '.next', 'coverage']);

function which(cmd) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 ? r.stdout.trim().split(/\r?\n/)[0] : null;
}

function containerEngine() {
  for (const eng of ['docker', 'podman']) {
    if (!which(eng)) continue;
    const r = spawnSync(eng, ['info'], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.status === 0) return eng;
  }
  return null;
}

/** { runtime: 'srt' | 'container' | null, how: string, engine?: string } */
export function detectRuntime(env = process.env) {
  const forced = (env.KIT_SANDBOX_RUNTIME ?? '').trim().toLowerCase();
  if (forced === 'none') return { runtime: null, how: 'KIT_SANDBOX_RUNTIME=none' };
  if (forced === 'srt' || forced === 'container') return { runtime: forced, how: `KIT_SANDBOX_RUNTIME=${forced}`, ...(forced === 'container' ? { engine: env.KIT_CONTAINER_ENGINE || 'docker' } : {}) };
  if (forced) return { runtime: null, how: `KIT_SANDBOX_RUNTIME=${forced} is not srt, container or none; treated as none` };
  const srt = which('srt');
  if (srt) return { runtime: 'srt', how: `srt on PATH (${srt})` };
  const local = path.join(K.KIT_DIR, 'node_modules', '@anthropic-ai', 'sandbox-runtime');
  if (K.isFile(path.join(local, 'package.json'))) return { runtime: 'srt', how: `@anthropic-ai/sandbox-runtime installed in the kit (${local})` };
  const eng = containerEngine();
  if (eng) return { runtime: 'container', how: `${eng} info succeeded`, engine: eng };
  return { runtime: null, how: 'no srt on PATH or in the kit, no working docker/podman' };
}

// The spec's declared domains decide two things that must agree: the sandbox allowlist built here, and whether the
// bash guard lets the lane fetch by hand (KIT-SPEC 10.1). The parser therefore lives in kitlib, where both reach it
// without a hook having to import the sandbox.
export const specNetwork = K.specNetwork;

/** Home-relative floor patterns become absolute deny paths; project-relative ones stay relative to the worktree. */
function denyReadPaths(wt, floor, kit) {
  const home = os.homedir();
  const out = new Set([
    path.join(home, '.ssh'), path.join(home, '.aws'), path.join(home, '.config', 'gh'), path.join(home, '.gnupg'),
    path.join(home, '.kube'), path.join(home, '.docker', 'config.json'), path.join(home, '.azure'), path.join(home, '.config', 'gcloud'),
    path.join(home, '.netrc'), path.join(home, '.npmrc'), path.join(home, '.pypirc'),
    path.join(home, '.claude', 'kit-notify.json'),
  ]);
  for (const p of [...floor.secret_read_patterns, ...(Array.isArray(kit.secret_patterns) ? kit.secret_patterns : [])]) {
    if (typeof p !== 'string' || !p) continue;
    out.add(p.startsWith('**/') ? path.join(wt, p) : p.includes('/') ? path.join(wt, p) : path.join(wt, '**', p));
    if (!p.includes('/')) out.add(path.join(wt, p));
  }
  for (const cf of Array.isArray(kit.credential_files) ? kit.credential_files : []) if (typeof cf === 'string') out.add(path.join(wt, cf));
  return [...out].sort();
}

/**
 * What `git commit` in a lane's linked worktree writes outside the worktree, and what in the shared git directory stays
 * protected. A linked worktree keeps its index and HEAD under `<common>/worktrees/<name>/` and its objects, branch ref
 * and reflog in the main repository's `.git`, so with only the worktree writable no lane could commit (eval run
 * 45299355535: "Unable to create '<repo>/.git/worktrees/<name>/index.lock': Read-only file system"). Found by running
 * `git commit` under srt 0.0.83 (bubblewrap): it needs the worktree's git dir, `objects/`, the directory holding the
 * branch's ref (git creates `<ref>.lock` beside it and renames it over the ref) and the branch's reflog file;
 * `config`, `packed-refs`, `hooks/` and every other ref are not written. The ref directory (`refs/heads/wt/`) holds the
 * other lanes' branches too, so each ref already in it is write-denied by name. srt skips an allowWrite path that does
 * not exist, so only existing paths are listed. Nothing is added when the git dir is inside the worktree (an ordinary
 * clone, already writable) or `wt` is not in a git repository.
 * @returns {{ common: string, allowWrite: string[], denyWrite: string[] } | null}
 */
export function gitWritePaths(wt, branch) {
  const r = spawnSync('git', ['rev-parse', '--git-dir', '--git-common-dir'], { cwd: wt, encoding: 'utf8', timeout: 10000 });
  if (r.status !== 0) return null;
  const [gitDir, common] = r.stdout.trim().split('\n').map((p) => path.resolve(wt, p));
  if (!gitDir || !common || !path.relative(wt, gitDir).startsWith('..')) return null;
  const ref = path.join(common, 'refs', 'heads', ...branch.split('/'));
  const refDir = path.dirname(ref);
  const exists = (p) => fs.existsSync(p);
  const allowWrite = [gitDir, path.join(common, 'objects'), refDir, path.join(common, 'logs', 'refs', 'heads', ...branch.split('/'))].filter(exists);
  let others = [];
  try {
    others = fs.readdirSync(refDir).filter((n) => !n.endsWith('.lock')).map((n) => path.join(refDir, n)).filter((p) => p !== ref);
  } catch {
    others = [];
  }
  const denyWrite = [path.join(common, 'hooks'), path.join(common, 'config'), path.join(common, 'packed-refs'), path.join(common, 'refs', 'tags'), ...others].filter(exists);
  return { common, allowWrite, denyWrite };
}

/** The lane's branch: lane.json's `branch`, else `wt/<slug>`, the branch `lane.js start` creates. */
function laneBranch(wt, slug) {
  try {
    const b = JSON.parse(fs.readFileSync(path.join(wt, '.claude', 'lane.json'), 'utf8')).branch;
    if (typeof b === 'string' && b) return b;
  } catch {
    // no lane.json yet: `lane.js start` builds the configuration before it writes one
  }
  return `wt/${slug}`;
}

/** The sandbox configuration for one lane. Reads the floor, kit.json and the worktree's git layout; writes nothing. */
export function sandboxConfig({ root, wt, slug, agent = 'implementer', env = process.env }) {
  const floor = K.loadFloor();
  const kit = K.loadKitJson(root);
  const det = detectRuntime(env);
  const preferred = typeof kit.sandbox?.runtime === 'string' ? kit.sandbox.runtime : null;
  const runtime = preferred === 'container' && det.runtime ? 'container' : det.runtime;
  const net = floor.network ?? {};
  // `agent` is recorded, not enforced: the sandbox boundary is the lane process, and the kit's agents are subagents
  // inside one lane session sharing that process, so a role cannot have a network of its own. The floor used to
  // carry a per_agent list for exactly that and no lane ever reached it (lane.js never passes an agent), which
  // meant a researcher's "open egress" was configuration nobody applied. The allowlist a lane gets is the
  // registries plus what its own spec declares, as KIT-SPEC 10.9 says.
  // the kit's telemetry collector on localhost is always reachable (KIT-SPEC 9.4); nothing else on localhost is implied
  const collector = `127.0.0.1:${Number(env.KIT_TELEMETRY_PORT || 4318)}`;
  const domains = [...new Set([...(Array.isArray(net.default_allow) ? net.default_allow : []), ...K.specNetwork(path.join(wt, K.workRoot(root), `${slug}.md`)), collector])].sort();
  const scratch = path.join(os.tmpdir(), `kit-lane-${slug}`);
  const git = gitWritePaths(wt, laneBranch(wt, slug));
  return {
    runtime,
    state: runtime ? 'contained' : 'degraded',
    how: det.how,
    engine: det.engine ?? null,
    agent,
    // the worktree, the scratch, then what a commit in a linked worktree writes in the main repository's .git
    allowWrite: [wt, scratch, ...(git?.allowWrite ?? [])],
    denyWrite: git?.denyWrite ?? [],
    gitCommon: git?.common ?? null,
    denyRead: denyReadPaths(wt, floor, kit),
    allowedDomains: domains,
    failIfUnavailable: true,
  };
}

/**
 * srt settings file content for a configuration. The shape is what `srt --settings` accepts as of sandbox-runtime
 * installed 2026-11-10 on macOS: `network` and `filesystem` at the top level, every key present (srt refuses a file
 * with a missing key rather than filling defaults, so that a typo cannot silently drop a rule). Verified end to end:
 * an allowed host connected, an undeclared host got "403 host is not on the allow list".
 */
export const SRT_REQUIRED_KEYS = { network: ['allowedDomains', 'deniedDomains'], filesystem: ['denyRead', 'allowRead', 'allowWrite', 'denyWrite'] };
export function srtSettings(cfg) {
  return {
    network: { allowedDomains: cfg.allowedDomains, deniedDomains: [] },
    filesystem: { denyRead: cfg.denyRead, allowRead: [], allowWrite: cfg.allowWrite, denyWrite: cfg.denyWrite ?? [] },
  };
}

/** Environment that turns on Claude Code's OpenTelemetry export for a lane and tags every record with the lane (KIT-SPEC 9.4). */
export function telemetryEnv({ project, slug, stage = 'build', port = Number(process.env.KIT_TELEMETRY_PORT || 4318) }) {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
    OTEL_METRIC_EXPORT_INTERVAL: '10000',
    OTEL_LOGS_EXPORT_INTERVAL: '2000',
    OTEL_RESOURCE_ATTRIBUTES: `kit.project=${project},kit.lane=${slug},kit.stage=${stage}`,
  };
}

/**
 * The command the host side runs to start a headless lane session inside the sandbox. Argument list, not a shell string.
 * `agent` runs the whole session as that agent (`claude --agent`): the eval names the kit agent a task measures; a
 * lane names none, so its session is the orchestrator that spawns the agents.
 * `prompt: null` leaves the prompt out of the argument list: the caller writes it to the process's stdin. `claude -p`
 * reads its prompt from stdin when none is given as an argument (the CLI reference's "Process piped content" row,
 * https://code.claude.com/docs/en/cli-reference; Claude Code 2.1.330 with neither says "Input must be provided either
 * through stdin or as a prompt argument when using --print"). The eval's judge prompt holds the end state and can pass
 * Linux's 128 KiB limit on one argument (E2BIG); stdin has no such limit. srt hands its stdin to the command; a
 * container needs `-i` for it.
 */
export function launchCommand(cfg, { wt, settingsPath, prompt, agent = null }) {
  const claude = ['claude', '-p', ...(prompt === null ? [] : [prompt]), '--permission-mode', 'default', ...(agent ? ['--agent', agent] : [])];
  if (cfg.runtime === 'srt') return ['srt', '--settings', settingsPath, '--', ...claude];
  if (cfg.runtime === 'container') {
    const eng = cfg.engine || 'docker';
    const args = [eng, 'run', '--rm', ...(prompt === null ? ['-i'] : []), '--network', 'kit-lane', '-v', `${wt}:${wt}`, '-w', wt, '-v', `${cfg.allowWrite[1]}:${cfg.allowWrite[1]}`];
    // a linked worktree's git data lives in the main repository's .git: mounted read-only, with what a commit writes
    // (sandboxConfig's allowWrite after the scratch) mounted writable over it. Not run here: no container engine.
    if (cfg.gitCommon) {
      args.push('-v', `${cfg.gitCommon}:${cfg.gitCommon}:ro`);
      for (const p of cfg.allowWrite.slice(2)) args.push('-v', `${p}:${p}`);
    }
    for (const d of cfg.allowedDomains) args.push('-e', `KIT_ALLOWED_DOMAIN=${d}`);
    return [...args, 'kit-lane:latest', ...claude];
  }
  return claude; // degraded: no boundary; recorded as such
}

/** Files under root whose content matches a floor credential pattern. Files the sandbox denies anyway are skipped; so are lines marked kit:allow-secret. */
export function credentialScan(root, floor = K.loadFloor()) {
  const re = K.credentialRegex();
  const denyPats = floor.secret_read_patterns;
  const hits = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p);
        continue;
      }
      if (!e.isFile()) continue;
      const rel = K.relTo(root, p);
      if (K.globMatch(rel, denyPats) || K.globMatch(e.name, denyPats.filter((x) => !x.includes('/')))) continue;
      if (rel.endsWith('security/floor.json')) continue; // the floor's own patterns are not credentials
      let st;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      if (st.size > MAX_SCAN_BYTES) continue;
      let text;
      try {
        text = fs.readFileSync(p, 'utf8');
      } catch {
        continue;
      }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(ALLOW_MARKER)) continue; // a reviewed test fixture, never a real credential
        const m = re.exec(lines[i]);
        if (m) {
          hits.push({ path: rel, line: i + 1, kind: m[0].slice(0, 12) + '…' });
          break;
        }
      }
    }
  };
  walk(root);
  return hits;
}

/**
 * Does the sandbox actually work here? Launches `true` through the detected runtime with the settings a lane would
 * get, the same way the eval and `lane.js start` launch Claude, and reports what happened. This is what CI runs before
 * the real-agent eval: a runtime that cannot start (no user namespaces, a confined bubblewrap, a missing helper) shows
 * up here with the runtime's own message, not as agents that silently did nothing. Never throws.
 */
export function probe(root, env = process.env) {
  const det = detectRuntime(env);
  if (!det.runtime) return { ok: false, runtime: null, how: det.how, status: null, stderr: '', why: 'no sandbox runtime' };
  let dir = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-sandbox-probe-'));
    const cfg = { ...sandboxConfig({ root, wt: dir, slug: 'sandbox-probe', env }), runtime: det.runtime, engine: det.engine || env.KIT_CONTAINER_ENGINE || 'docker' };
    const settingsPath = path.join(dir, 'sandbox.json');
    fs.writeFileSync(settingsPath, JSON.stringify(srtSettings(cfg), null, 2));
    const cmd = launchCommand(cfg, { wt: dir, settingsPath, prompt: '' });
    // the same launcher as a lane, with `true` in place of claude
    const i = cmd.indexOf('claude');
    const run = i >= 0 ? [...cmd.slice(0, i), 'true'] : ['true'];
    const r = spawnSync(run[0], run.slice(1), { cwd: dir, env, encoding: 'utf8', timeout: 60000 });
    const stderr = String(r.stderr ?? '').trim().slice(-2000);
    const status = r.status ?? null;
    return { ok: status === 0, runtime: det.runtime, how: det.how, command: run, status, signal: r.signal ?? null, error: r.error ? (r.error.code || r.error.message) : null, stderr, why: status === 0 ? '' : `${run[0]} exited ${status ?? `with ${r.signal || r.error?.code || 'no status'}`}` };
  } catch (e) {
    return { ok: false, runtime: det.runtime, how: det.how, status: null, stderr: '', why: String(e && e.message || e).split('\n')[0] };
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function main(argv) {
  const ap = new ArgumentParser({ prog: 'sandbox.js' });
  ap.addArgument('cmd');
  ap.addArgument('slug', { nargs: '?' });
  ap.addArgument('--repo', { default: '.' });
  const a = ap.parseArgs(argv);
  const root = K.realResolve(a.repo);
  if (a.cmd === 'detect') {
    process.stdout.write(K.jsonDumps(detectRuntime()) + '\n');
    return 0;
  }
  if (a.cmd === 'scan') {
    const hits = credentialScan(root);
    process.stdout.write(K.jsonDumps({ hits }, { indent: 2 }) + '\n');
    return hits.length ? 2 : 0;
  }
  if (a.cmd === 'probe') {
    const p = probe(root);
    process.stdout.write(K.jsonDumps(p, { indent: 2 }) + '\n');
    return p.ok ? 0 : 1;
  }
  if (a.cmd === 'config') {
    if (!a.slug) {
      process.stderr.write('sandbox.js config <slug> --repo R\n');
      return 2;
    }
    process.stdout.write(K.jsonDumps(sandboxConfig({ root, wt: root, slug: a.slug }), { indent: 2 }) + '\n');
    return 0;
  }
  process.stderr.write(`sandbox.js: unknown command '${a.cmd}'\n`);
  return 2;
}

if (K.isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
