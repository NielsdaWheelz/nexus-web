#!/usr/bin/env python3
"""Durable, fail-closed owner of one immutable Nexus production release."""

from __future__ import annotations

import argparse
import calendar
import contextlib
import dataclasses
import fcntl
import hashlib
import ipaddress
import json
import math
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Iterator
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from enum import StrEnum
from pathlib import Path
from typing import Any

from nexus.release_artifact import (
    ANDROID_RELEASE_TAG,
    AndroidPlayerProtocolIdentity,
    BackendArtifactDefect,
    CandidateManifest,
    RuntimeIdentity,
    is_exact_https_origin,
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
_RELEASE_TIMESTAMP = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z")
_DOCKER_TIMESTAMP = re.compile(
    r"(?P<seconds>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})"
    r"(?:\.(?P<fraction>\d{1,9}))?"
    r"(?:Z|(?P<offset_sign>[+-])(?P<offset_hours>[01]\d|2[0-3]):"
    r"(?P<offset_minutes>[0-5]\d))\Z"
)
_SERVICES = (
    "postgres",
    "caddy",
    "api",
    "worker-interactive",
    "worker-background",
)
_WRITERS = ("api", "worker-interactive", "worker-background")
_CODEX_AGENT_HOST = "nexus-codex-agent-host"
_CODEX_EGRESS_POLICY = "codex-egress-policy"
_CODEX_PRIVATE_NETWORK = "nexus_codex_private"
_CODEX_PROXY_EGRESS_NETWORK = "nexus_codex_proxy_egress"
_CODEX_EGRESS_PROXY_IP = "172.30.0.2"
_CODEX_AGENT_HOST_IP = "172.30.0.3"
_CODEX_PRIVATE_BRIDGE_IP = "172.30.0.1"
_CODEX_PRIVATE_NETWORK_OPTIONS = {"com.docker.network.bridge.gateway_mode_ipv4": "isolated"}
_CODEX_ISOLATED_GATEWAY_MINIMUM_DOCKER_MAJOR = 28
# Docker CLI consumes `systempaths=unconfined` client-side and translates it
# into empty `MaskedPaths`/`ReadonlyPaths`; the directive is therefore absent
# from the Engine inspect response. Keep the effective-path checks below as the
# runtime attestation and require the remaining round-tripped options exactly.
_CODEX_AGENT_INSPECT_SECURITY_OPTIONS = {
    "apparmor=nexus-codex-agent-host",
    "no-new-privileges:true",
    "seccomp=unconfined",
}
# The host's published graceful-stop budget (apps/codex_agent/host.py): request drain,
# interrupted-turn runtime close, and exit margin. Every stop of the host grants it.
_CODEX_AGENT_STOP_GRACE_SECONDS = 45
_CODEX_AGENT_MEMORY_LIMIT_BYTES = 448 * 1024 * 1024
_CODEX_AGENT_MEMORY_PEAK_LIMIT_BYTES = 384 * 1024 * 1024
_CODEX_AGENT_EPHEMERAL_FILE_LIMIT_BYTES = 77_594_624
_CODEX_AGENT_EPHEMERAL_ROOT_BYTES = 188_743_680
# The private executable tmpfs exists only because the pinned SDK launches a
# content-addressed supervisor beside its profile state. General /tmp remains
# noexec; a live container that differs is not the proven host.
_CODEX_AGENT_TMPFS = {
    "/run/nexus-codex-turns": ("rw,exec,nosuid,nodev,size=180m,mode=0700,uid=10001,gid=10001"),
    "/tmp": "rw,noexec,nosuid,nodev,size=16m",
}
_CODEX_EGRESS_POLICY_TMPFS = {"/tmp": "rw,noexec,nosuid,nodev,size=8m"}
_CODEX_AGENT_ULIMITS = frozenset(
    {
        ("core", 0, 0),
        (
            "fsize",
            _CODEX_AGENT_EPHEMERAL_FILE_LIMIT_BYTES,
            _CODEX_AGENT_EPHEMERAL_FILE_LIMIT_BYTES,
        ),
        ("nofile", 64, 64),
    }
)
_CODEX_AGENT_RUNTIME_ENVIRONMENT = {
    "NEXUS_CODEX_CREDENTIAL_FILE": "/run/nexus-codex-credential/auth.json",
    "NEXUS_CODEX_WORKING_DIRECTORY_ROOT": "/run/nexus-codex-turns",
    "NEXUS_CODEX_AGENT_SOCKET": "/run/nexus-codex/agent.sock",
    "NEXUS_CODEX_MODEL_TOOL_NETWORK_ATTESTED": "true",
}
# These are the only environment names inherited from the pinned Python/worker
# artifact. Their values come from `docker image inspect` and must be preserved
# exactly by the host container; Compose may add only the fixed runtime values
# above plus the separately attested dynamic MCP origin.
_CODEX_AGENT_IMAGE_ENVIRONMENT_NAMES = frozenset(
    {
        "GPG_KEY",
        "LANG",
        "NODE_ENV",
        "PATH",
        "PYTHONPATH",
        "PYTHON_SHA256",
        "PYTHON_VERSION",
    }
)
_CODEX_AGENT_VOLUME_MOUNTS = {
    "/run/nexus-codex": "nexus_nexus_codex_run",
}
_CODEX_STATE_CONTAINER_SIZE_BYTES = 1024 * 1024 * 1024
_CODEX_STATE_MINIMUM_FREE_BYTES = 128 * 1024 * 1024
_CODEX_STATE_MAPPER_NAME = "nexus-codex-state"
_CODEX_STATE_MAPPER = Path(f"/dev/mapper/{_CODEX_STATE_MAPPER_NAME}")
_CODEX_STATE_REQUIRED_MOUNT_OPTIONS = frozenset({"rw", "nosuid", "nodev", "noexec"})
_CODEX_ENROLLED_AUTH_RELATIVE_PATH = Path("codex/codex-personal/auth.json")
_CODEX_ENROLLED_AUTH_MAX_BYTES = 64 * 1024
_CODEX_STATE_BOOT_GUARD_NAME = "nexus-codex-state-boot-guard.service"
_CODEX_STATE_BOOT_GUARD = b"""#!/bin/sh
set -eu
state=/srv/nexus/codex-state
if /usr/bin/mountpoint --quiet -- "$state"; then
    exit 0
fi
if [ -L "$state" ] || { [ -e "$state" ] && [ ! -d "$state" ]; }; then
    echo "refusing unsafe Codex state underlay: $state" >&2
    exit 1
fi
/usr/bin/install -d -o root -g root -m 000 -- "$state"
/usr/bin/chown --no-dereference root:root -- "$state"
/usr/bin/chmod 000 -- "$state"
"""
_CODEX_STATE_BOOT_GUARD_UNIT = b"""[Unit]
Description=Protect the unmounted Nexus Codex credential-state underlay
DefaultDependencies=no
After=local-fs.target
Before=docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/nexus-codex-state-boot-guard
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
"""
_CODEX_STATE_DOCKER_DROP_IN = b"""[Unit]
Requires=nexus-codex-state-boot-guard.service
After=nexus-codex-state-boot-guard.service
"""
_CADDY_READINESS_COMMAND = (
    "wget",
    "-q",
    "-O",
    "/dev/null",
    "http://127.0.0.1:2019/config/",
)
_CADDY_ADAPT_COMMAND = (
    "caddy",
    "adapt",
    "--config",
    "/etc/caddy/Caddyfile",
    "--adapter",
    "caddyfile",
)
_CADDY_ADAPT_STDIN_COMMAND = (
    "caddy",
    "adapt",
    "--config",
    "/dev/stdin",
    "--adapter",
    "caddyfile",
)
_CADDY_VALIDATE_COMMAND = (
    "caddy",
    "validate",
    "--config",
    "/etc/caddy/Caddyfile",
    "--adapter",
    "caddyfile",
)
_CADDY_RELOAD_COMMAND = (
    "caddy",
    "reload",
    "--config",
    "/etc/caddy/Caddyfile",
    "--adapter",
    "caddyfile",
)
_CADDY_LOADED_CONFIG_COMMAND = (
    "wget",
    "-q",
    "-O",
    "-",
    "http://127.0.0.1:2019/config/",
)
_CADDY_CONFIG_MAX_BYTES = 1024 * 1024
_CODEX_CAPACITY_CLIENT_ENVIRONMENT = {
    "NEXUS_CODEX_AGENT_SOCKET": "/run/nexus-codex/agent.sock",
    "NEXUS_CODEX_CAPACITY_GENERATION_SPEC_FILE": "/run/nexus-capacity-input.json",
}
_CODEX_CAPACITY_CLIENT_COMMAND = ("-c", "while :; do sleep 3600; done")
_CODEX_CAPACITY_INPUT_CONTAINER_PATH = "/run/nexus-capacity-input.json"
_CODEX_CAPACITY_INPUT_SCHEMA_VERSION = "nexus-codex-capacity-canary-input.v1"
_CODEX_CAPACITY_INPUT_MAX_BYTES = 2 * 1024 * 1024
_CODEX_CAPACITY_INPUT_INSTRUCTIONS = (
    "Write one short morning brief sentence for a capacity qualification."
)
_CODEX_CAPACITY_INPUT_TEXT = "No personal context is supplied. Return bounded non-empty text."
_CODEX_CAPACITY_PROMPT_TEMPLATE_REVISION = "codex-capacity-canary.dawn-write.v1"
_CODEX_PERSONAL_GENERATION_REVISION = 224
_CAPACITY_SERVICES = (*_SERVICES, "codex-egress-policy", _CODEX_AGENT_HOST)
_RESOURCE_LIMITS = {
    "postgres": (256 * 1024 * 1024, 512 * 1024 * 1024, 256),
    "caddy": (32 * 1024 * 1024, 48 * 1024 * 1024, 128),
    "api": (192 * 1024 * 1024, 320 * 1024 * 1024, 256),
    "worker-interactive": (128 * 1024 * 1024, 320 * 1024 * 1024, 256),
    "worker-background": (128 * 1024 * 1024, 448 * 1024 * 1024, 256),
    "codex-egress-policy": (32 * 1024 * 1024, 64 * 1024 * 1024, 32),
    _CODEX_AGENT_HOST: (256 * 1024 * 1024, 448 * 1024 * 1024, 64),
    "migration": (256 * 1024 * 1024, 512 * 1024 * 1024, 256),
}
_CODEX_SANDBOX_PROBE = ("python", "-m", "apps.codex_agent.sandbox_health")
_MIGRATION_COMMAND = (
    "sh",
    "-c",
    "cd /app/migrations && /app/.venv/bin/alembic upgrade head",
)
# The existing VPS is viable only when its measured base capacity and the
# reservation envelope fit. Hard limits remain containment, not allocation.
_MIN_HOST_MEMORY_BYTES = 1900 * 1024 * 1024
_HOST_RESERVED_MEMORY_BYTES = 320 * 1024 * 1024
_WORKER_HEALTH_RECEIPT_MAX_AGE_SECONDS = 20.0
_MIN_AVAILABLE_MEMORY_BYTES = 128 * 1024 * 1024
_MIN_SWAP_BYTES = 1024 * 1024 * 1024
_MIN_PARSER_TEMP_FREE_BYTES = 512 * 1024 * 1024
_CODEX_CAPACITY_SCHEMA_VERSION = "nexus-codex-capacity.v3"
_CODEX_CAPACITY_CANARY_SCHEMA_VERSION = "nexus-codex-capacity-canary.v4"
# The canary owns its phase sequence and exit-code table as the public
# `apps.codex_agent.capacity_canary.TURNS` and `.EXIT_CODES`. This
# controller ships in the immutable host bundle without the worker package, so
# it cannot import that owner and mirrors it here instead; the two are bound by
# a conformance proof, and neither side may be changed alone. Every non-zero
# terminal is numbered away from 1 (an uncaught exception) and from 128+signal
# (a killed process) so no crash can present itself as a stated terminal.
_CODEX_CAPACITY_PHASES = ("cold", "warm_1", "warm_2")
_CODEX_CAPACITY_CANARY_EXIT_CODES = {
    "passed": 0,
    "not_run": 20,
    "subscription_blocked": 21,
    "failed": 22,
    "transport_retriable": 23,
}
_CODEX_CAPACITY_CANARY_LABEL = "nexus.release.codex-capacity-canary"
# One sample is a bounded set of host `/proc` and cgroup reads; the sampler is
# drained for one whole cycle plus that read budget so a slow but legal sample
# is never misreported as a stuck sampler.
_CODEX_CAPACITY_SAMPLE_INTERVAL_SECONDS = 1.0
_CODEX_CAPACITY_SAMPLE_BUDGET_SECONDS = 20.0
_CODEX_CAPACITY_SAMPLER_JOIN_SECONDS = (
    _CODEX_CAPACITY_SAMPLE_INTERVAL_SECONDS + _CODEX_CAPACITY_SAMPLE_BUDGET_SECONDS
)
# Qualification measures a live host, so its evidence expires. Beyond this age
# the measured envelope is no longer a statement about the host that would run
# the promotion, even for an unchanged candidate.
_CODEX_CAPACITY_EVIDENCE_MAX_AGE_SECONDS = 72 * 60 * 60
# The bundled raw corpus is the post-promotion and resume identity authority.
_ANDROID_PLAYER_PROTOCOL_CORPUS = Path("testdata/android/player-protocol.json")
_CODEX_CAPACITY_EVIDENCE_FIELDS = frozenset(
    {
        "schema_version",
        "source_sha",
        "worker_image_id",
        "status",
        "measured_at",
        "turns",
        "cgroup_memory_max",
        "cgroup_memory_current",
        "cgroup_memory_peak",
        "minimum_mem_available",
        "maximum_memory_psi_some",
        "maximum_memory_psi_full",
        "oom_kill_delta",
        "services",
    }
)
_CODEX_CAPACITY_CANARY_FIELDS = frozenset({"schema_version", "status", "turns"})
_CODEX_CAPACITY_INPUT_FIELDS = frozenset({"schema_version", "spec", "intent"})
_CODEX_CAPACITY_TURN_FIELDS = frozenset(
    {
        "phase",
        "operation",
        "generation_spec_fingerprint",
        "model",
        "reasoning",
        "terminal_status",
        "failure_kind",
        "usage_present",
        "sdk_version",
        "runtime_version",
        "tool_event_count",
        "permission_event_count",
    }
)
# Qualification asserts the health of exactly the long-lived services, without
# the ephemeral Codex host it starts itself.
_CODEX_CAPACITY_SERVICES = _SERVICES
_INFRASTRUCTURE_SERVICES = ("postgres", "caddy")
_INFRASTRUCTURE_VOLUME_TARGETS = {
    "postgres": {"/var/lib/postgresql/data": "nexus_postgres_data"},
    "caddy": {"/data": "nexus_caddy_data", "/config": "nexus_caddy_config"},
}
_LEGACY_ATTEMPT_FIELDS = frozenset(
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
_ATTEMPT_FIELDS = _LEGACY_ATTEMPT_FIELDS | {"backup_policy"}
_CONTAINER_FIELDS = frozenset({"container_id", "image", "config_sha256"})
_CADDY_ACTIVATION_FIELDS = frozenset(
    {
        "schema_version",
        "source_sha",
        "candidate_sha256",
        "predecessor_sha256",
        "config_sha256",
        "caddy_device",
        "caddy_inode",
    }
)
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
_ANDROID_RELEASE_MANIFEST_FIELDS = frozenset(
    {
        "version",
        "run_id",
        "git_sha",
        "tag",
        "package",
        "version_code",
        "previous_version_code",
        "version_name",
        "signer_sha256",
        "source_apk_sha256",
        "api_origin",
        "api_origin_source",
        "target_sdk",
        "player_protocol",
        "assets",
    }
)
_TERMINAL_PHASES = frozenset({"RolledBack", "Succeeded", "ForwardFixRequired"})
_BUNDLE_FILES = frozenset(
    {
        "Caddyfile",
        "candidate-manifest.json",
        "docker-compose.yml",
        "nexus-codex-agent-host.apparmor",
        "prove-codex-capacity.sh",
        "release.py",
        "python/nexus/__init__.py",
        "python/nexus/release_artifact.py",
        _ANDROID_PLAYER_PROTOCOL_CORPUS.as_posix(),
    }
)
_DB0215_BUNDLE_FILES = frozenset(
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
    """A valid durable release history or external release fact prevents the mutation."""


class ExternalCommandFailed(RuntimeError):
    """A bounded external release operation failed without proving permanence."""

    def __init__(self, message: str, *, operation: str | None = None) -> None:
        super().__init__(message)
        self.operation = operation or message


class PermanentReleaseFailure(RuntimeError):
    """The candidate cannot safely continue at its current durable boundary."""


class CodexCapacityBreach(PermanentReleaseFailure):
    """A measured Codex capacity breach the candidate can never take back.

    Only candidate breaches — cgroup peak, OOM, host policy, canary protocol,
    and structured output, plus the
    shape of the evidence that states one — are this class. Policy is
    the canary and host isolation contract: those validators are shared with the
    ordinary release paths, where a difference measures nothing, so qualification
    converts what they prove into this class at its own call sites. A breach the
    background sampler observes during the turns is a measurement like any other
    and is re-raised from the joining thread.

    Transient host headroom and pressure are retriable conditions, not permanent
    source defects. Other retriable failures include predecessor-service
    readiness, Docker, transport, sampler and cleanup failures, and a canary
    that never stated one of its own contract terminals — a crashed, OOM-killed
    or cut-off canary observed nothing, whether it left stdout empty,
    unparseable, or carrying an undefined exit code. Only stdout that parses as
    the canary's evidence contract can state a breach. A breach writes immutable
    failed evidence that permanently disqualifies its source SHA.
    """


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


class BackupPolicy(StrEnum):
    Required = "required"
    Waived = "waived"


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
            ReleasePhase.DataMutationStarted,
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
    parser_temp_root: Path = Path("/var/lib/nexus/parser-tmp")
    proc_root: Path = Path("/proc")
    cgroup_root: Path = Path("/sys/fs/cgroup")
    meminfo: Path = Path("/proc/meminfo")
    memory_pressure: Path = Path("/proc/pressure/memory")
    cgroup_controllers: Path = Path("/sys/fs/cgroup/cgroup.controllers")
    codex_apparmor_profile: Path = Path("/etc/apparmor.d/nexus-codex-agent-host")
    codex_state_container: Path = Path("/var/lib/nexus/codex-state.luks")
    codex_state_mount: Path = Path("/srv/nexus/codex-state")
    codex_state_boot_guard: Path = Path("/usr/local/sbin/nexus-codex-state-boot-guard")
    codex_state_boot_guard_unit: Path = Path(
        "/etc/systemd/system/nexus-codex-state-boot-guard.service"
    )
    codex_state_docker_drop_in: Path = Path(
        "/etc/systemd/system/docker.service.d/20-nexus-codex-state-guard.conf"
    )
    crypttab: Path = Path("/etc/crypttab")
    codex_state_forbidden_key: Path = Path("/var/lib/nexus/codex-state.key")
    apparmor_userns_restriction: Path = Path(
        "/proc/sys/kernel/apparmor_restrict_unprivileged_userns"
    )

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
            parser_temp_root=root / "var/lib/nexus/parser-tmp",
            proc_root=root / "proc",
            cgroup_root=root / "sys/fs/cgroup",
            meminfo=root / "proc/meminfo",
            memory_pressure=root / "proc/pressure/memory",
            cgroup_controllers=root / "sys/fs/cgroup/cgroup.controllers",
            codex_apparmor_profile=root / "etc/apparmor.d/nexus-codex-agent-host",
            codex_state_container=root / "var/lib/nexus/codex-state.luks",
            codex_state_mount=root / "srv/nexus/codex-state",
            codex_state_boot_guard=(root / "usr/local/sbin/nexus-codex-state-boot-guard"),
            codex_state_boot_guard_unit=(
                root / "etc/systemd/system/nexus-codex-state-boot-guard.service"
            ),
            codex_state_docker_drop_in=(
                root / "etc/systemd/system/docker.service.d/20-nexus-codex-state-guard.conf"
            ),
            crypttab=root / "etc/crypttab",
            codex_state_forbidden_key=root / "var/lib/nexus/codex-state.key",
            apparmor_userns_restriction=(
                root / "proc/sys/kernel/apparmor_restrict_unprivileged_userns"
            ),
        )

    @property
    def attempts(self) -> Path:
        return self.state_root / "attempts"

    @property
    def codex_enrolled_auth(self) -> Path:
        return self.codex_state_mount / _CODEX_ENROLLED_AUTH_RELATIVE_PATH

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
    def codex_capacity(self) -> Path:
        return self.state_root / "codex-capacity"

    @property
    def current(self) -> Path:
        return self.state_root / "current"

    @property
    def forward_fix(self) -> Path:
        return self.state_root / "forward-fix"

    @property
    def caddy_activation(self) -> Path:
        return self.state_root / "caddy-activation.json"

    @property
    def caddy_activation_backups(self) -> Path:
        return self.state_root / "caddy-activation-backups"


@dataclass(frozen=True, slots=True)
class CaddyActivationJournal:
    schema_version: int
    source_sha: str
    candidate_sha256: str
    predecessor_sha256: str
    config_sha256: str
    caddy_device: int
    caddy_inode: int

    def __post_init__(self) -> None:
        if self.schema_version != 1:
            raise ReleaseDefect("Caddy activation journal schema is unsupported")
        _require_match("Caddy activation source SHA", self.source_sha, _SHA)
        for label, value in (
            ("candidate", self.candidate_sha256),
            ("predecessor", self.predecessor_sha256),
            ("config", self.config_sha256),
        ):
            _require_match(f"Caddy activation {label} SHA-256", value, _SHA256)
        if self.caddy_device < 0 or self.caddy_inode < 1:
            raise ReleaseDefect("Caddy activation inode identity is malformed")

    def as_json(self) -> dict[str, object]:
        return dataclasses.asdict(self)

    @classmethod
    def from_json(cls, value: object) -> CaddyActivationJournal:
        mapping = _closed_mapping(value, _CADDY_ACTIVATION_FIELDS, "Caddy activation journal")
        return cls(
            schema_version=_integer(mapping, "schema_version"),
            source_sha=_string(mapping, "source_sha"),
            candidate_sha256=_string(mapping, "candidate_sha256"),
            predecessor_sha256=_string(mapping, "predecessor_sha256"),
            config_sha256=_string(mapping, "config_sha256"),
            caddy_device=_integer(mapping, "caddy_device"),
            caddy_inode=_integer(mapping, "caddy_inode"),
        )


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
    backup_policy: BackupPolicy
    backup: BackupEvidence | None
    failure_code: str | None
    created_at: str
    updated_at: str

    def __post_init__(self) -> None:
        if type(self.schema_version) is not int or self.schema_version not in (1, 2):
            raise ReleaseDefect("release attempt schema version must be 1 or 2")
        if not isinstance(self.backup_policy, BackupPolicy):
            raise ReleaseDefect("release backup policy is malformed")
        if self.schema_version == 1 and self.backup_policy is not BackupPolicy.Required:
            raise ReleaseDefect("legacy release attempt requires a database backup")
        if self.backup_policy is BackupPolicy.Waived and self.backup is not None:
            raise ReleaseDefect("waived release attempt cannot contain backup evidence")
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
        if (
            self.phase is ReleasePhase.DataMutationStarted
            and self.backup_policy is BackupPolicy.Required
            and self.backup is None
        ):
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
        backup_policy: BackupPolicy = BackupPolicy.Required,
    ) -> ReleaseAttempt:
        return cls(
            schema_version=2,
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
            backup_policy=backup_policy,
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
        if (
            self.phase is ReleasePhase.WritersStopped
            and phase is ReleasePhase.DataMutationStarted
            and self.backup_policy is not BackupPolicy.Waived
        ):
            raise ReleaseDefect("direct migration transition requires a database backup waiver")
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
        value: dict[str, object] = {
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
        if self.schema_version == 2:
            value["backup_policy"] = self.backup_policy.value
        return value

    @classmethod
    def from_json(cls, value: object) -> ReleaseAttempt:
        schema_version = _integer(_mapping(value, "release attempt"), "schema_version")
        if schema_version not in (1, 2):
            raise ReleaseDefect("release attempt schema version must be 1 or 2")
        mapping = _closed_mapping(
            value,
            _LEGACY_ATTEMPT_FIELDS if schema_version == 1 else _ATTEMPT_FIELDS,
            "release attempt",
        )
        try:
            backup_policy = (
                BackupPolicy.Required
                if schema_version == 1
                else BackupPolicy(_string(mapping, "backup_policy"))
            )
        except ValueError as exc:
            raise ReleaseDefect("release backup policy is malformed") from exc
        containers_value = _mapping(mapping.get("containers"), "attempt containers")
        try:
            phase = ReleasePhase(_string(mapping, "phase"))
        except ValueError as exc:
            raise ReleaseDefect("release attempt has an unknown phase") from exc
        backup_value = mapping.get("backup")
        return cls(
            schema_version=schema_version,
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
            backup_policy=backup_policy,
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
        if (
            current.phase is ReleasePhase.WritersStopped
            and attempt.phase is ReleasePhase.DataMutationStarted
            and current.backup_policy is not BackupPolicy.Waived
        ):
            raise ReleaseDefect("direct migration transition requires a database backup waiver")
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


def android_player_protocol_identity(corpus: Path) -> AndroidPlayerProtocolIdentity:
    try:
        return AndroidPlayerProtocolIdentity.of_corpus(corpus)
    except BackendArtifactDefect as exc:
        raise ReleaseDefect(str(exc)) from exc


def load_android_release_manifest(
    path: Path,
    *,
    corpus: Path,
    expected_tag: str,
) -> AndroidPlayerProtocolIdentity:
    """Strictly decode a stable signed release manifest and return its player identity."""
    _require_match("stable Android release tag", expected_tag, ANDROID_RELEASE_TAG)
    manifest = _closed_mapping(
        _read_json(path), _ANDROID_RELEASE_MANIFEST_FIELDS, "Android release manifest"
    )
    if type(manifest.get("version")) is not int or manifest["version"] != 2:
        raise ReleaseDefect("Android release manifest version is unsupported")
    run_id = manifest.get("run_id")
    if not isinstance(run_id, str) or not run_id:
        raise ReleaseDefect("Android release manifest run id is malformed")
    tag = manifest.get("tag")
    if not isinstance(tag, str) or tag != expected_tag:
        raise ReleaseDefect("Android release manifest tag differs from the selected stable release")
    if manifest.get("package") != "app.nexus.android":
        raise ReleaseDefect("Android release manifest package is unsupported")
    if type(manifest.get("version_code")) is not int or manifest["version_code"] < 1:
        raise ReleaseDefect("Android release manifest version code is malformed")
    previous_version_code = manifest.get("previous_version_code")
    if (
        type(previous_version_code) is not int
        or previous_version_code < 1
        or previous_version_code >= manifest["version_code"]
    ):
        raise ReleaseDefect("Android release manifest previous version code is malformed")
    if manifest.get("version_name") != expected_tag.removeprefix("android-v"):
        raise ReleaseDefect("Android release manifest version name differs from its tag")
    _require_match("Android release manifest git SHA", manifest.get("git_sha"), _SHA)
    _require_match(
        "Android release manifest signer SHA-256",
        manifest.get("signer_sha256"),
        _SHA256,
    )
    source_apk_sha256 = _require_match(
        "Android release manifest source APK SHA-256",
        manifest.get("source_apk_sha256"),
        _SHA256,
    )
    if not is_exact_https_origin(manifest.get("api_origin")):
        raise ReleaseDefect("Android release manifest API origin is malformed")
    if manifest.get("api_origin_source") != "signed_apk_build_config":
        raise ReleaseDefect("Android release manifest API origin source is unsupported")
    target_sdk = manifest.get("target_sdk")
    if type(target_sdk) is not int or target_sdk < 1:
        raise ReleaseDefect("Android release manifest target SDK is malformed")
    version_name = expected_tag.removeprefix("android-v")
    apk_names = ("nexus-android.apk", f"nexus-android-{version_name}.apk")
    assets = _closed_mapping(
        manifest.get("assets"),
        frozenset((*apk_names, *(f"{name}.sha256" for name in apk_names))),
        "Android release manifest assets",
    )
    for name, digest in assets.items():
        _require_match(f"Android release manifest asset {name}", digest, _SHA256)
    if any(assets[name] != source_apk_sha256 for name in apk_names):
        raise ReleaseDefect("Android release manifest APK assets differ from their source digest")
    try:
        identity = AndroidPlayerProtocolIdentity.from_json(manifest.get("player_protocol"))
    except BackendArtifactDefect as exc:
        raise ReleaseDefect(f"Android release manifest {exc}") from exc
    if identity != android_player_protocol_identity(corpus):
        # The signed APK ships before the web candidate; a lagging published
        # identity is an expected release-order stop, not malformed input.
        raise ReleaseBlocked("Android release manifest player protocol differs from the corpus")
    return identity


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


def _environment_mapping(value: object, label: str) -> dict[str, str]:
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ReleaseDefect(f"{label} is malformed")
    environment: dict[str, str] = {}
    for item in value:
        name, separator, raw_value = item.partition("=")
        if not separator or not name or name in environment:
            raise ReleaseDefect(f"{label} is malformed")
        environment[name] = raw_value
    return environment


def _validated_codex_capacity_input_bytes(payload: bytes) -> bytes:
    """Validate the candidate-frozen canary input at the controller boundary."""

    if not payload or len(payload) > _CODEX_CAPACITY_INPUT_MAX_BYTES:
        raise ReleaseDefect("Codex capacity input exceeds its byte contract")
    value = _read_json_output(payload, "Codex capacity input")
    envelope = _closed_mapping(
        value,
        _CODEX_CAPACITY_INPUT_FIELDS,
        "Codex capacity input",
    )
    if _string(envelope, "schema_version") != _CODEX_CAPACITY_INPUT_SCHEMA_VERSION:
        raise ReleaseDefect("Codex capacity input schema differs")
    spec = _mapping(envelope.get("spec"), "Codex capacity input spec")
    intent = _closed_mapping(
        envelope.get("intent"),
        frozenset({"instructions", "input", "output"}),
        "Codex capacity input intent",
    )
    intent_output = _closed_mapping(
        intent.get("output"),
        frozenset({"kind"}),
        "Codex capacity input intent output",
    )
    selection = _closed_mapping(
        spec.get("selection"),
        frozenset({"route", "model", "reasoning"}),
        "Codex capacity input selection",
    )
    dispatch = _closed_mapping(
        spec.get("resolved_dispatch_target"),
        frozenset({"kind", "model_key", "dispatch_model", "agent_definition_revision"}),
        "Codex capacity input dispatch",
    )
    output_contract = _closed_mapping(
        spec.get("output_contract"),
        frozenset({"kind"}),
        "Codex capacity input output contract",
    )
    bounds = _mapping(spec.get("bounds"), "Codex capacity input bounds")
    prompt_ref = _closed_mapping(
        spec.get("prompt_payload_ref"),
        frozenset({"kind", "owner_kind", "owner_id", "revision", "payload_digest"}),
        "Codex capacity input prompt reference",
    )
    absent = {"kind": "Absent"}
    if (
        spec.get("schema_version") != "nexus-generation-spec.v1"
        or spec.get("operation") != "dawn_write"
        or spec.get("selection_source") != "BackgroundPolicy"
        or selection
        != {
            "route": "CodexPersonal",
            "model": "gpt-5.6-terra",
            "reasoning": "medium",
        }
        or dispatch.get("kind") != "CodexPersonal"
        or dispatch.get("model_key") != "gpt-5.6-terra"
        or dispatch.get("dispatch_model") != "gpt-5.6-terra"
        or output_contract != {"kind": "Text"}
        or intent_output != {"kind": "Text"}
        or intent.get("instructions") != _CODEX_CAPACITY_INPUT_INSTRUCTIONS
        or intent.get("input") != _CODEX_CAPACITY_INPUT_TEXT
        or spec.get("prompt_template_revision") != _CODEX_CAPACITY_PROMPT_TEMPLATE_REVISION
        or prompt_ref.get("kind") != "DomainPromptPayload"
        or prompt_ref.get("owner_kind") != "CodexCapacityCanary"
        or prompt_ref.get("owner_id") != "production-capacity"
        or prompt_ref.get("revision") != "dawn-write.v1"
        or bounds.get("turn_timeout_seconds") != 180
        or spec.get("effective_context_budget_tokens") != 128_000
        or spec.get("effective_output_budget_tokens") != 16_000
        or any(
            spec.get(field) != absent
            for field in (
                "host_tool_plan_snapshot",
                "host_evidence_revision",
                "model_tool_plan_snapshot",
                "tool_effect_mode",
                "admitted_tool_scope",
                "admitted_tool_scope_digest",
                "provider_registry_revision",
            )
        )
    ):
        raise ReleaseDefect("Codex capacity input differs from the fixed Dawn contract")

    def digest_fact(fact: object) -> str:
        try:
            encoded = json.dumps(
                fact,
                ensure_ascii=True,
                allow_nan=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        except (TypeError, ValueError) as exc:
            raise ReleaseDefect("Codex capacity input contains non-canonical data") from exc
        return hashlib.sha256(encoded).hexdigest()

    instructions = _string(intent, "instructions")
    input_text = _string(intent, "input")
    if (
        spec.get("instructions_digest") != hashlib.sha256(instructions.encode("utf-8")).hexdigest()
        or spec.get("input_digest") != hashlib.sha256(input_text.encode("utf-8")).hexdigest()
        or prompt_ref.get("payload_digest") != digest_fact(intent)
        or spec.get("output_contract_fingerprint") != digest_fact(output_contract)
    ):
        raise ReleaseDefect("Codex capacity input fact digests differ")
    fingerprint = spec.get("fingerprint")
    fingerprint_facts = dict(spec)
    fingerprint_facts.pop("fingerprint", None)
    if fingerprint != digest_fact(fingerprint_facts):
        raise ReleaseDefect("Codex capacity input fingerprint differs")
    try:
        canonical = (
            json.dumps(
                value,
                ensure_ascii=True,
                allow_nan=False,
                sort_keys=True,
                separators=(",", ":"),
            )
            + "\n"
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise ReleaseDefect("Codex capacity input contains non-canonical data") from exc
    if payload != canonical:
        raise ReleaseDefect("Codex capacity input is not canonical JSON")
    return canonical


def _is_default_local_bridge_ipam(value: object) -> bool:
    if not isinstance(value, dict):
        return False
    if value.get("Driver") != "default" or value.get("Options") not in ({}, None):
        return False
    configurations = value.get("Config")
    if not isinstance(configurations, list) or len(configurations) != 1:
        return False
    configuration = configurations[0]
    if not isinstance(configuration, dict) or set(configuration) != {
        "Subnet",
        "Gateway",
    }:
        return False
    subnet = configuration.get("Subnet")
    gateway = configuration.get("Gateway")
    if not isinstance(subnet, str) or not isinstance(gateway, str):
        return False
    try:
        network = ipaddress.ip_network(subnet, strict=True)
        address = ipaddress.ip_address(gateway)
    except ValueError:
        return False
    return (
        network.version == 4
        and address.version == 4
        and address in network
        and address not in {network.network_address, network.broadcast_address}
    )


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


def _finite_number(mapping: dict[str, Any], key: str) -> float:
    value = mapping.get(key)
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise ReleaseDefect(f"{key} must be a finite number")
    number = float(value)
    if not math.isfinite(number):
        raise ReleaseDefect(f"{key} must be a finite number")
    return number


def _string_list(value: object, label: str) -> tuple[str, ...]:
    if not isinstance(value, list) or not all(isinstance(item, str) and item for item in value):
        raise ReleaseDefect(f"{label} must be an array of nonempty strings")
    return tuple(value)


def _require_match(name: str, value: object, pattern: re.Pattern[str]) -> str:
    if not isinstance(value, str) or pattern.fullmatch(value) is None:
        raise ReleaseDefect(f"{name} is malformed")
    return value


def _require_timestamp(value: str) -> None:
    if _RELEASE_TIMESTAMP.fullmatch(value) is None:
        raise ReleaseDefect("release timestamp must be canonical UTC seconds")


def _release_timestamp_seconds(value: str, label: str) -> float:
    """Read one canonical UTC release timestamp as epoch seconds."""

    if _RELEASE_TIMESTAMP.fullmatch(value) is None:
        raise ReleaseDefect(f"{label} timestamp is not canonical UTC seconds")
    try:
        return float(calendar.timegm(time.strptime(value, "%Y-%m-%dT%H:%M:%SZ")))
    except ValueError as exc:
        raise ReleaseDefect(f"{label} timestamp is not canonical UTC seconds") from exc


def _docker_timestamp_seconds(value: object, label: str) -> float:
    if not isinstance(value, str):
        raise ReleaseDefect(f"{label} must be a Docker RFC3339 timestamp")
    matched = _DOCKER_TIMESTAMP.fullmatch(value)
    if matched is None:
        raise ReleaseDefect(f"{label} must be a Docker RFC3339 timestamp")
    fraction = (matched.group("fraction") or "")[:6].ljust(6, "0")
    try:
        parsed = time.strptime(matched.group("seconds"), "%Y-%m-%dT%H:%M:%S")
    except ValueError as exc:
        raise ReleaseDefect(f"{label} must be a Docker RFC3339 timestamp") from exc
    offset_seconds = 0
    if offset_sign := matched.group("offset_sign"):
        offset_seconds = (
            int(matched.group("offset_hours")) * 60 + int(matched.group("offset_minutes"))
        ) * 60
        if offset_sign == "-":
            offset_seconds = -offset_seconds
    return float(calendar.timegm(parsed) - offset_seconds) + int(fraction) / 1_000_000


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


def _create_bytes(
    path: Path,
    data: bytes,
    *,
    mode: int = 0o640,
    owner: tuple[int, int] | None = None,
) -> None:
    path.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".partial", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        if owner is not None:
            os.fchown(descriptor, *owner)
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


def _atomic_bytes(path: Path, data: bytes, *, mode: int = 0o640) -> None:
    path.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".partial", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, mode)
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


def _run_observed(
    command: tuple[str, ...],
    *,
    environment: dict[str, str] | None = None,
    timeout_seconds: int = 180,
) -> subprocess.CompletedProcess[bytes]:
    """Run a fixed observation command whose documented terminal is nonzero."""

    if not command or any(not part for part in command):
        raise ReleaseDefect("external command must be a fixed non-empty argv")
    try:
        return subprocess.run(
            command,
            env=environment,
            capture_output=True,
            check=False,
            timeout=timeout_seconds,
        )
    except (subprocess.TimeoutExpired, OSError) as exc:
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


def _ulimit_set(value: object) -> frozenset[tuple[str, int, int]] | None:
    """Read Docker's `HostConfig.Ulimits` as the exact (name, soft, hard) set, or None."""

    if not isinstance(value, list):
        return None
    limits: set[tuple[str, int, int]] = set()
    for item in value:
        if not isinstance(item, dict):
            return None
        name, soft, hard = item.get("Name"), item.get("Soft"), item.get("Hard")
        if (
            not isinstance(name, str)
            or isinstance(soft, bool)
            or isinstance(hard, bool)
            or not isinstance(soft, int)
            or not isinstance(hard, int)
        ):
            return None
        limits.add((name, soft, hard))
    return frozenset(limits)


def _inspect_one(container_id: str, label: str) -> dict[str, Any]:
    raw = _read_json_output(_run(("docker", "inspect", container_id)).stdout, label)
    if not isinstance(raw, list) or len(raw) != 1 or not isinstance(raw[0], dict):
        raise ReleaseDefect(f"{label} is malformed")
    return raw[0]


def _inspect_network_one(network_name: str, label: str) -> dict[str, Any]:
    raw = _read_json_output(
        _run(("docker", "network", "inspect", network_name)).stdout,
        label,
    )
    if not isinstance(raw, list) or len(raw) != 1 or not isinstance(raw[0], dict):
        raise ReleaseDefect(f"{label} is malformed")
    return raw[0]


def _inspect_volume_one(volume_name: str, label: str) -> dict[str, Any]:
    raw = _read_json_output(
        _run(("docker", "volume", "inspect", volume_name)).stdout,
        label,
    )
    if not isinstance(raw, list) or len(raw) != 1 or not isinstance(raw[0], dict):
        raise ReleaseDefect(f"{label} is malformed")
    return raw[0]


def _require_named_volume_mount(
    mount: object,
    *,
    volume_name: str,
    destination: str,
    read_write: bool,
    volume_label: str,
    breach: type[PermanentReleaseFailure],
    failure: str,
) -> None:
    """Require one container mount to be exactly the named local Docker volume."""

    volume = _inspect_volume_one(volume_name, volume_label)
    source = volume.get("Mountpoint")
    if (
        not isinstance(mount, dict)
        or volume.get("Name") != volume_name
        or volume.get("Driver") != "local"
        or volume.get("Scope") != "local"
        or volume.get("Options") not in ({}, None)
        or not isinstance(source, str)
        or not Path(source).is_absolute()
        or Path(source) != Path(os.path.normpath(source))
        or mount.get("Type") != "volume"
        or mount.get("Name") != volume_name
        or mount.get("Source") != source
        or mount.get("Destination") != destination
        or mount.get("RW") is not read_write
    ):
        raise breach(failure)


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


def _validate_installed_bundle_shape(
    files: frozenset[str],
    candidate: CandidateManifest,
    *,
    current_record: ReleaseRecord | None,
    manifest_sha256: str,
) -> None:
    if files == _BUNDLE_FILES:
        return
    if (
        files != _DB0215_BUNDLE_FILES
        or current_record is None
        or candidate.source_sha != current_record.source_sha
        or candidate.expected_database_revision != "0215"
        or current_record.database_revision != "0215"
        or manifest_sha256 != current_record.manifest_sha256
        or candidate.images.api != current_record.api_image
        or candidate.images.worker != current_record.worker_image
        or candidate.expected_oracle_manifest_digest
        != current_record.expected_oracle_manifest_digest
    ):
        raise ReleaseDefect("installed release bundle shape differs from its recorded contract")


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


def _codex_capacity_evidence_expired(measured_at: float, *, now: float) -> bool:
    """Decide whether a capacity measurement still describes the promoting host.

    One predicate serves both the promotion read and the re-qualification write:
    the exact measurement a promotion refuses as expired is the one a rerun may
    replace, and neither side may drift from the other.
    """

    age_seconds = now - measured_at
    return age_seconds < -1.0 or age_seconds > _CODEX_CAPACITY_EVIDENCE_MAX_AGE_SECONDS


def _requires_codex_agent_host(candidate: CandidateManifest) -> bool:
    """Bind the new host/topology/MCP contract to its hard-cut revision.

    A 0216 metadata predecessor may use the retired single-container shape.
    Predecessor verification therefore proves its application publication but
    does not pretend it implements the 0224 sidecar and MCP contract. Every
    0224 candidate and current release is held to the new contract exactly.
    """

    revision = candidate.expected_database_revision
    if re.fullmatch(r"[0-9]+", revision) is None:
        raise ReleaseDefect("Codex host requirement needs a numeric database revision")
    return int(revision) >= _CODEX_PERSONAL_GENERATION_REVISION


def publish_config(source: Path, store: ReleaseStore, *, next_source_sha: str) -> str:
    store.assert_no_oracle_attempt()
    if store.paths.caddy_activation.exists():
        raise ReleaseBlocked("pending Caddy activation blocks config publication")
    store.require_current_record()
    store.assert_fresh_candidate(next_source_sha)
    values = _read_env(source)
    if "NODE_INGEST_SCRIPT" in values:
        raise ReleaseDefect(
            "NODE_INGEST_SCRIPT is image-owned and must not be present in published production config"
        )
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
        files = _bundle_files(bundle)
        for relative in files:
            item = bundle / relative
            metadata = item.stat()
            if metadata.st_uid != 0 or metadata.st_mode & 0o222:
                raise ReleaseDefect(
                    f"installed release asset is not root-owned immutable: {relative}"
                )
        candidate = load_candidate_manifest(bundle / "candidate-manifest.json")
        if candidate.source_sha != source_sha:
            raise ReleaseDefect("bundle path and candidate source SHA differ")
        _validate_installed_bundle_shape(
            files,
            candidate,
            current_record=(
                self.store.require_current_record() if files == _DB0215_BUNDLE_FILES else None
            ),
            manifest_sha256=_sha256(bundle / "candidate-manifest.json"),
        )
        return bundle

    def _require_codex_isolated_gateway_support(self) -> None:
        """Admit only Engines that implement the private bridge's isolation mode."""

        completed = _run(("docker", "version", "--format", "{{.Server.Version}}"))
        try:
            version = completed.stdout.decode("ascii").strip()
        except UnicodeDecodeError as exc:
            raise ReleaseDefect("Docker Engine server version is malformed") from exc
        matched = re.fullmatch(r"([0-9]+)(?:\.[0-9]+){1,2}(?:[-+].*)?", version)
        if matched is None:
            raise ReleaseDefect("Docker Engine server version is malformed")
        if int(matched.group(1)) < _CODEX_ISOLATED_GATEWAY_MINIMUM_DOCKER_MAJOR:
            raise ReleaseBlocked("Docker Engine 28 or newer is required for isolated gateway mode")

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
        profiles: tuple[str, ...] = (),
        input_bytes: bytes | None = None,
        timeout_seconds: int = 180,
    ) -> subprocess.CompletedProcess[bytes]:
        # Profiles are opted into per invocation, never globally: enabling
        # `release` for every command would put the profile-gated migration
        # one-off in scope for `up`, which must never start it implicitly.
        profile_arguments = tuple(
            argument for profile in profiles for argument in ("--profile", profile)
        )
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
                *profile_arguments,
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
        expected_image_id: str,
        timeout_seconds: int,
    ) -> bytes:
        service = arguments[0]
        if service not in {"migration", "worker-background"}:
            raise ReleaseDefect(f"durable Compose job service {service!r} is unsupported")
        expected_image_reference = (
            candidate.images.api if service == "migration" else candidate.images.worker
        )
        expected_command = _MIGRATION_COMMAND if service == "migration" else arguments[1:]
        completed = self._settle_compose_job(
            name,
            service=service,
            expected_image_reference=expected_image_reference,
            expected_image_id=expected_image_id,
            expected_command=expected_command,
        )
        if completed is not None:
            return completed

        self._compose(
            bundle=bundle,
            candidate=candidate,
            config_path=config_path,
            arguments=("run", "--name", name, "--no-deps", "--no-TTY", *arguments),
            # Only the migration one-off is profile-gated; other one-off services
            # are always in scope and need no profile opt-in.
            profiles=("release",) if service == "migration" else (),
            timeout_seconds=timeout_seconds,
        )
        completed = self._settle_compose_job(
            name,
            service=service,
            expected_image_reference=expected_image_reference,
            expected_image_id=expected_image_id,
            expected_command=expected_command,
        )
        if completed is None:
            raise ReleaseDefect(f"durable Compose job {name} disappeared after completion")
        return completed

    def _settle_compose_job(
        self,
        name: str,
        *,
        service: str,
        expected_image_reference: str,
        expected_image_id: str,
        expected_command: tuple[str, ...],
    ) -> bytes | None:
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
            inspected = _inspect_one(listed, f"durable Compose job {name} inspect")
            try:
                config = _mapping(
                    inspected.get("Config"),
                    f"durable Compose job {name} config",
                )
                labels = _mapping(
                    config.get("Labels"),
                    f"durable Compose job {name} labels",
                )
            except ReleaseDefect as exc:
                raise ReleaseDefect("durable Compose job identity differs") from exc
            if (
                inspected.get("Name") != f"/{name}"
                or inspected.get("Image") != expected_image_id
                or config.get("Image") != expected_image_reference
                or config.get("Cmd") != list(expected_command)
                or labels.get("com.docker.compose.project") != "nexus"
                or labels.get("com.docker.compose.service") != service
                or labels.get("com.docker.compose.oneoff") != "True"
                # Compose stamps `config-hash` from its own internal service
                # digest, which `docker compose config --hash` does not
                # reproduce; requiring equality against that value rejects even
                # the container Compose just created. Prove Compose authored the
                # container by requiring a well-formed label, and pin the actual
                # execution through the immutable bundle's image id, command, and
                # resource limits, all of which are compared here.
                or _SHA256.fullmatch(str(labels.get("com.docker.compose.config-hash"))) is None
            ):
                raise ReleaseDefect("durable Compose job identity differs")
            self._validate_resource_limits(service, inspected)
            state = _mapping(inspected.get("State"), f"durable Compose job {name} state")
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

    def _validate_resource_limits(self, service: str, inspected: dict[str, Any]) -> None:
        expected = _RESOURCE_LIMITS.get(service)
        if expected is None:
            raise ReleaseDefect(f"resource contract for {service!r} is unsupported")
        host_config = _mapping(inspected.get("HostConfig"), f"{service} host config")
        observed = (
            host_config.get("MemoryReservation"),
            host_config.get("Memory"),
            host_config.get("PidsLimit"),
        )
        if observed != expected:
            raise PermanentReleaseFailure(
                f"{service} resource limits differ: observed={observed!r} expected={expected!r}"
            )
        # Without this the hard limit bounds RAM only: Docker defaults memoryswap
        # to twice the memory limit, so a service could take its whole limit again
        # from host swap and the committed envelope would not hold.
        if host_config.get("MemorySwap") != expected[1]:
            raise PermanentReleaseFailure(
                f"{service} memory-swap limit differs: "
                f"observed={host_config.get('MemorySwap')!r} expected={expected[1]!r}"
            )

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
        require_writer_health: bool,
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
            inspected = _inspect_one(container_id, f"{service} container inspect")
            state = _mapping(inspected.get("State"), f"{service} state")
            expected_running = writers_running if service in _WRITERS else True
            if state.get("Running") is not expected_running:
                state_name = "running" if expected_running else "stopped"
                raise ReleaseDefect(f"{service} is not {state_name} before release")
            if service in _WRITERS and expected_running and require_writer_health:
                health = state.get("Health")
                if not isinstance(health, dict) or health.get("Status") != "healthy":
                    raise ExternalCommandFailed(
                        f"predecessor {service} is not healthy",
                        operation=f"predecessor-health:{service}",
                    )
            image_id = _require_match(f"{service} image id", inspected.get("Image"), _IMAGE_ID)
            config = _mapping(inspected.get("Config"), f"{service} config")
            labels = _mapping(config.get("Labels"), f"{service} Compose labels")
            if (
                labels.get("com.docker.compose.project") != "nexus"
                or labels.get("com.docker.compose.service") != service
            ):
                raise PermanentReleaseFailure(
                    f"live {service} does not belong to the exact Nexus Compose project"
                )
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

    def _container_usage(self, container_id: str, service: str) -> tuple[int, int]:
        raw = _read_json_output(
            _run(
                (
                    "docker",
                    "stats",
                    "--no-stream",
                    "--format",
                    "{{json .}}",
                    container_id,
                )
            ).stdout,
            f"{service} resource usage",
        )
        value = _mapping(raw, f"{service} resource usage")
        usage = value.get("MemUsage")
        pids = value.get("PIDs")
        if not isinstance(usage, str) or not isinstance(pids, str) or not pids.isdigit():
            raise ReleaseDefect(f"{service} resource usage is malformed")
        matched = re.fullmatch(r"([0-9]+(?:\.[0-9]+)?)(B|KiB|MiB|GiB) / .+", usage)
        if matched is None:
            raise ReleaseDefect(f"{service} memory usage is malformed")
        multiplier = {
            "B": 1,
            "KiB": 1024,
            "MiB": 1024 * 1024,
            "GiB": 1024 * 1024 * 1024,
        }[matched.group(2)]
        try:
            memory = int(Decimal(matched.group(1)) * multiplier)
        except InvalidOperation as exc:
            raise ReleaseDefect(f"{service} memory usage is malformed") from exc
        return memory, int(pids)

    def _converge_resource_limits(self, source_sha: str) -> None:
        current_record = self.store.require_current_record()
        current_attempt = self.store.load_attempt(current_record.source_sha)
        if current_attempt is None or current_attempt.phase is not ReleasePhase.Succeeded:
            raise ReleaseDefect("current release attempt is not exactly succeeded")
        self.store.assert_candidate_admissible(source_sha)
        bundle = self.bundle(source_sha)
        candidate = load_candidate_manifest(bundle / "candidate-manifest.json")
        config = self._config_snapshot()
        self._compose(
            bundle=bundle,
            candidate=candidate,
            config_path=config.path,
            arguments=("config", "--quiet"),
        )
        forward_fix_sha = self.store.forward_fix_sha()
        containers = self._container_evidence(
            bundle=bundle,
            candidate=candidate,
            config_path=config.path,
            writers_running=forward_fix_sha is None,
            require_writer_health=False,
        )
        if any(
            containers[service] != current_attempt.containers[service]
            for service in _INFRASTRUCTURE_SERVICES
        ):
            raise PermanentReleaseFailure(
                "live infrastructure differs from the current release attempt"
            )
        if forward_fix_sha is None and (
            containers["api"].image != current_record.api_image_id
            or containers["worker-interactive"].image != current_record.worker_image_id
            or containers["worker-background"].image != current_record.worker_image_id
        ):
            raise PermanentReleaseFailure(
                "live predecessor containers differ from the current release record"
            )
        self._preflight_host_capacity(
            containers,
            writers_running=forward_fix_sha is None,
        )

        drifted: list[tuple[str, str]] = []
        for service in _SERVICES:
            container_id = containers[service].container_id
            inspected = _inspect_one(container_id, f"{service} resource convergence inspect")
            host_config = _mapping(inspected.get("HostConfig"), f"{service} host config")
            state = _mapping(inspected.get("State"), f"{service} convergence state")
            running = state.get("Running")
            if type(running) is not bool:
                raise ReleaseDefect(f"{service} convergence running state is malformed")
            expected = _RESOURCE_LIMITS[service]
            observed = (
                host_config.get("MemoryReservation"),
                host_config.get("Memory"),
                host_config.get("MemorySwap"),
                host_config.get("PidsLimit"),
            )
            kernel_limits = (
                self._container_kernel_resources(container_id, service)[:4] if running else None
            )
            expected_kernel_limits = (
                str(expected[0]),
                str(expected[1]),
                "0",
                str(expected[2]),
            )
            if observed == (expected[0], expected[1], expected[1], expected[2]) and (
                kernel_limits is None or kernel_limits == expected_kernel_limits
            ):
                continue
            expected_running = service not in _WRITERS or forward_fix_sha is None
            if running is not expected_running:
                state_name = "running" if expected_running else "stopped"
                raise ReleaseBlocked(
                    f"{service} is not freshly proved {state_name} for resource convergence"
                )
            memory, pids = self._container_usage(container_id, service) if running else (0, 0)
            if memory >= expected[1]:
                raise ReleaseBlocked(f"{service} current memory is not below its hard limit")
            if pids > expected[2]:
                raise ReleaseBlocked(f"{service} current PID use exceeds its limit")
            drifted.append((service, container_id))

        for service, container_id in drifted:
            reservation, memory, pids = _RESOURCE_LIMITS[service]
            _run(
                (
                    "docker",
                    "update",
                    "--memory-reservation",
                    str(reservation),
                    "--memory",
                    str(memory),
                    # The daemon refuses a memory update that leaves memoryswap
                    # unset, and equal values deny the container swap entirely so
                    # the hard limit bounds RAM+swap rather than RAM alone.
                    "--memory-swap",
                    str(memory),
                    "--pids-limit",
                    str(pids),
                    container_id,
                )
            )
            converged = _inspect_one(container_id, f"{service} converged state inspect")
            converged_state = _mapping(
                converged.get("State"),
                f"{service} converged state",
            )
            converged_running = converged_state.get("Running")
            if type(converged_running) is not bool:
                raise ReleaseDefect(f"{service} converged running state is malformed")
            if converged_running:
                self._validate_running_resource_limits(
                    service,
                    container_id,
                    require_empty_swap=False,
                )
            else:
                self._validate_resource_limits(service, converged)
            print(
                "host-container-resource-converged"
                f" id={container_id} service={service!r}"
                f" reservation={reservation} memory={memory} pids={pids}",
                file=sys.stderr,
            )

        retained_swap: list[str] = []
        for service, evidence in containers.items():
            inspected = _inspect_one(
                evidence.container_id,
                f"{service} settled resource inspect",
            )
            state = _mapping(inspected.get("State"), f"{service} settled state")
            running = state.get("Running")
            if type(running) is not bool:
                raise ReleaseDefect(f"{service} settled running state is malformed")
            if running:
                swap_current = self._validate_running_resource_limits(
                    service,
                    evidence.container_id,
                    require_empty_swap=False,
                )
                if swap_current:
                    retained_swap.append(
                        f"{service} container {evidence.container_id} retains {swap_current} bytes"
                    )
            else:
                self._validate_resource_limits(service, inspected)
        if retained_swap:
            raise ReleaseBlocked(
                "running containers retain forbidden swap: "
                + ", ".join(retained_swap)
                + "; restart those exact containers before continuing"
            )

    def _host_text(self, path: Path, label: str) -> str:
        try:
            return path.read_text(encoding="ascii")
        except (OSError, UnicodeDecodeError) as exc:
            raise ReleaseBlocked(f"host {label} evidence is unavailable") from exc

    def _running_container_cgroup(self, container_id: str, service: str) -> Path:
        """Resolve one running container's host cgroup without entering it."""

        inspected = _inspect_one(container_id, f"{service} cgroup inspect")
        state = _mapping(inspected.get("State"), f"{service} cgroup state")
        pid = state.get("Pid")
        if (
            state.get("Running") is not True
            or not isinstance(pid, int)
            or isinstance(pid, bool)
            or pid <= 0
        ):
            raise ReleaseBlocked(f"{service} has no running cgroup")
        unified: list[str] = []
        for line in self._host_text(
            self.paths.proc_root / str(pid) / "cgroup",
            f"{service} container cgroup",
        ).splitlines():
            if line.startswith("0::"):
                unified.append(line.removeprefix("0::"))
        if (
            len(unified) != 1
            or not unified[0].startswith("/")
            or unified[0].startswith("//")
            or unified[0] == "/"
            or unified[0] != os.path.normpath(unified[0])
        ):
            raise ReleaseDefect(f"{service} container cgroup evidence is malformed")
        confirmed = _mapping(
            _inspect_one(container_id, f"{service} cgroup identity recheck").get("State"),
            f"{service} cgroup identity state",
        )
        if confirmed.get("Running") is not True or confirmed.get("Pid") != pid:
            raise ReleaseBlocked(f"{service} changed while its cgroup was resolved")
        return self.paths.cgroup_root / unified[0].removeprefix("/")

    def _cgroup_resources(self, cgroup: Path, service: str) -> tuple[str, str, str, str, int]:
        limits: list[str] = []
        for name in ("memory.low", "memory.max", "memory.swap.max", "pids.max"):
            value = self._host_text(cgroup / name, f"{service} {name}").strip()
            if re.fullmatch(r"[0-9]+|max", value) is None:
                raise ReleaseDefect(f"{service} cgroup resource evidence is malformed")
            limits.append(value)
        swap_current = self._host_text(
            cgroup / "memory.swap.current",
            f"{service} memory.swap.current",
        ).strip()
        if not swap_current.isdigit():
            raise ReleaseDefect(f"{service} cgroup resource evidence is malformed")
        return limits[0], limits[1], limits[2], limits[3], int(swap_current)

    def _container_kernel_resources(
        self,
        container_id: str,
        service: str,
    ) -> tuple[str, str, str, str, int]:
        return self._cgroup_resources(
            self._running_container_cgroup(container_id, service),
            service,
        )

    def _validate_running_resource_limits(
        self,
        service: str,
        container_id: str,
        *,
        require_empty_swap: bool = True,
    ) -> int:
        inspected = _inspect_one(container_id, f"{service} running resource inspect")
        self._validate_resource_limits(service, inspected)
        reservation, memory, pids = _RESOURCE_LIMITS[service]
        observed = self._container_kernel_resources(container_id, service)
        expected = (str(reservation), str(memory), "0", str(pids))
        if observed[:4] != expected:
            raise ReleaseBlocked(
                f"{service} kernel resource limits differ: "
                f"observed={observed[:4]!r} expected={expected!r}"
            )
        if require_empty_swap and observed[4] != 0:
            raise ReleaseBlocked(
                f"{service} container {container_id} retains "
                f"{observed[4]} bytes of forbidden swap; "
                "restart the exact container before continuing"
            )
        return observed[4]

    def _require_codex_agent_host_kernel_boundary(self) -> None:
        if (
            self._host_text(
                self.paths.apparmor_userns_restriction,
                "AppArmor user-namespace restriction",
            )
            != "1\n"
        ):
            raise ReleaseBlocked(
                "host AppArmor unprivileged-user-namespace restriction is not enabled"
            )

    def _require_codex_state_storage(self) -> None:
        """Prove the credential filesystem is the dedicated live LUKS2 mount."""

        failure = "Codex credential state storage is not the dedicated encrypted mount"
        try:
            container = self.paths.codex_state_container.lstat()
            mount = self.paths.codex_state_mount.lstat()
            credential = self.paths.codex_enrolled_auth.lstat()
            if (
                not stat.S_ISREG(container.st_mode)
                or container.st_uid != 0
                or container.st_gid != 0
                or stat.S_IMODE(container.st_mode) != 0o600
                or container.st_nlink != 1
                or container.st_size != _CODEX_STATE_CONTAINER_SIZE_BYTES
                or not stat.S_ISDIR(mount.st_mode)
                or mount.st_uid != 10001
                or mount.st_gid != 10001
                or stat.S_IMODE(mount.st_mode) != 0o700
                or not stat.S_ISREG(credential.st_mode)
                or credential.st_uid != 10001
                or credential.st_gid != 10001
                or stat.S_IMODE(credential.st_mode) != 0o600
                or credential.st_nlink != 1
                or not 0 < credential.st_size <= _CODEX_ENROLLED_AUTH_MAX_BYTES
                or self.paths.codex_state_forbidden_key.exists()
            ):
                raise ReleaseBlocked(failure)

            if self.paths.crypttab.exists():
                crypttab = self.paths.crypttab.read_text(encoding="utf-8")
                configured = tuple(
                    line.split("#", 1)[0].split()
                    for line in crypttab.splitlines()
                    if line.split("#", 1)[0].split()
                )
                if any(
                    fields[0] == _CODEX_STATE_MAPPER_NAME
                    or (len(fields) > 1 and fields[1] == str(self.paths.codex_state_container))
                    for fields in configured
                ):
                    raise ReleaseBlocked(failure)

            environment = {**os.environ, "LC_ALL": "C"}
            luks = _run_observed(
                (
                    "cryptsetup",
                    "isLuks",
                    "--type",
                    "luks2",
                    str(self.paths.codex_state_container),
                ),
                environment=environment,
                timeout_seconds=10,
            )
            if luks.returncode != 0 or luks.stdout or luks.stderr:
                raise ReleaseBlocked(failure)

            status = _run_observed(
                ("cryptsetup", "status", _CODEX_STATE_MAPPER_NAME),
                environment=environment,
                timeout_seconds=10,
            )
            if status.returncode != 0 or status.stderr:
                raise ReleaseBlocked(failure)
            status_lines = status.stdout.decode("ascii").splitlines()
            if not status_lines or status_lines[0].strip() not in {
                f"{_CODEX_STATE_MAPPER} is active.",
                f"{_CODEX_STATE_MAPPER} is active and is in use.",
            }:
                raise ReleaseBlocked(failure)
            status_fields: dict[str, str] = {}
            for line in status_lines[1:]:
                key, separator, value = line.strip().partition(":")
                if not separator:
                    continue
                key = key.strip().lower()
                if key in status_fields:
                    raise ReleaseBlocked(failure)
                status_fields[key] = value.strip()
            loop_device = status_fields.get("device")
            if status_fields.get("type") != "LUKS2" or not isinstance(loop_device, str):
                raise ReleaseBlocked(failure)
            if re.fullmatch(r"/dev/loop[0-9]+", loop_device) is None:
                raise ReleaseBlocked(failure)

            backing = _run_observed(
                ("losetup", "--noheadings", "--output", "BACK-FILE", loop_device),
                environment=environment,
                timeout_seconds=10,
            )
            if (
                backing.returncode != 0
                or backing.stderr
                or backing.stdout.decode("utf-8").strip() != str(self.paths.codex_state_container)
            ):
                raise ReleaseBlocked(failure)

            mounted = _run_observed(
                (
                    "findmnt",
                    "--json",
                    "--mountpoint",
                    str(self.paths.codex_state_mount),
                    "--output",
                    "SOURCE,TARGET,FSTYPE,OPTIONS",
                ),
                environment=environment,
                timeout_seconds=10,
            )
            if mounted.returncode != 0 or mounted.stderr:
                raise ReleaseBlocked(failure)
            mount_value = _mapping(
                _read_json_output(mounted.stdout, "Codex state mount"),
                "Codex state mount",
            )
            filesystems = mount_value.get("filesystems")
            if (
                not isinstance(filesystems, list)
                or len(filesystems) != 1
                or not isinstance(filesystems[0], dict)
            ):
                raise ReleaseBlocked(failure)
            filesystem = filesystems[0]
            options = filesystem.get("options")
            if (
                set(filesystem) != {"source", "target", "fstype", "options"}
                or filesystem.get("source") != str(_CODEX_STATE_MAPPER)
                or filesystem.get("target") != str(self.paths.codex_state_mount)
                or filesystem.get("fstype") != "ext4"
                or not isinstance(options, str)
                or not _CODEX_STATE_REQUIRED_MOUNT_OPTIONS.issubset(options.split(","))
            ):
                raise ReleaseBlocked(failure)

            available = _run_observed(
                (
                    "df",
                    "--output=avail",
                    "--block-size=1",
                    "--",
                    str(self.paths.codex_state_mount),
                ),
                environment=environment,
                timeout_seconds=10,
            )
            available_lines = available.stdout.decode("ascii").splitlines()
            if (
                available.returncode != 0
                or available.stderr
                or len(available_lines) != 2
                or available_lines[0].strip() != "Avail"
                or re.fullmatch(r"[0-9]+", available_lines[1].strip()) is None
            ):
                raise ReleaseBlocked(failure)
            if int(available_lines[1].strip()) < _CODEX_STATE_MINIMUM_FREE_BYTES:
                raise ReleaseBlocked("Codex credential state has less than 128 MiB free")

        except (
            OSError,
            UnicodeDecodeError,
            ReleaseDefect,
            ExternalCommandFailed,
        ) as exc:
            raise ReleaseBlocked(failure) from exc

    def _validate_codex_state_boot_guard(self) -> None:
        failure = "Codex credential state boot guard differs from release contract"
        for path, expected, mode in (
            (self.paths.codex_state_boot_guard, _CODEX_STATE_BOOT_GUARD, 0o755),
            (
                self.paths.codex_state_boot_guard_unit,
                _CODEX_STATE_BOOT_GUARD_UNIT,
                0o644,
            ),
            (
                self.paths.codex_state_docker_drop_in,
                _CODEX_STATE_DOCKER_DROP_IN,
                0o644,
            ),
        ):
            try:
                metadata = path.lstat()
                content = path.read_bytes()
            except OSError as exc:
                raise ReleaseBlocked(failure) from exc
            if (
                not stat.S_ISREG(metadata.st_mode)
                or metadata.st_uid != 0
                or metadata.st_gid != 0
                or stat.S_IMODE(metadata.st_mode) != mode
                or content != expected
            ):
                raise ReleaseBlocked(failure)
        enabled = _run_observed(
            ("systemctl", "is-enabled", "--quiet", _CODEX_STATE_BOOT_GUARD_NAME),
            timeout_seconds=10,
        )
        if enabled.returncode != 0 or enabled.stdout or enabled.stderr:
            raise ReleaseBlocked(failure)

    def _prepare_codex_state_boot_guard(self) -> None:
        for path, content, mode in (
            (self.paths.codex_state_boot_guard, _CODEX_STATE_BOOT_GUARD, 0o755),
            (
                self.paths.codex_state_boot_guard_unit,
                _CODEX_STATE_BOOT_GUARD_UNIT,
                0o644,
            ),
            (
                self.paths.codex_state_docker_drop_in,
                _CODEX_STATE_DOCKER_DROP_IN,
                0o644,
            ),
        ):
            _atomic_bytes(path, content, mode=mode)
            os.chown(path, 0, 0)
        _run(("systemctl", "daemon-reload"), timeout_seconds=10)
        _run(
            ("systemctl", "enable", _CODEX_STATE_BOOT_GUARD_NAME),
            timeout_seconds=10,
        )
        self._validate_codex_state_boot_guard()

    def install_codex_state_boot_guard(self, source_sha: str) -> dict[str, str]:
        """Install the boot guard from one exact admissible Codex candidate."""

        self.store.assert_no_oracle_attempt()
        self.store.assert_candidate_admissible(source_sha)
        bundle = self.bundle(source_sha)
        candidate = load_candidate_manifest(bundle / "candidate-manifest.json")
        if not _requires_codex_agent_host(candidate):
            raise ReleaseBlocked("candidate has no Codex agent host")
        self._require_codex_state_storage()
        self._prepare_codex_state_boot_guard()
        return {
            "schema_version": "nexus-codex-state-boot-guard.v1",
            "source_sha": source_sha,
            "status": "installed",
        }

    def _preflight_codex_agent_host_security(self, bundle: Path) -> None:
        self._require_codex_agent_host_kernel_boundary()
        _run(
            (
                "apparmor_parser",
                "-Q",
                str(bundle / "nexus-codex-agent-host.apparmor"),
            ),
            timeout_seconds=10,
        )

    def _revalidate_attempt_host_capacity(
        self,
        attempt: ReleaseAttempt,
        *,
        writers_running: bool | None,
    ) -> None:
        for service in _SERVICES:
            evidence = attempt.containers[service]
            inspected = _inspect_one(evidence.container_id, f"{service} replay preflight inspect")
            config = _mapping(inspected.get("Config"), f"{service} replay preflight config")
            labels = _mapping(config.get("Labels"), f"{service} replay preflight labels")
            state = _mapping(inspected.get("State"), f"{service} replay preflight state")
            running = state.get("Running")
            if type(running) is not bool:
                raise ReleaseDefect(f"{service} replay preflight running state is malformed")
            if (
                inspected.get("Image") != evidence.image
                or hashlib.sha256(_canonical_json(config)).hexdigest() != evidence.config_sha256
                or labels.get("com.docker.compose.project") != "nexus"
                or labels.get("com.docker.compose.service") != service
            ):
                raise ReleaseDefect(f"{service} identity changed before replay mutation")
            if service in _INFRASTRUCTURE_SERVICES:
                if running is not True:
                    raise ReleaseBlocked(f"{service} is not running before replay mutation")
            elif writers_running is not None and running is not writers_running:
                expected = "running" if writers_running else "stopped"
                raise ReleaseBlocked(f"{service} is not {expected} before replay mutation")
            if running:
                self._validate_running_resource_limits(service, evidence.container_id)
            else:
                self._validate_resource_limits(service, inspected)
            if service == "caddy":
                self._validate_caddy_mount(inspected)

        # Prepared can be a crash prefix with some exact writers already stopped.
        # Treat every recorded writer id as owned while the fresh inspections above
        # prove its actual state; later phases require every writer stopped.
        self._preflight_host_capacity(
            attempt.containers,
            writers_running=writers_running is not False,
        )

    def _host_memory_bytes(self) -> dict[str, int]:
        """Read the three retained `/proc/meminfo` counters, in bytes.

        This is the only parser of that file; every gate applies its own
        thresholds to what it returns.
        """

        meminfo: dict[str, int] = {}
        for line in self._host_text(self.paths.meminfo, "memory").splitlines():
            key, separator, raw = line.partition(":")
            if key not in {"MemTotal", "MemAvailable", "SwapTotal"}:
                continue
            parts = raw.split()
            if not separator or len(parts) != 2 or parts[1] != "kB" or not parts[0].isdigit():
                raise ReleaseDefect(f"host {key} evidence is malformed")
            if key in meminfo:
                raise ReleaseDefect(f"host {key} evidence is duplicated")
            meminfo[key] = int(parts[0]) * 1024
        if set(meminfo) != {"MemTotal", "MemAvailable", "SwapTotal"}:
            raise ReleaseDefect("host memory evidence is incomplete")
        return meminfo

    def _host_memory_pressure(self) -> dict[str, float]:
        """Read the `some`/`full` 10-second memory pressure averages.

        This is the only parser of `/proc/pressure/memory`; every gate applies
        its own thresholds to what it returns.
        """

        pressure: dict[str, float] = {}
        for line in self._host_text(self.paths.memory_pressure, "memory pressure").splitlines():
            parts = line.split()
            if not parts or parts[0] not in {"some", "full"}:
                continue
            avg10 = next((item for item in parts[1:] if item.startswith("avg10=")), None)
            if avg10 is None or parts[0] in pressure:
                raise ReleaseDefect("host memory pressure evidence is malformed")
            try:
                measured = float(avg10.removeprefix("avg10="))
            except ValueError as exc:
                raise ReleaseDefect("host memory pressure evidence is malformed") from exc
            if not math.isfinite(measured):
                raise ReleaseDefect("host memory pressure evidence is malformed")
            pressure[parts[0]] = measured
        if set(pressure) != {"some", "full"}:
            raise ReleaseDefect("host memory pressure evidence is incomplete")
        return pressure

    def _preflight_host_capacity(
        self,
        containers: dict[str, ContainerEvidence],
        *,
        writers_running: bool,
    ) -> None:
        controllers = self._host_text(
            self.paths.cgroup_controllers,
            "cgroup v2 controller",
        ).split()
        if "memory" not in controllers:
            raise ReleaseBlocked("host cgroup v2 memory controller is unavailable")

        meminfo = self._host_memory_bytes()
        if meminfo["MemTotal"] < _MIN_HOST_MEMORY_BYTES:
            raise ReleaseBlocked("host memory is below the committed 1900 MiB floor")
        reservation_sum = sum(_RESOURCE_LIMITS[service][0] for service in _CAPACITY_SERVICES)
        if meminfo["MemTotal"] - reservation_sum < _HOST_RESERVED_MEMORY_BYTES:
            raise ReleaseBlocked("host memory reserve is below 320 MiB")
        if meminfo["MemAvailable"] < _MIN_AVAILABLE_MEMORY_BYTES:
            raise ReleaseBlocked("host available memory is below 128 MiB")
        if meminfo["SwapTotal"] < _MIN_SWAP_BYTES:
            raise ReleaseBlocked("host swap is below 1 GiB")

        pressure = self._host_memory_pressure()
        if pressure["some"] > 10:
            raise ReleaseBlocked("host memory pressure exceeds the release envelope")

        try:
            parser_temp_metadata = self.paths.parser_temp_root.lstat()
        except OSError as exc:
            raise ReleaseBlocked("parser temporary filesystem is unavailable") from exc
        if (
            not stat.S_ISDIR(parser_temp_metadata.st_mode)
            or parser_temp_metadata.st_uid != 10001
            or parser_temp_metadata.st_gid != 10001
            or stat.S_IMODE(parser_temp_metadata.st_mode) != 0o700
        ):
            raise ReleaseBlocked("parser temporary root metadata is not exact")
        try:
            parser_temp_free = shutil.disk_usage(self.paths.parser_temp_root).free
        except OSError as exc:
            raise ReleaseBlocked("parser temporary filesystem is unavailable") from exc
        if parser_temp_free < _MIN_PARSER_TEMP_FREE_BYTES:
            raise ReleaseBlocked("parser temporary filesystem has less than 512 MiB free")

        output = _stdout(("docker", "ps", "--quiet", "--no-trunc"))
        running_ids = tuple(line for line in output.splitlines() if line)
        if len(running_ids) != len(set(running_ids)):
            raise ReleaseDefect("running container evidence is duplicated")
        for container_id in running_ids:
            _require_match("running container id", container_id, _CONTAINER_ID)
        expected_running = {
            evidence.container_id
            for service, evidence in containers.items()
            if service in _INFRASTRUCTURE_SERVICES or writers_running
        }
        unknown: list[str] = []
        for container_id in running_ids:
            inspected = _inspect_one(container_id, f"running container {container_id} inspect")
            config = _mapping(inspected.get("Config"), "running container config")
            labels = _mapping(config.get("Labels"), "running container labels")
            project = labels.get("com.docker.compose.project")
            service = labels.get("com.docker.compose.service")
            oneoff = labels.get("com.docker.compose.oneoff")
            state = _mapping(inspected.get("State"), "running container state")
            restart_count = inspected.get("RestartCount")
            oom_killed = state.get("OOMKilled")
            if type(restart_count) is not int or type(oom_killed) is not bool:
                raise ReleaseDefect("running container restart/OOM evidence is malformed")
            print(
                "host-container"
                f" id={container_id} project={project!r} service={service!r}"
                f" restarts={restart_count} oom_killed={oom_killed}",
                file=sys.stderr,
            )
            # The exact long-lived service containers are known by identity; the
            # controller's own bounded one-offs (migration, oracle reconcile) are
            # known by exact Compose project membership so a resumed release does
            # not report its own in-flight job as a foreign container.
            known = (
                container_id in expected_running
                or (project == "nexus" and oneoff == "True")
                or (
                    project == "nexus"
                    and service in {_CODEX_AGENT_HOST, _CODEX_EGRESS_POLICY}
                    and oneoff is None
                )
            )
            if not known:
                unknown.append(f"{container_id} project={project!r} service={service!r}")
        if unknown:
            raise ReleaseBlocked("unknown running container: " + ", ".join(unknown))
        stats = _stdout(("docker", "stats", "--no-stream", "--format", "{{json .}}", *running_ids))
        print(f"host-container-memory {stats}", file=sys.stderr)

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

    def preflight(
        self, source_sha: str, *, backup_policy: BackupPolicy = BackupPolicy.Required
    ) -> PreflightEvidence:
        self.store.assert_no_oracle_attempt()
        current_record = self.store.require_current_record()
        current_sha = current_record.source_sha
        self.store.assert_candidate_admissible(source_sha)
        forward_fix_sha = self.store.forward_fix_sha()
        if forward_fix_sha is None:
            self.verify_current(current_sha)
        bundle = self.bundle(source_sha)
        candidate = load_candidate_manifest(bundle / "candidate-manifest.json")
        if _requires_codex_agent_host(candidate):
            self._preflight_codex_agent_host_security(bundle)
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
        _run(
            (
                "docker",
                "run",
                "--rm",
                "--network",
                "none",
                "--read-only",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges",
                "--env-file",
                str(config.path),
                "--env",
                "PYTHONDONTWRITEBYTECODE=1",
                "--entrypoint",
                "python",
                candidate.images.api,
                "-c",
                "from nexus.config import get_settings; get_settings()",
            ),
            timeout_seconds=60,
        )
        containers = self._container_evidence(
            bundle=bundle,
            candidate=candidate,
            config_path=config.path,
            writers_running=forward_fix_sha is None,
            require_writer_health=True,
        )
        self._preflight_host_capacity(
            containers,
            writers_running=forward_fix_sha is None,
        )
        for service in _SERVICES:
            container_id = containers[service].container_id
            inspected = _inspect_one(
                container_id,
                f"{service} preflight resource inspect",
            )
            state = _mapping(inspected.get("State"), f"{service} preflight resource state")
            running = state.get("Running")
            if type(running) is not bool:
                raise ReleaseDefect(f"{service} preflight resource running state is malformed")
            if running:
                self._validate_running_resource_limits(service, container_id)
            else:
                self._validate_resource_limits(service, inspected)
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
        if backup_policy is BackupPolicy.Required:
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
            arguments=("stop", "--timeout", "30", "worker-background"),
        )
        self._assert_running_state(
            attempt.containers["worker-background"].container_id,
            running=False,
        )
        self._compose(
            bundle=bundle,
            candidate=candidate,
            config_path=config_path,
            arguments=("stop", "--timeout", "30", "worker-interactive", "api"),
        )
        for service in ("worker-interactive", "api"):
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
            arguments=("stop", "--timeout", "30", "worker-background"),
        )
        output = (
            self._compose(
                bundle=bundle,
                candidate=candidate,
                config_path=config_path,
                arguments=("ps", "--all", "--quiet", "worker-background"),
            )
            .stdout.decode()
            .strip()
        )
        if output:
            _require_match("stopped worker-background container id", output, _CONTAINER_ID)
            self._assert_running_state(output, running=False)
        self._compose(
            bundle=bundle,
            candidate=candidate,
            config_path=config_path,
            arguments=("stop", "--timeout", "30", "worker-interactive", "api"),
        )
        for service in ("worker-interactive", "api"):
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
            item = _inspect_one(evidence.container_id, f"rollback {service} inspect")
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
        expected_image_id: str,
    ) -> None:
        self._compose_job(
            name=f"nexus-release-{candidate.source_sha}-migration",
            bundle=bundle,
            candidate=candidate,
            config_path=config_path,
            arguments=("migration",),
            expected_image_id=expected_image_id,
            timeout_seconds=1800,
        )

    def _settle_completed_migration(
        self,
        source_sha: str,
        *,
        bundle: Path,
        candidate: CandidateManifest,
        config_path: Path,
        expected_image_id: str,
    ) -> None:
        self._settle_compose_job(
            f"nexus-release-{source_sha}-migration",
            service="migration",
            expected_image_reference=candidate.images.api,
            expected_image_id=expected_image_id,
            expected_command=_MIGRATION_COMMAND,
        )

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
            item = _inspect_one(evidence.container_id, f"{service} unchanged inspect")
            config = _mapping(item.get("Config"), f"{service} unchanged config")
            self._validate_running_resource_limits(service, evidence.container_id)
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
        require_codex_agent_host: bool,
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
        if require_codex_agent_host:
            self._prove_api_generation_surface(
                bundle=bundle,
                candidate=candidate,
                config_path=config_path,
            )
        for lane, service in (
            ("interactive", "worker-interactive"),
            ("background", "worker-background"),
        ):
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
            inspected = _inspect_one(container_id, f"{service} health inspect")
            if lane == "interactive" and _requires_codex_agent_host(candidate):
                self._validate_interactive_generation_surface(
                    inspected,
                    expected_mcp_origin=self._codex_mcp_origin(config_path),
                )
            state = _mapping(inspected.get("State"), f"{service} health state")
            health = _mapping(state.get("Health"), f"{service} health")
            log = health.get("Log")
            if (
                state.get("Running") is not True
                or state.get("Paused") is not False
                or state.get("Restarting") is not False
                or health.get("Status") != "healthy"
                or health.get("FailingStreak") != 0
                or not isinstance(log, list)
                or not log
            ):
                raise PermanentReleaseFailure(f"{lane} worker health is not exact")
            latest = _mapping(log[-1], f"{service} latest health result")
            output = latest.get("Output")
            started_at = _docker_timestamp_seconds(
                latest.get("Start"), f"{service} health receipt start"
            )
            ended_at = _docker_timestamp_seconds(latest.get("End"), f"{service} health receipt end")
            receipt_age = time.time() - ended_at
            if (
                latest.get("ExitCode") != 0
                or not isinstance(output, str)
                or len(output.encode("utf-8")) > 16_384
                or ended_at < started_at
                or receipt_age < -1.0
                or receipt_age > _WORKER_HEALTH_RECEIPT_MAX_AGE_SECONDS
            ):
                raise PermanentReleaseFailure(f"{lane} worker health is not exact")
            try:
                worker = _mapping(
                    _read_json_output(output.encode("utf-8"), f"{lane} worker health"),
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
        if require_codex_agent_host:
            self._prove_codex_agent_host(
                bundle=bundle,
                candidate=candidate,
                config_path=config_path,
                expected_worker_image_id=attempt.candidate_worker_image_id,
            )
            self._prove_codex_mcp_path(
                bundle=bundle,
                candidate=candidate,
                config_path=config_path,
            )
        return (
            attempt.candidate_api_image_id,
            attempt.candidate_worker_image_id,
            task_digest,
        )

    def _prove_api_generation_surface(
        self,
        *,
        bundle: Path,
        candidate: CandidateManifest,
        config_path: Path,
    ) -> None:
        api_container_id = (
            self._compose(
                bundle=bundle,
                candidate=candidate,
                config_path=config_path,
                arguments=("ps", "--quiet", "api"),
            )
            .stdout.decode()
            .strip()
        )
        _require_match("api container id", api_container_id, _CONTAINER_ID)
        self._validate_api_generation_surface(
            _inspect_one(api_container_id, "API generation surface inspect")
        )

    def _start_codex_agent_host(
        self,
        *,
        bundle: Path,
        candidate: CandidateManifest,
        config_path: Path,
    ) -> None:
        for service in (_CODEX_EGRESS_POLICY, _CODEX_AGENT_HOST):
            self._start_codex_runtime_service(
                bundle=bundle,
                candidate=candidate,
                config_path=config_path,
                service=service,
            )

    def _start_codex_runtime_service(
        self,
        *,
        bundle: Path,
        candidate: CandidateManifest,
        config_path: Path,
        service: str,
    ) -> None:
        if service not in {_CODEX_EGRESS_POLICY, _CODEX_AGENT_HOST}:
            raise ReleaseDefect("unsupported Codex runtime service")
        self._compose(
            bundle=bundle,
            candidate=candidate,
            config_path=config_path,
            arguments=(
                "up",
                "--detach",
                "--no-deps",
                "--wait",
                "--wait-timeout",
                "90",
                service,
            ),
            timeout_seconds=120,
        )

    def _stop_codex_runtime(
        self,
        *,
        bundle: Path,
        candidate: CandidateManifest,
        config_path: Path,
    ) -> None:
        """Stop and re-inspect both credential-runtime containers exactly."""

        services = (_CODEX_AGENT_HOST, _CODEX_EGRESS_POLICY)
        self._compose(
            bundle=bundle,
            candidate=candidate,
            config_path=config_path,
            arguments=(
                "stop",
                "--timeout",
                str(_CODEX_AGENT_STOP_GRACE_SECONDS),
                *services,
            ),
            timeout_seconds=_CODEX_AGENT_STOP_GRACE_SECONDS + 15,
        )
        for service in services:
            observed = (
                self._compose(
                    bundle=bundle,
                    candidate=candidate,
                    config_path=config_path,
                    arguments=("ps", "--all", "--quiet", service),
                )
                .stdout.decode("ascii")
                .strip()
            )
            identifiers = tuple(observed.splitlines()) if observed else ()
            if len(identifiers) > 1 or any(
                _CONTAINER_ID.fullmatch(identifier) is None for identifier in identifiers
            ):
                raise ReleaseDefect(f"{service} stopped-container listing is malformed")
            if identifiers:
                inspected = _inspect_one(identifiers[0], f"{service} stopped inspect")
                state = _mapping(inspected.get("State"), f"{service} stopped state")
                if state.get("Running") is not False:
                    raise ExternalCommandFailed(f"{service} remains running after stop")

    def _prove_codex_agent_host(
        self,
        *,
        bundle: Path,
        candidate: CandidateManifest,
        config_path: Path,
        expected_worker_image_id: str,
    ) -> None:
        """Prove the deployed host can enforce its fixed Linux sandbox.

        This deliberately tests only the container/kernel boundary.  The host's
        own startup probe remains the owner of pinned SDK and ChatGPT-account
        authentication readiness.
        """

        self._require_codex_state_storage()
        self._validate_codex_state_boot_guard()
        self._validate_codex_agent_host_profile(bundle)
        image_environment = self._codex_agent_image_environment(candidate.images.worker)
        image_id = self._container_image_id(
            bundle=bundle,
            candidate=candidate,
            config_path=config_path,
            service=_CODEX_AGENT_HOST,
        )
        if image_id != expected_worker_image_id:
            raise PermanentReleaseFailure(
                "Codex agent host image differs from candidate worker digest"
            )
        container_id = (
            self._compose(
                bundle=bundle,
                candidate=candidate,
                config_path=config_path,
                arguments=("ps", "--quiet", _CODEX_AGENT_HOST),
            )
            .stdout.decode()
            .strip()
        )
        _require_match("Codex agent host container id", container_id, _CONTAINER_ID)
        policy_image_id = self._container_image_id(
            bundle=bundle,
            candidate=candidate,
            config_path=config_path,
            service=_CODEX_EGRESS_POLICY,
        )
        if policy_image_id != expected_worker_image_id:
            raise PermanentReleaseFailure(
                "Codex egress policy image differs from candidate worker digest"
            )
        policy_container_id = (
            self._compose(
                bundle=bundle,
                candidate=candidate,
                config_path=config_path,
                arguments=("ps", "--quiet", _CODEX_EGRESS_POLICY),
            )
            .stdout.decode()
            .strip()
        )
        _require_match("Codex egress policy container id", policy_container_id, _CONTAINER_ID)
        self._validate_codex_agent_host_isolation(
            _inspect_one(container_id, "Codex agent host isolation inspect"),
            image_environment=image_environment,
            expected_mcp_origin=self._codex_mcp_origin(config_path),
        )
        self._validate_codex_egress_policy_isolation(
            _inspect_one(policy_container_id, "Codex egress policy isolation inspect"),
            image_environment=image_environment,
            expected_image_id=expected_worker_image_id,
            expected_mcp_host=self._codex_mcp_host(config_path),
        )
        # The exact writable credential-file bind is attested in the inspected host and
        # `_require_codex_state_storage` immediately below refreshes the host
        # mapper/mount proof after startup.
        self._require_codex_state_storage()
        self._validate_codex_egress_topology(
            host_container_id=container_id,
            policy_container_id=policy_container_id,
        )
        denied_targets = (
            f"{_CODEX_PRIVATE_BRIDGE_IP}:80",
            f"{_CODEX_PRIVATE_BRIDGE_IP}:443",
            f"{self._service_ipv4_address(bundle, candidate, config_path, 'postgres')}:5432",
            f"{self._service_ipv4_address(bundle, candidate, config_path, 'caddy')}:443",
        )
        self._compose(
            bundle=bundle,
            candidate=candidate,
            config_path=config_path,
            arguments=(
                "exec",
                "-T",
                _CODEX_AGENT_HOST,
                "python",
                "-m",
                "apps.codex_agent.network_health",
                "--denied-targets",
                *denied_targets,
            ),
        )
        # Do not exec a credential-bearing process until the just-created
        # container proves its writable credential-file bind and host mapper are exact.
        self._compose(
            bundle=bundle,
            candidate=candidate,
            config_path=config_path,
            arguments=("exec", "-T", _CODEX_AGENT_HOST, *_CODEX_SANDBOX_PROBE),
        )
        result = self._compose(
            bundle=bundle,
            candidate=candidate,
            config_path=config_path,
            arguments=(
                "exec",
                "-T",
                _CODEX_AGENT_HOST,
                "python",
                "-m",
                "apps.codex_agent.health",
            ),
        )
        try:
            health = _mapping(
                _read_json_output(result.stdout, "Codex agent host health"),
                "Codex agent host health",
            )
        except ReleaseDefect as exc:
            raise PermanentReleaseFailure("Codex agent host health contract is malformed") from exc
        if health != {
            "schema_version": "nexus-generation-health.v2",
            "status": "ready",
            "backend": "codex",
            "transport": "sdk",
            "auth_profile": "codex-personal",
            "command_schema_version": "nexus-generation-command.v3",
            "sdk_version": "0.144.4",
            "runtime_version": "0.144.4",
        }:
            raise PermanentReleaseFailure("Codex agent host is not ready with exact auth contract")

    def _prove_codex_mcp_path(
        self,
        *,
        bundle: Path,
        candidate: CandidateManifest,
        config_path: Path,
    ) -> None:
        """Prove the positive DNS/SNI/TLS/Caddy/MCP path after its worker is live."""

        try:
            self._compose(
                bundle=bundle,
                candidate=candidate,
                config_path=config_path,
                arguments=(
                    "exec",
                    "-T",
                    _CODEX_AGENT_HOST,
                    "python",
                    "-m",
                    "apps.codex_agent.network_health",
                    "--mcp-origin",
                    self._codex_mcp_origin(config_path),
                ),
            )
        except ExternalCommandFailed as exc:
            cause = exc.__cause__
            if isinstance(cause, subprocess.CalledProcessError) and isinstance(cause.stderr, bytes):
                for line in cause.stderr.decode("utf-8", errors="replace").splitlines():
                    if re.fullmatch(
                        r"Codex network proof (?:dns|connect-tls|request|response-headers|"
                        r"response-contract|response-body|mcp-origin): "
                        r"(?:gaierror|TimeoutError|ConnectionRefusedError|ConnectionResetError|"
                        r"OSError|SSLError|SSLCertVerificationError|RemoteDisconnected|"
                        r"BadStatusLine|IncompleteRead|HTTPException|RuntimeError|ValueError)",
                        line,
                    ):
                        raise ExternalCommandFailed(line, operation=exc.operation) from exc
            raise

    def _service_ipv4_address(
        self,
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
        inspected = _inspect_one(container_id, f"{service} network inspect")
        settings = _mapping(inspected.get("NetworkSettings"), f"{service} network settings")
        networks = settings.get("Networks")
        if not isinstance(networks, dict) or len(networks) != 1:
            raise PermanentReleaseFailure(f"{service} network attachment differs")
        attachment = next(iter(networks.values()))
        if not isinstance(attachment, dict):
            raise PermanentReleaseFailure(f"{service} network attachment differs")
        address = attachment.get("IPAddress")
        try:
            parsed = ipaddress.IPv4Address(address)
        except (ipaddress.AddressValueError, TypeError) as exc:
            raise PermanentReleaseFailure(f"{service} network address is malformed") from exc
        if not parsed.is_private:
            raise PermanentReleaseFailure(f"{service} network address is not private")
        return str(parsed)

    @staticmethod
    def _validate_api_generation_surface(inspected: dict[str, Any]) -> None:
        config = _mapping(inspected.get("Config"), "API generation config")
        environment = _environment_mapping(
            config.get("Env"),
            "API generation environment",
        )
        if environment.get("NEXUS_CODEX_AGENT_SOCKET") != "/run/nexus-codex/agent.sock":
            raise PermanentReleaseFailure("API generation socket environment differs")
        mounts = inspected.get("Mounts")
        if not isinstance(mounts, list) or len(mounts) != 1:
            raise PermanentReleaseFailure("API generation socket mount differs")
        _require_named_volume_mount(
            mounts[0],
            volume_name=_CODEX_AGENT_VOLUME_MOUNTS["/run/nexus-codex"],
            destination="/run/nexus-codex",
            read_write=False,
            volume_label="API Codex run volume",
            breach=PermanentReleaseFailure,
            failure="API generation socket mount differs",
        )

    @staticmethod
    def _validate_interactive_generation_surface(
        inspected: dict[str, Any], *, expected_mcp_origin: str
    ) -> None:
        config = _mapping(inspected.get("Config"), "interactive worker config")
        environment = _environment_mapping(config.get("Env"), "interactive worker environment")
        if (
            environment.get("WORKER_LANE") != "interactive"
            or environment.get("NEXUS_CODEX_AGENT_SOCKET") != "/run/nexus-codex/agent.sock"
            or environment.get("NEXUS_AGENT_TOOLS_MCP_LISTEN") != "0.0.0.0:8001"
            or environment.get("NEXUS_AGENT_TOOLS_MCP_ORIGIN") != expected_mcp_origin
            or config.get("ExposedPorts") != {"8001/tcp": {}}
        ):
            raise PermanentReleaseFailure("interactive generation surface differs")
        mounts = inspected.get("Mounts")
        if not isinstance(mounts, list):
            raise PermanentReleaseFailure("interactive generation surface mounts are malformed")
        run_mounts = [
            mount
            for mount in mounts
            if isinstance(mount, dict) and mount.get("Destination") == "/run/nexus-codex"
        ]
        if len(run_mounts) != 1:
            raise PermanentReleaseFailure("interactive generation socket mount differs")
        _require_named_volume_mount(
            run_mounts[0],
            volume_name=_CODEX_AGENT_VOLUME_MOUNTS["/run/nexus-codex"],
            destination="/run/nexus-codex",
            read_write=False,
            volume_label="interactive worker Codex run volume",
            breach=PermanentReleaseFailure,
            failure="interactive generation socket mount differs",
        )

    def _codex_agent_image_environment(self, image: str) -> dict[str, str]:
        inspected = _read_json_output(
            _run(("docker", "image", "inspect", image)).stdout,
            "Codex agent worker image inspect",
        )
        if (
            not isinstance(inspected, list)
            or len(inspected) != 1
            or not isinstance(inspected[0], dict)
        ):
            raise ReleaseDefect("Codex agent worker image inspect is malformed")
        config = _mapping(inspected[0].get("Config"), "Codex agent worker image config")
        environment = _environment_mapping(
            config.get("Env"),
            "Codex agent worker image environment",
        )
        if set(environment) != _CODEX_AGENT_IMAGE_ENVIRONMENT_NAMES:
            raise PermanentReleaseFailure("Codex agent worker image environment differs")
        return environment

    def _validate_codex_agent_host_isolation(
        self,
        inspected: dict[str, Any],
        *,
        image_environment: dict[str, str],
        expected_mcp_origin: str,
    ) -> None:
        config = _mapping(inspected.get("Config"), "Codex agent host config")
        host_config = _mapping(inspected.get("HostConfig"), "Codex agent host host config")
        try:
            environment = _environment_mapping(
                config.get("Env"),
                "Codex agent host environment",
            )
        except ReleaseDefect as exc:
            raise PermanentReleaseFailure(
                "Codex agent host environment evidence is malformed"
            ) from exc
        expected_environment = {
            **image_environment,
            **_CODEX_AGENT_RUNTIME_ENVIRONMENT,
            "NEXUS_CODEX_MCP_ORIGIN": expected_mcp_origin,
        }
        if environment != expected_environment:
            raise PermanentReleaseFailure("Codex agent host environment isolation differs")
        security_options = host_config.get("SecurityOpt")
        if not isinstance(security_options, list) or not all(
            isinstance(option, str) for option in security_options
        ):
            raise PermanentReleaseFailure("Codex agent host security-option evidence is malformed")
        if (
            config.get("User") != "10001:10001"
            or config.get("Cmd") != ["python", "-m", "apps.codex_agent.main"]
            or config.get("Entrypoint") not in (None, [])
            or config.get("WorkingDir") != "/tmp"
            or config.get("StopTimeout") != _CODEX_AGENT_STOP_GRACE_SECONDS
            or host_config.get("ReadonlyRootfs") is not True
            or host_config.get("CapDrop") != ["ALL"]
            or host_config.get("CapAdd") not in (None, [])
            or host_config.get("Privileged") is not False
            or host_config.get("Devices") not in (None, [])
            or host_config.get("DeviceRequests") not in (None, [])
            or host_config.get("PidMode") not in ("", "private")
            or host_config.get("IpcMode") not in ("", "private")
            or host_config.get("Init") is not True
            or str(host_config.get("NetworkMode", "")).startswith(("host", "container:"))
            or host_config.get("NanoCpus") != 1_000_000_000
            or len(security_options) != len(_CODEX_AGENT_INSPECT_SECURITY_OPTIONS)
            or set(security_options) != _CODEX_AGENT_INSPECT_SECURITY_OPTIONS
            or host_config.get("MaskedPaths") != []
            or host_config.get("ReadonlyPaths") != []
            or host_config.get("RestartPolicy") != {"MaximumRetryCount": 0, "Name": "no"}
            or host_config.get("Tmpfs") != _CODEX_AGENT_TMPFS
            or host_config.get("Dns") != [_CODEX_EGRESS_PROXY_IP]
            or _ulimit_set(host_config.get("Ulimits")) != _CODEX_AGENT_ULIMITS
        ):
            raise PermanentReleaseFailure("Codex agent host privilege isolation differs")
        self._validate_codex_agent_host_mounts(inspected)
        network = _mapping(inspected.get("NetworkSettings"), "Codex agent host network settings")
        ports = network.get("Ports")
        if ports not in ({}, None):
            raise PermanentReleaseFailure("Codex agent host exposes a public port")
        networks = network.get("Networks")
        if not isinstance(networks, dict) or set(networks) != {_CODEX_PRIVATE_NETWORK}:
            raise PermanentReleaseFailure("Codex agent host network isolation differs")
        private = networks[_CODEX_PRIVATE_NETWORK]
        if not isinstance(private, dict) or private.get("IPAddress") != _CODEX_AGENT_HOST_IP:
            raise PermanentReleaseFailure("Codex agent host network address differs")

    def _validate_codex_egress_policy_isolation(
        self,
        inspected: dict[str, Any],
        *,
        image_environment: dict[str, str],
        expected_image_id: str,
        expected_mcp_host: str,
    ) -> None:
        state = _mapping(inspected.get("State"), "Codex egress policy state")
        health = _mapping(state.get("Health"), "Codex egress policy health")
        if state.get("Running") is not True or health.get("Status") != "healthy":
            raise PermanentReleaseFailure("Codex egress policy is not healthy")
        config = _mapping(inspected.get("Config"), "Codex egress policy config")
        host_config = _mapping(
            inspected.get("HostConfig"),
            "Codex egress policy host config",
        )
        try:
            environment = _environment_mapping(
                config.get("Env"),
                "Codex egress policy environment",
            )
        except ReleaseDefect as exc:
            raise PermanentReleaseFailure(
                "Codex egress policy environment evidence is malformed"
            ) from exc
        if (
            inspected.get("Image") != expected_image_id
            or config.get("User") != "10002:10002"
            or config.get("Cmd") != ["python", "-m", "apps.codex_agent.egress_policy"]
            or config.get("Entrypoint") not in (None, [])
            or environment
            != {
                **image_environment,
                "NEXUS_CODEX_EGRESS_PROXY_IP": _CODEX_EGRESS_PROXY_IP,
                "NEXUS_CODEX_EGRESS_MCP_HOST": expected_mcp_host,
            }
            or host_config.get("ReadonlyRootfs") is not True
            or host_config.get("CapDrop") != ["ALL"]
            or host_config.get("CapAdd") != ["CAP_NET_BIND_SERVICE"]
            or host_config.get("Privileged") is not False
            or host_config.get("Devices") not in (None, [])
            or host_config.get("DeviceRequests") not in (None, [])
            or host_config.get("PidMode") not in ("", "private")
            or host_config.get("IpcMode") not in ("", "private")
            or host_config.get("Init") is not True
            or str(host_config.get("NetworkMode", "")).startswith(("host", "container:"))
            or host_config.get("SecurityOpt") != ["no-new-privileges:true"]
            or host_config.get("RestartPolicy")
            != {"MaximumRetryCount": 0, "Name": "unless-stopped"}
            or host_config.get("Tmpfs") != _CODEX_EGRESS_POLICY_TMPFS
        ):
            raise PermanentReleaseFailure("Codex egress policy isolation differs")
        self._validate_resource_limits(_CODEX_EGRESS_POLICY, inspected)
        mounts = inspected.get("Mounts")
        if mounts != []:
            raise PermanentReleaseFailure("Codex egress policy mounts differ")
        network = _mapping(
            inspected.get("NetworkSettings"),
            "Codex egress policy network settings",
        )
        if network.get("Ports") not in ({}, None):
            raise PermanentReleaseFailure("Codex egress policy exposes a public port")
        networks = network.get("Networks")
        if not isinstance(networks, dict) or set(networks) != {
            _CODEX_PRIVATE_NETWORK,
            _CODEX_PROXY_EGRESS_NETWORK,
        }:
            raise PermanentReleaseFailure("Codex egress policy network isolation differs")
        private = networks[_CODEX_PRIVATE_NETWORK]
        if not isinstance(private, dict) or private.get("IPAddress") != _CODEX_EGRESS_PROXY_IP:
            raise PermanentReleaseFailure("Codex egress policy network address differs")

    @staticmethod
    def _codex_mcp_host(config_path: Path) -> str:
        hostname = _unquote_env(_read_env(config_path).get("CADDY_SITE", ""))
        if (
            _HOST.fullmatch(hostname) is None
            or hostname.endswith(".local")
            or hostname.endswith(".internal")
        ):
            raise PermanentReleaseFailure("Codex MCP origin hostname is not public DNS")
        return hostname

    @classmethod
    def _codex_mcp_origin(cls, config_path: Path) -> str:
        return f"https://{cls._codex_mcp_host(config_path)}/internal/agent-tools/mcp"

    def _validate_codex_agent_host_mounts(self, inspected: dict[str, Any]) -> None:
        mounts = inspected.get("Mounts")
        if not isinstance(mounts, list) or len(mounts) != len(_CODEX_AGENT_VOLUME_MOUNTS) + 1:
            raise PermanentReleaseFailure("Codex agent host mounts differ from isolated contract")
        observed: dict[str, dict[str, Any]] = {}
        for mount in mounts:
            if not isinstance(mount, dict):
                raise PermanentReleaseFailure(
                    "Codex agent host mounts differ from isolated contract"
                )
            destination = mount.get("Destination")
            if not isinstance(destination, str) or destination in observed:
                raise PermanentReleaseFailure(
                    "Codex agent host mounts differ from isolated contract"
                )
            observed[destination] = mount
        credential_destination = "/run/nexus-codex-credential/auth.json"
        if set(observed) != {credential_destination, *_CODEX_AGENT_VOLUME_MOUNTS}:
            raise PermanentReleaseFailure("Codex agent host mounts differ from isolated contract")
        credential_mount = observed[credential_destination]
        if (
            credential_mount.get("Destination") != credential_destination
            or credential_mount.get("Type") != "bind"
            or credential_mount.get("Source") != str(self.paths.codex_enrolled_auth)
            or credential_mount.get("RW") is not True
            or credential_mount.get("Propagation") != "rprivate"
            # Structured Engine mounts report effective writability in `RW`
            # and may leave the user-option string empty. Older daemons can
            # retain an explicit `rw`; admit only those equivalent forms so
            # relabel, consistency, or other mount options still fail closed.
            or credential_mount.get("Mode") not in ("", "rw")
            or set(credential_mount)
            - {"Destination", "Mode", "RW", "Source", "Type", "Propagation"}
        ):
            raise PermanentReleaseFailure("Codex agent host mounts differ from isolated contract")
        for destination, volume_name in _CODEX_AGENT_VOLUME_MOUNTS.items():
            _require_named_volume_mount(
                observed[destination],
                volume_name=volume_name,
                destination=destination,
                read_write=True,
                volume_label=f"Codex agent host volume {volume_name}",
                breach=PermanentReleaseFailure,
                failure="Codex agent host mounts differ from isolated contract",
            )

    def _validate_codex_egress_topology(
        self,
        *,
        host_container_id: str,
        policy_container_id: str,
    ) -> None:
        private = _inspect_network_one(
            _CODEX_PRIVATE_NETWORK,
            "Codex private network inspect",
        )
        private_containers = private.get("Containers")
        private_ipam = private.get("IPAM")
        if (
            private.get("Name") != _CODEX_PRIVATE_NETWORK
            or private.get("Driver") != "bridge"
            or private.get("Scope") != "local"
            or private.get("Internal") is not True
            or private.get("EnableIPv4") is not True
            or private.get("EnableIPv6") is not False
            or private.get("Options") != _CODEX_PRIVATE_NETWORK_OPTIONS
            or not isinstance(private_ipam, dict)
            or private_ipam.get("Driver") != "default"
            or private_ipam.get("Options") not in ({}, None)
            or private_ipam.get("Config") != [{"Subnet": "172.30.0.0/24"}]
            or not isinstance(private_containers, dict)
            or set(private_containers) != {host_container_id, policy_container_id}
        ):
            raise PermanentReleaseFailure("Codex private egress network differs")
        expected_private_addresses = {
            host_container_id: f"{_CODEX_AGENT_HOST_IP}/24",
            policy_container_id: f"{_CODEX_EGRESS_PROXY_IP}/24",
        }
        if any(
            not isinstance(private_containers[container_id], dict)
            or private_containers[container_id].get("IPv4Address") != address
            for container_id, address in expected_private_addresses.items()
        ):
            raise PermanentReleaseFailure("Codex private egress addresses differ")

        public = _inspect_network_one(
            _CODEX_PROXY_EGRESS_NETWORK,
            "Codex policy public network inspect",
        )
        public_containers = public.get("Containers")
        if (
            public.get("Name") != _CODEX_PROXY_EGRESS_NETWORK
            or public.get("Driver") != "bridge"
            or public.get("Scope") != "local"
            or public.get("Internal") is not False
            or public.get("Options") != {}
            or not _is_default_local_bridge_ipam(public.get("IPAM"))
            or not isinstance(public_containers, dict)
            or set(public_containers) != {policy_container_id}
            or not isinstance(public_containers.get(policy_container_id), dict)
        ):
            raise PermanentReleaseFailure("Codex policy public egress network differs")

    def _materialize_codex_capacity_input(
        self,
        *,
        bundle: Path,
        candidate: CandidateManifest,
        config_path: Path,
    ) -> bytes:
        """Ask the candidate runtime to freeze, then independently admit, Dawn facts."""

        result = self._compose(
            bundle=bundle,
            candidate=candidate,
            config_path=config_path,
            arguments=(
                "run",
                "--rm",
                "--no-deps",
                "--entrypoint",
                "python",
                "worker-background",
                "-m",
                "apps.codex_agent.capacity_canary",
                "materialize-input",
            ),
        )
        try:
            return _validated_codex_capacity_input_bytes(result.stdout)
        except ReleaseDefect as exc:
            raise CodexCapacityBreach("Codex capacity input contract differs") from exc

    def _validate_codex_capacity_client_isolation(
        self,
        inspected: dict[str, Any],
        *,
        expected_image: str,
        expected_image_id: str,
        expected_name: str,
        expected_source_sha: str,
        image_environment: dict[str, str],
        expected_input_source: Path,
    ) -> None:
        config = _mapping(inspected.get("Config"), "Codex capacity canary config")
        host_config = _mapping(
            inspected.get("HostConfig"),
            "Codex capacity canary host config",
        )
        state = _mapping(inspected.get("State"), "Codex capacity canary state")
        try:
            environment = _environment_mapping(
                config.get("Env"),
                "Codex capacity canary environment",
            )
        except ReleaseDefect as exc:
            raise CodexCapacityBreach("Codex capacity canary isolation differs") from exc
        labels = config.get("Labels")
        security_options = host_config.get("SecurityOpt")
        if (
            inspected.get("Image") != expected_image_id
            or inspected.get("Name") != f"/{expected_name}"
            or not isinstance(labels, dict)
            or labels.get(_CODEX_CAPACITY_CANARY_LABEL) != expected_source_sha
            or state.get("Running") is not True
            or config.get("Image") != expected_image
            or config.get("User") != "10001:10001"
            or config.get("Entrypoint") != ["sh"]
            or config.get("Cmd") != list(_CODEX_CAPACITY_CLIENT_COMMAND)
            or environment != {**image_environment, **_CODEX_CAPACITY_CLIENT_ENVIRONMENT}
            or host_config.get("NetworkMode") != "none"
            or host_config.get("ReadonlyRootfs") is not True
            or host_config.get("CapDrop") != ["ALL"]
            or host_config.get("NanoCpus") != 1_000_000_000
            or security_options != ["no-new-privileges:true"]
        ):
            raise CodexCapacityBreach("Codex capacity canary isolation differs")
        self._validate_resource_limits(_CODEX_AGENT_HOST, inspected)

        mounts = inspected.get("Mounts")
        if not isinstance(mounts, list) or len(mounts) != 2:
            raise CodexCapacityBreach("Codex capacity canary isolation differs")
        observed = {
            mount.get("Destination"): mount
            for mount in mounts
            if isinstance(mount, dict) and isinstance(mount.get("Destination"), str)
        }
        if set(observed) != {"/run/nexus-codex", _CODEX_CAPACITY_INPUT_CONTAINER_PATH}:
            raise CodexCapacityBreach("Codex capacity canary isolation differs")
        _require_named_volume_mount(
            observed["/run/nexus-codex"],
            volume_name=_CODEX_AGENT_VOLUME_MOUNTS["/run/nexus-codex"],
            destination="/run/nexus-codex",
            read_write=False,
            volume_label="Codex capacity canary run volume",
            breach=CodexCapacityBreach,
            failure="Codex capacity canary isolation differs",
        )
        input_mount = observed[_CODEX_CAPACITY_INPUT_CONTAINER_PATH]
        if (
            input_mount.get("Type") != "bind"
            or input_mount.get("Source") != str(expected_input_source)
            or input_mount.get("Destination") != _CODEX_CAPACITY_INPUT_CONTAINER_PATH
            or input_mount.get("RW") is not False
        ):
            raise CodexCapacityBreach("Codex capacity canary isolation differs")
        network = _mapping(
            inspected.get("NetworkSettings"),
            "Codex capacity canary network settings",
        )
        networks = network.get("Networks")
        if (
            not isinstance(networks, dict)
            or set(networks) != {"none"}
            or not isinstance(networks.get("none"), dict)
            or network.get("Ports") not in ({}, None)
        ):
            raise CodexCapacityBreach("Codex capacity canary isolation differs")

    def _prove_codex_capacity_isolation(
        self,
        *,
        canary: dict[str, Any],
        host_container_id: str,
        policy_container_id: str,
        expected_image: str,
        expected_image_id: str,
        expected_name: str,
        expected_source_sha: str,
        image_environment: dict[str, str],
        expected_input_source: Path,
    ) -> None:
        """Assert live qualification isolation as the §11 policy breach it is.

        Both validators are shared with the ordinary release paths, where an
        isolation or resource-limit difference is a permanent candidate failure
        that measured nothing. Proven here it is the enumerated policy breach and
        must write failed evidence, so this call site converts what they prove
        instead of changing what they mean everywhere else.
        """

        try:
            self._validate_codex_capacity_client_isolation(
                canary,
                expected_image=expected_image,
                expected_image_id=expected_image_id,
                expected_name=expected_name,
                expected_source_sha=expected_source_sha,
                image_environment=image_environment,
                expected_input_source=expected_input_source,
            )
            self._validate_codex_egress_topology(
                host_container_id=host_container_id,
                policy_container_id=policy_container_id,
            )
        except CodexCapacityBreach:
            raise
        except PermanentReleaseFailure as exc:
            raise CodexCapacityBreach(str(exc)) from exc

    def _validate_codex_agent_host_profile(self, bundle: Path) -> None:
        self._require_codex_agent_host_kernel_boundary()
        try:
            metadata = self.paths.codex_apparmor_profile.lstat()
            installed = self.paths.codex_apparmor_profile.read_bytes()
        except OSError as exc:
            raise PermanentReleaseFailure(
                "Codex agent host AppArmor profile is unavailable"
            ) from exc
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != 0
            or metadata.st_gid != 0
            or stat.S_IMODE(metadata.st_mode) != 0o644
            or installed != (bundle / "nexus-codex-agent-host.apparmor").read_bytes()
        ):
            raise PermanentReleaseFailure(
                "Codex agent host AppArmor profile differs from release input"
            )

    def _prepare_codex_agent_host_security(self, bundle: Path) -> None:
        self._require_codex_agent_host_kernel_boundary()
        source = bundle / "nexus-codex-agent-host.apparmor"
        _atomic_bytes(
            self.paths.codex_apparmor_profile,
            source.read_bytes(),
            mode=0o644,
        )
        os.chown(self.paths.codex_apparmor_profile, 0, 0)
        self._validate_codex_agent_host_profile(bundle)
        _run(
            (
                "apparmor_parser",
                "-r",
                str(self.paths.codex_apparmor_profile),
            ),
            timeout_seconds=10,
        )

    def _codex_capacity_evidence_path(self, source_sha: str) -> Path:
        _require_match("Codex capacity source SHA", source_sha, _SHA)
        return self.paths.codex_capacity / f"{source_sha}.json"

    def _qualification_host_sample(self) -> tuple[int, float, float]:
        """Read the three non-content host counters retained by qualification."""

        memory = self._host_memory_bytes()
        reservation_sum = sum(_RESOURCE_LIMITS[service][0] for service in _CAPACITY_SERVICES)
        if (
            memory["MemTotal"] < _MIN_HOST_MEMORY_BYTES
            or memory["MemTotal"] - reservation_sum < _HOST_RESERVED_MEMORY_BYTES
            or memory["SwapTotal"] < _MIN_SWAP_BYTES
        ):
            raise ReleaseBlocked("Codex capacity qualification host envelope is unavailable")
        pressure = self._host_memory_pressure()
        return memory["MemAvailable"], pressure["some"], pressure["full"]

    def _require_qualification_host_sample(self, sample: tuple[int, float, float]) -> None:
        available, some, _full = sample
        if available < _MIN_AVAILABLE_MEMORY_BYTES:
            message = "Codex capacity qualification headroom is below 128 MiB"
        elif some > 10:
            message = "Codex capacity qualification memory pressure exceeds envelope"
        else:
            return
        raise ReleaseBlocked(message)

    def _classify_codex_capacity_startup_failure(
        self,
        *,
        bundle: Path,
        candidate: CandidateManifest,
        config_path: Path,
        expected_worker_image_id: str,
        cause: BaseException,
    ) -> BaseException:
        """Promote only an observed startup cgroup OOM into a capacity breach."""

        try:
            observed = (
                self._compose(
                    bundle=bundle,
                    candidate=candidate,
                    config_path=config_path,
                    arguments=("ps", "--all", "--quiet", _CODEX_AGENT_HOST),
                )
                .stdout.decode("ascii")
                .strip()
            )
            identifiers = tuple(observed.splitlines()) if observed else ()
            if len(identifiers) > 1 or any(
                _CONTAINER_ID.fullmatch(identifier) is None for identifier in identifiers
            ):
                raise ReleaseDefect("Codex capacity startup container listing is malformed")
            if not identifiers:
                return cause
            inspected = _inspect_one(
                identifiers[0],
                "Codex capacity startup host inspect",
            )
            image_id = _require_match(
                "Codex capacity startup host image id",
                inspected.get("Image"),
                _IMAGE_ID,
            )
            if image_id != expected_worker_image_id:
                raise ReleaseDefect("Codex capacity startup host image differs from candidate")
            state = _mapping(
                inspected.get("State"),
                "Codex capacity startup host state",
            )
            oom_killed = state.get("OOMKilled")
            if type(oom_killed) is not bool:
                raise ReleaseDefect("Codex capacity startup OOM evidence is malformed")
        except BaseException as inspection_error:
            cause.add_note(f"Codex capacity startup classification failed: {inspection_error}")
            return cause
        if oom_killed:
            return CodexCapacityBreach(
                "Codex agent host was OOM-killed during capacity qualification startup"
            )
        return cause

    def _codex_capacity_cgroup(self, container_id: str) -> Path:
        """Resolve the host-side cgroup v2 directory of the measured container.

        The measurement must never enter the cgroup it measures: an exec'd
        sampler is charged to the same 448 MiB limit and 64-process budget the
        proof asserts against a 64 MiB margin.
        """

        return self._running_container_cgroup(container_id, _CODEX_AGENT_HOST)

    def _classify_codex_host_cgroup_loss(
        self, container_id: str, cause: ReleaseBlocked
    ) -> ReleaseBlocked | CodexCapacityBreach | ExternalCommandFailed:
        """Decide what an unreadable host cgroup counter measured.

        A container that is still running lost nothing: the read fault is the
        transient it looks like. A container the kernel OOM-killed measured the
        exact §8 breach the proof exists to catch — its cgroup is simply gone —
        and any other exit means the measured host died without a verdict, which
        is retriable and never evidence.
        """

        try:
            state = _mapping(
                _inspect_one(container_id, "Codex capacity host inspect").get("State"),
                "Codex capacity host state",
            )
        except (ReleaseDefect, ExternalCommandFailed):
            return cause
        if state.get("Running") is True:
            return cause
        if state.get("OOMKilled") is True:
            return CodexCapacityBreach(
                "Codex agent host was OOM-killed during capacity qualification"
            )
        return ExternalCommandFailed("Codex agent host exited during capacity qualification")

    def _codex_capacity_cgroup_metrics(self, cgroup: Path) -> tuple[int, int, int, int]:
        resources = self._cgroup_resources(cgroup, _CODEX_AGENT_HOST)
        reservation, memory, pids = _RESOURCE_LIMITS[_CODEX_AGENT_HOST]
        expected = (str(reservation), str(memory), "0", str(pids))
        if resources[:4] != expected or resources[4] != 0:
            raise ReleaseBlocked("Codex capacity host kernel resource contract differs")
        values: dict[str, int] = {"memory.max": memory}
        for counter in ("memory.current", "memory.peak"):
            raw = self._host_text(cgroup / counter, f"Codex capacity {counter}").strip()
            if not raw.isdigit():
                raise ReleaseDefect("Codex capacity cgroup metrics are malformed")
            values[counter] = int(raw)
        for line in self._host_text(
            cgroup / "memory.events",
            "Codex capacity memory events",
        ).splitlines():
            key, separator, raw = line.partition(" ")
            if key != "oom_kill":
                continue
            if not separator or not raw.isdigit() or "oom_kill" in values:
                raise ReleaseDefect("Codex capacity cgroup metrics are malformed")
            values["oom_kill"] = int(raw)
        if set(values) != {"memory.max", "memory.current", "memory.peak", "oom_kill"}:
            raise ReleaseDefect("Codex capacity cgroup metrics are incomplete")
        if (
            values["memory.current"] > values["memory.max"]
            or values["memory.peak"] > values["memory.max"]
        ):
            raise CodexCapacityBreach("Codex capacity cgroup counters exceed memory.max")
        return (
            values["memory.max"],
            values["memory.current"],
            values["memory.peak"],
            values["oom_kill"],
        )

    def _require_codex_capacity_service_health(
        self,
        *,
        bundle: Path,
        candidate: CandidateManifest,
        config_path: Path,
    ) -> tuple[str, ...]:
        def refuse_readiness(service: str) -> None:
            # Service readiness blocks measurement; it is not a measured
            # canary or cgroup breach of the candidate.
            raise ReleaseBlocked(f"Codex capacity {service} is not healthy")

        for service in _CODEX_CAPACITY_SERVICES:
            container_id = (
                self._compose(
                    bundle=bundle,
                    candidate=candidate,
                    config_path=config_path,
                    arguments=("ps", "--all", "--quiet", service),
                )
                .stdout.decode("ascii")
                .strip()
            )
            _require_match(f"Codex capacity {service} container id", container_id, _CONTAINER_ID)
            inspected = _inspect_one(container_id, f"Codex capacity {service} inspect")
            state = _mapping(inspected.get("State"), f"Codex capacity {service} state")
            if state.get("Running") is not True:
                refuse_readiness(service)
            self._validate_running_resource_limits(service, container_id)
            if service == "caddy":
                self._require_caddy_admin_ready(
                    bundle=bundle,
                    candidate=candidate,
                    config_path=config_path,
                    failure="Codex capacity caddy is not healthy",
                )
                continue
            health = state.get("Health")
            if not isinstance(health, dict) or health.get("Status") != "healthy":
                refuse_readiness(service)
        return _CODEX_CAPACITY_SERVICES

    def _require_caddy_admin_ready(
        self,
        *,
        bundle: Path,
        candidate: CandidateManifest,
        config_path: Path,
        failure: str,
    ) -> None:
        """Run the canonical live-process probe owned by Caddy readiness."""

        try:
            self._compose(
                bundle=bundle,
                candidate=candidate,
                config_path=config_path,
                arguments=("exec", "-T", "caddy", *_CADDY_READINESS_COMMAND),
                timeout_seconds=10,
            )
        except ExternalCommandFailed as exc:
            raise ReleaseBlocked(failure) from exc

    def _live_caddy_container_id(
        self,
        *,
        bundle: Path,
        candidate: CandidateManifest,
        config_path: Path,
    ) -> str:
        container_id = (
            self._compose(
                bundle=bundle,
                candidate=candidate,
                config_path=config_path,
                arguments=("ps", "--quiet", "caddy"),
            )
            .stdout.decode("ascii")
            .strip()
        )
        _require_match("live caddy container id", container_id, _CONTAINER_ID)
        inspected = _inspect_one(container_id, "live caddy container inspect")
        state = _mapping(inspected.get("State"), "live caddy container state")
        if state.get("Running") is not True:
            raise ReleaseBlocked("Caddy is not running")
        self._validate_caddy_mount(inspected)
        return container_id

    def _read_caddy_config(self) -> bytes:
        try:
            metadata = self.paths.caddy_config.lstat()
            value = self.paths.caddy_config.read_bytes()
        except OSError as exc:
            raise ReleaseDefect("installed Caddy configuration is unavailable") from exc
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != 0
            or metadata.st_gid != 0
            or stat.S_IMODE(metadata.st_mode) != 0o444
            or not value
            or len(value) > _CADDY_CONFIG_MAX_BYTES
        ):
            raise ReleaseDefect("installed Caddy configuration is not exact immutable input")
        return value

    def _write_caddy_config_in_place(self, value: bytes) -> None:
        """Replace Caddy bytes without changing the bind mount's inode."""

        if not value or len(value) > _CADDY_CONFIG_MAX_BYTES:
            raise ReleaseDefect("candidate Caddy configuration size is invalid")
        path = self.paths.caddy_config
        try:
            before = path.lstat()
            descriptor = os.open(path, os.O_WRONLY | os.O_NOFOLLOW)
        except OSError as exc:
            raise ReleaseDefect("installed Caddy configuration cannot be opened safely") from exc
        try:
            opened = os.fstat(descriptor)
            if (
                not stat.S_ISREG(before.st_mode)
                or (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino)
                or opened.st_uid != 0
                or opened.st_gid != 0
                or stat.S_IMODE(opened.st_mode) != 0o444
            ):
                raise ReleaseDefect("installed Caddy configuration changed before update")
            os.ftruncate(descriptor, 0)
            remaining = memoryview(value)
            while remaining:
                written = os.write(descriptor, remaining)
                if written <= 0:
                    raise OSError("Caddy configuration write made no progress")
                remaining = remaining[written:]
            os.fsync(descriptor)
        except OSError as exc:
            raise ReleaseDefect("installed Caddy configuration update failed") from exc
        finally:
            os.close(descriptor)
        after = path.lstat()
        if (
            (after.st_dev, after.st_ino) != (before.st_dev, before.st_ino)
            or after.st_uid != 0
            or after.st_gid != 0
            or stat.S_IMODE(after.st_mode) != 0o444
            or path.read_bytes() != value
        ):
            raise ReleaseDefect("installed Caddy configuration update was not exact")

    def _load_caddy_activation(self) -> CaddyActivationJournal | None:
        path = self.paths.caddy_activation
        if not path.exists():
            return None
        try:
            metadata = path.lstat()
            value = _read_canonical_json(path, "Caddy activation journal")
        except OSError as exc:
            raise ReleaseDefect("Caddy activation journal is unavailable") from exc
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != 0
            or metadata.st_gid != 0
            or stat.S_IMODE(metadata.st_mode) != 0o400
        ):
            raise ReleaseDefect("Caddy activation journal metadata differs")
        return CaddyActivationJournal.from_json(value)

    def _caddy_activation_backup(self, digest: str) -> Path:
        _require_match("Caddy activation predecessor SHA-256", digest, _SHA256)
        return self.paths.caddy_activation_backups / f"{digest}.Caddyfile"

    def _read_caddy_activation_backup(self, digest: str) -> bytes:
        path = self._caddy_activation_backup(digest)
        try:
            metadata = path.lstat()
            value = path.read_bytes()
        except OSError as exc:
            raise ReleaseDefect("Caddy activation predecessor backup is unavailable") from exc
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != 0
            or metadata.st_gid != 0
            or stat.S_IMODE(metadata.st_mode) != 0o400
            or not value
            or len(value) > _CADDY_CONFIG_MAX_BYTES
            or hashlib.sha256(value).hexdigest() != digest
        ):
            raise ReleaseDefect("Caddy activation predecessor backup differs")
        return value

    def _prepare_caddy_activation(
        self,
        *,
        source_sha: str,
        candidate: bytes,
        predecessor: bytes,
        config_sha256: str,
    ) -> CaddyActivationJournal:
        if self._load_caddy_activation() is not None:
            raise ReleaseDefect("Caddy activation journal was not recovered")
        metadata = self.paths.caddy_config.lstat()
        predecessor_sha256 = hashlib.sha256(predecessor).hexdigest()
        backup = self._caddy_activation_backup(predecessor_sha256)
        if backup.exists():
            self._read_caddy_activation_backup(predecessor_sha256)
        else:
            _create_bytes(backup, predecessor, mode=0o400, owner=(0, 0))
        journal = CaddyActivationJournal(
            schema_version=1,
            source_sha=source_sha,
            candidate_sha256=hashlib.sha256(candidate).hexdigest(),
            predecessor_sha256=predecessor_sha256,
            config_sha256=config_sha256,
            caddy_device=metadata.st_dev,
            caddy_inode=metadata.st_ino,
        )
        _create_bytes(
            self.paths.caddy_activation,
            _canonical_json(journal.as_json()),
            mode=0o400,
            owner=(0, 0),
        )
        return journal

    def _restore_pending_caddy_disk(
        self,
        *,
        source_sha: str,
        candidate: bytes,
        config_sha256: str,
    ) -> tuple[CaddyActivationJournal, bytes] | None:
        journal = self._load_caddy_activation()
        if journal is None:
            return None
        if journal.source_sha != source_sha:
            raise ReleaseBlocked(
                f"Caddy activation for {journal.source_sha} must be recovered first"
            )
        if (
            journal.candidate_sha256 != hashlib.sha256(candidate).hexdigest()
            or journal.config_sha256 != config_sha256
        ):
            raise ReleaseDefect("pending Caddy activation differs from immutable inputs")
        metadata = self.paths.caddy_config.lstat()
        if (metadata.st_dev, metadata.st_ino) != (
            journal.caddy_device,
            journal.caddy_inode,
        ):
            raise ReleaseDefect("Caddy bind inode changed during pending activation")
        predecessor = self._read_caddy_activation_backup(journal.predecessor_sha256)
        self._write_caddy_config_in_place(predecessor)
        return journal, predecessor

    def _clear_caddy_activation(self, journal: CaddyActivationJournal) -> None:
        if self._load_caddy_activation() != journal:
            raise ReleaseDefect("Caddy activation journal changed before completion")
        self.paths.caddy_activation.unlink()
        _fsync_directory(self.paths.caddy_activation.parent)

    def _adapt_caddy_bytes(
        self,
        *,
        bundle: Path,
        candidate: CandidateManifest,
        config_path: Path,
        value: bytes,
    ) -> object:
        try:
            adapted = self._compose(
                bundle=bundle,
                candidate=candidate,
                config_path=config_path,
                arguments=("exec", "-T", "caddy", *_CADDY_ADAPT_STDIN_COMMAND),
                input_bytes=value,
                timeout_seconds=10,
            )
        except ExternalCommandFailed as exc:
            raise ReleaseBlocked("Caddy candidate adaptation is unavailable") from exc
        try:
            return _read_json_output(adapted.stdout, "adapted Caddy config")
        except ReleaseDefect as exc:
            raise PermanentReleaseFailure("adapted Caddy config is malformed") from exc

    def _read_loaded_caddy_config(
        self,
        *,
        bundle: Path,
        candidate: CandidateManifest,
        config_path: Path,
    ) -> object:
        try:
            loaded = self._compose(
                bundle=bundle,
                candidate=candidate,
                config_path=config_path,
                arguments=("exec", "-T", "caddy", *_CADDY_LOADED_CONFIG_COMMAND),
                timeout_seconds=10,
            )
        except ExternalCommandFailed as exc:
            raise ReleaseBlocked("Caddy loaded-config proof is unavailable") from exc
        try:
            return _read_json_output(loaded.stdout, "loaded Caddy config")
        except ReleaseDefect as exc:
            raise PermanentReleaseFailure("Caddy loaded-config proof is malformed") from exc

    def _require_caddy_loaded_config(
        self,
        *,
        bundle: Path,
        candidate: CandidateManifest,
        config_path: Path,
    ) -> None:
        """Prove the live Caddy process loaded the exact installed candidate file."""

        try:
            adapted = self._compose(
                bundle=bundle,
                candidate=candidate,
                config_path=config_path,
                arguments=("exec", "-T", "caddy", *_CADDY_ADAPT_COMMAND),
                timeout_seconds=10,
            )
            loaded = self._compose(
                bundle=bundle,
                candidate=candidate,
                config_path=config_path,
                arguments=("exec", "-T", "caddy", *_CADDY_LOADED_CONFIG_COMMAND),
                timeout_seconds=10,
            )
        except ExternalCommandFailed as exc:
            raise ReleaseBlocked("Caddy loaded-config proof is unavailable") from exc
        try:
            adapted_value = _read_json_output(adapted.stdout, "adapted Caddy config")
            loaded_value = _read_json_output(loaded.stdout, "loaded Caddy config")
        except ReleaseDefect as exc:
            raise PermanentReleaseFailure("Caddy loaded-config proof is malformed") from exc
        if loaded_value != adapted_value:
            raise ReleaseBlocked("Caddy has not loaded the installed candidate config")

    def activate_caddy_config(self, source_sha: str) -> dict[str, str]:
        """Activate one fresh candidate Caddyfile without replacing its bind inode."""

        self.store.assert_no_oracle_attempt()
        self.store.assert_fresh_candidate(source_sha)
        bundle = self.bundle(source_sha)
        candidate = load_candidate_manifest(bundle / "candidate-manifest.json")
        config = self._config_snapshot()
        current_sha = self.store.require_current_record().source_sha
        self._compose(
            bundle=bundle,
            candidate=candidate,
            config_path=config.path,
            arguments=("config", "--quiet"),
        )
        desired = (bundle / "Caddyfile").read_bytes()
        if not desired or len(desired) > _CADDY_CONFIG_MAX_BYTES:
            raise ReleaseDefect("candidate Caddy configuration size is invalid")
        pending = self._restore_pending_caddy_disk(
            source_sha=source_sha,
            candidate=desired,
            config_sha256=config.sha256,
        )
        container_id = self._live_caddy_container_id(
            bundle=bundle,
            candidate=candidate,
            config_path=config.path,
        )
        self._require_caddy_admin_ready(
            bundle=bundle,
            candidate=candidate,
            config_path=config.path,
            failure="Caddy is not ready for configuration activation",
        )
        if pending is not None:
            pending_journal, predecessor = pending
            adapted_predecessor = self._adapt_caddy_bytes(
                bundle=bundle,
                candidate=candidate,
                config_path=config.path,
                value=predecessor,
            )
            self._compose(
                bundle=bundle,
                candidate=candidate,
                config_path=config.path,
                arguments=("exec", "-T", "caddy", *_CADDY_VALIDATE_COMMAND),
                timeout_seconds=10,
            )
            self._compose(
                bundle=bundle,
                candidate=candidate,
                config_path=config.path,
                arguments=("exec", "-T", "caddy", *_CADDY_RELOAD_COMMAND),
                timeout_seconds=10,
            )
            if (
                self._read_loaded_caddy_config(
                    bundle=bundle,
                    candidate=candidate,
                    config_path=config.path,
                )
                != adapted_predecessor
            ):
                raise ReleaseDefect("recovered Caddy predecessor did not become live")
            self._clear_caddy_activation(pending_journal)
        self.verify_current(current_sha)
        installed = self._read_caddy_config()
        adapted_installed = self._adapt_caddy_bytes(
            bundle=bundle,
            candidate=candidate,
            config_path=config.path,
            value=installed,
        )
        adapted_desired = self._adapt_caddy_bytes(
            bundle=bundle,
            candidate=candidate,
            config_path=config.path,
            value=desired,
        )
        loaded = self._read_loaded_caddy_config(
            bundle=bundle,
            candidate=candidate,
            config_path=config.path,
        )
        if installed != desired and loaded != adapted_installed:
            raise ReleaseBlocked("Caddy loaded config differs from the installed predecessor")

        mutated = installed != desired
        journal = (
            self._prepare_caddy_activation(
                source_sha=source_sha,
                candidate=desired,
                predecessor=installed,
                config_sha256=config.sha256,
            )
            if mutated
            else None
        )
        try:
            if mutated:
                self._write_caddy_config_in_place(desired)
            self._compose(
                bundle=bundle,
                candidate=candidate,
                config_path=config.path,
                arguments=("exec", "-T", "caddy", *_CADDY_VALIDATE_COMMAND),
                timeout_seconds=10,
            )
            self._compose(
                bundle=bundle,
                candidate=candidate,
                config_path=config.path,
                arguments=("exec", "-T", "caddy", *_CADDY_RELOAD_COMMAND),
                timeout_seconds=10,
            )
            reloaded_container_id = self._live_caddy_container_id(
                bundle=bundle,
                candidate=candidate,
                config_path=config.path,
            )
            if reloaded_container_id != container_id:
                raise PermanentReleaseFailure(
                    "Caddy container changed during in-place configuration activation"
                )
            if (
                self._read_loaded_caddy_config(
                    bundle=bundle,
                    candidate=candidate,
                    config_path=config.path,
                )
                != adapted_desired
            ):
                raise ReleaseBlocked("Caddy did not load the exact candidate config")
            self.verify_current(current_sha)
        except BaseException as activation_error:
            if mutated:
                try:
                    self._write_caddy_config_in_place(installed)
                    self._compose(
                        bundle=bundle,
                        candidate=candidate,
                        config_path=config.path,
                        arguments=("exec", "-T", "caddy", *_CADDY_VALIDATE_COMMAND),
                        timeout_seconds=10,
                    )
                    self._compose(
                        bundle=bundle,
                        candidate=candidate,
                        config_path=config.path,
                        arguments=("exec", "-T", "caddy", *_CADDY_RELOAD_COMMAND),
                        timeout_seconds=10,
                    )
                    if (
                        self._live_caddy_container_id(
                            bundle=bundle,
                            candidate=candidate,
                            config_path=config.path,
                        )
                        != container_id
                        or self._read_loaded_caddy_config(
                            bundle=bundle,
                            candidate=candidate,
                            config_path=config.path,
                        )
                        != adapted_installed
                    ):
                        raise ReleaseDefect("Caddy rollback proof differs")
                    if journal is None:
                        raise ReleaseDefect("mutated Caddy activation omitted its journal")
                    self._clear_caddy_activation(journal)
                except BaseException as rollback_error:
                    failure = ReleaseDefect(
                        "Caddy activation failed and exact in-place rollback failed"
                    )
                    failure.add_note(f"activation failure: {activation_error}")
                    raise failure from rollback_error
            raise

        if journal is not None:
            self._clear_caddy_activation(journal)

        return {
            "caddy_config_sha256": hashlib.sha256(desired).hexdigest(),
            "caddy_container_id": container_id,
            "source_sha": source_sha,
            "status": "active",
        }

    def _read_codex_capacity_qualification(
        self,
        *,
        candidate: CandidateManifest,
        worker_image_id: str,
    ) -> None:
        path = self._codex_capacity_evidence_path(candidate.source_sha)
        value = self._load_codex_capacity_evidence(path)
        measured_at = self._read_codex_capacity_evidence_value(
            value,
            expected_source_sha=candidate.source_sha,
            worker_image_id=worker_image_id,
        )
        # Qualification measured a live host, not only a candidate. Past the
        # bounded age the measurement no longer describes the host this
        # promotion would run on, even for the identical candidate. Expiry is
        # not a breach: like absent evidence it blocks this promotion and is
        # cured by re-qualifying the unchanged SHA, so it must never terminalize
        # the candidate.
        if _codex_capacity_evidence_expired(measured_at, now=time.time()):
            raise ReleaseBlocked("Codex capacity qualification is stale")

    def _load_codex_capacity_evidence(self, path: Path) -> object:
        """Read one exact immutable evidence file before making a decision from it."""

        try:
            metadata = path.lstat()
            value = _read_canonical_json(path, "Codex capacity qualification")
        except OSError as exc:
            raise ReleaseBlocked("Codex capacity qualification is absent") from exc
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != 0
            or metadata.st_gid != 0
            or stat.S_IMODE(metadata.st_mode) != 0o444
        ):
            raise PermanentReleaseFailure(
                "Codex capacity qualification is not root-owned immutable"
            )
        return value

    def _read_codex_capacity_evidence_value(
        self,
        value: object,
        *,
        expected_source_sha: str,
        worker_image_id: str,
    ) -> float:
        """Validate one capacity evidence value and return when it was measured."""

        evidence = _closed_mapping(
            value, _CODEX_CAPACITY_EVIDENCE_FIELDS, "Codex capacity qualification"
        )
        if (
            _string(evidence, "schema_version") != _CODEX_CAPACITY_SCHEMA_VERSION
            or _string(evidence, "source_sha") != expected_source_sha
            or _string(evidence, "worker_image_id") != worker_image_id
            or _string(evidence, "status") != "passed"
        ):
            raise CodexCapacityBreach("Codex capacity qualification differs from candidate")
        if (
            _nonnegative_integer(evidence, "cgroup_memory_max")
            != _RESOURCE_LIMITS[_CODEX_AGENT_HOST][1]
        ):
            raise CodexCapacityBreach("Codex capacity qualification cgroup limit differs")
        peak = _nonnegative_integer(evidence, "cgroup_memory_peak")
        if peak > _CODEX_AGENT_MEMORY_PEAK_LIMIT_BYTES:
            raise CodexCapacityBreach("Codex capacity qualification cgroup peak exceeds 384 MiB")
        if (
            _nonnegative_integer(evidence, "cgroup_memory_current")
            > _RESOURCE_LIMITS[_CODEX_AGENT_HOST][1]
        ):
            raise CodexCapacityBreach("Codex capacity qualification cgroup current exceeds limit")
        if _nonnegative_integer(evidence, "oom_kill_delta") != 0:
            raise CodexCapacityBreach("Codex capacity qualification observed an OOM kill")
        turns = evidence.get("turns")
        if not isinstance(turns, list) or len(turns) != len(_CODEX_CAPACITY_PHASES):
            raise CodexCapacityBreach("Codex capacity qualification turns are malformed")
        phases: list[str] = []
        fingerprints: list[str] = []
        for value in turns:
            turn = _closed_mapping(
                value, _CODEX_CAPACITY_TURN_FIELDS, "Codex capacity qualification turn"
            )
            phase = _string(turn, "phase")
            phases.append(phase)
            fingerprint = _string(turn, "generation_spec_fingerprint")
            fingerprints.append(fingerprint)
            if (
                _string(turn, "operation") != "dawn_write"
                or _SHA256.fullmatch(fingerprint) is None
                or _string(turn, "model") != "gpt-5.6-terra"
                or _string(turn, "reasoning") != "medium"
                or _string(turn, "terminal_status") != "succeeded"
                or turn.get("failure_kind") is not None
                or _boolean(turn, "usage_present") is not True
                or not _string(turn, "sdk_version")
                or not _string(turn, "runtime_version")
                or _nonnegative_integer(turn, "tool_event_count") != 0
                or _nonnegative_integer(turn, "permission_event_count") != 0
            ):
                raise CodexCapacityBreach("Codex capacity qualification turn differs")
        if tuple(phases) != _CODEX_CAPACITY_PHASES:
            raise CodexCapacityBreach("Codex capacity qualification turn phases differ")
        if len(set(fingerprints)) != 1:
            raise CodexCapacityBreach("Codex capacity qualification spec identity differs")
        services = _string_list(evidence.get("services"), "Codex capacity qualification services")
        if tuple(services) != _CODEX_CAPACITY_SERVICES:
            raise CodexCapacityBreach("Codex capacity qualification service health differs")
        if _nonnegative_integer(evidence, "minimum_mem_available") < _MIN_AVAILABLE_MEMORY_BYTES:
            raise ReleaseBlocked("Codex capacity qualification host headroom is below 128 MiB")
        some = _finite_number(evidence, "maximum_memory_psi_some")
        _finite_number(evidence, "maximum_memory_psi_full")
        if some > 10:
            raise ReleaseBlocked("Codex capacity qualification memory pressure exceeds envelope")
        return _release_timestamp_seconds(
            _string(evidence, "measured_at"),
            "Codex capacity qualification",
        )

    def _read_codex_capacity_failure_value(
        self,
        value: object,
        *,
        expected_source_sha: str,
        worker_image_id: str,
    ) -> float:
        """Validate the exact permanent-failure evidence shape."""

        evidence = _closed_mapping(
            value, _CODEX_CAPACITY_EVIDENCE_FIELDS, "Codex capacity qualification"
        )
        if (
            _string(evidence, "schema_version") != _CODEX_CAPACITY_SCHEMA_VERSION
            or _string(evidence, "source_sha") != expected_source_sha
            or _string(evidence, "worker_image_id") != worker_image_id
            or _string(evidence, "status") != "failed"
        ):
            raise CodexCapacityBreach("Codex capacity qualification differs from candidate")
        if (
            evidence.get("turns") != []
            or _nonnegative_integer(evidence, "cgroup_memory_max")
            != _RESOURCE_LIMITS[_CODEX_AGENT_HOST][1]
            or _nonnegative_integer(evidence, "cgroup_memory_current") != 0
            or _nonnegative_integer(evidence, "cgroup_memory_peak") != 0
            or _nonnegative_integer(evidence, "minimum_mem_available") != 0
            or _finite_number(evidence, "maximum_memory_psi_some") != 0
            or _finite_number(evidence, "maximum_memory_psi_full") != 0
            or _nonnegative_integer(evidence, "oom_kill_delta") != 0
            or evidence.get("services") != []
        ):
            raise CodexCapacityBreach("Codex capacity failed evidence is malformed")
        return _release_timestamp_seconds(
            _string(evidence, "measured_at"),
            "Codex capacity qualification",
        )

    def _read_existing_codex_capacity_evidence(
        self,
        value: object,
        *,
        expected_source_sha: str,
        worker_image_id: str,
    ) -> tuple[str, float]:
        evidence = _mapping(value, "Codex capacity qualification")
        status = _string(evidence, "status")
        if status == "passed":
            measured_at = self._read_codex_capacity_evidence_value(
                value,
                expected_source_sha=expected_source_sha,
                worker_image_id=worker_image_id,
            )
        elif status == "failed":
            measured_at = self._read_codex_capacity_failure_value(
                value,
                expected_source_sha=expected_source_sha,
                worker_image_id=worker_image_id,
            )
        else:
            raise CodexCapacityBreach("Codex capacity qualification status is malformed")
        return status, measured_at

    def _admit_codex_capacity_qualification(
        self,
        *,
        source_sha: str,
        worker_image_id: str,
    ) -> None:
        """Fail before runtime mutation when immutable evidence already decides the SHA."""

        path = self._codex_capacity_evidence_path(source_sha)
        if not path.exists() and not path.is_symlink():
            return
        status, measured_at = self._read_existing_codex_capacity_evidence(
            self._load_codex_capacity_evidence(path),
            expected_source_sha=source_sha,
            worker_image_id=worker_image_id,
        )
        if status == "failed":
            raise ReleaseBlocked("Codex capacity qualification failed evidence is immutable")
        if not _codex_capacity_evidence_expired(measured_at, now=time.time()):
            raise ReleaseBlocked("Codex capacity qualification evidence already exists")

    def _write_codex_capacity_evidence(
        self,
        source_sha: str,
        worker_image_id: str,
        value: dict[str, object],
    ) -> None:
        path = self._codex_capacity_evidence_path(source_sha)
        if path.exists() or path.is_symlink():
            self._require_replaceable_codex_capacity_evidence(
                path,
                source_sha=source_sha,
                worker_image_id=worker_image_id,
            )
            _atomic_bytes(path, _canonical_json(value), mode=0o444)
        else:
            _create_bytes(path, _canonical_json(value), mode=0o444)
        os.chown(path, 0, 0)
        path.chmod(0o444)

    def _require_replaceable_codex_capacity_evidence(
        self,
        path: Path,
        *,
        source_sha: str,
        worker_image_id: str,
    ) -> None:
        """Allow a rerun to replace only an expired passing measurement.

        §11 makes a measured breach permanent: rerunning can never replace failed
        evidence, and a complete fresh pass is equally final. A passing
        measurement is bounded by its age instead, so once it can no longer
        authorize the promotion the unchanged SHA must be able to earn a new
        measurement — otherwise expiry, not a breach, would disqualify the
        candidate forever.
        """

        status, measured_at = self._read_existing_codex_capacity_evidence(
            self._load_codex_capacity_evidence(path),
            expected_source_sha=source_sha,
            worker_image_id=worker_image_id,
        )
        if status == "failed":
            raise ReleaseBlocked("Codex capacity qualification failed evidence is immutable")
        if not _codex_capacity_evidence_expired(measured_at, now=time.time()):
            raise ReleaseBlocked("Codex capacity qualification evidence already exists")

    def _write_codex_capacity_failure(self, *, source_sha: str, worker_image_id: str) -> None:
        self._write_codex_capacity_evidence(
            source_sha,
            worker_image_id,
            {
                "schema_version": _CODEX_CAPACITY_SCHEMA_VERSION,
                "source_sha": source_sha,
                "worker_image_id": worker_image_id,
                "status": "failed",
                "measured_at": _now(),
                "turns": [],
                "cgroup_memory_max": _RESOURCE_LIMITS[_CODEX_AGENT_HOST][1],
                "cgroup_memory_current": 0,
                "cgroup_memory_peak": 0,
                "minimum_mem_available": 0,
                "maximum_memory_psi_some": 0.0,
                "maximum_memory_psi_full": 0.0,
                "oom_kill_delta": 0,
                "services": [],
            },
        )

    def _record_codex_capacity_breach(
        self,
        *,
        source_sha: str,
        worker_image_id: str,
        breach: CodexCapacityBreach,
    ) -> BaseException:
        try:
            self._write_codex_capacity_failure(
                source_sha=source_sha,
                worker_image_id=worker_image_id,
            )
        except BaseException as evidence_error:
            unrecorded = ReleaseDefect(
                "Codex capacity breach could not be recorded as immutable evidence"
            )
            unrecorded.add_note(f"unrecorded Codex capacity breach: {breach}")
            unrecorded.__cause__ = evidence_error
            return unrecorded
        return breach

    def _codex_capacity_canary_ids(self, name: str) -> tuple[str, ...]:
        observed = _stdout(
            (
                "docker",
                "ps",
                "--all",
                "--quiet",
                "--filter",
                f"name=^/{name}$",
            )
        )
        identifiers = tuple(observed.splitlines()) if observed else ()
        if any(_CONTAINER_ID.fullmatch(identifier) is None for identifier in identifiers):
            raise ReleaseDefect("Codex capacity canary listing is malformed")
        return identifiers

    def _remove_owned_codex_capacity_canary(
        self,
        name: str,
        *,
        source_sha: str,
        operation: str,
    ) -> None:
        """Remove only exact inspected containers owned by this qualification."""

        for canary_id in self._codex_capacity_canary_ids(name):
            inspected = _inspect_one(canary_id, f"Codex capacity canary {operation} inspect")
            config = _mapping(
                inspected.get("Config"),
                f"Codex capacity canary {operation} config",
            )
            labels = config.get("Labels")
            if (
                inspected.get("Name") != f"/{name}"
                or not isinstance(labels, dict)
                or labels.get(_CODEX_CAPACITY_CANARY_LABEL) != source_sha
            ):
                raise ReleaseBlocked("Codex capacity canary name is held by a foreign container")
            # Delete by the inspected immutable ID, never the reusable name. If
            # the inspected container disappears and another process wins the
            # name before this call, Docker can only reject the stale ID; it
            # cannot redirect deletion onto the replacement.
            _run(("docker", "rm", "--force", canary_id), timeout_seconds=30)
        if self._codex_capacity_canary_ids(name):
            raise ExternalCommandFailed(f"Codex capacity canary remains after {operation}")

    def _reclaim_codex_capacity_canary(self, name: str, *, source_sha: str) -> None:
        """Remove an owned canary left behind by an interrupted same-SHA proof."""

        self._remove_owned_codex_capacity_canary(
            name,
            source_sha=source_sha,
            operation="reclaim",
        )

    def _cleanup_codex_capacity_runtime(
        self,
        *,
        bundle: Path,
        candidate: CandidateManifest,
        config_path: Path,
        canary_name: str | None,
        stop_host: bool,
    ) -> tuple[BaseException, ...]:
        failures: list[BaseException] = []
        if canary_name is not None:
            try:
                self._remove_owned_codex_capacity_canary(
                    canary_name,
                    source_sha=candidate.source_sha,
                    operation="removal",
                )
            except BaseException as exc:
                failures.append(exc)
        if stop_host:
            try:
                self._stop_codex_runtime(
                    bundle=bundle,
                    candidate=candidate,
                    config_path=config_path,
                )
            except BaseException as exc:
                failures.append(exc)
        return tuple(failures)

    def _requires_first_codex_capacity_qualification(
        self, candidate: CandidateManifest, *, existing: ReleaseAttempt | None = None
    ) -> bool:
        predecessor = (
            self.store.require_current_record()
            if existing is None or existing.predecessor_sha is None
            else self.store.load_record(existing.predecessor_sha)
        )
        if predecessor is None:
            raise ReleaseDefect("capacity qualification predecessor record is absent")
        if re.fullmatch(r"[0-9]+", predecessor.database_revision) is None:
            raise ReleaseDefect("predecessor database revision is not numeric")
        candidate_revision = candidate.expected_database_revision
        if re.fullmatch(r"[0-9]+", candidate_revision) is None:
            raise ReleaseDefect("candidate database revision is not numeric")
        return (
            _requires_codex_agent_host(candidate)
            and int(candidate_revision) >= _CODEX_PERSONAL_GENERATION_REVISION
            and int(predecessor.database_revision) < _CODEX_PERSONAL_GENERATION_REVISION
        )

    def _require_first_codex_capacity_qualification(
        self,
        source_sha: str,
        *,
        existing: ReleaseAttempt | None,
        qualify_active: bool = False,
    ) -> None:
        bundle = self.bundle(source_sha)
        candidate = load_candidate_manifest(bundle / "candidate-manifest.json")
        if self._requires_first_codex_capacity_qualification(candidate, existing=existing):
            # A durable attempt already pins the candidate image identity. On
            # replay, re-read the immutable evidence against that durable fact
            # without another Docker observation or a new kill point.
            worker_image_id = (
                existing.candidate_worker_image_id
                if existing is not None
                else self._image_identity(candidate.images.worker, candidate)
            )
            try:
                self._read_codex_capacity_qualification(
                    candidate=candidate,
                    worker_image_id=worker_image_id,
                )
            except ReleaseBlocked:
                if not qualify_active or existing is None:
                    raise
                self.qualify_codex_capacity(source_sha, activated_attempt=existing)
                self._read_codex_capacity_qualification(
                    candidate=candidate,
                    worker_image_id=worker_image_id,
                )

    def qualify_codex_capacity(
        self, source_sha: str, *, activated_attempt: ReleaseAttempt | None = None
    ) -> None:
        """Run the one pre-promotion, candidate-bound existing-VPS qualification.

        Classification is the run's product. A breach proven by the canary
        contract, the exact host's startup cgroup observations, the isolation
        policy, the background sampler, or the assembled evidence
        writes immutable failed evidence and disqualifies this source SHA forever. Only stdout that
        parses as the canary's own evidence contract can prove an in-canary
        breach. Everything that measured nothing about the envelope stays
        retriable and writes nothing: host headroom/pressure, Docker, transport, cleanup, a sampler
        fault, or a canary that crashed before stating a contract terminal. A
        rerun may replace only expired passing evidence, never failed evidence.
        """

        self.store.assert_no_oracle_attempt()
        self.store.assert_candidate_admissible(source_sha)
        bundle = self.bundle(source_sha)
        candidate = load_candidate_manifest(bundle / "candidate-manifest.json")
        if not self._requires_first_codex_capacity_qualification(
            candidate, existing=activated_attempt
        ):
            raise ReleaseBlocked("Codex capacity qualification is only for first 0224 promotion")
        self._require_codex_isolated_gateway_support()
        if activated_attempt is None:
            if self.store.forward_fix_sha() is not None:
                raise ReleaseBlocked("forward-fix capacity qualification is owned by release apply")
            worker_image_id = self._image_identity(candidate.images.worker, candidate)
        else:
            if (
                activated_attempt.source_sha != source_sha
                or self.store.load_attempt(source_sha) != activated_attempt
                or activated_attempt.phase
                not in {
                    ReleasePhase.BackendActivationStarted,
                    ReleasePhase.AwaitingFrontendPromotion,
                    ReleasePhase.FrontendPromoted,
                }
                or activated_attempt.forward_fix_of != self.store.forward_fix_sha()
            ):
                raise ReleaseDefect("active capacity qualification has no bound release attempt")
            current = self.store.require_current_record()
            if current.source_sha != activated_attempt.predecessor_sha and (
                activated_attempt.phase is not ReleasePhase.FrontendPromoted
                or current.source_sha != source_sha
                or current
                != ReleaseRecord.from_attempt(
                    attempt=activated_attempt,
                    candidate=candidate,
                    api_image_id=activated_attempt.candidate_api_image_id,
                    worker_image_id=activated_attempt.candidate_worker_image_id,
                    verified_at=current.verified_at,
                )
            ):
                raise ReleaseDefect("active capacity qualification current record differs")
            self._validate_release_inputs(
                bundle=bundle, candidate=candidate, attempt=activated_attempt
            )
            worker_image_id = activated_attempt.candidate_worker_image_id
        self._admit_codex_capacity_qualification(
            source_sha=source_sha,
            worker_image_id=worker_image_id,
        )
        # Capacity is candidate evidence only after the exact predecessor is
        # inside the kernel-enforced envelope. Docker metadata alone is not an
        # enforcement fact, and retained pre-contract swap invalidates the
        # baseline even after memory.swap.max is corrected.
        if activated_attempt is None:
            self._converge_resource_limits(source_sha)
        config_path = (
            self._config_snapshot().path
            if activated_attempt is None
            else Path(activated_attempt.config_path)
        )
        host_samples: list[tuple[int, float, float]] = []
        if activated_attempt is None:
            initial_host_sample = self._qualification_host_sample()
            self._require_qualification_host_sample(initial_host_sample)
            host_samples.append(initial_host_sample)
        cgroup_samples: list[tuple[int, int, int, int]] = []
        sampled_host_ids: list[str] = []
        sampled_host_cgroups: list[Path] = []
        sample_failure: list[Exception] = []
        sample_breach: list[CodexCapacityBreach] = []
        sample_lock = threading.Lock()
        sampler_stop = threading.Event()

        def sample_once(*, require_container: bool = False) -> None:
            """Measure host pressure and the exact candidate cgroup from process start."""

            with sample_lock:
                if sampled_host_ids:
                    # The container id and its cgroup path are immutable for the
                    # lifetime being measured. Re-querying Docker here adds no
                    # identity proof, creates observer load during the canary,
                    # and can race daemon state transitions. A missing cgroup is
                    # classified through Docker below because that is the one
                    # point where retained kernel counters can no longer speak.
                    container_id = sampled_host_ids[0]
                else:
                    observed = (
                        self._compose(
                            bundle=bundle,
                            candidate=candidate,
                            config_path=config_path,
                            arguments=("ps", "--all", "--quiet", _CODEX_AGENT_HOST),
                        )
                        .stdout.decode("ascii")
                        .strip()
                    )
                    identifiers = tuple(observed.splitlines()) if observed else ()
                    if len(identifiers) > 1 or any(
                        _CONTAINER_ID.fullmatch(identifier) is None for identifier in identifiers
                    ):
                        raise ReleaseDefect("Codex capacity sampled host listing is malformed")
                    if not identifiers:
                        if require_container:
                            raise ReleaseDefect("Codex capacity sampled host is absent")
                        return

                    container_id = identifiers[0]
                    inspected = _inspect_one(container_id, "Codex capacity sampled host inspect")
                    state = _mapping(inspected.get("State"), "Codex capacity sampled host state")
                    if state.get("Running") is not True and not require_container:
                        return
                    image_id = _require_match(
                        "Codex capacity sampled host image id",
                        inspected.get("Image"),
                        _IMAGE_ID,
                    )
                    if image_id != worker_image_id:
                        raise ReleaseDefect("Codex capacity sampled host differs from candidate")
                    if state.get("OOMKilled") is True:
                        raise CodexCapacityBreach(
                            "Codex agent host was OOM-killed during capacity qualification"
                        )
                    if state.get("Running") is not True:
                        raise ExternalCommandFailed("Codex capacity sampled host is not running")
                    cgroup = self._codex_capacity_cgroup(container_id)
                    sampled_host_ids.append(container_id)
                    sampled_host_cgroups.append(cgroup)

                try:
                    metrics = self._codex_capacity_cgroup_metrics(sampled_host_cgroups[0])
                except ReleaseBlocked as exc:
                    raise self._classify_codex_host_cgroup_loss(container_id, exc) from exc
                cgroup_samples.append(metrics)
                if (
                    metrics[0] != _RESOURCE_LIMITS[_CODEX_AGENT_HOST][1]
                    or metrics[2] > _CODEX_AGENT_MEMORY_PEAK_LIMIT_BYTES
                    or metrics[3] != 0
                ):
                    raise CodexCapacityBreach(
                        "Codex capacity qualification cgroup envelope differs"
                    )
                host_sample = self._qualification_host_sample()
                host_samples.append(host_sample)

        def sample_runtime() -> None:
            # justify-polling: host and cgroup counters expose no event source.
            while not sampler_stop.wait(_CODEX_CAPACITY_SAMPLE_INTERVAL_SECONDS):
                try:
                    sample_once()
                except CodexCapacityBreach as exc:
                    sample_breach.append(exc)
                    sampler_stop.set()
                except ReleaseBlocked as exc:
                    # Keep watching the cgroup after a transient observation failure.
                    if not sample_failure:
                        sample_failure.append(exc)
                except Exception as exc:
                    sample_failure.append(exc)
                    sampler_stop.set()

        sampler = threading.Thread(target=sample_runtime, daemon=True)

        def stop_sampler() -> None:
            sampler_stop.set()
            sampler.join(timeout=_CODEX_CAPACITY_SAMPLER_JOIN_SECONDS)
            if not sampler.is_alive():
                # Teardown must not erase a breach after an earlier read failure.
                try:
                    sample_once(require_container=True)
                except CodexCapacityBreach as exc:
                    sample_breach.append(exc)
                except Exception as exc:
                    sample_failure.append(exc)

        host_may_be_started = False
        sampler_started = False
        try:
            # Credential storage is operator-provisioned. Prove the LUKS2 ->
            # mapper -> ext4 chain and the locked-boot guard before starting
            # the host. The exact writable file bind is attested immediately after
            # Docker creates the container and before any controller-owned exec.
            self._require_codex_state_storage()
            self._validate_codex_state_boot_guard()
            if activated_attempt is None:
                self._preflight_codex_agent_host_security(bundle)
                self._prepare_codex_agent_host_security(bundle)
                self._start_codex_runtime_service(
                    bundle=bundle,
                    candidate=candidate,
                    config_path=config_path,
                    service=_CODEX_EGRESS_POLICY,
                )
            # A reused active host retains its bootstrap peak/OOM counters.
            # Sample those before applying the volatile host-pressure gate.
            # Standalone qualification observes before Docker starts the host.
            sampler.start()
            sampler_started = True
            # Host `up --wait` can fail after creating the container, so cleanup
            # and OOM classification must not depend on a completed response.
            if activated_attempt is None:
                host_may_be_started = True
                try:
                    self._start_codex_runtime_service(
                        bundle=bundle,
                        candidate=candidate,
                        config_path=config_path,
                        service=_CODEX_AGENT_HOST,
                    )
                except BaseException as exc:
                    classified = self._classify_codex_capacity_startup_failure(
                        bundle=bundle,
                        candidate=candidate,
                        config_path=config_path,
                        expected_worker_image_id=worker_image_id,
                        cause=exc,
                    )
                    if classified is exc:
                        raise
                    raise classified from exc
            self._prove_codex_agent_host(
                bundle=bundle,
                candidate=candidate,
                config_path=config_path,
                expected_worker_image_id=worker_image_id,
            )
            host_container_id = (
                self._compose(
                    bundle=bundle,
                    candidate=candidate,
                    config_path=config_path,
                    arguments=("ps", "--quiet", _CODEX_AGENT_HOST),
                )
                .stdout.decode("ascii")
                .strip()
            )
            _require_match("Codex capacity host container id", host_container_id, _CONTAINER_ID)
            policy_container_id = (
                self._compose(
                    bundle=bundle,
                    candidate=candidate,
                    config_path=config_path,
                    arguments=("ps", "--quiet", _CODEX_EGRESS_POLICY),
                )
                .stdout.decode("ascii")
                .strip()
            )
            _require_match(
                "Codex capacity egress policy container id",
                policy_container_id,
                _CONTAINER_ID,
            )
            if sample_breach:
                raise sample_breach[0]
            sample_once(require_container=True)
            if sample_failure:
                if isinstance(sample_failure[0], ReleaseBlocked):
                    raise sample_failure[0]
                raise ReleaseDefect("Codex capacity sampler failed") from sample_failure[0]
            if sampled_host_ids != [host_container_id]:
                raise ReleaseDefect("Codex capacity sampled host identity differs")
            for sample in host_samples:
                self._require_qualification_host_sample(sample)
        except BaseException as exc:
            # Device-auth, Docker, and observation failures remain retriable.
            # A cgroup OOM read from the exact attempted host is a measured
            # breach and must become immutable before teardown removes context.
            if sampler_started:
                stop_sampler()
            startup_error: BaseException = exc
            if sample_breach:
                startup_error = sample_breach[0]
            elif sampler.is_alive():
                startup_error = ExternalCommandFailed("Codex capacity sampler did not stop")
            elif sample_failure:
                if isinstance(sample_failure[0], ReleaseBlocked):
                    startup_error = sample_failure[0]
                else:
                    sampling_defect = ReleaseDefect("Codex capacity sampler failed")
                    sampling_defect.__cause__ = sample_failure[0]
                    startup_error = sampling_defect
            if isinstance(exc, CodexCapacityBreach):
                startup_error = exc
            if isinstance(startup_error, CodexCapacityBreach):
                startup_error = self._record_codex_capacity_breach(
                    source_sha=source_sha,
                    worker_image_id=worker_image_id,
                    breach=startup_error,
                )
            cleanup_failures = self._cleanup_codex_capacity_runtime(
                bundle=bundle,
                candidate=candidate,
                config_path=config_path,
                canary_name=None,
                stop_host=host_may_be_started,
            )
            for cleanup_failure in cleanup_failures:
                startup_error.add_note(f"Codex capacity cleanup also failed: {cleanup_failure}")
            if startup_error is exc:
                raise
            raise startup_error from exc
        name = f"nexus-codex-capacity-{source_sha}"
        canary_id = ""
        canary_may_exist = False
        input_directory: tempfile.TemporaryDirectory[str] | None = None
        input_path: Path | None = None
        evidence: dict[str, object] | None = None
        proof_error: BaseException | None = None
        write_failure_evidence = False
        try:
            input_bytes = self._materialize_codex_capacity_input(
                bundle=bundle,
                candidate=candidate,
                config_path=config_path,
            )
            input_directory = tempfile.TemporaryDirectory(prefix="nexus-codex-capacity-input-")
            input_path = Path(input_directory.name) / "generation.json"
            _create_bytes(
                input_path,
                input_bytes,
                mode=0o444,
                owner=(10001, 10001),
            )
            input_path = input_path.resolve(strict=True)
            input_metadata = input_path.lstat()
            if (
                not stat.S_ISREG(input_metadata.st_mode)
                or input_metadata.st_uid != 10001
                or input_metadata.st_gid != 10001
                or stat.S_IMODE(input_metadata.st_mode) != 0o444
                or input_path.read_bytes() != input_bytes
            ):
                raise ReleaseDefect("Codex capacity input file is not exact immutable input")
            reservation, memory, pids = _RESOURCE_LIMITS[_CODEX_AGENT_HOST]
            run_volume_name = _CODEX_AGENT_VOLUME_MOUNTS["/run/nexus-codex"]
            self._reclaim_codex_capacity_canary(name, source_sha=source_sha)
            # From here the named canary is this run's to remove, whether or not
            # `docker run` reports back, so cleanup always reclaims it.
            canary_may_exist = True
            canary_id = _stdout(
                (
                    "docker",
                    "run",
                    "--detach",
                    "--name",
                    name,
                    "--label",
                    f"{_CODEX_CAPACITY_CANARY_LABEL}={source_sha}",
                    "--network",
                    "none",
                    "--read-only",
                    "--cap-drop",
                    "ALL",
                    "--security-opt",
                    "no-new-privileges:true",
                    "--cpus",
                    "1.0",
                    "--memory-reservation",
                    str(reservation),
                    "--memory",
                    str(memory),
                    "--memory-swap",
                    str(memory),
                    "--pids-limit",
                    str(pids),
                    "--user",
                    "10001:10001",
                    "--env",
                    "NEXUS_CODEX_AGENT_SOCKET=/run/nexus-codex/agent.sock",
                    "--env",
                    "NEXUS_CODEX_CAPACITY_GENERATION_SPEC_FILE="
                    f"{_CODEX_CAPACITY_INPUT_CONTAINER_PATH}",
                    "--mount",
                    f"type=volume,src={run_volume_name},dst=/run/nexus-codex,readonly",
                    "--mount",
                    f"type=bind,src={input_path},dst="
                    f"{_CODEX_CAPACITY_INPUT_CONTAINER_PATH},readonly",
                    "--entrypoint",
                    "sh",
                    candidate.images.worker,
                    *_CODEX_CAPACITY_CLIENT_COMMAND,
                )
            )
            _require_match("Codex capacity canary container id", canary_id, _CONTAINER_ID)
            self._prove_codex_capacity_isolation(
                canary=_inspect_one(canary_id, "Codex capacity canary inspect"),
                host_container_id=host_container_id,
                policy_container_id=policy_container_id,
                expected_image=candidate.images.worker,
                expected_image_id=worker_image_id,
                expected_name=name,
                expected_source_sha=source_sha,
                image_environment=self._codex_agent_image_environment(candidate.images.worker),
                expected_input_source=input_path,
            )
            self._validate_running_resource_limits(_CODEX_AGENT_HOST, canary_id)
            sample_once(require_container=True)
            result = _run_observed(
                (
                    "docker",
                    "exec",
                    canary_id,
                    "python",
                    "-m",
                    "apps.codex_agent.capacity_canary",
                ),
                timeout_seconds=420,
            )
            if sample_breach:
                # The sampler observed the ceiling itself during the turns. That
                # is the measurement §11 enumerates, not a sampler fault, so the
                # main thread re-raises it first and failed evidence is written;
                # no later sampler classification may downgrade it.
                raise sample_breach[0]
            # Only a complete canary statement can prove its contract failed.
            # Sampling continues while this result is classified; every exit
            # joins and samples once more before teardown can erase a breach.
            try:
                canary = _closed_mapping(
                    _read_json_output(result.stdout, "Codex capacity canary"),
                    _CODEX_CAPACITY_CANARY_FIELDS,
                    "Codex capacity canary",
                )
                status = _string(canary, "status")
                schema_version = _string(canary, "schema_version")
                turns = canary.get("turns")
                if not isinstance(turns, list):
                    raise ReleaseDefect("Codex capacity canary turns are malformed")
            except ReleaseDefect as exc:
                raise ExternalCommandFailed(
                    "Codex capacity canary did not state its contract"
                ) from exc
            if result.returncode not in _CODEX_CAPACITY_CANARY_EXIT_CODES.values():
                # A complete statement carrying a code the contract does not
                # define is the killed-after-printing case: still retriable,
                # still never evidence.
                raise ExternalCommandFailed("Codex capacity canary did not reach a terminal")
            if schema_version != _CODEX_CAPACITY_CANARY_SCHEMA_VERSION:
                raise CodexCapacityBreach("Codex capacity canary schema differs")
            if result.returncode != _CODEX_CAPACITY_CANARY_EXIT_CODES.get(status):
                raise CodexCapacityBreach("Codex capacity canary exit status differs")
            if status in {"not_run", "subscription_blocked", "transport_retriable"}:
                raise ReleaseBlocked(f"Codex capacity qualification is {status}")
            if status != "passed":
                raise CodexCapacityBreach("Codex capacity canary failed")
            services = self._require_codex_capacity_service_health(
                bundle=bundle,
                candidate=candidate,
                config_path=config_path,
            )
            stop_sampler()
            if sample_breach:
                raise sample_breach[0]
            metrics = tuple(cgroup_samples)
            if not metrics:
                raise ReleaseDefect("Codex capacity cgroup was never sampled")
            initial_metrics, final_metrics = metrics[0], metrics[-1]
            if (
                any(metric[0] != _RESOURCE_LIMITS[_CODEX_AGENT_HOST][1] for metric in metrics)
                or max(metric[2] for metric in metrics) > _CODEX_AGENT_MEMORY_PEAK_LIMIT_BYTES
                or any(metric[3] != 0 for metric in metrics)
            ):
                raise CodexCapacityBreach("Codex capacity qualification cgroup envelope differs")
            evidence = {
                "schema_version": _CODEX_CAPACITY_SCHEMA_VERSION,
                "source_sha": source_sha,
                "worker_image_id": worker_image_id,
                "status": "passed",
                "measured_at": _now(),
                "turns": turns,
                "cgroup_memory_max": final_metrics[0],
                "cgroup_memory_current": final_metrics[1],
                "cgroup_memory_peak": max(metric[2] for metric in metrics),
                "minimum_mem_available": min(sample[0] for sample in host_samples),
                "maximum_memory_psi_some": max(sample[1] for sample in host_samples),
                "maximum_memory_psi_full": max(sample[2] for sample in host_samples),
                "oom_kill_delta": final_metrics[3] - initial_metrics[3],
                "services": list(services),
            }
            self._read_codex_capacity_evidence_value(
                evidence,
                expected_source_sha=candidate.source_sha,
                worker_image_id=worker_image_id,
            )
            if sampler.is_alive():
                raise ExternalCommandFailed("Codex capacity sampler did not stop")
            if sample_failure:
                if isinstance(sample_failure[0], ReleaseBlocked):
                    raise sample_failure[0]
                raise ReleaseDefect("Codex capacity sampler failed") from sample_failure[0]
        except CodexCapacityBreach as exc:
            # Only a measured breach disqualifies the source SHA forever, and
            # the immutable failed evidence it writes can never be replaced.
            stop_sampler()
            proof_error = sample_breach[0] if sample_breach else exc
            write_failure_evidence = True
        except BaseException as exc:
            # Docker, transport, sampler and host-read failures measured no
            # breach. They stay retriable and write nothing, exactly like the
            # startup block above.
            stop_sampler()
            if sample_breach:
                proof_error = sample_breach[0]
                write_failure_evidence = True
            elif sampler.is_alive():
                proof_error = ExternalCommandFailed("Codex capacity sampler did not stop")
            elif sample_failure:
                if isinstance(sample_failure[0], ReleaseBlocked):
                    proof_error = sample_failure[0]
                else:
                    sampling_defect = ReleaseDefect("Codex capacity sampler failed")
                    sampling_defect.__cause__ = sample_failure[0]
                    proof_error = sampling_defect
            else:
                proof_error = exc

        if proof_error is not None and write_failure_evidence:
            # The immutable failed record is the run's product: local durable
            # state lands before the external teardown, and a record that could
            # not be written is a defect of its own -- never a breach quietly
            # demoted to a retriable note that leaves the SHA re-qualifiable.
            if not isinstance(proof_error, CodexCapacityBreach):
                raise AssertionError("capacity breach classification lost its typed error")
            proof_error = self._record_codex_capacity_breach(
                source_sha=source_sha,
                worker_image_id=worker_image_id,
                breach=proof_error,
            )
        cleanup_failures = self._cleanup_codex_capacity_runtime(
            bundle=bundle,
            candidate=candidate,
            config_path=config_path,
            canary_name=name if canary_may_exist else None,
            stop_host=activated_attempt is None,
        )
        if cleanup_failures:
            # Cleanup observes nothing about capacity, so a failure here fails
            # the run without writing evidence; the next run reclaims the canary.
            if proof_error is None:
                proof_error = ExternalCommandFailed("Codex capacity cleanup failed")
            for cleanup_failure in cleanup_failures:
                proof_error.add_note(f"Codex capacity cleanup also failed: {cleanup_failure}")
        if input_directory is not None:
            try:
                input_directory.cleanup()
            except OSError as exc:
                if proof_error is None:
                    proof_error = ExternalCommandFailed("Codex capacity input cleanup failed")
                proof_error.add_note(f"Codex capacity input cleanup also failed: {exc}")
        if proof_error is not None:
            raise proof_error
        if evidence is None:
            raise ReleaseDefect("Codex capacity qualification produced no evidence")
        self._write_codex_capacity_evidence(source_sha, worker_image_id, evidence)

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
        inspected = _inspect_one(container_id, f"{service} activated container inspect")
        self._validate_running_resource_limits(service, container_id)
        image_id = _require_match(f"{service} image id", inspected.get("Image"), _IMAGE_ID)
        return image_id

    def apply(
        self,
        *,
        source_sha: str,
        deployment_id: str,
        production_host: str,
        backup_policy: BackupPolicy = BackupPolicy.Required,
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
                    backup_policy=backup_policy,
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
        backup_policy: BackupPolicy,
    ) -> ReleaseAttempt:
        self.store.assert_no_oracle_attempt()
        if self.paths.caddy_activation.exists():
            raise ReleaseBlocked("pending Caddy activation must be recovered before release apply")
        _require_match("Vercel deployment id", deployment_id, _DEPLOYMENT_ID)
        _require_match("production host", production_host, _HOST)
        self.store.assert_candidate_admissible(source_sha)
        existing = self.store.load_attempt(source_sha)
        if existing is not None and existing.backup_policy is not backup_policy:
            raise ReleaseBlocked("resume must reuse its recorded database backup policy")
        # The predecessor has no Codex host. A first cutover therefore requires
        # its immutable qualification before the ordinary release path mutates
        # a live container. Qualification owns its prerequisite resource
        # convergence so the measured baseline already satisfies the contract.
        if self.store.forward_fix_sha() is None and (
            existing is None
            or existing.phase
            not in {
                ReleasePhase.BackendActivationStarted,
                ReleasePhase.AwaitingFrontendPromotion,
                ReleasePhase.FrontendPromoted,
            }
        ):
            self._require_first_codex_capacity_qualification(
                source_sha,
                existing=existing,
            )
        candidate = load_candidate_manifest(self.bundle(source_sha) / "candidate-manifest.json")
        if _requires_codex_agent_host(candidate):
            self._require_codex_isolated_gateway_support()
            self._require_codex_state_storage()
            self._validate_codex_state_boot_guard()
        if existing is None or existing.phase is ReleasePhase.Prepared:
            pre_mutation_config = (
                self._config_snapshot().path if existing is None else Path(existing.config_path)
            )
            self._require_caddy_admin_ready(
                bundle=self.bundle(source_sha),
                candidate=candidate,
                config_path=pre_mutation_config,
                failure="Caddy is not ready before release mutation",
            )
            self._require_caddy_loaded_config(
                bundle=self.bundle(source_sha),
                candidate=candidate,
                config_path=pre_mutation_config,
            )
        if existing is None:
            self._converge_resource_limits(source_sha)
            preflight = self.preflight(source_sha, backup_policy=backup_policy)
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
                backup_policy=backup_policy,
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
            self._revalidate_attempt_host_capacity(
                attempt,
                writers_running=False if attempt.forward_fix_of is not None else None,
            )
            self._stop_writers(
                bundle=bundle,
                candidate=candidate,
                config_path=Path(attempt.config_path),
                attempt=attempt,
            )
            attempt = attempt.advance(ReleasePhase.WritersStopped, now=_now())
            self.store.replace_attempt(attempt)

        if attempt.phase is ReleasePhase.WritersStopped:
            self._revalidate_attempt_host_capacity(attempt, writers_running=False)
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
                starting_revision = revisions[0]
                self._prove_database_ancestry(
                    candidate=candidate,
                    current_revision=starting_revision,
                )
                database_identity = self._database_scalar(
                    bundle=bundle,
                    candidate=candidate,
                    config_path=Path(attempt.config_path),
                    sql=(
                        "SELECT current_database() || ':' || system_identifier "
                        "FROM pg_control_system()"
                    ),
                )
                if preflight is not None and (
                    database_identity != preflight.database_identity
                    or starting_revision != preflight.database_revision
                ):
                    raise PermanentReleaseFailure(
                        "database changed after preflight and before the migration boundary"
                    )
                if attempt.backup_policy is BackupPolicy.Waived:
                    # Config, exact containers, stopped writers and ancestry were
                    # proved above. No archive exists to attest or validate.
                    attempt = attempt.advance(ReleasePhase.DataMutationStarted, now=_now())
                else:
                    backup = self._backup(
                        bundle=bundle,
                        candidate=candidate,
                        attempt=attempt,
                        database_identity=database_identity,
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
            self._revalidate_attempt_host_capacity(attempt, writers_running=False)
            self._validate_backup_evidence(
                bundle=bundle,
                candidate=candidate,
                attempt=attempt,
            )
            attempt = attempt.advance(ReleasePhase.DataMutationStarted, now=_now())
            self.store.replace_attempt(attempt)

        if attempt.phase is ReleasePhase.DataMutationStarted:
            self._revalidate_attempt_host_capacity(attempt, writers_running=False)
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
                self._settle_completed_migration(
                    candidate.source_sha,
                    bundle=bundle,
                    candidate=candidate,
                    config_path=Path(attempt.config_path),
                    expected_image_id=attempt.candidate_api_image_id,
                )
            else:
                self._migrate(
                    bundle=bundle,
                    candidate=candidate,
                    config_path=Path(attempt.config_path),
                    expected_image_id=attempt.candidate_api_image_id,
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

        if attempt.phase in {
            ReleasePhase.BackendActivationStarted,
            ReleasePhase.FrontendPromoted,
        } or (
            attempt.phase is ReleasePhase.AwaitingFrontendPromotion
            and self._requires_first_codex_capacity_qualification(candidate, existing=attempt)
        ):
            self._activate_backend(bundle=bundle, candidate=candidate, attempt=attempt)
            if attempt.phase is ReleasePhase.BackendActivationStarted:
                attempt = attempt.advance(
                    ReleasePhase.AwaitingFrontendPromotion,
                    now=_now(),
                )
                self.store.replace_attempt(attempt)

        if attempt.phase not in {
            ReleasePhase.AwaitingFrontendPromotion,
            ReleasePhase.FrontendPromoted,
        }:
            raise ReleaseBlocked(f"host apply cannot continue phase {attempt.phase.value}")
        return attempt

    def _activate_backend(
        self, *, bundle: Path, candidate: CandidateManifest, attempt: ReleaseAttempt
    ) -> None:
        """Restore and prove the bound candidate, retaining the no-use window."""

        try:
            # Recheck immediately before host activation: qualification and
            # preflight evidence cannot authorize a later mount substitution.
            self._require_codex_state_storage()
            self._validate_codex_state_boot_guard()
            self._prepare_codex_agent_host_security(bundle)
            # Start and prove the policy, credential host, sandbox, auth, and
            # denied routes before writers. The positive MCP path is impossible
            # until the candidate interactive worker is live, so prove it only
            # after that listener starts and before the phase can advance.
            self._start_codex_agent_host(
                bundle=bundle,
                candidate=candidate,
                config_path=Path(attempt.config_path),
            )
            self._prove_codex_agent_host(
                bundle=bundle,
                candidate=candidate,
                config_path=Path(attempt.config_path),
                expected_worker_image_id=attempt.candidate_worker_image_id,
            )
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
            self._prove_api_generation_surface(
                bundle=bundle,
                candidate=candidate,
                config_path=Path(attempt.config_path),
            )
            self._prove_codex_mcp_path(
                bundle=bundle,
                candidate=candidate,
                config_path=Path(attempt.config_path),
            )
            self._prove_backend(
                bundle=bundle,
                candidate=candidate,
                attempt=attempt,
                require_codex_agent_host=False,
            )
            self._prove_public_mcp_mount(Path(attempt.config_path))
            self._require_first_codex_capacity_qualification(
                attempt.source_sha, existing=attempt, qualify_active=True
            )
        except (ReleaseBlocked, ExternalCommandFailed, ReleaseDefect, OSError) as exc:
            # A retriable measurement must leave the committed release resumable
            # with writers stopped. Permanent failures use ordinary settlement.
            failures = list(
                self._cleanup_codex_capacity_runtime(
                    bundle=bundle,
                    candidate=candidate,
                    config_path=Path(attempt.config_path),
                    canary_name=None,
                    stop_host=True,
                )
            )
            try:
                self._stop_current_writers(
                    bundle=bundle,
                    candidate=candidate,
                    config_path=Path(attempt.config_path),
                )
            except BaseException as cleanup_error:
                failures.append(cleanup_error)
            if failures:
                failure = ExternalCommandFailed("candidate stop after blocked activation failed")
                for cleanup_error in failures:
                    failure.add_note(str(cleanup_error))
                raise failure from exc
            raise

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
        if _requires_codex_agent_host(candidate):
            self._stop_codex_runtime(
                bundle=bundle,
                candidate=candidate,
                config_path=Path(attempt.config_path),
            )
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

    def _prove_public_mcp_mount(self, config_path: Path) -> None:
        """Prove public TLS reaches the auth-first worker MCP mount exactly."""

        url = self._codex_mcp_origin(config_path)
        operation = f"public-mcp:{url}"
        request = urllib.request.Request(
            url,
            data=b"",
            headers={"Accept": "application/json"},
            method="POST",
        )
        opener = urllib.request.build_opener(_RejectRedirects())
        try:
            with opener.open(request, timeout=8) as response:
                raise PermanentReleaseFailure(
                    f"public MCP proof returned HTTP {response.status} instead of 401"
                )
        except urllib.error.HTTPError as exc:
            if exc.code in {408, 425, 429} or 500 <= exc.code <= 599:
                raise ExternalCommandFailed(
                    f"public MCP proof was unavailable at {url}",
                    operation=operation,
                ) from exc
            body = exc.read(1)
            if (
                exc.code != 401
                or body != b""
                or exc.geturl() != url
                or exc.headers.get("Location") is not None
                or exc.headers.get("Set-Cookie") is not None
            ):
                raise PermanentReleaseFailure("public MCP mount contract differs") from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise ExternalCommandFailed(
                f"public MCP proof failed for {url}",
                operation=operation,
            ) from exc

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
        bundle: Path,
        expected_task_contract_digest: str,
    ) -> None:
        _require_match(
            "expected task contract digest",
            expected_task_contract_digest,
            _SHA256,
        )
        if _requires_codex_agent_host(candidate):
            self._prove_public_mcp_mount(Path(attempt.config_path))
        web, web_headers = self._fetch_json(f"https://{attempt.production_host}/version")
        expected_web: dict[str, Any] = {"source_sha": candidate.source_sha}
        if _bundle_files(bundle) != _DB0215_BUNDLE_FILES:
            expected_web["player_protocol"] = android_player_protocol_identity(
                bundle / _ANDROID_PLAYER_PROTOCOL_CORPUS
            ).as_json()
        if web != expected_web:
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
        if attempt.phase in {
            ReleasePhase.AwaitingFrontendPromotion,
            ReleasePhase.FrontendPromoted,
        }:
            try:
                self._require_first_codex_capacity_qualification(source_sha, existing=attempt)
            except ReleaseBlocked:
                # The alias may already have moved. Resume the same bound
                # candidate and refresh its expired measurement before publishing.
                self._activate_backend(bundle=bundle, candidate=candidate, attempt=attempt)
        if self.store.current_sha() == source_sha:
            _, _, task_digest = self._prove_backend(
                bundle=bundle,
                candidate=candidate,
                attempt=attempt,
                require_codex_agent_host=True,
            )
            self._prove_public(
                attempt,
                candidate,
                bundle=bundle,
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
                require_codex_agent_host=True,
            )
            self._prove_public(
                attempt,
                candidate,
                bundle=bundle,
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
            require_codex_agent_host=True,
        )
        self._prove_public(
            attempt,
            candidate,
            bundle=bundle,
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
        bundle = self.bundle(source_sha)
        candidate = load_candidate_manifest(bundle / "candidate-manifest.json")
        if record.manifest_sha256 != _sha256(bundle / "candidate-manifest.json"):
            raise ReleaseDefect("current release manifest hash differs")
        api_image_id, worker_image_id, task_digest = self._prove_backend(
            bundle=bundle,
            candidate=candidate,
            attempt=attempt,
            require_codex_agent_host=_requires_codex_agent_host(candidate),
        )
        self._prove_public(
            attempt,
            candidate,
            bundle=bundle,
            expected_task_contract_digest=task_digest,
        )
        self._validate_release_inputs(
            bundle=bundle,
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

    def resume_codex_agent_host(self, source_sha: str) -> dict[str, str]:
        """Resume only the exact current Codex host after an interactive unlock."""

        self.store.assert_no_oracle_attempt()
        _require_match("resume source SHA", source_sha, _SHA)
        record = self.store.require_current_record()
        if record.source_sha != source_sha:
            raise ReleaseBlocked(f"release {source_sha} is not current")
        # The same durable gate every host mutator takes: another SHA's
        # nonterminal attempt, or a forward-fix pointer that deliberately
        # stopped the writers, means the current record is not the runtime
        # authority and predecessor code must not be started underneath it.
        self.store.assert_candidate_admissible(source_sha)
        forward_fix = self.store.forward_fix_sha()
        if forward_fix is not None:
            raise ReleaseBlocked(f"release {forward_fix} awaits a forward fix")
        attempt = self.store.load_attempt(source_sha)
        if attempt is None or attempt.phase is not ReleasePhase.Succeeded:
            raise ReleaseDefect("current release is not a complete immutable publication")
        bundle = self.bundle(source_sha)
        candidate = load_candidate_manifest(bundle / "candidate-manifest.json")
        if not _requires_codex_agent_host(candidate):
            raise ReleaseBlocked("current release has no Codex agent host")
        self._require_codex_isolated_gateway_support()
        self._validate_release_inputs(
            bundle=bundle,
            candidate=candidate,
            attempt=attempt,
        )
        self._require_codex_state_storage()
        self._validate_codex_state_boot_guard()

        container_id = (
            self._compose(
                bundle=bundle,
                candidate=candidate,
                config_path=Path(attempt.config_path),
                arguments=("ps", "--all", "--quiet", _CODEX_AGENT_HOST),
            )
            .stdout.decode("ascii")
            .strip()
        )
        if container_id:
            _require_match("Codex agent host container id", container_id, _CONTAINER_ID)
            state = _mapping(
                _inspect_one(container_id, "Codex stopped agent host inspect").get("State"),
                "Codex stopped agent host state",
            )
            if state.get("Running") is not False:
                raise ReleaseBlocked("Codex agent host is not stopped")

        host_may_be_started = False
        try:
            host_may_be_started = True
            self._start_codex_agent_host(
                bundle=bundle,
                candidate=candidate,
                config_path=Path(attempt.config_path),
            )
            self.verify_current(source_sha)
        except BaseException as exc:
            cleanup_failures = self._cleanup_codex_capacity_runtime(
                bundle=bundle,
                candidate=candidate,
                config_path=Path(attempt.config_path),
                canary_name=None,
                stop_host=host_may_be_started,
            )
            for cleanup_failure in cleanup_failures:
                exc.add_note(f"Codex host stop after failed resume also failed: {cleanup_failure}")
            raise
        return {
            "schema_version": "nexus-codex-agent-host-resume.v1",
            "source_sha": source_sha,
            "status": "ready",
        }


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
                expected_image_id=(
                    target.record.worker_image_id
                    if execution.repair is None
                    else execution.repair.repair_worker_image_id
                ),
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
            require_writer_health=True,
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
        item = _inspect_one(evidence.container_id, f"Oracle {service} container inspect")
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
            require_codex_agent_host=_requires_codex_agent_host(target.candidate),
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
            bundle=target.bundle,
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

    android_release = commands.add_parser("validate-android-release-manifest")
    android_release.add_argument("--manifest", type=Path, required=True)
    android_release.add_argument("--corpus", type=Path, required=True)
    android_release.add_argument("--tag", required=True)

    android_identity = commands.add_parser("android-player-protocol-identity")
    android_identity.add_argument("--corpus", type=Path, required=True)

    install = commands.add_parser("install-bundle")
    install.add_argument("--source", type=Path, required=True)

    install_oracle_repair = commands.add_parser("install-oracle-repair-bundle")
    install_oracle_repair.add_argument("--source", type=Path, required=True)
    install_oracle_repair.add_argument("--target-source-sha", required=True)

    apply = commands.add_parser("apply")
    apply.add_argument("--source-sha", required=True)
    apply.add_argument("--deployment-id", required=True)
    apply.add_argument("--production-host", required=True)
    apply.add_argument("--no-database-backup", action="store_true")

    qualify_capacity = commands.add_parser("qualify-codex-capacity")
    qualify_capacity.add_argument("--source-sha", required=True)

    install_codex_state_boot_guard = commands.add_parser("install-codex-state-boot-guard")
    install_codex_state_boot_guard.add_argument("--source-sha", required=True)

    activate_caddy_config = commands.add_parser("activate-caddy-config")
    activate_caddy_config.add_argument("--source-sha", required=True)

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

    resume_codex_agent_host = commands.add_parser("resume-codex-agent-host")
    resume_codex_agent_host.add_argument("--source-sha", required=True)

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
    if args.command == "validate-android-release-manifest":
        identity = load_android_release_manifest(
            args.manifest,
            corpus=args.corpus,
            expected_tag=args.tag,
        )
        sys.stdout.buffer.write(_canonical_json(identity.as_json()))
        return 0
    if args.command == "android-player-protocol-identity":
        identity = android_player_protocol_identity(args.corpus)
        sys.stdout.buffer.write(_canonical_json(identity.as_json()))
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
                    "backup_policy": None if attempt is None else attempt.backup_policy.value,
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
                backup_policy=(
                    BackupPolicy.Waived if args.no_database_backup else BackupPolicy.Required
                ),
            )
            sys.stdout.buffer.write(
                _canonical_json({"source_sha": attempt.source_sha, "phase": attempt.phase.value})
            )
            return 0
        if args.command == "qualify-codex-capacity":
            controller.qualify_codex_capacity(args.source_sha)
            sys.stdout.buffer.write(
                _canonical_json({"source_sha": args.source_sha, "status": "passed"})
            )
            return 0
        if args.command == "install-codex-state-boot-guard":
            receipt = controller.install_codex_state_boot_guard(args.source_sha)
            sys.stdout.buffer.write(_canonical_json(receipt))
            return 0
        if args.command == "activate-caddy-config":
            receipt = controller.activate_caddy_config(args.source_sha)
            sys.stdout.buffer.write(_canonical_json(receipt))
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
        if args.command == "resume-codex-agent-host":
            receipt = controller.resume_codex_agent_host(args.source_sha)
            sys.stdout.buffer.write(_canonical_json(receipt))
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
