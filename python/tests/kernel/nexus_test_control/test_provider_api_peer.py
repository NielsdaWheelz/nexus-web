from __future__ import annotations

import base64
import ipaddress
import json
import socket
import ssl
from pathlib import Path

import httpx
import pytest
from cryptography import x509

RUN_ID = "0123456789abcdef"
RECOVERY_RUN_ID = "fedcba9876543210"
TEST_ENV = {"NEXUS_ENV": "test"}


def _available_port(excluded: set[int]) -> int:
    while True:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.bind(("127.0.0.1", 0))
            port = int(probe.getsockname()[1])
        if port not in excluded:
            return port


def test_provider_peer_is_controller_owned_and_recovered(
    tmp_path: Path,
) -> None:
    from nexus_test_control.model import ResourceKind

    provider_kind = getattr(ResourceKind, "PROVIDER_API_PEER", None)
    assert provider_kind is not None, "the provider API peer has no controller resource owner"

    from nexus_test_control.model import Resource
    from nexus_test_control.policy import repository_violations
    from nexus_test_control.runtime import (
        EndpointKind,
        ResourcePhase,
        RuntimeContractError,
        RuntimePorts,
        claim_run,
        cleanup_candidates,
        forget_cleaned,
        initialize_runtime,
        provider_api_peer_identity,
        read_ledger,
        read_runtime,
        record_created,
        record_planned,
        run_bucket_name,
        run_database_name,
        runtime_endpoint,
    )
    from nexus_test_control.services import (
        PROVIDER_API_NAMES,
        TEST_GENERATION_CONTINUATION_ENCRYPTION_KEY,
        TEST_PROVIDER_API_CREDENTIALS,
        SupabaseCredentials,
        TestRun,
        _database_url,
        clean_run,
        materialize_provider_api_peer,
        prepare_provider_api_peer_state,
        run_environment,
        start_python_process,
        test_environment,
        wait_process_ready,
    )

    source_python = Path(__file__).resolve().parents[3]
    source_root = source_python.parent
    fixture_seam_violations = tuple(
        violation
        for violation in repository_violations(source_root)
        if violation.rule == "repository-product-test-seam"
        and any(
            token in violation.message
            for token in ("GENERATION_API_BASE_URLS", "PROVIDER_API_PEER")
        )
    )
    assert fixture_seam_violations == ()
    (tmp_path / "python").symlink_to(source_python, target_is_directory=True)
    fixed_ports = list(range(21_001, 21_013))
    provider_port = _available_port(set(fixed_ports))
    initialize_runtime(tmp_path, TEST_ENV, RuntimePorts(*fixed_ports, provider_port))
    claim_run(tmp_path, TEST_ENV, RUN_ID)
    for resource in (
        Resource(ResourceKind.RUN_DATABASE, run_database_name(RUN_ID)),
        Resource(ResourceKind.BUCKET, run_bucket_name(RUN_ID)),
    ):
        record_planned(tmp_path, TEST_ENV, RUN_ID, resource)
        record_created(tmp_path, TEST_ENV, RUN_ID, resource)
    run = TestRun(
        run_id=RUN_ID,
        database_url=_database_url(tmp_path, TEST_ENV, run_database_name(RUN_ID)),
        migration_database_url=None,
        bucket=run_bucket_name(RUN_ID),
        supabase=SupabaseCredentials(
            runtime_endpoint(tmp_path, TEST_ENV, EndpointKind.SUPABASE),
            "public-anon-key",
            "fixture-admin-key",
        ),
    )

    unconfigured_environment = run_environment(tmp_path, TEST_ENV, run)
    assert unconfigured_environment["GENERATION_API_PROVIDERS"] == ""
    assert "GENERATION_API_BASE_URLS" not in unconfigured_environment
    assert "GENERATION_CONTINUATION_ENCRYPTION_KEY" not in unconfigured_environment
    assert not set(TEST_PROVIDER_API_CREDENTIALS).intersection(unconfigured_environment)

    peer = materialize_provider_api_peer(tmp_path, TEST_ENV, run)
    matching = [
        entry
        for entry in read_ledger(tmp_path, RUN_ID).entries
        if entry.resource == Resource(provider_kind, provider_api_peer_identity(RUN_ID))
    ]
    assert len(matching) == 1 and matching[0].phase is ResourcePhase.CREATED
    assert peer.port == provider_port
    assert peer.key.stat().st_mode & 0o777 == 0o600
    assert peer.audit.stat().st_mode & 0o777 == 0o600
    certificate = x509.load_pem_x509_certificate(peer.certificate.read_bytes())
    alternative_names = certificate.extensions.get_extension_for_class(
        x509.SubjectAlternativeName
    ).value
    assert ipaddress.ip_address("127.0.0.1") in alternative_names.get_values_for_type(
        x509.IPAddress
    )

    owned_environment = run_environment(tmp_path, TEST_ENV, run)
    expected_origin = f"https://127.0.0.1:{provider_port}"
    provider_candidate = next(
        candidate
        for candidate in cleanup_candidates(tmp_path, TEST_ENV, RUN_ID)
        if candidate.resource.kind is provider_kind
    )
    assert provider_candidate.endpoint == expected_origin
    assert owned_environment["GENERATION_API_PROVIDERS"] == ",".join(PROVIDER_API_NAMES)
    assert json.loads(owned_environment["GENERATION_API_BASE_URLS"]) == {
        provider: expected_origin for provider in PROVIDER_API_NAMES
    }
    assert {
        key: owned_environment[key] for key in TEST_PROVIDER_API_CREDENTIALS
    } == TEST_PROVIDER_API_CREDENTIALS
    assert owned_environment["GENERATION_CONTINUATION_ENCRYPTION_KEY"] == (
        TEST_GENERATION_CONTINUATION_ENCRYPTION_KEY
    )
    assert owned_environment["NEXUS_FABLE_RETENTION_ACCEPTED_AT"] == ("2026-08-31T00:00:00Z")
    assert len(base64.b64decode(TEST_GENERATION_CONTINUATION_ENCRYPTION_KEY, validate=True)) == 32
    assert json.loads(owned_environment["NEXUS_TEST_TLS_CA_CERTS"]) == [str(peer.certificate)]
    with pytest.raises(RuntimeContractError, match="caller resource configuration"):
        test_environment({"GENERATION_API_BASE_URLS": ""})

    for resource in (
        Resource(ResourceKind.RUN_DATABASE, run_database_name(RUN_ID)),
        Resource(ResourceKind.BUCKET, run_bucket_name(RUN_ID)),
    ):
        forget_cleaned(tmp_path, TEST_ENV, RUN_ID, resource)

    process = None
    try:
        process = start_python_process(tmp_path, TEST_ENV, run, "provider-api-peer")
        wait_process_ready(
            tmp_path,
            TEST_ENV,
            process,
            EndpointKind.PROVIDER_API,
            "/livez",
            tls_ca=peer.certificate,
        )
        tls_context = ssl.create_default_context(cafile=str(peer.certificate))
        with httpx.Client(verify=tls_context, trust_env=False) as client:
            response = client.get(f"{expected_origin}/livez")
        assert response.status_code == 200
        assert response.json() == {
            "providers": list(PROVIDER_API_NAMES),
            "status": "alive",
        }
    finally:
        if RUN_ID in read_runtime(tmp_path).owned_run_ids:
            clean_run(tmp_path, TEST_ENV, RUN_ID)

    assert not peer.state.exists()
    assert RUN_ID not in read_runtime(tmp_path).owned_run_ids

    claim_run(tmp_path, TEST_ENV, RECOVERY_RUN_ID)
    interrupted = TestRun(
        RECOVERY_RUN_ID,
        "unused",
        None,
        "unused",
        SupabaseCredentials("unused", "unused", "unused"),
    )
    partial_state = prepare_provider_api_peer_state(tmp_path, TEST_ENV, interrupted)
    (partial_state / "requests.jsonl").write_text("partial\n", encoding="utf-8")

    clean_run(tmp_path, TEST_ENV, RECOVERY_RUN_ID)

    assert not partial_state.exists()
    assert RECOVERY_RUN_ID not in read_runtime(tmp_path).owned_run_ids
