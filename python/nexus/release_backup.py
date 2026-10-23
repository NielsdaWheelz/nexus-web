"""Stream database backups to private R2, verify every archive byte, and retain them.

The release controller backs up with writers stopped, before it migrates. The
nightly job backs up with writers running: pg_dump reads one consistent
snapshot, and a host lock keeps it apart from any release. This one-off owns its
PostgreSQL children, multipart upload, durable completion receipt and archive
retention. Only a successful pg_dump can publish that receipt; only its exact
multipart upload may then become a completed object. Each caller prunes only
after its own backup verifies.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
from collections.abc import Callable, Mapping
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import FrameType
from typing import Literal
from urllib.parse import urlsplit

import boto3
from botocore.client import BaseClient, Config
from botocore.exceptions import BotoCoreError, ClientError
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

_PART_BYTES = 16 * 1024 * 1024
_TIMEOUT_SECONDS = 1800
_RECEIPT_MAX_BYTES = 2 * 1024 * 1024
_MANIFEST_MAX_BYTES = 16 * 1024
_RETENTION = timedelta(days=7)


class BackupFailure(RuntimeError):
    """A backup cannot establish the release's required recovery evidence."""


class BackupEvidence(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)

    endpoint: str
    bucket: str
    key: str
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    byte_count: int = Field(gt=0)
    database_identity: str
    starting_revision: str


class _UploadPart(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)

    part_number: int = Field(ge=1, le=10000)
    etag: str = Field(min_length=1, max_length=128)


class _RecoveryManifest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)

    schema_version: Literal[1]
    source_sha: str = Field(pattern=r"^[0-9a-f]{40}$")
    evidence: BackupEvidence


class _Receipt(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)

    schema_version: Literal[1]
    source_sha: str = Field(pattern=r"^[0-9a-f]{40}$")
    upload_id: str = Field(min_length=1, max_length=4096)
    parts: list[_UploadPart] = Field(min_length=1, max_length=10000)
    evidence: BackupEvidence

    @model_validator(mode="after")
    def _complete_parts(self) -> _Receipt:
        if [part.part_number for part in self.parts] != list(range(1, len(self.parts) + 1)):
            raise ValueError("backup multipart sequence is incomplete")
        if len(self.parts) != (self.evidence.byte_count + _PART_BYTES - 1) // _PART_BYTES:
            raise ValueError("backup multipart count differs from its byte count")
        return self


def _interrupt(_signum: int, _frame: FrameType | None) -> None:
    raise BackupFailure("backup interrupted or exceeded its deadline")


def database_identity(psql: Callable[[str], str]) -> str:
    """The database name and cluster system identifier a backup records.

    `psql` runs one statement as `psql -At` and returns its stripped output: the
    release reads through the postgres container, the nightly job directly.
    """
    return psql("SELECT current_database() || ':' || system_identifier FROM pg_control_system()")


def database_revision(psql: Callable[[str], str]) -> str:
    """The database's single Alembic revision, or "" before its first migration."""
    if not psql("SELECT COALESCE(to_regclass('public.alembic_version')::text, '')"):
        return ""
    rows = [row for row in psql("SELECT version_num FROM alembic_version").splitlines() if row]
    if not rows:
        return ""
    if len(rows) != 1 or re.fullmatch(r"[0-9a-z][0-9a-z_]{0,63}", rows[0]) is None:
        raise BackupFailure(f"the database has no single well-formed Alembic revision: {rows}")
    return rows[0]


def _pg_environment() -> dict[str, str]:
    # PostgreSQL children receive only their connection inputs, never R2 keys.
    environment = {
        name: os.environ[name]
        for name in ("PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE")
    }
    environment["PGCONNECT_TIMEOUT"] = "10"
    return environment


def _psql(statement: str) -> str:
    return subprocess.run(
        ("/usr/lib/postgresql/15/bin/psql", "-At", "--no-password", "--command", statement),
        env=_pg_environment(),
        capture_output=True,
        check=True,
        text=True,
        timeout=60,
    ).stdout.strip()


def _head_exists(client: BaseClient, *, bucket: str, key: str) -> bool:
    try:
        client.head_object(Bucket=bucket, Key=key)
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") in {"404", "NoSuchKey", "NotFound"}:
            return False
        raise
    return True


def _publish_receipt(path: Path, receipt: _Receipt) -> None:
    partial = path.with_suffix(".partial")
    partial.unlink(missing_ok=True)
    descriptor = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(receipt.model_dump_json().encode("utf-8") + b"\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.link(partial, path)
    partial.unlink()
    _sync_directory(path.parent)


def _sync_directory(path: Path) -> None:
    directory = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def _create_receipt(
    client: BaseClient,
    *,
    endpoint: str,
    bucket: str,
    key: str,
    source_sha: str,
    database_identity: str,
    starting_revision: str,
    path: Path,
) -> _Receipt:
    if _head_exists(client, bucket=bucket, key=key):
        raise BackupFailure("completed backup object has no durable dump receipt")
    # An interrupted dump has no completion receipt. Its exact-key parts can
    # be discarded; the deterministic host-owned container excludes overlap.
    paginator = client.get_paginator("list_multipart_uploads")
    for page in paginator.paginate(Bucket=bucket, Prefix=key):
        for upload in page.get("Uploads", []):
            if upload["Key"] == key:
                client.abort_multipart_upload(Bucket=bucket, Key=key, UploadId=upload["UploadId"])
    upload_id = client.create_multipart_upload(
        Bucket=bucket,
        Key=key,
        ContentType="application/octet-stream",
        Metadata={
            "source-sha": source_sha,
            "database-identity": database_identity,
            "starting-revision": starting_revision,
        },
    )["UploadId"]
    process = subprocess.Popen(
        ("/usr/lib/postgresql/15/bin/pg_dump", "--format=custom", "--no-password"),
        env=_pg_environment(),
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    try:
        if process.stdout is None:
            raise AssertionError("pg_dump stdout pipe was not created")
        digest = hashlib.sha256()
        byte_count = 0
        parts: list[_UploadPart] = []
        with process.stdout:
            while chunk := process.stdout.read(_PART_BYTES):
                if len(parts) == 10000:
                    raise BackupFailure("backup exceeds the multipart part limit")
                digest.update(chunk)
                byte_count += len(chunk)
                part_number = len(parts) + 1
                response = client.upload_part(
                    Bucket=bucket,
                    Key=key,
                    UploadId=upload_id,
                    PartNumber=part_number,
                    Body=chunk,
                    ContentLength=len(chunk),
                    ContentMD5=base64.b64encode(hashlib.md5(chunk).digest()).decode("ascii"),
                )
                parts.append(_UploadPart(part_number=part_number, etag=response["ETag"]))
        if process.wait() != 0:
            raise BackupFailure("pg_dump failed before backup publication")
        receipt = _Receipt(
            schema_version=1,
            source_sha=source_sha,
            upload_id=upload_id,
            parts=parts,
            evidence=BackupEvidence(
                endpoint=endpoint,
                bucket=bucket,
                key=key,
                sha256=digest.hexdigest(),
                byte_count=byte_count,
                database_identity=database_identity,
                starting_revision=starting_revision,
            ),
        )
        _publish_receipt(path, receipt)
        return receipt
    finally:
        if process.poll() is None:
            process.kill()
        process.wait(timeout=10)
        # Once the receipt exists, replay owns this exact completion intent.
        if not path.exists():
            client.abort_multipart_upload(Bucket=bucket, Key=key, UploadId=upload_id)


def _verify(client: BaseClient, *, source_sha: str, evidence: BackupEvidence) -> None:
    response = client.get_object(Bucket=evidence.bucket, Key=evidence.key)
    body = response["Body"]
    try:
        if response["ContentLength"] != evidence.byte_count or response.get("Metadata") != {
            "source-sha": source_sha,
            "database-identity": evidence.database_identity,
            "starting-revision": evidence.starting_revision,
        }:
            raise BackupFailure("remote backup identity or byte count differs")
        # No database target is supplied: pg_restore traverses and decompresses
        # every archive entry into /dev/null, without executing the restored SQL.
        process = subprocess.Popen(
            ("/usr/lib/postgresql/15/bin/pg_restore", "--exit-on-error", "--file=/dev/null"),
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env={},
        )
        try:
            if process.stdin is None:
                raise AssertionError("pg_restore stdin pipe was not created")
            digest = hashlib.sha256()
            byte_count = 0
            with process.stdin:
                while chunk := body.read(1024 * 1024):
                    byte_count += len(chunk)
                    if byte_count > evidence.byte_count:
                        raise BackupFailure("remote backup exceeds its recorded byte count")
                    digest.update(chunk)
                    process.stdin.write(chunk)
            if process.wait() != 0:
                raise BackupFailure("pg_restore could not traverse the backup archive")
            if byte_count != evidence.byte_count or digest.hexdigest() != evidence.sha256:
                raise BackupFailure("remote backup digest or byte count differs")
        finally:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=10)
    finally:
        body.close()


def _require_recovery_manifest(
    client: BaseClient,
    *,
    source_sha: str,
    evidence: BackupEvidence,
    publish: bool,
) -> None:
    """Keep recovery evidence beside the archive, surviving loss of the VPS."""
    expected = _RecoveryManifest(schema_version=1, source_sha=source_sha, evidence=evidence)
    key = evidence.key.removesuffix("/database.dump") + "/database.json"
    try:
        response = client.get_object(Bucket=evidence.bucket, Key=key)
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") not in {"404", "NoSuchKey", "NotFound"}:
            raise
        if not publish:
            raise BackupFailure("remote backup recovery manifest is missing") from exc
        body = expected.model_dump_json().encode("utf-8") + b"\n"
        client.put_object(
            Bucket=evidence.bucket,
            Key=key,
            Body=body,
            ContentLength=len(body),
            ContentType="application/json",
            ContentMD5=base64.b64encode(hashlib.md5(body).digest()).decode("ascii"),
            IfNoneMatch="*",
        )
        response = client.get_object(Bucket=evidence.bucket, Key=key)
    stream = response["Body"]
    try:
        data = stream.read(_MANIFEST_MAX_BYTES + 1)
    finally:
        stream.close()
    if len(data) > _MANIFEST_MAX_BYTES:
        raise BackupFailure("remote backup recovery manifest exceeds its bound")
    if _RecoveryManifest.model_validate_json(data) != expected:
        raise BackupFailure("remote backup recovery manifest differs from the verified archive")


def _read_receipt(path: Path) -> _Receipt | None:
    if not path.exists():
        return None
    with path.open("rb") as stream:
        data = stream.read(_RECEIPT_MAX_BYTES + 1)
    if len(data) > _RECEIPT_MAX_BYTES:
        raise BackupFailure("backup receipt exceeds its bound")
    return _Receipt.model_validate_json(data)


def expired_archives(archives: Mapping[str, datetime], now: datetime) -> list[str]:
    """Name the archives retention deletes, oldest first.

    Keep every archive younger than seven days and the newest one at least seven
    days old. Keeping the young ones is what refreshes the aged one: each backup
    crosses seven days in turn and replaces it, so with nightly backups the
    oldest kept archive is seven to eight days old. The newest archive always stays.
    """
    aged = sorted(
        (created, key) for key, created in archives.items() if now - created >= _RETENTION
    )
    return [key for _, key in aged[:-1]]


def _archives(client: BaseClient, bucket: str) -> dict[str, datetime]:
    """Every archive in the bucket, with R2's LastModified for its `.dump` object."""
    archives: dict[str, datetime] = {}
    for page in client.get_paginator("list_objects_v2").paginate(Bucket=bucket):
        for item in page.get("Contents", []):
            if item["Key"].endswith("/database.dump"):
                archives[item["Key"]] = item["LastModified"]
    return archives


def _prune(client: BaseClient, *, bucket: str, receipt_root: Path) -> list[str]:
    """Delete each expired archive with its recovery manifest and host receipt."""
    expired = expired_archives(_archives(client, bucket), datetime.now(UTC))
    for key in expired:
        prefix = key.removesuffix("/database.dump")
        # release.py keeps the receipt of releases/<sha> at <root>/<sha>; the
        # nightly job keeps nightly/<date> at <root>/nightly/<date>. A
        # maintenance receipt lives wherever its operator put it.
        receipt = None
        if re.fullmatch(r"releases/[0-9a-f]{40}", prefix):
            receipt = receipt_root / prefix.removeprefix("releases/")
        elif re.fullmatch(r"nightly/[0-9]{4}-[0-9]{2}-[0-9]{2}", prefix):
            receipt = receipt_root / prefix
        if receipt is not None and receipt.exists():
            shutil.rmtree(receipt)
        # The archive object goes last: an interrupted prune leaves it listed,
        # so the next prune finishes what this one started.
        client.delete_object(Bucket=bucket, Key=f"{prefix}/database.json")
        client.delete_object(Bucket=bucket, Key=key)
    return expired


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("check")
    create = commands.add_parser("create")
    verify = commands.add_parser("verify")
    nightly = commands.add_parser("nightly")
    prune = commands.add_parser("prune")
    for command in (create, verify):
        command.add_argument("--backup-key", required=True)
        command.add_argument("--database-identity", required=True)
        command.add_argument("--starting-revision", required=True)
    for command in (create, verify, nightly):
        command.add_argument("--source-sha", required=True)
    for command in (nightly, prune):
        command.add_argument("--receipt-root", required=True, type=Path)
    create.add_argument("--state-directory", required=True, type=Path)
    verify.add_argument("--sha256", required=True)
    verify.add_argument("--byte-count", required=True, type=int)
    args = parser.parse_args()
    signal.signal(signal.SIGALRM, _interrupt)
    signal.signal(signal.SIGTERM, _interrupt)
    signal.alarm(_TIMEOUT_SECONDS)
    try:
        if args.command == "nightly":
            # Nightly is `create` with derived inputs: one archive per UTC day.
            # A rerun that day resumes or verifies it as recorded, even after a
            # release has since moved the database.
            day = datetime.now(UTC).strftime("%Y-%m-%d")
            args.backup_key = f"nightly/{day}/database.dump"
            args.state_directory = args.receipt_root / "nightly" / day
            args.state_directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            recorded = _read_receipt(args.state_directory / "receipt.json")
            if recorded is None:
                args.database_identity = database_identity(_psql)
                args.starting_revision = database_revision(_psql)
            else:
                args.source_sha = recorded.source_sha
                args.database_identity = recorded.evidence.database_identity
                args.starting_revision = recorded.evidence.starting_revision
        if args.command not in {"check", "prune"} and (
            re.fullmatch(r"[0-9a-f]{40}", args.source_sha) is None
            or re.fullmatch(r"[0-9a-z][0-9a-z_]{0,63}", args.starting_revision) is None
            or re.fullmatch(r"[^\r\n]+:[0-9]+", args.database_identity) is None
            or len(args.backup_key) > 1024
            or re.fullmatch(r"(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*/)+database\.dump", args.backup_key)
            is None
        ):
            raise BackupFailure("backup source, key or database identity is malformed")
        endpoint = os.environ["R2_BACKUP_S3_API_ORIGIN"]
        parsed = urlsplit(endpoint)
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or not parsed.hostname.endswith(".r2.cloudflarestorage.com")
            or parsed.username is not None
            or parsed.password is not None
            or parsed.port is not None
            or parsed.path
            or parsed.query
            or parsed.fragment
        ):
            raise BackupFailure("backup endpoint is not an exact R2 HTTPS origin")
        bucket = os.environ["R2_BACKUP_BUCKET"]
        if re.fullmatch(r"[a-z0-9][a-z0-9-]{1,61}[a-z0-9]", bucket) is None:
            raise BackupFailure("backup bucket name is malformed")
        client = boto3.client(
            "s3",
            endpoint_url=endpoint,
            aws_access_key_id=os.environ["R2_BACKUP_ACCESS_KEY_ID"],
            aws_secret_access_key=os.environ["R2_BACKUP_SECRET_ACCESS_KEY"],
            region_name="auto",
            config=Config(
                signature_version="s3v4",
                s3={"addressing_style": "path"},
                connect_timeout=10,
                read_timeout=60,
                # Durable helper replay owns retries; no hidden SDK replay budget.
                retries={"total_max_attempts": 1},
                request_checksum_calculation="when_required",
                response_checksum_validation="when_required",
            ),
        )
        try:
            if args.command == "check":
                archives = _archives(client, bucket)
                newest = max(archives, key=archives.__getitem__, default=None)
                last_modified = None if newest is None else archives[newest].isoformat()
                print(json.dumps({"newest_archive": newest, "last_modified": last_modified}))
                return
            if args.command == "prune":
                deleted = _prune(client, bucket=bucket, receipt_root=args.receipt_root)
                print(json.dumps({"deleted": deleted}))
                return
            identity = {
                "endpoint": endpoint,
                "bucket": bucket,
                "key": args.backup_key,
                "database_identity": args.database_identity,
                "starting_revision": args.starting_revision,
            }
            if args.command in {"create", "nightly"}:
                path = args.state_directory / "receipt.json"
                receipt = _read_receipt(path)
                if receipt is None:
                    receipt = _create_receipt(
                        client,
                        **identity,
                        source_sha=args.source_sha,
                        path=path,
                    )
                elif receipt.source_sha != args.source_sha or any(
                    getattr(receipt.evidence, name) != value for name, value in identity.items()
                ):
                    raise BackupFailure("backup receipt belongs to a different release input")
                evidence = receipt.evidence
                # A prior process may have died after linking its receipt but
                # before syncing the directory. Replay completes that prefix.
                _sync_directory(path.parent)
                if not _head_exists(client, bucket=bucket, key=evidence.key):
                    client.complete_multipart_upload(
                        Bucket=bucket,
                        Key=evidence.key,
                        UploadId=receipt.upload_id,
                        MultipartUpload={
                            "Parts": [
                                {"PartNumber": part.part_number, "ETag": part.etag}
                                for part in receipt.parts
                            ]
                        },
                    )
            else:
                evidence = BackupEvidence(
                    **identity, sha256=args.sha256, byte_count=args.byte_count
                )
            _verify(client, source_sha=args.source_sha, evidence=evidence)
            _require_recovery_manifest(
                client,
                source_sha=args.source_sha,
                evidence=evidence,
                publish=args.command != "verify",
            )
            if args.command == "nightly":
                deleted = _prune(client, bucket=bucket, receipt_root=args.receipt_root)
                print(json.dumps({"evidence": evidence.model_dump(), "deleted": deleted}))
            else:
                print(evidence.model_dump_json())
        finally:
            client.close()
    except BackupFailure as exc:
        print(f"backup failed: {exc}", file=sys.stderr)
        raise SystemExit(1) from None
    except ClientError as exc:
        raw_code = exc.response.get("Error", {}).get("Code", "unknown")
        code = (
            raw_code
            if isinstance(raw_code, str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", raw_code)
            else "unknown"
        )
        print(f"backup {args.command} failed: R2 {code}", file=sys.stderr)
        raise SystemExit(1) from None
    except (
        BotoCoreError,
        OSError,
        ValueError,
        KeyError,
        ValidationError,
        subprocess.SubprocessError,
    ) as exc:
        # Provider/process exceptions can contain credentials or private inputs.
        print(f"backup {args.command} failed: {type(exc).__name__}", file=sys.stderr)
        raise SystemExit(1) from None
    finally:
        signal.alarm(0)


if __name__ == "__main__":
    main()
