from uuid import uuid4

import pytest
from sqlalchemy import text

from nexus.db.models import Media, MediaKind, MediaSourceAttempt, ProcessingStatus
from nexus.services.media_source_ingest import _supersede_source_media
from nexus.storage.paths import build_source_artifact_storage_path

pytestmark = pytest.mark.integration


def test_supersede_rejects_artifact_bearing_source_attempt(direct_db):
    loser_media_id = uuid4()
    winner_media_id = uuid4()
    attempt_id = uuid4()
    artifact_path = build_source_artifact_storage_path(loser_media_id, attempt_id, "tar")

    with direct_db.session() as session:
        session.add_all(
            [
                Media(
                    id=loser_media_id,
                    kind=MediaKind.pdf.value,
                    title="Loser",
                    processing_status=ProcessingStatus.extracting,
                ),
                Media(
                    id=winner_media_id,
                    kind=MediaKind.pdf.value,
                    title="Winner",
                    processing_status=ProcessingStatus.ready_for_reading,
                ),
                MediaSourceAttempt(
                    id=attempt_id,
                    media_id=loser_media_id,
                    source_type="remote_pdf_url",
                    attempt_no=1,
                    status="running",
                    intent_key="test-supersede-artifact-guard",
                    requested_url="https://arxiv.org/pdf/2606.01109",
                    canonical_source_url="https://arxiv.org/pdf/2606.01109",
                    source_payload={
                        "remote_kind": "pdf",
                        "arxiv_source_package": {"storage_path": artifact_path},
                    },
                ),
            ]
        )
        session.commit()

    direct_db.register_cleanup("media_source_attempts", "id", attempt_id)
    direct_db.register_cleanup("media", "id", loser_media_id)
    direct_db.register_cleanup("media", "id", winner_media_id)

    with direct_db.session() as session:
        with pytest.raises(RuntimeError, match="storage artifacts must be rehomed"):
            _supersede_source_media(
                session,
                loser_media_id=loser_media_id,
                winner_media_id=winner_media_id,
                attempt_id=attempt_id,
            )

    with direct_db.session() as session:
        row = session.execute(
            text("""
                SELECT media_id, attempt_no
                FROM media_source_attempts
                WHERE id = :attempt_id
            """),
            {"attempt_id": attempt_id},
        ).one()

    assert row == (loser_media_id, 1)
