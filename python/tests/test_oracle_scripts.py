"""Unit tests for Oracle operator scripts."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlsplit

import pytest

from nexus.errors import ApiError, ApiErrorCode
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


def test_plate_manifests_use_direct_bounded_upload_urls():
    script_manifest = json.loads((_REPO_ROOT / "scripts/oracle/manifest_plates.json").read_text())
    migration_manifest = json.loads(
        (_REPO_ROOT / "migrations/oracle_v1_seed/manifest_plates.json").read_text()
    )

    assert script_manifest == migration_manifest

    urls = [entry["resolved_source_url"] for entry in script_manifest]
    assert len(urls) == 36
    assert len(urls) == len(set(urls))
    for url in urls:
        parsed = urlsplit(url)
        assert parsed.scheme == "https"
        assert parsed.netloc == "upload.wikimedia.org"
        assert parsed.path.startswith("/wikipedia/commons/thumb/")
        assert "/1920px-" in parsed.path
        assert "Special:Redirect" not in url


def test_seed_plates_retries_transient_source_throttling(monkeypatch):
    script = _load_script(
        "oracle_seed_corpus_library_test",
        "scripts/oracle/seed_corpus_library.py",
    )
    entry = {
        "source_repository": "wikimedia_commons",
        "source_url": "https://commons.wikimedia.org/wiki/File:Plate.jpg",
        "resolved_source_url": "https://upload.wikimedia.org/wikipedia/commons/thumb/a/aa/Plate.jpg/1920px-Plate.jpg",
        "license_text": "public domain",
        "artist": "Artist",
        "work_title": "Plate",
        "year": "1900",
        "attribution_text": "Attribution",
        "tags": ["night"],
    }
    sleeps: list[float] = []
    fetches: list[str] = []
    upserts: list[dict] = []

    class Storage:
        def __init__(self):
            self.puts: list[tuple[str, bytes, str]] = []

        def head_object(self, key: str):
            return None

        def put_object(self, key: str, data: bytes, content_type: str) -> None:
            self.puts.append((key, data, content_type))

    storage = Storage()
    validated = SimpleNamespace(
        content_type="image/jpeg",
        data=b"image",
        width=1920,
        height=1200,
    )

    def fetch(resolved_source_url, client):
        fetches.append(resolved_source_url)
        if len(fetches) == 1:
            raise ApiError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Upstream returned status 429",
            )
        return validated

    def upsert(db, **kwargs):
        upserts.append(kwargs)
        return SimpleNamespace(id="plate-1")

    monkeypatch.setattr(script, "fetch_validated_image", fetch)
    monkeypatch.setattr(script.time, "sleep", lambda seconds: sleeps.append(seconds))
    monkeypatch.setattr(script.oracle_plates, "upsert_oracle_plate", upsert)

    script._seed_plates(object(), object(), storage, [entry])

    assert fetches == [entry["resolved_source_url"], entry["resolved_source_url"]]
    assert sleeps == [
        script.PLATE_FETCH_RETRY_BASE_SECONDS,
        script.PLATE_FETCH_SUCCESS_DELAY_SECONDS,
    ]
    assert storage.puts == [("oracle/plates/plate.jpg", b"image", "image/jpeg")]
    assert upserts[0]["source_url"] == entry["resolved_source_url"]
