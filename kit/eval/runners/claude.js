// Claude runner (KIT-SPEC 11A): runs a task as a headless Claude Code session in a sandboxed copy of its fixture
// repository with the kit installed, then hands the end state back as an outcome: files, hook events, git, and the
// judge's rubric verdicts. The judge is a second headless session that sees the rubric, the calibration examples and
// the end state, never the worker's transcript.
//
// Needs: `claude` on PATH, ANTHROPIC_API_KEY, and a sandbox runtime (srt or a container). Not runnable in the kit's
// own unit tests, which use the fixture runner; the planted faults for the harness are proven with fixtures too.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as K from '../../scripts/kitlib.js';
import * as SB from '../../scripts/sandbox.js';
import * as F from '../../scripts/tests/fixtures.js';

const EVAL_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const name = 'claude';

export function available(env = process.env) {
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8' });
  if (which.status !== 0) return { ok: false, why: 'claude is not on PATH' };
  if (!env.ANTHROPIC_API_KEY && !env.CLAUDE_CODE_OAUTH_TOKEN) return { ok: false, why: 'no ANTHROPIC_API_KEY (or CLAUDE_CODE_OAUTH_TOKEN) in the environment' };
  const det = SB.detectRuntime(env);
  if (!det.runtime) return { ok: false, why: `no sandbox runtime (${det.how}); the eval never runs agents unsandboxed` };
  return { ok: true, why: `claude on PATH, key present, sandbox ${det.runtime}` };
}

function fixtureRepo(task, dir, claudeHome) {
  const builders = { 'node-api': F.nodeApi, 'python-service': F.pythonService };
  const build = builders[task.fixture ?? 'node-api'];
  if (!build) throw new Error(`unknown fixture repo '${task.fixture}'`);
  const root = build(path.join(dir, task.fixture ?? 'node-api'));
  // the bootstrap registers the repo in the session's own home (CLAUDE_HOME), never the owner's ~/.claude
  const r = spawnSync(process.execPath, [path.join(K.KIT_DIR, 'scripts', 'bootstrap.js'), '--repo', root], { encoding: 'utf8', env: claudeHome ? { ...process.env, CLAUDE_HOME: claudeHome } : process.env });
  if (r.status !== 0) throw new Error(`bootstrap failed: ${r.stderr}`);
  for (const [rel, text] of Object.entries(task.setup?.files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  F.commitAll(root, 'eval setup');
  return root;
}

/** Credential-looking strings never reach a report, whatever a session printed. */
const redact = (s) => s.replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-***').replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, 'gh*_***');

/**
 * What Claude Code itself needs inside the sandbox, beyond the lane's own rules. Seen on GitHub's runner (eval-smoke-main
 * run 44987376718) and reproduced and fixed locally with srt 0.0.83 and Claude Code 2.1.330:
 * - the sandbox makes /tmp and $HOME read-only, so every session exited with `EROFS: ... mkdir '/tmp/claude'`. Each
 *   session gets its own home in the eval's scratch space, writable: Claude Code's config directory is its `.claude`
 *   (`CLAUDE_CONFIG_DIR`) and its temp directory is beside it (`CLAUDE_CODE_TMPDIR`);
 * - the kit under test is installed into that home (`install.sh --copy`), so the fixture's hooks
 *   (`$HOME/.claude/kit/scripts/...`), the kit's agents and its skills are the ones being evaluated, on a CI runner
 *   that never ran install.sh and on the owner's machine alike;
 * - Claude Code ignores a project's `permissions.allow` until the workspace is trusted, and headless runs have no other
 *   way to trust it than `projects["<path>"].hasTrustDialogAccepted` in the config's `.claude.json`, so the fixture
 *   repo (its path and its real path: macOS's temp directory is a symlink) is marked trusted there;
 * - the session must reach the model: `api.anthropic.com` joins the sandbox's network allowlist.
 * The kit's copy in the home (kit, agents, skills, commands, settings.json, CLAUDE.md) is write-denied, so a session
 * cannot rewrite the guards that check it; the owner's own ~/.claude and ~/.claude.json are read-denied. The judge gets
 * a home of its own and an empty working directory, so nothing the worker wrote reaches it. Credentials stay in the
 * environment, and the fixture's bootstrap registers the repo in this home, not the owner's. srt only: the container
 * runtime does not get these settings.
 */
export const API_HOST = 'api.anthropic.com';
const REPO_ROOT = path.dirname(K.KIT_DIR);
export function sessionHome(dir, { install = true } = {}) {
  const home = path.join(dir, 'home');
  const config = path.join(home, '.claude');
  const tmp = path.join(dir, 'claude-tmp');
  fs.mkdirSync(config, { recursive: true });
  fs.mkdirSync(tmp, { recursive: true });
  // git inside the session commits under a fixed identity, never the owner's (their global config is not in this home)
  fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = kit-eval\n\temail = kit-eval@localhost\n');
  // every write-denied path exists as what Claude Code expects (srt covers a missing path with a device file, which
  // Claude Code refuses to read as settings)
  fs.mkdirSync(path.join(config, 'commands'), { recursive: true });
  if (install) {
    const r = spawnSync('bash', [path.join(REPO_ROOT, 'install.sh'), '--copy'], { env: { ...process.env, HOME: home, CLAUDE_HOME: config }, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`install.sh into the eval's home failed: ${r.stderr || r.stdout}`);
  }
  for (const d of ['kit', 'agents', 'skills']) fs.mkdirSync(path.join(config, d), { recursive: true });
  if (!fs.existsSync(path.join(config, 'settings.json'))) fs.writeFileSync(path.join(config, 'settings.json'), '{}\n');
  if (!fs.existsSync(path.join(config, 'CLAUDE.md'))) fs.writeFileSync(path.join(config, 'CLAUDE.md'), '');
  return {
    home,
    config,
    env: { HOME: home, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_TMPDIR: tmp },
    allowWrite: [home, tmp],
    // the home is writable, the kit's guards in it are not: a session cannot rewrite the hooks that check it, nor
    // leave instructions for a later session (the global CLAUDE.md, settings, commands)
    denyWrite: ['kit', 'agents', 'skills', 'commands', 'settings.json', 'CLAUDE.md'].map((x) => path.join(config, x)),
    // the owner's own Claude Code home stays unreadable to the agent (Claude Code itself uses the session's home)
    denyRead: [path.join(os.homedir(), '.claude'), path.join(os.homedir(), '.claude.json')],
    allowedDomains: [API_HOST],
  };
}

/** The srt settings for one session: the lane's rules plus the session's home, cwd and the API host; written to file. */
function sessionSettings(lane, home, cwd, file) {
  const cfg = {
    ...lane,
    allowWrite: [...new Set([...lane.allowWrite.filter((p) => p !== lane.allowWrite[0]), cwd, ...home.allowWrite])],
    denyWrite: home.denyWrite,
    denyRead: [...new Set([...lane.denyRead, ...home.denyRead])],
    allowedDomains: [...new Set([...lane.allowedDomains, ...home.allowedDomains])].sort(),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(SB.srtSettings(cfg), null, 2));
  return file;
}

/** Mark the fixture repo trusted in the session's own Claude Code config, so its permissions.allow rules apply. */
export function trustWorkspace(config, root) {
  const file = path.join(config, '.claude.json');
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    cfg = {};
  }
  cfg.projects = cfg.projects ?? {};
  for (const p of new Set([root, fs.realpathSync(root)])) cfg.projects[p] = { ...(cfg.projects[p] ?? {}), hasTrustDialogAccepted: true };
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
}

function headless(prompt, cwd, env, settingsPath, timeoutMs) {
  const cfg = { runtime: SB.detectRuntime(env).runtime, allowWrite: [cwd, os.tmpdir()], allowedDomains: [], engine: process.env.KIT_CONTAINER_ENGINE || 'docker' };
  const cmd = SB.launchCommand(cfg, { wt: cwd, settingsPath, prompt });
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd, env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  // status is null when the session timed out (signal) or could not be spawned (error); both are kept
  return { status: r.status, signal: r.signal ?? null, error: r.error ? (r.error.code || r.error.message) : null, stdout: r.stdout ?? '', stderr: redact(r.stderr ?? '') };
}

function snapshot(root) {
  const files = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (['.git', 'node_modules', '.claude'].includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (fs.statSync(p).size < 512 * 1024) files[K.relTo(root, p)] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(root);
  return files;
}

export async function run(task, { attempt = 0, timeoutMs = 20 * 60 * 1000 } = {}) {
  const a = available();
  if (!a.ok) throw new Error(`claude runner unavailable: ${a.why}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kit-eval-${task.id}-`));
  const started = Date.now();
  try {
    // the session home is for srt only: a container runtime runs the host's docker/podman CLI, which needs the real HOME
    const srt = SB.detectRuntime(process.env).runtime === 'srt';
    const home = srt ? sessionHome(dir) : null;
    const root = fixtureRepo(task, dir, home?.config);
    if (home) trustWorkspace(home.config, root);
    const lane = SB.sandboxConfig({ root, wt: root, slug: task.id, agent: task.role ?? 'implementer' });
    const settings = path.join(root, '.claude', 'session', 'sandbox.json');
    if (home) sessionSettings(lane, home, root, settings);
    else {
      fs.mkdirSync(path.dirname(settings), { recursive: true });
      fs.writeFileSync(settings, JSON.stringify(SB.srtSettings(lane), null, 2));
    }
    const base = { ...process.env, ...SB.telemetryEnv({ project: 'kit-eval', slug: task.id, stage: task.role ?? 'build' }), KIT_EVAL_ATTEMPT: String(attempt) };
    const env = { ...base, ...(home?.env ?? {}) };
    const work = headless(task.goal, root, env, settings, timeoutMs);
    const files = snapshot(root);
    const eventsPath = path.join(root, '.claude', 'session', 'events.jsonl');
    const events = fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    const git = { log: spawnSync('git', ['log', '--oneline', '-20'], { cwd: root, encoding: 'utf8' }).stdout.trim().split('\n') };
    // the judge: rubric + calibration examples + end state, never the worker's transcript
    let judge = {};
    let judgeSession = null;
    if ((task.rubric ?? []).length) {
      const examples = task.calibration ? `\n\nCalibration examples:\n${JSON.stringify(task.calibration, null, 2)}` : '';
      const prompt = `You are grading the end state of a repository against a rubric. Answer ONLY with a JSON object mapping each criterion id to 1 (met) or 0 (not met).\n\nRubric:\n${task.rubric.map((c) => `- ${c.id}: ${c.text}`).join('\n')}${examples}\n\nFiles (path then content):\n${Object.entries(files).slice(0, 60).map(([p, t]) => `--- ${p}\n${t.slice(0, 4000)}`).join('\n')}\n\nGit log:\n${git.log.join('\n')}`;
      // the judge has its own home and an empty working directory: nothing the worker left in its repo or home
      // (a CLAUDE.md, settings) reaches it; it sees the end state only through its prompt
      const jdir = path.join(dir, 'judge');
      const jcwd = path.join(jdir, 'work');
      fs.mkdirSync(jcwd, { recursive: true });
      const jhome = srt ? sessionHome(jdir, { install: false }) : null;
      const jsettings = jhome ? sessionSettings(lane, jhome, jcwd, path.join(jdir, 'sandbox.json')) : settings;
      const j = headless(prompt, jhome ? jcwd : root, { ...base, ...(jhome?.env ?? {}), KIT_EVAL_JUDGE: '1' }, jsettings, 5 * 60 * 1000);
      judgeSession = { status: j.status, signal: j.signal, error: j.error, stderr: j.stderr.slice(-2000) };
      const m = /\{[\s\S]*\}/.exec(j.stdout);
      if (m) {
        try {
          judge = JSON.parse(m[0]);
        } catch {
          judge = {};
        }
      }
    }
    return { runner: name, variant: null, files, events, git, judge, ms: Date.now() - started, worker_status: work.status, worker_signal: work.signal, worker_error: work.error, worker_stderr: work.stderr.slice(-2000), judge_session: judgeSession };
  } finally {
    if (!process.env.KIT_EVAL_KEEP) fs.rmSync(dir, { recursive: true, force: true });
  }
}
