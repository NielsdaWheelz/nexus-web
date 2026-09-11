"""Fresh-process import boundary for the Codex metadata projection."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


def test_codex_projection_does_not_import_the_application_execution_owner() -> None:
    """Risk: metadata-only MCP lowering retains the executable Nexus/DB graph."""

    repository = Path(__file__).parents[3]
    environment = dict(os.environ)
    python_path = str(repository / "python")
    inherited = environment.get("PYTHONPATH")
    environment["PYTHONPATH"] = (
        python_path if inherited is None else os.pathsep.join((python_path, inherited))
    )
    script = """
import sys
from nexus.services.codex_generation_operations import compose_codex_model_tool_plan_registry

registry = compose_codex_model_tool_plan_registry()
if not registry.operations:
    raise SystemExit("Codex projection registry is empty")
forbidden = {
    "nexus.services.tool_runtime.bindings",
    "nexus.services.tool_runtime.execution",
}
loaded = sorted(forbidden.intersection(sys.modules))
if loaded:
    raise SystemExit("Codex projection imported executable owners: " + ", ".join(loaded))
"""
    completed = subprocess.run(
        (sys.executable, "-c", script),
        cwd=repository,
        env=environment,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
