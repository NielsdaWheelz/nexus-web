from __future__ import annotations

import hashlib
import json
from pathlib import Path
from uuid import uuid4

import pytest

from nexus.config import Settings, clear_settings_cache
from nexus.job_topology import (
    BACKGROUND_WORKER_JOB_KINDS,
    INTERACTIVE_WORKER_JOB_KINDS,
    MAINTENANCE_JOB_KINDS,
)
from nexus.jobs.process_executor import (
    BackgroundProcessProtocolDefect,
    ChildDefect,
    ChildSucceeded,
    _bounded_result_bytes,
    _decode_result,
    _encode_request,
)
from nexus.jobs.queue import JobExecutionContext
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
        } == {
            "enrich_metadata",
            "ingest_media_source",
            "media_content_reindex_job",
        }
        reconciler = registry["reconcile_stale_ingest_media_job"]
        assert reconciler.periodic_priority < min(
            definition.periodic_priority
            for definition in registry.values()
            if definition.kind != reconciler.kind
        )
        metadata = registry["enrich_metadata"]
        assert (
            metadata.handler_path,
            metadata.resource_class,
            metadata.max_attempts,
            metadata.retry_delays_seconds,
            metadata.lease_seconds,
            metadata.child_runtime,
            metadata.failed_result_statuses,
            metadata.never_prune_dead,
        ) == (
            "nexus.jobs.registry:_run_enrich_metadata",
            "Heavy",
            2,
            (0,),
            300,
            "Llm",
            (),
            True,
        )

        payload = [
            {
                "kind": definition.kind,
                "max_attempts": definition.max_attempts,
                "retry_delays_seconds": list(definition.retry_delays_seconds),
                "lease_seconds": definition.lease_seconds,
                "resource_class": definition.resource_class,
                "handler_path": definition.handler_path,
                "wall_timeout_seconds": definition.wall_timeout_seconds,
                "resource_failure_projection": definition.resource_failure_projection,
                "child_runtime": definition.child_runtime,
                "periodic_priority": definition.periodic_priority,
                "child_exit_cleanup": definition.child_exit_cleanup,
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

        monkeypatch.setenv("NEXUS_ENV", "prod")
        monkeypatch.setenv("INGEST_RECONCILE_SCHEDULE_SECONDS", "0")
        with pytest.raises(
            ValueError,
            match="INGEST_RECONCILE_SCHEDULE_SECONDS must be > 0 in staging and prod",
        ):
            Settings()
    finally:
        # The synthetic environment is monkeypatched away at teardown; the cache
        # it poisoned would otherwise outlive this test in the same process.
        clear_settings_cache()


@pytest.mark.parametrize(
    "encoded",
    (
        b'{"version":2,"kind":"Succeeded","payload":{}}',
        b'{"version":1,"version":1,"kind":"Succeeded","payload":{}}',
        b'{"version":1,"kind":"Succeeded","payload":{},"extra":null}',
        b'{"version":1,"kind":"ModeledFailure","error_code":"E_RESOURCE_LIMIT",'
        b'"message":"bounded","resource_dimension":null}',
    ),
)
def test_background_child_result_protocol_rejects_noncanonical_values(encoded: bytes) -> None:
    with pytest.raises(BackgroundProcessProtocolDefect):
        _decode_result(encoded)


def test_background_child_result_protocol_is_exact_and_size_bounded() -> None:
    success = _decode_result(b'{"version":1,"kind":"Succeeded","payload":{"value":3}}')
    assert success == ChildSucceeded(payload={"value": 3})

    encoded = _bounded_result_bytes(
        {
            "version": 1,
            "kind": "Succeeded",
            "payload": {"value": "x" * 2048},
        },
        result_max_bytes=1024,
    )
    assert len(encoded) <= 1024
    assert _decode_result(encoded) == ChildDefect(
        error_type="ResultTooLarge",
        message="Background child result exceeded its closed protocol limit.",
    )


@pytest.mark.parametrize("constant", (float("nan"), float("inf"), float("-inf")))
def test_background_child_protocol_rejects_non_json_numeric_constants(constant: float) -> None:
    with pytest.raises(BackgroundProcessProtocolDefect, match="input is not JSON"):
        _encode_request(
            handler_path="tests.example:run",
            payload={"value": constant},
            context=JobExecutionContext(
                job_id=uuid4(),
                worker_id="strict-json-proof",
                attempt_no=1,
                resource_class="Light",
            ),
            oom_score_adj=750,
            result_max_bytes=1024,
            runtime="Base",
        )

    encoded = _bounded_result_bytes(
        {"version": 1, "kind": "Succeeded", "payload": {"value": constant}},
        result_max_bytes=1024,
    )
    assert _decode_result(encoded) == ChildDefect(
        error_type="ResultSerializationDefect",
        message="Background job result was not JSON serializable.",
    )

    for token in (b"NaN", b"Infinity", b"-Infinity"):
        with pytest.raises(BackgroundProcessProtocolDefect, match="non-JSON constant"):
            _decode_result(b'{"version":1,"kind":"Succeeded","payload":{"value":' + token + b"}}")
