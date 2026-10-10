"""Preview/apply source-fenced EPUB credit repairs without republishing readers."""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import defer

from nexus.auth.permissions import can_read_media, visible_media_ids_cte_sql
from nexus.db.models import Media, MediaFile, User
from nexus.db.retries import retry_serializable
from nexus.db.session import create_session_factory
from nexus.services.epub_contributor_repair import (
    EpubContributorRepairPlan,
    EpubContributorRepairReport,
    EpubContributorRepairSkipped,
    apply_epub_contributor_repair_in_current_transaction,
    prepare_epub_contributor_repair,
    preview_epub_contributor_repair,
)
from nexus.services.epub_ingest import EpubExtractionError, extract_epub_metadata
from nexus.services.parser_temp import (
    StorageObjectIntegrityError,
    parser_attempt_directory,
    stream_storage_object_to_file,
)
from nexus.storage.client import StorageError, get_storage_client


def repair_epub_contributors(*, viewer_id: UUID, media_ids: tuple[UUID, ...], apply: bool) -> int:
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
            break
        for media_id in selected:
            report: EpubContributorRepairReport | EpubContributorRepairSkipped
            with factory() as db:
                source = db.get(MediaFile, media_id)
                if source is None:
                    print(
                        json.dumps(
                            {
                                "media_id": str(media_id),
                                "status": "skipped",
                                "reason": "source_missing",
                            }
                        )
                    )
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
                print(
                    json.dumps(
                        {
                            "media_id": str(media_id),
                            "status": "skipped",
                            "reason": "source_unavailable",
                            "code": error.code,
                        }
                    )
                )
                continue
            if isinstance(metadata, EpubExtractionError):
                print(
                    json.dumps(
                        {
                            "media_id": str(media_id),
                            "status": "skipped",
                            "reason": "source_invalid",
                            "code": metadata.error_code,
                        }
                    )
                )
                continue
            with factory() as db:
                media = db.scalar(
                    select(Media).options(defer(Media.plain_text)).where(Media.id == media_id)
                )
                current_source = db.get(MediaFile, media_id)
                if media is None or not can_read_media(db, viewer_id, media_id):
                    report = EpubContributorRepairSkipped("access_revoked")
                    plan = None
                elif (
                    current_source is None
                    or (
                        current_source.storage_path,
                        current_source.source_sha256,
                        current_source.size_bytes,
                        current_source.content_type,
                    )
                    != fingerprint
                ):
                    report = EpubContributorRepairSkipped("source_changed")
                    plan = None
                else:
                    plan = prepare_epub_contributor_repair(db, media=media, metadata=metadata)
                    report = (
                        plan
                        if isinstance(plan, EpubContributorRepairSkipped)
                        else preview_epub_contributor_repair(db, plan=plan)
                    )
            if (
                apply
                and plan is not None
                and not isinstance(plan, EpubContributorRepairSkipped)
                and not isinstance(report, EpubContributorRepairSkipped)
            ):
                with factory() as db:

                    def publish(
                        *,
                        expected_media_id: UUID = media_id,
                        expected_source: tuple[str, str, int, str] = fingerprint,
                        prepared_plan: EpubContributorRepairPlan = plan,
                    ) -> EpubContributorRepairReport | EpubContributorRepairSkipped:
                        locked_media = db.scalar(
                            select(Media)
                            .options(defer(Media.plain_text))
                            .where(Media.id == expected_media_id)
                            .with_for_update()
                        )
                        current_source = db.get(MediaFile, expected_media_id)
                        if locked_media is None or not can_read_media(
                            db, viewer_id, expected_media_id
                        ):
                            result = EpubContributorRepairSkipped("access_revoked")
                        elif (
                            locked_media.kind != "epub"
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
                            result = apply_epub_contributor_repair_in_current_transaction(
                                db, media=locked_media, plan=prepared_plan
                            )
                        db.commit()
                        return result

                    report = retry_serializable(db, "epub_contributor_repair.publish", publish)
            payload: dict[str, object] = {
                "media_id": str(media_id),
                "mode": "apply" if apply else "preview",
            }
            if isinstance(report, EpubContributorRepairSkipped):
                payload.update(status="skipped", reason=report.reason)
                if report.reason == "unrepresentable_observation":
                    payload["source_issues"] = [
                        asdict(issue) for issue in metadata.contributor_issues
                    ]
            else:
                payload.update(asdict(report))
                payload["status"] = "changed" if report.changed else "unchanged"
            print(json.dumps(payload, ensure_ascii=False))
        after = selected[-1]
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--viewer-id", type=UUID, required=True)
    parser.add_argument("--media-id", type=UUID, action="append", default=[])
    parser.add_argument(
        "--apply", action="store_true", help="apply guarded repairs; otherwise preview"
    )
    arguments = parser.parse_args()
    return repair_epub_contributors(
        viewer_id=arguments.viewer_id, media_ids=tuple(arguments.media_id), apply=arguments.apply
    )


if __name__ == "__main__":
    raise SystemExit(main())
