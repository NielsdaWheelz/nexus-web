"""Capture the frontend partition without publishing or restarting a service."""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path
from urllib.parse import urlsplit

from artifact import ArtifactError, parse_env

ROOT = Path(__file__).resolve().parents[2]
SHARED = {
    "NEXUS_ENV",
    "APP_PUBLIC_URL",
    "SUPABASE_ISSUER",
    "SUPABASE_JWKS_URL",
    "SUPABASE_AUDIENCES",
    "NEXUS_INTERNAL_SECRET",
    "R2_S3_API_ORIGIN",
}
FRONTEND = {
    "FASTAPI_BASE_URL",
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "NEXUS_EXTENSION_REDIRECT_ORIGINS",
}
OPTIONAL = {"NEXUS_EXTENSION_REDIRECT_ORIGINS"}


def capture(source_sha: str) -> bytes:
    if re.fullmatch(r"[0-9a-f]{40}", source_sha) is None:
        raise ArtifactError("source-sha must contain 40 lowercase hex characters")
    values: dict[str, str] = {}
    for filename, allowed in (("env-prod", SHARED), ("env-prod-frontend", FRONTEND)):
        partition = parse_env((ROOT / "deploy/env" / filename).read_bytes())
        if partition.keys() - allowed:
            raise ArtifactError(f"{filename} contains unsupported or misplaced keys")
        missing = (allowed - OPTIONAL) - {key for key, value in partition.items() if value}
        if missing:
            raise ArtifactError(f"{filename} requires nonempty keys: {', '.join(sorted(missing))}")
        values.update(partition)
    if any(
        "<" in value or ">" in value or "example.com" in value or value.lower() == "changeme"
        for value in values.values()
    ):
        raise ArtifactError("production inputs contain placeholder values")
    if values["NEXUS_ENV"] != "prod":
        raise ArtifactError("NEXUS_ENV must be prod")
    if values["APP_PUBLIC_URL"] != "https://nexus.nielseriknandal.com":
        raise ArtifactError("APP_PUBLIC_URL must be the canonical production origin")
    if values["FASTAPI_BASE_URL"] != "https://nexus-api.nielseriknandal.com":
        raise ArtifactError("FASTAPI_BASE_URL must be the canonical production api origin")
    for key in ("R2_S3_API_ORIGIN", "NEXUS_EXTENSION_REDIRECT_ORIGINS"):
        value = values.get(key, "")
        if not value and key in OPTIONAL:
            continue
        url = urlsplit(value)
        if (
            url.scheme != "https"
            or not url.hostname
            or url.username
            or url.password
            or url.path not in ("", "/")
            or url.query
            or url.fragment
            or "," in value
            or (
                key == "R2_S3_API_ORIGIN" and not url.hostname.endswith(".r2.cloudflarestorage.com")
            )
        ):
            raise ArtifactError(f"{key} must contain its declared https origin")
    values["NEXUS_SOURCE_SHA"] = source_sha
    encoded = "".join(f"{key}={value}\n" for key, value in sorted(values.items())).encode()
    if parse_env(encoded) != values:
        raise ArtifactError("configuration cannot be represented as literal environment values")
    return encoded


def main() -> int:
    if len(sys.argv) != 3:
        print(
            "usage: python3 deploy/web/publish-env.py <source-sha> <output-file>", file=sys.stderr
        )
        return 2
    try:
        encoded = capture(sys.argv[1])
        os.umask(0o077)
        destination = Path(sys.argv[2]).resolve()
        if destination.is_relative_to(ROOT):
            raise ArtifactError("output must be outside the source checkout")
        with destination.open("xb") as output:
            output.write(encoded)
        print(f"web config: captured {destination}; build explicitly to prepare a candidate")
        return 0
    except (ArtifactError, OSError, ValueError) as exc:
        detail = (
            str(exc)
            if isinstance(exc, ArtifactError)
            else "input or output is unavailable or malformed"
        )
        print(f"web config: {detail}; no service changed", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
