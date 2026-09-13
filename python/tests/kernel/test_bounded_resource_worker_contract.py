from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from nexus.config import Settings, clear_settings_cache
from nexus.job_topology import (
    BACKGROUND_WORKER_JOB_KINDS,
    INTERACTIVE_WORKER_JOB_KINDS,
    MAINTENANCE_JOB_KINDS,
)
from nexus.jobs.registry import get_default_registry, get_task_contract_digest


def test_worker_topology_and_task_digest_cover_resource_class(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(
        "DATABASE_URL",
        "postgresql+psycopg://127.0.0.1:54320/nexus",
    )
    monkeypatch.setenv("SUPABASE_JWKS_URL", "http://127.0.0.1:54321/auth/v1/.well-known/jwks.json")
    monkeypatch.setenv("SUPABASE_ISSUER", "http://127.0.0.1:54321/auth/v1")
    monkeypatch.setenv("SUPABASE_AUDIENCES", "authenticated")
    clear_settings_cache()
    try:
        registry = get_default_registry()
        interactive = set(INTERACTIVE_WORKER_JOB_KINDS)
        background = set(BACKGROUND_WORKER_JOB_KINDS)
        maintenance = set(MAINTENANCE_JOB_KINDS)

        assert not interactive & background
        assert not interactive & maintenance
        assert not background & maintenance
        assert interactive | background | maintenance == set(registry)
        assert "ingest_media_source" not in interactive
        assert "ingest_media_source" in background
        assert {
            definition.kind
            for definition in registry.values()
            if definition.resource_class == "Heavy"
        } == {"ingest_media_source", "media_content_reindex_job"}

        payload = [
            {
                "kind": definition.kind,
                "max_attempts": definition.max_attempts,
                "retry_delays_seconds": list(definition.retry_delays_seconds),
                "lease_seconds": definition.lease_seconds,
                "resource_class": definition.resource_class,
            }
            for definition in sorted(registry.values(), key=lambda item: item.kind)
        ]
        expected = hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()
        assert get_task_contract_digest() == expected

        monkeypatch.setenv("PARSER_TEMP_ROOT", "relative/parser-temp")
        with pytest.raises(ValueError, match="PARSER_TEMP_ROOT must be an absolute path"):
            Settings()
        monkeypatch.setenv("PARSER_TEMP_ROOT", "/tmp/nexus-test-parser-temp")
        assert Settings().parser_temp_root == Path("/tmp/nexus-test-parser-temp")
    finally:
        # The synthetic environment is monkeypatched away at teardown; the cache
        # it poisoned would otherwise outlive this test in the same process.
        clear_settings_cache()
