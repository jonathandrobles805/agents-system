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

/** Domains the spec declares under an optional `## Network` section (one per list item). */
export function specNetwork(specPath) {
  if (!K.isFile(specPath)) return [];
  const sec = K.parseSections(K.stripHtmlComments(K.readLines(specPath))).get('network');
  if (!sec) return [];
  const out = [];
  for (const [, line] of sec.lines ?? []) {
    const m = /^\s*[-*]\s+`?([a-z0-9.-]+\.[a-z]{2,}|\*)`?/i.exec(line);
    if (m) out.push(m[1].toLowerCase());
  }
  return out;
}

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

/** The sandbox configuration for one lane. Pure. */
export function sandboxConfig({ root, wt, slug, agent = 'implementer', env = process.env }) {
  const floor = K.loadFloor();
  const kit = K.loadKitJson(root);
  const det = detectRuntime(env);
  const preferred = typeof kit.sandbox?.runtime === 'string' ? kit.sandbox.runtime : null;
  const runtime = preferred === 'container' && det.runtime ? 'container' : det.runtime;
  const net = floor.network ?? {};
  const perAgent = Array.isArray(net.per_agent?.[agent]) ? net.per_agent[agent] : [];
  const domains = [...new Set([...(Array.isArray(net.default_allow) ? net.default_allow : []), ...specNetwork(path.join(wt, 'docs', 'specs', `${slug}.md`)), ...perAgent])].sort();
  const scratch = path.join(os.tmpdir(), `kit-lane-${slug}`);
  return {
    runtime,
    state: runtime ? 'contained' : 'degraded',
    how: det.how,
    engine: det.engine ?? null,
    agent,
    allowWrite: [wt, scratch],
    denyRead: denyReadPaths(wt, floor, kit),
    allowedDomains: domains,
    failIfUnavailable: true,
  };
}

/** srt settings file content for a configuration (format follows the sandbox-runtime README; marked provisional there). */
export function srtSettings(cfg) {
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: cfg.failIfUnavailable,
      filesystem: { allowWrite: cfg.allowWrite, denyRead: cfg.denyRead },
      network: { allowedDomains: cfg.allowedDomains, deniedDomains: [] },
    },
  };
}

/** The command the host side runs to start a headless lane session inside the sandbox. Argument list, not a shell string. */
export function launchCommand(cfg, { wt, settingsPath, prompt }) {
  const claude = ['claude', '-p', prompt, '--permission-mode', 'default'];
  if (cfg.runtime === 'srt') return ['srt', '--settings', settingsPath, '--', ...claude];
  if (cfg.runtime === 'container') {
    const eng = cfg.engine || 'docker';
    const args = [eng, 'run', '--rm', '--network', 'kit-lane', '-v', `${wt}:${wt}`, '-w', wt, '-v', `${cfg.allowWrite[1]}:${cfg.allowWrite[1]}`];
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
