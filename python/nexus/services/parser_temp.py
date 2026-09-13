"""Attempt-scoped filesystem materialization and output sizing for bounded media parsers."""

from __future__ import annotations

import errno
import hashlib
import shutil
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from pathlib import Path
from uuid import UUID, uuid4

from nexus.config import get_settings
from nexus.storage.client import StorageClientBase, StorageError


class StorageObjectSizeMismatch(AssertionError):
    pass


@contextmanager
def parser_attempt_directory(attempt_id: UUID) -> Iterator[Path]:
    """Yield one private run beneath an attempt owner without racing a peer run."""
    attempt_root = get_settings().parser_temp_root / str(attempt_id)
    attempt_root.mkdir(parents=True, mode=0o700, exist_ok=True)
    if attempt_root.is_symlink() or not attempt_root.is_dir():
        raise RuntimeError("parser attempt root is not a real directory")
    attempt_root.chmod(0o700)
    attempt_directory = attempt_root / str(uuid4())
    attempt_directory.mkdir(mode=0o700)
    try:
        yield attempt_directory
    finally:
        try:
            shutil.rmtree(attempt_directory)
        except FileNotFoundError:
            pass
        try:
            attempt_root.rmdir()
        except FileNotFoundError:
            pass
        except OSError as exc:
            if exc.errno != errno.ENOTEMPTY:
                raise


def stream_storage_object_to_file(
    storage_client: StorageClientBase,
    *,
    storage_path: str,
    destination: Path,
    expected_size_bytes: int,
) -> str:
    """Materialize exactly the persisted byte length and return its SHA-256."""
    if expected_size_bytes < 0:
        raise ValueError("expected storage object size cannot be negative")
    digest = hashlib.sha256()
    streamed_size_bytes = 0
    try:
        with destination.open("xb") as output:
            for chunk in storage_client.stream_object(storage_path):
                streamed_size_bytes += len(chunk)
                if streamed_size_bytes > expected_size_bytes:
                    raise StorageObjectSizeMismatch(
                        f"Storage object '{storage_path}' exceeds persisted byte length"
                    )
                digest.update(chunk)
                output.write(chunk)
        if streamed_size_bytes != expected_size_bytes:
            raise StorageObjectSizeMismatch(
                f"Storage object '{storage_path}' is shorter than persisted byte length"
            )
    except StorageError as exc:
        destination.unlink(missing_ok=True)
        raise StorageError(exc.message, exc.code) from exc
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    return digest.hexdigest()


def prune_stale_parser_temp(
    root: Path,
    *,
    operation_is_live: Callable[[UUID], bool],
) -> int:
    """Delete only UUID operation roots proven not to have live queue work."""
    if not root.exists():
        return 0
    removed = 0
    for path in root.iterdir():
        if not path.is_dir():
            continue
        try:
            operation_id = UUID(path.name)
        except ValueError:
            continue
        if operation_is_live(operation_id):
            continue
        shutil.rmtree(path)
        removed += 1
    return removed


def utf8_byte_length(value: str) -> int:
    """Count the encoded UTF-8 bytes of one already bounded text value."""
    return len(value.encode())


def nested_utf8_byte_length(value: object) -> int:
    """Count the UTF-8 bytes of every string reachable inside one parser output value."""
    if isinstance(value, str):
        return utf8_byte_length(value)
    if isinstance(value, Mapping):
        return sum(
            nested_utf8_byte_length(key) + nested_utf8_byte_length(item)
            for key, item in value.items()
        )
    if isinstance(value, Sequence):
        return sum(nested_utf8_byte_length(item) for item in value)
    return 0
