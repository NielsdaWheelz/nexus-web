from __future__ import annotations

import subprocess
from pathlib import Path


def test_node_guard_rejects_external_fetch_before_transport() -> None:
    repo_root = Path(__file__).parents[4]
    guard = repo_root / "python/tests/testkit/node-network-guard.mjs"
    result = subprocess.run(
        (
            "node",
            f"--import={guard}",
            "--input-type=module",
            "--eval",
            'await fetch("https://example.com/")',
        ),
        cwd=repo_root,
        check=False,
        capture_output=True,
        text=True,
        timeout=5,
    )

    assert result.returncode != 0
    assert "test process denied external network host: example.com" in result.stderr
