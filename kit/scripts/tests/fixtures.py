"""Fixture project generators used by bootstrap and CI tests (and copied into planted-faults/fixtures)."""
from __future__ import annotations
import json
import os
import subprocess
from pathlib import Path

GIT_ENV = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}


def git(args: list[str], cwd: Path) -> str:
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True, env=GIT_ENV).stdout


def commit_all(root: Path, msg: str) -> str:
    git(["add", "-A"], root)
    git(["commit", "-q", "-m", msg], root)
    return git(["rev-parse", "HEAD"], root).strip()


def node_api(root: Path) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    (root / "package.json").write_text(json.dumps({
        "name": "node-api", "version": "1.0.0", "type": "module",
        "scripts": {"test": "vitest run", "lint": "eslint .", "typecheck": "tsc --noEmit"},
        "dependencies": {"express": "^4.19.0"},
        "devDependencies": {"vitest": "^2.0.0", "typescript": "^5.5.0", "eslint": "^9.0.0", "@types/express": "^4.17.0"},
    }, indent=2))
    (root / "package-lock.json").write_text("{}")
    (root / "tsconfig.json").write_text(json.dumps({"compilerOptions": {"strict": True, "module": "esnext", "target": "es2022", "moduleResolution": "bundler", "noEmit": True}, "include": ["src"]}))
    (root / "src" / "domain").mkdir(parents=True)
    (root / "src" / "api").mkdir(parents=True)
    (root / "src" / "domain" / "payment.ts").write_text(
        "export class PaymentService {\n  constructor(private readonly db: { charge(id: string): Promise<number>; refund(id: string): Promise<number> }) {}\n"
        "  async charge(userId: string) {\n    return this.db.charge(userId);\n  }\n  async refund(id: string) {\n    return this.db.refund(id);\n  }\n}\n")
    (root / "src" / "api" / "routes.ts").write_text(
        "import { PaymentService } from '../domain/payment';\nexport function routes(s: PaymentService) {\n  return { charge: (u: string) => s.charge(u) };\n}\n")
    (root / "tests").mkdir()
    (root / "tests" / "payment.test.ts").write_text(
        "import { describe, it, expect } from 'vitest';\nimport { PaymentService } from '../src/domain/payment';\n"
        "describe('PaymentService', () => {\n  it('charges', async () => {\n    const s = new PaymentService({ charge: async () => 5, refund: async () => 1 });\n    expect(await s.charge('u')).toBe(5);\n  });\n"
        "  it('refunds', async () => {\n    const s = new PaymentService({ charge: async () => 5, refund: async () => 1 });\n    expect(await s.refund('x')).toBe(1);\n  });\n});\n")
    (root / ".github").mkdir()
    (root / "README.md").write_text("# node-api\n")
    (root / ".env").write_text("STRIPE_KEY=sk_live_notreal\n")
    (root / ".gitignore").write_text("node_modules\n.env\n")
    git(["init", "-q", "-b", "main"], root)
    commit_all(root, "init")
    return root


def python_service(root: Path) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    (root / "pyproject.toml").write_text(
        '[project]\nname = "python-service"\nversion = "0.1.0"\ndependencies = ["fastapi>=0.110", "pydantic>=2"]\n\n'
        '[project.optional-dependencies]\ndev = ["pytest>=8", "ruff>=0.5", "mypy>=1.10"]\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n\n[tool.ruff]\nline-length = 100\n')
    (root / "app").mkdir()
    (root / "app" / "__init__.py").write_text("")
    (root / "app" / "billing.py").write_text("def total(items: list[int]) -> int:\n    return sum(items)\n\n\ndef refund(amount: int) -> int:\n    return -amount\n")
    (root / "tests").mkdir()
    (root / "tests" / "test_billing.py").write_text("from app.billing import total, refund\n\n\ndef test_total():\n    assert total([1, 2]) == 3\n\n\ndef test_refund():\n    assert refund(5) == -5\n")
    (root / "README.md").write_text("# python-service\n")
    (root / ".gitlab-ci.yml").write_text("stages: [test]\n")
    git(["init", "-q", "-b", "main"], root)
    commit_all(root, "init")
    return root
