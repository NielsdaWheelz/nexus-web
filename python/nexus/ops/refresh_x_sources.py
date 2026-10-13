"""Freeze and refresh the existing X census through ordinary replayable source admission.

python -m nexus.ops.refresh_x_sources plan|apply --manifest /path/to/receipts.json
Run apply again to observe settlement; workers and exact-job repair remain ordinary owners.
"""

from __future__ import annotations

import argparse
import json
import os
from collections import Counter
from pathlib import Path
from uuid import UUID, uuid4

from pydantic import AwareDatetime, BaseModel, ConfigDict, JsonValue
from sqlalchemy import select, text
from sqlalchemy.orm import Session, sessionmaker

from nexus.db.models import Media, MediaSourceAttempt, MediaSourceAttemptStatus
from nexus.db.models import XSourceSnapshot as StoredXSourceSnapshot
from nexus.db.session import get_session_factory
from nexus.errors import ApiError, ApiErrorCode
from nexus.jobs.queue import get_job, jobs_for_payload
from nexus.schemas.media import SourceRefreshAdmission
from nexus.schemas.metadata_enrichment import MetadataOperationOut, TitleMetadataJobPayload
from nexus.services.media import get_media_for_viewer
from nexus.services.media_source_ingest import refresh_source_for_viewer
from nexus.services.media_source_types import X_POST
from nexus.services.metadata_operations import metadata_operations_for_jobs
from nexus.services.source_publication import latest_source_attempt_id
from nexus.services.x_source import has_retained_x_publication


class _Record(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)


class Refusal(_Record):
    code: str
    message: str


class SourceReceipt(_Record):
    source_attempt_id: UUID
    job_id: UUID | None
    attempt_status: MediaSourceAttemptStatus
    job_status: str | None
    error_code: str | None
    result: dict[str, JsonValue] | None
    saved_copy_kept: bool


class TitleReceipt(_Record):
    media_id: UUID
    source_attempt_id: UUID
    operation: MetadataOperationOut


class RefreshTarget(_Record):
    media_id: UUID
    creator_id: UUID | None
    expected_attempt_id: UUID | None
    client_mutation_id: UUID
    preview_refusal: Refusal | None
    admission: SourceRefreshAdmission | None
    inline_parent_attempt_id: UUID | None
    refusal: Refusal | None
    source: SourceReceipt | None
    title: TitleReceipt | None


class RefreshManifest(_Record):
    created_at: AwareDatetime
    targets: tuple[RefreshTarget, ...]
    child_titles: tuple[TitleReceipt, ...]


def plan_manifest(*, session_factory: sessionmaker[Session]) -> RefreshManifest:
    """Read one frozen native-X census; perform no admission or publication."""
    targets = []
    with session_factory() as db:
        db.connection(execution_options={"isolation_level": "REPEATABLE READ"})
        db.execute(text("SET TRANSACTION READ ONLY"))
        created_at = db.scalar(text("SELECT clock_timestamp()"))
        for media in db.scalars(
            select(Media)
            .where(Media.kind == "web_article", Media.provider == "x")
            .order_by(Media.id)
        ):
            creator = media.created_by_user_id
            attempt = latest_source_attempt_id(db, media.id)
            refusal: Refusal | None = None
            if creator is None:
                refusal = Refusal(code="missing_creator", message="media has no creator")
            elif attempt is None:
                refusal = Refusal(code="missing_attempt", message="media has no source attempt")
            else:
                try:
                    detail = get_media_for_viewer(db, creator, media.id)
                    if not detail.capabilities.can_refresh_source:
                        refusal = Refusal(
                            code="refresh_unavailable",
                            message="ordinary source refresh is unavailable",
                        )
                except ApiError as exc:
                    if exc.code == ApiErrorCode.E_INTERNAL:
                        raise
                    refusal = Refusal(code=exc.code.value, message=exc.message)
            targets.append(
                RefreshTarget(
                    media_id=media.id,
                    creator_id=creator,
                    expected_attempt_id=attempt,
                    client_mutation_id=uuid4(),
                    preview_refusal=refusal,
                    admission=None,
                    inline_parent_attempt_id=None,
                    refusal=None,
                    source=None,
                    title=None,
                )
            )
    return RefreshManifest(created_at=created_at, targets=tuple(targets), child_titles=())


def save_manifest(path: Path, manifest: RefreshManifest, *, new: bool) -> None:
    """Persist request identities before dispatch and replace receipts atomically."""
    destination = path if new else path.with_name(path.name + ".tmp")
    with destination.open("x" if new else "w") as stream:
        stream.write(manifest.model_dump_json(indent=2) + "\n")
        stream.flush()
        os.fsync(stream.fileno())
    if not new:
        os.replace(destination, path)
    descriptor = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def apply_manifest(path: Path, *, session_factory: sessionmaker[Session]) -> RefreshManifest:
    """Resume identical requests and record observed outcomes; never run or replace workers."""
    manifest = RefreshManifest.model_validate_json(path.read_bytes())
    targets = list(manifest.targets)
    children = {(item.media_id, item.source_attempt_id): item for item in manifest.child_titles}
    for index, target in enumerate(targets):
        inspected = target.expected_attempt_id
        if target.admission is not None:
            inspected = target.admission.source_attempt_id
        elif target.inline_parent_attempt_id is not None:
            # justify-defect: an observed inline completion retains its exact source receipt.
            assert target.source is not None
            inspected = target.source.source_attempt_id
        else:
            parent_attempt_ids = {
                str(item.admission.source_attempt_id): item.admission.source_attempt_id
                for item in targets
                if item.admission is not None
            }
            if (
                parent_attempt_ids
                and target.creator_id is not None
                and target.expected_attempt_id is not None
            ):
                with session_factory() as db:
                    db.connection(execution_options={"isolation_level": "REPEATABLE READ"})
                    db.execute(text("SET TRANSACTION READ ONLY"))
                    inline = db.scalar(
                        select(MediaSourceAttempt)
                        .join(
                            StoredXSourceSnapshot,
                            (StoredXSourceSnapshot.source_attempt_id == MediaSourceAttempt.id)
                            & (StoredXSourceSnapshot.media_id == MediaSourceAttempt.media_id),
                        )
                        .where(
                            MediaSourceAttempt.media_id == target.media_id,
                            MediaSourceAttempt.source_type == X_POST,
                            MediaSourceAttempt.status == MediaSourceAttemptStatus.succeeded,
                            StoredXSourceSnapshot.published_at >= manifest.created_at,
                            MediaSourceAttempt.source_payload[
                                "parent_source_attempt_id"
                            ].astext.in_(parent_attempt_ids.keys()),
                        )
                    )
                    if (
                        inline is not None
                        and latest_source_attempt_id(db, target.media_id) == inline.id
                    ):
                        parent_id = inline.source_payload["parent_source_attempt_id"]
                        # justify-defect: the query matched a recorded parent attempt's UUID text.
                        assert isinstance(parent_id, str)
                        inspected = inline.id
                        target = target.model_copy(
                            update={
                                "inline_parent_attempt_id": parent_attempt_ids[parent_id],
                                "refusal": None,
                            }
                        )
        if target.admission is None and target.inline_parent_attempt_id is None:
            if target.creator_id is None or target.expected_attempt_id is None:
                target = target.model_copy(update={"refusal": target.preview_refusal})
            else:
                try:
                    with session_factory() as db:
                        admission = refresh_source_for_viewer(
                            db=db,
                            viewer_id=target.creator_id,
                            media_id=target.media_id,
                            client_mutation_id=str(target.client_mutation_id),
                            expected_attempt_id=target.expected_attempt_id,
                            request_id=None,
                        )
                    target = target.model_copy(update={"admission": admission, "refusal": None})
                    inspected = admission.source_attempt_id
                except ApiError as exc:
                    if exc.code == ApiErrorCode.E_INTERNAL:
                        raise
                    target = target.model_copy(
                        update={"refusal": Refusal(code=exc.code.value, message=exc.message)}
                    )
        if inspected is not None:
            with session_factory() as db:
                db.connection(execution_options={"isolation_level": "REPEATABLE READ"})
                db.execute(text("SET TRANSACTION READ ONLY"))
                attempt = db.get(MediaSourceAttempt, inspected)
                if target.admission is not None:
                    # justify-defect: an admitted source and its retained job identity must exist.
                    assert attempt is not None and attempt.job_id == target.admission.job_id
                if attempt is not None:
                    job = get_job(db, attempt.job_id) if attempt.job_id is not None else None
                    # justify-defect: a source attempt's retained queue identity must resolve.
                    assert attempt.job_id is None or job is not None
                    source = SourceReceipt(
                        source_attempt_id=attempt.id,
                        job_id=attempt.job_id,
                        attempt_status=MediaSourceAttemptStatus(attempt.status),
                        job_status=None if job is None else job.status,
                        error_code=attempt.error_code,
                        result=None if job is None else job.result,
                        saved_copy_kept=has_retained_x_publication(db, media_id=target.media_id),
                    )
                    target = target.model_copy(update={"source": source})
                    if (
                        target.admission is not None or target.inline_parent_attempt_id is not None
                    ) and source.attempt_status == MediaSourceAttemptStatus.succeeded:
                        assert target.creator_id is not None
                        title = _title_receipt(
                            db,
                            viewer_id=target.creator_id,
                            media_id=target.media_id,
                            source_attempt_id=inspected,
                        )
                        target = target.model_copy(update={"title": title})
        targets[index] = target
        manifest = manifest.model_copy(
            update={"targets": tuple(targets), "child_titles": tuple(children.values())}
        )
        save_manifest(path, manifest, new=False)
    # Jobs retain every inline child obligation even after later source replacement.
    # Unrelated admissions stay paused while workers execute the frozen census.
    with session_factory() as db:
        rows = db.execute(
            text("""
            SELECT DISTINCT ON (source.media_id, source.id) job.id, job.payload
            FROM background_jobs job
            JOIN media_source_attempts source
              ON source.id = (job.payload->>'source_attempt_id')::uuid
            WHERE job.kind = 'enrich_metadata' AND job.payload->>'purpose' = 'title'
              AND job.created_at >= :created_at
              AND (source.media_id = ANY(:media_ids)
                   OR source.source_payload->>'parent_media_id' = ANY(:parent_ids))
            ORDER BY source.media_id, source.id, job.created_at, job.id
        """),
            {
                "created_at": manifest.created_at,
                "media_ids": [item.media_id for item in targets],
                "parent_ids": [str(item.media_id) for item in targets],
            },
        ).all()
        parent_jobs = {item.title.operation.job_id for item in targets if item.title is not None}
        for row in rows:
            if row.id in parent_jobs:
                continue
            payload = TitleMetadataJobPayload.model_validate_json(json.dumps(row.payload))
            operation = metadata_operations_for_jobs(
                db, viewer_id=payload.requester_user_id, job_ids=[row.id]
            )[row.id]
            receipt = TitleReceipt(
                media_id=payload.media_id,
                source_attempt_id=payload.source_attempt_id,
                operation=operation,
            )
            children[(receipt.media_id, receipt.source_attempt_id)] = receipt
        children = {
            key: item for key, item in children.items() if item.operation.job_id not in parent_jobs
        }
    manifest = manifest.model_copy(update={"child_titles": tuple(children.values())})
    save_manifest(path, manifest, new=False)
    return manifest


def _title_receipt(
    db: Session, *, viewer_id: UUID, media_id: UUID, source_attempt_id: UUID
) -> TitleReceipt | None:
    jobs = jobs_for_payload(
        db,
        kind="enrich_metadata",
        match={
            "media_id": str(media_id),
            "purpose": "title",
            "source_attempt_id": str(source_attempt_id),
        },
    )
    if not jobs:
        return None
    first = jobs[0]
    operation = metadata_operations_for_jobs(db, viewer_id=viewer_id, job_ids=[first.id])[first.id]
    return TitleReceipt(media_id=media_id, source_attempt_id=source_attempt_id, operation=operation)


def report(manifest: RefreshManifest) -> dict[str, int | bool]:
    counts: Counter[str] = Counter(
        {
            "targets": len(manifest.targets),
            "refreshed": 0,
            "unavailable_preserved": 0,
            "blocked_or_failed": 0,
            "unfinished": 0,
            "unaccounted": 0,
            "title_failed": 0,
            "child_titles": len(manifest.child_titles),
        }
    )
    for target in manifest.targets:
        if target.source is not None and (
            target.source.attempt_status
            not in {MediaSourceAttemptStatus.succeeded, MediaSourceAttemptStatus.failed}
            or (
                target.source.job_status is not None
                and target.source.job_status not in {"succeeded", "dead"}
            )
        ):
            counts["unfinished"] += 1
        elif target.admission is None and target.inline_parent_attempt_id is None:
            counts["blocked_or_failed" if target.refusal is not None else "unaccounted"] += 1
        elif target.source is None:
            counts["unaccounted"] += 1
        elif target.source.attempt_status == MediaSourceAttemptStatus.failed:
            source = target.source
            unavailable = (
                source.error_code == ApiErrorCode.E_X_POST_UNAVAILABLE.value
                and source.saved_copy_kept
            )
            counts["unavailable_preserved" if unavailable else "blocked_or_failed"] += 1
        elif target.title is None:
            counts["unaccounted"] += 1
        elif target.title.operation.status not in {"completed", "failed"}:
            counts["unfinished"] += 1
        else:
            counts["refreshed"] += 1
            counts["title_failed"] += target.title.operation.status == "failed"
    for receipt in manifest.child_titles:
        if receipt.operation.status not in {"completed", "failed"}:
            counts["unfinished"] += 1
        counts["title_failed"] += receipt.operation.status == "failed"
    return {**counts, "release_accounted": counts["unfinished"] == 0 and counts["unaccounted"] == 0}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("plan", "apply"))
    parser.add_argument("--manifest", required=True, type=Path)
    args = parser.parse_args()
    factory = get_session_factory()
    if args.command == "plan":
        manifest = plan_manifest(session_factory=factory)
        save_manifest(args.manifest, manifest, new=True)
        summary = {
            "targets": len(manifest.targets),
            "preview_refusals": dict(
                Counter(
                    item.preview_refusal.code
                    for item in manifest.targets
                    if item.preview_refusal is not None
                )
            ),
        }
    else:
        manifest = apply_manifest(args.manifest, session_factory=factory)
        summary = report(manifest)
    print(json.dumps(summary, sort_keys=True))


if __name__ == "__main__":
    main()
