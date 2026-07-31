from __future__ import annotations

import hashlib
import json
from datetime import date
from pathlib import Path
from typing import Any

import pytest

from nexus_test_control.model import PRIORITY_RISK_FLOOR
from nexus_test_control.policy import (
    corpus_manifest_schema_violations,
    corpus_violations,
    exception_violations,
    fault_manifest_violations,
    proof_contract_violations,
    proof_manifest_schema_violations,
    python_ast_violations,
    repository_violations,
)

REPO_ROOT = Path(__file__).parents[4]


def _write(root: Path, relative: str, content: str) -> Path:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


def _dump(root: Path, relative: str, value: Any) -> None:
    _write(root, relative, json.dumps(value, indent=2) + "\n")


def _rules(violations: tuple[Any, ...]) -> set[str]:
    return {violation.rule for violation in violations}


@pytest.mark.parametrize(
    ("source", "rule"),
    [
        ("from unittest.mock import patch\n", "python-internal-mock"),
        (
            "import nexus.services.reader as owner\n"
            "monkeypatch.setattr(owner, 'read', lambda: None)\n",
            "python-owned-monkeypatch",
        ),
        ("import time\ntime.sleep(1)\n", "python-sleep"),
        ("import pytest\n@pytest.mark.skip\ndef test_case(): pass\n", "python-skip"),
        ("import pytest as pt\n@pt.mark.skip\ndef test_case(): pass\n", "python-skip"),
        ("from pytest import mark as m\n@m.xfail\ndef test_case(): pass\n", "python-skip"),
        ("import pytest\npytestmark = pytest.mark.skip\n", "python-skip"),
        ("def test_case(): pass\n", "python-vacuous-proof"),
        ("def test_case():\n    return\n", "python-vacuous-proof"),
        ('def test_case():\n    """Only words."""\n', "python-vacuous-proof"),
        (
            "import pytest\n@pytest.mark.network\ndef test_case(): pass\n",
            "python-unregistered-marker",
        ),
        (
            "from pytest_socket import enable_socket\nenable_socket()\n",
            "python-network-enablement",
        ),
        (
            "from sqlalchemy import text\ntext('INSERT INTO users DEFAULT VALUES')\n",
            "python-raw-sql",
        ),
    ],
)
def test_python_ast_guard_rejects_each_mechanical_violation(source: str, rule: str) -> None:
    assert rule in _rules(python_ast_violations("python/tests/kernel/test_bad.py", source))


def test_python_ast_guard_rejects_invalid_source() -> None:
    assert _rules(python_ast_violations("python/tests/kernel/test_bad.py", "def broken(")) == {
        "python-syntax"
    }


def test_python_ast_guard_allows_external_boundary_patch_and_owned_exceptions() -> None:
    external_patch = "import httpx\nmonkeypatch.setattr(httpx, 'get', lambda: None)\n"
    hosted_socket = "from pytest_socket import enable_socket\nenable_socket()\n"
    query_oracle = "from sqlalchemy import text\ntext('SELECT 1')\n"
    migration_sql = "from sqlalchemy import text\ntext('INSERT INTO users DEFAULT VALUES')\n"
    assert not python_ast_violations("python/tests/kernel/test_ok.py", external_patch)
    assert not python_ast_violations("python/tests/service/test_query_oracle.py", query_oracle)
    assert not python_ast_violations("python/tests/hosted/test_provider.py", hosted_socket)
    assert not python_ast_violations("python/tests/migrations/test_head.py", migration_sql)


def _minimal_repository(root: Path) -> None:
    normative = (
        "docs/local-rules/testing-standards.md",
        "docs/local-rules/index.md",
        "docs/local-rules/codebase.md",
        "docs/rules/boundaries.md",
        "docs/rules/cleanliness.md",
        "docs/rules/codebase.md",
        "docs/rules/correctness.md",
        "docs/rules/database.md",
        "docs/rules/overrides.md",
        "docs/rules/retries.md",
        "docs/rules/simplicity.md",
        "docs/rules/testing.md",
        "docs/rules/timing.md",
    )
    for relative in normative:
        content = "# owner\n"
        if relative == "docs/local-rules/index.md":
            content += "[Testing](testing-standards.md)\n"
        _write(root, relative, content)
    _write(
        root,
        "python/pyproject.toml",
        '[tool.pytest.ini_options]\nfilterwarnings = ["error::UserWarning"]\n',
    )
    _write(root, "apps/web/e2e/playwright.config.ts", "export default { workers: 1, retries: 0 }\n")
    _write(
        root,
        "scripts/test",
        "exec uv run --frozen --no-sync python -m nexus_test_control\n",
    )
    _write(root, "scripts/agency_verify.sh", "exec ./scripts/test confidence\n")
    _write(
        root,
        "scripts/agency_setup.sh",
        "uv sync --all-extras --locked\nbun install --frozen-lockfile\n",
    )
    _write(
        root,
        ".github/workflows/ci.yml",
        "run: ./scripts/test pr\nif: always()\n",
    )
    _write(
        root,
        ".github/workflows/nightly.yml",
        'NEXUS_HOSTED_CANARY: "1"\nscript: ./scripts/test nightly\n',
    )
    _write(
        root,
        ".github/workflows/release.yml",
        'NEXUS_PROVIDER_CERTIFICATION: "1"\nscript: ./scripts/test release\n',
    )
    _write(
        root,
        "docs/local-rules/codebase.md",
        "typed test control plane\napps/web/e2e/\ntestdata/\n",
    )
    _write(
        root,
        "docs/local-rules/testing-standards.md",
        "./scripts/test confidence\n./scripts/test prove\n"
        "## 11. Local test-runtime safety\nnexus-run-<run-id>\n",
    )
    for relative in ("README.md", "python/README.md", "apps/web/README.md"):
        _write(
            root,
            relative,
            "./scripts/test changed\n./scripts/test confidence\n./scripts/test pr\n",
        )
    _write(
        root,
        "docs/architecture.md",
        "./scripts/test\ntesting-standards.md\napps/web/e2e/\n",
    )
    _write(root, ".env.example", "NEXUS_ENV=local\n")


def test_repository_guard_rejects_legacy_route_resurrection(tmp_path: Path) -> None:
    _minimal_repository(tmp_path)
    _write(tmp_path, "scripts/test_env.sh", "export DATABASE_URL_TEST=unsafe\n")

    assert "repository-retired-test-path" in _rules(repository_violations(tmp_path))


def test_repository_guard_rejects_route_drift(tmp_path: Path) -> None:
    _minimal_repository(tmp_path)
    _write(tmp_path, "scripts/agency_verify.sh", "exec make test\n")

    assert "repository-route-contract" in _rules(repository_violations(tmp_path))


def test_repository_guard_rejects_documented_legacy_route(tmp_path: Path) -> None:
    _minimal_repository(tmp_path)
    _write(tmp_path, "README.md", "./scripts/test changed\nmake test-e2e\n")

    assert "repository-route-contract" in _rules(repository_violations(tmp_path))


def test_repository_contract_accepts_bounded_single_owner(tmp_path: Path) -> None:
    _minimal_repository(tmp_path)
    assert not repository_violations(tmp_path)


def test_repository_guard_rejects_unbounded_workers(tmp_path: Path) -> None:
    _minimal_repository(tmp_path)
    _write(tmp_path, "Makefile", "test:\n\tpytest -n auto\n")
    assert "repository-worker-cap" in _rules(repository_violations(tmp_path))


def test_repository_guard_rejects_automatic_retry(tmp_path: Path) -> None:
    _minimal_repository(tmp_path)
    _write(
        root=tmp_path,
        relative="apps/web/e2e/playwright.config.ts",
        content="export default { retries: 1 }\n",
    )
    assert "repository-automatic-retry" in _rules(repository_violations(tmp_path))


def test_repository_guard_rejects_second_playwright_owner(tmp_path: Path) -> None:
    _minimal_repository(tmp_path)
    _write(tmp_path, "e2e/playwright.config.ts", "export default {}\n")
    assert "repository-playwright-owner" in _rules(repository_violations(tmp_path))


def test_repository_guard_rejects_weak_warning_policy(tmp_path: Path) -> None:
    _minimal_repository(tmp_path)
    _write(tmp_path, "python/pyproject.toml", "[tool.pytest.ini_options]\nfilterwarnings = []\n")
    assert "repository-warning-policy" in _rules(repository_violations(tmp_path))


def test_repository_guard_rejects_missing_normative_owner(tmp_path: Path) -> None:
    _minimal_repository(tmp_path)
    (tmp_path / "docs/rules/timing.md").unlink()
    assert "repository-normative-link" in _rules(repository_violations(tmp_path))


def test_repository_guard_rejects_broken_normative_link(tmp_path: Path) -> None:
    _minimal_repository(tmp_path)
    _write(tmp_path, "docs/rules/timing.md", "[Missing](does-not-exist.md)\n")

    violations = repository_violations(tmp_path)

    assert any(
        violation.rule == "repository-normative-link"
        and violation.path == "docs/rules/timing.md"
        and violation.line == 1
        for violation in violations
    )


def _complete_proof_repository(root: Path) -> dict[str, Any]:
    risks: list[dict[str, Any]] = []
    risk_ids = sorted(risk.value for risk in PRIORITY_RISK_FLOOR)
    for index, risk_id in enumerate(risk_ids):
        source = f"src/owner_{index}.py"
        proof_path = f"python/tests/kernel/test_risk_{index}.py"
        _write(root, source, "OWNER = True\n")
        _write(root, proof_path, "def test_risk():\n    assert owner_behavior()\n")
        risks.append(
            {
                "id": risk_id,
                "source_globs": [source],
                "proofs": [f"pytest:{proof_path}::test_risk"],
                "capabilities": ["kernel-python"],
            }
        )
    journey_ids = (
        "auth-session",
        "durable-ingest-reader-open",
        "highlight-note-provenance",
        "reader-progress-resume",
        "grounded-chat-citation",
        "resource-share-boundary",
        "nexus-search-open-restore",
        "podcast-refresh-playback",
        "destructive-delete",
        "daily-page-capture",
    )
    journeys: list[dict[str, Any]] = []
    for index, journey_id in enumerate(journey_ids):
        proof = f"apps/web/e2e/journeys/{journey_id}.journey.spec.ts"
        source = f"src/journey_owner_{index}.tsx"
        _write(root, proof, "// journey\n")
        _write(root, source, "export const owner = true;\n")
        journeys.append(
            {
                "id": journey_id,
                "proof": proof,
                "risks": [risk_ids[index % len(risk_ids)]],
                "source_globs": [source],
            }
        )
    manifest = {"version": 1, "priority_risks": risks, "journeys": journeys}
    _dump(root, "testdata/proofs.json", manifest)
    return manifest


def test_priority_floor_and_journey_inventory_are_complete() -> None:
    assert not proof_manifest_schema_violations(REPO_ROOT)
    assert not proof_contract_violations(REPO_ROOT)


def test_populated_proof_inventory_has_valid_paths_and_owners(tmp_path: Path) -> None:
    _complete_proof_repository(tmp_path)
    assert not proof_contract_violations(tmp_path)


def test_proof_schema_rejects_risk_floor_deletion(tmp_path: Path) -> None:
    manifest = _complete_proof_repository(tmp_path)
    manifest["priority_risks"].pop()
    _dump(tmp_path, "testdata/proofs.json", manifest)
    assert "proof-risk-floor" in _rules(proof_manifest_schema_violations(tmp_path))


def test_proof_schema_rejects_unknown_capability(tmp_path: Path) -> None:
    manifest = _complete_proof_repository(tmp_path)
    manifest["priority_risks"][0]["capabilities"] = ["wishful"]
    _dump(tmp_path, "testdata/proofs.json", manifest)
    assert "proof-schema" in _rules(proof_manifest_schema_violations(tmp_path))


@pytest.mark.parametrize(
    ("mutation", "rule"),
    [
        ("missing-source", "proof-source-owner"),
        ("missing-journey-source", "proof-source-owner"),
        ("missing-proof", "proof-node"),
        ("duplicate-proof", "proof-unique-owner"),
        ("too-few-journeys", "proof-journey-cap"),
        ("missing-required-journey", "proof-required-journeys"),
    ],
)
def test_complete_proof_guard_rejects_broken_ownership(
    tmp_path: Path, mutation: str, rule: str
) -> None:
    manifest = _complete_proof_repository(tmp_path)
    if mutation == "missing-source":
        manifest["priority_risks"][0]["source_globs"] = ["src/missing.py"]
    elif mutation == "missing-journey-source":
        manifest["journeys"][0]["source_globs"] = ["src/missing-journey.tsx"]
    elif mutation == "missing-proof":
        manifest["priority_risks"][0]["proofs"] = ["pytest:python/tests/kernel/missing.py::test"]
    elif mutation == "duplicate-proof":
        manifest["priority_risks"][1]["proofs"] = manifest["priority_risks"][0]["proofs"]
    elif mutation == "too-few-journeys":
        manifest["journeys"].pop()
    else:
        for journey in manifest["journeys"]:
            if journey["id"] == "nexus-search-open-restore":
                journey["id"] = "invented-journey"
                break
    _dump(tmp_path, "testdata/proofs.json", manifest)
    assert rule in _rules(proof_contract_violations(tmp_path))


def _corpus_repository(root: Path, content: bytes = b"canonical fixture\n") -> dict[str, Any]:
    path = root / "testdata/corpus/sample.txt"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    artifact = {
        "path": "testdata/corpus/sample.txt",
        "sha256": hashlib.sha256(content).hexdigest(),
        "source": "Repository-authored case",
        "license": "Repository-owned test data",
        "purpose": ["Policy self-test"],
    }
    manifest = {"version": 1, "artifacts": [artifact]}
    _dump(root, "testdata/manifest.json", manifest)
    return manifest


def test_inert_corpus_manifest_schema_is_valid() -> None:
    assert not corpus_manifest_schema_violations(REPO_ROOT)


def test_corpus_contract_accepts_manifested_fixture(tmp_path: Path) -> None:
    _corpus_repository(tmp_path)
    assert not corpus_violations(tmp_path)


@pytest.mark.parametrize(
    ("mutation", "rule"),
    [
        ("schema", "corpus-schema"),
        ("path", "corpus-path"),
        ("provenance", "corpus-provenance"),
        ("checksum", "corpus-checksum"),
        ("secret", "corpus-secret"),
        ("unmanifested", "corpus-unmanifested"),
        ("duplicate", "corpus-duplicate-content"),
    ],
)
def test_corpus_guard_rejects_each_manifest_violation(
    tmp_path: Path, mutation: str, rule: str
) -> None:
    manifest = _corpus_repository(tmp_path)
    if mutation == "schema":
        manifest["version"] = 2
    elif mutation == "path":
        manifest["artifacts"][0]["path"] = "/tmp/sample.txt"
    elif mutation == "provenance":
        manifest["artifacts"][0]["source"] = ""
    elif mutation == "checksum":
        manifest["artifacts"][0]["sha256"] = "0" * 64
    elif mutation == "secret":
        secret = b"sk_abcdefghijklmnopqrstuvwxyz012345\n"
        (tmp_path / "testdata/corpus/sample.txt").write_bytes(secret)
        manifest["artifacts"][0]["sha256"] = hashlib.sha256(secret).hexdigest()
    elif mutation == "unmanifested":
        _write(tmp_path, "testdata/corpus/extra.txt", "extra\n")
    else:
        duplicate = b"canonical fixture\n"
        (tmp_path / "testdata/corpus/copy.txt").write_bytes(duplicate)
        copy = dict(manifest["artifacts"][0])
        copy["path"] = "testdata/corpus/copy.txt"
        manifest["artifacts"].append(copy)
    _dump(tmp_path, "testdata/manifest.json", manifest)
    assert rule in _rules(corpus_violations(tmp_path))


@pytest.mark.parametrize(
    "relative",
    [
        "python/tests/fixtures/book.epub",
        "python/tests/fixtures/real_media/captured.json",
        "python/tests/fixtures/reader_apparatus/gold_graphs/article.json",
        "python/tests/fixtures/reader_apparatus/html/article-full.html",
        "python/tests/fixtures/reader_apparatus/tei/article.xml",
    ],
)
def test_corpus_guard_requires_captured_and_binary_fixtures(tmp_path: Path, relative: str) -> None:
    _corpus_repository(tmp_path)
    _write(tmp_path, relative, f"fixture at {relative}\n")
    assert "corpus-unmanifested" in _rules(corpus_violations(tmp_path))


@pytest.mark.parametrize(
    "relative",
    [
        "python/tests/fixtures/large_authored_cases.json",
        "python/tests/fixtures/reader_apparatus/corpus_manifest.json",
        "python/tests/fixtures/reader_apparatus/html/minimal-pattern.html",
    ],
)
def test_corpus_guard_ignores_language_local_authored_text(tmp_path: Path, relative: str) -> None:
    _corpus_repository(tmp_path)
    _write(tmp_path, relative, "authored fixture\n" * 400)
    assert not corpus_violations(tmp_path)


def test_corpus_guard_leaves_fault_patches_to_the_fault_manifest(tmp_path: Path) -> None:
    _corpus_repository(tmp_path)
    _write(tmp_path, "testdata/faults/defect.patch", "targeted fault\n")
    assert not corpus_violations(tmp_path)


def _exception(rule: str = "quarantine") -> dict[str, str]:
    return {
        "rule": rule,
        "path": "python/tests/kernel/test_example.py",
        "node": "pytest:python/tests/kernel/test_example.py::test_example",
        "reason": "Current defect",
        "expires_on": "2099-01-01",
        "replacement": "pytest:python/tests/kernel/test_replacement.py::test_replacement",
    }


def test_empty_exception_manifest_is_valid() -> None:
    assert not exception_violations(REPO_ROOT, date(2026, 7, 31))


@pytest.mark.parametrize(
    ("mutation", "rule"),
    [
        ("schema", "exception-schema"),
        ("target", "exception-exact-target"),
        ("expired", "exception-expired"),
        ("duplicate", "exception-duplicate"),
    ],
)
def test_exception_guard_rejects_each_violation(tmp_path: Path, mutation: str, rule: str) -> None:
    _write(tmp_path, "python/tests/kernel/test_example.py", "def test_example(): pass\n")
    item = _exception()
    exceptions: list[dict[str, str]] = [item]
    if mutation == "schema":
        item.pop("replacement")
    elif mutation == "target":
        item["path"] = "python/tests/**/*.py"
    elif mutation == "expired":
        item["expires_on"] = "2020-01-01"
    else:
        exceptions.append(dict(item))
    _dump(tmp_path, "testdata/policy-exceptions.json", {"version": 1, "exceptions": exceptions})
    assert rule in _rules(exception_violations(tmp_path, date(2026, 7, 31)))


def _fault_repository(root: Path) -> dict[str, Any]:
    patch = b"diff --git a/python/nexus/owner.py b/python/nexus/owner.py\n"
    path = root / "testdata/faults/example.patch"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(patch)
    fault = {
        "id": "example-fault",
        "patch": "testdata/faults/example.patch",
        "sha256": hashlib.sha256(patch).hexdigest(),
        "proofs": ["pytest:python/tests/kernel/test_example.py::test_example"],
        "expected_failure": "expected value differs",
    }
    manifest = {"version": 1, "faults": [fault]}
    _dump(root, "testdata/faults/manifest.json", manifest)
    return manifest


def test_empty_fault_manifest_is_valid() -> None:
    assert not fault_manifest_violations(REPO_ROOT)


@pytest.mark.parametrize(
    ("mutation", "rule"),
    [
        ("schema", "fault-schema"),
        ("path", "fault-path"),
        ("checksum", "fault-checksum"),
        ("unmanifested", "fault-unmanifested"),
        ("harness-target", "fault-product-only"),
        ("empty-patch", "fault-patch"),
    ],
)
def test_fault_guard_rejects_each_violation(tmp_path: Path, mutation: str, rule: str) -> None:
    manifest = _fault_repository(tmp_path)
    if mutation == "schema":
        manifest["faults"][0]["id"] = "Not A Slug"
    elif mutation == "path":
        manifest["faults"][0]["patch"] = "outside.patch"
    elif mutation == "checksum":
        manifest["faults"][0]["sha256"] = "0" * 64
    elif mutation == "unmanifested":
        manifest["faults"] = []
    else:
        patch = (
            b""
            if mutation == "empty-patch"
            else b"diff --git a/python/tests/test_owner.py b/python/tests/test_owner.py\n"
        )
        (tmp_path / "testdata/faults/example.patch").write_bytes(patch)
        manifest["faults"][0]["sha256"] = hashlib.sha256(patch).hexdigest()
    _dump(tmp_path, "testdata/faults/manifest.json", manifest)
    assert rule in _rules(fault_manifest_violations(tmp_path))
