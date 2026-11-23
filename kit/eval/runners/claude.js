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

/**
 * A setup file's text: a string, or `{ "from": "<path under kit/eval>" }` for a file several tasks share. In either,
 * `{{eval:head}}` becomes the fixture's commit the setup is written against (a spec's Commit and approval lines).
 */
export function setupText(value, head) {
  let text = value;
  if (typeof value !== 'string') {
    const src = path.resolve(EVAL_DIR, String(value?.from ?? ''));
    if (!value?.from || path.relative(EVAL_DIR, src).startsWith('..')) throw new Error(`eval setup: ${JSON.stringify(value)} is neither text nor { "from": "<path under kit/eval>" }`);
    text = fs.readFileSync(src, 'utf8');
  }
  return text.replaceAll('{{eval:head}}', head);
}

function writeSetupFiles(root, files, head) {
  for (const [rel, value] of Object.entries(files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), setupText(value, head));
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const deepMerge = (a, b) => {
  for (const [k, v] of Object.entries(b)) a[k] = isObj(v) && isObj(a[k]) ? deepMerge({ ...a[k] }, v) : v;
  return a;
};

/** One row's Red run or Green run cell in a lane's progress.md set to a log reference, as the tester and implementer do. */
export function setProgressCell(file, criterion, column, ref) {
  const at = { red: 4, green: 5 }[column];
  if (!at) throw new Error(`eval setup: a run is recorded as red or green, not '${column}'`);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const i = lines.findIndex((l) => new RegExp(`^\\|\\s*${criterion}\\s*\\|`).test(l));
  if (i < 0) throw new Error(`eval setup: no row ${criterion} in ${file}`);
  const cells = lines[i].split('|');
  cells[at] = ` ${ref} `;
  lines[i] = cells.join('|');
  fs.writeFileSync(file, lines.join('\n'));
}

/**
 * The lane a task's goal names, made the way the kit makes one: `lane.js start` (precheck, worktree on wt/<slug> from
 * origin's base, lane.json, progress skeleton), then the task's steps, each a kit operation: `stage` (lane.js stage),
 * `write` (files in the worktree), `check` (lane.js check runs the command host-side and logs it; its log ref goes into
 * the progress row, and a run whose exit contradicts `record` stops the setup), `commit`, `template` (lane.js template).
 * Returns the worktree.
 */
function startLane(root, dir, lane, env, head) {
  const laneJs = (args) => {
    const r = spawnSync(process.execPath, [path.join(K.KIT_DIR, 'scripts', 'lane.js'), ...args], { cwd: root, env, encoding: 'utf8', timeout: 10 * 60 * 1000 });
    if (r.status !== 0) throw new Error(`eval setup: lane.js ${args.join(' ')} exited ${r.status}: ${r.stderr || r.stdout}`);
    return r.stdout;
  };
  const last = (out) => JSON.parse(out.trim().split('\n').pop());
  // lane.js start fetches the base from origin and refuses a repo without one; the fixture's origin is a bare clone
  F.git(['clone', '-q', '--bare', root, path.join(dir, 'origin.git')], dir);
  F.git(['remote', 'add', 'origin', path.join(dir, 'origin.git')], root);
  const wt = last(laneJs(['start', lane.slug, '--repo', root])).worktree;
  for (const step of lane.steps ?? []) {
    if (step.stage) laneJs(['stage', lane.slug, step.stage, '--repo', root]);
    else if (step.write) writeSetupFiles(wt, step.write, head);
    else if (step.check) {
      const r = last(laneJs(['check', lane.slug, step.check, '--repo', root, '--', step.command]));
      if ((step.record === 'red') !== (r.exit !== 0)) throw new Error(`eval setup: the ${step.record} run of ${step.check} (${step.command}) exited ${r.exit}`);
      setProgressCell(path.join(wt, K.findLane(wt).work, `${lane.slug}.progress.md`), step.check, step.record, r.ref);
    } else if (step.commit) F.commitAll(wt, step.commit);
    else if (step.template) fs.writeFileSync(path.join(wt, step.to), laneJs(['template', step.template, '--slug', lane.slug, '--repo', wt]));
    else throw new Error(`eval setup: unknown lane step ${JSON.stringify(step)}`);
  }
  return wt;
}

/**
 * The fixture repo, bootstrapped, with the task's setup: its `files` and `kit_json` patch committed on main as
 * "eval setup", then its `lane`, if any. Returns the repo, the directory the worker runs in (the lane's worktree when
 * there is one) and the lane's slug.
 */
export function fixtureRepo(task, dir, claudeHome) {
  const builders = { 'node-api': F.nodeApi, 'python-service': F.pythonService };
  const build = builders[task.fixture ?? 'node-api'];
  if (!build) throw new Error(`unknown fixture repo '${task.fixture}'`);
  const root = build(path.join(dir, task.fixture ?? 'node-api'));
  // the bootstrap registers the repo in the session's own home (CLAUDE_HOME), never the owner's ~/.claude; a setup's
  // test runs (npx) cache their packages in the eval's scratch space, not the owner's ~/.npm
  const env = { ...process.env, ...(claudeHome ? { CLAUDE_HOME: claudeHome } : {}), npm_config_cache: path.join(dir, 'npm-cache') };
  const r = spawnSync(process.execPath, [path.join(K.KIT_DIR, 'scripts', 'bootstrap.js'), '--repo', root], { encoding: 'utf8', env });
  if (r.status !== 0) throw new Error(`bootstrap failed: ${r.stderr}`);
  const setup = task.setup ?? {};
  const head = F.git(['rev-parse', 'HEAD'], root).trim();
  writeSetupFiles(root, setup.files, head);
  if (setup.kit_json) {
    const kj = path.join(root, '.claude', 'kit.json');
    fs.writeFileSync(kj, JSON.stringify(deepMerge(JSON.parse(fs.readFileSync(kj, 'utf8')), setup.kit_json), null, 2) + '\n');
  }
  F.commitAll(root, 'eval setup');
  if (!setup.lane) return { root, cwd: root, lane: null };
  return { root, cwd: startLane(root, dir, setup.lane, env, head), lane: setup.lane.slug };
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
 * cannot rewrite it (the repo's own .claude/settings.json, which registers the hooks, is still writable: the worktree
 * gap bypass.test records for hardening plan Step 4); the owner's own ~/.claude and ~/.claude.json are read-denied. The judge gets
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
    const r = spawnSync('bash', [path.join(REPO_ROOT, 'install.sh'), '--copy'], { env: { ...process.env, HOME: home, CLAUDE_HOME: config, KIT_BIN_DIR: path.join(home, '.local', 'bin') }, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`install.sh into the eval's home failed: ${r.stderr || r.stdout}`);
  }
  for (const d of ['kit', 'agents', 'skills']) fs.mkdirSync(path.join(config, d), { recursive: true });
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  if (!fs.existsSync(path.join(config, 'settings.json'))) fs.writeFileSync(path.join(config, 'settings.json'), '{}\n');
  if (!fs.existsSync(path.join(config, 'CLAUDE.md'))) fs.writeFileSync(path.join(config, 'CLAUDE.md'), '');
  return {
    home,
    config,
    // the kit's `kit` launcher (#63) is installed into the home's .local/bin and goes first on PATH. zsh reads its
    // startup files from $ZDOTDIR when set, else $HOME. On the owner's Mac every Bash call printed
    // `/Users/<owner>/.zshenv:.:1: no such file or directory: <session home>/.cargo/env`, which is what zsh 5.9 prints
    // when ZDOTDIR still names the owner's home and HOME is the session's (reproduced on Linux); ZDOTDIR is the session's
    env: { HOME: home, ZDOTDIR: home, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_TMPDIR: tmp, PATH: `${path.join(home, '.local', 'bin')}${path.delimiter}${process.env.PATH ?? ''}` },
    allowWrite: [home, tmp],
    // the home is writable, the kit's guards in it are not: a session cannot rewrite the hooks that check it, nor
    // leave instructions for a later session (the global CLAUDE.md, settings, commands)
    denyWrite: [...['kit', 'agents', 'skills', 'commands', 'settings.json', 'CLAUDE.md'].map((x) => path.join(config, x)), path.join(home, '.local', 'bin')],
    // the owner's own Claude Code home stays unreadable to the agent (Claude Code itself uses the session's home)
    denyRead: ownerClaudeDenyRead(),
    allowedDomains: [API_HOST],
  };
}

/** The srt settings for one session: the lane's rules plus the session's home, cwd and the API host; written to file. */
function sessionSettings(lane, home, cwd, file, { laneScratch = true } = {}) {
  const cfg = {
    ...lane,
    // the session's cwd (the worker's repo, or the judge's empty folder), the lane's scratch for the worker only, the home
    allowWrite: [cwd, ...(laneScratch ? lane.allowWrite.slice(1) : []), ...home.allowWrite],
    denyWrite: home.denyWrite,
    denyRead: [...new Set([...lane.denyRead, ...home.denyRead])],
    allowedDomains: [...new Set([...lane.allowedDomains, ...home.allowedDomains])].sort(),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(SB.srtSettings(cfg), null, 2));
  return file;
}

/**
 * The owner's ~/.claude.json and ~/.claude, read-denied. When the `claude` program itself lives under ~/.claude (the
 * old local install, ~/.claude/local), that one folder stays readable so the sandbox can still run it; everything else
 * there (credentials, keys, transcripts) is denied entry by entry.
 */
export function ownerClaudeDenyRead(home = os.homedir(), which = spawnSync('which', ['claude'], { encoding: 'utf8' }).stdout?.trim() ?? '') {
  const dot = path.join(home, '.claude');
  let bin = '';
  try {
    bin = which ? fs.realpathSync(which) : '';
  } catch {
    bin = '';
  }
  const rel = bin ? path.relative(fs.existsSync(dot) ? fs.realpathSync(dot) : dot, bin) : '';
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return [dot, path.join(home, '.claude.json')];
  const keep = rel.split(path.sep)[0];
  // credentials and keys are denied even before they exist (an entry created later is otherwise not on the list)
  const entries = new Set([...fs.readdirSync(dot), '.credentials.json', 'keys']);
  entries.delete(keep);
  return [...[...entries].map((e) => path.join(dot, e)), path.join(home, '.claude.json')];
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

function headless(prompt, cwd, env, settingsPath, timeoutMs, agent = null) {
  const cfg = { runtime: SB.detectRuntime(env).runtime, allowWrite: [cwd, os.tmpdir()], allowedDomains: [], engine: process.env.KIT_CONTAINER_ENGINE || 'docker' };
  const cmd = SB.launchCommand(cfg, { wt: cwd, settingsPath, prompt, agent });
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd, env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  // status is null when the session timed out (signal) or could not be spawned (error); both are kept
  return { command: cmd.map(redact), status: r.status, signal: r.signal ?? null, error: r.error ? (r.error.code || r.error.message) : null, stdout: r.stdout ?? '', stderr: redact(r.stderr ?? '') };
}

/**
 * The kit agent a task runs as: its role, when the session's home has that agent installed (install.sh --copy puts
 * kit/agents/*.md in <home>/.claude/agents). Without a session home (the container runtime) nothing proves which
 * agents the session can see, so none is named.
 */
export function kitAgent(task, home) {
  const role = task.role;
  if (!home || typeof role !== 'string' || !/^[a-z][a-z-]*$/.test(role)) return null;
  return fs.existsSync(path.join(home.config, 'agents', `${role}.md`)) ? role : null;
}

/**
 * The session's transcripts, redacted, copied to `out` (Claude Code writes them under its config directory's projects/,
 * one file per session and one per subagent). Returns the copies' paths; none when the session wrote none.
 */
export function keepTranscripts(config, out) {
  const src = path.join(config, 'projects');
  const kept = [];
  const walk = (d) => {
    for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) {
        const dest = path.join(out, path.relative(src, p));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, redact(fs.readFileSync(p, 'utf8')));
        kept.push(dest);
      }
    }
  };
  walk(src);
  return kept;
}

/** Hook events from line `from` on: the lines a session appended, never the ones the setup wrote before it. */
function readEvents(file, from = 0) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(from).map((l) => JSON.parse(l));
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

export async function run(task, { attempt = 0, timeoutMs = 20 * 60 * 1000, transcripts = null } = {}) {
  const a = available();
  if (!a.ok) throw new Error(`claude runner unavailable: ${a.why}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kit-eval-${task.id}-`));
  const started = Date.now();
  try {
    // the session home is for srt only: a container runtime runs the host's docker/podman CLI, which needs the real HOME
    const srt = SB.detectRuntime(process.env).runtime === 'srt';
    const home = srt ? sessionHome(dir) : null;
    // the worker runs where its goal is: the fixture repo, or the lane's worktree when the task sets one up
    const { root, cwd, lane: slug } = fixtureRepo(task, dir, home?.config);
    // Claude Code looks up a worktree's trust under its main repository (seen: "Ignoring 16 permissions.allow entries ...
    // projects["<repo>"].hasTrustDialogAccepted" for a session in the lane's worktree), so both are trusted
    if (home) for (const p of new Set([root, cwd])) trustWorkspace(home.config, p);
    const lane = SB.sandboxConfig({ root, wt: cwd, slug: slug ?? task.id, agent: task.role ?? 'implementer' });
    const settings = path.join(cwd, '.claude', 'session', 'sandbox.json');
    if (home) sessionSettings(lane, home, cwd, settings);
    else {
      fs.mkdirSync(path.dirname(settings), { recursive: true });
      fs.writeFileSync(settings, JSON.stringify(SB.srtSettings(lane), null, 2));
    }
    // in a lane the hooks write the lane's events file; elsewhere the repo's session file
    const laneRec = slug ? K.findLane(cwd) : null;
    const eventsPath = laneRec ? laneRec.eventsPath : path.join(cwd, '.claude', 'session', 'events.jsonl');
    const before = readEvents(eventsPath).length;
    const base = { ...process.env, ...SB.telemetryEnv({ project: 'kit-eval', slug: task.id, stage: task.role ?? 'build' }), KIT_EVAL_ATTEMPT: String(attempt) };
    const env = { ...base, ...(home?.env ?? {}) };
    const work = headless(task.goal, cwd, env, settings, timeoutMs, kitAgent(task, home));
    const kept = { worker: home && transcripts ? keepTranscripts(home.config, path.join(transcripts, 'worker')) : [], judge: [] };
    const files = snapshot(cwd);
    const events = readEvents(eventsPath, before);
    const git = { log: spawnSync('git', ['log', '--oneline', '-20'], { cwd, encoding: 'utf8' }).stdout.trim().split('\n') };
    // the project's recorded test commands, so the scorer can tell a test run among the session's Bash calls
    const cmds = K.loadKitJson(cwd).commands ?? {};
    const testCommands = ['test', 'test_affected', 'test_file'].map((k) => cmds[k]).filter((c) => typeof c === 'string' && c.trim());
    // the judge: rubric + calibration examples + end state, never the worker's transcript
    let judge = {};
    let judgeSession = null;
    if ((task.rubric ?? []).length) {
      const examples = task.calibration ? `\n\nCalibration examples:\n${JSON.stringify(task.calibration, null, 2)}` : '';
      const prompt = `You are grading the end state of a repository against a rubric. Answer ONLY with a JSON object mapping each criterion id to 1 (met) or 0 (not met).\n\nRubric:\n${task.rubric.map((c) => `- ${c.id}: ${c.text}`).join('\n')}${examples}\n\nFiles (path then content):\n${Object.entries(files).slice(0, 60).map(([p, t]) => `--- ${p}\n${t.slice(0, 4000)}`).join('\n')}\n\nGit log:\n${git.log.join('\n')}`;
      // the judge has its own home and an empty working directory: nothing the worker left in its repo or home
      // (a CLAUDE.md, settings) reaches it; it sees the end state only through its prompt. It runs as no kit agent.
      const jdir = path.join(dir, 'judge');
      const jcwd = path.join(jdir, 'work');
      fs.mkdirSync(jcwd, { recursive: true });
      const jhome = srt ? sessionHome(jdir, { install: false }) : null;
      const jsettings = jhome ? sessionSettings(lane, jhome, jcwd, path.join(jdir, 'sandbox.json'), { laneScratch: false }) : settings;
      const j = headless(prompt, jhome ? jcwd : cwd, { ...base, ...(jhome?.env ?? {}), KIT_EVAL_JUDGE: '1' }, jsettings, 5 * 60 * 1000);
      if (jhome && transcripts) kept.judge = keepTranscripts(jhome.config, path.join(transcripts, 'judge'));
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
    return { runner: name, variant: null, files, events, git, judge, test_commands: testCommands, transcripts: kept, ms: Date.now() - started, worker_command: work.command, worker_status: work.status, worker_signal: work.signal, worker_error: work.error, worker_stderr: work.stderr.slice(-2000), judge_session: judgeSession };
  } finally {
    if (!process.env.KIT_EVAL_KEEP) fs.rmSync(dir, { recursive: true, force: true });
  }
}
