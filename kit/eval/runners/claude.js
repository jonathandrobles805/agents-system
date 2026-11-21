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

function fixtureRepo(task, dir) {
  const builders = { 'node-api': F.nodeApi, 'python-service': F.pythonService };
  const build = builders[task.fixture ?? 'node-api'];
  if (!build) throw new Error(`unknown fixture repo '${task.fixture}'`);
  const root = build(path.join(dir, task.fixture ?? 'node-api'));
  const r = spawnSync(process.execPath, [path.join(K.KIT_DIR, 'scripts', 'bootstrap.js'), '--repo', root], { encoding: 'utf8' });
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
    const root = fixtureRepo(task, dir);
    const cfg = SB.sandboxConfig({ root, wt: root, slug: task.id, agent: task.role ?? 'implementer' });
    const settings = path.join(root, '.claude', 'session', 'sandbox.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify(SB.srtSettings(cfg), null, 2));
    const env = { ...process.env, ...SB.telemetryEnv({ project: 'kit-eval', slug: task.id, stage: task.role ?? 'build' }), KIT_EVAL_ATTEMPT: String(attempt) };
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
      const j = headless(prompt, root, { ...env, KIT_EVAL_JUDGE: '1' }, settings, 5 * 60 * 1000);
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
