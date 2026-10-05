"""Strict identities for immutable backend release artifacts."""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_SOURCE_SHA = re.compile(r"[0-9a-f]{40}")
_DATABASE_REVISION = re.compile(r"[0-9a-z][0-9a-z_]{0,63}")
_API_IMAGE = re.compile(r"ghcr\.io/nielsdawheelz/nexus-api@sha256:[0-9a-f]{64}")
_WORKER_IMAGE = re.compile(r"ghcr\.io/nielsdawheelz/nexus-worker@sha256:[0-9a-f]{64}")
_RUNTIME_IDENTITY_KEYS = frozenset({"source_sha", "expected_database_revision"})
_CANDIDATE_MANIFEST_KEYS = frozenset(
    {"schema_version", "source_sha", "repository", "images", "expected_database_revision"}
)
_REPOSITORY = "NielsdaWheelz/nexus-web"
_RUNTIME_IDENTITY_PATH = Path("/app/runtime-identity.json")


# justify-defect: malformed owned release artifacts are deployment defects, not modeled outcomes.
class BackendArtifactDefect(RuntimeError):
    """An owned release artifact violated its closed contract."""


@dataclass(frozen=True, slots=True)
class RuntimeIdentity:
    source_sha: str
    expected_database_revision: str

    def __post_init__(self) -> None:
        _require_match("source_sha", self.source_sha, _SOURCE_SHA)
        _require_match(
            "expected_database_revision",
            self.expected_database_revision,
            _DATABASE_REVISION,
        )

    def as_json(self) -> dict[str, object]:
        return {
            "source_sha": self.source_sha,
            "expected_database_revision": self.expected_database_revision,
        }


@dataclass(frozen=True, slots=True)
class CandidateImages:
    api: str
    worker: str

    def __post_init__(self) -> None:
        _require_match("api image", self.api, _API_IMAGE)
        _require_match("worker image", self.worker, _WORKER_IMAGE)

    def as_json(self) -> dict[str, object]:
        return {"api": self.api, "worker": self.worker}


@dataclass(frozen=True, slots=True)
class CandidateManifest:
    schema_version: int
    source_sha: str
    repository: str
    images: CandidateImages
    expected_database_revision: str

    def __post_init__(self) -> None:
        if type(self.schema_version) is not int or self.schema_version != 3:
            raise BackendArtifactDefect("candidate manifest schema_version must be 3")
        _require_match("source_sha", self.source_sha, _SOURCE_SHA)
        if self.repository != _REPOSITORY:
            raise BackendArtifactDefect("candidate manifest repository is malformed")
        if not isinstance(self.images, CandidateImages):
            raise BackendArtifactDefect("candidate manifest images are malformed")
        _require_match(
            "expected_database_revision",
            self.expected_database_revision,
            _DATABASE_REVISION,
        )

    def as_json(self) -> dict[str, object]:
        return {
            "schema_version": self.schema_version,
            "source_sha": self.source_sha,
            "repository": self.repository,
            "images": self.images.as_json(),
            "expected_database_revision": self.expected_database_revision,
        }


def build_runtime_identity(repo_root: Path, source_sha: str) -> RuntimeIdentity:
    """Derive the image identity from the exact checked-out release inputs."""
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    _require_match("source_sha", source_sha, _SOURCE_SHA)
    migration_config = Config(str(repo_root / "migrations/alembic.ini"))
    migration_config.set_main_option("script_location", str(repo_root / "migrations/alembic"))
    heads = ScriptDirectory.from_config(migration_config).get_heads()
    if len(heads) != 1:
        raise BackendArtifactDefect(f"expected one Alembic head, found {heads!r}")
    return RuntimeIdentity(source_sha=source_sha, expected_database_revision=heads[0])


def write_runtime_identity(repo_root: Path, source_sha: str, output_path: Path) -> None:
    write_runtime_identity_value(build_runtime_identity(repo_root, source_sha), output_path)


def write_runtime_identity_value(identity: RuntimeIdentity, output_path: Path) -> None:
    output_path.write_bytes(_canonical_json_bytes(identity.as_json()))


def load_runtime_identity(path: Path) -> RuntimeIdentity:
    value, encoded = _load_closed_json(path)
    if not isinstance(value, dict) or value.keys() != _RUNTIME_IDENTITY_KEYS:
        raise BackendArtifactDefect("runtime identity has unsupported fields")
    identity = RuntimeIdentity(
        source_sha=_require_string(value, "source_sha"),
        expected_database_revision=_require_string(value, "expected_database_revision"),
    )
    if encoded != _canonical_json_bytes(identity.as_json()):
        raise BackendArtifactDefect("runtime identity is not canonical JSON")
    return identity


def load_candidate_manifest(path: Path) -> CandidateManifest:
    value, encoded = _load_closed_json(path)
    if not isinstance(value, dict) or value.keys() != _CANDIDATE_MANIFEST_KEYS:
        raise BackendArtifactDefect("candidate manifest fields are unsupported")
    if value["schema_version"] != 3:
        raise BackendArtifactDefect("candidate manifest schema_version is unsupported")
    images = value["images"]
    if not isinstance(images, dict) or images.keys() != {"api", "worker"}:
        raise BackendArtifactDefect("candidate manifest image fields are unsupported")
    candidate = CandidateManifest(
        schema_version=value["schema_version"],
        source_sha=_require_string(value, "source_sha"),
        repository=_require_string(value, "repository"),
        images=CandidateImages(
            api=_require_string(images, "api"),
            worker=_require_string(images, "worker"),
        ),
        expected_database_revision=_require_string(value, "expected_database_revision"),
    )
    if encoded != _canonical_json_bytes(candidate.as_json()):
        raise BackendArtifactDefect("candidate manifest is not canonical JSON")
    return candidate


def write_candidate_manifest(
    *,
    source_sha: str,
    api_image: str,
    worker_image: str,
    api_runtime_identity_path: Path,
    worker_runtime_identity_path: Path,
    output_path: Path,
) -> None:
    _require_match("source_sha", source_sha, _SOURCE_SHA)
    images = CandidateImages(api=api_image, worker=worker_image)

    api_identity = load_runtime_identity(api_runtime_identity_path)
    worker_identity = load_runtime_identity(worker_runtime_identity_path)
    if api_identity != worker_identity:
        raise BackendArtifactDefect("API and worker runtime identities must be identical")
    if api_identity.source_sha != source_sha:
        raise BackendArtifactDefect("runtime identity does not match the source SHA")

    manifest = CandidateManifest(
        schema_version=3,
        source_sha=source_sha,
        repository=_REPOSITORY,
        images=images,
        expected_database_revision=api_identity.expected_database_revision,
    )
    output_path.write_bytes(_canonical_json_bytes(manifest.as_json()))


def _canonical_json_bytes(value: object) -> bytes:
    return (
        json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True) + "\n"
    ).encode("utf-8")


def _load_closed_json(path: Path) -> tuple[object, bytes]:
    try:
        encoded = path.read_bytes()
        return json.loads(encoded, object_pairs_hook=_unique_object), encoded
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise BackendArtifactDefect(f"could not read release artifact {path}") from exc


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise BackendArtifactDefect(f"duplicate JSON key {key!r}")
        value[key] = item
    return value


def _require_string(value: dict[str, Any], key: str) -> str:
    item = value[key]
    if not isinstance(item, str):
        raise BackendArtifactDefect(f"{key} must be a string")
    return item


def _require_match(name: str, value: object, pattern: re.Pattern[str]) -> None:
    if not isinstance(value, str) or pattern.fullmatch(value) is None:
        raise BackendArtifactDefect(f"{name} is malformed")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    runtime = commands.add_parser("write-runtime-identity")
    runtime.add_argument("--repo-root", type=Path, required=True)
    runtime.add_argument("--source-sha", required=True)
    runtime.add_argument("--output", type=Path, required=True)

    printed = commands.add_parser("print-runtime-identity")
    printed.add_argument("--path", type=Path, default=_RUNTIME_IDENTITY_PATH)

    candidate = commands.add_parser("write-candidate-manifest")
    candidate.add_argument("--source-sha", required=True)
    candidate.add_argument("--api-image", required=True)
    candidate.add_argument("--worker-image", required=True)
    candidate.add_argument("--api-runtime-identity", type=Path, required=True)
    candidate.add_argument("--worker-runtime-identity", type=Path, required=True)
    candidate.add_argument("--output", type=Path, required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.command == "write-runtime-identity":
        write_runtime_identity(args.repo_root, args.source_sha, args.output)
    elif args.command == "print-runtime-identity":
        identity = load_runtime_identity(args.path)
        sys.stdout.buffer.write(_canonical_json_bytes(identity.as_json()))
    elif args.command == "write-candidate-manifest":
        write_candidate_manifest(
            source_sha=args.source_sha,
            api_image=args.api_image,
            worker_image=args.worker_image,
            api_runtime_identity_path=args.api_runtime_identity,
            worker_runtime_identity_path=args.worker_runtime_identity,
            output_path=args.output,
        )
    else:
        raise AssertionError(f"unsupported command {args.command!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
