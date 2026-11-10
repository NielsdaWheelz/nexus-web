"""The closed web candidate and literal environment formats."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import asdict, dataclass
from pathlib import Path

NODE_VERSION = "22.23.2"
BUN_VERSION = "1.3.14"


class ArtifactError(ValueError):
    """A candidate or its captured configuration violates the deployment contract."""


@dataclass(frozen=True, slots=True)
class Manifest:
    source_sha: str
    archive_sha256: str
    config_sha256: str
    node_version: str

    def __post_init__(self) -> None:
        for name, value, length in (
            ("source_sha", self.source_sha, 40),
            ("archive_sha256", self.archive_sha256, 64),
            ("config_sha256", self.config_sha256, 64),
        ):
            if not isinstance(value, str) or re.fullmatch(rf"[0-9a-f]{{{length}}}", value) is None:
                raise ArtifactError(
                    f"{name} must contain exactly {length} lowercase hex characters"
                )
        if self.node_version != NODE_VERSION:
            raise ArtifactError(f"node_version must be {NODE_VERSION}")

    def to_bytes(self) -> bytes:
        return (json.dumps(asdict(self), sort_keys=True, separators=(",", ":")) + "\n").encode(
            "utf-8"
        )

    def digest(self) -> str:
        return hashlib.sha256(self.to_bytes()).hexdigest()


def load_manifest(path: Path) -> Manifest:
    encoded = path.read_bytes()
    try:
        value = json.loads(encoded)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ArtifactError("candidate manifest must contain utf-8 json") from exc
    if not isinstance(value, dict) or value.keys() != {
        "source_sha",
        "archive_sha256",
        "config_sha256",
        "node_version",
    }:
        raise ArtifactError("candidate manifest fields are unsupported")
    manifest = Manifest(**value)
    if encoded != manifest.to_bytes():
        raise ArtifactError("candidate manifest must use canonical json")
    return manifest


def sha256_file(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def parse_env(encoded: bytes) -> dict[str, str]:
    """Parse literal single-line KEY=value inputs, never shell expansion or escapes."""
    try:
        document = encoded.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ArtifactError("environment must be utf-8") from exc
    if any(
        (ord(character) < 32 and character != "\n") or ord(character) == 127
        for character in document
    ):
        raise ArtifactError("environment contains control characters")
    values: dict[str, str] = {}
    for number, line in enumerate(document.split("\n"), 1):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        key, separator, value = line.partition("=")
        if not separator or re.fullmatch(r"[A-Z][A-Z0-9_]*", key) is None:
            raise ArtifactError(f"environment line {number} must be KEY=value")
        if key in values:
            raise ArtifactError(f"environment contains duplicate key {key}")
        value = value.strip()
        if value.startswith(("'", '"')):
            if len(value) < 2 or value[-1] != value[0] or value[0] in value[1:-1]:
                raise ArtifactError(f"environment line {number} has invalid literal quoting")
            value = value[1:-1]
        elif "'" in value or '"' in value:
            raise ArtifactError(f"environment line {number} has invalid literal quoting")
        if "\\" in value:
            raise ArtifactError(f"environment line {number} contains escapes")
        values[key] = value
    return values
