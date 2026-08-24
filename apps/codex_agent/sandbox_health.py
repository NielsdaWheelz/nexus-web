"""Behavioral readiness probe for the bundled Codex Linux sandbox."""

from __future__ import annotations

import subprocess

import codex_cli_bin
from apps.codex_agent.auth_environment import reject_api_key_auth

_TIMEOUT_SECONDS = 10.0


def check() -> None:
    reject_api_key_auth()
    try:
        completed = subprocess.run(
            (
                str(codex_cli_bin.bundled_codex_path()),
                "sandbox",
                "--",
                "/usr/bin/true",
            ),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RuntimeError("Codex Linux sandbox readiness probe failed") from error
    if completed.returncode != 0:
        raise RuntimeError("Codex Linux sandbox readiness probe failed")


def main() -> None:
    try:
        check()
    except RuntimeError:
        # justify-ignore-error: the readiness message is credential-adjacent host context,
        # so the CLI contract is a silent nonzero exit while callers keep the typed error.
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
