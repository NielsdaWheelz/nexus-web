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


def _python_files_to_scan(repo_root: Path) -> list[Path]:
    python_tests = repo_root / "python" / "tests"
    return [
        *sorted((python_tests / "real_media").glob("*.py")),
        *sorted((python_tests / "live_providers").glob("test_*.py")),
        repo_root / "python" / "scripts" / "seed_real_media_e2e.py",
    ]


def _e2e_files_to_scan(repo_root: Path) -> list[Path]:
    return sorted((repo_root / "e2e" / "tests" / "real-media").glob("*.ts"))


def _flag_python_internal_mocks(path: Path, tree: ast.AST, forbidden: list[str]) -> None:
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module == "unittest.mock":
            forbidden.append(f"{path.name}:{node.lineno} imports unittest.mock")
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name in {"mock", "unittest.mock"}:
                    forbidden.append(f"{path.name}:{node.lineno} imports {alias.name}")
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for arg in [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs]:
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


def _flag_forbidden_text(
    path: Path,
    source: str,
    needles: tuple[str, ...],
    forbidden: list[str],
) -> None:
    for needle in needles:
        if needle.casefold() in source.casefold():
            forbidden.append(f"{path.name} contains internal shortcut {needle}")


def test_real_media_tests_do_not_patch_internal_boundaries(tmp_path):
    ensure_real_media_prerequisites()
    forbidden: list[str] = []
    scanned_files: list[str] = []
    repo_root = Path(__file__).parents[3]

    forbidden_python_shortcuts = (
        "INSERT INTO " + "media",
        "INSERT INTO " + "fragments",
        "INSERT INTO " + "media_transcript_states",
        "INSERT INTO " + "podcast_transcript_segments",
        "INSERT INTO " + "podcast_transcript_versions",
        "INSERT INTO " + "podcast_transcription_jobs",
        "INSERT INTO " + "source_snapshots",
        "INSERT INTO " + "content_index_runs",
        "INSERT INTO " + "media_content_index_states",
        "INSERT INTO " + "content_blocks",
        "INSERT INTO " + "content_chunks",
        "INSERT INTO " + "content_chunk_parts",
        "INSERT INTO " + "content_embeddings",
        "INSERT INTO " + "evidence_spans",
        "UPDATE " + "media SET plain_text",
        "UPDATE " + "fragments",
        "UPDATE " + "media_transcript_states",
        "UPDATE " + "media_content_index_states",
        "DELETE FROM " + "fragment_blocks",
        "DELETE FROM " + "content_chunks",
        "DELETE FROM " + "content_embeddings",
        "rebuild_" + "fragment_content_index(",
        "insert_" + "fragment_blocks(",
        "_insert_" + "transcript",
        "_persist_" + "transcript",
    )
    forbidden_e2e_shortcuts = (
        "page.route(",
        "context.route(",
        "browserContext.route(",
        "route.fulfill(",
        "route.continue(",
        "vi.mock(",
        "jest.mock(",
        "mockImplementation(",
        "INSERT INTO " + "media",
        "INSERT INTO " + "fragments",
        "INSERT INTO " + "content_chunks",
        "INSERT INTO " + "content_embeddings",
        "INSERT INTO " + "podcast_transcript",
    )

    for path in _python_files_to_scan(repo_root):
        scanned_files.append(str(path.relative_to(repo_root)))
        source = path.read_text(encoding="utf-8")
        tree = ast.parse(source, filename=str(path))
        _flag_python_internal_mocks(path, tree, forbidden)
        _flag_forbidden_text(path, source, forbidden_python_shortcuts, forbidden)

    for path in _e2e_files_to_scan(repo_root):
        scanned_files.append(str(path.relative_to(repo_root)))
        source = path.read_text(encoding="utf-8")
        _flag_forbidden_text(path, source, forbidden_e2e_shortcuts, forbidden)

    assert not forbidden, "\n".join(forbidden)
    write_trace(
        tmp_path,
        "real-media-no-internal-mocks-trace.json",
        {"scanned_files": scanned_files},
    )
