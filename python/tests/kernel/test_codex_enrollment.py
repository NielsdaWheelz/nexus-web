"""Kernel proof for the one interactive subscription-enrollment handoff."""

from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
from pathlib import Path

import pytest
from apps.codex_agent.credential_state import (
    CredentialStateUnavailable,
    create_ephemeral_runtime_paths,
    enrolled_auth_identity,
    link_runtime_auth,
    remove_ephemeral_runtime_paths,
    require_private_executable_runtime_mount,
    require_writable_credential_mount,
    sync_enrolled_auth_file,
)

REPO_ROOT = Path(__file__).parents[3]


def _enrollment_peer(tmp_path: Path) -> tuple[Path, Path]:
    executable = tmp_path / "codex-enrollment-peer"
    executable.write_text(
        "#!/usr/bin/env python3\n"
        "import json, os, sys\n"
        "from pathlib import Path\n"
        "home = Path(os.environ['CODEX_HOME'])\n"
        "auth = home / 'auth.json'\n"
        "auth.write_bytes(b'test-private-chatgpt-auth')\n"
        "auth.chmod(0o600)\n"
        "(home / 'runtime-residue').write_text('must stay ephemeral', encoding='utf-8')\n"
        "Path(os.environ['NEXUS_ENROLLMENT_AUDIT']).write_text(\n"
        "    json.dumps({'argv': sys.argv[1:], 'codex_home': os.environ.get('CODEX_HOME')}),\n"
        "    encoding='utf-8',\n"
        ")\n",
        encoding="utf-8",
    )
    executable.chmod(0o755)
    (tmp_path / "codex_cli_bin.py").write_text(
        "import os\n"
        "from pathlib import Path\n"
        "def bundled_codex_path():\n"
        "    return Path(os.environ['NEXUS_ENROLLMENT_PEER'])\n",
        encoding="utf-8",
    )
    return executable, tmp_path / "enrollment-audit.json"


def _run_enrollment(
    tmp_path: Path,
    *,
    forbidden_key: str | None = None,
    preexisting_target: bytes | None = None,
) -> tuple[subprocess.CompletedProcess[str], Path, Path, Path]:
    executable, audit = _enrollment_peer(tmp_path)
    codex_home = tmp_path / "enrollment-tmpfs" / "codex-home"
    codex_home.parent.mkdir(mode=0o700)
    encrypted_state = tmp_path / "encrypted-state"
    encrypted_state.mkdir(mode=0o700)
    target = encrypted_state / "codex" / "codex-personal" / "auth.json"
    if preexisting_target is not None:
        target.parent.mkdir(parents=True, mode=0o700)
        target.write_bytes(preexisting_target)
        target.chmod(0o600)
    environment = {
        key: value
        for key, value in os.environ.items()
        if key not in {"OPENAI_API_KEY", "CODEX_API_KEY"}
    }
    environment.update(
        {
            "CODEX_HOME": str(codex_home),
            "NEXUS_CODEX_ENROLLMENT_AUTH_FILE": str(target),
            "NEXUS_ENROLLMENT_AUDIT": str(audit),
            "NEXUS_ENROLLMENT_PEER": str(executable),
            "PYTHONPATH": os.pathsep.join((str(tmp_path), str(REPO_ROOT))),
        }
    )
    if forbidden_key is not None:
        environment[forbidden_key] = "must-not-be-used"
    completed = subprocess.run(
        (sys.executable, "-m", "apps.codex_agent.enroll"),
        cwd=REPO_ROOT,
        env=environment,
        text=True,
        capture_output=True,
        timeout=10,
        check=False,
    )
    return completed, audit, codex_home, target


def test_enrollment_requires_its_explicit_codex_home_and_reaches_device_auth(
    tmp_path: Path,
) -> None:
    completed, audit, codex_home, target = _run_enrollment(tmp_path)

    assert completed.returncode == 0, completed.stderr
    assert json.loads(audit.read_text(encoding="utf-8")) == {
        "argv": ["login", "--device-auth"],
        "codex_home": str(codex_home),
    }
    assert target.read_bytes() == b"test-private-chatgpt-auth"
    target_metadata = target.stat()
    assert stat.S_IMODE(target_metadata.st_mode) == 0o600
    assert target_metadata.st_nlink == 1
    assert not (target.parent / "runtime-residue").exists()


@pytest.mark.parametrize("forbidden_key", ["OPENAI_API_KEY", "CODEX_API_KEY"])
def test_enrollment_refuses_api_key_auth_before_exec(
    tmp_path: Path,
    forbidden_key: str,
) -> None:
    completed, audit, _, target = _run_enrollment(tmp_path, forbidden_key=forbidden_key)

    assert completed.returncode != 0
    assert forbidden_key in completed.stderr
    assert not audit.exists()
    assert not target.exists()


def test_enrollment_is_one_shot_and_never_replaces_the_durable_credential(
    tmp_path: Path,
) -> None:
    completed, audit, codex_home, target = _run_enrollment(
        tmp_path,
        preexisting_target=b"already-enrolled",
    )

    assert completed.returncode != 0
    assert "already enrolled" in completed.stderr
    assert not audit.exists(), "an enrolled target must be refused before device auth"
    assert not codex_home.exists() or not any(codex_home.iterdir())
    assert target.read_bytes() == b"already-enrolled"


def test_runtime_credential_requires_an_exact_writable_file_mount(tmp_path: Path) -> None:
    credential = tmp_path / "auth.json"
    credential.write_bytes(b"test-private-chatgpt-auth")
    credential.chmod(0o600)
    mountinfo = tmp_path / "mountinfo"
    mountinfo.write_text(
        f"42 21 0:31 /encrypted/auth.json {credential} "
        "rw,nosuid,nodev,noexec - ext4 /dev/mapper/nexus-codex-state rw\n",
        encoding="ascii",
    )

    require_writable_credential_mount(credential, mountinfo_path=mountinfo)

    mountinfo.write_text(
        f"42 21 0:31 /encrypted/auth.json {credential} "
        "ro,nosuid,nodev,noexec - ext4 /dev/mapper/nexus-codex-state rw\n",
        encoding="ascii",
    )
    with pytest.raises(RuntimeError, match="exact writable mount"):
        require_writable_credential_mount(credential, mountinfo_path=mountinfo)


def test_runtime_launcher_requires_one_private_executable_tmpfs(tmp_path: Path) -> None:
    runtime_root = tmp_path / "turns"
    runtime_root.mkdir(mode=0o700)
    mountinfo = tmp_path / "mountinfo"
    mountinfo.write_text(
        f"43 21 0:32 / {runtime_root} rw,nosuid,nodev - tmpfs tmpfs rw,size=16777216,mode=700\n",
        encoding="ascii",
    )

    require_private_executable_runtime_mount(runtime_root, mountinfo_path=mountinfo)

    mountinfo.write_text(
        f"43 21 0:32 / {runtime_root} rw,nosuid,nodev,noexec - tmpfs tmpfs "
        "rw,size=16777216,mode=700\n",
        encoding="ascii",
    )
    with pytest.raises(RuntimeError, match="private and executable"):
        require_private_executable_runtime_mount(runtime_root, mountinfo_path=mountinfo)


def test_pinned_refresh_is_power_synced_in_place_and_runtime_state_is_discarded(
    tmp_path: Path,
) -> None:
    credential = tmp_path / "auth.json"
    credential.write_bytes(b"initial-private-chatgpt-auth")
    credential.chmod(0o600)
    identity = enrolled_auth_identity(credential)
    turn_root = tmp_path / "turns"
    turn_root.mkdir(mode=0o700)
    runtime = create_ephemeral_runtime_paths(turn_root, "refresh")
    runtime_auth = link_runtime_auth(credential, runtime)

    assert runtime.temporary_directory == runtime.root / "tmp"
    assert runtime.temporary_directory.is_dir()
    assert stat.S_IMODE(runtime.temporary_directory.stat().st_mode) == 0o700

    with runtime_auth.open("wb") as pinned_save:
        pinned_save.write(b"rotated-private-chatgpt-auth")
        pinned_save.flush()
    sync_enrolled_auth_file(credential, expected_identity=identity)

    assert credential.read_bytes() == b"rotated-private-chatgpt-auth"
    remove_ephemeral_runtime_paths(runtime, root=turn_root)
    assert not runtime.working_directory.exists()
    assert not runtime.state_root_base.exists()
    assert not runtime.temporary_directory.exists()
    assert not runtime.root.exists()

    replacement = tmp_path / "replacement.json"
    replacement.write_bytes(b"rename-based-runtime-is-not-qualified")
    replacement.chmod(0o600)
    os.replace(replacement, credential)
    with pytest.raises(CredentialStateUnavailable, match="changed identity"):
        sync_enrolled_auth_file(credential, expected_identity=identity)
