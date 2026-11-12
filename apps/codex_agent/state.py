"""The private, monotone identity of one exclusively owned native container.

Only enrollment initializes it. Every container startup advances it before any
listener or native process exists. Database restoration must never rewind it.
"""

from __future__ import annotations

import os
import stat
import tempfile
from pathlib import Path
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field


class HostState(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)

    host_id: UUID
    incarnation: int = Field(ge=0)


def initialize(account: Path) -> None:
    """Explicit first installation; never replace an existing host identity."""
    path = account / "host-state.json"
    value = HostState(host_id=uuid4(), incarnation=0)
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as stream:
        stream.write(value.model_dump_json())
        stream.flush()
        os.fsync(stream.fileno())
    directory = os.open(account, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def read(account: Path) -> HostState:
    path = account / "host-state.json"
    if stat.S_IMODE(path.stat().st_mode) != 0o600:
        raise ValueError("native host state must be mode 0600")
    return HostState.model_validate_json(path.read_bytes())


def advance(account: Path) -> HostState:
    """The deployment owner guarantees the previous container is gone."""
    path = account / "host-state.json"
    previous = read(account)
    value = HostState(host_id=previous.host_id, incarnation=previous.incarnation + 1)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=account, delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(value.model_dump_json())
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(account, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return value


if __name__ == "__main__":
    initialize(Path(os.environ["NEXUS_CODEX_CREDENTIAL_FILE"]).parent)
