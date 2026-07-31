from __future__ import annotations

import base64
import binascii
import fcntl
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import cast

from nexus_test_control.runtime import (
    EndpointKind,
    RuntimeContractError,
    canonical_repo_root,
    require_test_environment,
    runtime_endpoint,
    runtime_state_dir,
)

BUILD_METADATA_VERSION = 1
BUILD_COMMAND = ("bun", "run", "build")

_BUILD_FINGERPRINT = re.compile(r"[0-9a-f]{64}\Z")
_SAFE_CHILD_ENV = ("HOME", "LANG", "LC_ALL", "PATH", "TMPDIR", "TZ")
_FIXED_BUILD_INPUTS = (
    "apps/web/bun.lock",
    "apps/web/next.config.ts",
    "apps/web/package.json",
    "apps/web/scripts/copy-pdfjs.mjs",
    "apps/web/tsconfig.json",
)
_METADATA_NAME = ".nexus-build.json"


@dataclass(frozen=True, slots=True)
class StandaloneBuild:
    fingerprint: str
    root: Path
    server: Path


def standalone_build_fingerprint(
    repo_root: Path,
    environment: Mapping[str, str],
    supabase_public_key: str,
) -> str:
    root = canonical_repo_root(repo_root)
    public_environment = _public_build_environment(root, environment, supabase_public_key)
    digest = hashlib.sha256(b"nexus-next-standalone-v1\0")
    for relative, contents in _build_inputs(root):
        digest.update(relative.encode())
        digest.update(b"\0")
        digest.update(contents)
        digest.update(b"\0")
    for key, value in sorted(public_environment.items()):
        digest.update(key.encode())
        digest.update(b"\0")
        digest.update(value.encode())
        digest.update(b"\0")
    return digest.hexdigest()


def ensure_standalone_build(
    repo_root: Path,
    environment: Mapping[str, str],
    supabase_public_key: str,
) -> StandaloneBuild:
    root = canonical_repo_root(repo_root)
    public_environment = _public_build_environment(root, environment, supabase_public_key)
    fingerprint = standalone_build_fingerprint(root, environment, supabase_public_key)
    builds = runtime_state_dir(root) / "builds"
    artifact = builds / fingerprint

    with _next_build_lock(root, environment):
        reused = _read_artifact(artifact, fingerprint, public_environment)
        if reused is not None:
            return reused
        if artifact.exists():
            shutil.rmtree(artifact)

        builds.mkdir(parents=True, exist_ok=True)
        web_root = root / "apps" / "web"
        _reject_next_environment_files(web_root)
        next_output = web_root / ".next"
        if next_output.exists():
            shutil.rmtree(next_output)

        try:
            subprocess.run(
                BUILD_COMMAND,
                cwd=web_root,
                env=_child_environment(environment, public_environment),
                check=True,
            )
        except subprocess.CalledProcessError:
            raise RuntimeContractError("Next standalone build failed") from None

        standalone = next_output / "standalone"
        server = _single_generated_server(standalone)
        static = next_output / "static"
        public = web_root / "public"
        if not static.is_dir() or not any(path.is_file() for path in static.rglob("*")):
            raise RuntimeContractError("Next build did not produce static assets")
        if not public.is_dir() or not any(path.is_file() for path in public.rglob("*")):
            raise RuntimeContractError("web build has no public assets")

        staging = Path(tempfile.mkdtemp(prefix=f".{fingerprint}-", dir=builds))
        try:
            shutil.copytree(standalone, staging, dirs_exist_ok=True, symlinks=True)
            server_relative = server.relative_to(standalone)
            normalized_server_root = staging / server_relative.parent
            shutil.copytree(public, normalized_server_root / "public", dirs_exist_ok=True)
            shutil.copytree(static, normalized_server_root / ".next" / "static")
            _verify_payload(staging, server_relative)
            _write_metadata(
                staging,
                fingerprint=fingerprint,
                public_environment=public_environment,
                server_relative=server_relative,
            )
            built = _read_artifact(staging, fingerprint, public_environment)
            if built is None:
                raise RuntimeContractError("completed Next artifact failed verification")
            os.replace(staging, artifact)
        finally:
            if staging.exists():
                shutil.rmtree(staging)

        result = _read_artifact(artifact, fingerprint, public_environment)
        if result is None:
            raise RuntimeContractError("published Next artifact failed verification")
        return result


@contextmanager
def _next_build_lock(repo_root: Path, environment: Mapping[str, str]) -> Iterator[Path]:
    require_test_environment(environment)
    path = runtime_state_dir(repo_root) / "locks" / "next-build.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_file = path.open("a+b")
    try:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        yield path
    finally:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
        lock_file.close()


def _public_build_environment(
    repo_root: Path,
    environment: Mapping[str, str],
    supabase_public_key: str,
) -> dict[str, str]:
    require_test_environment(environment)
    public_key = _validated_supabase_public_key(supabase_public_key)
    return {
        "APP_PUBLIC_URL": runtime_endpoint(repo_root, environment, EndpointKind.WEB),
        "FASTAPI_BASE_URL": runtime_endpoint(repo_root, environment, EndpointKind.API),
        "NEXT_PUBLIC_SUPABASE_ANON_KEY": public_key,
        "NEXT_PUBLIC_SUPABASE_URL": runtime_endpoint(repo_root, environment, EndpointKind.SUPABASE),
        "NEXT_TELEMETRY_DISABLED": "1",
        "NEXUS_ENV": "test",
        "NODE_ENV": "production",
        "R2_S3_API_ORIGIN": runtime_endpoint(repo_root, environment, EndpointKind.MINIO),
    }


def _validated_supabase_public_key(value: str) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise RuntimeContractError("Supabase public key is required for the web build")
    if value.startswith("sb_publishable_") and value != "sb_publishable_":
        return value
    parts = value.split(".")
    if len(parts) != 3:
        raise RuntimeContractError("web build accepts only a Supabase public key")
    try:
        payload = parts[1] + "=" * (-len(parts[1]) % 4)
        claims = json.loads(base64.urlsafe_b64decode(payload).decode())
    except (binascii.Error, UnicodeDecodeError, json.JSONDecodeError):
        raise RuntimeContractError("web build accepts only a Supabase public key") from None
    if not isinstance(claims, dict) or claims.get("role") != "anon":
        raise RuntimeContractError("web build accepts only a Supabase public key")
    return value


def _build_inputs(repo_root: Path) -> tuple[tuple[str, bytes], ...]:
    web_root = repo_root / "apps" / "web"
    paths = [repo_root / relative for relative in _FIXED_BUILD_INPUTS]
    paths.extend(_product_files(web_root / "src"))
    paths.extend(_product_files(web_root / "public", excluded_root="pdfjs"))
    paths.extend(_product_files(web_root / "patches"))

    found: list[tuple[str, bytes]] = []
    for path in paths:
        try:
            resolved = path.resolve(strict=True)
            relative = resolved.relative_to(repo_root).as_posix()
        except (OSError, ValueError) as exc:
            raise RuntimeContractError(
                "web build input is missing or outside the repository"
            ) from exc
        if not resolved.is_file():
            raise RuntimeContractError(f"web build input is not a file: {relative}")
        found.append((relative, resolved.read_bytes()))
    if len({relative for relative, _ in found}) != len(found):
        raise RuntimeContractError("web build input is duplicated")
    return tuple(sorted(found))


def _product_files(directory: Path, *, excluded_root: str | None = None) -> list[Path]:
    if not directory.is_dir():
        raise RuntimeContractError(f"web build input directory is missing: {directory}")
    files: list[Path] = []
    for path in directory.rglob("*"):
        relative = path.relative_to(directory)
        if excluded_root is not None and relative.parts[0] == excluded_root:
            continue
        if "__tests__" in relative.parts or ".test." in path.name or ".spec." in path.name:
            continue
        if path.is_file():
            files.append(path)
    return files


def _single_generated_server(standalone: Path) -> Path:
    if not standalone.is_dir():
        raise RuntimeContractError("Next build did not produce standalone output")
    servers = tuple(
        path
        for path in standalone.rglob("server.js")
        if path.is_file() and "node_modules" not in path.relative_to(standalone).parts
    )
    if len(servers) != 1:
        raise RuntimeContractError(
            f"Next standalone output must contain one generated server.js, found {len(servers)}"
        )
    return servers[0]


def _child_environment(
    environment: Mapping[str, str], public_environment: Mapping[str, str]
) -> dict[str, str]:
    child = {
        key: value
        for key in _SAFE_CHILD_ENV
        if (value := environment.get(key)) is not None and value != ""
    }
    child.update(public_environment)
    return child


def _reject_next_environment_files(web_root: Path) -> None:
    loaded = tuple(
        name
        for name in (".env", ".env.local", ".env.production", ".env.production.local")
        if (web_root / name).is_file()
    )
    if loaded:
        raise RuntimeContractError(
            "Next build refuses local environment files: " + ", ".join(loaded)
        )


def _write_metadata(
    artifact: Path,
    *,
    fingerprint: str,
    public_environment: Mapping[str, str],
    server_relative: Path,
) -> None:
    metadata = {
        "version": BUILD_METADATA_VERSION,
        "fingerprint": fingerprint,
        "command": list(BUILD_COMMAND),
        "strict_csp": True,
        "public_environment": dict(sorted(public_environment.items())),
        "server": server_relative.as_posix(),
    }
    temporary = artifact / f"{_METADATA_NAME}.tmp"
    temporary.write_text(
        json.dumps(metadata, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, artifact / _METADATA_NAME)


def _read_artifact(
    artifact: Path,
    fingerprint: str,
    public_environment: Mapping[str, str],
) -> StandaloneBuild | None:
    if not _BUILD_FINGERPRINT.fullmatch(fingerprint) or not artifact.is_dir():
        return None
    try:
        raw = json.loads((artifact / _METADATA_NAME).read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(raw, dict) or set(raw) != {
        "version",
        "fingerprint",
        "command",
        "strict_csp",
        "public_environment",
        "server",
    }:
        return None
    if (
        raw["version"] != BUILD_METADATA_VERSION
        or raw["fingerprint"] != fingerprint
        or raw["command"] != list(BUILD_COMMAND)
        or raw["strict_csp"] is not True
        or raw["public_environment"] != dict(sorted(public_environment.items()))
        or not isinstance(raw["server"], str)
    ):
        return None
    server_relative = PurePosixPath(cast(str, raw["server"]))
    if server_relative.is_absolute() or ".." in server_relative.parts:
        return None
    server_path = artifact.joinpath(*server_relative.parts)
    try:
        _verify_payload(artifact, Path(*server_relative.parts))
    except RuntimeContractError:
        return None
    return StandaloneBuild(fingerprint, artifact, server_path)


def _verify_payload(artifact: Path, server_relative: Path) -> None:
    server = artifact / server_relative
    if server.name != "server.js" or not server.is_file():
        raise RuntimeContractError("Next artifact lacks its recorded server.js")
    server_root = server.parent
    public = server_root / "public"
    static = server_root / ".next" / "static"
    if not public.is_dir() or not any(path.is_file() for path in public.rglob("*")):
        raise RuntimeContractError("Next artifact lacks public assets")
    if not static.is_dir() or not any(path.is_file() for path in static.rglob("*")):
        raise RuntimeContractError("Next artifact lacks static assets")
