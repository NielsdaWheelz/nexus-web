"""Single container-internal owner for current Oracle publication support."""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from uuid import UUID

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from nexus.config import ORACLE_RECONCILE_JOB_KINDS
from nexus.db.models import (
    ContentIndexState,
    Media,
    MediaSourceAttempt,
    OraclePlate,
    ProcessingStatus,
)
from nexus.db.session import get_session_factory
from nexus.errors import ApiError
from nexus.jobs.queue import get_job
from nexus.jobs.worker import JobWorker
from nexus.oracle.manifest import (
    OracleManifest,
    OraclePlateManifestEntry,
    load_oracle_manifest,
    oracle_plate_storage_slug,
)
from nexus.release_artifact import RuntimeIdentity
from nexus.runtime_health import get_runtime_identity
from nexus.services import oracle_corpus, oracle_plates
from nexus.services.content_indexing import (
    ensure_media_content_reindex_job,
    request_media_content_reindex,
)
from nexus.services.image_validation import fetch_validated_image
from nexus.services.ingest_recovery import (
    retry_dead_content_index_job,
    retry_dead_source_job,
)
from nexus.services.semantic_chunks import (
    current_transcript_embedding_model,
    current_transcript_embedding_provider,
)
from nexus.storage.client import StorageClientBase, StorageError, get_storage_client
from nexus.storage.paths import build_oracle_plate_storage_path, ext_for_content_type


@dataclass(frozen=True)
class OracleReconcileInputs:
    manifest_directory: Path
    expected_manifest_digest: str
    manifest: OracleManifest
    runtime_identity: RuntimeIdentity


@dataclass(frozen=True)
class _PlateSnapshot:
    metadata: oracle_plates.OraclePlateMetadata


def bind_oracle_reconcile_inputs(
    *,
    manifest_directory: Path,
    expected_manifest_digest: str,
    runtime_identity: RuntimeIdentity | None = None,
) -> OracleReconcileInputs:
    """Bind explicit operator inputs to both reviewed bytes and baked runtime identity."""
    if not manifest_directory.is_absolute():
        raise ValueError("Oracle manifest directory must be an absolute path")
    manifest = load_oracle_manifest(manifest_directory)
    if manifest.manifest_digest != expected_manifest_digest:
        raise ValueError(
            "Oracle manifest differs from the recorded expected Oracle manifest digest"
        )
    runtime = runtime_identity or get_runtime_identity()
    if runtime.expected_oracle_manifest_digest != expected_manifest_digest:
        raise ValueError("Oracle manifest differs from the baked runtime identity")
    return OracleReconcileInputs(
        manifest_directory=manifest_directory,
        expected_manifest_digest=expected_manifest_digest,
        manifest=manifest,
        runtime_identity=runtime,
    )


def inspect_current_oracle(
    *,
    session_factory: sessionmaker[Session],
    storage_client: StorageClientBase,
    manifest: OracleManifest,
    owner_user_id: UUID,
) -> oracle_corpus.OracleCorpusInspection:
    """Close the PostgreSQL read transaction before proving the R2 snapshot."""
    with session_factory() as db:
        database = oracle_corpus.inspect_oracle_corpus_database(
            db,
            manifest=manifest,
            owner_user_id=owner_user_id,
        )
    return oracle_corpus.complete_oracle_corpus_inspection(
        database,
        storage_client=storage_client,
    )


def preflight_oracle_reconcile(
    *, session_factory: sessionmaker[Session], manifest: OracleManifest
) -> oracle_corpus.OracleCorpusRemovalPlan:
    """Reject unsupported removals before the host creates a mutating attempt."""
    with session_factory() as db:
        return oracle_corpus.reject_oracle_manifest_removals(db, manifest=manifest)


def reconcile_oracle_support(
    *,
    session_factory: sessionmaker[Session],
    storage_client: StorageClientBase,
    manifest: OracleManifest,
    owner_user_id: UUID,
) -> dict[str, object]:
    """Converge additive/update support while the host keeps every writer stopped."""
    preflight_oracle_reconcile(session_factory=session_factory, manifest=manifest)
    media_ids = _reconcile_corpus_database(
        session_factory=session_factory,
        manifest=manifest,
        owner_user_id=owner_user_id,
    )
    source_job_ids = _pending_source_job_ids(
        session_factory=session_factory,
        media_ids=media_ids,
    )
    _run_exact_jobs(session_factory=session_factory, job_ids=source_job_ids)
    index_job_ids = _ensure_index_job_ids(
        session_factory=session_factory,
        media_ids=media_ids,
    )
    _run_exact_jobs(session_factory=session_factory, job_ids=index_job_ids)
    _resolve_anchors(session_factory=session_factory)
    plate_writes = _reconcile_plates(
        session_factory=session_factory,
        storage_client=storage_client,
        manifest=manifest,
    )
    return {
        "media_ids": [str(media_id) for media_id in media_ids],
        "source_job_ids": [str(job_id) for job_id in source_job_ids],
        "index_job_ids": [str(job_id) for job_id in index_job_ids],
        "plate_object_writes": plate_writes,
    }


def _reconcile_corpus_database(
    *,
    session_factory: sessionmaker[Session],
    manifest: OracleManifest,
    owner_user_id: UUID,
) -> tuple[UUID, ...]:
    with session_factory() as db:
        oracle_corpus.require_oracle_corpus_unpublished(db)
        library_id = oracle_corpus.ensure_oracle_corpus_library(
            db,
            owner_user_id=owner_user_id,
        )
        db.commit()
    media_ids: list[UUID] = []
    for work in manifest.works:
        with session_factory() as db:
            result = oracle_corpus.ensure_oracle_corpus_media(
                db,
                owner_user_id=owner_user_id,
                library_id=library_id,
                work=work,
            )
            db.commit()
            media_ids.append(result.media_id)
    return tuple(media_ids)


def _pending_source_job_ids(
    *, session_factory: sessionmaker[Session], media_ids: tuple[UUID, ...]
) -> tuple[UUID, ...]:
    pending: list[UUID] = []
    suspended: list[tuple[UUID, UUID]] = []
    with session_factory() as db:
        for media_id in sorted(media_ids):
            media = db.get(Media, media_id)
            if media is None:
                raise RuntimeError(f"Oracle media {media_id} disappeared")
            if media.processing_status == ProcessingStatus.ready_for_reading:
                continue
            attempt = db.execute(
                select(MediaSourceAttempt)
                .where(MediaSourceAttempt.media_id == media_id)
                .order_by(
                    MediaSourceAttempt.attempt_no.desc(),
                    MediaSourceAttempt.created_at.desc(),
                    MediaSourceAttempt.id.desc(),
                )
                .limit(1)
            ).scalar_one_or_none()
            if attempt is None or attempt.job_id is None:
                raise RuntimeError(f"Oracle media {media_id} has no exact source job")
            if (
                attempt.source_payload.get("system_source")
                != oracle_corpus.ORACLE_CORPUS_SYSTEM_KEY
            ):
                raise RuntimeError(f"Oracle media {media_id} source job has foreign ownership")
            job = get_job(db, attempt.job_id)
            if job is None:
                raise RuntimeError(f"Oracle media {media_id} source job disappeared")
            if job.status == "dead":
                suspended.append((media_id, attempt.job_id))
            pending.append(attempt.job_id)
    for media_id, expected_job_id in suspended:
        replayed_job_id = retry_dead_source_job(media_id=media_id)
        if replayed_job_id != expected_job_id:
            raise RuntimeError(f"Oracle media {media_id} replayed a foreign source job")
    return tuple(dict.fromkeys(pending))


def _ensure_index_job_ids(
    *, session_factory: sessionmaker[Session], media_ids: tuple[UUID, ...]
) -> tuple[UUID, ...]:
    provider = current_transcript_embedding_provider()
    model = current_transcript_embedding_model()
    job_ids: list[UUID] = []
    suspended: list[tuple[UUID, UUID]] = []
    with session_factory() as db:
        for media_id in sorted(media_ids):
            media = db.get(Media, media_id)
            if media is None or media.processing_status != ProcessingStatus.ready_for_reading:
                raise RuntimeError(f"Oracle media {media_id} source ingest did not become readable")
            state = db.execute(
                select(ContentIndexState).where(
                    ContentIndexState.owner_kind == "media",
                    ContentIndexState.owner_id == media_id,
                )
            ).scalar_one_or_none()
            if (
                state is not None
                and state.status == "ready"
                and state.active_embedding_provider == provider
                and state.active_embedding_model == model
            ):
                continue
            if state is None or state.status in {"ready", "failed", "no_text", "ocr_required"}:
                intent = request_media_content_reindex(
                    db,
                    media_id=media_id,
                    reason="reconciliation",
                    request_id=f"oracle-reconcile:{media_id}",
                )
            else:
                intent = ensure_media_content_reindex_job(
                    db,
                    media_id=media_id,
                    reason="reconciliation",
                    request_id=f"oracle-reconcile:{media_id}",
                )
            if intent.suspended:
                suspended.append((media_id, intent.background_job_id))
            job_ids.append(intent.background_job_id)
        db.commit()
    for media_id, expected_job_id in suspended:
        replayed_job_id = retry_dead_content_index_job(media_id=media_id)
        if replayed_job_id != expected_job_id:
            raise RuntimeError(f"Oracle media {media_id} replayed a foreign content-index job")
    return tuple(dict.fromkeys(job_ids))


def _run_exact_jobs(*, session_factory: sessionmaker[Session], job_ids: tuple[UUID, ...]) -> None:
    if not job_ids:
        return
    worker = JobWorker(
        session_factory=session_factory,
        worker_id="oracle-reconcile",
        allowed_kinds=ORACLE_RECONCILE_JOB_KINDS,
    )
    for job_id in sorted(job_ids):
        worker.run_exact(job_id)
        with session_factory() as db:
            job = get_job(db, job_id)
        if job is None or job.status != "succeeded":
            observed = "missing" if job is None else job.status
            raise RuntimeError(f"Oracle exact job {job_id} stopped in {observed!r} state")


def _resolve_anchors(*, session_factory: sessionmaker[Session]) -> None:
    with session_factory() as db:
        result = oracle_corpus.resolve_oracle_passage_anchors(db)
        db.commit()
    if result.failed:
        raise RuntimeError(
            f"Oracle anchor resolution failed for {result.failed}/{result.total} anchors"
        )


def _reconcile_plates(
    *,
    session_factory: sessionmaker[Session],
    storage_client: StorageClientBase,
    manifest: OracleManifest,
) -> int:
    writes = 0
    with httpx.Client(timeout=30.0, headers={"User-Agent": "nexus-oracle-reconcile"}) as client:
        for desired in manifest.plates:
            snapshot = _plate_snapshot(
                session_factory=session_factory,
                source_url=desired.resolved_source_url,
            )
            if snapshot is not None and _plate_object_is_reusable(
                snapshot,
                desired=desired,
                storage_client=storage_client,
            ):
                _upsert_plate_snapshot(
                    session_factory=session_factory,
                    desired=desired,
                    metadata=snapshot.metadata,
                )
                continue
            image = fetch_validated_image(desired.resolved_source_url, client)
            storage_key = build_oracle_plate_storage_path(
                oracle_plate_storage_slug(desired),
                ext_for_content_type(image.content_type),
            )
            if oracle_plates.ensure_oracle_plate_storage_object(
                storage_client=storage_client,
                storage_key=storage_key,
                content_type=image.content_type,
                data=image.data,
                width=image.width,
                height=image.height,
            ):
                writes += 1
            _upsert_plate_values(
                session_factory=session_factory,
                desired=desired,
                width=image.width,
                height=image.height,
                storage_key=storage_key,
                content_type=image.content_type,
                byte_size=len(image.data),
            )
    return writes


def _plate_snapshot(
    *, session_factory: sessionmaker[Session], source_url: str
) -> _PlateSnapshot | None:
    with session_factory() as db:
        row = db.execute(
            select(OraclePlate).where(OraclePlate.source_url == source_url)
        ).scalar_one_or_none()
        if row is None:
            return None
        return _PlateSnapshot(
            metadata=oracle_plates.OraclePlateMetadata(
                image_id=row.id,
                storage_key=row.storage_key,
                content_type=row.content_type,
                byte_size=row.byte_size,
                width=row.width,
                height=row.height,
                etag=f'"oracle-plate-{row.id}"',
            )
        )


def _plate_object_is_reusable(
    snapshot: _PlateSnapshot,
    *,
    desired: OraclePlateManifestEntry,
    storage_client: StorageClientBase,
) -> bool:
    try:
        expected_key = build_oracle_plate_storage_path(
            oracle_plate_storage_slug(desired),
            ext_for_content_type(snapshot.metadata.content_type),
        )
    except ValueError:
        return False
    if snapshot.metadata.storage_key != expected_key:
        return False
    return oracle_plates.validate_oracle_plate_storage_metadata(
        (snapshot.metadata,),
        storage_client=storage_client,
    ).ready


def _upsert_plate_snapshot(
    *,
    session_factory: sessionmaker[Session],
    desired: OraclePlateManifestEntry,
    metadata: oracle_plates.OraclePlateMetadata,
) -> None:
    _upsert_plate_values(
        session_factory=session_factory,
        desired=desired,
        width=metadata.width,
        height=metadata.height,
        storage_key=metadata.storage_key,
        content_type=metadata.content_type,
        byte_size=metadata.byte_size,
    )


def _upsert_plate_values(
    *,
    session_factory: sessionmaker[Session],
    desired: OraclePlateManifestEntry,
    width: int,
    height: int,
    storage_key: str,
    content_type: str,
    byte_size: int,
) -> None:
    with session_factory() as db:
        oracle_plates.upsert_oracle_plate(
            db,
            source_repository=desired.source_repository,
            source_page_url=desired.source_url,
            source_url=desired.resolved_source_url,
            license_text=desired.license_text,
            artist=desired.artist,
            work_title=desired.work_title,
            year=desired.year,
            attribution_text=desired.attribution_text,
            width=width,
            height=height,
            storage_key=storage_key,
            content_type=content_type,
            byte_size=byte_size,
            tags=list(desired.tags),
        )
        db.commit()


def _inspection_payload(inspection: oracle_corpus.OracleCorpusInspection) -> dict[str, object]:
    if inspection.support_ready and inspection.published:
        status = "published"
    elif inspection.support_ready:
        status = "ready_unpublished"
    else:
        status = "not_ready"
    publication = inspection.publication
    return {
        "status": status,
        "manifest_digest": inspection.manifest_digest,
        "embedding_provider": inspection.embedding_provider,
        "embedding_model": inspection.embedding_model,
        "support_ready": inspection.support_ready,
        "published": inspection.published,
        "publication": (
            None
            if publication is None
            else {
                "corpus_key": publication.corpus_key,
                "manifest_digest": publication.manifest_digest,
                "embedding_provider": publication.embedding_provider,
                "embedding_model": publication.embedding_model,
            }
        ),
        "errors": list(inspection.errors),
        "removals": {
            "work_keys": list(inspection.removals.work_keys),
            "anchor_keys": [list(key) for key in inspection.removals.anchor_keys],
            "plate_source_urls": list(inspection.removals.plate_source_urls),
        },
        "counts": {
            "works": inspection.readiness.work_count,
            "ready_media": inspection.readiness.ready_media_count,
            "anchors": inspection.readiness.anchor_count,
            "resolved_anchors": inspection.readiness.resolved_anchor_count,
            "plates": inspection.readiness.plate_count,
            "ready_plates": inspection.readiness.ready_plate_count,
        },
    }


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Reconcile the current Oracle publication")
    parser.add_argument(
        "command",
        choices=("status", "preflight", "unpublish", "reconcile-support", "publish"),
    )
    parser.add_argument("--manifest-directory", required=True, type=Path)
    parser.add_argument("--expected-manifest-digest", required=True)
    parser.add_argument("--owner-user", type=UUID)
    return parser


def _require_owner_user(command: str, owner_user_id: UUID | None) -> UUID:
    if owner_user_id is None:
        raise ValueError(f"--owner-user is required for Oracle {command}")
    return owner_user_id


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        inputs = bind_oracle_reconcile_inputs(
            manifest_directory=args.manifest_directory,
            expected_manifest_digest=args.expected_manifest_digest,
        )
        session_factory = get_session_factory()
        if args.command == "status":
            owner_user_id = _require_owner_user(args.command, args.owner_user)
            storage_client = get_storage_client()
            payload = _inspection_payload(
                inspect_current_oracle(
                    session_factory=session_factory,
                    storage_client=storage_client,
                    manifest=inputs.manifest,
                    owner_user_id=owner_user_id,
                )
            )
        elif args.command == "preflight":
            plan = preflight_oracle_reconcile(
                session_factory=session_factory,
                manifest=inputs.manifest,
            )
            payload = {
                "status": "accepted",
                "manifest_digest": inputs.expected_manifest_digest,
                "removals": plan.has_removals,
            }
        elif args.command == "unpublish":
            with session_factory() as db:
                changed = oracle_corpus.unpublish_oracle_corpus(db)
                db.commit()
            payload = {
                "status": "unpublished",
                "manifest_digest": inputs.expected_manifest_digest,
                "changed": changed,
            }
        elif args.command == "reconcile-support":
            owner_user_id = _require_owner_user(args.command, args.owner_user)
            storage_client = get_storage_client()
            result = reconcile_oracle_support(
                session_factory=session_factory,
                storage_client=storage_client,
                manifest=inputs.manifest,
                owner_user_id=owner_user_id,
            )
            payload = {
                "status": "support_reconciled",
                "manifest_digest": inputs.expected_manifest_digest,
                **result,
            }
        else:
            owner_user_id = _require_owner_user(args.command, args.owner_user)
            storage_client = get_storage_client()
            inspection = inspect_current_oracle(
                session_factory=session_factory,
                storage_client=storage_client,
                manifest=inputs.manifest,
                owner_user_id=owner_user_id,
            )
            with session_factory() as db:
                oracle_corpus.publish_oracle_corpus(db, inspection=inspection)
                db.commit()
            payload = {
                "status": "published",
                "manifest_digest": inputs.expected_manifest_digest,
            }
    except (ApiError, StorageError, httpx.HTTPError, RuntimeError, ValueError) as exc:
        print(
            json.dumps(
                {
                    "status": "error",
                    "error_type": type(exc).__name__,
                    "error": str(exc),
                },
                sort_keys=True,
                separators=(",", ":"),
            ),
            file=sys.stderr,
        )
        return 1
    print(json.dumps(payload, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
