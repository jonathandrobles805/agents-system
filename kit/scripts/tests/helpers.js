// Shared test helpers (port of conftest.py). Used by every *.test.js.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GIT_ENV, git, commitAll } from './fixtures.js';

// Tests must never touch the developer's real ~/.claude: bootstrap registers every project it sets up in
// $CLAUDE_HOME/kit-projects.json. Each test process gets its own throwaway home.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-test-home-'));
process.env.CLAUDE_HOME = TEST_HOME;
// Tests describe the kit's behaviour with a sandbox runtime present unless a test says otherwise (KIT-SPEC 10.9); the
// fixture spec is high-risk, which needs the container runtime. Tests of the degraded path set KIT_SANDBOX_RUNTIME=none.
process.env.KIT_SANDBOX_RUNTIME ??= 'container';
process.on('exit', () => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

export const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Fresh temp dir, removed when the test ends (pytest's tmp_path). */
export function tmpPath(t) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kit-test-')));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/** Set an env var for the duration of the test (pytest's monkeypatch.setenv). */
export function setEnv(t, key, value) {
  const prev = process.env[key];
  process.env[key] = value;
  t.after(() => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  });
}

/** A small git repo with a source file whose lines are known, plus the docs layout (pytest's `repo` fixture). */
export function makeRepo(t) {
  const r = path.join(tmpPath(t), 'proj');
  fs.mkdirSync(path.join(r, 'src'), { recursive: true });
  fs.mkdirSync(path.join(r, 'docs', 'research'), { recursive: true });
  fs.mkdirSync(path.join(r, 'docs', 'specs'), { recursive: true });
  fs.mkdirSync(path.join(r, '.claude'));
  fs.writeFileSync(
    path.join(r, 'src', 'payment.ts'),
    'export class PaymentService {\n' + // 1
      '  constructor(private db: Db) {}\n' + // 2
      '  async charge(userId: string) {\n' + // 3
      '    return this.db.charge(userId);\n' + // 4
      '  }\n' + // 5
      '  async refund(id: string) {\n' + // 6
      '    return this.db.refund(id);\n' + // 7
      '  }\n' + // 8
      '}\n', // 9
  );
  fs.writeFileSync(path.join(r, 'src', 'routes.ts'), "import { PaymentService } from './payment';\nconst s = new PaymentService(db);\ns.charge('u1');\n");
  git(['init', '-q', '-b', 'main'], r);
  commitAll(r, 'init');
  return r;
}

/**
 * Run a kit script as a subprocess, like the Python suite's run_script.
 * @returns {{returncode: number, stdout: string, stderr: string}}
 */
export function runScript(name, args = [], { stdin, cwd, env } = {}) {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, name), ...args], {
    input: stdin,
    encoding: 'utf8',
    cwd,
    env: env ?? process.env,
    maxBuffer: 256 * 1024 * 1024,
  });
  return { returncode: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export { GIT_ENV };
