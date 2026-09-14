"""The controller's shared environment-secret selection policy."""

from collections.abc import Mapping

SENSITIVE_ENV_PARTS = (
    "credential",
    "fixture",
    "key",
    "password",
    "promotion",
    "secret",
    "token",
)


def environment_secrets(environment: Mapping[str, str]) -> tuple[str, ...]:
    return tuple(
        value
        for key, value in environment.items()
        if value and any(part in key.casefold() for part in SENSITIVE_ENV_PARTS)
    )
