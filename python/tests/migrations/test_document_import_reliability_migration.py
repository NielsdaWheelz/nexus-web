"""Real PostgreSQL + MinIO proof for the document-import persistence hard cut."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from uuid import UUID

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, inspect, text

from nexus.db.models import MediaFile, MediaUploadSession, MediaUploadSessionDestination
from nexus.storage.client import get_storage_client


def test_0217_0218_backfill_is_resumable_fail_closed_and_hard_contracts_schema(
    empty_migration_database_url: str,
) -> None:
    migration_root = Path(__file__).parents[3] / "migrations"
    config = Config(migration_root / "alembic.ini")
    config.set_main_option("script_location", str(migration_root / "alembic"))
    assert ScriptDirectory.from_config(config).get_current_head() == "0218"
    command.upgrade(config, "0216")

    user_id = UUID("00000000-0000-0000-0000-000000002160")
    valid_id = UUID("00000000-0000-0000-0000-000000002161")
    missing_id = UUID("00000000-0000-0000-0000-000000002162")
    changed_id = UUID("00000000-0000-0000-0000-000000002163")
    job_id = UUID("00000000-0000-0000-0000-000000002164")
    phantom_id = UUID("00000000-0000-0000-0000-000000002165")
    phantom_attempt_id = UUID("00000000-0000-0000-0000-000000002166")
    epub_id = UUID("00000000-0000-0000-0000-000000002167")
    phantom_source = ("migration/document-import/phantom.pdf", b"%PDF-phantom-source")
    epub_source = ("migration/document-import/valid.epub", b"PK\x03\x04valid-epub-source")
    sources = {
        valid_id: ("migration/document-import/valid.pdf", b"%PDF-valid-source"),
        missing_id: ("migration/document-import/missing.pdf", b"%PDF-repaired-source"),
        changed_id: ("migration/document-import/changed.pdf", b"%PDF-correct-source"),
    }
    storage = get_storage_client()
    engine = create_engine(empty_migration_database_url)
    try:
        storage.put_object(*sources[valid_id], "application/pdf")
        storage.put_object(sources[changed_id][0], b"%PDF-wrong", "application/pdf")
        storage.put_object(*phantom_source, "application/pdf")
        storage.put_object(*epub_source, "application/epub+zip")
        with engine.begin() as connection:
            connection.execute(
                text("INSERT INTO users (id, email) VALUES (:id, :email)"),
                {"id": user_id, "email": "document-import-migration@example.invalid"},
            )
            for media_id, (storage_path, expected_payload) in sources.items():
                connection.execute(
                    text(
                        """
                        INSERT INTO media (
                            id, kind, title, processing_status, created_by_user_id
                        ) VALUES (:id, 'pdf', :title, 'ready_for_reading', :user_id)
                        """
                    ),
                    {
                        "id": media_id,
                        "title": f"Migration source {media_id}",
                        "user_id": user_id,
                    },
                )
                connection.execute(
                    text(
                        """
                        INSERT INTO media_file (
                            media_id, storage_path, content_type, size_bytes
                        ) VALUES (:media_id, :path, 'application/pdf', :size)
                        """
                    ),
                    {
                        "media_id": media_id,
                        "path": storage_path,
                        "size": len(expected_payload),
                    },
                )
            connection.execute(
                text(
                    """
                    INSERT INTO media (
                        id, kind, title, processing_status, created_by_user_id
                    ) VALUES (:id, 'epub', 'Migration EPUB source',
                              'ready_for_reading', :user_id)
                    """
                ),
                {"id": epub_id, "user_id": user_id},
            )
            connection.execute(
                text(
                    """
                    INSERT INTO media_file (
                        media_id, storage_path, content_type, size_bytes
                    ) VALUES (:media_id, :path, 'application/epub+zip', :size)
                    """
                ),
                {
                    "media_id": epub_id,
                    "path": epub_source[0],
                    "size": len(epub_source[1]),
                },
            )
            connection.execute(
                text(
                    """
                    INSERT INTO media (
                        id, kind, title, processing_status, created_by_user_id
                    ) VALUES (:id, 'pdf', 'Stopped legacy upload', 'pending', :user_id)
                    """
                ),
                {"id": phantom_id, "user_id": user_id},
            )
            connection.execute(
                text(
                    """
                    INSERT INTO media_file (
                        media_id, storage_path, content_type, size_bytes
                    ) VALUES (:media_id, :path, 'application/pdf', :size)
                    """
                ),
                {
                    "media_id": phantom_id,
                    "path": phantom_source[0],
                    "size": len(phantom_source[1]),
                },
            )
            connection.execute(
                text(
                    """
                    INSERT INTO media_source_attempts (
                        id, media_id, created_by_user_id, source_type, attempt_no,
                        status, intent_key, source_payload, request_id,
                        signed_upload_expires_at
                    ) VALUES (
                        :id, :media_id, :user_id, 'uploaded_pdf_file', 1,
                        'accepted', 'legacy-upload', '{}'::jsonb, 'legacy-request',
                        now() + interval '1 hour'
                    )
                    """
                ),
                {
                    "id": phantom_attempt_id,
                    "media_id": phantom_id,
                    "user_id": user_id,
                },
            )
            connection.execute(
                text(
                    """
                    INSERT INTO background_jobs (id, kind, payload, status, attempts)
                    VALUES (:id, 'storage_object_cleanup', CAST(:payload AS jsonb),
                            'pending', 0)
                    """
                ),
                {
                    "id": job_id,
                    "payload": json.dumps(
                        {
                            "mediaId": str(valid_id),
                            "storagePath": sources[valid_id][0],
                            "checkpoint": {"kind": "Armed"},
                        }
                    ),
                },
            )

        command.upgrade(config, "0217")
        inspector = inspect(engine)
        assert {column["name"] for column in inspector.get_columns("media_upload_sessions")} == {
            "id",
            "created_by_user_id",
            "candidate_media_id",
            "kind",
            "filename",
            "content_type",
            "expected_size_bytes",
            "idempotency_key",
            "request_id",
            "upload_generation",
            "upload_url_expires_at",
            "verification_token",
            "verification_generation",
            "verification_expires_at",
            "transport_failure_kind",
            "transport_http_status",
            "transport_failed_at",
            "verification_error_code",
            "verification_failed_at",
            "published_media_id",
            "published_source_attempt_id",
            "published_at",
            "created_at",
            "updated_at",
        }
        assert next(
            column["nullable"]
            for column in inspector.get_columns("media_file")
            if column["name"] == "source_sha256"
        )

        with pytest.raises(RuntimeError, match="failed to read media_file"):
            command.upgrade(config, "0218")
        with engine.connect() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0217"
            assert (
                connection.scalar(
                    text("SELECT source_sha256 FROM media_file WHERE media_id = :id"),
                    {"id": valid_id},
                )
                == hashlib.sha256(sources[valid_id][1]).hexdigest()
            )
            assert (
                connection.scalar(
                    text("SELECT source_sha256 FROM media_file WHERE media_id = :id"),
                    {"id": missing_id},
                )
                is None
            )

        storage.put_object(*sources[missing_id], "application/pdf")
        with pytest.raises(RuntimeError, match="size changed"):
            command.upgrade(config, "0218")
        with engine.connect() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0217"
            assert (
                connection.scalar(
                    text("SELECT source_sha256 FROM media_file WHERE media_id = :id"),
                    {"id": missing_id},
                )
                == hashlib.sha256(sources[missing_id][1]).hexdigest()
            )

        storage.put_object(*sources[changed_id], "application/pdf")
        with pytest.raises(RuntimeError, match="active source publication defects"):
            command.upgrade(config, "0218")
        with engine.connect() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0217"
            assert (
                connection.scalar(
                    text("SELECT source_sha256 FROM media_file WHERE media_id = :id"),
                    {"id": phantom_id},
                )
                == hashlib.sha256(phantom_source[1]).hexdigest()
            )
            assert (
                connection.scalar(
                    text("SELECT count(*) FROM media_source_attempts WHERE id = :id"),
                    {"id": phantom_attempt_id},
                )
                == 1
            )
            assert "signed_upload_expires_at" in {
                column["name"] for column in inspect(engine).get_columns("media_source_attempts")
            }

        # Exact operator cleanup is deliberately outside the migration. A rerun
        # resumes only after the stopped-writer media, file, and attempt are gone.
        with engine.begin() as connection:
            connection.execute(
                text("DELETE FROM media_source_attempts WHERE id = :id"),
                {"id": phantom_attempt_id},
            )
            connection.execute(
                text("DELETE FROM media_file WHERE media_id = :id"),
                {"id": phantom_id},
            )
            connection.execute(
                text("DELETE FROM media WHERE id = :id"),
                {"id": phantom_id},
            )
        storage.delete_object(phantom_source[0])
        command.upgrade(config, "0218")
        inspector = inspect(engine)
        with engine.connect() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0218"
            assert dict(
                connection.execute(
                    text("SELECT media_id, source_sha256 FROM media_file ORDER BY media_id")
                ).all()
            ) == {
                media_id: hashlib.sha256(payload).hexdigest()
                for media_id, (_path, payload) in sources.items()
            } | {epub_id: hashlib.sha256(epub_source[1]).hexdigest()}
            assert (
                connection.scalar(
                    text("SELECT payload->>'ownerKind' FROM background_jobs WHERE id = :id"),
                    {"id": job_id},
                )
                == "Media"
            )
        assert not next(
            column["nullable"]
            for column in inspector.get_columns("media_file")
            if column["name"] == "source_sha256"
        )
        assert "signed_upload_expires_at" not in {
            column["name"] for column in inspector.get_columns("media_source_attempts")
        }
        assert "idx_media_stale_pending_upload_cleanup" not in {
            index["name"] for index in inspector.get_indexes("media")
        }
        assert inspector.get_check_constraints("media_upload_sessions") == []
        assert {
            constraint["name"]
            for constraint in inspector.get_unique_constraints("media_upload_sessions")
        } == {
            "uq_media_upload_sessions_candidate_media",
            "uq_media_upload_sessions_published_media",
            "uq_media_upload_sessions_published_source_attempt",
            "uq_media_upload_sessions_viewer_idempotency",
        }
        assert inspector.get_pk_constraint("media_upload_session_destinations")[
            "constrained_columns"
        ] == ["upload_session_id", "library_id"]
        assert all(
            foreign_key["options"] == {}
            for table in ("media_upload_sessions", "media_upload_session_destinations")
            for foreign_key in inspector.get_foreign_keys(table)
        )
        assert MediaUploadSession.__tablename__ == "media_upload_sessions"
        assert MediaUploadSessionDestination.__tablename__ == "media_upload_session_destinations"
        assert MediaFile.source_sha256.nullable is False

        with pytest.raises(NotImplementedError, match="irreversible document-import"):
            command.downgrade(config, "0217")
    finally:
        for storage_path, _payload in sources.values():
            storage.delete_object(storage_path)
        storage.delete_object(phantom_source[0])
        storage.delete_object(epub_source[0])
        engine.dispose()
