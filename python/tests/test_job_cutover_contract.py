"""Contract tests for Postgres queue cutover (no Celery runtime path)."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

pytestmark = pytest.mark.unit

_REPO_ROOT = Path(__file__).resolve().parents[2]
_PYTHON_RUNTIME_ROOT = _REPO_ROOT / "python" / "nexus"
_WORKER_APP_ROOT = _REPO_ROOT / "apps" / "worker"
_SERVICE_ROOT = _PYTHON_RUNTIME_ROOT / "services"
_TASK_ROOT = _PYTHON_RUNTIME_ROOT / "tasks"
_TEST_ROOT = _REPO_ROOT / "python" / "tests"
_CUTOVER_TOPOLOGY_FILES = [
    _REPO_ROOT / "python" / "pyproject.toml",
    _REPO_ROOT / "scripts" / "test_env.sh",
    _REPO_ROOT / "scripts" / "with_test_services.sh",
    _REPO_ROOT / "scripts" / "agency_setup.sh",
    _REPO_ROOT / "docker" / "docker-compose.test.yml",
    _REPO_ROOT / "python" / "tests" / "test_migrations.py",
]
_LEGACY_WORDING_FILES = [
    _REPO_ROOT / "python" / "README.md",
    _PYTHON_RUNTIME_ROOT / "logging.py",
    _TASK_ROOT / "ingest_pdf.py",
    _TASK_ROOT / "podcast_sync_subscription.py",
    _TASK_ROOT / "reconcile_stale_ingest_media.py",
]


def _iter_python_files(root: Path) -> list[Path]:
    return [
        path for path in root.rglob("*.py") if "__pycache__" not in path.parts and path.is_file()
    ]


def test_runtime_code_has_no_celery_imports():
    celery_import_pattern = re.compile(r"^\s*(from|import)\s+celery(\.|\s|$)", re.MULTILINE)
    violations: list[str] = []

    for root in (_PYTHON_RUNTIME_ROOT, _WORKER_APP_ROOT):
        for path in _iter_python_files(root):
            content = path.read_text(encoding="utf-8")
            if celery_import_pattern.search(content):
                violations.append(str(path.relative_to(_REPO_ROOT)))

    assert not violations, (
        "Expected full cutover to remove Celery imports from runtime modules. "
        f"Found Celery imports in: {violations}"
    )


def test_runtime_services_and_tasks_have_no_apply_async_dispatch():
    violations: list[str] = []

    for root in (_SERVICE_ROOT, _TASK_ROOT):
        for path in _iter_python_files(root):
            content = path.read_text(encoding="utf-8")
            if ".apply_async(" in content:
                violations.append(str(path.relative_to(_REPO_ROOT)))

    assert not violations, (
        "Expected queue dispatch to route through Postgres queue service only. "
        f"Found apply_async usage in: {violations}"
    )


def test_worker_entrypoint_no_longer_exposes_celery_beat_process():
    main_path = _WORKER_APP_ROOT / "main.py"
    content = main_path.read_text(encoding="utf-8")

    assert "celery_app" not in content, (
        "Expected worker entrypoint to stop exporting celery_app after cutover. "
        "Found celery_app symbol in apps/worker/main.py."
    )
    assert "celery -A" not in content, (
        "Expected worker entrypoint docs/comments to stop referencing celery CLI. "
        "Found celery CLI invocation in apps/worker/main.py."
    )


def test_backend_tests_do_not_patch_apply_async_dispatch():
    violations: list[str] = []

    for path in _iter_python_files(_TEST_ROOT):
        if path.name == "test_job_cutover_contract.py":
            continue
        content = path.read_text(encoding="utf-8")
        if "apply_async" in content:
            violations.append(str(path.relative_to(_REPO_ROOT)))

    assert not violations, (
        "Expected test suite to stop patching dead Celery apply_async seams. "
        f"Found apply_async references in: {violations}"
    )


def test_backend_tests_do_not_mock_postgres_enqueue_boundary():
    enqueue_patch_pattern = re.compile(
        r'(patch|monkeypatch\.setattr)\(\s*"(?:nexus\.services|nexus\.tasks)\.[^"]*enqueue_job'
    )
    violations: list[str] = []

    for path in _iter_python_files(_TEST_ROOT):
        if path.name == "test_job_cutover_contract.py":
            continue
        content = path.read_text(encoding="utf-8")
        if enqueue_patch_pattern.search(content):
            violations.append(str(path.relative_to(_REPO_ROOT)))

    assert not violations, (
        "Expected integration tests to assert real Postgres queue behavior instead of "
        "mocking enqueue_job seams. "
        f"Found enqueue_job mocks in: {violations}"
    )


def test_runtime_topology_files_have_no_redis_references():
    redis_pattern = re.compile(r"\bredis\b|REDIS_", re.IGNORECASE)
    violations: list[str] = []

    for path in _CUTOVER_TOPOLOGY_FILES:
        content = path.read_text(encoding="utf-8")
        if redis_pattern.search(content):
            violations.append(str(path.relative_to(_REPO_ROOT)))

    assert not violations, (
        "Expected full cutover runtime topology to remove Redis references from "
        "runtime and local topology docs/config. "
        f"Found Redis references in: {violations}"
    )


def test_project_dependencies_have_no_celery_or_redis_packages():
    pyproject = (_REPO_ROOT / "python" / "pyproject.toml").read_text(encoding="utf-8")

    assert "celery[" not in pyproject.lower(), (
        "Expected full cutover to remove Celery dependency from python/pyproject.toml."
    )
    assert re.search(r'^\s*"redis[<>=~!].*"$', pyproject, re.MULTILINE) is None, (
        "Expected full cutover to remove Redis dependency from python/pyproject.toml."
    )


def test_migration_suite_has_no_redis_connectivity_path():
    migration_tests = (_REPO_ROOT / "python" / "tests" / "test_migrations.py").read_text(
        encoding="utf-8"
    )

    assert "test_redis_connectivity" not in migration_tests, (
        "Expected migration test suite to remove Redis connectivity checks after cutover."
    )
    assert "from redis import Redis" not in migration_tests, (
        "Expected migration test suite to stop importing redis package after cutover."
    )


def test_legacy_celery_wording_removed_from_runtime_docs_and_comments():
    celery_wording = re.compile(r"\bCelery\b")
    violations: list[str] = []

    for path in _LEGACY_WORDING_FILES:
        content = path.read_text(encoding="utf-8")
        if celery_wording.search(content):
            violations.append(str(path.relative_to(_REPO_ROOT)))

    assert not violations, (
        "Expected legacy Celery-era wording to be removed from active docs/runtime comments. "
        f"Found references in: {violations}"
    )
