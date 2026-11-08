import os
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """A small git repo with a source file whose lines are known, plus the docs layout."""
    r = tmp_path / "proj"
    (r / "src").mkdir(parents=True)
    (r / "docs" / "research").mkdir(parents=True)
    (r / "docs" / "specs").mkdir(parents=True)
    (r / ".claude").mkdir()
    (r / "src" / "payment.ts").write_text(
        "export class PaymentService {\n"          # 1
        "  constructor(private db: Db) {}\n"       # 2
        "  async charge(userId: string) {\n"       # 3
        "    return this.db.charge(userId);\n"     # 4
        "  }\n"                                    # 5
        "  async refund(id: string) {\n"           # 6
        "    return this.db.refund(id);\n"         # 7
        "  }\n"                                    # 8
        "}\n"                                      # 9
    )
    (r / "src" / "routes.ts").write_text("import { PaymentService } from './payment';\nconst s = new PaymentService(db);\ns.charge('u1');\n")
    env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=r, check=True)
    subprocess.run(["git", "add", "-A"], cwd=r, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=r, check=True, env=env)
    return r


def run_script(name: str, args: list[str], stdin: str | None = None, cwd: Path | None = None):
    return subprocess.run(
        [sys.executable, "-I", str(SCRIPTS / name), *args],
        input=stdin, capture_output=True, text=True, cwd=cwd,
    )
