"""One-way enrollment and narrow durable Codex credential-state access."""

from __future__ import annotations

import os
import shutil
import stat
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

CODEX_PROFILE_KEY = "codex-personal"
CODEX_ENROLLED_AUTH_RELATIVE_PATH = Path("codex") / CODEX_PROFILE_KEY / "auth.json"
MAX_CODEX_AUTH_BYTES = 64 * 1024


class CredentialStateUnavailable(RuntimeError):
    """The enrolled credential cannot be used by ephemeral runtime state."""


@dataclass(frozen=True, slots=True)
class CredentialFileIdentity:
    device: int
    inode: int


@dataclass(frozen=True, slots=True)
class EphemeralRuntimePaths:
    root: Path
    working_directory: Path
    state_root_base: Path
    temporary_directory: Path


def create_ephemeral_runtime_paths(root: Path, scope: str) -> EphemeralRuntimePaths:
    """Create one private runtime-state/cwd/tmp tree beneath the host tmpfs root."""

    if not scope or "/" in scope or scope in {".", ".."}:
        raise ValueError("Codex runtime scope must be one safe path component")
    runtime_root = root / f"{scope}-{uuid4().hex}"
    working_directory = runtime_root / "workspace"
    state_root_base = runtime_root / "state"
    temporary_directory = runtime_root / "tmp"
    try:
        runtime_root.mkdir(mode=0o700)
        working_directory.mkdir(mode=0o700)
        state_root_base.mkdir(mode=0o700)
        temporary_directory.mkdir(mode=0o700)
        for path in (
            runtime_root,
            working_directory,
            state_root_base,
            temporary_directory,
        ):
            metadata = path.lstat()
            if not stat.S_ISDIR(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) != 0o700:
                raise RuntimeError("Codex ephemeral runtime directory is not private")
    except BaseException:
        shutil.rmtree(runtime_root, ignore_errors=True)
        raise
    return EphemeralRuntimePaths(
        root=runtime_root,
        working_directory=working_directory,
        state_root_base=state_root_base,
        temporary_directory=temporary_directory,
    )


def remove_ephemeral_runtime_paths(paths: EphemeralRuntimePaths, *, root: Path) -> None:
    """Remove the complete request-local credential, runtime, and cwd state."""

    if paths.root.parent != root or not paths.root.name:
        raise RuntimeError("Codex ephemeral runtime root escaped its owner")
    if (
        paths.working_directory != paths.root / "workspace"
        or paths.state_root_base != paths.root / "state"
        or paths.temporary_directory != paths.root / "tmp"
    ):
        raise RuntimeError("Codex ephemeral runtime paths changed ownership")
    shutil.rmtree(paths.root)


def validate_enrolled_auth_file(path: Path) -> None:
    """Validate the exact opaque credential artifact without printing its contents."""

    descriptor = _open_enrolled_auth(path)
    os.close(descriptor)


def enrolled_auth_identity(path: Path) -> CredentialFileIdentity:
    """Capture the exact enrolled inode before a pinned runtime may refresh it."""

    descriptor = _open_enrolled_auth(path)
    try:
        metadata = os.fstat(descriptor)
        return CredentialFileIdentity(device=metadata.st_dev, inode=metadata.st_ino)
    finally:
        os.close(descriptor)


def sync_enrolled_auth_file(
    path: Path,
    *,
    expected_identity: CredentialFileIdentity,
) -> None:
    """Power-sync an in-place refresh and re-prove its exact file identity."""

    descriptor = _open_enrolled_auth(path, writable=True)
    try:
        metadata = os.fstat(descriptor)
        if (metadata.st_dev, metadata.st_ino) != (
            expected_identity.device,
            expected_identity.inode,
        ):
            raise CredentialStateUnavailable("enrolled Codex credential changed identity")
        try:
            os.fsync(descriptor)
        except OSError as error:
            raise CredentialStateUnavailable(
                "enrolled Codex credential could not be synchronized"
            ) from error
    finally:
        os.close(descriptor)
    if enrolled_auth_identity(path) != expected_identity:
        raise CredentialStateUnavailable("enrolled Codex credential changed identity")


def require_writable_credential_mount(
    path: Path,
    *,
    mountinfo_path: Path = Path("/proc/self/mountinfo"),
) -> None:
    """Require the credential artifact itself to be one exact writable mount."""

    validate_enrolled_auth_file(path)
    try:
        lines = mountinfo_path.read_text(encoding="ascii").splitlines()
    except (OSError, UnicodeDecodeError) as error:
        raise RuntimeError("Codex credential mount evidence is unavailable") from error
    matches: list[tuple[str, ...]] = []
    for line in lines:
        fields = tuple(line.split())
        if len(fields) >= 10 and fields[4] == str(path) and "-" in fields[6:]:
            matches.append(fields)
    if len(matches) != 1 or "rw" not in matches[0][5].split(","):
        raise RuntimeError("Codex credential file must be an exact writable mount")
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    except OSError as error:
        raise RuntimeError("Codex credential file mount is not writable") from error
    os.close(descriptor)


def require_private_executable_runtime_mount(
    path: Path,
    *,
    mountinfo_path: Path = Path("/proc/self/mountinfo"),
) -> None:
    """Require the private executable tmpfs used by the native sandbox."""

    try:
        metadata = path.lstat()
        resolved = path.resolve()
        lines = mountinfo_path.read_text(encoding="ascii").splitlines()
    except (OSError, UnicodeDecodeError) as error:
        raise RuntimeError("Codex runtime mount evidence is unavailable") from error
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or stat.S_IMODE(metadata.st_mode) != 0o700
        or metadata.st_uid != os.geteuid()
        or resolved != path
    ):
        raise RuntimeError("Codex runtime mount is not private")
    matches: list[tuple[tuple[str, ...], int]] = []
    for line in lines:
        fields = tuple(line.split())
        try:
            separator = fields.index("-")
        except ValueError:
            continue
        if len(fields) > separator + 1 and len(fields) >= 6 and fields[4] == str(path):
            matches.append((fields, separator))
    if len(matches) != 1:
        raise RuntimeError("Codex runtime root must be one exact tmpfs mount")
    fields, separator = matches[0]
    options = frozenset(fields[5].split(","))
    if (
        fields[separator + 1] != "tmpfs"
        or not {"rw", "nosuid", "nodev"}.issubset(options)
        or "ro" in options
        or "noexec" in options
    ):
        raise RuntimeError("Codex runtime tmpfs must be private and executable")


def link_runtime_auth(
    enrolled_auth_file: Path,
    runtime: EphemeralRuntimePaths,
) -> Path:
    """Link pinned Codex auth writes to the sole durable credential artifact."""

    try:
        validate_enrolled_auth_file(enrolled_auth_file)
        profile_root = runtime.state_root_base / "codex" / CODEX_PROFILE_KEY
        profile_root.mkdir(parents=True, mode=0o700)
        for directory in (profile_root.parent, profile_root):
            directory.chmod(0o700)
            metadata = directory.lstat()
            if not stat.S_ISDIR(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) != 0o700:
                raise CredentialStateUnavailable("ephemeral Codex profile is not private")
        destination = profile_root / "auth.json"
        destination.symlink_to(enrolled_auth_file)
        validate_runtime_auth_link(destination, enrolled_auth_file)
        return destination
    except CredentialStateUnavailable:
        raise
    except OSError as error:
        raise CredentialStateUnavailable("enrolled Codex credential could not be linked") from error


def validate_runtime_auth_link(path: Path, enrolled_auth_file: Path) -> None:
    """Prove the pinned runtime still addresses the exact durable auth file."""

    try:
        metadata = path.lstat()
        target = Path(os.readlink(path))
    except OSError as error:
        raise CredentialStateUnavailable("ephemeral Codex auth link is unavailable") from error
    if not stat.S_ISLNK(metadata.st_mode) or target != enrolled_auth_file:
        raise CredentialStateUnavailable("ephemeral Codex auth link changed identity")
    validate_enrolled_auth_file(enrolled_auth_file)


def install_enrolled_auth(staged_auth_file: Path, target: Path) -> None:
    """Atomically install the first enrolled auth artifact without replacement."""

    descriptor = _open_enrolled_auth(staged_auth_file)
    try:
        payload = _read_bounded(descriptor)
    finally:
        os.close(descriptor)
    _prepare_private_parent(target.parent)
    temporary = target.with_name(f".{target.name}.enrolling-{uuid4().hex}")
    try:
        _write_new_private_file(temporary, payload)
        try:
            os.link(temporary, target, follow_symlinks=False)
        except FileExistsError as error:
            raise RuntimeError("Codex credential target is already enrolled") from error
        directory = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)
    validate_enrolled_auth_file(target)


def require_unenrolled_target(target: Path) -> None:
    """Fail before interactive login when the one-shot target already exists."""

    _reject_symlink_components(target.parent)
    if target.exists() or target.is_symlink():
        raise RuntimeError("Codex credential target is already enrolled")


def _open_enrolled_auth(path: Path, *, writable: bool = False) -> int:
    if not path.is_absolute() or Path(os.path.normpath(str(path))) != path:
        raise CredentialStateUnavailable("Codex credential file must be normalized and absolute")
    _reject_symlink_components(path.parent)
    try:
        initial = path.lstat()
        access = os.O_WRONLY if writable else os.O_RDONLY
        descriptor = os.open(path, access | os.O_CLOEXEC | os.O_NOFOLLOW)
    except OSError as error:
        raise CredentialStateUnavailable("enrolled Codex credential is unavailable") from error
    try:
        current = os.fstat(descriptor)
        if (
            not stat.S_ISREG(initial.st_mode)
            or (initial.st_dev, initial.st_ino) != (current.st_dev, current.st_ino)
            or current.st_uid != os.geteuid()
            or current.st_gid != os.getegid()
            or stat.S_IMODE(current.st_mode) != 0o600
            or current.st_nlink != 1
            or not 0 < current.st_size <= MAX_CODEX_AUTH_BYTES
        ):
            raise CredentialStateUnavailable("enrolled Codex credential has unsafe metadata")
    except BaseException:
        os.close(descriptor)
        raise
    return descriptor


def _read_bounded(descriptor: int) -> bytes:
    payload = bytearray()
    while chunk := os.read(descriptor, 16 * 1024):
        payload.extend(chunk)
        if len(payload) > MAX_CODEX_AUTH_BYTES:
            raise CredentialStateUnavailable("enrolled Codex credential exceeds its byte bound")
    if not payload:
        raise CredentialStateUnavailable("enrolled Codex credential is empty")
    return bytes(payload)


def _write_new_private_file(path: Path, payload: bytes) -> None:
    try:
        descriptor = os.open(
            path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
            0o600,
        )
    except OSError as error:
        raise CredentialStateUnavailable(
            "private Codex credential copy could not be created"
        ) from error
    try:
        offset = 0
        while offset < len(payload):
            offset += os.write(descriptor, payload[offset:])
        os.fsync(descriptor)
        os.fchmod(descriptor, 0o600)
    finally:
        os.close(descriptor)


def _prepare_private_parent(path: Path) -> None:
    missing: list[Path] = []
    owner = path
    while not owner.exists():
        missing.append(owner)
        owner = owner.parent
    _reject_symlink_components(owner)
    metadata = owner.lstat()
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or metadata.st_uid != os.geteuid()
        or metadata.st_gid != os.getegid()
        or stat.S_IMODE(metadata.st_mode) != 0o700
    ):
        raise RuntimeError("Codex credential-state root must be private and process-owned")
    for directory in reversed(missing):
        directory.mkdir(mode=0o700)
    _reject_symlink_components(path)
    for directory in missing:
        metadata = directory.lstat()
        if (
            not stat.S_ISDIR(metadata.st_mode)
            or metadata.st_uid != os.geteuid()
            or metadata.st_gid != os.getegid()
            or stat.S_IMODE(metadata.st_mode) != 0o700
        ):
            raise RuntimeError("Codex credential parent must be private and process-owned")


def _reject_symlink_components(path: Path) -> None:
    current = Path(path.anchor)
    for component in path.parts[1:]:
        current /= component
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            return
        if stat.S_ISLNK(metadata.st_mode):
            raise CredentialStateUnavailable("Codex credential path must not traverse symlinks")
