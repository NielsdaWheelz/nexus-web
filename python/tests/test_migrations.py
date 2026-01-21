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
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO media (id, kind, title, processing_status)
                        VALUES (:id, 'invalid_kind', 'Test', 'pending')
                    """),
                    {"id": uuid4()},
                )
                session.commit()

            session.rollback()
            assert "ck_media_kind" in str(exc_info.value)

    def test_invalid_processing_status_rejected(self, migrated_engine):
        """Check constraint prevents invalid processing status values."""
        with Session(migrated_engine) as session:
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO media (id, kind, title, processing_status)
                        VALUES (:id, 'web_article', 'Test', 'invalid_status')
                    """),
                    {"id": uuid4()},
                )
                session.commit()

            session.rollback()
            assert "ck_media_processing_status" in str(exc_info.value)

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
            for kind in valid_kinds:
                media_id = uuid4()
                session.execute(
                    text("""
                        INSERT INTO media (id, kind, title, processing_status)
                        VALUES (:id, :kind, :title, 'pending')
                    """),
                    {"id": media_id, "kind": kind, "title": f"Test {kind}"},
                )

            session.commit()

            # Verify all were inserted
            result = session.execute(text("SELECT COUNT(*) FROM media"))
            count = result.scalar()
            assert count == len(valid_kinds)

            # Clean up
            session.execute(text("DELETE FROM media"))
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
            for status in valid_statuses:
                media_id = uuid4()
                session.execute(
                    text("""
                        INSERT INTO media (id, kind, title, processing_status)
                        VALUES (:id, 'web_article', :title, :status)
                    """),
                    {"id": media_id, "title": f"Test {status}", "status": status},
                )

            session.commit()

            # Clean up
            session.execute(text("DELETE FROM media"))
            session.commit()
