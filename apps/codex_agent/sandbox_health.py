"""Behavioral readiness probe for the bundled Codex Linux sandbox."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from uuid import uuid4

import codex_cli_bin
from apps.codex_agent.auth_environment import (
    reject_ambient_codex_home,
    reject_subscription_api_key_auth,
)
from apps.codex_agent.confined_runtime import CODEX_SANDBOX_HEALTH_OVERRIDES
from apps.codex_agent.credential_state import (
    create_ephemeral_runtime_paths,
    remove_ephemeral_runtime_paths,
)
from apps.codex_agent.path_environment import required_absolute_path

_TIMEOUT_SECONDS = 10.0
_WORKING_DIRECTORY_ROOT_ENV = "NEXUS_CODEX_WORKING_DIRECTORY_ROOT"
_CHILD_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
_PROBE = """
import os
import sys
from pathlib import Path

temporary = Path(os.environ["TMPDIR"])
inside = temporary / "sandbox-health"
outside = Path(sys.argv[1])
inside.write_text("confined", encoding="ascii")
try:
    outside.write_text("escaped", encoding="ascii")
except OSError:
    pass
else:
    raise SystemExit("Codex sandbox admitted bare /tmp")
"""


def _config_arguments() -> tuple[str, ...]:
    return tuple(
        argument
        for override in CODEX_SANDBOX_HEALTH_OVERRIDES
        for argument in ("--config", override)
    )


def check(working_directory_root: Path) -> None:
    reject_subscription_api_key_auth()
    reject_ambient_codex_home()
    try:
        paths = create_ephemeral_runtime_paths(working_directory_root, "sandbox-health")
    except (OSError, RuntimeError, ValueError) as error:
        raise RuntimeError("Codex Linux sandbox readiness probe failed") from error
    codex_home = paths.state_root_base / "codex"
    child_home = paths.state_root_base / "home"
    outside = Path("/tmp") / f"nexus-codex-sandbox-outside-{uuid4().hex}"
    passed = False
    failure: BaseException | None = None
    try:
        codex_home.mkdir(mode=0o700)
        child_home.mkdir(mode=0o700)
        environment = {
            "CODEX_HOME": str(codex_home),
            "HOME": str(child_home),
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "PATH": _CHILD_PATH,
            "TMPDIR": str(paths.temporary_directory),
        }
        completed = subprocess.run(
            (
                str(codex_cli_bin.bundled_codex_path()),
                *_config_arguments(),
                "sandbox",
                "--",
                sys.executable,
                "-c",
                _PROBE,
                str(outside),
            ),
            cwd=paths.working_directory,
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=_TIMEOUT_SECONDS,
            check=False,
        )
        marker = paths.temporary_directory / "sandbox-health"
        passed = (
            completed.returncode == 0
            and marker.read_text(encoding="ascii") == "confined"
        )
    except (OSError, UnicodeDecodeError, subprocess.TimeoutExpired) as error:
        failure = error
    finally:
        try:
            outside.unlink(missing_ok=True)
        except (OSError, RuntimeError) as error:
            failure = failure or error
        try:
            remove_ephemeral_runtime_paths(paths, root=working_directory_root)
        except (OSError, RuntimeError) as error:
            failure = failure or error
    if failure is not None or not passed:
        raise RuntimeError("Codex Linux sandbox readiness probe failed") from failure


def main() -> None:
    try:
        check(required_absolute_path(_WORKING_DIRECTORY_ROOT_ENV))
    except RuntimeError:
        # justify-ignore-error: the readiness message is credential-adjacent host context,
        # so the CLI contract is a silent nonzero exit while callers keep the typed error.
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
