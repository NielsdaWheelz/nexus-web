"""Research existing media dates after the publication-date schema cutover."""

from __future__ import annotations

import argparse
from uuid import UUID

from sqlalchemy import select, text

from nexus.auth.permissions import can_read_media, visible_media_ids_cte_sql
from nexus.db.models import Media, MediaFile, MediaKind, ProcessingStatus, User
from nexus.db.session import create_session_factory
from nexus.schemas.presence import Present
from nexus.services.epub_ingest import EpubExtractionError, extract_epub_metadata
from nexus.services.metadata_dispatch import enqueue_metadata_enrichment
from nexus.services.parser_temp import (
    StorageObjectIntegrityError,
    parser_attempt_directory,
    stream_storage_object_to_file,
)
from nexus.storage.client import StorageError, get_storage_client


def backfill_media_publication_dates(*, viewer_id: UUID) -> int:
    session_factory = create_session_factory()
    with session_factory() as db:
        if db.get(User, viewer_id) is None:
            raise ValueError("viewer does not exist")

    queued = skipped = failed = 0
    after: UUID | None = None
    while True:
        with session_factory() as db:
            selection = select(Media.id).where(Media.id.in_(text(visible_media_ids_cte_sql())))
            if after is not None:
                selection = selection.where(Media.id > after)
            media_ids = db.scalars(
                selection.order_by(Media.id).limit(100), {"viewer_id": viewer_id}
            ).all()
        if not media_ids:
            break

        for media_id in media_ids:
            with session_factory() as db:
                source_media = db.scalars(select(Media).where(Media.id == media_id)).one()
                if source_media.processing_status != ProcessingStatus.ready_for_reading and not (
                    source_media.processing_status == ProcessingStatus.pending
                    and source_media.kind in (MediaKind.video, MediaKind.podcast_episode)
                ):
                    skipped += 1
                    continue
                media_file = (
                    db.get(MediaFile, media_id) if source_media.kind == MediaKind.epub else None
                )

            metadata = None
            if source_media.kind == MediaKind.epub:
                if media_file is None:
                    raise RuntimeError(f"readable epub has no stored source: {media_id}")
                try:
                    with parser_attempt_directory(media_id) as directory:
                        source_path = directory / "source.epub"
                        stream_storage_object_to_file(
                            get_storage_client(),
                            storage_path=media_file.storage_path,
                            destination=source_path,
                            expected_size_bytes=media_file.size_bytes,
                            expected_source_sha256=media_file.source_sha256,
                        )
                        metadata = extract_epub_metadata(source_path)
                except (StorageError, StorageObjectIntegrityError) as exc:
                    failed += 1
                    print(f"failed media={media_id} source_error={exc.code}")
                    continue
                if isinstance(metadata, EpubExtractionError):
                    failed += 1
                    print(f"failed media={media_id} epub_error={metadata.error_code}")
                    continue

            with session_factory.begin() as db:
                media = db.scalars(
                    select(Media).where(Media.id == media_id).with_for_update()
                ).one()
                if (
                    not can_read_media(db, viewer_id, media_id)
                    or media.processing_status != source_media.processing_status
                    or media.kind != source_media.kind
                ):
                    skipped += 1
                    continue
                if media_file is not None:
                    current_file = db.scalars(
                        select(MediaFile).where(MediaFile.media_id == media_id)
                    ).one()
                    if (
                        current_file.source_sha256 != media_file.source_sha256
                        or current_file.storage_path != media_file.storage_path
                    ):
                        skipped += 1
                        continue
                inserted = enqueue_metadata_enrichment(
                    db,
                    media_id=media_id,
                    requester_user_id=viewer_id,
                    request_id=None,
                    dedupe_key=f"publication-dates:{media_id}",
                )
                if inserted and metadata is not None:
                    if isinstance(metadata.edition_published_date, Present):
                        media.edition_published_date = metadata.edition_published_date.value
                    if isinstance(metadata.edition_isbn, Present):
                        media.edition_isbn = metadata.edition_isbn.value
            if inserted:
                queued += 1
            else:
                skipped += 1
        after = media_ids[-1]

    print(f"publication-date backfill: queued={queued} skipped={skipped} failed={failed}")
    return 1 if failed else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--viewer-id", type=UUID, required=True)
    args = parser.parse_args()
    return backfill_media_publication_dates(viewer_id=args.viewer_id)


if __name__ == "__main__":
    raise SystemExit(main())
