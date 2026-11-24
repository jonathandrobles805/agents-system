// Fixture project generators used by bootstrap and CI tests (and by planted-faults/make_fixtures.js).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { jsonDumps } from '../kitlib.js';
import { recordSpecApproval } from '../lane.js';

// Hermetic git: the developer's global config (commit signing, hooks) must not affect test repositories.
process.env.GIT_CONFIG_COUNT = '1';
process.env.GIT_CONFIG_KEY_0 = 'commit.gpgsign';
process.env.GIT_CONFIG_VALUE_0 = 'false';

export const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

export function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: GIT_ENV });
}

export function commitAll(root, msg) {
  git(['add', '-A'], root);
  git(['commit', '-q', '-m', msg], root);
  return git(['rev-parse', 'HEAD'], root).trim();
}

/**
 * Stand-in for the owner's merge of a spec/<slug> PR with kit lane merge: record the approval lane.js reads (hardening
 * plan D1), for a fixture whose spec was committed on its base directly. `commit` (default HEAD) must be on the base.
 */
export function approveSpec(root, slug, { by = 'Jonathan Robles', commit = null, pr = null } = {}) {
  const c = commit ?? git(['rev-parse', 'HEAD'], root).trim();
  return recordSpecApproval(root, slug, { by, at: new Date().toISOString().slice(0, 19), merged_at: null, pr, head: null, commit: c });
}

const write = (p, text) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};

/**
 * The node-api project's dependency files (kit/scripts/tests/data/node-api): its package.json, the package-lock.json
 * npm generated from it (`npm install --package-lock-only`), so `npm ci` installs exactly the versions the project
 * declares (the eval installs them before a session: kit/eval/runners/claude.js installDeps), and the ESLint config
 * its `eslint` lint command needs (ESLint 9 exits 2 without one). The three are copied as they are.
 */
export const NODE_API_DEPS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'node-api');
export const NODE_API_DEP_FILES = ['package.json', 'package-lock.json', 'eslint.config.js'];

export function nodeApi(root) {
  fs.mkdirSync(root, { recursive: true });
  for (const f of NODE_API_DEP_FILES) fs.copyFileSync(path.join(NODE_API_DEPS, f), path.join(root, f));
  write(path.join(root, 'tsconfig.json'), jsonDumps({ compilerOptions: { strict: true, module: 'esnext', target: 'es2022', moduleResolution: 'bundler', noEmit: true }, include: ['src'] }));
  write(path.join(root, 'src', 'domain', 'payment.ts'),
    'export class PaymentService {\n  constructor(private readonly db: { charge(id: string): Promise<number>; refund(id: string): Promise<number> }) {}\n' +
    '  async charge(userId: string) {\n    return this.db.charge(userId);\n  }\n  async refund(id: string) {\n    return this.db.refund(id);\n  }\n}\n');
  write(path.join(root, 'src', 'api', 'routes.ts'),
    "import { PaymentService } from '../domain/payment';\nexport function routes(s: PaymentService) {\n  return { charge: (u: string) => s.charge(u) };\n}\n");
  write(path.join(root, 'tests', 'payment.test.ts'),
    "import { describe, it, expect } from 'vitest';\nimport { PaymentService } from '../src/domain/payment';\n" +
    "describe('PaymentService', () => {\n  it('charges', async () => {\n    const s = new PaymentService({ charge: async () => 5, refund: async () => 1 });\n    expect(await s.charge('u')).toBe(5);\n  });\n" +
    "  it('refunds', async () => {\n    const s = new PaymentService({ charge: async () => 5, refund: async () => 1 });\n    expect(await s.refund('x')).toBe(1);\n  });\n});\n");
  fs.mkdirSync(path.join(root, '.github'), { recursive: true });
  write(path.join(root, 'README.md'), '# node-api\n');
  write(path.join(root, '.env'), 'STRIPE_KEY=sk_live_notreal\n');
  write(path.join(root, '.gitignore'), 'node_modules\n.env\ncoverage/\n*.tsbuildinfo\n');
  git(['init', '-q', '-b', 'main'], root);
  commitAll(root, 'init');
  return root;
}

/** A Python target project (the kit must still detect and support Python projects). */
export function pythonService(root) {
  fs.mkdirSync(root, { recursive: true });
  write(path.join(root, 'pyproject.toml'),
    '[project]\nname = "python-service"\nversion = "0.1.0"\ndependencies = ["fastapi>=0.110", "pydantic>=2"]\n\n' +
    '[project.optional-dependencies]\ndev = ["pytest>=8", "ruff>=0.5", "mypy>=1.10"]\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n\n[tool.ruff]\nline-length = 100\n');
  write(path.join(root, 'app', '__init__.py'), '');
  write(path.join(root, 'app', 'billing.py'), 'def total(items: list[int]) -> int:\n    return sum(items)\n\n\ndef refund(amount: int) -> int:\n    return -amount\n');
  write(path.join(root, 'tests', 'test_billing.py'), 'from app.billing import total, refund\n\n\ndef test_total():\n    assert total([1, 2]) == 3\n\n\ndef test_refund():\n    assert refund(5) == -5\n');
  write(path.join(root, 'README.md'), '# python-service\n');
  write(path.join(root, '.gitlab-ci.yml'), 'stages: [test]\n');
  git(['init', '-q', '-b', 'main'], root);
  commitAll(root, 'init');
  return root;
}
