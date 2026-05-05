"""Real-media acceptance tests must not patch internal Nexus behavior."""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

from tests.real_media.conftest import ensure_real_media_prerequisites, write_trace

pytestmark = [
    pytest.mark.slow,
    pytest.mark.supabase,
    pytest.mark.network,
    pytest.mark.real_media,
]


def test_real_media_tests_do_not_patch_internal_boundaries(tmp_path):
    ensure_real_media_prerequisites()
    forbidden: list[str] = []
    scanned_files: list[str] = []
    for path in sorted(
        path
        for test_dir in (Path(__file__).parent, Path(__file__).parents[1] / "live_providers")
        for path in test_dir.glob("*.py")
    ):
        scanned_files.append(str(path.relative_to(Path(__file__).parents[1])))
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

    e2e_dir = Path(__file__).parents[3] / "e2e" / "tests" / "real-media"
    for path in sorted(e2e_dir.glob("*.spec.ts")):
        scanned_files.append(str(path.relative_to(Path(__file__).parents[3])))
        text = path.read_text(encoding="utf-8")
        for needle in (
            "page.route(",
            "context.route(",
            "browserContext.route(",
            "route.fulfill(",
            "route.continue(",
            "vi.mock(",
            "jest.mock(",
            "mockImplementation(",
        ):
            if needle in text:
                forbidden.append(f"{path.name} contains {needle}")

    assert not forbidden, "\n".join(forbidden)
    write_trace(
        tmp_path,
        "real-media-no-internal-mocks-trace.json",
        {"scanned_files": scanned_files},
    )
