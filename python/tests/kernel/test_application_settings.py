from __future__ import annotations

import ast
from pathlib import Path

import pytest

from nexus.config import Environment, Settings


def _settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "DATABASE_URL": "postgresql+psycopg://127.0.0.1:54320/nexus",
        "SUPABASE_JWKS_URL": "https://auth.example.invalid/.well-known/jwks.json",
        "SUPABASE_ISSUER": "https://auth.example.invalid",
        "SUPABASE_AUDIENCES": "authenticated",
    }
    values.update(overrides)
    return Settings(**values, _env_file=None)  # pyright: ignore[reportCallIssue]


def test_podcasts_default_to_disabled_without_provider_credentials() -> None:
    settings = _settings(
        PODCAST_INDEX_API_KEY=None,
        PODCAST_INDEX_API_SECRET=None,
    )

    assert settings.podcasts_enabled is False


@pytest.mark.parametrize("nexus_env", [Environment.LOCAL, Environment.TEST])
@pytest.mark.parametrize(
    ("missing_alias", "present_alias", "present_value"),
    [
        ("PODCAST_INDEX_API_KEY", "PODCAST_INDEX_API_SECRET", "secret"),
        ("PODCAST_INDEX_API_SECRET", "PODCAST_INDEX_API_KEY", "key"),
    ],
)
def test_enabled_podcasts_reject_missing_provider_credentials(
    nexus_env: Environment,
    missing_alias: str,
    present_alias: str,
    present_value: str,
) -> None:
    with pytest.raises(ValueError, match=missing_alias):
        _settings(
            NEXUS_ENV=nexus_env,
            PODCASTS_ENABLED=True,
            **{missing_alias: None, present_alias: present_value},
        )


def test_enabled_podcasts_preserve_explicit_admission() -> None:
    settings = _settings(
        PODCASTS_ENABLED=True,
        PODCAST_INDEX_API_KEY="key",
        PODCAST_INDEX_API_SECRET="secret",
    )

    assert settings.podcasts_enabled is True


def test_application_validator_only_sequences_owned_checks() -> None:
    config_path = Path(__file__).parents[2] / "nexus" / "config.py"
    module = ast.parse(config_path.read_text())
    settings_class = next(
        node for node in module.body if isinstance(node, ast.ClassDef) and node.name == "Settings"
    )
    validator = next(
        node
        for node in settings_class.body
        if isinstance(node, ast.FunctionDef) and node.name == "validate_required_settings"
    )
    statements = validator.body[1:]
    calls = statements[:-1]

    assert [
        statement.value.func.attr
        for statement in calls
        if isinstance(statement, ast.Expr)
        and isinstance(statement.value, ast.Call)
        and isinstance(statement.value.func, ast.Attribute)
    ] == [
        "_validate_supabase_auth",
        "_validate_retired_supabase_settings",
        "_validate_database_origin",
        "_validate_retired_storage_settings",
        "_validate_database_limits",
        "_validate_deployed_storage",
        "_validate_storage_lifecycle",
        "_validate_archive_safety",
        "_validate_billing_limits",
        "_validate_media_provider_limits",
        "_validate_billing_credentials",
        "_validate_email_credentials",
        "_validate_podcast_credentials",
        "_validate_deployed_browse_provider",
        "_validate_deployed_generation_runtime",
        "_validate_ingest_runtime_and_paths",
        "_validate_worker_lane",
        "_validate_worker_intervals",
        "_validate_background_process_limits",
        "_validate_maintenance_schedules",
    ]
    assert all(
        isinstance(statement, ast.Expr)
        and isinstance(statement.value, ast.Call)
        and isinstance(statement.value.func, ast.Attribute)
        and isinstance(statement.value.func.value, ast.Name)
        and statement.value.func.value.id == "self"
        and not statement.value.args
        and not statement.value.keywords
        for statement in calls
    )
    assert len(statements) == 21
    assert isinstance(statements[-1], ast.Return)
    assert isinstance(statements[-1].value, ast.Name)
    assert statements[-1].value.id == "self"


def test_application_validators_never_mutate_podcast_admission() -> None:
    config_path = Path(__file__).parents[2] / "nexus" / "config.py"
    module = ast.parse(config_path.read_text())
    settings_class = next(
        node for node in module.body if isinstance(node, ast.ClassDef) and node.name == "Settings"
    )
    validator_methods = [
        node
        for node in settings_class.body
        if isinstance(node, ast.FunctionDef) and node.name.startswith("_validate_")
    ]

    mutated_attributes = {
        target.attr
        for method in validator_methods
        for assignment in ast.walk(method)
        if isinstance(assignment, (ast.Assign, ast.AnnAssign, ast.AugAssign))
        for target in (
            assignment.targets if isinstance(assignment, ast.Assign) else [assignment.target]
        )
        if isinstance(target, ast.Attribute)
    }

    assert "podcasts_enabled" not in mutated_attributes
