"""Preview source-matched EPUB credit repairs; apply one exact reviewed preview."""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import asdict
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import defer

from nexus.auth.permissions import can_read_media, visible_media_ids_cte_sql
from nexus.db.models import Media, MediaFile, User
from nexus.db.retries import retry_serializable
from nexus.db.session import create_session_factory
from nexus.schemas.presence import Presence, Present, presence_from_nullable
from nexus.services.epub_contributor_repair import (
    EpubContributorRepairPreview,
    EpubContributorRepairSkipped,
    apply_epub_contributor_repair_in_current_transaction,
    prepare_epub_contributor_repair,
    preview_epub_contributor_repair,
)
from nexus.services.epub_ingest import (
    EpubExtractionError,
    EpubExtractionResult,
    extract_epub_metadata,
)
from nexus.services.parser_temp import (
    StorageObjectIntegrityError,
    parser_attempt_directory,
    stream_storage_object_to_file,
)
from nexus.storage.client import StorageError, get_storage_client


def repair_epub_contributors(
    *, viewer_id: UUID, media_ids: tuple[UUID, ...], preview_digest: Presence[str]
) -> int:
    applying = isinstance(preview_digest, Present)
    mode = "apply" if applying else "preview"
    factory = create_session_factory()
    with factory() as db:
        if db.get(User, viewer_id) is None:
            raise ValueError("viewer does not exist")
    after: UUID | None = None
    while True:
        with factory() as db:
            selection = select(Media.id).where(
                Media.kind == "epub", Media.id.in_(text(visible_media_ids_cte_sql()))
            )
            if media_ids:
                selection = selection.where(Media.id.in_(media_ids))
            if after is not None:
                selection = selection.where(Media.id > after)
            selected = tuple(
                db.scalars(selection.order_by(Media.id).limit(100), {"viewer_id": viewer_id})
            )
        if not selected:
            if applying and after is None:
                print(
                    json.dumps(
                        {
                            "media_id": str(media_ids[0]),
                            "mode": mode,
                            "status": "skipped",
                            "reason": "access_revoked",
                        }
                    )
                )
                return 1
            break
        for media_id in selected:
            payload: dict[str, object] = {"media_id": str(media_id), "mode": mode}
            with factory() as db:
                source = db.get(MediaFile, media_id)
                if source is None:
                    payload.update(status="skipped", reason="source_missing")
                    print(json.dumps(payload))
                    if applying:
                        return 1
                    continue
                fingerprint = (
                    source.storage_path,
                    source.source_sha256,
                    source.size_bytes,
                    source.content_type,
                )
            try:
                with parser_attempt_directory(media_id) as directory:
                    epub_path = directory / "source.epub"
                    stream_storage_object_to_file(
                        get_storage_client(),
                        storage_path=fingerprint[0],
                        destination=epub_path,
                        expected_size_bytes=fingerprint[2],
                        expected_source_sha256=fingerprint[1],
                    )
                    metadata = extract_epub_metadata(epub_path)
            except (StorageError, StorageObjectIntegrityError) as error:
                payload.update(status="skipped", reason="source_unavailable", code=error.code)
                print(json.dumps(payload))
                if applying:
                    return 1
                continue
            if isinstance(metadata, EpubExtractionError):
                payload.update(status="skipped", reason="source_invalid", code=metadata.error_code)
                print(json.dumps(payload))
                if applying:
                    return 1
                continue
            with factory() as db:

                def publish(
                    *,
                    expected_media_id: UUID = media_id,
                    expected_source: tuple[str, str, int, str] = fingerprint,
                    source_metadata: EpubExtractionResult = metadata,
                ) -> EpubContributorRepairPreview | EpubContributorRepairSkipped:
                    if not applying:
                        db.execute(
                            text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
                        )
                    selection = (
                        select(Media)
                        .options(defer(Media.plain_text))
                        .where(Media.id == expected_media_id)
                    )
                    media = db.scalar(selection.with_for_update() if applying else selection)
                    current_source = db.get(MediaFile, expected_media_id)
                    if media is None or not can_read_media(db, viewer_id, expected_media_id):
                        result = EpubContributorRepairSkipped("access_revoked")
                    elif (
                        media.kind != "epub"
                        or current_source is None
                        or (
                            current_source.storage_path,
                            current_source.source_sha256,
                            current_source.size_bytes,
                            current_source.content_type,
                        )
                        != expected_source
                    ):
                        result = EpubContributorRepairSkipped("source_changed")
                    else:
                        plan = prepare_epub_contributor_repair(
                            db, media=media, metadata=source_metadata
                        )
                        if isinstance(plan, EpubContributorRepairSkipped):
                            result = plan
                        elif isinstance(preview_digest, Present):
                            result = apply_epub_contributor_repair_in_current_transaction(
                                db,
                                media=media,
                                plan=plan,
                                viewer_id=viewer_id,
                                source=current_source,
                                preview_digest=preview_digest.value,
                            )
                        else:
                            result = preview_epub_contributor_repair(
                                db, plan=plan, viewer_id=viewer_id, source=current_source
                            )
                    if applying:
                        db.commit()
                    return result

                report = (
                    retry_serializable(db, "epub_contributor_repair.publish", publish)
                    if applying
                    else publish()
                )
            if isinstance(report, EpubContributorRepairSkipped):
                payload.update(status="skipped", reason=report.reason)
                if report.reason == "unrepresentable_observation":
                    payload["source_issues"] = [
                        asdict(issue) for issue in metadata.contributor_issues
                    ]
            else:
                payload.update(asdict(report.report))
                payload.update(preview=report.preview, preview_digest=report.preview_digest)
                payload["status"] = "changed" if report.report.changed else "unchanged"
            print(json.dumps(payload, ensure_ascii=False))
            if applying:
                return 1 if isinstance(report, EpubContributorRepairSkipped) else 0
        after = selected[-1]
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--viewer-id", type=UUID, required=True)
    parser.add_argument("--media-id", type=UUID, action="append", default=[])
    parser.add_argument("--apply", action="store_true", help="apply one exact reviewed preview")
    parser.add_argument("--preview-digest", help="sha256 from the reviewed single-item preview")
    arguments = parser.parse_args()
    if arguments.apply:
        if len(arguments.media_id) != 1 or not re.fullmatch(
            r"[0-9a-f]{64}", arguments.preview_digest or ""
        ):
            parser.error("--apply requires exactly one --media-id and a sha256 --preview-digest")
    elif arguments.preview_digest is not None:
        parser.error("--preview-digest requires --apply")
    return repair_epub_contributors(
        viewer_id=arguments.viewer_id,
        media_ids=tuple(arguments.media_id),
        preview_digest=presence_from_nullable(arguments.preview_digest),
    )


if __name__ == "__main__":
    raise SystemExit(main())
