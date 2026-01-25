"""Tests for database migrations.

These tests run on a SEPARATE DATABASE (nexus_test_migrations) from other tests.
This allows them to safely drop/recreate schema without affecting other tests.

Run with: make test-migrations
Do NOT run with: make test (these are excluded)
"""

import os
import subprocess
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session


def get_test_database_url() -> str:
    """Get the test database URL from environment."""
    url = os.environ.get("DATABASE_URL")
    if not url:
        pytest.fail("DATABASE_URL environment variable must be set")
    return url


def get_migrations_dir() -> str:
    """Get the path to the migrations directory."""
    # From python/tests/, go up to repo root, then into migrations/
    tests_dir = os.path.dirname(os.path.abspath(__file__))
    python_dir = os.path.dirname(tests_dir)
    repo_root = os.path.dirname(python_dir)
    return os.path.join(repo_root, "migrations")


def run_alembic_command(command: str) -> subprocess.CompletedProcess:
    """Run an alembic command and return the result."""
    migrations_dir = get_migrations_dir()
    python_dir = os.path.join(os.path.dirname(migrations_dir), "python")
    result = subprocess.run(
        ["uv", "run", "--project", python_dir, "alembic"] + command.split(),
        capture_output=True,
        text=True,
        env={**os.environ},
        cwd=migrations_dir,
    )
    return result


@pytest.fixture(scope="session", autouse=True)
def verify_schema_exists():
    """Override the global verify_schema_exists fixture.

    Migration tests manage their own schema state, so we skip the check.
    """
    yield


@pytest.fixture(scope="module")
def migrated_engine():
    """Create engine and run migrations for the module.

    This fixture runs migrations at the start of the module and
    downgrades at the end to clean up.
    """
    database_url = get_test_database_url()
    engine = create_engine(database_url)

    # First, downgrade to clean state (in case previous test run left data)
    run_alembic_command("downgrade base")

    # Run migrations
    result = run_alembic_command("upgrade head")
    if result.returncode != 0:
        pytest.fail(f"Migration upgrade failed: {result.stderr}")

    yield engine

    # Clean up: downgrade to base
    run_alembic_command("downgrade base")
    engine.dispose()


class TestMigrationUpgradeDowngrade:
    """Tests that migrations apply and rollback cleanly."""

    def test_upgrade_succeeds(self):
        """Migration upgrade to head succeeds on empty database."""
        # Start fresh
        run_alembic_command("downgrade base")

        result = run_alembic_command("upgrade head")

        assert result.returncode == 0, f"Upgrade failed: {result.stderr}"

    def test_downgrade_succeeds(self):
        """Migration downgrade to base succeeds."""
        # First ensure we're at head
        run_alembic_command("upgrade head")

        result = run_alembic_command("downgrade base")

        assert result.returncode == 0, f"Downgrade failed: {result.stderr}"


class TestSchemaConstraints:
    """Tests that schema constraints are properly enforced."""

    def test_duplicate_default_library_rejected(self, migrated_engine):
        """Partial unique index prevents duplicate default libraries per user."""
        with Session(migrated_engine) as session:
            user_id = uuid4()

            # Create user
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})

            # Create first default library
            session.execute(
                text("""
                    INSERT INTO libraries (id, owner_user_id, name, is_default)
                    VALUES (:id, :owner_id, 'My Library', true)
                """),
                {"id": uuid4(), "owner_id": user_id},
            )

            # Attempt to create second default library - should fail
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO libraries (id, owner_user_id, name, is_default)
                        VALUES (:id, :owner_id, 'Another Default', true)
                    """),
                    {"id": uuid4(), "owner_id": user_id},
                )
                session.commit()

            session.rollback()
            assert "uix_libraries_one_default_per_user" in str(exc_info.value)

    def test_duplicate_membership_rejected(self, migrated_engine):
        """Primary key prevents duplicate memberships."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            library_id = uuid4()

            # Create user
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})

            # Create library
            session.execute(
                text("""
                    INSERT INTO libraries (id, owner_user_id, name, is_default)
                    VALUES (:id, :owner_id, 'Test Library', false)
                """),
                {"id": library_id, "owner_id": user_id},
            )

            # Create first membership
            session.execute(
                text("""
                    INSERT INTO memberships (library_id, user_id, role)
                    VALUES (:library_id, :user_id, 'admin')
                """),
                {"library_id": library_id, "user_id": user_id},
            )

            # Attempt duplicate membership - should fail
            with pytest.raises(IntegrityError):
                session.execute(
                    text("""
                        INSERT INTO memberships (library_id, user_id, role)
                        VALUES (:library_id, :user_id, 'member')
                    """),
                    {"library_id": library_id, "user_id": user_id},
                )
                session.commit()

            session.rollback()

    def test_invalid_role_rejected(self, migrated_engine):
        """Check constraint prevents invalid role values."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            library_id = uuid4()

            # Create user and library
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text("""
                    INSERT INTO libraries (id, owner_user_id, name, is_default)
                    VALUES (:id, :owner_id, 'Test Library', false)
                """),
                {"id": library_id, "owner_id": user_id},
            )

            # Attempt membership with invalid role
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO memberships (library_id, user_id, role)
                        VALUES (:library_id, :user_id, 'invalid_role')
                    """),
                    {"library_id": library_id, "user_id": user_id},
                )
                session.commit()

            session.rollback()
            assert "ck_memberships_role" in str(exc_info.value)

    def test_invalid_media_kind_rejected(self, migrated_engine):
        """Check constraint prevents invalid media kind values."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})

            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                        VALUES (:id, 'invalid_kind', 'Test', 'pending', :user_id)
                    """),
                    {"id": uuid4(), "user_id": user_id},
                )
                session.commit()

            session.rollback()
            assert "ck_media_kind" in str(exc_info.value)

    def test_invalid_processing_status_rejected(self, migrated_engine):
        """Enum type prevents invalid processing status values."""
        from sqlalchemy.exc import DBAPIError

        with Session(migrated_engine) as session:
            user_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})

            # With enum type, casting an invalid value fails with a database error
            with pytest.raises(DBAPIError):
                session.execute(
                    text("""
                        INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                        VALUES (:id, 'web_article', 'Test', 'invalid_status'::processing_status_enum, :user_id)
                    """),
                    {"id": uuid4(), "user_id": user_id},
                )
                session.commit()

            session.rollback()

    def test_library_name_too_short_rejected(self, migrated_engine):
        """Check constraint prevents empty library names."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})

            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO libraries (id, owner_user_id, name, is_default)
                        VALUES (:id, :owner_id, '', false)
                    """),
                    {"id": uuid4(), "owner_id": user_id},
                )
                session.commit()

            session.rollback()
            assert "ck_libraries_name_length" in str(exc_info.value)

    def test_library_name_too_long_rejected(self, migrated_engine):
        """Check constraint prevents library names over 100 characters."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})

            long_name = "x" * 101
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO libraries (id, owner_user_id, name, is_default)
                        VALUES (:id, :owner_id, :name, false)
                    """),
                    {"id": uuid4(), "owner_id": user_id, "name": long_name},
                )
                session.commit()

            session.rollback()
            assert "ck_libraries_name_length" in str(exc_info.value)

    def test_valid_media_kinds_accepted(self, migrated_engine):
        """All valid media kinds are accepted."""
        valid_kinds = ["web_article", "epub", "pdf", "video", "podcast_episode"]

        with Session(migrated_engine) as session:
            # Need a user for created_by_user_id
            user_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})

            for kind in valid_kinds:
                media_id = uuid4()
                session.execute(
                    text("""
                        INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                        VALUES (:id, :kind, :title, 'pending', :user_id)
                    """),
                    {"id": media_id, "kind": kind, "title": f"Test {kind}", "user_id": user_id},
                )

            session.commit()

            # Verify all were inserted (including system user media)
            result = session.execute(
                text("SELECT COUNT(*) FROM media WHERE created_by_user_id = :user_id"),
                {"user_id": user_id},
            )
            count = result.scalar()
            assert count == len(valid_kinds)

            # Clean up
            session.execute(
                text("DELETE FROM media WHERE created_by_user_id = :user_id"), {"user_id": user_id}
            )
            session.execute(text("DELETE FROM users WHERE id = :id"), {"id": user_id})
            session.commit()

    def test_valid_processing_statuses_accepted(self, migrated_engine):
        """All valid processing statuses are accepted."""
        valid_statuses = [
            "pending",
            "extracting",
            "ready_for_reading",
            "embedding",
            "ready",
            "failed",
        ]

        with Session(migrated_engine) as session:
            # Need a user for created_by_user_id
            user_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})

            for status in valid_statuses:
                media_id = uuid4()
                session.execute(
                    text("""
                        INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                        VALUES (:id, 'web_article', :title, CAST(:status AS processing_status_enum), :user_id)
                    """),
                    {
                        "id": media_id,
                        "title": f"Test {status}",
                        "status": status,
                        "user_id": user_id,
                    },
                )

            session.commit()

            # Clean up
            session.execute(text("DELETE FROM media"))
            session.execute(text("DELETE FROM users WHERE id = :id"), {"id": user_id})
            session.commit()


class TestS1SchemaConstraints:
    """Tests for S1-specific schema constraints (idempotency indexes, URL lengths)."""

    def test_canonical_url_uniqueness(self, migrated_engine):
        """Partial unique index on (kind, canonical_url) enforced."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})

            canonical_url = "https://example.com/article"

            # Create first media with canonical_url
            session.execute(
                text("""
                    INSERT INTO media (id, kind, title, processing_status, created_by_user_id, canonical_url)
                    VALUES (:id, 'web_article', 'First Article', 'pending', :user_id, :canonical_url)
                """),
                {"id": uuid4(), "user_id": user_id, "canonical_url": canonical_url},
            )
            session.commit()

            # Attempt to create second media with same kind and canonical_url
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO media (id, kind, title, processing_status, created_by_user_id, canonical_url)
                        VALUES (:id, 'web_article', 'Second Article', 'pending', :user_id, :canonical_url)
                    """),
                    {"id": uuid4(), "user_id": user_id, "canonical_url": canonical_url},
                )
                session.commit()

            session.rollback()
            assert "uix_media_canonical_url" in str(exc_info.value)

            # Clean up
            session.execute(
                text("DELETE FROM media WHERE created_by_user_id = :user_id"), {"user_id": user_id}
            )
            session.execute(text("DELETE FROM users WHERE id = :id"), {"id": user_id})
            session.commit()

    def test_file_sha256_uniqueness_per_user(self, migrated_engine):
        """Partial unique index on (user, kind, sha256) enforced for pdf/epub."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            another_user_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": another_user_id})

            file_sha256 = "abc123def456"

            # Create first pdf with sha256
            session.execute(
                text("""
                    INSERT INTO media (id, kind, title, processing_status, created_by_user_id, file_sha256)
                    VALUES (:id, 'pdf', 'First PDF', 'pending', :user_id, :file_sha256)
                """),
                {"id": uuid4(), "user_id": user_id, "file_sha256": file_sha256},
            )
            session.commit()

            # Same user, same sha256 → should fail
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO media (id, kind, title, processing_status, created_by_user_id, file_sha256)
                        VALUES (:id, 'pdf', 'Duplicate PDF', 'pending', :user_id, :file_sha256)
                    """),
                    {"id": uuid4(), "user_id": user_id, "file_sha256": file_sha256},
                )
                session.commit()

            session.rollback()
            assert "uix_media_file_sha256" in str(exc_info.value)

            # Different user, same sha256 → should succeed
            session.execute(
                text("""
                    INSERT INTO media (id, kind, title, processing_status, created_by_user_id, file_sha256)
                    VALUES (:id, 'pdf', 'Another User PDF', 'pending', :user_id, :file_sha256)
                """),
                {"id": uuid4(), "user_id": another_user_id, "file_sha256": file_sha256},
            )
            session.commit()

            # Clean up
            session.execute(
                text("DELETE FROM media WHERE created_by_user_id IN (:u1, :u2)"),
                {"u1": user_id, "u2": another_user_id},
            )
            session.execute(
                text("DELETE FROM users WHERE id IN (:u1, :u2)"),
                {"u1": user_id, "u2": another_user_id},
            )
            session.commit()

    def test_requested_url_length_constraint(self, migrated_engine):
        """Check constraint prevents requested_url over 2048 characters."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})

            long_url = "https://example.com/" + "x" * 2030

            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO media (id, kind, title, processing_status, created_by_user_id, requested_url)
                        VALUES (:id, 'web_article', 'Test', 'pending', :user_id, :requested_url)
                    """),
                    {"id": uuid4(), "user_id": user_id, "requested_url": long_url},
                )
                session.commit()

            session.rollback()
            assert "ck_media_requested_url_length" in str(exc_info.value)

    def test_canonical_url_length_constraint(self, migrated_engine):
        """Check constraint prevents canonical_url over 2048 characters."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})

            long_url = "https://example.com/" + "y" * 2030

            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO media (id, kind, title, processing_status, created_by_user_id, canonical_url)
                        VALUES (:id, 'web_article', 'Test', 'pending', :user_id, :canonical_url)
                    """),
                    {"id": uuid4(), "user_id": user_id, "canonical_url": long_url},
                )
                session.commit()

            session.rollback()
            assert "ck_media_canonical_url_length" in str(exc_info.value)

    def test_media_file_table_exists(self, migrated_engine):
        """media_file table exists and can store file metadata."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            media_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text("""
                    INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                    VALUES (:id, 'pdf', 'Test PDF', 'pending', :user_id)
                """),
                {"id": media_id, "user_id": user_id},
            )

            # Insert media_file
            session.execute(
                text("""
                    INSERT INTO media_file (media_id, storage_path, content_type, size_bytes)
                    VALUES (:media_id, 'media/test/original.pdf', 'application/pdf', 1048576)
                """),
                {"media_id": media_id},
            )
            session.commit()

            # Verify it was inserted
            result = session.execute(
                text(
                    "SELECT storage_path, content_type, size_bytes FROM media_file WHERE media_id = :media_id"
                ),
                {"media_id": media_id},
            )
            row = result.fetchone()
            assert row is not None
            assert row[0] == "media/test/original.pdf"
            assert row[1] == "application/pdf"
            assert row[2] == 1048576

            # Clean up (cascade should handle media_file)
            session.execute(text("DELETE FROM media WHERE id = :id"), {"id": media_id})
            session.execute(text("DELETE FROM users WHERE id = :id"), {"id": user_id})
            session.commit()

    def test_failure_stage_enum(self, migrated_engine):
        """failure_stage enum accepts valid values and rejects invalid."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})

            valid_stages = ["upload", "extract", "transcribe", "embed", "other"]

            for stage in valid_stages:
                media_id = uuid4()
                session.execute(
                    text("""
                        INSERT INTO media (id, kind, title, processing_status, created_by_user_id, failure_stage)
                        VALUES (:id, 'web_article', :title, 'failed', :user_id, CAST(:stage AS failure_stage_enum))
                    """),
                    {"id": media_id, "title": f"Test {stage}", "user_id": user_id, "stage": stage},
                )

            session.commit()

            # Clean up
            session.execute(
                text("DELETE FROM media WHERE created_by_user_id = :user_id"), {"user_id": user_id}
            )
            session.execute(text("DELETE FROM users WHERE id = :id"), {"id": user_id})
            session.commit()

    def test_processing_attempts_default(self, migrated_engine):
        """processing_attempts defaults to 0."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            media_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text("""
                    INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                    VALUES (:id, 'web_article', 'Test', 'pending', :user_id)
                """),
                {"id": media_id, "user_id": user_id},
            )
            session.commit()

            result = session.execute(
                text("SELECT processing_attempts FROM media WHERE id = :id"),
                {"id": media_id},
            )
            attempts = result.scalar()
            assert attempts == 0

            # Clean up
            session.execute(text("DELETE FROM media WHERE id = :id"), {"id": media_id})
            session.execute(text("DELETE FROM users WHERE id = :id"), {"id": user_id})
            session.commit()


class TestS2HighlightsAnnotationsConstraints:
    """Tests for S2-specific schema constraints (highlights, annotations)."""

    def test_invalid_highlight_color_rejected(self, migrated_engine):
        """CHECK constraint prevents invalid highlight color values."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            media_id = uuid4()
            fragment_id = uuid4()

            # Create user and media with fragment
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text("""
                    INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                    VALUES (:id, 'web_article', 'Test Article', 'ready_for_reading', :user_id)
                """),
                {"id": media_id, "user_id": user_id},
            )
            session.execute(
                text("""
                    INSERT INTO fragments (id, media_id, idx, canonical_text, html_sanitized)
                    VALUES (:id, :media_id, 0, 'Test canonical text content', '<p>Test</p>')
                """),
                {"id": fragment_id, "media_id": media_id},
            )
            session.commit()

            # Attempt to create highlight with invalid color
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO highlights (id, user_id, fragment_id, start_offset, end_offset, color, exact, prefix, suffix)
                        VALUES (:id, :user_id, :fragment_id, 0, 10, 'invalid_color', 'exact', 'prefix', 'suffix')
                    """),
                    {"id": uuid4(), "user_id": user_id, "fragment_id": fragment_id},
                )
                session.commit()

            session.rollback()
            assert "ck_highlights_color" in str(exc_info.value)

            # Clean up
            session.execute(text("DELETE FROM fragments WHERE id = :id"), {"id": fragment_id})
            session.execute(text("DELETE FROM media WHERE id = :id"), {"id": media_id})
            session.execute(text("DELETE FROM users WHERE id = :id"), {"id": user_id})
            session.commit()

    def test_invalid_highlight_offsets_rejected(self, migrated_engine):
        """CHECK constraint prevents invalid offset ranges."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            media_id = uuid4()
            fragment_id = uuid4()

            # Create user and media with fragment
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text("""
                    INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                    VALUES (:id, 'web_article', 'Test Article', 'ready_for_reading', :user_id)
                """),
                {"id": media_id, "user_id": user_id},
            )
            session.execute(
                text("""
                    INSERT INTO fragments (id, media_id, idx, canonical_text, html_sanitized)
                    VALUES (:id, :media_id, 0, 'Test canonical text content', '<p>Test</p>')
                """),
                {"id": fragment_id, "media_id": media_id},
            )
            session.commit()

            # Test case 1: end_offset <= start_offset (end == start)
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO highlights (id, user_id, fragment_id, start_offset, end_offset, color, exact, prefix, suffix)
                        VALUES (:id, :user_id, :fragment_id, 10, 10, 'yellow', 'exact', 'prefix', 'suffix')
                    """),
                    {"id": uuid4(), "user_id": user_id, "fragment_id": fragment_id},
                )
                session.commit()

            session.rollback()
            assert "ck_highlights_offsets_valid" in str(exc_info.value)

            # Test case 2: end_offset < start_offset
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO highlights (id, user_id, fragment_id, start_offset, end_offset, color, exact, prefix, suffix)
                        VALUES (:id, :user_id, :fragment_id, 10, 5, 'yellow', 'exact', 'prefix', 'suffix')
                    """),
                    {"id": uuid4(), "user_id": user_id, "fragment_id": fragment_id},
                )
                session.commit()

            session.rollback()
            assert "ck_highlights_offsets_valid" in str(exc_info.value)

            # Test case 3: negative start_offset
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO highlights (id, user_id, fragment_id, start_offset, end_offset, color, exact, prefix, suffix)
                        VALUES (:id, :user_id, :fragment_id, -1, 10, 'yellow', 'exact', 'prefix', 'suffix')
                    """),
                    {"id": uuid4(), "user_id": user_id, "fragment_id": fragment_id},
                )
                session.commit()

            session.rollback()
            assert "ck_highlights_offsets_valid" in str(exc_info.value)

            # Clean up
            session.execute(text("DELETE FROM fragments WHERE id = :id"), {"id": fragment_id})
            session.execute(text("DELETE FROM media WHERE id = :id"), {"id": media_id})
            session.execute(text("DELETE FROM users WHERE id = :id"), {"id": user_id})
            session.commit()

    def test_duplicate_highlight_span_rejected(self, migrated_engine):
        """Unique index prevents duplicate (user_id, fragment_id, start_offset, end_offset)."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            media_id = uuid4()
            fragment_id = uuid4()

            # Create user and media with fragment
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text("""
                    INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                    VALUES (:id, 'web_article', 'Test Article', 'ready_for_reading', :user_id)
                """),
                {"id": media_id, "user_id": user_id},
            )
            session.execute(
                text("""
                    INSERT INTO fragments (id, media_id, idx, canonical_text, html_sanitized)
                    VALUES (:id, :media_id, 0, 'Test canonical text content', '<p>Test</p>')
                """),
                {"id": fragment_id, "media_id": media_id},
            )

            # Create first highlight
            session.execute(
                text("""
                    INSERT INTO highlights (id, user_id, fragment_id, start_offset, end_offset, color, exact, prefix, suffix)
                    VALUES (:id, :user_id, :fragment_id, 0, 10, 'yellow', 'exact', 'prefix', 'suffix')
                """),
                {"id": uuid4(), "user_id": user_id, "fragment_id": fragment_id},
            )
            session.commit()

            # Attempt to create duplicate highlight at same span
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO highlights (id, user_id, fragment_id, start_offset, end_offset, color, exact, prefix, suffix)
                        VALUES (:id, :user_id, :fragment_id, 0, 10, 'blue', 'exact', 'prefix', 'suffix')
                    """),
                    {"id": uuid4(), "user_id": user_id, "fragment_id": fragment_id},
                )
                session.commit()

            session.rollback()
            assert "uix_highlights_user_fragment_offsets" in str(exc_info.value)

            # Clean up
            session.execute(
                text("DELETE FROM highlights WHERE fragment_id = :id"), {"id": fragment_id}
            )
            session.execute(text("DELETE FROM fragments WHERE id = :id"), {"id": fragment_id})
            session.execute(text("DELETE FROM media WHERE id = :id"), {"id": media_id})
            session.execute(text("DELETE FROM users WHERE id = :id"), {"id": user_id})
            session.commit()

    def test_second_annotation_for_highlight_rejected(self, migrated_engine):
        """Unique constraint prevents multiple annotations per highlight."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            media_id = uuid4()
            fragment_id = uuid4()
            highlight_id = uuid4()

            # Create user, media, fragment, and highlight
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text("""
                    INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                    VALUES (:id, 'web_article', 'Test Article', 'ready_for_reading', :user_id)
                """),
                {"id": media_id, "user_id": user_id},
            )
            session.execute(
                text("""
                    INSERT INTO fragments (id, media_id, idx, canonical_text, html_sanitized)
                    VALUES (:id, :media_id, 0, 'Test canonical text content', '<p>Test</p>')
                """),
                {"id": fragment_id, "media_id": media_id},
            )
            session.execute(
                text("""
                    INSERT INTO highlights (id, user_id, fragment_id, start_offset, end_offset, color, exact, prefix, suffix)
                    VALUES (:id, :user_id, :fragment_id, 0, 10, 'yellow', 'exact', 'prefix', 'suffix')
                """),
                {"id": highlight_id, "user_id": user_id, "fragment_id": fragment_id},
            )

            # Create first annotation
            session.execute(
                text("""
                    INSERT INTO annotations (id, highlight_id, body)
                    VALUES (:id, :highlight_id, 'First annotation')
                """),
                {"id": uuid4(), "highlight_id": highlight_id},
            )
            session.commit()

            # Attempt to create second annotation for same highlight
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO annotations (id, highlight_id, body)
                        VALUES (:id, :highlight_id, 'Second annotation')
                    """),
                    {"id": uuid4(), "highlight_id": highlight_id},
                )
                session.commit()

            session.rollback()
            assert "uix_annotations_one_per_highlight" in str(exc_info.value)

            # Clean up
            session.execute(
                text("DELETE FROM annotations WHERE highlight_id = :id"), {"id": highlight_id}
            )
            session.execute(text("DELETE FROM highlights WHERE id = :id"), {"id": highlight_id})
            session.execute(text("DELETE FROM fragments WHERE id = :id"), {"id": fragment_id})
            session.execute(text("DELETE FROM media WHERE id = :id"), {"id": media_id})
            session.execute(text("DELETE FROM users WHERE id = :id"), {"id": user_id})
            session.commit()

    def test_highlight_delete_cascades_annotation(self, migrated_engine):
        """Deleting a highlight cascades to delete its annotation."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            media_id = uuid4()
            fragment_id = uuid4()
            highlight_id = uuid4()
            annotation_id = uuid4()

            # Create user, media, fragment, highlight, and annotation
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text("""
                    INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                    VALUES (:id, 'web_article', 'Test Article', 'ready_for_reading', :user_id)
                """),
                {"id": media_id, "user_id": user_id},
            )
            session.execute(
                text("""
                    INSERT INTO fragments (id, media_id, idx, canonical_text, html_sanitized)
                    VALUES (:id, :media_id, 0, 'Test canonical text content', '<p>Test</p>')
                """),
                {"id": fragment_id, "media_id": media_id},
            )
            session.execute(
                text("""
                    INSERT INTO highlights (id, user_id, fragment_id, start_offset, end_offset, color, exact, prefix, suffix)
                    VALUES (:id, :user_id, :fragment_id, 0, 10, 'yellow', 'exact', 'prefix', 'suffix')
                """),
                {"id": highlight_id, "user_id": user_id, "fragment_id": fragment_id},
            )
            session.execute(
                text("""
                    INSERT INTO annotations (id, highlight_id, body)
                    VALUES (:id, :highlight_id, 'Test annotation')
                """),
                {"id": annotation_id, "highlight_id": highlight_id},
            )
            session.commit()

            # Verify annotation exists
            result = session.execute(
                text("SELECT COUNT(*) FROM annotations WHERE id = :id"),
                {"id": annotation_id},
            )
            assert result.scalar() == 1

            # Delete highlight
            session.execute(text("DELETE FROM highlights WHERE id = :id"), {"id": highlight_id})
            session.commit()

            # Verify annotation was cascaded
            result = session.execute(
                text("SELECT COUNT(*) FROM annotations WHERE id = :id"),
                {"id": annotation_id},
            )
            assert result.scalar() == 0

            # Clean up
            session.execute(text("DELETE FROM fragments WHERE id = :id"), {"id": fragment_id})
            session.execute(text("DELETE FROM media WHERE id = :id"), {"id": media_id})
            session.execute(text("DELETE FROM users WHERE id = :id"), {"id": user_id})
            session.commit()

    def test_fragment_delete_cascades_highlights(self, migrated_engine):
        """Deleting a fragment cascades to delete associated highlights (and annotations)."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            media_id = uuid4()
            fragment_id = uuid4()
            highlight_id = uuid4()
            annotation_id = uuid4()

            # Create user, media, fragment, highlight, and annotation
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text("""
                    INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                    VALUES (:id, 'web_article', 'Test Article', 'ready_for_reading', :user_id)
                """),
                {"id": media_id, "user_id": user_id},
            )
            session.execute(
                text("""
                    INSERT INTO fragments (id, media_id, idx, canonical_text, html_sanitized)
                    VALUES (:id, :media_id, 0, 'Test canonical text content', '<p>Test</p>')
                """),
                {"id": fragment_id, "media_id": media_id},
            )
            session.execute(
                text("""
                    INSERT INTO highlights (id, user_id, fragment_id, start_offset, end_offset, color, exact, prefix, suffix)
                    VALUES (:id, :user_id, :fragment_id, 0, 10, 'yellow', 'exact', 'prefix', 'suffix')
                """),
                {"id": highlight_id, "user_id": user_id, "fragment_id": fragment_id},
            )
            session.execute(
                text("""
                    INSERT INTO annotations (id, highlight_id, body)
                    VALUES (:id, :highlight_id, 'Test annotation')
                """),
                {"id": annotation_id, "highlight_id": highlight_id},
            )
            session.commit()

            # Verify highlight and annotation exist
            result = session.execute(
                text("SELECT COUNT(*) FROM highlights WHERE id = :id"),
                {"id": highlight_id},
            )
            assert result.scalar() == 1
            result = session.execute(
                text("SELECT COUNT(*) FROM annotations WHERE id = :id"),
                {"id": annotation_id},
            )
            assert result.scalar() == 1

            # Delete fragment
            session.execute(text("DELETE FROM fragments WHERE id = :id"), {"id": fragment_id})
            session.commit()

            # Verify highlight was cascaded
            result = session.execute(
                text("SELECT COUNT(*) FROM highlights WHERE id = :id"),
                {"id": highlight_id},
            )
            assert result.scalar() == 0

            # Verify annotation was also cascaded (via highlight cascade)
            result = session.execute(
                text("SELECT COUNT(*) FROM annotations WHERE id = :id"),
                {"id": annotation_id},
            )
            assert result.scalar() == 0

            # Clean up
            session.execute(text("DELETE FROM media WHERE id = :id"), {"id": media_id})
            session.execute(text("DELETE FROM users WHERE id = :id"), {"id": user_id})
            session.commit()

    def test_valid_highlight_colors_accepted(self, migrated_engine):
        """All valid highlight colors are accepted."""
        valid_colors = ["yellow", "green", "blue", "pink", "purple"]

        with Session(migrated_engine) as session:
            user_id = uuid4()
            media_id = uuid4()
            fragment_id = uuid4()

            # Create user and media with fragment
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text("""
                    INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                    VALUES (:id, 'web_article', 'Test Article', 'ready_for_reading', :user_id)
                """),
                {"id": media_id, "user_id": user_id},
            )
            session.execute(
                text("""
                    INSERT INTO fragments (id, media_id, idx, canonical_text, html_sanitized)
                    VALUES (:id, :media_id, 0, 'Test canonical text content for highlights', '<p>Test</p>')
                """),
                {"id": fragment_id, "media_id": media_id},
            )
            session.commit()

            # Create highlights with each valid color (at different offsets to avoid uniqueness constraint)
            for i, color in enumerate(valid_colors):
                start = i * 5
                end = start + 4
                session.execute(
                    text("""
                        INSERT INTO highlights (id, user_id, fragment_id, start_offset, end_offset, color, exact, prefix, suffix)
                        VALUES (:id, :user_id, :fragment_id, :start, :end, :color, 'text', '', '')
                    """),
                    {
                        "id": uuid4(),
                        "user_id": user_id,
                        "fragment_id": fragment_id,
                        "start": start,
                        "end": end,
                        "color": color,
                    },
                )

            session.commit()

            # Verify all highlights were inserted
            result = session.execute(
                text("SELECT COUNT(*) FROM highlights WHERE fragment_id = :fid"),
                {"fid": fragment_id},
            )
            count = result.scalar()
            assert count == len(valid_colors)

            # Clean up
            session.execute(
                text("DELETE FROM highlights WHERE fragment_id = :id"), {"id": fragment_id}
            )
            session.execute(text("DELETE FROM fragments WHERE id = :id"), {"id": fragment_id})
            session.execute(text("DELETE FROM media WHERE id = :id"), {"id": media_id})
            session.execute(text("DELETE FROM users WHERE id = :id"), {"id": user_id})
            session.commit()

    def test_overlapping_highlights_allowed(self, migrated_engine):
        """Overlapping highlights at different offsets are allowed."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            media_id = uuid4()
            fragment_id = uuid4()

            # Create user and media with fragment
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text("""
                    INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                    VALUES (:id, 'web_article', 'Test Article', 'ready_for_reading', :user_id)
                """),
                {"id": media_id, "user_id": user_id},
            )
            session.execute(
                text("""
                    INSERT INTO fragments (id, media_id, idx, canonical_text, html_sanitized)
                    VALUES (:id, :media_id, 0, 'Test canonical text content', '<p>Test</p>')
                """),
                {"id": fragment_id, "media_id": media_id},
            )
            session.commit()

            # Create first highlight: [0, 10)
            session.execute(
                text("""
                    INSERT INTO highlights (id, user_id, fragment_id, start_offset, end_offset, color, exact, prefix, suffix)
                    VALUES (:id, :user_id, :fragment_id, 0, 10, 'yellow', 'exact1', 'prefix', 'suffix')
                """),
                {"id": uuid4(), "user_id": user_id, "fragment_id": fragment_id},
            )

            # Create overlapping highlight: [5, 15) - overlaps with first
            session.execute(
                text("""
                    INSERT INTO highlights (id, user_id, fragment_id, start_offset, end_offset, color, exact, prefix, suffix)
                    VALUES (:id, :user_id, :fragment_id, 5, 15, 'blue', 'exact2', 'prefix', 'suffix')
                """),
                {"id": uuid4(), "user_id": user_id, "fragment_id": fragment_id},
            )

            # Create nested highlight: [2, 8) - contained within first
            session.execute(
                text("""
                    INSERT INTO highlights (id, user_id, fragment_id, start_offset, end_offset, color, exact, prefix, suffix)
                    VALUES (:id, :user_id, :fragment_id, 2, 8, 'green', 'exact3', 'prefix', 'suffix')
                """),
                {"id": uuid4(), "user_id": user_id, "fragment_id": fragment_id},
            )

            session.commit()

            # Verify all highlights were inserted
            result = session.execute(
                text("SELECT COUNT(*) FROM highlights WHERE fragment_id = :fid"),
                {"fid": fragment_id},
            )
            assert result.scalar() == 3

            # Clean up
            session.execute(
                text("DELETE FROM highlights WHERE fragment_id = :id"), {"id": fragment_id}
            )
            session.execute(text("DELETE FROM fragments WHERE id = :id"), {"id": fragment_id})
            session.execute(text("DELETE FROM media WHERE id = :id"), {"id": media_id})
            session.execute(text("DELETE FROM users WHERE id = :id"), {"id": user_id})
            session.commit()


class TestCeleryAndRedis:
    """Tests for Celery app and Redis connectivity."""

    def test_celery_app_initializes(self):
        """Worker app can be imported without error."""
        from apps.worker.main import celery_app

        assert celery_app is not None
        # Just check the broker URL is configured (may be None in test env without REDIS_URL)
        # The app should still initialize

    def test_redis_connectivity(self):
        """Redis is reachable if REDIS_URL is set."""
        import os

        redis_url = os.environ.get("REDIS_URL")
        if not redis_url:
            pytest.skip("REDIS_URL not set, skipping Redis connectivity test")

        from redis import Redis

        r = Redis.from_url(redis_url)
        assert r.ping()


class TestS3SchemaConstraints:
    """Tests for S3-specific schema constraints (chat, conversations, messages, etc.)."""

    def test_conversation_sharing_constraint(self, migrated_engine):
        """CHECK constraint prevents invalid sharing values."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})

            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO conversations (id, owner_user_id, sharing)
                        VALUES (:id, :user_id, 'invalid_sharing')
                    """),
                    {"id": uuid4(), "user_id": user_id},
                )
                session.commit()

            session.rollback()
            assert "ck_conversations_sharing" in str(exc_info.value)

    def test_conversation_next_seq_positive_constraint(self, migrated_engine):
        """CHECK constraint prevents next_seq < 1."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})

            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO conversations (id, owner_user_id, sharing, next_seq)
                        VALUES (:id, :user_id, 'private', 0)
                    """),
                    {"id": uuid4(), "user_id": user_id},
                )
                session.commit()

            session.rollback()
            assert "ck_conversations_next_seq_positive" in str(exc_info.value)

    def test_message_pending_only_assistant_constraint(self, migrated_engine):
        """CHECK constraint: pending status only valid for assistant role."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            conversation_id = uuid4()

            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text("""
                    INSERT INTO conversations (id, owner_user_id, sharing, next_seq)
                    VALUES (:id, :user_id, 'private', 1)
                """),
                {"id": conversation_id, "user_id": user_id},
            )

            # User message with pending status should fail
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO messages (id, conversation_id, seq, role, content, status)
                        VALUES (:id, :conv_id, 1, 'user', 'test', 'pending')
                    """),
                    {"id": uuid4(), "conv_id": conversation_id},
                )
                session.commit()

            session.rollback()
            assert "ck_messages_pending_only_assistant" in str(exc_info.value)

    def test_message_pending_assistant_allowed(self, migrated_engine):
        """Assistant message with pending status is allowed."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            conversation_id = uuid4()

            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text("""
                    INSERT INTO conversations (id, owner_user_id, sharing, next_seq)
                    VALUES (:id, :user_id, 'private', 2)
                """),
                {"id": conversation_id, "user_id": user_id},
            )

            # Assistant message with pending status should succeed
            session.execute(
                text("""
                    INSERT INTO messages (id, conversation_id, seq, role, content, status)
                    VALUES (:id, :conv_id, 1, 'assistant', '', 'pending')
                """),
                {"id": uuid4(), "conv_id": conversation_id},
            )
            session.commit()

    def test_message_conversation_seq_unique(self, migrated_engine):
        """UNIQUE constraint on (conversation_id, seq)."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            conversation_id = uuid4()

            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text("""
                    INSERT INTO conversations (id, owner_user_id, sharing, next_seq)
                    VALUES (:id, :user_id, 'private', 3)
                """),
                {"id": conversation_id, "user_id": user_id},
            )

            # First message with seq=1
            session.execute(
                text("""
                    INSERT INTO messages (id, conversation_id, seq, role, content, status)
                    VALUES (:id, :conv_id, 1, 'user', 'first', 'complete')
                """),
                {"id": uuid4(), "conv_id": conversation_id},
            )
            session.commit()

            # Duplicate seq should fail
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO messages (id, conversation_id, seq, role, content, status)
                        VALUES (:id, :conv_id, 1, 'user', 'duplicate', 'complete')
                    """),
                    {"id": uuid4(), "conv_id": conversation_id},
                )
                session.commit()

            session.rollback()
            assert "uix_messages_conversation_seq" in str(exc_info.value)

    def test_message_context_one_target_constraint(self, migrated_engine):
        """CHECK constraint: exactly one FK must be non-null."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            conversation_id = uuid4()
            message_id = uuid4()
            media_id = uuid4()

            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text("""
                    INSERT INTO conversations (id, owner_user_id, sharing, next_seq)
                    VALUES (:id, :user_id, 'private', 2)
                """),
                {"id": conversation_id, "user_id": user_id},
            )
            session.execute(
                text("""
                    INSERT INTO messages (id, conversation_id, seq, role, content, status)
                    VALUES (:id, :conv_id, 1, 'user', 'test', 'complete')
                """),
                {"id": message_id, "conv_id": conversation_id},
            )
            session.execute(
                text("""
                    INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                    VALUES (:id, 'web_article', 'Test', 'ready_for_reading', :user_id)
                """),
                {"id": media_id, "user_id": user_id},
            )
            session.commit()

            # Context with no FK should fail
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO message_contexts (id, message_id, target_type, ordinal)
                        VALUES (:id, :msg_id, 'media', 0)
                    """),
                    {"id": uuid4(), "msg_id": message_id},
                )
                session.commit()

            session.rollback()
            assert "ck_message_contexts_one_target" in str(exc_info.value)

    def test_user_api_key_nonce_length_constraint(self, migrated_engine):
        """CHECK constraint: nonce must be exactly 24 bytes."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})

            # Nonce with wrong length should fail
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO user_api_keys (id, user_id, provider, encrypted_key, key_nonce, key_fingerprint)
                        VALUES (:id, :user_id, 'openai', :key, :nonce, 'xxxx')
                    """),
                    {
                        "id": uuid4(),
                        "user_id": user_id,
                        "key": b"encrypted_key_data",
                        "nonce": b"too_short",  # Not 24 bytes
                    },
                )
                session.commit()

            session.rollback()
            assert "ck_user_api_keys_nonce_len" in str(exc_info.value)

    def test_user_api_key_user_provider_unique(self, migrated_engine):
        """UNIQUE constraint: one key per provider per user."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})

            valid_nonce = b"x" * 24  # 24 bytes

            # First key
            session.execute(
                text("""
                    INSERT INTO user_api_keys (id, user_id, provider, encrypted_key, key_nonce, key_fingerprint)
                    VALUES (:id, :user_id, 'openai', :key, :nonce, 'xxxx')
                """),
                {
                    "id": uuid4(),
                    "user_id": user_id,
                    "key": b"encrypted_key_1",
                    "nonce": valid_nonce,
                },
            )
            session.commit()

            # Duplicate key for same provider should fail
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO user_api_keys (id, user_id, provider, encrypted_key, key_nonce, key_fingerprint)
                        VALUES (:id, :user_id, 'openai', :key, :nonce, 'yyyy')
                    """),
                    {
                        "id": uuid4(),
                        "user_id": user_id,
                        "key": b"encrypted_key_2",
                        "nonce": valid_nonce,
                    },
                )
                session.commit()

            session.rollback()
            assert "uix_user_api_keys_user_provider" in str(exc_info.value)

    def test_idempotency_key_length_constraint(self, migrated_engine):
        """CHECK constraint: key length between 1 and 128."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            conversation_id = uuid4()
            msg1_id = uuid4()
            msg2_id = uuid4()

            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text("""
                    INSERT INTO conversations (id, owner_user_id, sharing, next_seq)
                    VALUES (:id, :user_id, 'private', 3)
                """),
                {"id": conversation_id, "user_id": user_id},
            )
            session.execute(
                text("""
                    INSERT INTO messages (id, conversation_id, seq, role, content, status)
                    VALUES (:id, :conv_id, 1, 'user', 'test', 'complete')
                """),
                {"id": msg1_id, "conv_id": conversation_id},
            )
            session.execute(
                text("""
                    INSERT INTO messages (id, conversation_id, seq, role, content, status)
                    VALUES (:id, :conv_id, 2, 'assistant', 'response', 'complete')
                """),
                {"id": msg2_id, "conv_id": conversation_id},
            )
            session.commit()

            # Key too long should fail
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO idempotency_keys (user_id, key, payload_hash, user_message_id, assistant_message_id, expires_at)
                        VALUES (:user_id, :key, 'hash', :msg1, :msg2, now() + interval '1 day')
                    """),
                    {
                        "user_id": user_id,
                        "key": "x" * 129,  # Too long
                        "msg1": msg1_id,
                        "msg2": msg2_id,
                    },
                )
                session.commit()

            session.rollback()
            assert "ck_idempotency_keys_key_length" in str(exc_info.value)

    def test_fragment_block_offsets_constraint(self, migrated_engine):
        """CHECK constraint: end_offset >= start_offset."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            media_id = uuid4()
            fragment_id = uuid4()

            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text("""
                    INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                    VALUES (:id, 'web_article', 'Test', 'ready_for_reading', :user_id)
                """),
                {"id": media_id, "user_id": user_id},
            )
            session.execute(
                text("""
                    INSERT INTO fragments (id, media_id, idx, canonical_text, html_sanitized)
                    VALUES (:id, :media_id, 0, 'Test', '<p>Test</p>')
                """),
                {"id": fragment_id, "media_id": media_id},
            )
            session.commit()

            # end < start should fail
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO fragment_blocks (id, fragment_id, block_idx, start_offset, end_offset)
                        VALUES (:id, :frag_id, 0, 10, 5)
                    """),
                    {"id": uuid4(), "frag_id": fragment_id},
                )
                session.commit()

            session.rollback()
            assert "ck_fragment_blocks_offsets" in str(exc_info.value)

    def test_generated_tsvector_columns_exist(self, migrated_engine):
        """Generated tsvector columns exist and are STORED."""
        with Session(migrated_engine) as session:
            # Check media.title_tsv
            result = session.execute(
                text("""
                    SELECT is_generated FROM information_schema.columns
                    WHERE table_name = 'media' AND column_name = 'title_tsv'
                """)
            )
            row = result.fetchone()
            assert row is not None, "media.title_tsv column should exist"
            assert row[0] == "ALWAYS", "title_tsv should be a generated column"

            # Check fragments.canonical_text_tsv
            result = session.execute(
                text("""
                    SELECT is_generated FROM information_schema.columns
                    WHERE table_name = 'fragments' AND column_name = 'canonical_text_tsv'
                """)
            )
            row = result.fetchone()
            assert row is not None, "fragments.canonical_text_tsv column should exist"
            assert row[0] == "ALWAYS"

            # Check annotations.body_tsv
            result = session.execute(
                text("""
                    SELECT is_generated FROM information_schema.columns
                    WHERE table_name = 'annotations' AND column_name = 'body_tsv'
                """)
            )
            row = result.fetchone()
            assert row is not None, "annotations.body_tsv column should exist"
            assert row[0] == "ALWAYS"

            # Check messages.content_tsv
            result = session.execute(
                text("""
                    SELECT is_generated FROM information_schema.columns
                    WHERE table_name = 'messages' AND column_name = 'content_tsv'
                """)
            )
            row = result.fetchone()
            assert row is not None, "messages.content_tsv column should exist"
            assert row[0] == "ALWAYS"

    def test_gin_indexes_exist(self, migrated_engine):
        """GIN indexes exist for tsvector columns."""
        with Session(migrated_engine) as session:
            # Check for GIN indexes
            result = session.execute(
                text("""
                    SELECT indexname, indexdef FROM pg_indexes
                    WHERE tablename IN ('media', 'fragments', 'annotations', 'messages')
                    AND indexdef LIKE '%gin%'
                """)
            )
            rows = result.fetchall()
            index_names = [row[0] for row in rows]

            assert "idx_media_title_tsv" in index_names
            assert "idx_fragments_canonical_text_tsv" in index_names
            assert "idx_annotations_body_tsv" in index_names
            assert "idx_messages_content_tsv" in index_names

    def test_models_provider_model_name_unique(self, migrated_engine):
        """UNIQUE constraint on (provider, model_name)."""
        with Session(migrated_engine) as session:
            # First model
            session.execute(
                text("""
                    INSERT INTO models (id, provider, model_name, max_context_tokens)
                    VALUES (:id, 'openai', 'gpt-4', 8192)
                """),
                {"id": uuid4()},
            )
            session.commit()

            # Duplicate should fail
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO models (id, provider, model_name, max_context_tokens)
                        VALUES (:id, 'openai', 'gpt-4', 8192)
                    """),
                    {"id": uuid4()},
                )
                session.commit()

            session.rollback()
            assert "uix_models_provider_model_name" in str(exc_info.value)
