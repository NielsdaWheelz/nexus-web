"""Unit tests for Oracle operator scripts."""

from __future__ import annotations

import importlib.util
from pathlib import Path
from types import SimpleNamespace

import pytest

from nexus.services.oracle_plates import OraclePlateStorageReadiness

pytestmark = pytest.mark.unit

_REPO_ROOT = Path(__file__).resolve().parents[2]


def _load_script(module_name: str, rel_path: str):
    spec = importlib.util.spec_from_file_location(module_name, _REPO_ROOT / rel_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _FakeSession:
    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        return False

    def commit(self) -> None:
        return None


def test_check_corpus_readiness_exits_zero_only_when_ready(monkeypatch, capsys):
    script = _load_script(
        "oracle_check_corpus_readiness_test",
        "scripts/oracle/check_corpus_readiness.py",
    )
    readiness = SimpleNamespace(
        status="ready",
        library_id="library-1",
        work_count=1,
        ready_media_count=1,
        anchor_count=1,
        resolved_anchor_count=1,
        plate_count=1,
        ready_plate_count=1,
    )
    plate_storage = OraclePlateStorageReadiness(total=1, valid=1, invalid=())

    monkeypatch.setattr(script, "get_session_factory", lambda: lambda: _FakeSession())
    monkeypatch.setattr(script, "get_storage_client", lambda: object())
    monkeypatch.setattr(
        script.oracle_corpus,
        "resolve_oracle_passage_anchors",
        lambda db: SimpleNamespace(resolved=1, total=1, failed=0),
    )
    monkeypatch.setattr(
        script.oracle_corpus,
        "get_oracle_corpus_readiness",
        lambda db: readiness,
    )
    monkeypatch.setattr(
        script.oracle_plates,
        "validate_oracle_plate_storage_objects",
        lambda db, *, storage_client: plate_storage,
    )

    assert script.main() == 0
    assert "corpus ready" in capsys.readouterr().out

    readiness.status = "not_ready"
    assert script.main() == 1
    readiness.status = "ready"

    plate_storage = OraclePlateStorageReadiness(
        total=1,
        valid=0,
        invalid=("missing oracle/plates/x.jpg",),
    )
    assert script.main() == 1
    assert "plate object invalid: missing oracle/plates/x.jpg" in capsys.readouterr().out
