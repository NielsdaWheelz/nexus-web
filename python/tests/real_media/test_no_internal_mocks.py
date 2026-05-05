"""Real-media acceptance tests must not patch internal Nexus behavior."""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

pytestmark = [
    pytest.mark.slow,
    pytest.mark.supabase,
    pytest.mark.network,
    pytest.mark.real_media,
]


def test_real_media_tests_do_not_patch_internal_boundaries():
    forbidden: list[str] = []
    for path in sorted(Path(__file__).parent.glob("test_*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module == "unittest.mock":
                forbidden.append(f"{path.name}:{node.lineno} imports unittest.mock")
            if isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name in {"mock", "unittest.mock"}:
                        forbidden.append(f"{path.name}:{node.lineno} imports {alias.name}")
            if isinstance(node, ast.FunctionDef):
                for arg in node.args.args:
                    if arg.arg == "monkeypatch":
                        forbidden.append(f"{path.name}:{node.lineno} requests monkeypatch")
            if isinstance(node, ast.Call):
                if isinstance(node.func, ast.Name) and node.func.id == "patch":
                    forbidden.append(f"{path.name}:{node.lineno} calls patch")
                if (
                    isinstance(node.func, ast.Attribute)
                    and node.func.attr == "patch"
                    and isinstance(node.func.value, ast.Name)
                    and node.func.value.id == "mock"
                ):
                    forbidden.append(f"{path.name}:{node.lineno} calls mock.patch")
                if (
                    isinstance(node.func, ast.Attribute)
                    and node.func.attr == "setattr"
                    and isinstance(node.func.value, ast.Name)
                    and node.func.value.id == "monkeypatch"
                ):
                    forbidden.append(f"{path.name}:{node.lineno} calls monkeypatch.setattr")

    assert not forbidden, "\n".join(forbidden)
