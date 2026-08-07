import base64
import hashlib
import json
import os
import signal
import socket
import subprocess
import sys
import threading
from dataclasses import replace
from pathlib import Path

import httpx
import pytest

import nexus_test_control.services as services
from nexus_test_control.build import StandaloneBuild
from nexus_test_control.model import Resource, ResourceKind
from nexus_test_control.runtime import (
    EndpointKind,
    RuntimeContractError,
    RuntimePorts,
    claim_run,
    extension_profile_identity,
    initialize_runtime,
    migration_database_name,
    process_resource_identity,
    read_ledger,
    record_created,
    record_planned,
    run_bucket_name,
    run_database_name,
)
from nexus_test_control.services import (
    TEST_EXTENSION_ID,
    TEST_EXTENSION_PUBLIC_KEY,
    SupabaseCredentials,
    _database_url,
    _parse_supabase_status,
    _start_owned_process,
    _startup_identity_pending,
    _supabase_credentials_from_status,
    _write_supabase_config,
    clean_owned_runtime,
    clean_run,
    new_run_id,
    run_environment,
    start_python_process,
    start_web_process,
    wait_process_ready,
)
from nexus_test_control.services import TestRun as OwnedRun
from nexus_test_control.services import (
    TestUser as ScenarioUser,
)
from nexus_test_control.services import (
    test_environment as local_test_environment,
)

TEST_ENV = {"NEXUS_ENV": "test"}
RUN_ID = "0123456789abcdef"


def _ports() -> RuntimePorts:
    return RuntimePorts(15432, 19000, 25421, 25422, 25423, 25424, 25425, 18000, 13000, 19091)


def _owned_run(tmp_path: Path, *, migration: bool = True) -> OwnedRun:
    initialize_runtime(tmp_path, TEST_ENV, _ports())
    claim_run(tmp_path, TEST_ENV, RUN_ID)
    resources = [
        Resource(ResourceKind.RUN_DATABASE, run_database_name(RUN_ID)),
        Resource(ResourceKind.BUCKET, run_bucket_name(RUN_ID)),
    ]
    if migration:
        resources.append(Resource(ResourceKind.MIGRATION_DATABASE, migration_database_name(RUN_ID)))
    for resource in resources:
        record_planned(tmp_path, TEST_ENV, RUN_ID, resource)
        record_created(tmp_path, TEST_ENV, RUN_ID, resource)
    return OwnedRun(
        run_id=RUN_ID,
        database_url=_database_url(tmp_path, TEST_ENV, run_database_name(RUN_ID)),
        migration_database_url=(
            _database_url(tmp_path, TEST_ENV, migration_database_name(RUN_ID))
            if migration
            else None
        ),
        bucket=run_bucket_name(RUN_ID),
        supabase=SupabaseCredentials(
            "http://127.0.0.1:25421",
            "public-anon-key",
            "must-not-escape",
        ),
    )


def test_run_ids_are_exact_opaque_test_ownership_ids() -> None:
    first = new_run_id()
    second = new_run_id()

    assert len(first) == 16
    assert int(first, 16) >= 0
    assert first != second


def test_owned_process_unblocks_sigterm_before_exec_and_stops_gracefully(
    tmp_path: Path,
) -> None:
    initialize_runtime(tmp_path, TEST_ENV, _ports())
    claim_run(tmp_path, TEST_ENV, RUN_ID)
    mask_path = tmp_path / "signal-mask.txt"
    script = (
        "import pathlib, signal, sys; "
        "mask = signal.pthread_sigmask(signal.SIG_BLOCK, set()); "
        "pathlib.Path(sys.argv[1]).write_text(str(signal.SIGTERM in mask)); "
        "signal.pause()"
    )
    started = _start_owned_process(
        tmp_path,
        TEST_ENV,
        RUN_ID,
        "api",
        (sys.executable, "-c", script, str(mask_path)),
        cwd=tmp_path,
        process_environment={"NEXUS_TEST_RUN_ID": RUN_ID},
    )
    try:
        for _attempt in range(500):
            if mask_path.is_file():
                break
            threading.Event().wait(0.01)
        assert mask_path.read_text(encoding="utf-8") == "False"

        clean_run(tmp_path, TEST_ENV, RUN_ID)

        with pytest.raises(ProcessLookupError):
            os.kill(started.process_group_id, 0)
    finally:
        try:
            os.killpg(started.process_group_id, signal.SIGKILL)
        except ProcessLookupError:
            pass


def test_clean_recovers_a_process_killed_between_spawn_and_created_record(
    tmp_path: Path,
) -> None:
    initialize_runtime(tmp_path, TEST_ENV, _ports())
    claim_run(tmp_path, TEST_ENV, RUN_ID)
    owner_token = "a" * 32
    command = (sys.executable, "-c", "import signal; signal.pause()")
    resource = Resource(ResourceKind.PROCESS, process_resource_identity(RUN_ID, "api"))
    record_planned(
        tmp_path,
        TEST_ENV,
        RUN_ID,
        resource,
        external_id=owner_token,
        command=command,
    )
    process = subprocess.Popen(
        command,
        env={
            **os.environ,
            "NEXUS_ENV": "test",
            "NEXUS_TEST_PROCESS_OWNER": owner_token,
            "NEXUS_TEST_RUN_ID": RUN_ID,
        },
        start_new_session=True,
    )
    try:
        clean_run(tmp_path, TEST_ENV, RUN_ID)

        process.wait(timeout=3)
        assert not (tmp_path / ".nexus-test/runs" / RUN_ID).exists()
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()


def test_clean_uses_immutable_identity_when_owned_process_rewrites_argv(
    tmp_path: Path,
) -> None:
    initialize_runtime(tmp_path, TEST_ENV, _ports())
    claim_run(tmp_path, TEST_ENV, RUN_ID)
    command = (
        "/bin/bash",
        "-c",
        'exec -a nexus-mutated-title "$1" -c "import signal; signal.pause()"',
        "owned-process",
        sys.executable,
    )
    started = _start_owned_process(
        tmp_path,
        TEST_ENV,
        RUN_ID,
        "web",
        command,
        cwd=tmp_path,
        process_environment={"NEXUS_TEST_RUN_ID": RUN_ID},
    )
    command_line = b""
    try:
        for _attempt in range(500):
            command_line = (Path("/proc") / str(started.process_group_id) / "cmdline").read_bytes()
            if command_line.startswith(b"nexus-mutated-title"):
                break
            threading.Event().wait(0.01)
        assert command_line.startswith(b"nexus-mutated-title")

        clean_run(tmp_path, TEST_ENV, RUN_ID)

        with pytest.raises(ProcessLookupError):
            os.kill(started.process_group_id, 0)
    finally:
        try:
            os.killpg(started.process_group_id, signal.SIGKILL)
        except ProcessLookupError:
            pass


def test_readiness_rejects_listener_outside_owned_process_group(tmp_path: Path) -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as allocator:
        allocator.bind(("127.0.0.1", 0))
        port = int(allocator.getsockname()[1])
    initialize_runtime(tmp_path, TEST_ENV, replace(_ports(), web=port))
    claim_run(tmp_path, TEST_ENV, RUN_ID)
    stale = subprocess.Popen(
        (sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1"),
        cwd=tmp_path,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    owned = _start_owned_process(
        tmp_path,
        TEST_ENV,
        RUN_ID,
        "web",
        (sys.executable, "-c", "import signal; signal.pause()"),
        cwd=tmp_path,
        process_environment={"NEXUS_TEST_RUN_ID": RUN_ID},
    )
    try:
        for _attempt in range(500):
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
                if probe.connect_ex(("127.0.0.1", port)) == 0:
                    break
            threading.Event().wait(0.01)
        else:
            pytest.fail("foreign listener did not start")

        with pytest.raises(RuntimeContractError, match="did not become ready"):
            wait_process_ready(
                tmp_path,
                TEST_ENV,
                owned,
                endpoint=EndpointKind.WEB,
                path="/",
                timeout_seconds=0.2,
            )
    finally:
        try:
            clean_run(tmp_path, TEST_ENV, RUN_ID)
        finally:
            try:
                os.killpg(stale.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            stale.wait()


def test_readiness_rejects_an_owned_listener_that_returns_unauthorized(tmp_path: Path) -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as allocator:
        allocator.bind(("127.0.0.1", 0))
        port = int(allocator.getsockname()[1])
    initialize_runtime(tmp_path, TEST_ENV, replace(_ports(), web=port))
    claim_run(tmp_path, TEST_ENV, RUN_ID)
    server = (
        "import http.server,sys; "
        "handler=type('Unauthorized',(http.server.BaseHTTPRequestHandler,),{"
        "'do_GET':lambda self:(self.send_response(401),self.end_headers()),"
        "'log_message':lambda *args:None}); "
        "http.server.ThreadingHTTPServer(('127.0.0.1',int(sys.argv[1])),handler).serve_forever()"
    )
    owned = _start_owned_process(
        tmp_path,
        TEST_ENV,
        RUN_ID,
        "web",
        (sys.executable, "-c", server, str(port)),
        cwd=tmp_path,
        process_environment={"NEXUS_TEST_RUN_ID": RUN_ID},
    )
    try:
        with pytest.raises(RuntimeContractError, match="did not become ready"):
            wait_process_ready(
                tmp_path,
                TEST_ENV,
                owned,
                endpoint=EndpointKind.WEB,
                path="/",
                timeout_seconds=0.2,
            )
    finally:
        clean_run(tmp_path, TEST_ENV, RUN_ID)


def test_readiness_grace_requires_immutable_birth_identity_and_time() -> None:
    assert _startup_identity_pending(birth_matches=True, now=1, deadline=2)
    assert not _startup_identity_pending(birth_matches=False, now=1, deadline=2)
    assert not _startup_identity_pending(birth_matches=True, now=2, deadline=2)


def test_caller_resource_configuration_is_rejected_and_secrets_have_safe_reprs() -> None:
    assert local_test_environment({}) == TEST_ENV
    for environment in (
        {"NEXUS_ENV": "prod"},
        {"DATABASE_URL": "postgresql://production.example/app"},
        {"SUPABASE_DB_URL": "postgresql://production.example/postgres"},
        {"R2_ENDPOINT_URL": "https://production.example"},
        {"SUPABASE_JWKS_URL": "https://production.example/jwks"},
        {"AWS_ENDPOINT_URL_S3": "https://production.example"},
        {"PGHOST": "production.example"},
        {"SUPABASE_ACCESS_TOKEN": "production-token"},
        {"OPENAI_API_BASE_URL": "https://production.example/v1"},
        {"OUTBOUND_HTTP_PROXY_URL": "https://production.example"},
        {"PODCAST_INDEX_BASE_URL": "https://production.example"},
        {"NEXUS_TEST_STATIC_DNS": '{"production.example":"93.184.216.34"}'},
        {"NODE_OPTIONS": "--import=/tmp/foreign.mjs"},
        {"DOCKER_HOST": "tcp://production.example:2376"},
        {"DOCKER_CONTEXT": "production"},
    ):
        with pytest.raises(RuntimeContractError):
            local_test_environment(environment)
    assert "admin-secret" not in repr(
        SupabaseCredentials("http://127.0.0.1:25421", "anon", "admin-secret")
    )
    assert "password-secret" not in repr(
        ScenarioUser(
            "12345678-1234-4123-8123-123456789abc",
            "test@example.invalid",
            "password-secret",
        )
    )


def test_supabase_status_parser_ignores_cli_noise_and_keeps_only_required_values() -> None:
    status = _parse_supabase_status(
        "Stopped services: [studio]\n"
        '{"API_URL":"http://127.0.0.1:25421","ANON_KEY":"public",'
        '"SECRET_KEY":"admin","DB_URL":"must-not-leak"}\n'
    )

    assert status == {
        "API_URL": "http://127.0.0.1:25421",
        "ANON_KEY": "public",
        "SECRET_KEY": "admin",
    }


def test_supabase_status_parser_accepts_the_service_role_admin_key() -> None:
    status = _parse_supabase_status(
        '{"API_URL":"http://127.0.0.1:25421","ANON_KEY":"public","SERVICE_ROLE_KEY":"admin"}\n'
    )

    assert status["SERVICE_ROLE_KEY"] == "admin"


def test_supabase_credentials_use_the_recorded_url_when_cli_omits_api_url() -> None:
    credentials = _supabase_credentials_from_status(
        {"ANON_KEY": "public", "SECRET_KEY": "admin"},
        "http://127.0.0.1:25421",
    )

    assert credentials.url == "http://127.0.0.1:25421"
    assert credentials.anon_key == "public"


def test_supabase_credentials_reject_a_cli_url_outside_the_recorded_runtime() -> None:
    with pytest.raises(RuntimeContractError, match="does not match"):
        _supabase_credentials_from_status(
            {
                "API_URL": "https://production.example",
                "ANON_KEY": "public",
                "SECRET_KEY": "admin",
            },
            "http://127.0.0.1:25421",
        )


def test_admin_invite_records_ownership_before_provider_creation_and_returns_email_only(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    initialize_runtime(tmp_path, TEST_ENV, _ports())
    claim_run(tmp_path, TEST_ENV, RUN_ID)
    email = f"nexus+{RUN_ID}+auth-session@example.invalid"
    user_id = "12345678-1234-4123-8123-123456789abc"
    admin_key = "controller-only-admin-key"

    def provider(request: httpx.Request) -> httpx.Response:
        [planned] = read_ledger(tmp_path, RUN_ID).entries
        assert planned.resource == Resource(ResourceKind.SUPABASE_USER, email)
        assert planned.scenario_id == "auth-session"
        assert planned.phase.value == "planned"
        assert planned.external_id is None
        assert request.method == "POST"
        assert request.url.path == "/auth/v1/invite"
        assert request.headers["authorization"] == f"Bearer {admin_key}"
        assert request.headers["apikey"] == admin_key
        assert json.loads(request.content) == {
            "email": email,
            "data": {
                "nexus_test_run_id": RUN_ID,
                "nexus_test_scenario": "auth-session",
            },
        }
        return httpx.Response(200, json={"id": user_id, "email": email})

    client_type = httpx.Client
    transport = httpx.MockTransport(provider)

    def provider_client(*, trust_env: bool, timeout: int) -> httpx.Client:
        return client_type(transport=transport, trust_env=trust_env, timeout=timeout)

    monkeypatch.setattr(httpx, "Client", provider_client)

    invited = services.invite_supabase_user(
        tmp_path,
        TEST_ENV,
        RUN_ID,
        "auth-session",
        SupabaseCredentials("http://127.0.0.1:25421", "public", admin_key),
    )

    assert invited.email == email
    assert not hasattr(invited, "id")
    assert not hasattr(invited, "password")
    assert admin_key not in repr(invited)
    [created] = read_ledger(tmp_path, RUN_ID).entries
    assert created.phase.value == "created"
    assert created.external_id == user_id


def test_cleanup_recovers_provider_created_invite_left_planned(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    initialize_runtime(tmp_path, TEST_ENV, _ports())
    claim_run(tmp_path, TEST_ENV, RUN_ID)
    email = f"nexus+{RUN_ID}+auth-session@example.invalid"
    user_id = "12345678-1234-4123-8123-123456789abc"
    admin_key = "controller-only-admin-key"
    resource = Resource(ResourceKind.SUPABASE_USER, email)
    record_planned(
        tmp_path,
        TEST_ENV,
        RUN_ID,
        resource,
        scenario_id="auth-session",
    )
    calls: list[tuple[str, str]] = []
    listed_pages: list[int] = []

    def provider(request: httpx.Request) -> httpx.Response:
        calls.append((request.method, request.url.path))
        assert request.headers["authorization"] == f"Bearer {admin_key}"
        assert request.headers["apikey"] == admin_key
        if request.method == "GET" and request.url.path == "/auth/v1/admin/users":
            page = int(request.url.params["page"])
            listed_pages.append(page)
            assert request.url.params["per_page"] == "1000"
            if page == 1:
                return httpx.Response(
                    200,
                    json={
                        "users": [
                            {
                                "id": f"00000000-0000-4000-8000-{index:012x}",
                                "email": f"unrelated-{index}@example.invalid",
                                "user_metadata": {},
                            }
                            for index in range(1000)
                        ]
                    },
                )
            assert page == 2
            return httpx.Response(
                200,
                json={
                    "users": [
                        {
                            "id": user_id,
                            "email": email,
                            "user_metadata": {
                                "nexus_test_run_id": RUN_ID,
                                "nexus_test_scenario": "auth-session",
                            },
                        }
                    ]
                },
            )
        if request.url.path == f"/auth/v1/admin/users/{user_id}":
            if request.method == "GET":
                return httpx.Response(
                    200,
                    json={
                        "id": user_id,
                        "email": email,
                        "user_metadata": {
                            "nexus_test_run_id": RUN_ID,
                            "nexus_test_scenario": "auth-session",
                        },
                    },
                )
            if request.method == "DELETE":
                return httpx.Response(204)
        raise AssertionError(f"unexpected Supabase cleanup request: {request.method}")

    client_type = httpx.Client
    transport = httpx.MockTransport(provider)

    def provider_client(*, trust_env: bool, timeout: int) -> httpx.Client:
        return client_type(transport=transport, trust_env=trust_env, timeout=timeout)

    monkeypatch.setattr(httpx, "Client", provider_client)

    clean_run(
        tmp_path,
        TEST_ENV,
        RUN_ID,
        supabase=SupabaseCredentials(
            "http://127.0.0.1:25421",
            "public",
            admin_key,
        ),
    )

    assert calls == [
        ("GET", "/auth/v1/admin/users"),
        ("GET", "/auth/v1/admin/users"),
        ("GET", f"/auth/v1/admin/users/{user_id}"),
        ("DELETE", f"/auth/v1/admin/users/{user_id}"),
    ]
    assert listed_pages == [1, 2]
    assert not (tmp_path / ".nexus-test" / "runs" / RUN_ID).exists()


def test_supabase_status_parser_rejects_non_json() -> None:
    with pytest.raises(RuntimeContractError, match="not JSON"):
        _parse_supabase_status("Supabase is unavailable")


def test_supabase_workdir_contains_generated_config_and_exact_email_template_assets(
    tmp_path: Path,
) -> None:
    (tmp_path / "supabase").mkdir()
    (tmp_path / "supabase" / "config.toml").write_text(
        "\n".join(
            (
                'project_id = "nexus"',
                "[api]",
                "port = 54321",
                "[db]",
                "port = 54322",
                "shadow_port = 54320",
                "[studio]",
                "port = 54323",
                "[inbucket]",
                "port = 54324",
                "[auth]",
                'site_url = "http://localhost:3000"',
                'jwt_issuer = "http://127.0.0.1:54321/auth/v1"',
                'additional_redirect_urls = ["http://localhost:3000/auth/callback"]',
                "[auth.email.template.invite]",
                'content_path = "./supabase/templates/invite.html"',
                "[auth.email.template.recovery]",
                'content_path = "./supabase/templates/recovery.html"',
            )
        )
        + "\n"
    )
    source_templates = tmp_path / "supabase" / "templates"
    source_templates.mkdir()
    invite_template = b"<p>Accept this Nexus invitation.</p>\n"
    recovery_template = b"<p>Continue this Nexus password reset.</p>\n"
    (source_templates / "invite.html").write_bytes(invite_template)
    (source_templates / "recovery.html").write_bytes(recovery_template)
    runtime = initialize_runtime(tmp_path, TEST_ENV, _ports())

    _write_supabase_config(tmp_path)

    generated = Path(runtime.supabase_workdir) / "supabase" / "config.toml"
    text = generated.read_text()
    assert f'project_id = "{runtime.compose_project}"' in text
    assert "port = 25421" in text
    assert "port = 25422" in text
    assert "shadow_port = 25425" in text
    assert "port = 25423" in text
    assert "port = 25424" in text
    assert 'site_url = "http://127.0.0.1:13000"' in text
    assert 'jwt_issuer = "http://127.0.0.1:25421/auth/v1"' in text
    assert '"http://127.0.0.1:13000/auth/callback"' in text
    generated_templates = generated.parent / "templates"
    assert (generated_templates / "invite.html").read_bytes() == invite_template
    assert (generated_templates / "recovery.html").read_bytes() == recovery_template


def test_application_database_url_selects_the_installed_psycopg_driver(tmp_path: Path) -> None:
    initialize_runtime(tmp_path, TEST_ENV, _ports())

    assert _database_url(tmp_path, TEST_ENV, "nexus_run_0123456789abcdef").startswith(
        "postgresql+psycopg://127.0.0.1:15432/"
    )


def test_run_environment_contains_only_exact_local_resources_and_no_admin_key(
    tmp_path: Path,
) -> None:
    run = _owned_run(tmp_path)

    environment = run_environment(tmp_path, TEST_ENV, run)

    assert environment["DATABASE_URL"] == run.database_url
    assert environment["NEXUS_MIGRATION_DATABASE_URL"] == run.migration_database_url
    assert environment["R2_BUCKET"] == run.bucket
    assert environment["NEXT_PUBLIC_SUPABASE_URL"] == "http://127.0.0.1:25421"
    assert environment["NEXT_PUBLIC_SUPABASE_ANON_KEY"] == "public-anon-key"
    assert environment["OPENAI_API_BASE_URL"] == "http://127.0.0.1:19091/v1"
    assert environment["OPENAI_API_KEY"] == "nexus-test-fixture-openai-key"
    assert environment["NEXUS_RUNTIME_IDENTITY_FILE"] == str(
        tmp_path / ".nexus-test/runtime-identity.json"
    )
    assert environment["NEXUS_EXTENSION_REDIRECT_ORIGINS"] == (
        f"https://{TEST_EXTENSION_ID}.chromiumapp.org"
    )
    assert "must-not-escape" not in repr(environment)
    assert not {
        "SERVICE_ROLE_KEY",
        "SUPABASE_AUTH_ADMIN_KEY",
        "SUPABASE_SERVICE_KEY",
        "SUPABASE_SERVICE_ROLE_KEY",
    }.intersection(environment)


@pytest.mark.parametrize(
    "run",
    (
        OwnedRun(
            RUN_ID,
            "postgresql+psycopg://production.example/nexus",
            None,
            run_bucket_name(RUN_ID),
            SupabaseCredentials("http://127.0.0.1:25421", "anon", "admin"),
        ),
        OwnedRun(
            RUN_ID,
            "postgresql+psycopg://127.0.0.1:15432/other",
            None,
            "production-library",
            SupabaseCredentials("https://production.example", "anon", "admin"),
        ),
    ),
    ids=("public-database", "foreign-owned-resources"),
)
def test_python_child_rejects_unpersisted_or_public_run_resources_before_spawn(
    tmp_path: Path,
    run: OwnedRun,
) -> None:
    persisted = _owned_run(tmp_path, migration=False)
    poisoned = replace(
        run,
        database_url=run.database_url,
        migration_database_url=persisted.migration_database_url,
    )

    with pytest.raises(RuntimeContractError, match="exact persisted local test run"):
        start_python_process(tmp_path, TEST_ENV, poisoned, "api")

    assert not any(
        entry.resource.kind is ResourceKind.PROCESS
        for entry in read_ledger(tmp_path, RUN_ID).entries
    )


def test_web_child_rejects_public_supabase_before_recording_or_spawning_process(
    tmp_path: Path,
) -> None:
    run = _owned_run(tmp_path, migration=False)
    poisoned = replace(
        run,
        supabase=SupabaseCredentials("https://production.example", "anon", "admin"),
    )
    artifact = tmp_path / ".nexus-test/builds" / ("a" * 64)
    artifact.mkdir(parents=True)
    server = artifact / "server.js"
    server.write_text("throw new Error('must not run')\n", encoding="utf-8")

    with pytest.raises(RuntimeContractError, match="exact persisted local test run"):
        start_web_process(
            tmp_path,
            TEST_ENV,
            poisoned,
            StandaloneBuild("a" * 64, artifact, server),
        )

    assert not any(
        entry.resource.kind is ResourceKind.PROCESS
        for entry in read_ledger(tmp_path, RUN_ID).entries
    )


def test_cleanup_repairs_an_interrupted_empty_claim_and_releases_exact_ownership(
    tmp_path: Path,
) -> None:
    initialize_runtime(tmp_path, TEST_ENV, _ports())
    runtime_path = tmp_path / ".nexus-test/runtime.json"
    interrupted = json.loads(runtime_path.read_text(encoding="utf-8"))
    interrupted["owned_run_ids"] = [RUN_ID]
    runtime_path.write_text(json.dumps(interrupted), encoding="utf-8")

    clean_run(tmp_path, TEST_ENV, RUN_ID)

    runtime = json.loads(runtime_path.read_text(encoding="utf-8"))
    assert runtime["owned_run_ids"] == []
    assert not (tmp_path / ".nexus-test/runs" / RUN_ID).exists()


def test_cleanup_attempts_every_resource_and_retains_only_failed_ownership(
    tmp_path: Path,
) -> None:
    initialize_runtime(tmp_path, TEST_ENV, _ports())
    claim_run(tmp_path, TEST_ENV, RUN_ID)
    recoverable = Resource(
        ResourceKind.EXTENSION_PROFILE,
        extension_profile_identity(RUN_ID, "recoverable"),
    )
    unsafe = Resource(
        ResourceKind.EXTENSION_PROFILE,
        extension_profile_identity(RUN_ID, "unsafe"),
    )
    record_planned(
        tmp_path,
        TEST_ENV,
        RUN_ID,
        recoverable,
        scenario_id="recoverable",
    )
    record_planned(tmp_path, TEST_ENV, RUN_ID, unsafe, scenario_id="unsafe")
    recoverable_path = tmp_path / recoverable.identity
    recoverable_path.mkdir(parents=True)
    foreign = tmp_path / "foreign-profile"
    foreign.mkdir()
    sentinel = foreign / "sentinel.txt"
    sentinel.write_text("preserve\n", encoding="utf-8")
    unsafe_path = tmp_path / unsafe.identity
    unsafe_path.symlink_to(foreign, target_is_directory=True)

    with pytest.raises(ExceptionGroup, match=f"run {RUN_ID} cleanup failed"):
        clean_run(tmp_path, TEST_ENV, RUN_ID)

    assert not recoverable_path.exists()
    assert sentinel.read_text(encoding="utf-8") == "preserve\n"
    assert [entry.resource for entry in read_ledger(tmp_path, RUN_ID).entries] == [unsafe]

    unsafe_path.unlink()
    unsafe_path.mkdir()
    clean_run(tmp_path, TEST_ENV, RUN_ID)
    assert not (tmp_path / ".nexus-test/runs" / RUN_ID).exists()


def test_extension_redirect_id_is_derived_from_the_staged_public_key() -> None:
    digest = hashlib.sha256(base64.b64decode(TEST_EXTENSION_PUBLIC_KEY)).digest()
    extension_id = "".join(
        chr(ord("a") + nibble) for byte in digest[:16] for nibble in (byte >> 4, byte & 15)
    )

    assert extension_id == TEST_EXTENSION_ID


def test_clean_removes_only_the_exact_recorded_workspace_runtime(tmp_path: Path) -> None:
    runtime = initialize_runtime(tmp_path, TEST_ENV, _ports())
    supabase_config = Path(runtime.supabase_workdir) / "supabase/config.toml"
    supabase_config.parent.mkdir(parents=True)
    supabase_config.write_text("project_id = 'test'\n", encoding="utf-8")
    foreign = tmp_path / "foreign-sentinel"
    foreign.write_text("preserve", encoding="utf-8")
    commands: list[tuple[str, ...]] = []

    def run_command(command: tuple[str, ...], *, cwd: Path) -> subprocess.CompletedProcess[str]:
        assert cwd == tmp_path
        commands.append(command)
        return subprocess.CompletedProcess(command, 0, "", "")

    assert clean_owned_runtime(tmp_path, TEST_ENV, command_runner=run_command) == ()

    assert commands == [
        (
            "supabase",
            "--workdir",
            runtime.supabase_workdir,
            "stop",
            "--project-id",
            runtime.compose_project,
            "--no-backup",
            "--yes",
        ),
        (
            "docker",
            "compose",
            "--project-name",
            runtime.compose_project,
            "--file",
            str(tmp_path / "docker" / "docker-compose.test.yml"),
            "down",
            "--volumes",
            "--remove-orphans",
        ),
    ]
    assert not (tmp_path / ".nexus-test").exists()
    assert foreign.read_text(encoding="utf-8") == "preserve"


def test_clean_attempts_compose_and_retains_ownership_when_supabase_stop_fails(
    tmp_path: Path,
) -> None:
    runtime = initialize_runtime(tmp_path, TEST_ENV, _ports())
    supabase_config = Path(runtime.supabase_workdir) / "supabase/config.toml"
    supabase_config.parent.mkdir(parents=True)
    supabase_config.write_text("project_id = 'test'\n", encoding="utf-8")
    commands: list[tuple[str, ...]] = []

    def run_command(command: tuple[str, ...], *, cwd: Path) -> subprocess.CompletedProcess[str]:
        assert cwd == tmp_path
        commands.append(command)
        if command[0] == "supabase":
            raise subprocess.CalledProcessError(1, command)
        return subprocess.CompletedProcess(command, 0, "", "")

    with pytest.raises(RuntimeContractError, match="Supabase teardown failed"):
        clean_owned_runtime(tmp_path, TEST_ENV, command_runner=run_command)

    assert [command[0] for command in commands] == ["supabase", "docker"]
    assert (tmp_path / ".nexus-test/runtime.json").is_file()
