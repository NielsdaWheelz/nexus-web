"""Host-only enrolled profile state; native Codex owns atomic auth refresh."""

from __future__ import annotations

import os
import stat
from pathlib import Path
from uuid import uuid4

MAX_CODEX_AUTH_BYTES = 64 * 1024


class CredentialStateUnavailable(RuntimeError):
    """The enrolled host account state is unavailable or not private."""


def validate_enrolled_auth_file(path: Path) -> None:
    """Check opaque credential metadata without copying or printing its contents."""

    descriptor = _open_enrolled_auth(path)
    os.close(descriptor)
    parent = path.parent.stat()
    if (
        not stat.S_ISDIR(parent.st_mode)
        or parent.st_uid != os.geteuid()
        or parent.st_gid != os.getegid()
        or stat.S_IMODE(parent.st_mode) != 0o700
        or not os.access(path.parent, os.W_OK)
    ):
        raise CredentialStateUnavailable("Codex account directory must be private and writable")


def require_unenrolled_target(target: Path) -> None:
    if target.exists() or target.is_symlink():
        raise RuntimeError("Codex credential target is already enrolled")


def install_enrolled_auth(staged_auth_file: Path, target: Path) -> None:
    """Install the first account artifact atomically, without replacing enrollment."""

    descriptor = _open_enrolled_auth(staged_auth_file)
    try:
        payload = os.read(descriptor, MAX_CODEX_AUTH_BYTES + 1)
    finally:
        os.close(descriptor)
    if not 0 < len(payload) <= MAX_CODEX_AUTH_BYTES:
        raise CredentialStateUnavailable("Codex credential exceeds its byte bound")
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    parent = target.parent.stat()
    if parent.st_uid != os.geteuid() or stat.S_IMODE(parent.st_mode) != 0o700:
        raise CredentialStateUnavailable(
            "Codex account directory must be private and process-owned"
        )
    temporary = target.with_name(f".{target.name}.enrolling-{uuid4().hex}")
    try:
        with temporary.open("xb") as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(temporary, target, follow_symlinks=False)
        except FileExistsError as error:
            raise RuntimeError("Codex credential target is already enrolled") from error
        descriptor = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        temporary.unlink(missing_ok=True)
    validate_enrolled_auth_file(target)


def _open_enrolled_auth(path: Path) -> int:
    if not path.is_absolute() or Path(os.path.normpath(str(path))) != path:
        raise CredentialStateUnavailable("Codex credential file must be normalized and absolute")
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    except OSError as error:
        raise CredentialStateUnavailable("enrolled Codex credential is unavailable") from error
    metadata = os.fstat(descriptor)
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != os.geteuid()
        or metadata.st_gid != os.getegid()
        or stat.S_IMODE(metadata.st_mode) != 0o600
        or not 0 < metadata.st_size <= MAX_CODEX_AUTH_BYTES
    ):
        os.close(descriptor)
        raise CredentialStateUnavailable("enrolled Codex credential has unsafe metadata")
    return descriptor
