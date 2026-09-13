"""Process proof for the Codex host provider-import memory boundary."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


def test_codex_host_import_does_not_load_provider_http_runtime() -> None:
    """Risk: Codex-only startup initializes every unrelated HTTP provider engine."""

    repository = Path(__file__).parents[3]
    environment = dict(os.environ)
    python_path = str(repository / "python")
    inherited = environment.get("PYTHONPATH")
    environment["PYTHONPATH"] = (
        python_path if inherited is None else os.pathsep.join((python_path, inherited))
    )
    script = """
import json
import sys

import apps.codex_agent.main

loaded = sorted(
    name
    for name in sys.modules
    if name == "provider_runtime.runtime" or name.startswith("provider_runtime.engines")
)
print(json.dumps(loaded))
raise SystemExit(bool(loaded))
"""
    completed = subprocess.run(
        (sys.executable, "-B", "-c", script),
        cwd=repository,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )

    assert completed.returncode == 0, completed.stdout or completed.stderr
