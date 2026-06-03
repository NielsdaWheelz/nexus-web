"""Supabase Auth admin config discovery for seed scripts."""

from __future__ import annotations

import os
import sys
from collections.abc import Mapping

MISSING_SUPABASE_AUTH_CONFIG_MESSAGE = (
    "SUPABASE_URL and SUPABASE_AUTH_ADMIN_KEY must be set by the E2E bootstrap"
)
FORBIDDEN_SUPABASE_AUTH_CONFIG_KEYS = (
    "SUPABASE_DATABASE_URL",
    "SUPABASE_SERVICE_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SERVICE_ROLE_KEY",
)


class SupabaseAuthConfigError(RuntimeError):
    pass


def resolve_supabase_auth_config(
    environ: Mapping[str, str] | None = None,
) -> tuple[str, str] | None:
    env = os.environ if environ is None else environ
    forbidden = [key for key in FORBIDDEN_SUPABASE_AUTH_CONFIG_KEYS if env.get(key)]
    if forbidden:
        raise SupabaseAuthConfigError(
            "Supabase Auth seed scripts do not accept legacy admin env aliases: "
            f"{', '.join(forbidden)}. Use command-scoped SUPABASE_AUTH_ADMIN_KEY."
        )

    supabase_url = env.get("SUPABASE_URL")
    admin_key = env.get("SUPABASE_AUTH_ADMIN_KEY")

    if supabase_url and admin_key:
        return supabase_url, admin_key

    return None


def load_supabase_auth_config() -> tuple[str, str]:
    config = resolve_supabase_auth_config()
    if config is None:
        raise SupabaseAuthConfigError(MISSING_SUPABASE_AUTH_CONFIG_MESSAGE)
    return config


def load_supabase_auth_config_or_exit() -> tuple[str, str]:
    try:
        return load_supabase_auth_config()
    except SupabaseAuthConfigError as exc:
        print(f"ERROR: {exc}")
        sys.exit(1)
