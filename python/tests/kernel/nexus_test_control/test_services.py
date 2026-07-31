import base64
import hashlib
import os
import signal
import subprocess
import sys
import threading
from pathlib import Path

import pytest

from nexus_test_control.runtime import (
    RuntimeContractError,
    RuntimePorts,
    claim_run,
    initialize_runtime,
)
from nexus_test_control.services import (
    TEST_EXTENSION_ID,
    TEST_EXTENSION_PUBLIC_KEY,
    SupabaseCredentials,
    _database_url,
    _parse_supabase_status,
    _start_owned_process,
    _supabase_credentials_from_status,
    _write_supabase_config,
    clean_owned_runtime,
    clean_run,
    new_run_id,
    run_environment,
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
    return RuntimePorts(15432, 19000, 25421, 25422, 25423, 25424, 25425, 18000, 13000)


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


def test_caller_resource_configuration_is_rejected_and_secrets_have_safe_reprs() -> None:
    assert local_test_environment({}) == TEST_ENV
    for environment in (
        {"NEXUS_ENV": "prod"},
        {"DATABASE_URL": "postgresql://production.example/app"},
        {"R2_ENDPOINT_URL": "https://production.example"},
        {"SUPABASE_JWKS_URL": "https://production.example/jwks"},
        {"AWS_ENDPOINT_URL_S3": "https://production.example"},
        {"PGHOST": "production.example"},
        {"SUPABASE_ACCESS_TOKEN": "production-token"},
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


def test_supabase_status_parser_rejects_non_json() -> None:
    with pytest.raises(RuntimeContractError, match="not JSON"):
        _parse_supabase_status("Supabase is unavailable")


def test_supabase_workdir_is_generated_from_recorded_local_ports(tmp_path: Path) -> None:
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
            )
        )
        + "\n"
    )
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


def test_application_database_url_selects_the_installed_psycopg_driver(tmp_path: Path) -> None:
    initialize_runtime(tmp_path, TEST_ENV, _ports())

    assert _database_url(tmp_path, TEST_ENV, "nexus_run_0123456789abcdef").startswith(
        "postgresql+psycopg://127.0.0.1:15432/"
    )


def test_run_environment_contains_only_exact_local_resources_and_no_admin_key(
    tmp_path: Path,
) -> None:
    initialize_runtime(tmp_path, TEST_ENV, _ports())
    run = OwnedRun(
        run_id="0123456789abcdef",
        database_url=(
            "postgresql+psycopg://127.0.0.1:15432/nexus_run_0123456789abcdef"
            "?user=postgres&password=postgres"
        ),
        migration_database_url=(
            "postgresql+psycopg://127.0.0.1:15432/nexus_migration_0123456789abcdef"
            "?user=postgres&password=postgres"
        ),
        bucket="nexus-run-0123456789abcdef",
        supabase=SupabaseCredentials(
            "http://127.0.0.1:25421",
            "public-anon-key",
            "must-not-escape",
        ),
    )

    environment = run_environment(tmp_path, TEST_ENV, run)

    assert environment["DATABASE_URL"] == run.database_url
    assert environment["NEXUS_MIGRATION_DATABASE_URL"] == run.migration_database_url
    assert environment["R2_BUCKET"] == run.bucket
    assert environment["NEXT_PUBLIC_SUPABASE_URL"] == "http://127.0.0.1:25421"
    assert environment["NEXT_PUBLIC_SUPABASE_ANON_KEY"] == "public-anon-key"
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
