"""Supabase Auth admin config discovery for seed scripts."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from collections.abc import Mapping

DEFAULT_LOCAL_SUPABASE_URL = "http://127.0.0.1:54321"
MISSING_SUPABASE_AUTH_CONFIG_MESSAGE = (
    "SUPABASE_URL and SUPABASE_AUTH_ADMIN_KEY must be set, "
    "or local Supabase CLI status must be available"
)


def _status_text_without_service_warnings(raw_status: str) -> str:
    return "\n".join(
        line
        for line in raw_status.splitlines()
        if line.strip() and not line.startswith("Stopped services:")
    )


def _load_local_supabase_status() -> dict[str, object]:
    try:
        raw_status = subprocess.check_output(
            ["supabase", "status", "--output", "json"],
            stderr=subprocess.DEVNULL,
            text=True,
        )
        status = json.loads(_status_text_without_service_warnings(raw_status))
    except (OSError, subprocess.CalledProcessError, json.JSONDecodeError):
        return {}
    return status if isinstance(status, dict) else {}


def _status_str(status: Mapping[str, object], key: str) -> str | None:
    value = status.get(key)
    return value if isinstance(value, str) and value else None


def resolve_supabase_auth_config(
    environ: Mapping[str, str] | None = None,
    status: Mapping[str, object] | None = None,
) -> tuple[str, str] | None:
    env = os.environ if environ is None else environ
    supabase_url = env.get("SUPABASE_URL")
    admin_key = env.get("SUPABASE_AUTH_ADMIN_KEY")

    if supabase_url and admin_key:
        return supabase_url, admin_key

    local_status = status if status is not None else _load_local_supabase_status()
    resolved_url = (
        supabase_url or _status_str(local_status, "API_URL") or DEFAULT_LOCAL_SUPABASE_URL
    )
    resolved_key = (
        admin_key
        or _status_str(local_status, "SECRET_KEY")
        or _status_str(local_status, "SERVICE_ROLE_KEY")
    )
    if not resolved_url or not resolved_key:
        return None
    return resolved_url, resolved_key


def load_supabase_auth_config() -> tuple[str, str]:
    config = resolve_supabase_auth_config()
    if config is None:
        raise RuntimeError(MISSING_SUPABASE_AUTH_CONFIG_MESSAGE)
    return config


def load_supabase_auth_config_or_exit() -> tuple[str, str]:
    try:
        return load_supabase_auth_config()
    except RuntimeError as exc:
        print(f"ERROR: {exc}")
        sys.exit(1)
