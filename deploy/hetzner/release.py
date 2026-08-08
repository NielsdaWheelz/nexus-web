#!/usr/bin/env python3
"""Durable, fail-closed owner of one immutable Nexus production release."""

from __future__ import annotations

import argparse
import contextlib
import dataclasses
import fcntl
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from collections.abc import Iterator
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Any

from nexus.release_artifact import (
    BackendArtifactDefect,
    CandidateManifest,
    RuntimeIdentity,
)
from nexus.release_artifact import (
    load_candidate_manifest as _load_candidate_manifest,
)

_SHA = re.compile(r"[0-9a-f]{40}\Z")
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_IMAGE_ID = re.compile(r"sha256:[0-9a-f]{64}\Z")
_IMAGE_REFERENCE = re.compile(r"[^\s@]+@sha256:[0-9a-f]{64}\Z")
_CONTAINER_ID = re.compile(r"[0-9a-f]{12,64}\Z")
_DATABASE_IDENTIFIER = re.compile(r"[a-z_][a-z0-9_]{0,62}\Z")
_DATABASE_REVISION = re.compile(r"[0-9a-z][0-9a-z_]{0,63}\Z")
_DEPLOYMENT_ID = re.compile(r"dpl_[A-Za-z0-9]+\Z")
_ORACLE_DIGEST = re.compile(r"sha256:[0-9a-f]{64}\Z")
_UUID = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-"
    r"[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z"
)
_HOST = re.compile(
    r"(?=.{1,253}\Z)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+"
    r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z"
)
_SERVICES = (
    "postgres",
    "caddy",
    "api",
    "worker-interactive",
    "worker-background",
)
_WRITERS = ("api", "worker-interactive", "worker-background")
_INFRASTRUCTURE_SERVICES = ("postgres", "caddy")
_INFRASTRUCTURE_VOLUME_TARGETS = {
    "postgres": {"/var/lib/postgresql/data": "nexus_postgres_data"},
    "caddy": {"/data": "nexus_caddy_data", "/config": "nexus_caddy_config"},
}
_ATTEMPT_FIELDS = frozenset(
    {
        "schema_version",
        "source_sha",
        "manifest_sha256",
        "candidate_api_image_id",
        "candidate_worker_image_id",
        "predecessor_sha",
        "forward_fix_of",
        "containers",
        "config_path",
        "config_sha256",
        "vercel_deployment_id",
        "production_host",
        "phase",
        "backup",
        "failure_code",
        "created_at",
        "updated_at",
    }
)
_CONTAINER_FIELDS = frozenset({"container_id", "image", "config_sha256"})
_BACKUP_FIELDS = frozenset(
    {"path", "sha256", "byte_count", "database_identity", "starting_revision"}
)
_ORACLE_ATTEMPT_FIELDS = frozenset(
    {
        "schema_version",
        "source_sha",
        "expected_manifest_digest",
        "config_path",
        "config_sha256",
        "prior_marker",
        "containers",
        "phase",
        "created_at",
        "updated_at",
    }
)
_ORACLE_REPAIR_FIELDS = frozenset(
    {
        "schema_version",
        "target_source_sha",
        "target_manifest_digest",
        "expected_database_revision",
        "repair_source_sha",
        "repair_manifest_sha256",
        "repair_api_image",
        "repair_worker_image",
        "repair_api_image_id",
        "repair_worker_image_id",
        "created_at",
    }
)
_ORACLE_STATUS_FIELDS = frozenset(
    {
        "status",
        "manifest_digest",
        "embedding_provider",
        "embedding_model",
        "support_ready",
        "published",
        "publication",
        "errors",
        "removals",
        "counts",
    }
)
_ORACLE_MARKER_FIELDS = frozenset(
    {"corpus_key", "manifest_digest", "embedding_provider", "embedding_model"}
)
_ORACLE_PRIOR_MARKER_PRESENT_FIELDS = frozenset(
    {"kind", "manifest_digest", "embedding_provider", "embedding_model"}
)
_ORACLE_REMOVAL_FIELDS = frozenset({"work_keys", "anchor_keys", "plate_source_urls"})
_ORACLE_COUNT_FIELDS = frozenset(
    {"works", "ready_media", "anchors", "resolved_anchors", "plates", "ready_plates"}
)
_RECORD_FIELDS = frozenset(
    {
        "schema_version",
        "source_sha",
        "manifest_sha256",
        "api_image",
        "worker_image",
        "api_image_id",
        "worker_image_id",
        "predecessor_sha",
        "config_path",
        "config_sha256",
        "database_revision",
        "expected_oracle_manifest_digest",
        "vercel_deployment_id",
        "production_host",
        "verified_at",
    }
)
_TERMINAL_PHASES = frozenset({"RolledBack", "Succeeded", "ForwardFixRequired"})
_BUNDLE_FILES = frozenset(
    {
        "Caddyfile",
        "candidate-manifest.json",
        "docker-compose.yml",
        "release.py",
        "python/nexus/__init__.py",
        "python/nexus/release_artifact.py",
    }
)
# justify-retry-schedule: release provider/host effects retry exactly once under
# the same durable semantic checkpoint before retry exhaustion defects.
_EXTERNAL_ATTEMPTS = 2
_EXTERNAL_RETRY_DELAY_SECONDS = 2
_DATABASE_ANCESTRY_SCRIPT = """
import json
import sys

from alembic.config import Config
from alembic.script import ScriptDirectory

config = Config('/app/migrations/alembic.ini')
config.set_main_option('script_location', '/app/migrations/alembic')
scripts = ScriptDirectory.from_config(config)
current_revision = sys.argv[1]
candidate_head = sys.argv[2]
heads = scripts.get_heads()
is_ancestor = False
if heads == [candidate_head]:
    if current_revision == candidate_head:
        is_ancestor = True
    else:
        try:
            tuple(scripts.iterate_revisions(candidate_head, current_revision))
        except Exception:
            pass
        else:
            is_ancestor = True
print(json.dumps({
    'candidate_head': candidate_head,
    'current_revision': current_revision,
    'heads': heads,
    'is_ancestor': is_ancestor,
}, separators=(',', ':'), sort_keys=True))
""".strip()


# justify-defect: malformed release artifacts and impossible histories are operator defects.
class ReleaseDefect(RuntimeError):
    """The owned release state or candidate contract is malformed."""


class ReleaseBlocked(RuntimeError):
    """A valid durable release history prevents the requested mutation."""


class ExternalCommandFailed(RuntimeError):
    """A bounded external release operation failed without proving permanence."""

    def __init__(self, message: str, *, operation: str | None = None) -> None:
        super().__init__(message)
        self.operation = operation or message


class PermanentReleaseFailure(RuntimeError):
    """The candidate cannot safely continue at its current durable boundary."""


class _RejectRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: Any,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> None:
        del req, fp, code, msg, headers, newurl
        raise PermanentReleaseFailure("public proof redirected")


class ReleasePhase(StrEnum):
    Prepared = "Prepared"
    WritersStopped = "WritersStopped"
    BackupVerified = "BackupVerified"
    DataMutationStarted = "DataMutationStarted"
    BackendActivationStarted = "BackendActivationStarted"
    AwaitingFrontendPromotion = "AwaitingFrontendPromotion"
    FrontendPromoted = "FrontendPromoted"
    RollbackRequired = "RollbackRequired"
    ForwardFixPending = "ForwardFixPending"
    RolledBack = "RolledBack"
    Succeeded = "Succeeded"
    ForwardFixRequired = "ForwardFixRequired"


class OraclePhase(StrEnum):
    Prepared = "Prepared"
    WritersStopped = "WritersStopped"
    Unpublished = "Unpublished"
    SupportReconciled = "SupportReconciled"
    Published = "Published"
    RuntimeRestored = "RuntimeRestored"
    Succeeded = "Succeeded"


_TRANSITIONS: dict[ReleasePhase, frozenset[ReleasePhase]] = {
    ReleasePhase.Prepared: frozenset(
        {
            ReleasePhase.WritersStopped,
            ReleasePhase.RollbackRequired,
            ReleasePhase.ForwardFixPending,
        }
    ),
    ReleasePhase.WritersStopped: frozenset(
        {
            ReleasePhase.BackupVerified,
            ReleasePhase.BackendActivationStarted,
            ReleasePhase.RollbackRequired,
            ReleasePhase.ForwardFixPending,
        }
    ),
    ReleasePhase.BackupVerified: frozenset(
        {
            ReleasePhase.DataMutationStarted,
            ReleasePhase.RollbackRequired,
            ReleasePhase.ForwardFixPending,
        }
    ),
    ReleasePhase.DataMutationStarted: frozenset(
        {ReleasePhase.BackendActivationStarted, ReleasePhase.ForwardFixPending}
    ),
    ReleasePhase.BackendActivationStarted: frozenset(
        {
            ReleasePhase.AwaitingFrontendPromotion,
            ReleasePhase.ForwardFixPending,
        }
    ),
    ReleasePhase.AwaitingFrontendPromotion: frozenset(
        {ReleasePhase.FrontendPromoted, ReleasePhase.ForwardFixPending}
    ),
    ReleasePhase.FrontendPromoted: frozenset(
        {ReleasePhase.Succeeded, ReleasePhase.ForwardFixPending}
    ),
    ReleasePhase.RollbackRequired: frozenset({ReleasePhase.RolledBack}),
    ReleasePhase.ForwardFixPending: frozenset({ReleasePhase.ForwardFixRequired}),
    ReleasePhase.RolledBack: frozenset(),
    ReleasePhase.Succeeded: frozenset(),
    ReleasePhase.ForwardFixRequired: frozenset(),
}

_ORACLE_TRANSITIONS: dict[OraclePhase, frozenset[OraclePhase]] = {
    OraclePhase.Prepared: frozenset({OraclePhase.WritersStopped}),
    OraclePhase.WritersStopped: frozenset({OraclePhase.Unpublished}),
    OraclePhase.Unpublished: frozenset({OraclePhase.SupportReconciled}),
    OraclePhase.SupportReconciled: frozenset({OraclePhase.Published}),
    OraclePhase.Published: frozenset({OraclePhase.RuntimeRestored}),
    OraclePhase.RuntimeRestored: frozenset({OraclePhase.Succeeded}),
    OraclePhase.Succeeded: frozenset(),
}


@dataclass(frozen=True, slots=True)
class ReleasePaths:
    state_root: Path = Path("/var/lib/nexus/releases")
    bundle_root: Path = Path("/opt/nexus/releases")
    config_root: Path = Path("/etc/nexus/config")
    current_config: Path = Path("/etc/nexus/current.env")
    caddy_config: Path = Path("/etc/nexus/Caddyfile")
    backup_root: Path = Path("/var/backups/nexus")
    lock_path: Path = Path("/run/lock/nexus-release.lock")

    @classmethod
    def under(cls, root: Path) -> ReleasePaths:
        return cls(
            state_root=root / "var/lib/nexus/releases",
            bundle_root=root / "opt/nexus/releases",
            config_root=root / "etc/nexus/config",
            current_config=root / "etc/nexus/current.env",
            caddy_config=root / "etc/nexus/Caddyfile",
            backup_root=root / "var/backups/nexus",
            lock_path=root / "run/lock/nexus-release.lock",
        )

    @property
    def attempts(self) -> Path:
        return self.state_root / "attempts"

    @property
    def oracle_attempts(self) -> Path:
        return self.state_root / "oracle-attempts"

    @property
    def oracle_repairs(self) -> Path:
        return self.state_root / "oracle-repairs"

    @property
    def records(self) -> Path:
        return self.state_root / "records"

    @property
    def current(self) -> Path:
        return self.state_root / "current"

    @property
    def forward_fix(self) -> Path:
        return self.state_root / "forward-fix"


@dataclass(frozen=True, slots=True)
class ContainerEvidence:
    container_id: str
    image: str
    config_sha256: str

    def __post_init__(self) -> None:
        _require_match("container id", self.container_id, _CONTAINER_ID)
        if not (_IMAGE_ID.fullmatch(self.image) or _IMAGE_REFERENCE.fullmatch(self.image)):
            raise ReleaseDefect("container image must be an immutable digest")
        _require_match("container config SHA-256", self.config_sha256, _SHA256)

    def as_json(self) -> dict[str, object]:
        return dataclasses.asdict(self)

    @classmethod
    def from_json(cls, value: object) -> ContainerEvidence:
        mapping = _closed_mapping(value, _CONTAINER_FIELDS, "container evidence")
        return cls(
            container_id=_string(mapping, "container_id"),
            image=_string(mapping, "image"),
            config_sha256=_string(mapping, "config_sha256"),
        )


@dataclass(frozen=True, slots=True)
class OracleMarkerAbsent:
    def as_json(self) -> dict[str, object]:
        return {"kind": "Absent"}


@dataclass(frozen=True, slots=True)
class OracleMarkerPresent:
    manifest_digest: str
    embedding_provider: str
    embedding_model: str

    def __post_init__(self) -> None:
        _require_match(
            "Oracle publication manifest digest",
            self.manifest_digest,
            _ORACLE_DIGEST,
        )
        for label, value in (
            ("embedding provider", self.embedding_provider),
            ("embedding model", self.embedding_model),
        ):
            if (
                not value
                or len(value) > 128
                or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]*", value) is None
            ):
                raise ReleaseDefect(f"Oracle {label} is malformed")

    def as_json(self) -> dict[str, object]:
        return {
            "kind": "Present",
            "manifest_digest": self.manifest_digest,
            "embedding_provider": self.embedding_provider,
            "embedding_model": self.embedding_model,
        }


OraclePriorMarker = OracleMarkerAbsent | OracleMarkerPresent


def _oracle_prior_marker_from_json(value: object) -> OraclePriorMarker:
    mapping = _mapping(value, "Oracle prior marker")
    kind = mapping.get("kind")
    if kind == "Absent":
        if mapping.keys() != {"kind"}:
            raise ReleaseDefect("absent Oracle prior marker fields are unsupported")
        return OracleMarkerAbsent()
    if kind == "Present":
        present = _closed_mapping(
            mapping,
            _ORACLE_PRIOR_MARKER_PRESENT_FIELDS,
            "present Oracle prior marker",
        )
        return OracleMarkerPresent(
            manifest_digest=_string(present, "manifest_digest"),
            embedding_provider=_string(present, "embedding_provider"),
            embedding_model=_string(present, "embedding_model"),
        )
    raise ReleaseDefect("Oracle prior marker has an unknown kind")


@dataclass(frozen=True, slots=True)
class OracleAttempt:
    schema_version: int
    source_sha: str
    expected_manifest_digest: str
    config_path: str
    config_sha256: str
    prior_marker: OraclePriorMarker
    containers: dict[str, ContainerEvidence]
    phase: OraclePhase
    created_at: str
    updated_at: str

    def __post_init__(self) -> None:
        if self.schema_version != 1:
            raise ReleaseDefect("Oracle attempt schema version must be 1")
        _require_match("Oracle target source SHA", self.source_sha, _SHA)
        _require_match(
            "Oracle expected manifest digest",
            self.expected_manifest_digest,
            _ORACLE_DIGEST,
        )
        config_path = Path(self.config_path)
        if not config_path.is_absolute() or config_path.name != f"{self.config_sha256}.env":
            raise ReleaseDefect("Oracle captured config path is not content-addressed")
        _require_match("Oracle config SHA-256", self.config_sha256, _SHA256)
        if not isinstance(
            self.prior_marker,
            (OracleMarkerAbsent, OracleMarkerPresent),
        ):
            raise ReleaseDefect("Oracle prior marker is malformed")
        if tuple(sorted(self.containers)) != tuple(sorted(_WRITERS)):
            raise ReleaseDefect("Oracle container evidence must cover exact app writers")
        _require_timestamp(self.created_at)
        _require_timestamp(self.updated_at)

    @classmethod
    def prepared(
        cls,
        *,
        source_sha: str,
        expected_manifest_digest: str,
        config_path: str,
        config_sha256: str,
        prior_marker: OraclePriorMarker,
        containers: dict[str, ContainerEvidence],
        now: str,
    ) -> OracleAttempt:
        return cls(
            schema_version=1,
            source_sha=source_sha,
            expected_manifest_digest=expected_manifest_digest,
            config_path=config_path,
            config_sha256=config_sha256,
            prior_marker=prior_marker,
            containers=containers,
            phase=OraclePhase.Prepared,
            created_at=now,
            updated_at=now,
        )

    @property
    def terminal(self) -> bool:
        return self.phase is OraclePhase.Succeeded

    @property
    def target_name(self) -> str:
        return f"{self.source_sha}-{self.expected_manifest_digest.removeprefix('sha256:')}"

    def advance(self, phase: OraclePhase, *, now: str) -> OracleAttempt:
        if phase not in _ORACLE_TRANSITIONS[self.phase]:
            raise ReleaseDefect(f"invalid Oracle transition {self.phase.value} -> {phase.value}")
        return dataclasses.replace(self, phase=phase, updated_at=now)

    def as_json(self) -> dict[str, object]:
        return {
            "schema_version": self.schema_version,
            "source_sha": self.source_sha,
            "expected_manifest_digest": self.expected_manifest_digest,
            "config_path": self.config_path,
            "config_sha256": self.config_sha256,
            "prior_marker": self.prior_marker.as_json(),
            "containers": {
                service: evidence.as_json() for service, evidence in sorted(self.containers.items())
            },
            "phase": self.phase.value,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_json(cls, value: object) -> OracleAttempt:
        mapping = _closed_mapping(value, _ORACLE_ATTEMPT_FIELDS, "Oracle attempt")
        containers = _mapping(mapping.get("containers"), "Oracle containers")
        try:
            phase = OraclePhase(_string(mapping, "phase"))
        except ValueError as exc:
            raise ReleaseDefect("Oracle attempt has an unknown phase") from exc
        return cls(
            schema_version=_integer(mapping, "schema_version"),
            source_sha=_string(mapping, "source_sha"),
            expected_manifest_digest=_string(
                mapping,
                "expected_manifest_digest",
            ),
            config_path=_string(mapping, "config_path"),
            config_sha256=_string(mapping, "config_sha256"),
            prior_marker=_oracle_prior_marker_from_json(mapping.get("prior_marker")),
            containers={
                service: ContainerEvidence.from_json(evidence)
                for service, evidence in containers.items()
            },
            phase=phase,
            created_at=_string(mapping, "created_at"),
            updated_at=_string(mapping, "updated_at"),
        )


@dataclass(frozen=True, slots=True)
class OracleRepairBinding:
    schema_version: int
    target_source_sha: str
    target_manifest_digest: str
    expected_database_revision: str
    repair_source_sha: str
    repair_manifest_sha256: str
    repair_api_image: str
    repair_worker_image: str
    repair_api_image_id: str
    repair_worker_image_id: str
    created_at: str

    def __post_init__(self) -> None:
        if self.schema_version != 1:
            raise ReleaseDefect("Oracle repair schema version must be 1")
        _require_match("Oracle repair target source SHA", self.target_source_sha, _SHA)
        _require_match(
            "Oracle repair target manifest digest",
            self.target_manifest_digest,
            _ORACLE_DIGEST,
        )
        _require_match(
            "Oracle repair database revision",
            self.expected_database_revision,
            _DATABASE_REVISION,
        )
        _require_match("Oracle repair source SHA", self.repair_source_sha, _SHA)
        if self.repair_source_sha == self.target_source_sha:
            raise ReleaseDefect("Oracle repair source must differ from its target")
        _require_match(
            "Oracle repair manifest SHA-256",
            self.repair_manifest_sha256,
            _SHA256,
        )
        _require_match("Oracle repair API image", self.repair_api_image, _IMAGE_REFERENCE)
        _require_match(
            "Oracle repair worker image",
            self.repair_worker_image,
            _IMAGE_REFERENCE,
        )
        _require_match("Oracle repair API image id", self.repair_api_image_id, _IMAGE_ID)
        _require_match(
            "Oracle repair worker image id",
            self.repair_worker_image_id,
            _IMAGE_ID,
        )
        _require_timestamp(self.created_at)

    @property
    def target_name(self) -> str:
        return f"{self.target_source_sha}-{self.target_manifest_digest.removeprefix('sha256:')}"

    def as_json(self) -> dict[str, object]:
        return dataclasses.asdict(self)

    @classmethod
    def from_json(cls, value: object) -> OracleRepairBinding:
        mapping = _closed_mapping(value, _ORACLE_REPAIR_FIELDS, "Oracle repair binding")
        return cls(
            schema_version=_integer(mapping, "schema_version"),
            target_source_sha=_string(mapping, "target_source_sha"),
            target_manifest_digest=_string(mapping, "target_manifest_digest"),
            expected_database_revision=_string(mapping, "expected_database_revision"),
            repair_source_sha=_string(mapping, "repair_source_sha"),
            repair_manifest_sha256=_string(mapping, "repair_manifest_sha256"),
            repair_api_image=_string(mapping, "repair_api_image"),
            repair_worker_image=_string(mapping, "repair_worker_image"),
            repair_api_image_id=_string(mapping, "repair_api_image_id"),
            repair_worker_image_id=_string(mapping, "repair_worker_image_id"),
            created_at=_string(mapping, "created_at"),
        )


@dataclass(frozen=True, slots=True)
class OracleRuntimeStatus:
    status: str
    manifest_digest: str
    embedding_provider: str
    embedding_model: str
    support_ready: bool
    published: bool
    prior_marker: OraclePriorMarker
    errors: tuple[str, ...]
    has_removals: bool

    def is_exact_publication(self, expected_manifest_digest: str) -> bool:
        marker = self.prior_marker
        return (
            self.status == "published"
            and self.manifest_digest == expected_manifest_digest
            and self.support_ready
            and self.published
            and isinstance(marker, OracleMarkerPresent)
            and marker.manifest_digest == expected_manifest_digest
            and marker.embedding_provider == self.embedding_provider
            and marker.embedding_model == self.embedding_model
            and not self.errors
            and not self.has_removals
        )


def parse_oracle_status(data: bytes) -> OracleRuntimeStatus:
    raw = _read_json_output(data, "Oracle status")
    if data != _canonical_json(raw):
        raise ReleaseDefect("Oracle status is not canonical JSON")
    mapping = _closed_mapping(raw, _ORACLE_STATUS_FIELDS, "Oracle status")
    status = _string(mapping, "status")
    if status not in {"published", "ready_unpublished", "not_ready"}:
        raise ReleaseDefect("Oracle status is unknown")
    manifest_digest = _string(mapping, "manifest_digest")
    _require_match("Oracle status manifest digest", manifest_digest, _ORACLE_DIGEST)
    embedding_provider = _string(mapping, "embedding_provider")
    embedding_model = _string(mapping, "embedding_model")
    OracleMarkerPresent(
        manifest_digest=manifest_digest,
        embedding_provider=embedding_provider,
        embedding_model=embedding_model,
    )
    support_ready = _boolean(mapping, "support_ready")
    published = _boolean(mapping, "published")
    publication_value = mapping.get("publication")
    if publication_value is None:
        prior_marker: OraclePriorMarker = OracleMarkerAbsent()
    else:
        publication = _closed_mapping(
            publication_value,
            _ORACLE_MARKER_FIELDS,
            "Oracle publication",
        )
        if _string(publication, "corpus_key") != "current":
            raise ReleaseDefect("Oracle publication key is unsupported")
        prior_marker = OracleMarkerPresent(
            manifest_digest=_string(publication, "manifest_digest"),
            embedding_provider=_string(publication, "embedding_provider"),
            embedding_model=_string(publication, "embedding_model"),
        )
    derived_status = (
        "published"
        if support_ready and published
        else "ready_unpublished"
        if support_ready
        else "not_ready"
    )
    if status != derived_status:
        raise ReleaseDefect("Oracle status discriminator disagrees with readiness")

    errors = _string_list(mapping.get("errors"), "Oracle status errors")
    removals = _closed_mapping(
        mapping.get("removals"),
        _ORACLE_REMOVAL_FIELDS,
        "Oracle status removals",
    )
    work_keys = _string_list(removals.get("work_keys"), "Oracle work removals")
    plate_urls = _string_list(
        removals.get("plate_source_urls"),
        "Oracle plate removals",
    )
    anchor_value = removals.get("anchor_keys")
    if not isinstance(anchor_value, list):
        raise ReleaseDefect("Oracle anchor removals must be an array")
    for anchor in anchor_value:
        if (
            not isinstance(anchor, list)
            or len(anchor) != 2
            or not all(isinstance(item, str) and item for item in anchor)
        ):
            raise ReleaseDefect("Oracle anchor removal is malformed")
    counts = _closed_mapping(
        mapping.get("counts"),
        _ORACLE_COUNT_FIELDS,
        "Oracle status counts",
    )
    for key in _ORACLE_COUNT_FIELDS:
        _nonnegative_integer(counts, key)
    return OracleRuntimeStatus(
        status=status,
        manifest_digest=manifest_digest,
        embedding_provider=embedding_provider,
        embedding_model=embedding_model,
        support_ready=support_ready,
        published=published,
        prior_marker=prior_marker,
        errors=errors,
        has_removals=bool(work_keys or anchor_value or plate_urls),
    )


def _oracle_response(
    data: bytes,
    *,
    fields: frozenset[str],
    label: str,
) -> dict[str, Any]:
    raw = _read_json_output(data, label)
    if data != _canonical_json(raw):
        raise ReleaseDefect(f"{label} is not canonical JSON")
    return _closed_mapping(raw, fields, label)


def _accept_oracle_preflight(data: bytes, expected_digest: str) -> None:
    value = _oracle_response(
        data,
        fields=frozenset({"status", "manifest_digest", "removals"}),
        label="Oracle preflight",
    )
    if (
        _string(value, "status") != "accepted"
        or _string(value, "manifest_digest") != expected_digest
        or _boolean(value, "removals")
    ):
        raise PermanentReleaseFailure("Oracle preflight did not accept an additive target")


def _accept_oracle_unpublish(data: bytes, expected_digest: str) -> None:
    value = _oracle_response(
        data,
        fields=frozenset({"status", "manifest_digest", "changed"}),
        label="Oracle unpublish",
    )
    if (
        _string(value, "status") != "unpublished"
        or _string(value, "manifest_digest") != expected_digest
    ):
        raise ReleaseDefect("Oracle unpublish response disagrees with its target")
    _boolean(value, "changed")


def _accept_oracle_support(data: bytes, expected_digest: str) -> None:
    value = _oracle_response(
        data,
        fields=frozenset(
            {
                "status",
                "manifest_digest",
                "media_ids",
                "source_job_ids",
                "index_job_ids",
                "plate_object_writes",
            }
        ),
        label="Oracle support reconcile",
    )
    if (
        _string(value, "status") != "support_reconciled"
        or _string(value, "manifest_digest") != expected_digest
    ):
        raise ReleaseDefect("Oracle support response disagrees with its target")
    for key in ("media_ids", "source_job_ids", "index_job_ids"):
        identifiers = _string_list(value.get(key), f"Oracle {key}")
        if any(_UUID.fullmatch(identifier) is None for identifier in identifiers):
            raise ReleaseDefect(f"Oracle {key} contains a malformed UUID")
    _nonnegative_integer(value, "plate_object_writes")


def _accept_oracle_publish(data: bytes, expected_digest: str) -> None:
    value = _oracle_response(
        data,
        fields=frozenset({"status", "manifest_digest"}),
        label="Oracle publish",
    )
    if (
        _string(value, "status") != "published"
        or _string(value, "manifest_digest") != expected_digest
    ):
        raise ReleaseDefect("Oracle publish response disagrees with its target")


@dataclass(frozen=True, slots=True)
class BackupEvidence:
    path: str
    sha256: str
    byte_count: int
    database_identity: str
    starting_revision: str

    def __post_init__(self) -> None:
        if not Path(self.path).is_absolute():
            raise ReleaseDefect("backup path must be absolute")
        _require_match("backup SHA-256", self.sha256, _SHA256)
        if type(self.byte_count) is not int or self.byte_count < 1:
            raise ReleaseDefect("backup byte count must be positive")
        if not self.database_identity or "\n" in self.database_identity:
            raise ReleaseDefect("database identity is malformed")
        _require_match("starting database revision", self.starting_revision, _DATABASE_REVISION)

    def as_json(self) -> dict[str, object]:
        return dataclasses.asdict(self)

    @classmethod
    def from_json(cls, value: object) -> BackupEvidence:
        mapping = _closed_mapping(value, _BACKUP_FIELDS, "backup evidence")
        return cls(
            path=_string(mapping, "path"),
            sha256=_string(mapping, "sha256"),
            byte_count=_integer(mapping, "byte_count"),
            database_identity=_string(mapping, "database_identity"),
            starting_revision=_string(mapping, "starting_revision"),
        )


@dataclass(frozen=True, slots=True)
class ReleaseAttempt:
    schema_version: int
    source_sha: str
    manifest_sha256: str
    candidate_api_image_id: str
    candidate_worker_image_id: str
    predecessor_sha: str | None
    forward_fix_of: str | None
    containers: dict[str, ContainerEvidence]
    config_path: str
    config_sha256: str
    vercel_deployment_id: str
    production_host: str
    phase: ReleasePhase
    backup: BackupEvidence | None
    failure_code: str | None
    created_at: str
    updated_at: str

    def __post_init__(self) -> None:
        if self.schema_version != 1:
            raise ReleaseDefect("release attempt schema version must be 1")
        _require_match("attempt source SHA", self.source_sha, _SHA)
        _require_match("manifest SHA-256", self.manifest_sha256, _SHA256)
        _require_match("candidate API image id", self.candidate_api_image_id, _IMAGE_ID)
        _require_match("candidate worker image id", self.candidate_worker_image_id, _IMAGE_ID)
        if self.predecessor_sha is None:
            if self.phase is not ReleasePhase.Succeeded:
                raise ReleaseDefect("successor release attempt requires a predecessor")
        else:
            _require_match("predecessor SHA", self.predecessor_sha, _SHA)
            if self.predecessor_sha == self.source_sha:
                raise ReleaseDefect("release predecessor must differ from candidate")
        if self.forward_fix_of is not None:
            _require_match("forward-fix predecessor SHA", self.forward_fix_of, _SHA)
            if self.forward_fix_of == self.source_sha:
                raise ReleaseDefect("release cannot forward-fix itself")
        if tuple(sorted(self.containers)) != tuple(sorted(_SERVICES)):
            raise ReleaseDefect("container evidence must cover the exact production services")
        if not Path(self.config_path).is_absolute():
            raise ReleaseDefect("captured config path must be absolute")
        _require_match("config SHA-256", self.config_sha256, _SHA256)
        _require_match("Vercel deployment id", self.vercel_deployment_id, _DEPLOYMENT_ID)
        _require_match("production host", self.production_host, _HOST)
        if self.phase is ReleasePhase.BackupVerified and self.backup is None:
            raise ReleaseDefect("BackupVerified attempt has no backup evidence")
        if self.phase is ReleasePhase.DataMutationStarted and self.backup is None:
            raise ReleaseDefect("DataMutationStarted attempt has no backup evidence")
        if (
            self.phase in {ReleasePhase.Prepared, ReleasePhase.WritersStopped}
            and self.backup is not None
        ):
            raise ReleaseDefect("pre-backup release attempt already has backup evidence")
        if self.failure_code is not None and not re.fullmatch(
            r"[a-z][a-z0-9-]{0,63}", self.failure_code
        ):
            raise ReleaseDefect("release failure code is malformed")
        failed = self.phase in {
            ReleasePhase.RollbackRequired,
            ReleasePhase.ForwardFixPending,
            ReleasePhase.RolledBack,
            ReleasePhase.ForwardFixRequired,
        }
        if failed != (self.failure_code is not None):
            raise ReleaseDefect("release failure code and terminal phase disagree")
        _require_timestamp(self.created_at)
        _require_timestamp(self.updated_at)
        if self.updated_at < self.created_at:
            raise ReleaseDefect("release attempt timestamp moved backward")

    @classmethod
    def prepared(
        cls,
        *,
        source_sha: str,
        manifest_sha256: str,
        candidate_api_image_id: str,
        candidate_worker_image_id: str,
        predecessor_sha: str,
        forward_fix_of: str | None,
        containers: dict[str, ContainerEvidence],
        config_path: str,
        config_sha256: str,
        vercel_deployment_id: str,
        production_host: str,
        now: str,
    ) -> ReleaseAttempt:
        return cls(
            schema_version=1,
            source_sha=source_sha,
            manifest_sha256=manifest_sha256,
            candidate_api_image_id=candidate_api_image_id,
            candidate_worker_image_id=candidate_worker_image_id,
            predecessor_sha=predecessor_sha,
            forward_fix_of=forward_fix_of,
            containers=containers,
            config_path=config_path,
            config_sha256=config_sha256,
            vercel_deployment_id=vercel_deployment_id,
            production_host=production_host,
            phase=ReleasePhase.Prepared,
            backup=None,
            failure_code=None,
            created_at=now,
            updated_at=now,
        )

    @property
    def terminal(self) -> bool:
        return self.phase.value in _TERMINAL_PHASES

    def advance(
        self,
        phase: ReleasePhase,
        *,
        now: str,
        failure_code: str | None = None,
    ) -> ReleaseAttempt:
        if phase not in _TRANSITIONS[self.phase]:
            raise ReleaseDefect(f"invalid release transition {self.phase.value} -> {phase.value}")
        return dataclasses.replace(
            self,
            phase=phase,
            failure_code=failure_code,
            updated_at=now,
        )

    def with_backup(
        self,
        *,
        path: str,
        sha256: str,
        byte_count: int,
        database_identity: str,
        starting_revision: str,
        now: str,
    ) -> ReleaseAttempt:
        if self.phase is not ReleasePhase.WritersStopped:
            raise ReleaseDefect("backup evidence requires WritersStopped")
        return dataclasses.replace(
            self,
            phase=ReleasePhase.BackupVerified,
            backup=BackupEvidence(
                path=path,
                sha256=sha256,
                byte_count=byte_count,
                database_identity=database_identity,
                starting_revision=starting_revision,
            ),
            failure_code=None,
            updated_at=now,
        )

    def as_json(self) -> dict[str, object]:
        return {
            "schema_version": self.schema_version,
            "source_sha": self.source_sha,
            "manifest_sha256": self.manifest_sha256,
            "candidate_api_image_id": self.candidate_api_image_id,
            "candidate_worker_image_id": self.candidate_worker_image_id,
            "predecessor_sha": self.predecessor_sha,
            "forward_fix_of": self.forward_fix_of,
            "containers": {
                service: evidence.as_json() for service, evidence in sorted(self.containers.items())
            },
            "config_path": self.config_path,
            "config_sha256": self.config_sha256,
            "vercel_deployment_id": self.vercel_deployment_id,
            "production_host": self.production_host,
            "phase": self.phase.value,
            "backup": None if self.backup is None else self.backup.as_json(),
            "failure_code": self.failure_code,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_json(cls, value: object) -> ReleaseAttempt:
        mapping = _closed_mapping(value, _ATTEMPT_FIELDS, "release attempt")
        containers_value = _mapping(mapping.get("containers"), "attempt containers")
        try:
            phase = ReleasePhase(_string(mapping, "phase"))
        except ValueError as exc:
            raise ReleaseDefect("release attempt has an unknown phase") from exc
        backup_value = mapping.get("backup")
        return cls(
            schema_version=_integer(mapping, "schema_version"),
            source_sha=_string(mapping, "source_sha"),
            manifest_sha256=_string(mapping, "manifest_sha256"),
            candidate_api_image_id=_string(mapping, "candidate_api_image_id"),
            candidate_worker_image_id=_string(mapping, "candidate_worker_image_id"),
            predecessor_sha=_optional_string(mapping, "predecessor_sha"),
            forward_fix_of=_optional_string(mapping, "forward_fix_of"),
            containers={
                service: ContainerEvidence.from_json(item)
                for service, item in containers_value.items()
            },
            config_path=_string(mapping, "config_path"),
            config_sha256=_string(mapping, "config_sha256"),
            vercel_deployment_id=_string(mapping, "vercel_deployment_id"),
            production_host=_string(mapping, "production_host"),
            phase=phase,
            backup=None if backup_value is None else BackupEvidence.from_json(backup_value),
            failure_code=_optional_string(mapping, "failure_code"),
            created_at=_string(mapping, "created_at"),
            updated_at=_string(mapping, "updated_at"),
        )


@dataclass(frozen=True, slots=True)
class ReleaseRecord:
    schema_version: int
    source_sha: str
    manifest_sha256: str
    api_image: str
    worker_image: str
    api_image_id: str
    worker_image_id: str
    predecessor_sha: str | None
    config_path: str
    config_sha256: str
    database_revision: str
    expected_oracle_manifest_digest: str
    vercel_deployment_id: str
    production_host: str
    verified_at: str

    def __post_init__(self) -> None:
        if self.schema_version != 1:
            raise ReleaseDefect("release record schema version must be 1")
        _require_match("record source SHA", self.source_sha, _SHA)
        _require_match("manifest SHA-256", self.manifest_sha256, _SHA256)
        _require_match("API image", self.api_image, _IMAGE_REFERENCE)
        _require_match("worker image", self.worker_image, _IMAGE_REFERENCE)
        _require_match("API image id", self.api_image_id, _IMAGE_ID)
        _require_match("worker image id", self.worker_image_id, _IMAGE_ID)
        if self.predecessor_sha is not None:
            _require_match("record predecessor SHA", self.predecessor_sha, _SHA)
            if self.predecessor_sha == self.source_sha:
                raise ReleaseDefect("release record predecessor must differ from source")
        if not Path(self.config_path).is_absolute():
            raise ReleaseDefect("record config path must be absolute")
        _require_match("record config SHA-256", self.config_sha256, _SHA256)
        _require_match("record database revision", self.database_revision, _DATABASE_REVISION)
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", self.expected_oracle_manifest_digest):
            raise ReleaseDefect("record Oracle digest is malformed")
        _require_match("record Vercel deployment id", self.vercel_deployment_id, _DEPLOYMENT_ID)
        _require_match("record production host", self.production_host, _HOST)
        _require_timestamp(self.verified_at)

    @classmethod
    def from_attempt(
        cls,
        *,
        attempt: ReleaseAttempt,
        candidate: CandidateManifest,
        api_image_id: str,
        worker_image_id: str,
        verified_at: str,
    ) -> ReleaseRecord:
        if attempt.source_sha != candidate.source_sha:
            raise ReleaseDefect("attempt and candidate source SHA differ")
        if attempt.phase not in {
            ReleasePhase.FrontendPromoted,
            ReleasePhase.Succeeded,
        }:
            raise ReleaseDefect("release record requires a promoted frontend")
        if attempt.predecessor_sha is None and attempt.phase is not ReleasePhase.Succeeded:
            raise ReleaseDefect("successor release record requires a predecessor")
        return cls(
            schema_version=1,
            source_sha=attempt.source_sha,
            manifest_sha256=attempt.manifest_sha256,
            api_image=candidate.images.api,
            worker_image=candidate.images.worker,
            api_image_id=api_image_id,
            worker_image_id=worker_image_id,
            predecessor_sha=attempt.predecessor_sha,
            config_path=attempt.config_path,
            config_sha256=attempt.config_sha256,
            database_revision=candidate.expected_database_revision,
            expected_oracle_manifest_digest=candidate.expected_oracle_manifest_digest,
            vercel_deployment_id=attempt.vercel_deployment_id,
            production_host=attempt.production_host,
            verified_at=verified_at,
        )

    def as_json(self) -> dict[str, object]:
        return dataclasses.asdict(self)

    @classmethod
    def from_json(cls, value: object) -> ReleaseRecord:
        mapping = _closed_mapping(value, _RECORD_FIELDS, "release record")
        return cls(
            schema_version=_integer(mapping, "schema_version"),
            source_sha=_string(mapping, "source_sha"),
            manifest_sha256=_string(mapping, "manifest_sha256"),
            api_image=_string(mapping, "api_image"),
            worker_image=_string(mapping, "worker_image"),
            api_image_id=_string(mapping, "api_image_id"),
            worker_image_id=_string(mapping, "worker_image_id"),
            predecessor_sha=_optional_string(mapping, "predecessor_sha"),
            config_path=_string(mapping, "config_path"),
            config_sha256=_string(mapping, "config_sha256"),
            database_revision=_string(mapping, "database_revision"),
            expected_oracle_manifest_digest=_string(mapping, "expected_oracle_manifest_digest"),
            vercel_deployment_id=_string(mapping, "vercel_deployment_id"),
            production_host=_string(mapping, "production_host"),
            verified_at=_string(mapping, "verified_at"),
        )


def load_candidate_manifest(path: Path) -> CandidateManifest:
    try:
        return _load_candidate_manifest(path)
    except BackendArtifactDefect as exc:
        raise ReleaseDefect(str(exc)) from exc


def permanent_failure_phase(
    phase: ReleasePhase,
    *,
    forward_fix: bool,
) -> ReleasePhase:
    if forward_fix and phase not in _TERMINAL_PHASES:
        return ReleasePhase.ForwardFixPending
    if phase in {
        ReleasePhase.Prepared,
        ReleasePhase.WritersStopped,
        ReleasePhase.BackupVerified,
    }:
        return ReleasePhase.RollbackRequired
    if phase in {
        ReleasePhase.DataMutationStarted,
        ReleasePhase.BackendActivationStarted,
        ReleasePhase.AwaitingFrontendPromotion,
        ReleasePhase.FrontendPromoted,
    }:
        return ReleasePhase.ForwardFixPending
    raise ReleaseDefect(f"terminal phase {phase.value} cannot fail again")


class ReleaseStore:
    def __init__(self, paths: ReleasePaths) -> None:
        self.paths = paths

    def create_attempt(self, attempt: ReleaseAttempt) -> None:
        self._prepare_state_directories()
        _create_json(self.paths.attempts / f"{attempt.source_sha}.json", attempt.as_json())

    def replace_attempt(self, attempt: ReleaseAttempt) -> None:
        current = self.load_attempt(attempt.source_sha)
        if current is None:
            raise ReleaseDefect(f"release attempt {attempt.source_sha} does not exist")
        if current == attempt:
            return
        unchanged = dataclasses.replace(
            attempt,
            phase=current.phase,
            backup=current.backup,
            failure_code=current.failure_code,
            updated_at=current.updated_at,
        )
        if unchanged != current:
            raise ReleaseDefect("release transition changed immutable attempt evidence")
        if attempt.phase not in _TRANSITIONS[current.phase]:
            raise ReleaseDefect(
                f"invalid stored release transition {current.phase.value} -> {attempt.phase.value}"
            )
        _atomic_json(self.paths.attempts / f"{attempt.source_sha}.json", attempt.as_json())

    def load_attempt(self, source_sha: str) -> ReleaseAttempt | None:
        _require_match("source SHA", source_sha, _SHA)
        path = self.paths.attempts / f"{source_sha}.json"
        if not path.exists():
            return None
        return ReleaseAttempt.from_json(_read_canonical_json(path, "release attempt"))

    def attempts(self) -> tuple[ReleaseAttempt, ...]:
        if not self.paths.attempts.exists():
            return ()
        attempts: list[ReleaseAttempt] = []
        for path in sorted(self.paths.attempts.iterdir()):
            if path.name.startswith(".") and path.name.endswith(".partial"):
                continue
            if not re.fullmatch(r"[0-9a-f]{40}\.json", path.name):
                raise ReleaseDefect(f"unknown release attempt state file {path}")
            attempt = ReleaseAttempt.from_json(_read_canonical_json(path, "release attempt"))
            if path.name != f"{attempt.source_sha}.json":
                raise ReleaseDefect(f"release attempt filename disagrees with {path}")
            attempts.append(attempt)
        return tuple(attempts)

    def active_attempt(self) -> ReleaseAttempt | None:
        active = tuple(attempt for attempt in self.attempts() if not attempt.terminal)
        if len(active) > 1:
            raise ReleaseDefect("multiple nonterminal application release attempts exist")
        return active[0] if active else None

    def assert_candidate_admissible(self, source_sha: str) -> None:
        _require_match("candidate source SHA", source_sha, _SHA)
        active = self.active_attempt()
        if active is not None:
            if active.source_sha == source_sha:
                return
            raise ReleaseBlocked(
                f"release {active.source_sha} is still {active.phase.value}; "
                f"candidate {source_sha} is blocked"
            )
        existing = self.load_attempt(source_sha)
        if existing is not None:
            if existing.phase is ReleasePhase.Succeeded and self.current_sha() == source_sha:
                return
            raise ReleaseBlocked(
                f"source SHA {source_sha} is permanently terminal as {existing.phase.value}"
            )
        if self.load_record(source_sha) is not None:
            raise ReleaseBlocked(f"source SHA {source_sha} was already published")
        failed_sha = self.forward_fix_sha()
        if failed_sha == source_sha:
            raise ReleaseBlocked(f"failed source SHA {source_sha} cannot forward-fix itself")

    def assert_fresh_candidate(self, source_sha: str) -> None:
        """Require a never-started, never-published SHA for config preparation."""
        _require_match("candidate source SHA", source_sha, _SHA)
        active = self.active_attempt()
        if active is not None:
            raise ReleaseBlocked(
                f"release {active.source_sha} is still {active.phase.value}; config is blocked"
            )
        if self.load_attempt(source_sha) is not None:
            raise ReleaseBlocked(f"source SHA {source_sha} already has release history")
        if self.load_record(source_sha) is not None or self.current_sha() == source_sha:
            raise ReleaseBlocked(f"source SHA {source_sha} was already published")
        if self.forward_fix_sha() == source_sha:
            raise ReleaseBlocked(f"failed source SHA {source_sha} cannot be reused")

    def create_record(self, record: ReleaseRecord) -> None:
        self._prepare_state_directories()
        path = self.paths.records / f"{record.source_sha}.json"
        if path.exists():
            if self.load_record(record.source_sha) != record:
                raise ReleaseDefect(f"immutable release record {record.source_sha} changed")
            return
        _create_json(path, record.as_json())

    def load_record(self, source_sha: str) -> ReleaseRecord | None:
        _require_match("record source SHA", source_sha, _SHA)
        path = self.paths.records / f"{source_sha}.json"
        if not path.exists():
            return None
        record = ReleaseRecord.from_json(_read_canonical_json(path, "release record"))
        if record.source_sha != source_sha:
            raise ReleaseDefect(f"release record filename disagrees with {path}")
        return record

    def set_current(self, source_sha: str) -> None:
        _require_match("current source SHA", source_sha, _SHA)
        record = self.load_record(source_sha)
        if record is None:
            raise ReleaseDefect("current source SHA requires an immutable release record")
        previous = self.current_sha()
        if previous is None:
            raise ReleaseBlocked("application release requires an existing current record")
        if previous != source_sha and record.predecessor_sha != previous:
            raise ReleaseDefect("release record predecessor differs from prior current SHA")
        _atomic_bytes(self.paths.current, f"{source_sha}\n".encode())

    def current_sha(self) -> str | None:
        if not self.paths.current.exists():
            return None
        value = _read_pointer(self.paths.current, "current release")
        _require_match("current source SHA", value, _SHA)
        if self.load_record(value) is None:
            raise ReleaseDefect("current source SHA has no immutable release record")
        return value

    def require_current_record(self) -> ReleaseRecord:
        current = self.current_sha()
        if current is None:
            raise ReleaseBlocked("application release requires an existing current record")
        record = self.load_record(current)
        if record is None:
            raise ReleaseDefect("current source SHA has no immutable release record")
        return record

    def complete_published_attempt(self, source_sha: str, *, now: str) -> ReleaseAttempt:
        attempt = self.load_attempt(source_sha)
        if attempt is None:
            raise ReleaseDefect(f"release attempt {source_sha} does not exist")
        if self.current_sha() != source_sha or self.load_record(source_sha) is None:
            raise ReleaseDefect(
                "published-prefix recovery requires matching record and current SHA"
            )
        if attempt.phase is ReleasePhase.Succeeded:
            return attempt
        if attempt.phase is not ReleasePhase.FrontendPromoted:
            raise ReleaseDefect(f"published-prefix recovery cannot complete {attempt.phase.value}")
        succeeded = attempt.advance(ReleasePhase.Succeeded, now=now)
        self.replace_attempt(succeeded)
        return succeeded

    def set_forward_fix(self, source_sha: str) -> None:
        attempt = self.load_attempt(source_sha)
        if attempt is None or attempt.phase not in {
            ReleasePhase.DataMutationStarted,
            ReleasePhase.BackendActivationStarted,
            ReleasePhase.AwaitingFrontendPromotion,
            ReleasePhase.FrontendPromoted,
            ReleasePhase.ForwardFixPending,
            ReleasePhase.ForwardFixRequired,
        }:
            raise ReleaseDefect(
                "forward-fix pointer requires a committed or ForwardFixRequired attempt"
            )
        current = self.forward_fix_sha()
        if current is not None and current != source_sha:
            raise ReleaseDefect(f"forward-fix pointer already names {current}")
        _atomic_bytes(self.paths.forward_fix, f"{source_sha}\n".encode())

    def forward_fix_sha(self) -> str | None:
        if not self.paths.forward_fix.exists():
            return None
        value = _read_pointer(self.paths.forward_fix, "forward-fix")
        _require_match("forward-fix SHA", value, _SHA)
        attempt = self.load_attempt(value)
        if attempt is None or attempt.phase not in {
            ReleasePhase.DataMutationStarted,
            ReleasePhase.BackendActivationStarted,
            ReleasePhase.AwaitingFrontendPromotion,
            ReleasePhase.FrontendPromoted,
            ReleasePhase.ForwardFixPending,
            ReleasePhase.ForwardFixRequired,
        }:
            raise ReleaseDefect("forward-fix pointer has no matching failed attempt")
        return value

    def clear_forward_fix_after_success(self, successor_sha: str) -> None:
        attempt = self.load_attempt(successor_sha)
        if attempt is None or attempt.phase is not ReleasePhase.Succeeded:
            raise ReleaseDefect("only a succeeded successor clears forward-fix state")
        failed_sha = self.forward_fix_sha()
        if failed_sha is None or attempt.forward_fix_of != failed_sha:
            return
        if failed_sha == successor_sha:
            raise ReleaseDefect("a failed release cannot clear its own forward-fix pointer")
        self.paths.forward_fix.unlink()
        _fsync_directory(self.paths.forward_fix.parent)

    def create_oracle_attempt(self, attempt: OracleAttempt) -> None:
        self._prepare_state_directories()
        _create_json(
            self.paths.oracle_attempts / f"{attempt.target_name}.json",
            attempt.as_json(),
        )

    def replace_oracle_attempt(self, attempt: OracleAttempt) -> None:
        current = self.load_oracle_attempt(
            attempt.source_sha,
            attempt.expected_manifest_digest,
        )
        if current is None:
            raise ReleaseDefect(f"Oracle attempt {attempt.target_name} does not exist")
        if current == attempt:
            return
        unchanged = dataclasses.replace(
            attempt,
            phase=current.phase,
            updated_at=current.updated_at,
        )
        if unchanged != current:
            raise ReleaseDefect("Oracle transition changed immutable attempt evidence")
        if attempt.phase not in _ORACLE_TRANSITIONS[current.phase]:
            raise ReleaseDefect(
                f"invalid stored Oracle transition {current.phase.value} -> {attempt.phase.value}"
            )
        _atomic_json(
            self.paths.oracle_attempts / f"{attempt.target_name}.json",
            attempt.as_json(),
        )

    def load_oracle_attempt(
        self,
        source_sha: str,
        expected_manifest_digest: str,
    ) -> OracleAttempt | None:
        _require_match("Oracle target source SHA", source_sha, _SHA)
        _require_match(
            "Oracle expected manifest digest",
            expected_manifest_digest,
            _ORACLE_DIGEST,
        )
        name = f"{source_sha}-{expected_manifest_digest.removeprefix('sha256:')}"
        path = self.paths.oracle_attempts / f"{name}.json"
        if not path.exists():
            return None
        attempt = OracleAttempt.from_json(_read_canonical_json(path, "Oracle attempt"))
        if attempt.target_name != name:
            raise ReleaseDefect(f"Oracle attempt filename disagrees with {path}")
        return attempt

    def oracle_attempts(self) -> tuple[OracleAttempt, ...]:
        if not self.paths.oracle_attempts.exists():
            return ()
        attempts: list[OracleAttempt] = []
        for path in sorted(self.paths.oracle_attempts.iterdir()):
            if path.name.startswith(".") and path.name.endswith(".partial"):
                continue
            if re.fullmatch(r"[0-9a-f]{40}-[0-9a-f]{64}\.json", path.name) is None:
                raise ReleaseDefect(f"unknown Oracle attempt state file {path}")
            attempt = OracleAttempt.from_json(_read_canonical_json(path, "Oracle attempt"))
            if path.name != f"{attempt.target_name}.json":
                raise ReleaseDefect(f"Oracle attempt filename disagrees with {path}")
            attempts.append(attempt)
        return tuple(attempts)

    def active_oracle_attempt(self) -> OracleAttempt | None:
        active = tuple(attempt for attempt in self.oracle_attempts() if not attempt.terminal)
        if len(active) > 1:
            raise ReleaseDefect("multiple nonterminal Oracle attempts exist")
        return active[0] if active else None

    def require_oracle_target(
        self,
        source_sha: str,
        expected_manifest_digest: str,
    ) -> OracleAttempt | None:
        _require_match("Oracle target source SHA", source_sha, _SHA)
        _require_match(
            "Oracle expected manifest digest",
            expected_manifest_digest,
            _ORACLE_DIGEST,
        )
        active = self.active_oracle_attempt()
        if active is None:
            return None
        if (
            active.source_sha != source_sha
            or active.expected_manifest_digest != expected_manifest_digest
        ):
            raise ReleaseBlocked(
                f"Oracle attempt {active.target_name} is still {active.phase.value}; "
                f"target {source_sha} is blocked"
            )
        return active

    def assert_no_oracle_attempt(self) -> None:
        attempt = self.active_oracle_attempt()
        if attempt is not None:
            raise ReleaseBlocked(
                f"Oracle attempt {attempt.target_name} is still {attempt.phase.value}"
            )

    def create_oracle_repair(self, binding: OracleRepairBinding) -> None:
        self._prepare_state_directories()
        _create_json(
            self.paths.oracle_repairs / f"{binding.target_name}.json",
            binding.as_json(),
        )

    def load_oracle_repair(
        self,
        target_source_sha: str,
        target_manifest_digest: str,
    ) -> OracleRepairBinding | None:
        _require_match("Oracle repair target source SHA", target_source_sha, _SHA)
        _require_match(
            "Oracle repair target manifest digest",
            target_manifest_digest,
            _ORACLE_DIGEST,
        )
        name = f"{target_source_sha}-{target_manifest_digest.removeprefix('sha256:')}"
        path = self.paths.oracle_repairs / f"{name}.json"
        if not path.exists():
            return None
        binding = OracleRepairBinding.from_json(_read_canonical_json(path, "Oracle repair binding"))
        if binding.target_name != name:
            raise ReleaseDefect(f"Oracle repair binding filename disagrees with {path}")
        return binding

    def oracle_repairs(self) -> tuple[OracleRepairBinding, ...]:
        if not self.paths.oracle_repairs.exists():
            return ()
        bindings: list[OracleRepairBinding] = []
        for path in sorted(self.paths.oracle_repairs.iterdir()):
            if path.name.startswith(".") and path.name.endswith(".partial"):
                continue
            if re.fullmatch(r"[0-9a-f]{40}-[0-9a-f]{64}\.json", path.name) is None:
                raise ReleaseDefect(f"unknown Oracle repair state file {path}")
            binding = OracleRepairBinding.from_json(
                _read_canonical_json(path, "Oracle repair binding")
            )
            if path.name != f"{binding.target_name}.json":
                raise ReleaseDefect(f"Oracle repair binding filename disagrees with {path}")
            bindings.append(binding)
        return tuple(bindings)

    def _prepare_state_directories(self) -> None:
        for path in (
            self.paths.state_root,
            self.paths.attempts,
            self.paths.oracle_attempts,
            self.paths.oracle_repairs,
            self.paths.records,
        ):
            path.mkdir(mode=0o750, parents=True, exist_ok=True)


def _canonical_json(value: object) -> bytes:
    return (
        json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True) + "\n"
    ).encode()


def _read_json(path: Path) -> object:
    try:
        return json.loads(path.read_bytes(), object_pairs_hook=_unique_object)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ReleaseDefect(f"could not read strict JSON state {path}") from exc


def _read_canonical_json(path: Path, label: str) -> object:
    value = _read_json(path)
    try:
        encoded = path.read_bytes()
    except OSError as exc:
        raise ReleaseDefect(f"could not read {label} bytes {path}") from exc
    if encoded != _canonical_json(value):
        raise ReleaseDefect(f"{label} is not canonical JSON")
    return value


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ReleaseDefect(f"duplicate JSON key {key!r}")
        value[key] = item
    return value


def _closed_mapping(value: object, fields: frozenset[str], label: str) -> dict[str, Any]:
    mapping = _mapping(value, label)
    if mapping.keys() != fields:
        raise ReleaseDefect(f"{label} fields are not the exact supported contract")
    return mapping


def _mapping(value: object, label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise ReleaseDefect(f"{label} must be an object")
    return value


def _string(mapping: dict[str, Any], key: str) -> str:
    value = mapping.get(key)
    if not isinstance(value, str):
        raise ReleaseDefect(f"{key} must be a string")
    return value


def _optional_string(mapping: dict[str, Any], key: str) -> str | None:
    value = mapping.get(key)
    if value is not None and not isinstance(value, str):
        raise ReleaseDefect(f"{key} must be a string or null")
    return value


def _integer(mapping: dict[str, Any], key: str) -> int:
    value = mapping.get(key)
    if type(value) is not int:
        raise ReleaseDefect(f"{key} must be an integer")
    return value


def _nonnegative_integer(mapping: dict[str, Any], key: str) -> int:
    value = _integer(mapping, key)
    if value < 0:
        raise ReleaseDefect(f"{key} must be nonnegative")
    return value


def _boolean(mapping: dict[str, Any], key: str) -> bool:
    value = mapping.get(key)
    if type(value) is not bool:
        raise ReleaseDefect(f"{key} must be a boolean")
    return value


def _string_list(value: object, label: str) -> tuple[str, ...]:
    if not isinstance(value, list) or not all(isinstance(item, str) and item for item in value):
        raise ReleaseDefect(f"{label} must be an array of nonempty strings")
    return tuple(value)


def _require_match(name: str, value: object, pattern: re.Pattern[str]) -> str:
    if not isinstance(value, str) or pattern.fullmatch(value) is None:
        raise ReleaseDefect(f"{name} is malformed")
    return value


def _require_timestamp(value: str) -> None:
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", value) is None:
        raise ReleaseDefect("release timestamp must be canonical UTC seconds")


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _read_pointer(path: Path, label: str) -> str:
    try:
        data = path.read_bytes()
    except OSError as exc:
        raise ReleaseDefect(f"could not read {label} pointer") from exc
    if not data.endswith(b"\n") or data.count(b"\n") != 1:
        raise ReleaseDefect(f"{label} pointer is not one newline-terminated value")
    try:
        return data[:-1].decode("ascii")
    except UnicodeDecodeError as exc:
        raise ReleaseDefect(f"{label} pointer is not ASCII") from exc


def _create_json(path: Path, value: object) -> None:
    _create_bytes(path, _canonical_json(value))


def _create_bytes(path: Path, data: bytes, *, mode: int = 0o640) -> None:
    path.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".partial", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, mode)
        stream = os.fdopen(descriptor, "wb")
        descriptor = -1
        with stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(temporary, path)
        except FileExistsError as exc:
            raise ReleaseDefect(f"create-only state already exists: {path}") from exc
        _fsync_directory(path.parent)
        temporary.unlink()
        _fsync_directory(path.parent)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        temporary.unlink(missing_ok=True)


def _atomic_json(path: Path, value: object) -> None:
    _atomic_bytes(path, _canonical_json(value))


def _atomic_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".partial", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o640)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        _fsync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


@contextlib.contextmanager
def release_lock(path: Path) -> Iterator[None]:
    path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    with path.open("a+b") as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise ReleaseBlocked("another Nexus host mutation holds the release lock") from exc
        yield


@dataclass(frozen=True, slots=True)
class ConfigSnapshot:
    path: Path
    sha256: str
    values: dict[str, str]


@dataclass(frozen=True, slots=True)
class PreflightEvidence:
    candidate: CandidateManifest
    manifest_sha256: str
    bundle: Path
    config: ConfigSnapshot
    containers: dict[str, ContainerEvidence]
    database_revision: str
    database_identity: str
    api_image_id: str
    worker_image_id: str


def _run(
    command: tuple[str, ...],
    *,
    environment: dict[str, str] | None = None,
    input_bytes: bytes | None = None,
    timeout_seconds: int = 180,
) -> subprocess.CompletedProcess[bytes]:
    if not command or any(not part for part in command):
        raise ReleaseDefect("external command must be a fixed non-empty argv")
    try:
        return subprocess.run(
            command,
            env=environment,
            input=input_bytes,
            capture_output=True,
            check=True,
            timeout=timeout_seconds,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError) as exc:
        operation = hashlib.sha256("\0".join(command).encode()).hexdigest()
        raise ExternalCommandFailed(
            f"bounded command failed: {command[0]}",
            operation=f"command-{operation}",
        ) from exc


def _stdout(command: tuple[str, ...], *, environment: dict[str, str] | None = None) -> str:
    result = _run(command, environment=environment)
    try:
        return result.stdout.decode("utf-8").strip()
    except UnicodeDecodeError as exc:
        raise ReleaseDefect(f"{command[0]} returned non-UTF-8 output") from exc


def _bundle_files(path: Path) -> frozenset[str]:
    if not path.is_dir() or path.is_symlink():
        raise ReleaseDefect("release bundle must be a real directory")
    files: set[str] = set()
    for item in path.rglob("*"):
        if item.is_symlink():
            raise ReleaseDefect(f"release bundle contains a symlink: {item}")
        if item.is_file():
            files.add(item.relative_to(path).as_posix())
    return frozenset(files)


def _install_immutable_bundle(
    source: Path,
    paths: ReleasePaths,
    candidate: CandidateManifest,
) -> Path:
    if _bundle_files(source) != _BUNDLE_FILES:
        raise ReleaseDefect("release bundle has unsupported or missing files")
    destination = paths.bundle_root / candidate.source_sha
    if destination.exists():
        if _bundle_files(destination) != _BUNDLE_FILES:
            raise ReleaseDefect("installed release bundle has changed shape")
        for relative in _BUNDLE_FILES:
            if (source / relative).read_bytes() != (destination / relative).read_bytes():
                raise ReleaseDefect("installed immutable release bundle differs")
        return destination

    paths.bundle_root.mkdir(mode=0o755, parents=True, exist_ok=True)
    temporary = paths.bundle_root / f".{candidate.source_sha}.{os.getpid()}.partial"
    if temporary.exists():
        raise ReleaseDefect(f"stale bundle installation exists: {temporary}")
    try:
        for relative in sorted(_BUNDLE_FILES):
            target = temporary / relative
            target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
            shutil.copyfile(source / relative, target)
            target.chmod(0o555 if relative == "release.py" else 0o444)
            os.chown(target, 0, 0)
            with target.open("rb") as stream:
                os.fsync(stream.fileno())
        for directory in sorted(
            (item for item in temporary.rglob("*") if item.is_dir()),
            key=lambda item: len(item.parts),
            reverse=True,
        ):
            directory.chmod(0o555)
            os.chown(directory, 0, 0)
            _fsync_directory(directory)
        temporary.chmod(0o555)
        os.chown(temporary, 0, 0)
        _fsync_directory(temporary)
        os.replace(temporary, destination)
        _fsync_directory(paths.bundle_root)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
    return destination


def install_bundle(source: Path, paths: ReleasePaths) -> str:
    if _bundle_files(source) != _BUNDLE_FILES:
        raise ReleaseDefect("release bundle has unsupported or missing files")
    candidate = load_candidate_manifest(source / "candidate-manifest.json")
    store = ReleaseStore(paths)
    store.assert_no_oracle_attempt()
    store.require_current_record()
    destination = paths.bundle_root / candidate.source_sha
    if not destination.exists():
        active = store.active_attempt()
        if active is not None:
            raise ReleaseBlocked(
                f"application release {active.source_sha} is still {active.phase.value}"
            )
    _install_immutable_bundle(source, paths, candidate)
    return candidate.source_sha


def _read_env(path: Path) -> dict[str, str]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError) as exc:
        raise ReleaseDefect(f"could not read captured config {path}") from exc
    values: dict[str, str] = {}
    for line_number, line in enumerate(lines, 1):
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        if not separator or re.fullmatch(r"[A-Z][A-Z0-9_]*", key) is None or "\x00" in value:
            raise ReleaseDefect(f"config line {line_number} is malformed")
        if key in values:
            raise ReleaseDefect(f"config key {key} is duplicated")
        values[key] = value
    if not values:
        raise ReleaseDefect("captured config is empty")
    return values


def _unquote_env(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        return value[1:-1]
    return value


def publish_config(source: Path, store: ReleaseStore, *, next_source_sha: str) -> str:
    store.assert_no_oracle_attempt()
    store.require_current_record()
    store.assert_fresh_candidate(next_source_sha)
    values = _read_env(source)
    canonical = "".join(f"{key}={values[key]}\n" for key in sorted(values)).encode()
    digest = hashlib.sha256(canonical).hexdigest()
    store.paths.config_root.mkdir(mode=0o750, parents=True, exist_ok=True)
    destination = store.paths.config_root / f"{digest}.env"
    if not destination.exists() and not destination.is_symlink():
        _create_bytes(destination, canonical, mode=0o440)
    metadata = destination.lstat()
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != os.geteuid()
        or metadata.st_gid != os.getegid()
        or stat.S_IMODE(metadata.st_mode) != 0o440
        or destination.read_bytes() != canonical
    ):
        raise ReleaseDefect("content-addressed config path is not exact immutable input")

    store.paths.current_config.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    temporary = store.paths.current_config.with_name(
        f".{store.paths.current_config.name}.{os.getpid()}.partial"
    )
    try:
        os.symlink(destination, temporary)
        os.replace(temporary, store.paths.current_config)
        _fsync_directory(store.paths.current_config.parent)
    finally:
        temporary.unlink(missing_ok=True)
    return digest


class HostRelease:
    def __init__(self, paths: ReleasePaths) -> None:
        self.paths = paths
        self.store = ReleaseStore(paths)

    def bundle(self, source_sha: str) -> Path:
        _require_match("bundle source SHA", source_sha, _SHA)
        bundle = self.paths.bundle_root / source_sha
        if _bundle_files(bundle) != _BUNDLE_FILES:
            raise ReleaseDefect("installed release bundle has unsupported or missing files")
        for relative in _BUNDLE_FILES:
            item = bundle / relative
            metadata = item.stat()
            if metadata.st_uid != 0 or metadata.st_mode & 0o222:
                raise ReleaseDefect(
                    f"installed release asset is not root-owned immutable: {relative}"
                )
        candidate = load_candidate_manifest(bundle / "candidate-manifest.json")
        if candidate.source_sha != source_sha:
            raise ReleaseDefect("bundle path and candidate source SHA differ")
        return bundle

    def _validate_release_inputs(
        self,
        *,
        bundle: Path,
        candidate: CandidateManifest,
        attempt: ReleaseAttempt,
        check_caddy: bool = True,
    ) -> None:
        manifest_path = bundle / "candidate-manifest.json"
        if (
            candidate.source_sha != attempt.source_sha
            or _sha256(manifest_path) != attempt.manifest_sha256
        ):
            raise ReleaseDefect("attempt and immutable candidate manifest differ")
        config_path = Path(attempt.config_path)
        try:
            config_root = self.paths.config_root.resolve(strict=True)
            resolved_config = config_path.resolve(strict=True)
        except OSError as exc:
            raise ReleaseDefect("captured release config cannot be resolved") from exc
        config_metadata = resolved_config.stat()
        if (
            config_path.is_symlink()
            or resolved_config.parent != config_root
            or resolved_config.name != f"{attempt.config_sha256}.env"
            or _sha256(resolved_config) != attempt.config_sha256
            or config_metadata.st_uid != 0
            or config_metadata.st_mode & 0o022
        ):
            raise ReleaseDefect("captured release config is not immutable exact input")
        if check_caddy:
            caddy_metadata = self.paths.caddy_config.stat()
            if (
                not stat.S_ISREG(caddy_metadata.st_mode)
                or caddy_metadata.st_uid != 0
                or caddy_metadata.st_gid != 0
                or stat.S_IMODE(caddy_metadata.st_mode) != 0o444
                or (bundle / "Caddyfile").read_bytes() != self.paths.caddy_config.read_bytes()
            ):
                raise ReleaseDefect("installed Caddy configuration differs from release input")

    def _validate_caddy_mount(self, inspected: dict[str, Any]) -> None:
        mounts = inspected.get("Mounts")
        if not isinstance(mounts, list):
            raise ReleaseDefect("caddy mount evidence is malformed")
        caddyfile_mounts = [
            mount
            for mount in mounts
            if isinstance(mount, dict) and mount.get("Destination") == "/etc/caddy/Caddyfile"
        ]
        if len(caddyfile_mounts) != 1:
            raise PermanentReleaseFailure("live caddy does not have one exact Caddyfile mount")
        mount = caddyfile_mounts[0]
        if (
            mount.get("Type") != "bind"
            or mount.get("Source") != str(self.paths.caddy_config.resolve(strict=True))
            or mount.get("RW") is not False
        ):
            raise PermanentReleaseFailure(
                "live caddy does not use the installed read-only Caddyfile"
            )

    def _compose_environment(
        self,
        *,
        candidate: CandidateManifest,
        config_path: Path,
    ) -> dict[str, str]:
        environment = dict(os.environ)
        for key in _read_env(config_path):
            environment.pop(key, None)
        environment.update(
            {
                "API_IMAGE": candidate.images.api,
                "WORKER_IMAGE": candidate.images.worker,
                "NEXUS_CONFIG_FILE": str(config_path),
            }
        )
        return environment

    def _compose(
        self,
        *,
        bundle: Path,
        candidate: CandidateManifest,
        config_path: Path,
        arguments: tuple[str, ...],
        input_bytes: bytes | None = None,
        timeout_seconds: int = 180,
    ) -> subprocess.CompletedProcess[bytes]:
        return _run(
            (
                "docker",
                "compose",
                "--project-name",
                "nexus",
                "--env-file",
                str(config_path),
                "--file",
                str(bundle / "docker-compose.yml"),
                *arguments,
            ),
            environment=self._compose_environment(
                candidate=candidate,
                config_path=config_path,
            ),
            input_bytes=input_bytes,
            timeout_seconds=timeout_seconds,
        )

    def _compose_job(
        self,
        *,
        name: str,
        bundle: Path,
        candidate: CandidateManifest,
        config_path: Path,
        arguments: tuple[str, ...],
        timeout_seconds: int,
    ) -> bytes:
        completed = self._settle_compose_job(name)
        if completed is not None:
            return completed

        result = self._compose(
            bundle=bundle,
            candidate=candidate,
            config_path=config_path,
            arguments=("run", "--name", name, "--no-deps", "--no-TTY", *arguments),
            timeout_seconds=timeout_seconds,
        )
        _run(("docker", "rm", name))
        return result.stdout

    def _settle_compose_job(self, name: str) -> bytes | None:
        if re.fullmatch(r"nexus-[a-z0-9-]{1,120}", name) is None:
            raise ReleaseDefect("durable Compose job name is malformed")
        listed = _stdout(
            (
                "docker",
                "ps",
                "--all",
                "--quiet",
                "--filter",
                f"name=^/{name}$",
            )
        )
        if "\n" in listed:
            raise ReleaseDefect(f"durable Compose job {name} is not unique")
        if listed:
            _require_match("durable Compose job container id", listed, _CONTAINER_ID)
            raw = _read_json_output(
                _run(("docker", "inspect", listed)).stdout,
                f"durable Compose job {name}",
            )
            if not isinstance(raw, list) or len(raw) != 1 or not isinstance(raw[0], dict):
                raise ReleaseDefect(f"durable Compose job {name} inspect is malformed")
            state = _mapping(raw[0].get("State"), f"durable Compose job {name} state")
            if state.get("Running") is True:
                raise ReleaseBlocked(f"durable Compose job {name} is still running")
            exit_code = state.get("ExitCode")
            if type(exit_code) is not int:
                raise ReleaseDefect(f"durable Compose job {name} exit code is malformed")
            output = _run(("docker", "logs", "--tail", "1", listed)).stdout
            _run(("docker", "rm", listed))
            if exit_code != 0:
                raise ExternalCommandFailed(f"durable Compose job {name} failed")
            return output
        return None

    def _config_snapshot(self) -> ConfigSnapshot:
        if not self.paths.current_config.is_symlink():
            raise ReleaseDefect("current config must be an atomic content-addressed symlink")
        try:
            path = self.paths.current_config.resolve(strict=True)
            root = self.paths.config_root.resolve(strict=True)
        except OSError as exc:
            raise ReleaseDefect("current config target cannot be resolved") from exc
        if path.parent != root or re.fullmatch(r"[0-9a-f]{64}\.env", path.name) is None:
            raise ReleaseDefect("current config points outside the canonical config root")
        metadata = path.stat()
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != 0
            or metadata.st_gid != 0
            or stat.S_IMODE(metadata.st_mode) != 0o440
        ):
            raise ReleaseDefect("current config is not root-owned immutable input")
        digest = _sha256(path)
        if path.name != f"{digest}.env":
            raise ReleaseDefect("current config filename disagrees with its content digest")
        return ConfigSnapshot(path=path, sha256=digest, values=_read_env(path))

    def _container_evidence(
        self,
        *,
        bundle: Path,
        candidate: CandidateManifest,
        config_path: Path,
        writers_running: bool,
    ) -> dict[str, ContainerEvidence]:
        evidence: dict[str, ContainerEvidence] = {}
        config_values = _read_env(config_path)
        expected_infra_images = {
            "postgres": _unquote_env(config_values.get("POSTGRES_IMAGE", "")),
            "caddy": _unquote_env(config_values.get("CADDY_IMAGE", "")),
        }
        for service, image in expected_infra_images.items():
            if _IMAGE_REFERENCE.fullmatch(image) is None:
                raise ReleaseDefect(f"{service} image config must be an immutable digest")
        for service in _SERVICES:
            result = self._compose(
                bundle=bundle,
                candidate=candidate,
                config_path=config_path,
                arguments=("ps", "--all", "--quiet", service),
            )
            container_id = result.stdout.decode().strip()
            _require_match(f"{service} container id", container_id, _CONTAINER_ID)
            raw = _read_json_output(
                _run(("docker", "inspect", container_id)).stdout,
                f"{service} container inspect",
            )
            if not isinstance(raw, list) or len(raw) != 1 or not isinstance(raw[0], dict):
                raise ReleaseDefect(f"{service} container inspect shape is malformed")
            inspected = raw[0]
            state = _mapping(inspected.get("State"), f"{service} state")
            expected_running = writers_running if service in _WRITERS else True
            if state.get("Running") is not expected_running:
                state_name = "running" if expected_running else "stopped"
                raise ReleaseDefect(f"{service} is not {state_name} before release")
            if service in _WRITERS and expected_running:
                health = state.get("Health")
                if not isinstance(health, dict) or health.get("Status") != "healthy":
                    raise ExternalCommandFailed(
                        f"predecessor {service} is not healthy",
                        operation=f"predecessor-health:{service}",
                    )
            image_id = _require_match(f"{service} image id", inspected.get("Image"), _IMAGE_ID)
            config = _mapping(inspected.get("Config"), f"{service} config")
            if (
                service in expected_infra_images
                and config.get("Image") != expected_infra_images[service]
            ):
                raise PermanentReleaseFailure(
                    f"live {service} image reference differs from captured config"
                )
            if service == "caddy":
                self._validate_caddy_mount(inspected)
            evidence[service] = ContainerEvidence(
                container_id=container_id,
                image=image_id,
                config_sha256=hashlib.sha256(_canonical_json(config)).hexdigest(),
            )
        return evidence

    def _image_identity(self, image: str, candidate: CandidateManifest) -> str:
        _run(("docker", "pull", image), timeout_seconds=600)
        inspected = _read_json_output(
            _run(("docker", "image", "inspect", image)).stdout,
            "candidate image inspect",
        )
        if (
            not isinstance(inspected, list)
            or len(inspected) != 1
            or not isinstance(inspected[0], dict)
        ):
            raise ReleaseDefect("candidate image inspect shape is malformed")
        image_id = _require_match("candidate image id", inspected[0].get("Id"), _IMAGE_ID)
        config = _mapping(inspected[0].get("Config"), "candidate image config")
        labels = _mapping(config.get("Labels"), "candidate image labels")
        if labels.get("org.opencontainers.image.revision") != candidate.source_sha:
            raise PermanentReleaseFailure("candidate OCI revision label differs")
        identity_bytes = _run(
            (
                "docker",
                "run",
                "--rm",
                "--entrypoint",
                "cat",
                image,
                "/app/runtime-identity.json",
            )
        ).stdout
        identity_value = _read_json_output(identity_bytes, "candidate runtime identity")
        mapping = _mapping(identity_value, "candidate runtime identity")
        if mapping.keys() != {
            "source_sha",
            "expected_database_revision",
            "expected_oracle_manifest_digest",
        }:
            raise ReleaseDefect("candidate runtime identity fields are unsupported")
        identity = RuntimeIdentity(
            source_sha=_string(mapping, "source_sha"),
            expected_database_revision=_string(mapping, "expected_database_revision"),
            expected_oracle_manifest_digest=_string(mapping, "expected_oracle_manifest_digest"),
        )
        if identity_bytes != _canonical_json(identity.as_json()):
            raise ReleaseDefect("candidate runtime identity is not canonical JSON")
        if (
            identity.source_sha != candidate.source_sha
            or identity.expected_database_revision != candidate.expected_database_revision
            or identity.expected_oracle_manifest_digest != candidate.expected_oracle_manifest_digest
        ):
            raise PermanentReleaseFailure("candidate runtime identity differs from manifest")
        return image_id

    def _database_revisions(
        self,
        *,
        bundle: Path,
        candidate: CandidateManifest,
        config_path: Path,
        operation: str,
    ) -> tuple[str, ...]:
        if not operation:
            raise ReleaseDefect("database revision proof operation is empty")
        try:
            table = (
                self._compose(
                    bundle=bundle,
                    candidate=candidate,
                    config_path=config_path,
                    arguments=(
                        "exec",
                        "-T",
                        "postgres",
                        "sh",
                        "-c",
                        'psql -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" '
                        "-c \"SELECT COALESCE(to_regclass('public.alembic_version')::text, '')\"",
                    ),
                )
                .stdout.decode()
                .strip()
            )
            if not table:
                return ()
            output = (
                self._compose(
                    bundle=bundle,
                    candidate=candidate,
                    config_path=config_path,
                    arguments=(
                        "exec",
                        "-T",
                        "postgres",
                        "sh",
                        "-c",
                        'psql -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" '
                        '-c "SELECT version_num FROM alembic_version ORDER BY version_num"',
                    ),
                )
                .stdout.decode()
                .strip()
            )
        except ExternalCommandFailed as exc:
            raise ExternalCommandFailed(str(exc), operation=operation) from exc
        revisions = tuple(line for line in output.splitlines() if line)
        if any(_DATABASE_REVISION.fullmatch(revision) is None for revision in revisions):
            raise ReleaseDefect("database has a malformed Alembic revision")
        return revisions

    def _prove_database_ancestry(
        self,
        *,
        candidate: CandidateManifest,
        current_revision: str,
    ) -> None:
        output = _run(
            (
                "docker",
                "run",
                "--rm",
                "--entrypoint",
                "/app/.venv/bin/python",
                candidate.images.api,
                "-c",
                _DATABASE_ANCESTRY_SCRIPT,
                current_revision,
                candidate.expected_database_revision,
            )
        ).stdout
        proof = _closed_mapping(
            _read_json_output(output, "database ancestry proof"),
            frozenset({"candidate_head", "current_revision", "heads", "is_ancestor"}),
            "database ancestry proof",
        )
        if (
            _string(proof, "candidate_head") != candidate.expected_database_revision
            or _string(proof, "current_revision") != current_revision
            or _string_list(proof.get("heads"), "database ancestry heads")
            != (candidate.expected_database_revision,)
            or not _boolean(proof, "is_ancestor")
        ):
            raise PermanentReleaseFailure(
                "database revision is not an ancestor of the candidate head"
            )

    def preflight(self, source_sha: str) -> PreflightEvidence:
        self.store.assert_no_oracle_attempt()
        current_record = self.store.require_current_record()
        current_sha = current_record.source_sha
        self.store.assert_candidate_admissible(source_sha)
        forward_fix_sha = self.store.forward_fix_sha()
        if forward_fix_sha is None:
            self.verify_current(current_sha)
        bundle = self.bundle(source_sha)
        candidate = load_candidate_manifest(bundle / "candidate-manifest.json")
        config = self._config_snapshot()
        _require_match(
            "public API host",
            _unquote_env(config.values.get("CADDY_SITE", "")),
            _HOST,
        )
        caddy_metadata = self.paths.caddy_config.stat()
        if (
            not stat.S_ISREG(caddy_metadata.st_mode)
            or caddy_metadata.st_uid != 0
            or caddy_metadata.st_gid != 0
            or stat.S_IMODE(caddy_metadata.st_mode) != 0o444
            or (bundle / "Caddyfile").read_bytes() != self.paths.caddy_config.read_bytes()
        ):
            raise PermanentReleaseFailure(
                "installed Caddy configuration differs from release input"
            )
        self._compose(
            bundle=bundle,
            candidate=candidate,
            config_path=config.path,
            arguments=("config", "--quiet"),
        )
        api_image_id = self._image_identity(candidate.images.api, candidate)
        worker_image_id = self._image_identity(candidate.images.worker, candidate)
        containers = self._container_evidence(
            bundle=bundle,
            candidate=candidate,
            config_path=config.path,
            writers_running=forward_fix_sha is None,
        )
        if forward_fix_sha is None:
            if (
                containers["api"].image != current_record.api_image_id
                or containers["worker-interactive"].image != current_record.worker_image_id
                or containers["worker-background"].image != current_record.worker_image_id
            ):
                raise PermanentReleaseFailure(
                    "live predecessor containers differ from the current release record"
                )
        revisions = self._database_revisions(
            bundle=bundle,
            candidate=candidate,
            config_path=config.path,
            operation="preflight-database-revisions",
        )
        if len(revisions) != 1:
            raise PermanentReleaseFailure("database must expose one Alembic revision")
        current_revision = revisions[0]
        self._prove_database_ancestry(
            candidate=candidate,
            current_revision=current_revision,
        )
        identity = self._database_scalar(
            bundle=bundle,
            candidate=candidate,
            config_path=config.path,
            sql="SELECT current_database() || ':' || system_identifier FROM pg_control_system()",
        )
        byte_count = int(
            self._database_scalar(
                bundle=bundle,
                candidate=candidate,
                config_path=config.path,
                sql="SELECT pg_database_size(current_database())",
            )
        )
        available = shutil.disk_usage(self.paths.backup_root.parent).free
        if available < byte_count * 2 + 268_435_456:
            raise ReleaseBlocked("backup filesystem has insufficient verified capacity")
        return PreflightEvidence(
            candidate=candidate,
            manifest_sha256=_sha256(bundle / "candidate-manifest.json"),
            bundle=bundle,
            config=config,
            containers=containers,
            database_revision=current_revision,
            database_identity=identity,
            api_image_id=api_image_id,
            worker_image_id=worker_image_id,
        )

    def _database_scalar(
        self,
        *,
        bundle: Path,
        candidate: CandidateManifest,
        config_path: Path,
        sql: str,
    ) -> str:
        result = (
            self._compose(
                bundle=bundle,
                candidate=candidate,
                config_path=config_path,
                arguments=(
                    "exec",
                    "-T",
                    "postgres",
                    "sh",
                    "-c",
                    'psql -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"',
                    "nexus-release-sql",
                    sql,
                ),
            )
            .stdout.decode()
            .strip()
        )
        if not result or "\n" in result:
            raise ReleaseDefect("database scalar proof returned an invalid result")
        return result

    def _assert_running_state(self, container_id: str, *, running: bool) -> None:
        observed = _stdout(("docker", "inspect", "--format", "{{.State.Running}}", container_id))
        expected = "true" if running else "false"
        if observed != expected:
            raise ExternalCommandFailed(
                f"container {container_id[:12]} running state is {observed}, expected {expected}"
            )

    def _stop_writers(
        self,
        *,
        bundle: Path,
        candidate: CandidateManifest,
        config_path: Path,
        attempt: ReleaseAttempt,
    ) -> None:
        self._compose(
            bundle=bundle,
            candidate=candidate,
            config_path=config_path,
            arguments=("stop", "--timeout", "30", *_WRITERS),
        )
        for service in _WRITERS:
            self._assert_running_state(
                attempt.containers[service].container_id,
                running=False,
            )

    def _stop_current_writers(
        self,
        *,
        bundle: Path,
        candidate: CandidateManifest,
        config_path: Path,
    ) -> None:
        self._compose(
            bundle=bundle,
            candidate=candidate,
            config_path=config_path,
            arguments=("stop", "--timeout", "30", *_WRITERS),
        )
        for service in _WRITERS:
            output = (
                self._compose(
                    bundle=bundle,
                    candidate=candidate,
                    config_path=config_path,
                    arguments=("ps", "--all", "--quiet", service),
                )
                .stdout.decode()
                .strip()
            )
            if not output:
                continue
            container_ids = output.splitlines()
            if len(container_ids) != 1:
                raise ReleaseDefect(f"stopped {service} has multiple containers")
            container_id = container_ids[0]
            _require_match(f"stopped {service} container id", container_id, _CONTAINER_ID)
            self._assert_running_state(container_id, running=False)

    def _restart_predecessor(self, attempt: ReleaseAttempt) -> None:
        for service in _WRITERS:
            evidence = attempt.containers[service]
            inspected = _read_json_output(
                _run(("docker", "inspect", evidence.container_id)).stdout,
                f"rollback {service} inspect",
            )
            if (
                not isinstance(inspected, list)
                or len(inspected) != 1
                or not isinstance(inspected[0], dict)
            ):
                raise ReleaseDefect(f"rollback {service} inspect shape is malformed")
            item = inspected[0]
            if item.get("Image") != evidence.image:
                raise ReleaseDefect(f"rollback {service} image identity changed")
            config = _mapping(item.get("Config"), f"rollback {service} config")
            if hashlib.sha256(_canonical_json(config)).hexdigest() != evidence.config_sha256:
                raise ReleaseDefect(f"rollback {service} config identity changed")
            _run(("docker", "start", evidence.container_id))

        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            statuses = []
            for service in _WRITERS:
                container_id = attempt.containers[service].container_id
                status = _stdout(
                    (
                        "docker",
                        "inspect",
                        "--format",
                        "{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}",
                        container_id,
                    )
                )
                statuses.append(status)
            if statuses == ["healthy", "healthy", "healthy"]:
                return
            # justify-polling: Docker health is the only predecessor readiness signal.
            time.sleep(1)
        raise ExternalCommandFailed("exact predecessor containers did not become healthy")

    def _backup(
        self,
        *,
        bundle: Path,
        candidate: CandidateManifest,
        attempt: ReleaseAttempt,
        database_identity: str,
        starting_revision: str,
    ) -> BackupEvidence:
        self.paths.backup_root.mkdir(mode=0o750, parents=True, exist_ok=True)
        os.chown(self.paths.backup_root, 0, 0)
        self.paths.backup_root.chmod(0o750)
        final = self.paths.backup_root / f"{attempt.source_sha}.dump"
        partial = final.with_suffix(".dump.partial")
        if os.path.lexists(partial):
            if partial.is_symlink() or not partial.is_file():
                raise ReleaseDefect(f"incomplete backup path is unsafe: {partial}")
            partial.unlink()
            _fsync_directory(partial.parent)
        if os.path.lexists(final):
            metadata = final.lstat()
            if (
                not stat.S_ISREG(metadata.st_mode)
                or metadata.st_uid != 0
                or metadata.st_gid != 0
                or stat.S_IMODE(metadata.st_mode) != 0o400
                or metadata.st_size < 1
            ):
                raise ReleaseDefect("existing release backup metadata is invalid")
            byte_count = metadata.st_size
            self._verify_backup(
                bundle=bundle,
                candidate=candidate,
                config_path=Path(attempt.config_path),
                path=final,
            )
            return BackupEvidence(
                path=str(final),
                sha256=_sha256(final),
                byte_count=byte_count,
                database_identity=database_identity,
                starting_revision=starting_revision,
            )

        command = (
            "docker",
            "compose",
            "--project-name",
            "nexus",
            "--env-file",
            attempt.config_path,
            "--file",
            str(bundle / "docker-compose.yml"),
            "exec",
            "-T",
            "postgres",
            "sh",
            "-c",
            'exec pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
        )
        environment = self._compose_environment(
            candidate=candidate,
            config_path=Path(attempt.config_path),
        )
        descriptor = -1
        try:
            try:
                descriptor = os.open(
                    partial,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                    0o400,
                )
                os.fchown(descriptor, 0, 0)
                os.fchmod(descriptor, 0o400)
                stream = os.fdopen(descriptor, "wb")
                descriptor = -1
                with stream:
                    subprocess.run(
                        command,
                        env=environment,
                        stdout=stream,
                        stderr=subprocess.PIPE,
                        check=True,
                        timeout=1800,
                    )
                    stream.flush()
                    os.fsync(stream.fileno())
            finally:
                if descriptor >= 0:
                    os.close(descriptor)
        except (
            subprocess.CalledProcessError,
            subprocess.TimeoutExpired,
            OSError,
        ) as exc:
            raise ExternalCommandFailed("bounded PostgreSQL backup failed") from exc
        partial_metadata = partial.lstat()
        if (
            not stat.S_ISREG(partial_metadata.st_mode)
            or partial_metadata.st_uid != 0
            or partial_metadata.st_gid != 0
            or stat.S_IMODE(partial_metadata.st_mode) != 0o400
            or partial_metadata.st_size < 1
        ):
            raise ReleaseDefect("PostgreSQL backup metadata is invalid")
        self._verify_backup(
            bundle=bundle,
            candidate=candidate,
            config_path=Path(attempt.config_path),
            path=partial,
        )
        digest = _sha256(partial)
        byte_count = partial_metadata.st_size
        os.replace(partial, final)
        _fsync_directory(final.parent)
        return BackupEvidence(
            path=str(final),
            sha256=digest,
            byte_count=byte_count,
            database_identity=database_identity,
            starting_revision=starting_revision,
        )

    def _validate_backup_evidence(
        self,
        *,
        bundle: Path,
        candidate: CandidateManifest,
        attempt: ReleaseAttempt,
    ) -> None:
        evidence = attempt.backup
        if evidence is None:
            raise ReleaseDefect("BackupVerified attempt lost its backup evidence")
        path = Path(evidence.path)
        if (
            path != self.paths.backup_root / f"{attempt.source_sha}.dump"
            or path.is_symlink()
            or not path.is_file()
        ):
            raise ReleaseDefect("recorded release backup path is not exact")
        metadata = path.lstat()
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != 0
            or metadata.st_gid != 0
            or stat.S_IMODE(metadata.st_mode) != 0o400
            or metadata.st_size != evidence.byte_count
        ):
            raise ReleaseDefect("recorded release backup metadata changed")
        if _sha256(path) != evidence.sha256:
            raise ReleaseDefect("recorded release backup digest changed")
        self._verify_backup(
            bundle=bundle,
            candidate=candidate,
            config_path=Path(attempt.config_path),
            path=path,
        )
        database_identity = self._database_scalar(
            bundle=bundle,
            candidate=candidate,
            config_path=Path(attempt.config_path),
            sql="SELECT current_database() || ':' || system_identifier FROM pg_control_system()",
        )
        if database_identity != evidence.database_identity:
            raise ReleaseDefect("release backup belongs to a different database")
        revisions = self._database_revisions(
            bundle=bundle,
            candidate=candidate,
            config_path=Path(attempt.config_path),
            operation="backup-database-revisions",
        )
        expected_revisions = (evidence.starting_revision,)
        if revisions != expected_revisions:
            raise PermanentReleaseFailure(
                "database changed after backup and before the migration boundary"
            )

    def _verify_backup(
        self,
        *,
        bundle: Path,
        candidate: CandidateManifest,
        config_path: Path,
        path: Path,
    ) -> None:
        command = (
            "docker",
            "compose",
            "--project-name",
            "nexus",
            "--env-file",
            str(config_path),
            "--file",
            str(bundle / "docker-compose.yml"),
            "exec",
            "-T",
            "postgres",
            "pg_restore",
            "--list",
        )
        try:
            with path.open("rb") as stream:
                result = subprocess.run(
                    command,
                    env=self._compose_environment(
                        candidate=candidate,
                        config_path=config_path,
                    ),
                    stdin=stream,
                    capture_output=True,
                    check=True,
                    timeout=300,
                )
        except (
            subprocess.CalledProcessError,
            subprocess.TimeoutExpired,
            OSError,
        ) as exc:
            raise ExternalCommandFailed("bounded PostgreSQL backup verification failed") from exc
        if not result.stdout.strip():
            raise ReleaseDefect("pg_restore did not list a valid database backup")

    def _migrate(
        self,
        *,
        bundle: Path,
        candidate: CandidateManifest,
        config_path: Path,
    ) -> None:
        self._compose_job(
            name=f"nexus-release-{candidate.source_sha}-migration",
            bundle=bundle,
            candidate=candidate,
            config_path=config_path,
            arguments=(
                "api",
                "sh",
                "-c",
                "cd /app/migrations && /app/.venv/bin/alembic upgrade head",
            ),
            timeout_seconds=1800,
        )

    def _settle_completed_migration(self, source_sha: str) -> None:
        self._settle_compose_job(f"nexus-release-{source_sha}-migration")

    def _prove_database_revision(
        self,
        *,
        bundle: Path,
        candidate: CandidateManifest,
        config_path: Path,
        operation: str,
    ) -> None:
        revisions = self._database_revisions(
            bundle=bundle,
            candidate=candidate,
            config_path=config_path,
            operation=operation,
        )
        if revisions != (candidate.expected_database_revision,):
            raise PermanentReleaseFailure(
                f"database revision is {revisions!r}, expected {candidate.expected_database_revision}"
            )

    def _prove_infra_unchanged(self, attempt: ReleaseAttempt) -> None:
        for service in ("postgres", "caddy"):
            evidence = attempt.containers[service]
            raw = _read_json_output(
                _run(("docker", "inspect", evidence.container_id)).stdout,
                f"{service} unchanged inspect",
            )
            if not isinstance(raw, list) or len(raw) != 1 or not isinstance(raw[0], dict):
                raise ReleaseDefect(f"{service} unchanged inspect shape is malformed")
            item = raw[0]
            config = _mapping(item.get("Config"), f"{service} unchanged config")
            if service == "caddy":
                self._validate_caddy_mount(item)
            if (
                item.get("Image") != evidence.image
                or hashlib.sha256(_canonical_json(config)).hexdigest() != evidence.config_sha256
                or _mapping(item.get("State"), f"{service} unchanged state").get("Running")
                is not True
            ):
                raise PermanentReleaseFailure(f"{service} identity changed during app release")

    def _prove_backend(
        self,
        *,
        bundle: Path,
        candidate: CandidateManifest,
        attempt: ReleaseAttempt,
    ) -> tuple[str, str, str]:
        config_path = Path(attempt.config_path)
        version = self._compose(
            bundle=bundle,
            candidate=candidate,
            config_path=config_path,
            arguments=(
                "exec",
                "-T",
                "api",
                "python",
                "-c",
                "import json,urllib.request;"
                "print(json.dumps(json.load(urllib.request.urlopen("
                "'http://127.0.0.1:8000/version',timeout=5)),sort_keys=True))",
            ),
        ).stdout
        try:
            value = _mapping(_read_json_output(version, "API version"), "API version")
            data = _mapping(value.get("data"), "API version data")
        except ReleaseDefect as exc:
            raise PermanentReleaseFailure("API version contract is malformed") from exc
        expected = {
            "source_sha": candidate.source_sha,
            "expected_database_revision": candidate.expected_database_revision,
            "expected_oracle_manifest_digest": candidate.expected_oracle_manifest_digest,
        }
        if (
            value.keys() != {"data"}
            or any(data.get(key) != item for key, item in expected.items())
            or set(data) != {*expected, "task_contract_digest"}
        ):
            raise PermanentReleaseFailure("API runtime identity differs from candidate")
        task_digest_value = data.get("task_contract_digest")
        if not isinstance(task_digest_value, str) or _SHA256.fullmatch(task_digest_value) is None:
            raise PermanentReleaseFailure("API task contract digest is malformed")
        task_digest = task_digest_value

        self._compose(
            bundle=bundle,
            candidate=candidate,
            config_path=config_path,
            arguments=(
                "exec",
                "-T",
                "api",
                "python",
                "-c",
                "import json,urllib.request;"
                "value=json.load(urllib.request.urlopen("
                "'http://127.0.0.1:8000/readyz',timeout=5));"
                "raise SystemExit(0 if value=={'data':{'status':'ready'}} else 12)",
            ),
        )
        for lane, service in (
            ("interactive", "worker-interactive"),
            ("background", "worker-background"),
        ):
            result = self._compose(
                bundle=bundle,
                candidate=candidate,
                config_path=config_path,
                arguments=(
                    "exec",
                    "-T",
                    service,
                    "python",
                    "-m",
                    "apps.worker.health",
                    "--lane",
                    lane,
                ),
            )
            try:
                worker = _mapping(
                    _read_json_output(result.stdout, f"{lane} worker health"),
                    lane,
                )
            except ReleaseDefect as exc:
                raise PermanentReleaseFailure(
                    f"{lane} worker health contract is malformed"
                ) from exc
            if (
                worker.keys()
                != {
                    "status",
                    "lane",
                    "source_sha",
                    "expected_database_revision",
                    "expected_oracle_manifest_digest",
                    "task_contract_digest",
                }
                or worker.get("status") != "ready"
                or worker.get("lane") != lane
                or worker.get("source_sha") != candidate.source_sha
                or worker.get("expected_database_revision") != candidate.expected_database_revision
                or worker.get("expected_oracle_manifest_digest")
                != candidate.expected_oracle_manifest_digest
                or worker.get("task_contract_digest") != task_digest
            ):
                raise PermanentReleaseFailure(f"{lane} worker runtime identity differs")
        self._prove_database_revision(
            bundle=bundle,
            candidate=candidate,
            config_path=config_path,
            operation="backend-readiness-revisions",
        )
        self._prove_infra_unchanged(attempt)
        api_id = self._container_image_id(
            bundle=bundle,
            candidate=candidate,
            config_path=config_path,
            service="api",
        )
        worker_ids = {
            self._container_image_id(
                bundle=bundle,
                candidate=candidate,
                config_path=config_path,
                service=service,
            )
            for service in ("worker-interactive", "worker-background")
        }
        if api_id != attempt.candidate_api_image_id:
            raise PermanentReleaseFailure("API container image differs from candidate digest")
        if worker_ids != {attempt.candidate_worker_image_id}:
            raise PermanentReleaseFailure("worker container images differ from candidate digest")
        return (
            attempt.candidate_api_image_id,
            attempt.candidate_worker_image_id,
            task_digest,
        )

    def _container_image_id(
        self,
        *,
        bundle: Path,
        candidate: CandidateManifest,
        config_path: Path,
        service: str,
    ) -> str:
        container_id = (
            self._compose(
                bundle=bundle,
                candidate=candidate,
                config_path=config_path,
                arguments=("ps", "--quiet", service),
            )
            .stdout.decode()
            .strip()
        )
        _require_match(f"{service} container id", container_id, _CONTAINER_ID)
        image_id = _stdout(("docker", "inspect", "--format", "{{.Image}}", container_id))
        _require_match(f"{service} image id", image_id, _IMAGE_ID)
        return image_id

    def apply(
        self,
        *,
        source_sha: str,
        deployment_id: str,
        production_host: str,
    ) -> ReleaseAttempt:
        self.store.assert_no_oracle_attempt()
        self.store.require_current_record()
        failures: dict[str, int] = {}
        while True:
            try:
                return self._apply_once(
                    source_sha=source_sha,
                    deployment_id=deployment_id,
                    production_host=production_host,
                )
            except PermanentReleaseFailure:
                self._terminalize_attempt(source_sha, failure_code="candidate-invariant")
                raise
            except ExternalCommandFailed as exc:
                operation = self._retry_operation(source_sha, exc.operation)
                failures[operation] = failures.get(operation, 0) + 1
                if failures[operation] < _EXTERNAL_ATTEMPTS:
                    time.sleep(_EXTERNAL_RETRY_DELAY_SECONDS)
                    continue
                self._terminalize_attempt(source_sha, failure_code="external-exhausted")
                raise

    def _retry_operation(self, source_sha: str, operation: str) -> str:
        attempt = self.store.load_attempt(source_sha)
        phase = "Preflight" if attempt is None else attempt.phase.value
        return f"{phase}:{operation}"

    def _apply_once(
        self,
        *,
        source_sha: str,
        deployment_id: str,
        production_host: str,
    ) -> ReleaseAttempt:
        self.store.assert_no_oracle_attempt()
        _require_match("Vercel deployment id", deployment_id, _DEPLOYMENT_ID)
        _require_match("production host", production_host, _HOST)
        self.store.assert_candidate_admissible(source_sha)
        existing = self.store.load_attempt(source_sha)
        if existing is None:
            preflight = self.preflight(source_sha)
            current = self.store.require_current_record().source_sha
            attempt = ReleaseAttempt.prepared(
                source_sha=source_sha,
                manifest_sha256=preflight.manifest_sha256,
                candidate_api_image_id=preflight.api_image_id,
                candidate_worker_image_id=preflight.worker_image_id,
                predecessor_sha=current,
                forward_fix_of=self.store.forward_fix_sha(),
                containers=preflight.containers,
                config_path=str(preflight.config.path),
                config_sha256=preflight.config.sha256,
                vercel_deployment_id=deployment_id,
                production_host=production_host,
                now=_now(),
            )
            self.store.create_attempt(attempt)
        else:
            attempt = existing
            if (
                attempt.vercel_deployment_id != deployment_id
                or attempt.production_host != production_host
            ):
                raise ReleaseBlocked("resume must reuse its bound Vercel deployment")
            preflight = None

        if attempt.phase is ReleasePhase.RollbackRequired:
            self._complete_rollback(attempt)
            raise ReleaseBlocked(
                f"release {source_sha} completed its required predecessor rollback"
            )

        bundle = self.bundle(source_sha)
        candidate = load_candidate_manifest(bundle / "candidate-manifest.json")
        if attempt.phase is ReleasePhase.ForwardFixPending:
            self._complete_forward_fix(
                attempt,
                bundle=bundle,
                candidate=candidate,
            )
            raise ReleaseBlocked(
                f"release {source_sha} completed its required forward-fix publication"
            )
        self._validate_release_inputs(
            bundle=bundle,
            candidate=candidate,
            attempt=attempt,
        )
        if (
            self.store.forward_fix_sha() == source_sha
            and attempt.phase is not ReleasePhase.ForwardFixRequired
        ):
            self._record_permanent_failure(
                attempt,
                bundle=bundle,
                candidate=candidate,
                failure_code="failure-publication-recovered",
            )
            raise ReleaseBlocked(
                f"release {source_sha} completed its pending ForwardFixRequired publication"
            )
        if attempt.phase is ReleasePhase.Prepared:
            self._stop_writers(
                bundle=bundle,
                candidate=candidate,
                config_path=Path(attempt.config_path),
                attempt=attempt,
            )
            attempt = attempt.advance(ReleasePhase.WritersStopped, now=_now())
            self.store.replace_attempt(attempt)

        if attempt.phase is ReleasePhase.WritersStopped:
            revisions = self._database_revisions(
                bundle=bundle,
                candidate=candidate,
                config_path=Path(attempt.config_path),
                operation="migration-start-revisions",
            )
            if len(revisions) != 1:
                raise PermanentReleaseFailure(
                    "migration start requires one exact database revision"
                )
            if revisions == (candidate.expected_database_revision,):
                attempt = attempt.advance(
                    ReleasePhase.BackendActivationStarted,
                    now=_now(),
                )
                self.store.replace_attempt(attempt)
            else:
                if len(revisions) > 1:
                    raise PermanentReleaseFailure(
                        "pending migration requires at most one exact starting revision"
                    )
                starting_revision = revisions[0]
                backup = self._backup(
                    bundle=bundle,
                    candidate=candidate,
                    attempt=attempt,
                    database_identity=(
                        preflight.database_identity
                        if preflight is not None
                        else self._database_scalar(
                            bundle=bundle,
                            candidate=candidate,
                            config_path=Path(attempt.config_path),
                            sql=(
                                "SELECT current_database() || ':' || system_identifier "
                                "FROM pg_control_system()"
                            ),
                        )
                    ),
                    starting_revision=starting_revision,
                )
                attempt = attempt.with_backup(
                    path=backup.path,
                    sha256=backup.sha256,
                    byte_count=backup.byte_count,
                    database_identity=backup.database_identity,
                    starting_revision=backup.starting_revision,
                    now=_now(),
                )
                self.store.replace_attempt(attempt)

        if attempt.phase is ReleasePhase.BackupVerified:
            self._validate_backup_evidence(
                bundle=bundle,
                candidate=candidate,
                attempt=attempt,
            )
            attempt = attempt.advance(ReleasePhase.DataMutationStarted, now=_now())
            self.store.replace_attempt(attempt)

        if attempt.phase is ReleasePhase.DataMutationStarted:
            revisions = self._database_revisions(
                bundle=bundle,
                candidate=candidate,
                config_path=Path(attempt.config_path),
                operation="migration-recovery-revisions",
            )
            if len(revisions) != 1:
                raise PermanentReleaseFailure(
                    "migration recovery requires one exact database revision"
                )
            current_revision = revisions[0]
            self._prove_database_ancestry(
                candidate=candidate,
                current_revision=current_revision,
            )
            if revisions == (candidate.expected_database_revision,):
                self._settle_completed_migration(candidate.source_sha)
            else:
                self._migrate(
                    bundle=bundle,
                    candidate=candidate,
                    config_path=Path(attempt.config_path),
                )
            self._prove_database_revision(
                bundle=bundle,
                candidate=candidate,
                config_path=Path(attempt.config_path),
                operation="migration-result-revisions",
            )
            attempt = attempt.advance(
                ReleasePhase.BackendActivationStarted,
                now=_now(),
            )
            self.store.replace_attempt(attempt)

        if attempt.phase is ReleasePhase.BackendActivationStarted:
            self._compose(
                bundle=bundle,
                candidate=candidate,
                config_path=Path(attempt.config_path),
                arguments=(
                    "up",
                    "--detach",
                    "--no-deps",
                    "--wait",
                    "--wait-timeout",
                    "90",
                    *_WRITERS,
                ),
                timeout_seconds=120,
            )
            self._prove_backend(bundle=bundle, candidate=candidate, attempt=attempt)
            attempt = attempt.advance(
                ReleasePhase.AwaitingFrontendPromotion,
                now=_now(),
            )
            self.store.replace_attempt(attempt)

        if attempt.phase is not ReleasePhase.AwaitingFrontendPromotion:
            raise ReleaseBlocked(f"host apply cannot continue phase {attempt.phase.value}")
        return attempt

    def _terminalize_attempt(self, source_sha: str, *, failure_code: str) -> None:
        attempt = self.store.load_attempt(source_sha)
        if attempt is None or attempt.terminal:
            return
        if attempt.phase is ReleasePhase.RollbackRequired:
            self._complete_rollback(attempt)
            return
        bundle = self.bundle(source_sha)
        candidate = load_candidate_manifest(bundle / "candidate-manifest.json")
        if attempt.phase is ReleasePhase.ForwardFixPending:
            self._complete_forward_fix(
                attempt,
                bundle=bundle,
                candidate=candidate,
            )
            return
        self._record_permanent_failure(
            attempt,
            bundle=bundle,
            candidate=candidate,
            failure_code=failure_code,
        )

    def fail_bound_frontend(
        self,
        *,
        source_sha: str,
        deployment_id: str,
    ) -> ReleaseAttempt:
        """Settle an attempt whose immutable frontend deployment is permanently gone."""
        return self._settle_frontend_failure(
            source_sha=source_sha,
            deployment_id=deployment_id,
            failure_code="bound-frontend-unavailable",
        )

    def fail_auth_smoke(
        self,
        *,
        source_sha: str,
        deployment_id: str,
    ) -> ReleaseAttempt:
        """Settle a promoted attempt whose post-alias auth oracle failed."""
        return self._settle_frontend_failure(
            source_sha=source_sha,
            deployment_id=deployment_id,
            failure_code="post-alias-auth-smoke-failed",
        )

    def _settle_frontend_failure(
        self,
        *,
        source_sha: str,
        deployment_id: str,
        failure_code: str,
    ) -> ReleaseAttempt:
        self.store.assert_no_oracle_attempt()
        self.store.require_current_record()
        _require_match("Vercel deployment id", deployment_id, _DEPLOYMENT_ID)
        attempt = self.store.load_attempt(source_sha)
        if attempt is None:
            raise ReleaseBlocked("bound frontend failure requires an existing attempt")
        if attempt.vercel_deployment_id != deployment_id:
            raise ReleaseBlocked("bound frontend failure must name the exact stored deployment")
        if attempt.terminal:
            raise ReleaseBlocked("bound frontend failure cannot rewrite a terminal attempt")
        self._terminalize_attempt(
            source_sha,
            failure_code=failure_code,
        )
        settled = self.store.load_attempt(source_sha)
        if settled is None or not settled.terminal:
            raise ReleaseDefect("bound frontend failure did not settle the attempt")
        return settled

    def _record_permanent_failure(
        self,
        attempt: ReleaseAttempt,
        *,
        bundle: Path,
        candidate: CandidateManifest,
        failure_code: str,
    ) -> None:
        forward_fix = self.store.forward_fix_sha()
        outcome = permanent_failure_phase(
            attempt.phase,
            forward_fix=forward_fix is not None,
        )
        if outcome is ReleasePhase.RollbackRequired:
            attempt = attempt.advance(
                ReleasePhase.RollbackRequired,
                now=_now(),
                failure_code=failure_code,
            )
            self.store.replace_attempt(attempt)
            self._complete_rollback(attempt)
        else:
            attempt = attempt.advance(
                ReleasePhase.ForwardFixPending,
                now=_now(),
                failure_code=failure_code,
            )
            self.store.replace_attempt(attempt)
            self._complete_forward_fix(
                attempt,
                bundle=bundle,
                candidate=candidate,
            )

    def _complete_rollback(self, attempt: ReleaseAttempt) -> None:
        if attempt.phase is not ReleasePhase.RollbackRequired:
            raise ReleaseDefect("predecessor rollback requires durable rollback intent")
        self._restart_predecessor(attempt)
        rolled_back = attempt.advance(
            ReleasePhase.RolledBack,
            now=_now(),
            failure_code=attempt.failure_code,
        )
        self.store.replace_attempt(rolled_back)

    def _complete_forward_fix(
        self,
        attempt: ReleaseAttempt,
        *,
        bundle: Path,
        candidate: CandidateManifest,
    ) -> None:
        if attempt.phase is not ReleasePhase.ForwardFixPending:
            raise ReleaseDefect("forward fix requires durable failure intent")
        if self.store.forward_fix_sha() is None:
            self.store.set_forward_fix(attempt.source_sha)
        self._stop_current_writers(
            bundle=bundle,
            candidate=candidate,
            config_path=Path(attempt.config_path),
        )
        failed = attempt.advance(
            ReleasePhase.ForwardFixRequired,
            now=_now(),
            failure_code=attempt.failure_code,
        )
        self.store.replace_attempt(failed)

    def _fetch_json(self, url: str) -> tuple[dict[str, Any], dict[str, str]]:
        operation = f"public-http:{url}"
        request = urllib.request.Request(url, headers={"Accept": "application/json"})
        opener = urllib.request.build_opener(_RejectRedirects())
        try:
            with opener.open(request, timeout=8) as response:
                if response.status != 200:
                    raise ExternalCommandFailed(
                        f"public proof returned HTTP {response.status}",
                        operation=operation,
                    )
                body = response.read(65_537)
                if len(body) > 65_536:
                    raise PermanentReleaseFailure("public proof body exceeds its bound")
                if response.geturl() != url:
                    raise PermanentReleaseFailure("public proof URL changed")
                if response.headers.get("Location") is not None:
                    raise PermanentReleaseFailure("public proof returned Location")
                if response.headers.get("Set-Cookie") is not None:
                    raise PermanentReleaseFailure("public proof mutated authentication state")
                headers = {
                    key.lower(): ",".join(response.headers.get_all(key, failobj=[]))
                    for key in response.headers.keys()
                }
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise ExternalCommandFailed(
                f"public proof failed for {url}",
                operation=operation,
            ) from exc
        try:
            value = _mapping(
                _read_json_output(body, f"public proof {url}"),
                "public proof",
            )
        except ReleaseDefect as exc:
            raise PermanentReleaseFailure("public JSON contract is malformed") from exc
        return value, headers

    def _prove_public(
        self,
        attempt: ReleaseAttempt,
        candidate: CandidateManifest,
        *,
        expected_task_contract_digest: str,
    ) -> None:
        _require_match(
            "expected task contract digest",
            expected_task_contract_digest,
            _SHA256,
        )
        web, web_headers = self._fetch_json(f"https://{attempt.production_host}/version")
        if web != {"source_sha": candidate.source_sha}:
            raise ReleaseBlocked("authoritative frontend does not serve the bound candidate")
        if web_headers.get("cache-control") != "no-store":
            raise PermanentReleaseFailure("frontend version response is cacheable")
        config = _read_env(Path(attempt.config_path))
        api_host = _unquote_env(config.get("CADDY_SITE", ""))
        _require_match("public API host", api_host, _HOST)
        api_url = f"https://{api_host}/version"
        api, api_headers = self._fetch_json(api_url)
        if api.keys() != {"data"}:
            raise PermanentReleaseFailure("public API version fields are not closed")
        try:
            data = _mapping(api.get("data"), "public API version data")
        except ReleaseDefect as exc:
            raise PermanentReleaseFailure("public API version data is malformed") from exc
        if data.keys() != {
            "source_sha",
            "expected_database_revision",
            "expected_oracle_manifest_digest",
            "task_contract_digest",
        }:
            raise PermanentReleaseFailure("public API version data fields are not closed")
        if (
            data.get("source_sha") != candidate.source_sha
            or data.get("expected_database_revision") != candidate.expected_database_revision
            or data.get("expected_oracle_manifest_digest")
            != candidate.expected_oracle_manifest_digest
            or data.get("task_contract_digest") != expected_task_contract_digest
        ):
            raise PermanentReleaseFailure("public API identity differs from candidate")
        if api_headers.get("cache-control") != "no-store":
            raise PermanentReleaseFailure("API version response is cacheable")
        ready_url = f"https://{api_host}/readyz"
        ready, ready_headers = self._fetch_json(ready_url)
        if ready != {"data": {"status": "ready"}}:
            raise ExternalCommandFailed(
                "public API is not exactly ready",
                operation=f"public-contract:{ready_url}",
            )
        if ready_headers.get("cache-control") != "no-store":
            raise PermanentReleaseFailure("API readiness response is cacheable")

    def finalize(self, *, source_sha: str, deployment_id: str) -> ReleaseAttempt:
        self.store.assert_no_oracle_attempt()
        self.store.require_current_record()
        failures: dict[str, int] = {}
        while True:
            try:
                return self._finalize_once(
                    source_sha=source_sha,
                    deployment_id=deployment_id,
                )
            except PermanentReleaseFailure:
                self._terminalize_attempt(source_sha, failure_code="candidate-invariant")
                raise
            except ExternalCommandFailed as exc:
                operation = self._retry_operation(source_sha, exc.operation)
                failures[operation] = failures.get(operation, 0) + 1
                if failures[operation] < _EXTERNAL_ATTEMPTS:
                    time.sleep(_EXTERNAL_RETRY_DELAY_SECONDS)
                    continue
                self._terminalize_attempt(source_sha, failure_code="external-exhausted")
                raise

    def _finalize_once(self, *, source_sha: str, deployment_id: str) -> ReleaseAttempt:
        attempt = self.store.load_attempt(source_sha)
        if attempt is None:
            raise ReleaseBlocked(f"release attempt {source_sha} does not exist")
        if attempt.vercel_deployment_id != deployment_id:
            raise ReleaseBlocked("finalize deployment differs from the bound Vercel candidate")
        bundle = self.bundle(source_sha)
        candidate = load_candidate_manifest(bundle / "candidate-manifest.json")
        self._validate_release_inputs(
            bundle=bundle,
            candidate=candidate,
            attempt=attempt,
        )
        if self.store.current_sha() == source_sha:
            _, _, task_digest = self._prove_backend(
                bundle=bundle,
                candidate=candidate,
                attempt=attempt,
            )
            self._prove_public(
                attempt,
                candidate,
                expected_task_contract_digest=task_digest,
            )
            succeeded = self.store.complete_published_attempt(source_sha, now=_now())
            self.store.clear_forward_fix_after_success(source_sha)
            return succeeded
        if attempt.phase is ReleasePhase.AwaitingFrontendPromotion:
            _, _, task_digest = self._prove_backend(
                bundle=bundle,
                candidate=candidate,
                attempt=attempt,
            )
            self._prove_public(
                attempt,
                candidate,
                expected_task_contract_digest=task_digest,
            )
            attempt = attempt.advance(ReleasePhase.FrontendPromoted, now=_now())
            self.store.replace_attempt(attempt)
        elif attempt.phase is not ReleasePhase.FrontendPromoted:
            raise ReleaseBlocked(f"finalize cannot continue phase {attempt.phase.value}")

        api_image_id, worker_image_id, task_digest = self._prove_backend(
            bundle=bundle,
            candidate=candidate,
            attempt=attempt,
        )
        self._prove_public(
            attempt,
            candidate,
            expected_task_contract_digest=task_digest,
        )
        existing_record = self.store.load_record(source_sha)
        record = ReleaseRecord.from_attempt(
            attempt=attempt,
            candidate=candidate,
            api_image_id=api_image_id,
            worker_image_id=worker_image_id,
            verified_at=(_now() if existing_record is None else existing_record.verified_at),
        )
        self.store.create_record(record)
        self.store.set_current(source_sha)
        succeeded = self.store.complete_published_attempt(source_sha, now=_now())
        self.store.clear_forward_fix_after_success(source_sha)
        return succeeded

    def verify_current(self, source_sha: str) -> None:
        self.store.assert_no_oracle_attempt()
        self.store.require_current_record()
        if self.store.current_sha() != source_sha:
            raise ReleaseBlocked(f"release {source_sha} is not current")
        attempt = self.store.load_attempt(source_sha)
        record = self.store.load_record(source_sha)
        if attempt is None or attempt.phase is not ReleasePhase.Succeeded or record is None:
            raise ReleaseDefect("current release is not a complete immutable publication")
        candidate = load_candidate_manifest(self.bundle(source_sha) / "candidate-manifest.json")
        if record.manifest_sha256 != _sha256(self.bundle(source_sha) / "candidate-manifest.json"):
            raise ReleaseDefect("current release manifest hash differs")
        api_image_id, worker_image_id, task_digest = self._prove_backend(
            bundle=self.bundle(source_sha),
            candidate=candidate,
            attempt=attempt,
        )
        self._prove_public(
            attempt,
            candidate,
            expected_task_contract_digest=task_digest,
        )
        self._validate_release_inputs(
            bundle=self.bundle(source_sha),
            candidate=candidate,
            attempt=attempt,
            check_caddy=False,
        )
        expected_record = ReleaseRecord.from_attempt(
            attempt=attempt,
            candidate=candidate,
            api_image_id=api_image_id,
            worker_image_id=worker_image_id,
            verified_at=record.verified_at,
        )
        if record != expected_record:
            raise ReleaseDefect("current release record differs from the proven vector")
        self.store.clear_forward_fix_after_success(source_sha)


@dataclass(frozen=True, slots=True)
class OracleReleaseTarget:
    record: ReleaseRecord
    release_attempt: ReleaseAttempt
    bundle: Path
    candidate: CandidateManifest
    owner_user_id: str


@dataclass(frozen=True, slots=True)
class OracleExecutionSource:
    bundle: Path
    candidate: CandidateManifest
    repair: OracleRepairBinding | None


class OracleReconcileResult(StrEnum):
    NoOp = "NoOp"
    Succeeded = "Succeeded"


class HostOracleReconcile:
    """Durable host owner for one current Oracle publication target."""

    def __init__(self, paths: ReleasePaths) -> None:
        self.paths = paths
        self.store = ReleaseStore(paths)
        self.host = HostRelease(paths)

    def reconcile(
        self,
        source_sha: str,
        *,
        execution_source_sha: str | None = None,
    ) -> OracleReconcileResult:
        _require_match("Oracle target source SHA", source_sha, _SHA)
        self.store.require_current_record()
        if execution_source_sha is not None:
            _require_match("Oracle execution source SHA", execution_source_sha, _SHA)

        # Attempt state is recovery input and must be observed before live status.
        active = self.store.active_oracle_attempt()
        if active is not None and active.source_sha != source_sha:
            raise ReleaseBlocked(
                f"Oracle attempt {active.target_name} is still {active.phase.value}; "
                f"target {source_sha} is blocked"
            )

        target = self._bind_current_target(source_sha)
        execution = self._bind_execution_source(
            target,
            execution_source_sha=execution_source_sha,
        )
        attempt = self.store.require_oracle_target(
            source_sha,
            target.record.expected_oracle_manifest_digest,
        )
        if attempt is not None:
            self._validate_attempt(attempt, target)
            self._resume(attempt, target, execution)
            return OracleReconcileResult.Succeeded

        status = self._status(target, execution)
        if status.manifest_digest != target.record.expected_oracle_manifest_digest:
            raise ReleaseDefect("Oracle status differs from the immutable release target")
        if status.is_exact_publication(target.record.expected_oracle_manifest_digest):
            self._prove_current_runtime(target)
            return OracleReconcileResult.NoOp

        self._preflight(target, execution)
        terminal = self.store.load_oracle_attempt(
            source_sha,
            target.record.expected_oracle_manifest_digest,
        )
        if terminal is not None:
            raise ReleaseDefect(
                "a succeeded Oracle target drifted; publication requires a new release SHA"
            )
        containers = self._capture_current_containers(target)
        attempt = OracleAttempt.prepared(
            source_sha=source_sha,
            expected_manifest_digest=target.record.expected_oracle_manifest_digest,
            config_path=target.record.config_path,
            config_sha256=target.record.config_sha256,
            prior_marker=status.prior_marker,
            containers=containers,
            now=_now(),
        )
        self.store.create_oracle_attempt(attempt)
        self._resume(attempt, target, execution)
        return OracleReconcileResult.Succeeded

    def _bind_current_target(self, source_sha: str) -> OracleReleaseTarget:
        self.store.require_current_record()
        active_release = self.store.active_attempt()
        if active_release is not None:
            raise ReleaseBlocked(
                f"application release {active_release.source_sha} is still "
                f"{active_release.phase.value}"
            )
        if self.store.forward_fix_sha() is not None:
            raise ReleaseBlocked("Oracle reconcile is blocked by forward-fix state")
        if self.store.current_sha() != source_sha:
            raise ReleaseBlocked(f"Oracle target {source_sha} is not current")
        record = self.store.load_record(source_sha)
        release_attempt = self.store.load_attempt(source_sha)
        if (
            record is None
            or release_attempt is None
            or release_attempt.phase is not ReleasePhase.Succeeded
        ):
            raise ReleaseDefect("Oracle reconcile requires one complete immutable current release")
        record_path = self.paths.records / f"{source_sha}.json"
        if _read_canonical_json(record_path, "release record") != record.as_json():
            raise ReleaseDefect("current release record canonical value changed")

        bundle = self.host.bundle(source_sha)
        manifest_path = bundle / "candidate-manifest.json"
        candidate = load_candidate_manifest(manifest_path)
        self.host._validate_release_inputs(
            bundle=bundle,
            candidate=candidate,
            attempt=release_attempt,
        )
        if (
            record.manifest_sha256 != _sha256(manifest_path)
            or record.api_image != candidate.images.api
            or record.worker_image != candidate.images.worker
            or record.database_revision != candidate.expected_database_revision
            or record.expected_oracle_manifest_digest != candidate.expected_oracle_manifest_digest
            or release_attempt.manifest_sha256 != record.manifest_sha256
            or release_attempt.config_path != record.config_path
            or release_attempt.config_sha256 != record.config_sha256
            or release_attempt.vercel_deployment_id != record.vercel_deployment_id
            or release_attempt.production_host != record.production_host
        ):
            raise ReleaseDefect("current release artifacts disagree with its record")

        config_path = Path(record.config_path)
        try:
            config_root = self.paths.config_root.resolve(strict=True)
            resolved_config = config_path.resolve(strict=True)
        except OSError as exc:
            raise ReleaseDefect("recorded Oracle config cannot be resolved") from exc
        if (
            config_path.is_symlink()
            or resolved_config.parent != config_root
            or resolved_config.name != f"{record.config_sha256}.env"
            or _sha256(resolved_config) != record.config_sha256
            or resolved_config.stat().st_uid != 0
        ):
            raise ReleaseDefect("recorded Oracle config is not immutable release input")
        config = _read_env(resolved_config)
        owner_user_id = _unquote_env(config.get("NEXUS_ORACLE_CORPUS_OWNER_USER_ID", ""))
        if _UUID.fullmatch(owner_user_id) is None:
            raise ReleaseDefect("Oracle corpus owner user id is malformed")
        return OracleReleaseTarget(
            record=record,
            release_attempt=release_attempt,
            bundle=bundle,
            candidate=candidate,
            owner_user_id=owner_user_id,
        )

    def _bind_execution_source(
        self,
        target: OracleReleaseTarget,
        *,
        execution_source_sha: str | None,
    ) -> OracleExecutionSource:
        self.store.oracle_repairs()
        binding = self.store.load_oracle_repair(
            target.record.source_sha,
            target.record.expected_oracle_manifest_digest,
        )
        if execution_source_sha is None:
            if binding is not None:
                raise ReleaseBlocked(
                    "Oracle target has an immutable repair binding; "
                    f"replay requires execution source {binding.repair_source_sha}"
                )
            return OracleExecutionSource(
                bundle=target.bundle,
                candidate=target.candidate,
                repair=None,
            )

        attempt = self.store.load_oracle_attempt(
            target.record.source_sha,
            target.record.expected_oracle_manifest_digest,
        )
        if attempt is None:
            raise ReleaseBlocked("Oracle repair execution requires existing attempt state")
        if binding is None:
            raise ReleaseBlocked("Oracle repair execution requires a durable repair binding")
        if binding.repair_source_sha != execution_source_sha:
            raise ReleaseBlocked(f"Oracle repair is immutably bound to {binding.repair_source_sha}")

        bundle = self.host.bundle(execution_source_sha)
        candidate = load_candidate_manifest(bundle / "candidate-manifest.json")
        if (
            binding.target_source_sha != target.record.source_sha
            or binding.target_manifest_digest != target.record.expected_oracle_manifest_digest
            or binding.expected_database_revision != target.record.database_revision
            or binding.repair_manifest_sha256 != _sha256(bundle / "candidate-manifest.json")
            or binding.repair_api_image != candidate.images.api
            or binding.repair_worker_image != candidate.images.worker
            or candidate.source_sha != binding.repair_source_sha
            or candidate.expected_database_revision != target.record.database_revision
            or candidate.expected_oracle_manifest_digest
            != target.record.expected_oracle_manifest_digest
        ):
            raise ReleaseDefect("Oracle repair execution differs from its durable binding")
        api_image_id = self.host._image_identity(candidate.images.api, candidate)
        worker_image_id = self.host._image_identity(candidate.images.worker, candidate)
        if (
            api_image_id != binding.repair_api_image_id
            or worker_image_id != binding.repair_worker_image_id
        ):
            raise ReleaseDefect("Oracle repair image identity differs from its durable binding")
        return OracleExecutionSource(bundle=bundle, candidate=candidate, repair=binding)

    def _validate_attempt(
        self,
        attempt: OracleAttempt,
        target: OracleReleaseTarget,
    ) -> None:
        if (
            attempt.source_sha != target.record.source_sha
            or attempt.expected_manifest_digest != target.record.expected_oracle_manifest_digest
            or attempt.config_path != target.record.config_path
            or attempt.config_sha256 != target.record.config_sha256
            or _sha256(Path(attempt.config_path)) != attempt.config_sha256
        ):
            raise ReleaseDefect("Oracle attempt inputs differ from the current record")
        expected_images = {
            "api": target.record.api_image_id,
            "worker-interactive": target.record.worker_image_id,
            "worker-background": target.record.worker_image_id,
        }
        for service, evidence in attempt.containers.items():
            if evidence.image != expected_images[service]:
                raise ReleaseDefect(
                    f"Oracle attempt {service} image differs from the current record"
                )

    def _oracle_cli(
        self,
        target: OracleReleaseTarget,
        execution: OracleExecutionSource,
        command: str,
    ) -> bytes:
        if command not in {
            "status",
            "preflight",
            "unpublish",
            "reconcile-support",
            "publish",
        }:
            raise ReleaseDefect(f"unsupported Oracle internal command {command!r}")
        command_arguments = [
            "worker-background",
            "python",
            "-m",
            "nexus.ops.oracle_reconcile",
            command,
            "--manifest-directory",
            "/app/scripts/oracle",
            "--expected-manifest-digest",
            target.record.expected_oracle_manifest_digest,
        ]
        if command in {"status", "reconcile-support", "publish"}:
            command_arguments.extend(("--owner-user", target.owner_user_id))
        timeout_seconds = 2700 if command == "reconcile-support" else 300
        if command in {"unpublish", "reconcile-support", "publish"}:
            execution_suffix = (
                "" if execution.repair is None else f"-repair-{execution.candidate.source_sha}"
            )
            return self.host._compose_job(
                name=(f"nexus-oracle-{target.record.source_sha}{execution_suffix}-{command}"),
                bundle=target.bundle,
                candidate=execution.candidate,
                config_path=Path(target.record.config_path),
                arguments=tuple(command_arguments),
                timeout_seconds=timeout_seconds,
            )
        return self.host._compose(
            bundle=target.bundle,
            candidate=execution.candidate,
            config_path=Path(target.record.config_path),
            arguments=("run", "--rm", "--no-deps", "--no-TTY", *command_arguments),
            timeout_seconds=timeout_seconds,
        ).stdout

    def _status(
        self,
        target: OracleReleaseTarget,
        execution: OracleExecutionSource,
    ) -> OracleRuntimeStatus:
        return parse_oracle_status(self._oracle_cli(target, execution, "status"))

    def _preflight(
        self,
        target: OracleReleaseTarget,
        execution: OracleExecutionSource,
    ) -> None:
        _accept_oracle_preflight(
            self._oracle_cli(target, execution, "preflight"),
            target.record.expected_oracle_manifest_digest,
        )

    def _capture_current_containers(
        self,
        target: OracleReleaseTarget,
    ) -> dict[str, ContainerEvidence]:
        self._prove_current_runtime(target)
        all_containers = self.host._container_evidence(
            bundle=target.bundle,
            candidate=target.candidate,
            config_path=Path(target.record.config_path),
            writers_running=True,
        )
        containers = {service: all_containers[service] for service in _WRITERS}
        expected_images = {
            "api": target.record.api_image_id,
            "worker-interactive": target.record.worker_image_id,
            "worker-background": target.record.worker_image_id,
        }
        if any(
            evidence.image != expected_images[service] for service, evidence in containers.items()
        ):
            raise PermanentReleaseFailure(
                "current app containers differ from the immutable release record"
            )
        return containers

    def _inspect_exact_container(
        self,
        service: str,
        evidence: ContainerEvidence,
    ) -> dict[str, Any]:
        raw = _read_json_output(
            _run(("docker", "inspect", evidence.container_id)).stdout,
            f"Oracle {service} container inspect",
        )
        if not isinstance(raw, list) or len(raw) != 1 or not isinstance(raw[0], dict):
            raise ReleaseDefect(f"Oracle {service} container inspect is malformed")
        item = raw[0]
        config = _mapping(item.get("Config"), f"Oracle {service} config")
        if (
            item.get("Image") != evidence.image
            or hashlib.sha256(_canonical_json(config)).hexdigest() != evidence.config_sha256
        ):
            raise ReleaseDefect(f"Oracle {service} container identity changed")
        return _mapping(item.get("State"), f"Oracle {service} state")

    def _prove_exact_running_state(
        self,
        attempt: OracleAttempt,
        *,
        running: bool,
    ) -> None:
        for service, evidence in attempt.containers.items():
            state = self._inspect_exact_container(service, evidence)
            if state.get("Running") is not running:
                expected = "running" if running else "stopped"
                raise ExternalCommandFailed(f"exact Oracle {service} container is not {expected}")

    def _stop_exact_writers(self, attempt: OracleAttempt) -> None:
        running = [
            evidence.container_id
            for service, evidence in attempt.containers.items()
            if self._inspect_exact_container(service, evidence).get("Running") is True
        ]
        if running:
            _run(("docker", "stop", "--time", "30", *running), timeout_seconds=60)
        self._prove_exact_running_state(attempt, running=False)

    def _prove_compose_container_ids(
        self,
        attempt: OracleAttempt,
        target: OracleReleaseTarget,
    ) -> None:
        for service, evidence in attempt.containers.items():
            current_id = (
                self.host._compose(
                    bundle=target.bundle,
                    candidate=target.candidate,
                    config_path=Path(target.record.config_path),
                    arguments=("ps", "--quiet", service),
                )
                .stdout.decode()
                .strip()
            )
            if current_id != evidence.container_id:
                raise ReleaseDefect(f"Compose {service} no longer names the exact Oracle container")

    def _restore_exact_runtime(
        self,
        attempt: OracleAttempt,
        target: OracleReleaseTarget,
    ) -> None:
        stopped = [
            evidence.container_id
            for service, evidence in attempt.containers.items()
            if self._inspect_exact_container(service, evidence).get("Running") is False
        ]
        if stopped:
            _run(("docker", "start", *stopped), timeout_seconds=60)

        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            healthy = True
            for service, evidence in attempt.containers.items():
                state = self._inspect_exact_container(service, evidence)
                health = state.get("Health")
                healthy = (
                    healthy
                    and state.get("Running") is True
                    and isinstance(health, dict)
                    and health.get("Status") == "healthy"
                )
            if healthy:
                break
            # justify-polling: Docker health is the bounded runtime readiness source.
            time.sleep(1)
        else:
            raise ExternalCommandFailed("exact Oracle app containers did not become healthy")
        self._prove_exact_running_state(attempt, running=True)
        self._prove_compose_container_ids(attempt, target)
        self._prove_current_runtime(target)

    def _prove_current_runtime(self, target: OracleReleaseTarget) -> None:
        api_image_id, worker_image_id, task_digest = self.host._prove_backend(
            bundle=target.bundle,
            candidate=target.candidate,
            attempt=target.release_attempt,
        )
        if (
            api_image_id != target.record.api_image_id
            or worker_image_id != target.record.worker_image_id
        ):
            raise PermanentReleaseFailure(
                "current runtime images differ from the immutable release record"
            )
        self.host._prove_public(
            target.release_attempt,
            target.candidate,
            expected_task_contract_digest=task_digest,
        )

    def _require_exact_publication(
        self,
        target: OracleReleaseTarget,
        execution: OracleExecutionSource,
    ) -> None:
        status = self._status(target, execution)
        if not status.is_exact_publication(target.record.expected_oracle_manifest_digest):
            raise PermanentReleaseFailure("Oracle publication is not exact after publish")

    def _resume(
        self,
        attempt: OracleAttempt,
        target: OracleReleaseTarget,
        execution: OracleExecutionSource,
    ) -> OracleAttempt:
        if attempt.phase is OraclePhase.Prepared:
            self._stop_exact_writers(attempt)
            attempt = attempt.advance(OraclePhase.WritersStopped, now=_now())
            self.store.replace_oracle_attempt(attempt)

        if attempt.phase is OraclePhase.WritersStopped:
            self._stop_exact_writers(attempt)
            _accept_oracle_unpublish(
                self._oracle_cli(target, execution, "unpublish"),
                attempt.expected_manifest_digest,
            )
            attempt = attempt.advance(OraclePhase.Unpublished, now=_now())
            self.store.replace_oracle_attempt(attempt)

        if attempt.phase is OraclePhase.Unpublished:
            self._stop_exact_writers(attempt)
            _accept_oracle_support(
                self._oracle_cli(target, execution, "reconcile-support"),
                attempt.expected_manifest_digest,
            )
            attempt = attempt.advance(OraclePhase.SupportReconciled, now=_now())
            self.store.replace_oracle_attempt(attempt)

        if attempt.phase is OraclePhase.SupportReconciled:
            self._stop_exact_writers(attempt)
            _accept_oracle_publish(
                self._oracle_cli(target, execution, "publish"),
                attempt.expected_manifest_digest,
            )
            attempt = attempt.advance(OraclePhase.Published, now=_now())
            self.store.replace_oracle_attempt(attempt)

        if attempt.phase is OraclePhase.Published:
            self._stop_exact_writers(attempt)
            self._require_exact_publication(target, execution)
            try:
                self._restore_exact_runtime(attempt, target)
            except (
                ExternalCommandFailed,
                PermanentReleaseFailure,
                ReleaseBlocked,
                ReleaseDefect,
            ):
                self._stop_exact_writers(attempt)
                raise
            attempt = attempt.advance(OraclePhase.RuntimeRestored, now=_now())
            self.store.replace_oracle_attempt(attempt)

        if attempt.phase is OraclePhase.RuntimeRestored:
            try:
                self._require_exact_publication(target, execution)
                self._restore_exact_runtime(attempt, target)
                self._require_exact_publication(target, execution)
            except (
                ExternalCommandFailed,
                PermanentReleaseFailure,
                ReleaseBlocked,
                ReleaseDefect,
            ):
                self._stop_exact_writers(attempt)
                raise
            attempt = attempt.advance(OraclePhase.Succeeded, now=_now())
            self.store.replace_oracle_attempt(attempt)

        if attempt.phase is not OraclePhase.Succeeded:
            raise ReleaseDefect(f"Oracle reconcile cannot continue phase {attempt.phase.value}")
        return attempt


def install_oracle_repair_bundle(
    source: Path,
    paths: ReleasePaths,
    *,
    target_source_sha: str,
) -> OracleRepairBinding:
    _require_match("Oracle repair target source SHA", target_source_sha, _SHA)
    if _bundle_files(source) != _BUNDLE_FILES:
        raise ReleaseDefect("Oracle repair bundle has unsupported or missing files")
    candidate = load_candidate_manifest(source / "candidate-manifest.json")
    if candidate.source_sha == target_source_sha:
        raise ReleaseDefect("Oracle repair source must differ from its target")

    owner = HostOracleReconcile(paths)
    owner.store.oracle_repairs()
    target = owner._bind_current_target(target_source_sha)
    attempt = owner.store.load_oracle_attempt(
        target_source_sha,
        target.record.expected_oracle_manifest_digest,
    )
    if attempt is None:
        raise ReleaseBlocked("Oracle repair installation requires existing attempt state")
    owner._validate_attempt(attempt, target)
    active = owner.store.active_oracle_attempt()
    existing = owner.store.load_oracle_repair(
        target_source_sha,
        target.record.expected_oracle_manifest_digest,
    )
    if existing is None:
        if active != attempt or attempt.terminal:
            raise ReleaseBlocked("new Oracle repair installation requires the active attempt")
        if (
            owner.store.load_attempt(candidate.source_sha) is not None
            or owner.store.load_record(candidate.source_sha) is not None
            or owner.store.current_sha() == candidate.source_sha
            or owner.store.forward_fix_sha() == candidate.source_sha
        ):
            raise ReleaseBlocked("Oracle repair source must have no application release history")
    elif existing.repair_source_sha != candidate.source_sha:
        raise ReleaseBlocked(f"Oracle repair is immutably bound to {existing.repair_source_sha}")

    if (
        candidate.expected_database_revision != target.record.database_revision
        or candidate.expected_oracle_manifest_digest
        != target.record.expected_oracle_manifest_digest
    ):
        raise ReleaseBlocked(
            "Oracle repair source must preserve the target schema and manifest identity"
        )

    destination = paths.bundle_root / candidate.source_sha
    if existing is not None and not destination.exists():
        raise ReleaseDefect("durably bound Oracle repair bundle is missing")
    _install_immutable_bundle(source, paths, candidate)
    bundle = owner.host.bundle(candidate.source_sha)
    installed_candidate = load_candidate_manifest(bundle / "candidate-manifest.json")
    api_image_id = owner.host._image_identity(
        installed_candidate.images.api,
        installed_candidate,
    )
    worker_image_id = owner.host._image_identity(
        installed_candidate.images.worker,
        installed_candidate,
    )
    proposed = OracleRepairBinding(
        schema_version=1,
        target_source_sha=target_source_sha,
        target_manifest_digest=target.record.expected_oracle_manifest_digest,
        expected_database_revision=target.record.database_revision,
        repair_source_sha=installed_candidate.source_sha,
        repair_manifest_sha256=_sha256(bundle / "candidate-manifest.json"),
        repair_api_image=installed_candidate.images.api,
        repair_worker_image=installed_candidate.images.worker,
        repair_api_image_id=api_image_id,
        repair_worker_image_id=worker_image_id,
        created_at=_now() if existing is None else existing.created_at,
    )
    if existing is not None:
        if proposed != existing:
            raise ReleaseDefect("installed Oracle repair differs from its durable binding")
        return existing
    owner.store.create_oracle_repair(proposed)
    return proposed


def _read_json_output(data: bytes, label: str) -> object:
    try:
        return json.loads(data, object_pairs_hook=_unique_object)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ReleaseDefect(f"{label} was not strict JSON") from exc


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    inspect = commands.add_parser("inspect")
    inspect.add_argument("--source-sha", required=True)

    validate = commands.add_parser("validate-candidate")
    validate.add_argument("--manifest", type=Path, required=True)

    install = commands.add_parser("install-bundle")
    install.add_argument("--source", type=Path, required=True)

    install_oracle_repair = commands.add_parser("install-oracle-repair-bundle")
    install_oracle_repair.add_argument("--source", type=Path, required=True)
    install_oracle_repair.add_argument("--target-source-sha", required=True)

    apply = commands.add_parser("apply")
    apply.add_argument("--source-sha", required=True)
    apply.add_argument("--deployment-id", required=True)
    apply.add_argument("--production-host", required=True)

    finalize = commands.add_parser("finalize")
    finalize.add_argument("--source-sha", required=True)
    finalize.add_argument("--deployment-id", required=True)

    fail_frontend = commands.add_parser("fail-bound-frontend")
    fail_frontend.add_argument("--source-sha", required=True)
    fail_frontend.add_argument("--deployment-id", required=True)

    fail_auth_smoke = commands.add_parser("fail-auth-smoke")
    fail_auth_smoke.add_argument("--source-sha", required=True)
    fail_auth_smoke.add_argument("--deployment-id", required=True)

    verify = commands.add_parser("verify-current")
    verify.add_argument("--source-sha", required=True)

    config = commands.add_parser("publish-config")
    config.add_argument("--source", type=Path, required=True)
    config.add_argument("--next-source-sha", required=True)

    oracle = commands.add_parser("reconcile-oracle")
    oracle.add_argument("--source-sha", required=True)
    oracle.add_argument("--execution-source-sha")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    paths = ReleasePaths()
    if args.command == "validate-candidate":
        candidate = load_candidate_manifest(args.manifest)
        sys.stdout.buffer.write(_canonical_json({"source_sha": candidate.source_sha}))
        return 0
    if args.command == "install-bundle":
        with release_lock(paths.lock_path):
            source_sha = install_bundle(args.source, paths)
        sys.stdout.buffer.write(_canonical_json({"source_sha": source_sha}))
        return 0
    if args.command == "install-oracle-repair-bundle":
        with release_lock(paths.lock_path):
            binding = install_oracle_repair_bundle(
                args.source,
                paths,
                target_source_sha=args.target_source_sha,
            )
        sys.stdout.buffer.write(
            _canonical_json(
                {
                    "repair_source_sha": binding.repair_source_sha,
                    "target_manifest_digest": binding.target_manifest_digest,
                    "target_source_sha": binding.target_source_sha,
                }
            )
        )
        return 0
    if args.command == "inspect":
        store = ReleaseStore(paths)
        current_record = store.require_current_record()
        store.assert_candidate_admissible(args.source_sha)
        attempt = store.load_attempt(args.source_sha)
        current = current_record.source_sha
        forward_fix = store.forward_fix_sha()
        forward_fix_attempt = None if forward_fix is None else store.load_attempt(forward_fix)
        if forward_fix is not None and forward_fix_attempt is None:
            raise ReleaseDefect("forward-fix pointer has no attempt")
        failed_vercel_deployment_ids = (
            []
            if forward_fix is None
            else sorted(
                {
                    item.vercel_deployment_id
                    for item in store.attempts()
                    if item.phase
                    in {
                        ReleasePhase.ForwardFixPending,
                        ReleasePhase.ForwardFixRequired,
                    }
                    and (item.source_sha == forward_fix or item.forward_fix_of == forward_fix)
                }
            )
        )
        if (
            current == args.source_sha
            and attempt is not None
            and attempt.phase is ReleasePhase.Succeeded
        ):
            status = "current"
        elif attempt is None:
            status = "new"
        else:
            status = "resume"
        sys.stdout.buffer.write(
            _canonical_json(
                {
                    "status": status,
                    "current_sha": current,
                    "current_vercel_deployment_id": current_record.vercel_deployment_id,
                    "forward_fix_sha": forward_fix,
                    "failed_vercel_deployment_ids": failed_vercel_deployment_ids,
                    "phase": None if attempt is None else attempt.phase.value,
                    "predecessor_sha": (current if attempt is None else attempt.predecessor_sha),
                    "vercel_deployment_id": (
                        None if attempt is None else attempt.vercel_deployment_id
                    ),
                }
            )
        )
        return 0
    controller = HostRelease(paths)
    with release_lock(paths.lock_path):
        if args.command == "apply":
            attempt = controller.apply(
                source_sha=args.source_sha,
                deployment_id=args.deployment_id,
                production_host=args.production_host,
            )
            sys.stdout.buffer.write(
                _canonical_json({"source_sha": attempt.source_sha, "phase": attempt.phase.value})
            )
            return 0
        if args.command == "finalize":
            attempt = controller.finalize(
                source_sha=args.source_sha,
                deployment_id=args.deployment_id,
            )
            sys.stdout.buffer.write(
                _canonical_json({"source_sha": attempt.source_sha, "phase": attempt.phase.value})
            )
            return 0
        if args.command == "fail-bound-frontend":
            attempt = controller.fail_bound_frontend(
                source_sha=args.source_sha,
                deployment_id=args.deployment_id,
            )
            sys.stdout.buffer.write(
                _canonical_json({"source_sha": attempt.source_sha, "phase": attempt.phase.value})
            )
            return 0
        if args.command == "fail-auth-smoke":
            attempt = controller.fail_auth_smoke(
                source_sha=args.source_sha,
                deployment_id=args.deployment_id,
            )
            sys.stdout.buffer.write(
                _canonical_json({"source_sha": attempt.source_sha, "phase": attempt.phase.value})
            )
            return 0
        if args.command == "verify-current":
            controller.verify_current(args.source_sha)
            sys.stdout.buffer.write(
                _canonical_json({"source_sha": args.source_sha, "status": "current"})
            )
            return 0
        if args.command == "publish-config":
            digest = publish_config(
                args.source,
                controller.store,
                next_source_sha=args.next_source_sha,
            )
            sys.stdout.buffer.write(_canonical_json({"config_sha256": digest}))
            return 0
        if args.command == "reconcile-oracle":
            result = HostOracleReconcile(paths).reconcile(
                args.source_sha,
                execution_source_sha=args.execution_source_sha,
            )
            record = controller.store.load_record(args.source_sha)
            if record is None:
                raise ReleaseDefect("successful Oracle reconcile lost its release record")
            sys.stdout.buffer.write(
                _canonical_json(
                    {
                        "source_sha": args.source_sha,
                        "expected_manifest_digest": (record.expected_oracle_manifest_digest),
                        "result": result.value,
                    }
                )
            )
            return 0
    raise AssertionError(f"unsupported command {args.command!r}")


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (
        BackendArtifactDefect,
        ExternalCommandFailed,
        PermanentReleaseFailure,
        ReleaseBlocked,
        ReleaseDefect,
    ) as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)
