"""Backfill immutable source digests and remove the provisional-upload schema.

Revision ID: 0217
Revises: 0216
Create Date: 2026-08-14
"""

from __future__ import annotations

import hashlib
import os
from collections.abc import Sequence

import boto3
import sqlalchemy as sa
from alembic import op
from botocore.client import Config
from botocore.exceptions import BotoCoreError, ClientError

revision: str = "0217"
down_revision: str | Sequence[str] | None = "0216"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_SIGNATURES = {"pdf": b"%PDF-", "epub": b"PK\x03\x04"}
_CHUNK_BYTES = 8 * 1024 * 1024


def _required_environment(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"0217 backfill requires {name}")
    return value


def _storage_client():
    return boto3.client(
        "s3",
        endpoint_url=_required_environment("R2_S3_API_ORIGIN").rstrip("/"),
        aws_access_key_id=_required_environment("R2_ACCESS_KEY_ID"),
        aws_secret_access_key=_required_environment("R2_SECRET_ACCESS_KEY"),
        region_name=os.environ.get("R2_REGION") or "auto",
        config=Config(
            signature_version="s3v4",
            s3={"addressing_style": "path"},
            request_checksum_calculation="when_required",
            response_checksum_validation="when_required",
            connect_timeout=5,
            read_timeout=30,
        ),
    )


def _measure_source(*, client, bucket: str, media_id: object, path: str, kind: str, size: int) -> str:
    expected_signature = _SIGNATURES.get(kind)
    if expected_signature is None:
        raise RuntimeError(f"0217 backfill: media_file {media_id} has unsupported kind {kind!r}")
    try:
        metadata = client.head_object(Bucket=bucket, Key=path)
        stored_size = int(metadata.get("ContentLength") or 0)
        if stored_size != size:
            raise RuntimeError(
                f"0217 backfill: media_file {media_id} size changed "
                f"(database={size}, storage={stored_size})"
            )
        response = client.get_object(Bucket=bucket, Key=path)
        body = response["Body"]
        digest = hashlib.sha256()
        prefix = bytearray()
        measured_size = 0
        try:
            while chunk := body.read(_CHUNK_BYTES):
                if len(prefix) < len(expected_signature):
                    prefix.extend(chunk[: len(expected_signature) - len(prefix)])
                measured_size += len(chunk)
                digest.update(chunk)
        finally:
            body.close()
    except (BotoCoreError, ClientError, OSError) as exc:
        raise RuntimeError(
            f"0217 backfill: failed to read media_file {media_id} object {path!r}"
        ) from exc
    if measured_size != size:
        raise RuntimeError(
            f"0217 backfill: media_file {media_id} stream size changed "
            f"(database={size}, storage={measured_size})"
        )
    if bytes(prefix) != expected_signature:
        raise RuntimeError(
            f"0217 backfill: media_file {media_id} object {path!r} has an invalid {kind} signature"
        )
    return digest.hexdigest()


def _backfill_source_digests() -> None:
    bind = op.get_bind()
    rows = bind.execute(
        sa.text(
            """
            SELECT mf.media_id, mf.storage_path, mf.size_bytes, m.kind
            FROM media_file mf
            JOIN media m ON m.id = mf.media_id
            WHERE mf.source_sha256 IS NULL
               OR mf.source_sha256 !~ '^[0-9a-f]{64}$'
            ORDER BY mf.media_id
            """
        )
    ).mappings().all()
    if not rows:
        return
    client = _storage_client()
    bucket = _required_environment("R2_BUCKET")
    for row in rows:
        digest = _measure_source(
            client=client,
            bucket=bucket,
            media_id=row["media_id"],
            path=str(row["storage_path"]),
            kind=str(row["kind"]),
            size=int(row["size_bytes"]),
        )
        bind.execute(
            sa.text(
                "UPDATE media_file SET source_sha256 = :digest WHERE media_id = :media_id"
            ),
            {"digest": digest, "media_id": row["media_id"]},
        )


def _assert_no_active_source_publication_defects() -> None:
    """Reject legacy accepted work that has no single exact durable source job."""
    bind = op.get_bind()
    defects = bind.execute(
        sa.text(
            """
            SELECT msa.id
            FROM media_source_attempts msa
            LEFT JOIN background_jobs linked_job ON linked_job.id = msa.job_id
            CROSS JOIN LATERAL (
                SELECT count(*) AS exact_count
                FROM background_jobs exact_job
                WHERE exact_job.kind = 'ingest_media_source'
                  AND exact_job.payload @> jsonb_build_object(
                      'media_id', msa.media_id::text,
                      'attempt_id', msa.id::text
                  )
            ) exact_jobs
            WHERE msa.status IN ('accepted', 'queued', 'running')
              AND (
                  linked_job.id IS NULL
                  OR linked_job.kind <> 'ingest_media_source'
                  OR linked_job.status NOT IN ('pending', 'failed', 'running', 'dead')
                  OR NOT (
                      linked_job.payload @> jsonb_build_object(
                          'media_id', msa.media_id::text,
                          'attempt_id', msa.id::text
                      )
                  )
                  OR exact_jobs.exact_count <> 1
              )
            ORDER BY msa.id
            """
        )
    ).scalars().all()
    if defects:
        raise RuntimeError(
            "0217 preflight: active source publication defects require exact operator cleanup: "
            + ", ".join(str(attempt_id) for attempt_id in defects)
        )


def upgrade() -> None:
    # Each measured row is committed independently. If one object is missing or
    # changed, the revision remains at 0216 and a rerun skips completed rows.
    with op.get_context().autocommit_block():
        _backfill_source_digests()

    bind = op.get_bind()
    invalid = bind.execute(
        sa.text(
            """
            SELECT media_id
            FROM media_file
            WHERE source_sha256 IS NULL
               OR source_sha256 !~ '^[0-9a-f]{64}$'
            ORDER BY media_id
            """
        )
    ).scalars().all()
    if invalid:
        raise RuntimeError(
            "0217 preflight: media_file source_sha256 backfill is incomplete: "
            + ", ".join(str(media_id) for media_id in invalid)
        )

    # The removed signed-upload column was the only durable marker for an old
    # provisional upload. Do not strand or invent work at the hard cut: an
    # operator must resolve every active attempt that was never atomically bound
    # to one exact source job before this legacy state can be discarded.
    _assert_no_active_source_publication_defects()

    op.alter_column("media_file", "source_sha256", existing_type=sa.Text(), nullable=False)
    op.execute("DROP INDEX IF EXISTS idx_media_stale_pending_upload_cleanup")
    op.drop_column("media_source_attempts", "signed_upload_expires_at")
    op.execute(
        """
        UPDATE background_jobs
        SET payload = jsonb_set(payload, '{ownerKind}', '"Media"'::jsonb, true),
            updated_at = now()
        WHERE kind = 'storage_object_cleanup'
          AND payload ? 'mediaId'
          AND NOT payload ? 'ownerKind'
        """
    )


def downgrade() -> None:
    raise NotImplementedError("0217 is an irreversible document-import hard cutover")
