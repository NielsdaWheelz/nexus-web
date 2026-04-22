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

pytestmark = pytest.mark.integration


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


def insert_canonical_fragment_highlight(
    session: Session,
    *,
    highlight_id,
    user_id,
    media_id,
    fragment_id,
    start_offset: int,
    end_offset: int,
    color: str = "yellow",
    exact: str = "exact",
    prefix: str = "prefix",
    suffix: str = "suffix",
    created_at=None,
) -> None:
    """Insert a head-schema fragment highlight plus its canonical anchor row."""
    highlight_params = {
        "id": highlight_id,
        "user_id": user_id,
        "media_id": media_id,
        "color": color,
        "exact": exact,
        "prefix": prefix,
        "suffix": suffix,
    }
    if created_at is None:
        session.execute(
            text(
                """
                INSERT INTO highlights (
                    id,
                    user_id,
                    anchor_kind,
                    anchor_media_id,
                    color,
                    exact,
                    prefix,
                    suffix
                )
                VALUES (
                    :id,
                    :user_id,
                    'fragment_offsets',
                    :media_id,
                    :color,
                    :exact,
                    :prefix,
                    :suffix
                )
                """
            ),
            highlight_params,
        )
    else:
        session.execute(
            text(
                """
                INSERT INTO highlights (
                    id,
                    user_id,
                    anchor_kind,
                    anchor_media_id,
                    color,
                    exact,
                    prefix,
                    suffix,
                    created_at
                )
                VALUES (
                    :id,
                    :user_id,
                    'fragment_offsets',
                    :media_id,
                    :color,
                    :exact,
                    :prefix,
                    :suffix,
                    :created_at
                )
                """
            ),
            {**highlight_params, "created_at": created_at},
        )

    session.execute(
        text(
            """
            INSERT INTO highlight_fragment_anchors (
                highlight_id,
                fragment_id,
                start_offset,
                end_offset
            )
            VALUES (
                :highlight_id,
                :fragment_id,
                :start_offset,
                :end_offset
            )
            """
        ),
        {
            "highlight_id": highlight_id,
            "fragment_id": fragment_id,
            "start_offset": start_offset,
            "end_offset": end_offset,
        },
    )


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

    def test_billing_plan_tier_constraint_rejected(self, migrated_engine):
        with Session(migrated_engine) as session:
            user_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO billing_accounts (id, user_id, plan_tier, created_at, updated_at)
                        VALUES (:id, :user_id, 'legacy_paid', now(), now())
                    """),
                    {"id": uuid4(), "user_id": user_id},
                )
                session.commit()

            session.rollback()
            assert "ck_billing_accounts_plan_tier" in str(exc_info.value)

    def test_billing_account_user_unique_constraint_rejected(self, migrated_engine):
        with Session(migrated_engine) as session:
            user_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text("""
                    INSERT INTO billing_accounts (id, user_id, plan_tier, created_at, updated_at)
                    VALUES (:id, :user_id, 'free', now(), now())
                """),
                {"id": uuid4(), "user_id": user_id},
            )
            session.commit()

            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO billing_accounts (id, user_id, plan_tier, created_at, updated_at)
                        VALUES (:id, :user_id, 'plus', now(), now())
                    """),
                    {"id": uuid4(), "user_id": user_id},
                )
                session.commit()

            session.rollback()
            assert "uq_billing_accounts_user_id" in str(exc_info.value)

    def test_pages_title_length_constraint_rejected(self, migrated_engine):
        with Session(migrated_engine) as session:
            user_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO pages (id, user_id, title, body)
                        VALUES (:id, :user_id, '', 'body')
                    """),
                    {"id": uuid4(), "user_id": user_id},
                )
                session.commit()

            session.rollback()
            assert "ck_pages_title_length" in str(exc_info.value)

    def test_billing_webhook_event_duplicate_rejected(self, migrated_engine):
        with Session(migrated_engine) as session:
            event_id = "evt_test_1"
            session.execute(
                text("""
                    INSERT INTO stripe_webhook_events (
                        id,
                        stripe_event_id,
                        event_type,
                        processed_at,
                        created_at
                    )
                    VALUES (:id, :stripe_event_id, 'checkout.session.completed', now(), now())
                """),
                {"id": uuid4(), "stripe_event_id": event_id},
            )
            session.commit()

            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO stripe_webhook_events (
                            id,
                            stripe_event_id,
                            event_type,
                            processed_at,
                            created_at
                        )
                        VALUES (:id, :stripe_event_id, 'checkout.session.completed', now(), now())
                    """),
                    {"id": uuid4(), "stripe_event_id": event_id},
                )
                session.commit()

            session.rollback()
            assert "uq_stripe_webhook_events_stripe_event_id" in str(exc_info.value)

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

    def test_fragment_time_offsets_require_strictly_increasing_ranges(self, migrated_engine):
        """Fragment transcript timing must enforce t_start_ms < t_end_ms."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            media_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text(
                    """
                    INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                    VALUES (:id, 'podcast_episode', 'Timing Test', 'ready_for_reading', :user_id)
                    """
                ),
                {"id": media_id, "user_id": user_id},
            )
            session.commit()

            # Valid strict range succeeds.
            session.execute(
                text(
                    """
                    INSERT INTO fragments (
                        id, media_id, idx, canonical_text, html_sanitized, t_start_ms, t_end_ms
                    )
                    VALUES (:id, :media_id, 0, 'ok', '<p>ok</p>', 100, 200)
                    """
                ),
                {"id": uuid4(), "media_id": media_id},
            )
            session.commit()

            # Zero-length range must fail.
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text(
                        """
                        INSERT INTO fragments (
                            id, media_id, idx, canonical_text, html_sanitized, t_start_ms, t_end_ms
                        )
                        VALUES (:id, :media_id, 1, 'zero', '<p>zero</p>', 200, 200)
                        """
                    ),
                    {"id": uuid4(), "media_id": media_id},
                )
                session.commit()
            session.rollback()
            assert "ck_fragments_time_offsets_valid" in str(exc_info.value)

            # Backwards range must fail.
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text(
                        """
                        INSERT INTO fragments (
                            id, media_id, idx, canonical_text, html_sanitized, t_start_ms, t_end_ms
                        )
                        VALUES (:id, :media_id, 2, 'backward', '<p>backward</p>', 400, 300)
                        """
                    ),
                    {"id": uuid4(), "media_id": media_id},
                )
                session.commit()
            session.rollback()
            assert "ck_fragments_time_offsets_valid" in str(exc_info.value)


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

    def test_x_provider_identity_uniqueness(self, migrated_engine):
        """Partial unique index enforces one media row per X post ID."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})

            session.execute(
                text("""
                    INSERT INTO media (
                        id, kind, title, processing_status, created_by_user_id,
                        provider, provider_id
                    )
                    VALUES (
                        :id, 'web_article', 'First X Post', 'ready_for_reading', :user_id,
                        'x', '1234567890'
                    )
                """),
                {"id": uuid4(), "user_id": user_id},
            )
            session.commit()

            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO media (
                            id, kind, title, processing_status, created_by_user_id,
                            provider, provider_id
                        )
                        VALUES (
                            :id, 'web_article', 'Second X Post', 'ready_for_reading', :user_id,
                            'x', '1234567890'
                        )
                    """),
                    {"id": uuid4(), "user_id": user_id},
                )
                session.commit()

            session.rollback()
            assert "uix_media_x_provider_id" in str(exc_info.value)

            session.execute(
                text("""
                    INSERT INTO media (
                        id, kind, title, processing_status, created_by_user_id,
                        provider, provider_id
                    )
                    VALUES (
                        :id, 'video', 'YouTube Fixture', 'ready_for_reading', :user_id,
                        'youtube', '1234567890'
                    )
                """),
                {"id": uuid4(), "user_id": user_id},
            )
            session.execute(
                text("""
                    INSERT INTO media (
                        id, kind, title, processing_status, created_by_user_id,
                        provider, provider_id
                    )
                    VALUES (
                        :id, 'video', 'Second YouTube Fixture', 'ready_for_reading', :user_id,
                        'youtube', '1234567890'
                    )
                """),
                {"id": uuid4(), "user_id": user_id},
            )
            session.commit()

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
                        INSERT INTO highlights (
                            id, user_id, anchor_kind, anchor_media_id, color, exact, prefix, suffix
                        )
                        VALUES (
                            :id, :user_id, 'fragment_offsets', :media_id,
                            'invalid_color', 'exact', 'prefix', 'suffix'
                        )
                    """),
                    {"id": uuid4(), "user_id": user_id, "media_id": media_id},
                )
                session.commit()

            session.rollback()
            assert "ck_highlights_color" in str(exc_info.value)

            # Clean up
            session.execute(text("DELETE FROM fragments WHERE id = :id"), {"id": fragment_id})
            session.execute(text("DELETE FROM media WHERE id = :id"), {"id": media_id})
            session.execute(text("DELETE FROM users WHERE id = :id"), {"id": user_id})
            session.commit()

    def test_invalid_fragment_anchor_offsets_rejected(self, migrated_engine):
        """Canonical fragment anchor rows reject invalid offset ranges."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            media_id = uuid4()
            fragment_id = uuid4()
            highlight_id = uuid4()

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

            session.execute(
                text("""
                    INSERT INTO highlights (
                        id, user_id, anchor_kind, anchor_media_id, color, exact, prefix, suffix
                    )
                    VALUES (
                        :id, :user_id, 'fragment_offsets', :media_id,
                        'yellow', 'exact', 'prefix', 'suffix'
                    )
                """),
                {"id": highlight_id, "user_id": user_id, "media_id": media_id},
            )
            session.commit()

            # Test case 1: end_offset <= start_offset (end == start)
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO highlight_fragment_anchors (
                            highlight_id, fragment_id, start_offset, end_offset
                        )
                        VALUES (:highlight_id, :fragment_id, 10, 10)
                    """),
                    {"highlight_id": highlight_id, "fragment_id": fragment_id},
                )
                session.commit()

            session.rollback()
            assert "ck_hfa_offsets_valid" in str(exc_info.value)

            # Test case 2: end_offset < start_offset
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO highlight_fragment_anchors (
                            highlight_id, fragment_id, start_offset, end_offset
                        )
                        VALUES (:highlight_id, :fragment_id, 10, 5)
                    """),
                    {"highlight_id": highlight_id, "fragment_id": fragment_id},
                )
                session.commit()

            session.rollback()
            assert "ck_hfa_offsets_valid" in str(exc_info.value)

            # Test case 3: negative start_offset
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO highlight_fragment_anchors (
                            highlight_id, fragment_id, start_offset, end_offset
                        )
                        VALUES (:highlight_id, :fragment_id, -1, 10)
                    """),
                    {"highlight_id": highlight_id, "fragment_id": fragment_id},
                )
                session.commit()

            session.rollback()
            assert "ck_hfa_offsets_valid" in str(exc_info.value)

            # Clean up
            session.execute(text("DELETE FROM highlights WHERE id = :id"), {"id": highlight_id})
            session.execute(text("DELETE FROM fragments WHERE id = :id"), {"id": fragment_id})
            session.execute(text("DELETE FROM media WHERE id = :id"), {"id": media_id})
            session.execute(text("DELETE FROM users WHERE id = :id"), {"id": user_id})
            session.commit()

    def test_duplicate_fragment_spans_are_not_db_constrained_at_head(self, migrated_engine):
        """Head schema no longer keeps a bridge-column unique index for fragment spans."""
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

            insert_canonical_fragment_highlight(
                session,
                highlight_id=uuid4(),
                user_id=user_id,
                media_id=media_id,
                fragment_id=fragment_id,
                start_offset=0,
                end_offset=10,
                color="yellow",
                exact="exact",
            )
            insert_canonical_fragment_highlight(
                session,
                highlight_id=uuid4(),
                user_id=user_id,
                media_id=media_id,
                fragment_id=fragment_id,
                start_offset=0,
                end_offset=10,
                color="blue",
                exact="exact",
            )
            session.commit()

            count = session.execute(
                text(
                    "SELECT COUNT(*) FROM highlight_fragment_anchors "
                    "WHERE fragment_id = :fragment_id AND start_offset = 0 AND end_offset = 10"
                ),
                {"fragment_id": fragment_id},
            ).scalar_one()
            assert count == 2

            # Clean up
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
                    INSERT INTO highlights (
                        id, user_id, anchor_kind, anchor_media_id, color, exact, prefix, suffix
                    )
                    VALUES (
                        :id, :user_id, 'fragment_offsets', :media_id,
                        'yellow', 'exact', 'prefix', 'suffix'
                    )
                """),
                {"id": highlight_id, "user_id": user_id, "media_id": media_id},
            )
            session.execute(
                text("""
                    INSERT INTO highlight_fragment_anchors (
                        highlight_id, fragment_id, start_offset, end_offset
                    )
                    VALUES (:highlight_id, :fragment_id, 0, 10)
                """),
                {"highlight_id": highlight_id, "fragment_id": fragment_id},
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
                    INSERT INTO highlights (
                        id, user_id, anchor_kind, anchor_media_id, color, exact, prefix, suffix
                    )
                    VALUES (
                        :id, :user_id, 'fragment_offsets', :media_id,
                        'yellow', 'exact', 'prefix', 'suffix'
                    )
                """),
                {"id": highlight_id, "user_id": user_id, "media_id": media_id},
            )
            session.execute(
                text("""
                    INSERT INTO highlight_fragment_anchors (
                        highlight_id, fragment_id, start_offset, end_offset
                    )
                    VALUES (:highlight_id, :fragment_id, 0, 10)
                """),
                {"highlight_id": highlight_id, "fragment_id": fragment_id},
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
                    INSERT INTO highlights (
                        id, user_id, anchor_kind, anchor_media_id, color, exact, prefix, suffix
                    )
                    VALUES (
                        :id, :user_id, 'fragment_offsets', :media_id,
                        'yellow', 'exact', 'prefix', 'suffix'
                    )
                """),
                {"id": highlight_id, "user_id": user_id, "media_id": media_id},
            )
            session.execute(
                text("""
                    INSERT INTO highlight_fragment_anchors (
                        highlight_id, fragment_id, start_offset, end_offset
                    )
                    VALUES (:highlight_id, :fragment_id, 0, 10)
                """),
                {"highlight_id": highlight_id, "fragment_id": fragment_id},
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

            # Create highlights with each valid color.
            for i, color in enumerate(valid_colors):
                start = i * 5
                end = start + 4
                insert_canonical_fragment_highlight(
                    session,
                    highlight_id=uuid4(),
                    user_id=user_id,
                    media_id=media_id,
                    fragment_id=fragment_id,
                    start_offset=start,
                    end_offset=end,
                    color=color,
                    exact="text",
                    prefix="",
                    suffix="",
                )

            session.commit()

            # Verify all highlights were inserted
            result = session.execute(
                text("SELECT COUNT(*) FROM highlight_fragment_anchors WHERE fragment_id = :fid"),
                {"fid": fragment_id},
            )
            count = result.scalar()
            assert count == len(valid_colors)

            # Clean up
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
            insert_canonical_fragment_highlight(
                session,
                highlight_id=uuid4(),
                user_id=user_id,
                media_id=media_id,
                fragment_id=fragment_id,
                start_offset=0,
                end_offset=10,
                color="yellow",
                exact="exact1",
            )

            # Create overlapping highlight: [5, 15) - overlaps with first
            insert_canonical_fragment_highlight(
                session,
                highlight_id=uuid4(),
                user_id=user_id,
                media_id=media_id,
                fragment_id=fragment_id,
                start_offset=5,
                end_offset=15,
                color="blue",
                exact="exact2",
            )

            # Create nested highlight: [2, 8) - contained within first
            insert_canonical_fragment_highlight(
                session,
                highlight_id=uuid4(),
                user_id=user_id,
                media_id=media_id,
                fragment_id=fragment_id,
                start_offset=2,
                end_offset=8,
                color="green",
                exact="exact3",
            )

            session.commit()

            # Verify all highlights were inserted
            result = session.execute(
                text("SELECT COUNT(*) FROM highlight_fragment_anchors WHERE fragment_id = :fid"),
                {"fid": fragment_id},
            )
            assert result.scalar() == 3

            # Clean up
            session.execute(text("DELETE FROM fragments WHERE id = :id"), {"id": fragment_id})
            session.execute(text("DELETE FROM media WHERE id = :id"), {"id": media_id})
            session.execute(text("DELETE FROM users WHERE id = :id"), {"id": user_id})
            session.commit()


class TestWorkerRuntime:
    """Tests for worker runtime import and initialization."""

    def test_worker_app_initializes(self):
        """Worker app can be imported and constructed without error."""
        from apps.worker.main import create_worker

        worker = create_worker()
        assert worker is not None
        assert len(worker.registry) > 0


class TestS4Migration0007:
    """Tests for S4 migration 0007 — library sharing schema.

    Each test self-manages migration state (downgrade base -> upgrade target).
    Does NOT rely on the module-level migrated_engine fixture.
    """

    @pytest.fixture(autouse=True)
    def isolate_migration(self):
        """Start and end each test at a clean base state, restore to head."""
        run_alembic_command("downgrade base")
        yield
        run_alembic_command("downgrade base")
        run_alembic_command("upgrade head")

    @pytest.fixture
    def s4_engine(self):
        """Provide a dedicated engine for S4 tests."""
        database_url = get_test_database_url()
        engine = create_engine(database_url)
        yield engine
        engine.dispose()

    def test_upgrade_0006_to_0007_seeds_edges_and_intrinsics(self, s4_engine):
        """Seed transform produces correct closure edges and intrinsics."""
        result = run_alembic_command("upgrade 0006")
        assert result.returncode == 0, f"upgrade 0006 failed: {result.stderr}"

        u1 = uuid4()
        d1 = uuid4()  # default library for u1
        l1 = uuid4()  # non-default library
        m_edge = uuid4()  # media in l1 AND d1
        m_intrinsic_only = uuid4()  # media in d1 only

        with Session(s4_engine) as session:
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": u1})

            # Default library for u1
            session.execute(
                text(
                    "INSERT INTO libraries (id, owner_user_id, name, is_default) "
                    "VALUES (:id, :owner, 'Default', true)"
                ),
                {"id": d1, "owner": u1},
            )
            # Non-default library
            session.execute(
                text(
                    "INSERT INTO libraries (id, owner_user_id, name, is_default) "
                    "VALUES (:id, :owner, 'Shared', false)"
                ),
                {"id": l1, "owner": u1},
            )

            # u1 is member of both libraries
            session.execute(
                text(
                    "INSERT INTO memberships (library_id, user_id, role) "
                    "VALUES (:lib, :user, 'admin')"
                ),
                {"lib": d1, "user": u1},
            )
            session.execute(
                text(
                    "INSERT INTO memberships (library_id, user_id, role) "
                    "VALUES (:lib, :user, 'admin')"
                ),
                {"lib": l1, "user": u1},
            )

            # Media m_edge in l1 AND d1
            session.execute(
                text(
                    "INSERT INTO media (id, kind, title, processing_status, created_by_user_id) "
                    "VALUES (:id, 'web_article', 'Edge Article', 'ready_for_reading', :user)"
                ),
                {"id": m_edge, "user": u1},
            )
            session.execute(
                text("INSERT INTO library_media (library_id, media_id) VALUES (:lib, :med)"),
                {"lib": l1, "med": m_edge},
            )
            session.execute(
                text("INSERT INTO library_media (library_id, media_id) VALUES (:lib, :med)"),
                {"lib": d1, "med": m_edge},
            )

            # Media m_intrinsic_only in d1 only
            session.execute(
                text(
                    "INSERT INTO media (id, kind, title, processing_status, created_by_user_id) "
                    "VALUES (:id, 'web_article', 'Intrinsic Article', 'ready_for_reading', :user)"
                ),
                {"id": m_intrinsic_only, "user": u1},
            )
            session.execute(
                text("INSERT INTO library_media (library_id, media_id) VALUES (:lib, :med)"),
                {"lib": d1, "med": m_intrinsic_only},
            )

            session.commit()

        # Upgrade to 0007 — seed runs
        result = run_alembic_command("upgrade 0007")
        assert result.returncode == 0, f"upgrade 0007 failed: {result.stderr}"

        # Assert seed results
        with Session(s4_engine) as session:
            # Closure edge: (d1, m_edge, l1) must exist
            edge_count = session.execute(
                text(
                    "SELECT COUNT(*) FROM default_library_closure_edges "
                    "WHERE default_library_id = :d AND media_id = :m "
                    "AND source_library_id = :s"
                ),
                {"d": d1, "m": m_edge, "s": l1},
            ).scalar()
            assert edge_count == 1

            # Intrinsic: (d1, m_intrinsic_only) must exist
            intrinsic_count = session.execute(
                text(
                    "SELECT COUNT(*) FROM default_library_intrinsics "
                    "WHERE default_library_id = :d AND media_id = :m"
                ),
                {"d": d1, "m": m_intrinsic_only},
            ).scalar()
            assert intrinsic_count == 1

            # Intrinsic: (d1, m_edge) must NOT exist (covered by closure edge)
            edge_intrinsic = session.execute(
                text(
                    "SELECT COUNT(*) FROM default_library_intrinsics "
                    "WHERE default_library_id = :d AND media_id = :m"
                ),
                {"d": d1, "m": m_edge},
            ).scalar()
            assert edge_intrinsic == 0

            # Backfill jobs: 0 rows
            job_count = session.execute(
                text("SELECT COUNT(*) FROM default_library_backfill_jobs")
            ).scalar()
            assert job_count == 0

    def test_upgrade_0006_to_0007_fails_when_member_has_no_default_library(self, s4_engine):
        """Upgrade hard-fails with sentinel when default library is missing."""
        result = run_alembic_command("upgrade 0006")
        assert result.returncode == 0

        u_owner = uuid4()
        u_member = uuid4()
        l1 = uuid4()
        m1 = uuid4()

        with Session(s4_engine) as session:
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": u_owner})
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": u_member})

            # Owner has a default library
            owner_default = uuid4()
            session.execute(
                text(
                    "INSERT INTO libraries (id, owner_user_id, name, is_default) "
                    "VALUES (:id, :owner, 'Owner Default', true)"
                ),
                {"id": owner_default, "owner": u_owner},
            )
            session.execute(
                text(
                    "INSERT INTO memberships (library_id, user_id, role) "
                    "VALUES (:lib, :user, 'admin')"
                ),
                {"lib": owner_default, "user": u_owner},
            )

            # Non-default library owned by u_owner
            session.execute(
                text(
                    "INSERT INTO libraries (id, owner_user_id, name, is_default) "
                    "VALUES (:id, :owner, 'Shared Lib', false)"
                ),
                {"id": l1, "owner": u_owner},
            )
            session.execute(
                text(
                    "INSERT INTO memberships (library_id, user_id, role) "
                    "VALUES (:lib, :user, 'admin')"
                ),
                {"lib": l1, "user": u_owner},
            )

            # u_member is member of l1 but has NO default library
            session.execute(
                text(
                    "INSERT INTO memberships (library_id, user_id, role) "
                    "VALUES (:lib, :user, 'member')"
                ),
                {"lib": l1, "user": u_member},
            )

            # Media in l1
            session.execute(
                text(
                    "INSERT INTO media (id, kind, title, processing_status, created_by_user_id) "
                    "VALUES (:id, 'web_article', 'Article', 'ready_for_reading', :user)"
                ),
                {"id": m1, "user": u_owner},
            )
            session.execute(
                text("INSERT INTO library_media (library_id, media_id) VALUES (:lib, :med)"),
                {"lib": l1, "med": m1},
            )

            session.commit()

        # Upgrade should fail
        result = run_alembic_command("upgrade 0007")
        assert result.returncode != 0
        combined = result.stdout + result.stderr
        assert "S4_0007_MISSING_DEFAULT_LIBRARY" in combined

    def test_upgrade_0006_to_0007_seed_is_idempotent_after_downgrade_round_trip(self, s4_engine):
        """Seeded PK tuple sets are identical after downgrade + re-upgrade."""
        result = run_alembic_command("upgrade 0006")
        assert result.returncode == 0

        u1 = uuid4()
        d1 = uuid4()
        l1 = uuid4()
        m_edge = uuid4()
        m_intrinsic_only = uuid4()

        with Session(s4_engine) as session:
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": u1})
            session.execute(
                text(
                    "INSERT INTO libraries (id, owner_user_id, name, is_default) "
                    "VALUES (:id, :owner, 'Default', true)"
                ),
                {"id": d1, "owner": u1},
            )
            session.execute(
                text(
                    "INSERT INTO libraries (id, owner_user_id, name, is_default) "
                    "VALUES (:id, :owner, 'Shared', false)"
                ),
                {"id": l1, "owner": u1},
            )
            session.execute(
                text(
                    "INSERT INTO memberships (library_id, user_id, role) "
                    "VALUES (:lib, :user, 'admin')"
                ),
                {"lib": d1, "user": u1},
            )
            session.execute(
                text(
                    "INSERT INTO memberships (library_id, user_id, role) "
                    "VALUES (:lib, :user, 'admin')"
                ),
                {"lib": l1, "user": u1},
            )
            session.execute(
                text(
                    "INSERT INTO media (id, kind, title, processing_status, created_by_user_id) "
                    "VALUES (:id, 'web_article', 'Edge', 'ready_for_reading', :user)"
                ),
                {"id": m_edge, "user": u1},
            )
            session.execute(
                text("INSERT INTO library_media (library_id, media_id) VALUES (:lib, :med)"),
                {"lib": l1, "med": m_edge},
            )
            session.execute(
                text("INSERT INTO library_media (library_id, media_id) VALUES (:lib, :med)"),
                {"lib": d1, "med": m_edge},
            )
            session.execute(
                text(
                    "INSERT INTO media (id, kind, title, processing_status, created_by_user_id) "
                    "VALUES (:id, 'web_article', 'Intrinsic', 'ready_for_reading', :user)"
                ),
                {"id": m_intrinsic_only, "user": u1},
            )
            session.execute(
                text("INSERT INTO library_media (library_id, media_id) VALUES (:lib, :med)"),
                {"lib": d1, "med": m_intrinsic_only},
            )
            session.commit()

        # First upgrade
        result = run_alembic_command("upgrade 0007")
        assert result.returncode == 0

        with Session(s4_engine) as session:
            edges_first = set(
                session.execute(
                    text(
                        "SELECT default_library_id, media_id, source_library_id "
                        "FROM default_library_closure_edges"
                    )
                ).fetchall()
            )
            intrinsics_first = set(
                session.execute(
                    text("SELECT default_library_id, media_id FROM default_library_intrinsics")
                ).fetchall()
            )

        # Downgrade back to 0006
        result = run_alembic_command("downgrade 0006")
        assert result.returncode == 0

        # Second upgrade
        result = run_alembic_command("upgrade 0007")
        assert result.returncode == 0

        with Session(s4_engine) as session:
            edges_second = set(
                session.execute(
                    text(
                        "SELECT default_library_id, media_id, source_library_id "
                        "FROM default_library_closure_edges"
                    )
                ).fetchall()
            )
            intrinsics_second = set(
                session.execute(
                    text("SELECT default_library_id, media_id FROM default_library_intrinsics")
                ).fetchall()
            )

        assert edges_first == edges_second
        assert intrinsics_first == intrinsics_second

    def test_0007_supporting_indexes_exist(self, s4_engine):
        """All expected 0007 index names exist in pg_indexes."""
        result = run_alembic_command("upgrade head")
        assert result.returncode == 0

        expected_indexes = [
            # library_invitations
            "uix_library_invitations_pending_once",
            "idx_library_invitations_library_status_created",
            "idx_library_invitations_invitee_status_created",
            # default_library_intrinsics
            "idx_default_library_intrinsics_media",
            # default_library_closure_edges
            "idx_default_library_closure_edges_source",
            "idx_default_library_closure_edges_default_media",
            # default_library_backfill_jobs
            "idx_default_library_backfill_jobs_status_updated",
            # existing-table supporting indexes
            "idx_memberships_user_library_role",
            "idx_library_entries_media_library",
            "idx_conversation_shares_library_conversation",
        ]

        with Session(s4_engine) as session:
            result = session.execute(
                text("SELECT indexname FROM pg_indexes WHERE schemaname = 'public'")
            )
            existing = {row[0] for row in result.fetchall()}

        for idx_name in expected_indexes:
            assert idx_name in existing, f"Index {idx_name} not found"

    def test_library_invitations_pending_unique_partial_index(self, s4_engine):
        """Partial unique index prevents duplicate pending invites."""
        result = run_alembic_command("upgrade head")
        assert result.returncode == 0

        inviter = uuid4()
        invitee = uuid4()
        library_id = uuid4()

        with Session(s4_engine) as session:
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": inviter})
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": invitee})
            session.execute(
                text(
                    "INSERT INTO libraries (id, owner_user_id, name, is_default) "
                    "VALUES (:id, :owner, 'Test', false)"
                ),
                {"id": library_id, "owner": inviter},
            )

            # First pending invite
            session.execute(
                text(
                    "INSERT INTO library_invitations "
                    "(id, library_id, inviter_user_id, invitee_user_id, role, status) "
                    "VALUES (:id, :lib, :inviter, :invitee, 'member', 'pending')"
                ),
                {"id": uuid4(), "lib": library_id, "inviter": inviter, "invitee": invitee},
            )
            session.commit()

            # Duplicate pending invite should fail
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text(
                        "INSERT INTO library_invitations "
                        "(id, library_id, inviter_user_id, invitee_user_id, role, status) "
                        "VALUES (:id, :lib, :inviter, :invitee, 'member', 'pending')"
                    ),
                    {
                        "id": uuid4(),
                        "lib": library_id,
                        "inviter": inviter,
                        "invitee": invitee,
                    },
                )
                session.commit()

            session.rollback()
            assert "uix_library_invitations_pending_once" in str(exc_info.value)

    def test_library_invitations_responded_at_check_constraint(self, s4_engine):
        """Check constraint enforces responded_at/status consistency."""
        result = run_alembic_command("upgrade head")
        assert result.returncode == 0

        inviter = uuid4()
        invitee = uuid4()
        library_id = uuid4()

        with Session(s4_engine) as session:
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": inviter})
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": invitee})
            session.execute(
                text(
                    "INSERT INTO libraries (id, owner_user_id, name, is_default) "
                    "VALUES (:id, :owner, 'Test', false)"
                ),
                {"id": library_id, "owner": inviter},
            )
            session.commit()

            # pending with non-null responded_at → must fail
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text(
                        "INSERT INTO library_invitations "
                        "(id, library_id, inviter_user_id, invitee_user_id, role, status, responded_at) "
                        "VALUES (:id, :lib, :inviter, :invitee, 'member', 'pending', now())"
                    ),
                    {"id": uuid4(), "lib": library_id, "inviter": inviter, "invitee": invitee},
                )
                session.commit()
            session.rollback()
            assert "ck_library_invitations_responded_at" in str(exc_info.value)

            # accepted with null responded_at → must fail
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text(
                        "INSERT INTO library_invitations "
                        "(id, library_id, inviter_user_id, invitee_user_id, role, status, responded_at) "
                        "VALUES (:id, :lib, :inviter, :invitee, 'member', 'accepted', NULL)"
                    ),
                    {"id": uuid4(), "lib": library_id, "inviter": inviter, "invitee": invitee},
                )
                session.commit()
            session.rollback()
            assert "ck_library_invitations_responded_at" in str(exc_info.value)

            # valid terminal: accepted with non-null responded_at → must succeed
            session.execute(
                text(
                    "INSERT INTO library_invitations "
                    "(id, library_id, inviter_user_id, invitee_user_id, role, status, responded_at) "
                    "VALUES (:id, :lib, :inviter, :invitee, 'member', 'accepted', now())"
                ),
                {"id": uuid4(), "lib": library_id, "inviter": inviter, "invitee": invitee},
            )
            session.commit()

    def test_library_invitations_not_self_check_constraint(self, s4_engine):
        """Check constraint prevents self-invitations."""
        result = run_alembic_command("upgrade head")
        assert result.returncode == 0

        user = uuid4()
        library_id = uuid4()

        with Session(s4_engine) as session:
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user})
            session.execute(
                text(
                    "INSERT INTO libraries (id, owner_user_id, name, is_default) "
                    "VALUES (:id, :owner, 'Test', false)"
                ),
                {"id": library_id, "owner": user},
            )
            session.commit()

            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text(
                        "INSERT INTO library_invitations "
                        "(id, library_id, inviter_user_id, invitee_user_id, role, status) "
                        "VALUES (:id, :lib, :user, :user, 'member', 'pending')"
                    ),
                    {"id": uuid4(), "lib": library_id, "user": user},
                )
                session.commit()

            session.rollback()
            assert "ck_library_invitations_not_self" in str(exc_info.value)

    def test_default_library_backfill_jobs_finished_at_state_constraint(self, s4_engine):
        """Check constraint enforces finished_at/status consistency for backfill jobs."""
        result = run_alembic_command("upgrade head")
        assert result.returncode == 0

        user = uuid4()
        default_lib = uuid4()
        source_lib = uuid4()

        with Session(s4_engine) as session:
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user})
            session.execute(
                text(
                    "INSERT INTO libraries (id, owner_user_id, name, is_default) "
                    "VALUES (:id, :owner, 'Default', true)"
                ),
                {"id": default_lib, "owner": user},
            )
            session.execute(
                text(
                    "INSERT INTO libraries (id, owner_user_id, name, is_default) "
                    "VALUES (:id, :owner, 'Source', false)"
                ),
                {"id": source_lib, "owner": user},
            )
            session.commit()

            # pending with non-null finished_at → must fail
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text(
                        "INSERT INTO default_library_backfill_jobs "
                        "(default_library_id, source_library_id, user_id, status, finished_at) "
                        "VALUES (:dl, :sl, :u, 'pending', now())"
                    ),
                    {"dl": default_lib, "sl": source_lib, "u": user},
                )
                session.commit()
            session.rollback()
            assert "ck_default_library_backfill_jobs_finished_at_state" in str(exc_info.value)

            # completed with null finished_at → must fail
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text(
                        "INSERT INTO default_library_backfill_jobs "
                        "(default_library_id, source_library_id, user_id, status, finished_at) "
                        "VALUES (:dl, :sl, :u, 'completed', NULL)"
                    ),
                    {"dl": default_lib, "sl": source_lib, "u": user},
                )
                session.commit()
            session.rollback()
            assert "ck_default_library_backfill_jobs_finished_at_state" in str(exc_info.value)

            # valid: completed with non-null finished_at → must succeed
            session.execute(
                text(
                    "INSERT INTO default_library_backfill_jobs "
                    "(default_library_id, source_library_id, user_id, status, finished_at) "
                    "VALUES (:dl, :sl, :u, 'completed', now())"
                ),
                {"dl": default_lib, "sl": source_lib, "u": user},
            )
            session.commit()


class TestS5Migration0008:
    """Tests for S5 migration 0008 — epub_toc_nodes schema.

    Each test self-manages migration state (downgrade base -> upgrade target).
    Does NOT rely on the module-level migrated_engine fixture.
    """

    @pytest.fixture(autouse=True)
    def isolate_migration(self):
        """Start and end each test at a clean base state, restore to head."""
        run_alembic_command("downgrade base")
        yield
        run_alembic_command("downgrade base")
        run_alembic_command("upgrade head")

    @pytest.fixture
    def s5_engine(self):
        """Provide a dedicated engine for S5 tests."""
        database_url = get_test_database_url()
        engine = create_engine(database_url)
        yield engine
        engine.dispose()

    def _create_epub_fixtures(self, session):
        """Insert user + epub media + fragment fixtures, return their ids."""
        user_id = uuid4()
        media_id = uuid4()
        fragment_id = uuid4()

        session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        session.execute(
            text(
                "INSERT INTO media (id, kind, title, processing_status, created_by_user_id) "
                "VALUES (:id, 'epub', 'Test EPUB', 'extracting', :user_id)"
            ),
            {"id": media_id, "user_id": user_id},
        )
        session.execute(
            text(
                "INSERT INTO fragments (id, media_id, idx, canonical_text, html_sanitized) "
                "VALUES (:id, :media_id, 0, 'Chapter one text', '<p>Chapter one</p>')"
            ),
            {"id": fragment_id, "media_id": media_id},
        )
        session.commit()
        return user_id, media_id, fragment_id

    def test_0008_epub_toc_nodes_table_and_indexes_exist(self, s5_engine):
        """Table epub_toc_nodes and its indexes exist after upgrade to head."""
        result = run_alembic_command("upgrade head")
        assert result.returncode == 0, f"upgrade failed: {result.stderr}"

        with Session(s5_engine) as session:
            # Table exists
            table_result = session.execute(
                text(
                    "SELECT table_name FROM information_schema.tables "
                    "WHERE table_schema = 'public' AND table_name = 'epub_toc_nodes'"
                )
            )
            assert table_result.fetchone() is not None, "epub_toc_nodes table must exist"

            # Indexes exist
            idx_result = session.execute(
                text(
                    "SELECT indexname FROM pg_indexes "
                    "WHERE schemaname = 'public' AND tablename = 'epub_toc_nodes'"
                )
            )
            index_names = {row[0] for row in idx_result.fetchall()}
            assert "uix_epub_toc_nodes_media_order" in index_names
            assert "idx_epub_toc_nodes_media_fragment" in index_names

    def test_0008_epub_toc_nodes_constraints_enforced(self, s5_engine):
        """Check and FK constraints on epub_toc_nodes reject invalid data."""
        result = run_alembic_command("upgrade head")
        assert result.returncode == 0, f"upgrade failed: {result.stderr}"

        with Session(s5_engine) as session:
            _, media_id, _ = self._create_epub_fixtures(session)

            # node_id empty -> fail ck_epub_toc_nodes_node_id_nonempty
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text(
                        "INSERT INTO epub_toc_nodes "
                        "(media_id, node_id, label, depth, order_key) "
                        "VALUES (:mid, '', 'Label', 0, '0001')"
                    ),
                    {"mid": media_id},
                )
                session.commit()
            session.rollback()
            assert "ck_epub_toc_nodes_node_id_nonempty" in str(exc_info.value)

            # label whitespace-only -> fail ck_epub_toc_nodes_label_nonempty
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text(
                        "INSERT INTO epub_toc_nodes "
                        "(media_id, node_id, label, depth, order_key) "
                        "VALUES (:mid, 'n1', '   ', 0, '0001')"
                    ),
                    {"mid": media_id},
                )
                session.commit()
            session.rollback()
            assert "ck_epub_toc_nodes_label_nonempty" in str(exc_info.value)

            # parent_node_id == node_id -> fail ck_epub_toc_nodes_parent_nonself
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text(
                        "INSERT INTO epub_toc_nodes "
                        "(media_id, node_id, parent_node_id, label, depth, order_key) "
                        "VALUES (:mid, 'self', 'self', 'Label', 0, '0001')"
                    ),
                    {"mid": media_id},
                )
                session.commit()
            session.rollback()
            assert "ck_epub_toc_nodes_parent_nonself" in str(exc_info.value)

            # depth negative -> fail ck_epub_toc_nodes_depth_range
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text(
                        "INSERT INTO epub_toc_nodes "
                        "(media_id, node_id, label, depth, order_key) "
                        "VALUES (:mid, 'n2', 'Label', -1, '0001')"
                    ),
                    {"mid": media_id},
                )
                session.commit()
            session.rollback()
            assert "ck_epub_toc_nodes_depth_range" in str(exc_info.value)

            # depth too large -> fail ck_epub_toc_nodes_depth_range
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text(
                        "INSERT INTO epub_toc_nodes "
                        "(media_id, node_id, label, depth, order_key) "
                        "VALUES (:mid, 'n3', 'Label', 17, '0001')"
                    ),
                    {"mid": media_id},
                )
                session.commit()
            session.rollback()
            assert "ck_epub_toc_nodes_depth_range" in str(exc_info.value)

            # fragment_idx negative -> fail ck_epub_toc_nodes_fragment_idx_nonneg
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text(
                        "INSERT INTO epub_toc_nodes "
                        "(media_id, node_id, label, depth, order_key, fragment_idx) "
                        "VALUES (:mid, 'n4', 'Label', 0, '0001', -1)"
                    ),
                    {"mid": media_id},
                )
                session.commit()
            session.rollback()
            assert "ck_epub_toc_nodes_fragment_idx_nonneg" in str(exc_info.value)

            # parent FK referencing nonexistent parent -> fail
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text(
                        "INSERT INTO epub_toc_nodes "
                        "(media_id, node_id, parent_node_id, label, depth, order_key) "
                        "VALUES (:mid, 'child', 'nonexistent_parent', 'Label', 1, '0001')"
                    ),
                    {"mid": media_id},
                )
                session.commit()
            session.rollback()
            assert "fk_epub_toc_nodes_parent" in str(exc_info.value)

            # Valid insert with fragment_idx=0 (references existing fragment)
            session.execute(
                text(
                    "INSERT INTO epub_toc_nodes "
                    "(media_id, node_id, label, depth, order_key, fragment_idx) "
                    "VALUES (:mid, 'valid', 'Chapter 1', 0, '0001', 0)"
                ),
                {"mid": media_id},
            )
            session.commit()

            # Verify the row was inserted
            count = session.execute(
                text(
                    "SELECT COUNT(*) FROM epub_toc_nodes "
                    "WHERE media_id = :mid AND node_id = 'valid'"
                ),
                {"mid": media_id},
            ).scalar()
            assert count == 1

    def test_0008_order_key_format_constraint(self, s5_engine):
        """ck_epub_toc_nodes_order_key_format accepts valid and rejects invalid keys."""
        result = run_alembic_command("upgrade head")
        assert result.returncode == 0, f"upgrade failed: {result.stderr}"

        with Session(s5_engine) as session:
            _, media_id, _ = self._create_epub_fixtures(session)

            valid_keys = ["0001", "0001.0002", "0010.0001.0003"]
            for i, key in enumerate(valid_keys):
                session.execute(
                    text(
                        "INSERT INTO epub_toc_nodes "
                        "(media_id, node_id, label, depth, order_key) "
                        "VALUES (:mid, :nid, 'Label', 0, :key)"
                    ),
                    {"mid": media_id, "nid": f"valid_{i}", "key": key},
                )
            session.commit()

            invalid_keys = ["1", "0001.2", "0001.000A", ".0001", "0001."]
            for i, key in enumerate(invalid_keys):
                with pytest.raises(IntegrityError) as exc_info:
                    session.execute(
                        text(
                            "INSERT INTO epub_toc_nodes "
                            "(media_id, node_id, label, depth, order_key) "
                            "VALUES (:mid, :nid, 'Label', 0, :key)"
                        ),
                        {"mid": media_id, "nid": f"invalid_{i}", "key": key},
                    )
                    session.commit()
                session.rollback()
                assert "ck_epub_toc_nodes_order_key_format" in str(exc_info.value)

    def test_0008_unique_media_order_key_enforced(self, s5_engine):
        """uix_epub_toc_nodes_media_order rejects duplicate order_key within same media."""
        result = run_alembic_command("upgrade head")
        assert result.returncode == 0, f"upgrade failed: {result.stderr}"

        with Session(s5_engine) as session:
            _, media_id, _ = self._create_epub_fixtures(session)

            session.execute(
                text(
                    "INSERT INTO epub_toc_nodes "
                    "(media_id, node_id, label, depth, order_key) "
                    "VALUES (:mid, 'a', 'First', 0, '0001')"
                ),
                {"mid": media_id},
            )
            session.commit()

            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text(
                        "INSERT INTO epub_toc_nodes "
                        "(media_id, node_id, label, depth, order_key) "
                        "VALUES (:mid, 'b', 'Second', 0, '0001')"
                    ),
                    {"mid": media_id},
                )
                session.commit()
            session.rollback()
            assert "uix_epub_toc_nodes_media_order" in str(exc_info.value)


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

    def test_conversation_title_not_blank_constraint(self, migrated_engine):
        """CHECK constraint prevents blank conversation titles."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})

            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO conversations (id, owner_user_id, title, sharing, next_seq)
                        VALUES (:id, :user_id, '   ', 'private', 1)
                    """),
                    {"id": uuid4(), "user_id": user_id},
                )
                session.commit()

            session.rollback()
            assert "ck_conversations_title_not_blank" in str(exc_info.value)

    def test_conversation_title_max_length_constraint(self, migrated_engine):
        """CHECK constraint enforces bounded conversation titles."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})

            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO conversations (id, owner_user_id, title, sharing, next_seq)
                        VALUES (:id, :user_id, :title, 'private', 1)
                    """),
                    {"id": uuid4(), "user_id": user_id, "title": "x" * 121},
                )
                session.commit()

            session.rollback()
            assert "ck_conversations_title_max_length" in str(exc_info.value)

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


# =============================================================================
# Slice 6 PR-01: Typed-Highlight Data Foundation (migration 0009)
# =============================================================================


class TestS6PR01Migration0009:
    """Tests for S6 PR-01 migration 0009 — typed-highlight data foundation.

    Each test self-manages migration state (downgrade base -> upgrade target).
    """

    @pytest.fixture(autouse=True)
    def isolate_migration(self):
        """Start and end each test at a clean base state, restore to head."""
        run_alembic_command("downgrade base")
        yield
        run_alembic_command("downgrade base")
        run_alembic_command("upgrade head")

    @pytest.fixture
    def s6_engine(self):
        """Provide a dedicated engine for S6 tests."""
        database_url = get_test_database_url()
        engine = create_engine(database_url)
        yield engine
        engine.dispose()

    def _upgrade_to_0009(self):
        result = run_alembic_command("upgrade 0009")
        assert result.returncode == 0, f"upgrade failed: {result.stderr}"

    def _create_base_fixtures(self, session):
        """Insert user + web_article media + fragment, return ids."""
        user_id = uuid4()
        media_id = uuid4()
        fragment_id = uuid4()
        session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        session.execute(
            text(
                "INSERT INTO media (id, kind, title, processing_status, "
                "created_by_user_id) VALUES (:id, 'web_article', 'Test', "
                "'ready_for_reading', :uid)"
            ),
            {"id": media_id, "uid": user_id},
        )
        session.execute(
            text(
                "INSERT INTO fragments (id, media_id, idx, canonical_text, "
                "html_sanitized) VALUES (:id, :mid, 0, 'Hello world test', "
                "'<p>Hello world test</p>')"
            ),
            {"id": fragment_id, "mid": media_id},
        )
        session.commit()
        return user_id, media_id, fragment_id

    # ------------------------------------------------------------------
    # test_pr01_adds_s6_typed_highlight_foundation_tables_and_columns
    # ------------------------------------------------------------------
    def test_pr01_adds_s6_typed_highlight_foundation_tables_and_columns(self, s6_engine):
        self._upgrade_to_0009()
        with Session(s6_engine) as session:
            # New tables exist
            for tbl in (
                "highlight_fragment_anchors",
                "highlight_pdf_anchors",
                "highlight_pdf_quads",
                "pdf_page_text_spans",
            ):
                row = session.execute(
                    text("SELECT 1 FROM information_schema.tables WHERE table_name = :t"),
                    {"t": tbl},
                ).fetchone()
                assert row is not None, f"table {tbl} must exist"

            # New columns on media
            for col in ("plain_text", "page_count"):
                row = session.execute(
                    text(
                        "SELECT is_nullable FROM information_schema.columns "
                        "WHERE table_name = 'media' AND column_name = :c"
                    ),
                    {"c": col},
                ).fetchone()
                assert row is not None, f"media.{col} must exist"
                assert row[0] == "YES", f"media.{col} must be nullable"

            # New columns on highlights
            for col in ("anchor_kind", "anchor_media_id"):
                row = session.execute(
                    text(
                        "SELECT is_nullable FROM information_schema.columns "
                        "WHERE table_name = 'highlights' AND column_name = :c"
                    ),
                    {"c": col},
                ).fetchone()
                assert row is not None, f"highlights.{col} must exist"
                assert row[0] == "YES", f"highlights.{col} must be nullable"

            # Fragment columns are now nullable
            for col in ("fragment_id", "start_offset", "end_offset"):
                row = session.execute(
                    text(
                        "SELECT is_nullable FROM information_schema.columns "
                        "WHERE table_name = 'highlights' AND column_name = :c"
                    ),
                    {"c": col},
                ).fetchone()
                assert row is not None
                assert row[0] == "YES", f"highlights.{col} must be nullable"

            # Check constraints exist on highlights
            constraints = session.execute(
                text(
                    "SELECT conname FROM pg_constraint "
                    "WHERE conrelid = 'highlights'::regclass "
                    "AND contype = 'c'"
                )
            ).fetchall()
            cnames = {r[0] for r in constraints}
            assert "ck_highlights_fragment_bridge" in cnames
            assert "ck_highlights_anchor_fields_paired_null" in cnames
            assert "ck_highlights_anchor_kind_valid" in cnames
            assert "ck_highlights_color" in cnames

            # Supporting PDF indexes exist
            indexes = session.execute(
                text("SELECT indexname FROM pg_indexes WHERE tablename = 'highlight_pdf_anchors'")
            ).fetchall()
            inames = {r[0] for r in indexes}
            assert "ix_hpa_media_page_sort" in inames
            assert "ix_hpa_geometry_lookup" in inames

    # ------------------------------------------------------------------
    # test_pr01_media_page_count_domain_check
    # ------------------------------------------------------------------
    def test_pr01_media_page_count_domain_check(self, s6_engine):
        self._upgrade_to_0009()
        with Session(s6_engine) as session:
            user_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.commit()

            # NULL is OK
            mid1 = uuid4()
            session.execute(
                text(
                    "INSERT INTO media (id, kind, title, processing_status, "
                    "page_count, created_by_user_id) VALUES "
                    "(:id, 'pdf', 'A', 'pending', NULL, :uid)"
                ),
                {"id": mid1, "uid": user_id},
            )
            session.commit()

            # page_count = 1 is OK
            mid2 = uuid4()
            session.execute(
                text(
                    "INSERT INTO media (id, kind, title, processing_status, "
                    "page_count, created_by_user_id) VALUES "
                    "(:id, 'pdf', 'B', 'pending', 1, :uid)"
                ),
                {"id": mid2, "uid": user_id},
            )
            session.commit()

            # page_count = 0 rejected
            with pytest.raises(IntegrityError) as exc:
                session.execute(
                    text(
                        "INSERT INTO media (id, kind, title, processing_status, "
                        "page_count, created_by_user_id) VALUES "
                        "(:id, 'pdf', 'C', 'pending', 0, :uid)"
                    ),
                    {"id": uuid4(), "uid": user_id},
                )
                session.commit()
            session.rollback()
            assert "ck_media_page_count_positive" in str(exc.value)

            # page_count = -1 rejected
            with pytest.raises(IntegrityError) as exc:
                session.execute(
                    text(
                        "INSERT INTO media (id, kind, title, processing_status, "
                        "page_count, created_by_user_id) VALUES "
                        "(:id, 'pdf', 'D', 'pending', -1, :uid)"
                    ),
                    {"id": uuid4(), "uid": user_id},
                )
                session.commit()
            session.rollback()
            assert "ck_media_page_count_positive" in str(exc.value)

    # ------------------------------------------------------------------
    # test_pr01_preserves_legacy_fragment_highlight_constraints_after_migration
    # ------------------------------------------------------------------
    def test_pr01_preserves_legacy_fragment_highlight_constraints_after_migration(self, s6_engine):
        self._upgrade_to_0009()
        with Session(s6_engine) as session:
            uid, mid, fid = self._create_base_fixtures(session)

            # Valid legacy insert succeeds
            h_id = uuid4()
            session.execute(
                text(
                    "INSERT INTO highlights (id, user_id, fragment_id, "
                    "start_offset, end_offset, color, exact, prefix, suffix) "
                    "VALUES (:id, :uid, :fid, 0, 5, 'yellow', 'Hello', '', '')"
                ),
                {"id": h_id, "uid": uid, "fid": fid},
            )
            session.commit()

            # Invalid color rejected
            with pytest.raises(IntegrityError) as exc:
                session.execute(
                    text(
                        "INSERT INTO highlights (id, user_id, fragment_id, "
                        "start_offset, end_offset, color, exact, prefix, suffix) "
                        "VALUES (:id, :uid, :fid, 0, 3, 'red', 'Hel', '', '')"
                    ),
                    {"id": uuid4(), "uid": uid, "fid": fid},
                )
                session.commit()
            session.rollback()
            assert "ck_highlights_color" in str(exc.value)

            # Invalid offsets (end <= start) rejected by bridge check
            with pytest.raises(IntegrityError) as exc:
                session.execute(
                    text(
                        "INSERT INTO highlights (id, user_id, fragment_id, "
                        "start_offset, end_offset, color, exact, prefix, suffix) "
                        "VALUES (:id, :uid, :fid, 5, 5, 'green', 'x', '', '')"
                    ),
                    {"id": uuid4(), "uid": uid, "fid": fid},
                )
                session.commit()
            session.rollback()
            assert "ck_highlights_fragment_bridge" in str(exc.value)

            # Duplicate span rejected
            with pytest.raises(IntegrityError) as exc:
                session.execute(
                    text(
                        "INSERT INTO highlights (id, user_id, fragment_id, "
                        "start_offset, end_offset, color, exact, prefix, suffix) "
                        "VALUES (:id, :uid, :fid, 0, 5, 'blue', 'Hello', '', '')"
                    ),
                    {"id": uuid4(), "uid": uid, "fid": fid},
                )
                session.commit()
            session.rollback()
            assert "uix_highlights_user_fragment_offsets" in str(exc.value)

    # ------------------------------------------------------------------
    # test_pr01_new_anchor_subtype_cascade_and_uniqueness_constraints
    # ------------------------------------------------------------------
    def test_pr01_new_anchor_subtype_cascade_and_uniqueness_constraints(self, s6_engine):
        self._upgrade_to_0009()
        with Session(s6_engine) as session:
            uid, mid, fid = self._create_base_fixtures(session)

            # Create a logical highlight with fragment bridge + subtype row
            h_id = uuid4()
            session.execute(
                text(
                    "INSERT INTO highlights (id, user_id, fragment_id, "
                    "start_offset, end_offset, color, exact, prefix, suffix, "
                    "anchor_kind, anchor_media_id) VALUES "
                    "(:id, :uid, :fid, 0, 5, 'yellow', 'Hello', '', '', "
                    "'fragment_offsets', :mid)"
                ),
                {"id": h_id, "uid": uid, "fid": fid, "mid": mid},
            )
            session.execute(
                text(
                    "INSERT INTO highlight_fragment_anchors "
                    "(highlight_id, fragment_id, start_offset, end_offset) "
                    "VALUES (:hid, :fid, 0, 5)"
                ),
                {"hid": h_id, "fid": fid},
            )
            session.commit()

            # Duplicate 1:1 subtype row rejected (PK violation)
            with pytest.raises(IntegrityError):
                session.execute(
                    text(
                        "INSERT INTO highlight_fragment_anchors "
                        "(highlight_id, fragment_id, start_offset, end_offset) "
                        "VALUES (:hid, :fid, 0, 5)"
                    ),
                    {"hid": h_id, "fid": fid},
                )
                session.commit()
            session.rollback()

            # FK violation: non-existent highlight_id
            with pytest.raises(IntegrityError):
                session.execute(
                    text(
                        "INSERT INTO highlight_fragment_anchors "
                        "(highlight_id, fragment_id, start_offset, end_offset) "
                        "VALUES (:hid, :fid, 0, 3)"
                    ),
                    {"hid": uuid4(), "fid": fid},
                )
                session.commit()
            session.rollback()

            # Delete core highlight -> cascade to subtype
            session.execute(text("DELETE FROM highlights WHERE id = :id"), {"id": h_id})
            session.commit()
            row = session.execute(
                text("SELECT 1 FROM highlight_fragment_anchors WHERE highlight_id = :hid"),
                {"hid": h_id},
            ).fetchone()
            assert row is None, "cascade must delete subtype row"

    # ------------------------------------------------------------------
    # test_pr01_greenfield_defaults_allow_dormant_schema_without_backfill
    # ------------------------------------------------------------------
    def test_pr01_greenfield_defaults_allow_dormant_schema_without_backfill(self, s6_engine):
        self._upgrade_to_0009()
        with Session(s6_engine) as session:
            uid, mid, fid = self._create_base_fixtures(session)

            # Legacy insert works without setting new fields
            h_id = uuid4()
            session.execute(
                text(
                    "INSERT INTO highlights (id, user_id, fragment_id, "
                    "start_offset, end_offset, color, exact, prefix, suffix) "
                    "VALUES (:id, :uid, :fid, 0, 5, 'yellow', 'Hello', '', '')"
                ),
                {"id": h_id, "uid": uid, "fid": fid},
            )
            session.commit()

            # anchor_kind and anchor_media_id default to NULL
            row = session.execute(
                text("SELECT anchor_kind, anchor_media_id FROM highlights WHERE id = :id"),
                {"id": h_id},
            ).fetchone()
            assert row[0] is None
            assert row[1] is None

            # No fragment subtype row exists (no dual-write)
            sub = session.execute(
                text("SELECT 1 FROM highlight_fragment_anchors WHERE highlight_id = :hid"),
                {"hid": h_id},
            ).fetchone()
            assert sub is None

    # ------------------------------------------------------------------
    # test_pr01_rejects_partial_dormant_logical_anchor_fields_on_highlights
    # ------------------------------------------------------------------
    def test_pr01_rejects_partial_dormant_logical_anchor_fields_on_highlights(self, s6_engine):
        self._upgrade_to_0009()
        with Session(s6_engine) as session:
            uid, mid, fid = self._create_base_fixtures(session)

            # anchor_kind without anchor_media_id -> rejected
            with pytest.raises(IntegrityError) as exc:
                session.execute(
                    text(
                        "INSERT INTO highlights (id, user_id, fragment_id, "
                        "start_offset, end_offset, color, exact, prefix, suffix, "
                        "anchor_kind) VALUES "
                        "(:id, :uid, :fid, 0, 5, 'yellow', 'Hello', '', '', "
                        "'fragment_offsets')"
                    ),
                    {"id": uuid4(), "uid": uid, "fid": fid},
                )
                session.commit()
            session.rollback()
            assert "ck_highlights_anchor_fields_paired_null" in str(exc.value)

            # anchor_media_id without anchor_kind -> rejected
            with pytest.raises(IntegrityError) as exc:
                session.execute(
                    text(
                        "INSERT INTO highlights (id, user_id, fragment_id, "
                        "start_offset, end_offset, color, exact, prefix, suffix, "
                        "anchor_media_id) VALUES "
                        "(:id, :uid, :fid, 0, 5, 'yellow', 'Hello', '', '', :mid)"
                    ),
                    {"id": uuid4(), "uid": uid, "fid": fid, "mid": mid},
                )
                session.commit()
            session.rollback()
            assert "ck_highlights_anchor_fields_paired_null" in str(exc.value)

            # Invalid anchor_kind value -> rejected
            with pytest.raises(IntegrityError) as exc:
                session.execute(
                    text(
                        "INSERT INTO highlights (id, user_id, fragment_id, "
                        "start_offset, end_offset, color, exact, prefix, suffix, "
                        "anchor_kind, anchor_media_id) VALUES "
                        "(:id, :uid, :fid, 0, 5, 'yellow', 'Hello', '', '', "
                        "'invalid_kind', :mid)"
                    ),
                    {"id": uuid4(), "uid": uid, "fid": fid, "mid": mid},
                )
                session.commit()
            session.rollback()
            assert "ck_highlights_anchor_kind_valid" in str(exc.value)

    # ------------------------------------------------------------------
    # test_pr01_does_not_require_fragment_subtype_dual_write_during_dormant_window
    # ------------------------------------------------------------------
    def test_pr01_does_not_require_fragment_subtype_dual_write_during_dormant_window(
        self, s6_engine
    ):
        self._upgrade_to_0009()
        with Session(s6_engine) as session:
            uid, mid, fid = self._create_base_fixtures(session)

            h_id = uuid4()
            session.execute(
                text(
                    "INSERT INTO highlights (id, user_id, fragment_id, "
                    "start_offset, end_offset, color, exact, prefix, suffix) "
                    "VALUES (:id, :uid, :fid, 0, 5, 'yellow', 'Hello', '', '')"
                ),
                {"id": h_id, "uid": uid, "fid": fid},
            )
            session.commit()

            row = session.execute(
                text("SELECT 1 FROM highlight_fragment_anchors WHERE highlight_id = :hid"),
                {"hid": h_id},
            ).fetchone()
            assert row is None, "Legacy insert must succeed without fragment subtype row"

    # ------------------------------------------------------------------
    # test_pr01_allows_future_non_fragment_logical_rows_to_leave_legacy_fragment_columns_null
    # ------------------------------------------------------------------
    def test_pr01_allows_future_non_fragment_logical_rows_to_leave_legacy_fragment_columns_null(
        self, s6_engine
    ):
        self._upgrade_to_0009()
        with Session(s6_engine) as session:
            uid, mid, _ = self._create_base_fixtures(session)

            h_id = uuid4()
            session.execute(
                text(
                    "INSERT INTO highlights (id, user_id, "
                    "fragment_id, start_offset, end_offset, "
                    "color, exact, prefix, suffix, "
                    "anchor_kind, anchor_media_id) VALUES "
                    "(:id, :uid, NULL, NULL, NULL, "
                    "'yellow', '', '', '', "
                    "'pdf_page_geometry', :mid)"
                ),
                {"id": h_id, "uid": uid, "mid": mid},
            )
            session.commit()

            row = session.execute(
                text("SELECT fragment_id, start_offset, end_offset FROM highlights WHERE id = :id"),
                {"id": h_id},
            ).fetchone()
            assert row[0] is None
            assert row[1] is None
            assert row[2] is None

    # ------------------------------------------------------------------
    # test_pr01_retained_fragment_unique_index_preserves_duplicate_semantics_under_nullable_bridge
    # ------------------------------------------------------------------
    def test_pr01_retained_fragment_unique_index_preserves_duplicate_semantics_under_nullable_bridge(
        self, s6_engine
    ):
        self._upgrade_to_0009()
        with Session(s6_engine) as session:
            uid, mid, fid = self._create_base_fixtures(session)

            # First fragment highlight
            session.execute(
                text(
                    "INSERT INTO highlights (id, user_id, fragment_id, "
                    "start_offset, end_offset, color, exact, prefix, suffix) "
                    "VALUES (:id, :uid, :fid, 0, 5, 'yellow', 'Hello', '', '')"
                ),
                {"id": uuid4(), "uid": uid, "fid": fid},
            )
            session.commit()

            # Duplicate rejected
            with pytest.raises(IntegrityError) as exc:
                session.execute(
                    text(
                        "INSERT INTO highlights (id, user_id, fragment_id, "
                        "start_offset, end_offset, color, exact, prefix, suffix) "
                        "VALUES (:id, :uid, :fid, 0, 5, 'blue', 'Hello', '', '')"
                    ),
                    {"id": uuid4(), "uid": uid, "fid": fid},
                )
                session.commit()
            session.rollback()
            assert "uix_highlights_user_fragment_offsets" in str(exc.value)

            # Multiple non-fragment rows with NULL fragment columns don't conflict
            for _ in range(3):
                session.execute(
                    text(
                        "INSERT INTO highlights (id, user_id, "
                        "fragment_id, start_offset, end_offset, "
                        "color, exact, prefix, suffix, "
                        "anchor_kind, anchor_media_id) VALUES "
                        "(:id, :uid, NULL, NULL, NULL, "
                        "'yellow', '', '', '', "
                        "'pdf_page_geometry', :mid)"
                    ),
                    {"id": uuid4(), "uid": uid, "mid": mid},
                )
            session.commit()

    # ------------------------------------------------------------------
    # test_pr01_pdf_anchor_supporting_indexes_exist_without_exact_duplicate_uniqueness
    # ------------------------------------------------------------------
    def test_pr01_pdf_anchor_supporting_indexes_exist_without_exact_duplicate_uniqueness(
        self, s6_engine
    ):
        self._upgrade_to_0009()
        with Session(s6_engine) as session:
            indexes = session.execute(
                text(
                    "SELECT indexname, indexdef FROM pg_indexes "
                    "WHERE tablename = 'highlight_pdf_anchors'"
                )
            ).fetchall()
            idx_map = {r[0]: r[1] for r in indexes}
            assert "ix_hpa_media_page_sort" in idx_map
            assert "ix_hpa_geometry_lookup" in idx_map
            # Neither is UNIQUE
            for name in ("ix_hpa_media_page_sort", "ix_hpa_geometry_lookup"):
                assert "UNIQUE" not in idx_map[name].upper(), f"{name} must not be unique in pr-01"

    # ------------------------------------------------------------------
    # test_pr01_pdf_page_text_spans_enforces_row_local_validity_but_not_contiguity_lifecycle_rules
    # ------------------------------------------------------------------
    def test_pr01_pdf_page_text_spans_enforces_row_local_validity_but_not_contiguity_lifecycle_rules(
        self, s6_engine
    ):
        self._upgrade_to_0009()
        with Session(s6_engine) as session:
            uid = uuid4()
            mid = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": uid})
            session.execute(
                text(
                    "INSERT INTO media (id, kind, title, processing_status, "
                    "page_count, created_by_user_id) VALUES "
                    "(:id, 'pdf', 'Test PDF', 'extracting', 5, :uid)"
                ),
                {"id": mid, "uid": uid},
            )
            session.commit()

            # Valid row
            session.execute(
                text(
                    "INSERT INTO pdf_page_text_spans "
                    "(media_id, page_number, start_offset, end_offset, "
                    "text_extract_version) VALUES (:mid, 1, 0, 100, 1)"
                ),
                {"mid": mid},
            )
            session.commit()

            # Duplicate page rejected (PK)
            with pytest.raises(IntegrityError):
                session.execute(
                    text(
                        "INSERT INTO pdf_page_text_spans "
                        "(media_id, page_number, start_offset, end_offset, "
                        "text_extract_version) VALUES (:mid, 1, 0, 50, 1)"
                    ),
                    {"mid": mid},
                )
                session.commit()
            session.rollback()

            # Invalid page_number = 0
            with pytest.raises(IntegrityError) as exc:
                session.execute(
                    text(
                        "INSERT INTO pdf_page_text_spans "
                        "(media_id, page_number, start_offset, end_offset, "
                        "text_extract_version) VALUES (:mid, 0, 0, 50, 1)"
                    ),
                    {"mid": mid},
                )
                session.commit()
            session.rollback()
            assert "ck_ppts_page_number" in str(exc.value)

            # Negative start_offset
            with pytest.raises(IntegrityError) as exc:
                session.execute(
                    text(
                        "INSERT INTO pdf_page_text_spans "
                        "(media_id, page_number, start_offset, end_offset, "
                        "text_extract_version) VALUES (:mid, 2, -1, 50, 1)"
                    ),
                    {"mid": mid},
                )
                session.commit()
            session.rollback()
            assert "ck_ppts_start_offset" in str(exc.value)

            # end < start
            with pytest.raises(IntegrityError) as exc:
                session.execute(
                    text(
                        "INSERT INTO pdf_page_text_spans "
                        "(media_id, page_number, start_offset, end_offset, "
                        "text_extract_version) VALUES (:mid, 2, 50, 10, 1)"
                    ),
                    {"mid": mid},
                )
                session.commit()
            session.rollback()
            assert "ck_ppts_offsets_valid" in str(exc.value)

            # Non-contiguous pages are row-valid (contiguity is pr-03 concern)
            session.execute(
                text(
                    "INSERT INTO pdf_page_text_spans "
                    "(media_id, page_number, start_offset, end_offset, "
                    "text_extract_version) VALUES (:mid, 4, 500, 600, 1)"
                ),
                {"mid": mid},
            )
            session.commit()

    # ------------------------------------------------------------------
    # test_pr01_highlight_pdf_quads_enforces_row_shape_without_canonicalization_semantics
    # ------------------------------------------------------------------
    def test_pr01_highlight_pdf_quads_enforces_row_shape_without_canonicalization_semantics(
        self, s6_engine
    ):
        self._upgrade_to_0009()
        with Session(s6_engine) as session:
            uid, mid, _ = self._create_base_fixtures(session)

            h_id = uuid4()
            session.execute(
                text(
                    "INSERT INTO highlights (id, user_id, "
                    "fragment_id, start_offset, end_offset, "
                    "color, exact, prefix, suffix, "
                    "anchor_kind, anchor_media_id) VALUES "
                    "(:id, :uid, NULL, NULL, NULL, "
                    "'yellow', '', '', '', "
                    "'pdf_page_geometry', :mid)"
                ),
                {"id": h_id, "uid": uid, "mid": mid},
            )
            session.commit()

            # Valid quad
            session.execute(
                text(
                    "INSERT INTO highlight_pdf_quads "
                    "(highlight_id, quad_idx, x1, y1, x2, y2, "
                    "x3, y3, x4, y4) VALUES "
                    "(:hid, 0, 10, 20, 30, 20, 30, 40, 10, 40)"
                ),
                {"hid": h_id},
            )
            session.commit()

            # Duplicate (highlight_id, quad_idx) rejected
            with pytest.raises(IntegrityError):
                session.execute(
                    text(
                        "INSERT INTO highlight_pdf_quads "
                        "(highlight_id, quad_idx, x1, y1, x2, y2, "
                        "x3, y3, x4, y4) VALUES "
                        "(:hid, 0, 1, 2, 3, 4, 5, 6, 7, 8)"
                    ),
                    {"hid": h_id},
                )
                session.commit()
            session.rollback()

            # Negative quad_idx rejected
            with pytest.raises(IntegrityError) as exc:
                session.execute(
                    text(
                        "INSERT INTO highlight_pdf_quads "
                        "(highlight_id, quad_idx, x1, y1, x2, y2, "
                        "x3, y3, x4, y4) VALUES "
                        "(:hid, -1, 1, 2, 3, 4, 5, 6, 7, 8)"
                    ),
                    {"hid": h_id},
                )
                session.commit()
            session.rollback()
            assert "ck_hpq_quad_idx" in str(exc.value)

            # Row-valid but not canonically ordered is accepted in pr-01
            session.execute(
                text(
                    "INSERT INTO highlight_pdf_quads "
                    "(highlight_id, quad_idx, x1, y1, x2, y2, "
                    "x3, y3, x4, y4) VALUES "
                    "(:hid, 5, 99, 99, 1, 1, 50, 50, 0, 0)"
                ),
                {"hid": h_id},
            )
            session.commit()

    # ------------------------------------------------------------------
    # test_pr01_highlight_pdf_anchors_enforces_row_local_shape_domains_without_semantic_coherence_rules
    # ------------------------------------------------------------------
    def test_pr01_highlight_pdf_anchors_enforces_row_local_shape_domains_without_semantic_coherence_rules(
        self, s6_engine
    ):
        self._upgrade_to_0009()
        with Session(s6_engine) as session:
            uid, mid, _ = self._create_base_fixtures(session)

            h_id = uuid4()
            session.execute(
                text(
                    "INSERT INTO highlights (id, user_id, "
                    "fragment_id, start_offset, end_offset, "
                    "color, exact, prefix, suffix, "
                    "anchor_kind, anchor_media_id) VALUES "
                    "(:id, :uid, NULL, NULL, NULL, "
                    "'yellow', '', '', '', "
                    "'pdf_page_geometry', :mid)"
                ),
                {"id": h_id, "uid": uid, "mid": mid},
            )
            session.commit()

            # Valid row
            session.execute(
                text(
                    "INSERT INTO highlight_pdf_anchors "
                    "(highlight_id, media_id, page_number, geometry_version, "
                    "geometry_fingerprint, sort_top, sort_left, "
                    "plain_text_match_status, rect_count) VALUES "
                    "(:hid, :mid, 1, 1, 'abc123', 10.5, 20.0, 'pending', 1)"
                ),
                {"hid": h_id, "mid": mid},
            )
            session.commit()
            session.execute(
                text("DELETE FROM highlight_pdf_anchors WHERE highlight_id = :hid"),
                {"hid": h_id},
            )
            session.commit()

            # Invalid page_number = 0
            with pytest.raises(IntegrityError) as exc:
                session.execute(
                    text(
                        "INSERT INTO highlight_pdf_anchors "
                        "(highlight_id, media_id, page_number, "
                        "geometry_version, geometry_fingerprint, "
                        "sort_top, sort_left, plain_text_match_status, "
                        "rect_count) VALUES "
                        "(:hid, :mid, 0, 1, 'x', 0, 0, 'pending', 1)"
                    ),
                    {"hid": h_id, "mid": mid},
                )
                session.commit()
            session.rollback()
            assert "ck_hpa_page_number" in str(exc.value)

            # Invalid rect_count = 0
            with pytest.raises(IntegrityError) as exc:
                session.execute(
                    text(
                        "INSERT INTO highlight_pdf_anchors "
                        "(highlight_id, media_id, page_number, "
                        "geometry_version, geometry_fingerprint, "
                        "sort_top, sort_left, plain_text_match_status, "
                        "rect_count) VALUES "
                        "(:hid, :mid, 1, 1, 'x', 0, 0, 'pending', 0)"
                    ),
                    {"hid": h_id, "mid": mid},
                )
                session.commit()
            session.rollback()
            assert "ck_hpa_rect_count" in str(exc.value)

            # Invalid geometry_version = 0
            with pytest.raises(IntegrityError) as exc:
                session.execute(
                    text(
                        "INSERT INTO highlight_pdf_anchors "
                        "(highlight_id, media_id, page_number, "
                        "geometry_version, geometry_fingerprint, "
                        "sort_top, sort_left, plain_text_match_status, "
                        "rect_count) VALUES "
                        "(:hid, :mid, 1, 0, 'x', 0, 0, 'pending', 1)"
                    ),
                    {"hid": h_id, "mid": mid},
                )
                session.commit()
            session.rollback()
            assert "ck_hpa_geometry_version" in str(exc.value)

            # Invalid match_status
            with pytest.raises(IntegrityError) as exc:
                session.execute(
                    text(
                        "INSERT INTO highlight_pdf_anchors "
                        "(highlight_id, media_id, page_number, "
                        "geometry_version, geometry_fingerprint, "
                        "sort_top, sort_left, plain_text_match_status, "
                        "rect_count) VALUES "
                        "(:hid, :mid, 1, 1, 'x', 0, 0, 'bogus', 1)"
                    ),
                    {"hid": h_id, "mid": mid},
                )
                session.commit()
            session.rollback()
            assert "ck_hpa_match_status" in str(exc.value)

            # Negative match offset
            with pytest.raises(IntegrityError) as exc:
                session.execute(
                    text(
                        "INSERT INTO highlight_pdf_anchors "
                        "(highlight_id, media_id, page_number, "
                        "geometry_version, geometry_fingerprint, "
                        "sort_top, sort_left, plain_text_match_status, "
                        "plain_text_start_offset, plain_text_end_offset, "
                        "rect_count) VALUES "
                        "(:hid, :mid, 1, 1, 'x', 0, 0, 'unique', -1, 5, 1)"
                    ),
                    {"hid": h_id, "mid": mid},
                )
                session.commit()
            session.rollback()
            assert "ck_hpa_match_offsets_non_negative" in str(exc.value)

            # One-sided offset null
            with pytest.raises(IntegrityError) as exc:
                session.execute(
                    text(
                        "INSERT INTO highlight_pdf_anchors "
                        "(highlight_id, media_id, page_number, "
                        "geometry_version, geometry_fingerprint, "
                        "sort_top, sort_left, plain_text_match_status, "
                        "plain_text_start_offset, plain_text_end_offset, "
                        "rect_count) VALUES "
                        "(:hid, :mid, 1, 1, 'x', 0, 0, 'unique', 5, NULL, 1)"
                    ),
                    {"hid": h_id, "mid": mid},
                )
                session.commit()
            session.rollback()
            assert "ck_hpa_match_offsets_paired_null" in str(exc.value)

            # Semantically unresolved but row-valid (pr-03+)
            session.execute(
                text(
                    "INSERT INTO highlight_pdf_anchors "
                    "(highlight_id, media_id, page_number, "
                    "geometry_version, geometry_fingerprint, "
                    "sort_top, sort_left, plain_text_match_status, "
                    "plain_text_match_version, "
                    "plain_text_start_offset, plain_text_end_offset, "
                    "rect_count) VALUES "
                    "(:hid, :mid, 1, 1, 'abc', 0, 0, 'unique', 1, 0, 50, 2)"
                ),
                {"hid": h_id, "mid": mid},
            )
            session.commit()


class TestHighlightBridgeRemovalMigration0056:
    """Data migration coverage for the highlight bridge-column hard cutover."""

    @pytest.fixture(autouse=True)
    def isolate_migration(self):
        run_alembic_command("downgrade base")
        yield
        run_alembic_command("downgrade base")
        run_alembic_command("upgrade head")

    @pytest.fixture
    def migration_engine(self):
        engine = create_engine(get_test_database_url())
        yield engine
        engine.dispose()

    def test_upgrade_0055_to_head_backfills_fragment_anchors_and_drops_bridge_columns(
        self, migration_engine
    ):
        result = run_alembic_command("upgrade 0055")
        assert result.returncode == 0, f"upgrade 0055 failed: {result.stderr}"

        user_id = uuid4()
        media_id = uuid4()
        fragment_id = uuid4()
        highlight_id = uuid4()

        with Session(migration_engine) as session:
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text(
                    """
                    INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                    VALUES (:id, 'web_article', 'Legacy highlight media', 'ready_for_reading', :user_id)
                    """
                ),
                {"id": media_id, "user_id": user_id},
            )
            session.execute(
                text(
                    """
                    INSERT INTO fragments (id, media_id, idx, canonical_text, html_sanitized)
                    VALUES (:id, :media_id, 0, 'legacy fragment text', '<p>legacy fragment text</p>')
                    """
                ),
                {"id": fragment_id, "media_id": media_id},
            )
            session.execute(
                text(
                    """
                    INSERT INTO highlights (
                        id,
                        user_id,
                        fragment_id,
                        start_offset,
                        end_offset,
                        color,
                        exact,
                        prefix,
                        suffix
                    )
                    VALUES (
                        :id,
                        :user_id,
                        :fragment_id,
                        0,
                        6,
                        'yellow',
                        'legacy',
                        '',
                        ''
                    )
                    """
                ),
                {
                    "id": highlight_id,
                    "user_id": user_id,
                    "fragment_id": fragment_id,
                },
            )
            session.commit()

        result = run_alembic_command("upgrade head")
        assert result.returncode == 0, f"upgrade head failed: {result.stderr}"

        with Session(migration_engine) as session:
            for column_name in ("fragment_id", "start_offset", "end_offset"):
                row = session.execute(
                    text(
                        """
                        SELECT 1
                        FROM information_schema.columns
                        WHERE table_name = 'highlights'
                          AND column_name = :column_name
                        """
                    ),
                    {"column_name": column_name},
                ).fetchone()
                assert row is None, f"highlights.{column_name} must be removed at head"

            row = session.execute(
                text(
                    """
                    SELECT anchor_kind, anchor_media_id
                    FROM highlights
                    WHERE id = :id
                    """
                ),
                {"id": highlight_id},
            ).fetchone()
            assert row is not None
            assert row[0] == "fragment_offsets"
            assert str(row[1]) == str(media_id)

            anchor_row = session.execute(
                text(
                    """
                    SELECT fragment_id, start_offset, end_offset
                    FROM highlight_fragment_anchors
                    WHERE highlight_id = :id
                    """
                ),
                {"id": highlight_id},
            ).fetchone()
            assert anchor_row is not None
            assert str(anchor_row[0]) == str(fragment_id)
            assert anchor_row[1] == 0
            assert anchor_row[2] == 6

    def test_downgrade_head_to_0055_restores_bridge_columns_from_canonical_rows(
        self, migration_engine
    ):
        result = run_alembic_command("upgrade head")
        assert result.returncode == 0, f"upgrade head failed: {result.stderr}"

        user_id = uuid4()
        media_id = uuid4()
        fragment_id = uuid4()
        highlight_id = uuid4()

        with Session(migration_engine) as session:
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text(
                    """
                    INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                    VALUES (:id, 'web_article', 'Canonical highlight media', 'ready_for_reading', :user_id)
                    """
                ),
                {"id": media_id, "user_id": user_id},
            )
            session.execute(
                text(
                    """
                    INSERT INTO fragments (id, media_id, idx, canonical_text, html_sanitized)
                    VALUES (:id, :media_id, 0, 'canonical fragment text', '<p>canonical fragment text</p>')
                    """
                ),
                {"id": fragment_id, "media_id": media_id},
            )
            insert_canonical_fragment_highlight(
                session,
                highlight_id=highlight_id,
                user_id=user_id,
                media_id=media_id,
                fragment_id=fragment_id,
                start_offset=1,
                end_offset=7,
                color="yellow",
                exact="anonic",
                prefix="c",
                suffix="al",
            )
            session.commit()

        result = run_alembic_command("downgrade 0055")
        assert result.returncode == 0, f"downgrade 0055 failed: {result.stderr}"

        with Session(migration_engine) as session:
            column_names = {
                row[0]
                for row in session.execute(
                    text(
                        """
                        SELECT column_name
                        FROM information_schema.columns
                        WHERE table_name = 'highlights'
                          AND column_name IN ('fragment_id', 'start_offset', 'end_offset')
                        """
                    )
                ).fetchall()
            }
            assert column_names == {"fragment_id", "start_offset", "end_offset"}

            row = session.execute(
                text(
                    """
                    SELECT fragment_id, start_offset, end_offset, anchor_kind, anchor_media_id
                    FROM highlights
                    WHERE id = :id
                    """
                ),
                {"id": highlight_id},
            ).fetchone()
            assert row is not None
            assert str(row[0]) == str(fragment_id)
            assert row[1] == 1
            assert row[2] == 7
            assert row[3] == "fragment_offsets"
            assert str(row[4]) == str(media_id)


class TestMigration0026SemanticChunkBackfill:
    """Regression tests for semantic chunk backfill over legacy transcripts."""

    @pytest.fixture(autouse=True)
    def isolate_migration(self):
        run_alembic_command("downgrade base")
        yield
        run_alembic_command("downgrade base")
        run_alembic_command("upgrade head")

    @pytest.fixture
    def migration_engine(self):
        database_url = get_test_database_url()
        engine = create_engine(database_url)
        yield engine
        engine.dispose()

    def test_upgrade_backfills_semantic_chunks_for_pre_0024_transcripts(self, migration_engine):
        result = run_alembic_command("upgrade 0023")
        assert result.returncode == 0, f"upgrade 0023 failed: {result.stderr}"

        user_id = uuid4()
        media_id = uuid4()
        fragment_1 = uuid4()
        fragment_2 = uuid4()

        with Session(migration_engine) as session:
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text(
                    """
                    INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                    VALUES (:media_id, 'podcast_episode', 'legacy transcript', 'ready_for_reading', :user_id)
                    """
                ),
                {"media_id": media_id, "user_id": user_id},
            )
            session.execute(
                text(
                    """
                    INSERT INTO fragments (
                        id,
                        media_id,
                        idx,
                        html_sanitized,
                        canonical_text,
                        t_start_ms,
                        t_end_ms,
                        speaker_label
                    )
                    VALUES (
                        :id,
                        :media_id,
                        :idx,
                        :html_sanitized,
                        :canonical_text,
                        :t_start_ms,
                        :t_end_ms,
                        :speaker_label
                    )
                    """
                ),
                {
                    "id": fragment_1,
                    "media_id": media_id,
                    "idx": 0,
                    "html_sanitized": "<p>first legacy segment</p>",
                    "canonical_text": "first legacy segment",
                    "t_start_ms": 0,
                    "t_end_ms": 1000,
                    "speaker_label": "Host",
                },
            )
            session.execute(
                text(
                    """
                    INSERT INTO fragments (
                        id,
                        media_id,
                        idx,
                        html_sanitized,
                        canonical_text,
                        t_start_ms,
                        t_end_ms,
                        speaker_label
                    )
                    VALUES (
                        :id,
                        :media_id,
                        :idx,
                        :html_sanitized,
                        :canonical_text,
                        :t_start_ms,
                        :t_end_ms,
                        :speaker_label
                    )
                    """
                ),
                {
                    "id": fragment_2,
                    "media_id": media_id,
                    "idx": 1,
                    "html_sanitized": "<p>second legacy segment</p>",
                    "canonical_text": "second legacy segment",
                    "t_start_ms": 1200,
                    "t_end_ms": 2200,
                    "speaker_label": "Guest",
                },
            )
            session.commit()

        result = run_alembic_command("upgrade head")
        assert result.returncode == 0, f"upgrade head failed: {result.stderr}"

        with Session(migration_engine) as session:
            state_row = session.execute(
                text(
                    """
                    SELECT transcript_state, transcript_coverage, semantic_status, active_transcript_version_id
                    FROM media_transcript_states
                    WHERE media_id = :media_id
                    """
                ),
                {"media_id": media_id},
            ).fetchone()
            version_row = session.execute(
                text(
                    """
                    SELECT id, version_no, is_active
                    FROM podcast_transcript_versions
                    WHERE media_id = :media_id
                    """
                ),
                {"media_id": media_id},
            ).fetchone()
            segment_count = session.execute(
                text("SELECT COUNT(*) FROM podcast_transcript_segments WHERE media_id = :media_id"),
                {"media_id": media_id},
            ).scalar()
            chunk_count = session.execute(
                text("SELECT COUNT(*) FROM podcast_transcript_chunks WHERE media_id = :media_id"),
                {"media_id": media_id},
            ).scalar()
            chunk_models = session.execute(
                text(
                    """
                    SELECT DISTINCT embedding_model
                    FROM podcast_transcript_chunks
                    WHERE media_id = :media_id
                    ORDER BY embedding_model
                    """
                ),
                {"media_id": media_id},
            ).fetchall()

        assert state_row is not None
        assert state_row[0] == "ready"
        assert state_row[1] == "full"
        assert state_row[2] == "pending", (
            "legacy transcript rows backfilled before pgvector cutover must be marked pending "
            "until re-indexed with production semantic embeddings"
        )
        assert state_row[3] is not None
        assert version_row is not None
        assert version_row[1] == 1
        assert version_row[2] is True
        assert segment_count == 2
        assert chunk_count == 2, "legacy transcript segments must be backfilled into chunks"
        assert chunk_models == [("hash_v1_frozen_0026",)], (
            "migration 0026 must use a frozen in-migration embedding implementation "
            "so fresh installs stay time-stable even if runtime embedding code changes"
        )


class TestPodcastListeningStateMigration:
    """Schema assertions for podcast listening-state persistence table."""

    def test_head_contains_podcast_listening_state_table_contract(self, migrated_engine):
        with Session(migrated_engine) as session:
            columns = session.execute(
                text(
                    """
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_name = 'podcast_listening_states'
                    ORDER BY ordinal_position
                    """
                )
            ).fetchall()
            pk_columns = session.execute(
                text(
                    """
                    SELECT a.attname
                    FROM pg_index i
                    JOIN pg_class c ON c.oid = i.indrelid
                    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
                    WHERE c.relname = 'podcast_listening_states'
                      AND i.indisprimary
                    ORDER BY a.attname
                    """
                )
            ).fetchall()
            constraints = session.execute(
                text(
                    """
                    SELECT conname
                    FROM pg_constraint
                    WHERE conrelid = 'podcast_listening_states'::regclass
                    ORDER BY conname
                    """
                )
            ).fetchall()
            indexes = session.execute(
                text(
                    """
                    SELECT indexname
                    FROM pg_indexes
                    WHERE tablename = 'podcast_listening_states'
                    ORDER BY indexname
                    """
                )
            ).fetchall()
            is_completed_column = session.execute(
                text(
                    """
                    SELECT column_name, data_type, is_nullable, column_default
                    FROM information_schema.columns
                    WHERE table_name = 'podcast_listening_states'
                      AND column_name = 'is_completed'
                    """
                )
            ).fetchone()

        column_names = {row[0] for row in columns}
        assert {
            "user_id",
            "media_id",
            "position_ms",
            "duration_ms",
            "playback_speed",
            "is_completed",
            "updated_at",
        }.issubset(column_names), f"Unexpected podcast_listening_states columns: {column_names}"

        assert [row[0] for row in pk_columns] == ["media_id", "user_id"], (
            f"Expected composite PK over (user_id, media_id), got {[row[0] for row in pk_columns]}"
        )

        constraint_names = {row[0] for row in constraints}
        assert "ck_podcast_listening_states_position_ms_non_negative" in constraint_names
        assert "ck_podcast_listening_states_playback_speed_positive" in constraint_names

        index_names = {row[0] for row in indexes}
        assert "ix_podcast_listening_states_media_id" in index_names

        assert is_completed_column is not None, (
            "podcast_listening_states.is_completed must exist for played/unplayed state derivation"
        )
        assert is_completed_column[1] == "boolean", (
            f"Expected is_completed boolean type, got {is_completed_column[1]}"
        )
        assert is_completed_column[2] == "NO", "is_completed must be non-null"


class TestPlaybackQueueMigration:
    """Schema assertions for playback queue table and subscription auto-queue toggle."""

    def test_head_contains_playback_queue_table_and_auto_queue_flag(self, migrated_engine):
        with Session(migrated_engine) as session:
            queue_columns = session.execute(
                text(
                    """
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_name = 'playback_queue_items'
                    ORDER BY ordinal_position
                    """
                )
            ).fetchall()
            queue_constraints = session.execute(
                text(
                    """
                    SELECT conname
                    FROM pg_constraint
                    WHERE conrelid = 'playback_queue_items'::regclass
                    ORDER BY conname
                    """
                )
            ).fetchall()
            queue_indexes = session.execute(
                text(
                    """
                    SELECT indexname
                    FROM pg_indexes
                    WHERE tablename = 'playback_queue_items'
                    ORDER BY indexname
                    """
                )
            ).fetchall()
            auto_queue_column = session.execute(
                text(
                    """
                    SELECT column_name, data_type, is_nullable, column_default
                    FROM information_schema.columns
                    WHERE table_name = 'podcast_subscriptions'
                      AND column_name = 'auto_queue'
                    """
                )
            ).fetchone()
            default_playback_speed_column = session.execute(
                text(
                    """
                    SELECT column_name, data_type, is_nullable, column_default
                    FROM information_schema.columns
                    WHERE table_name = 'podcast_subscriptions'
                      AND column_name = 'default_playback_speed'
                    """
                )
            ).fetchone()

        queue_column_names = {row[0] for row in queue_columns}
        assert {
            "id",
            "user_id",
            "media_id",
            "position",
            "added_at",
            "source",
        }.issubset(queue_column_names), (
            "playback queue migration must provide durable ordered queue schema; "
            f"got columns {queue_column_names}"
        )

        queue_constraint_names = {row[0] for row in queue_constraints}
        assert "uq_playback_queue_items_user_media" in queue_constraint_names
        assert "ck_playback_queue_items_position_non_negative" in queue_constraint_names
        assert "ck_playback_queue_items_source" in queue_constraint_names

        queue_index_names = {row[0] for row in queue_indexes}
        assert "ix_playback_queue_items_user_position" in queue_index_names

        assert auto_queue_column is not None, (
            "podcast_subscriptions.auto_queue must exist for sync-driven queue opt-in"
        )
        assert auto_queue_column[1] == "boolean", (
            f"Expected auto_queue boolean column, got {auto_queue_column[1]}"
        )
        assert default_playback_speed_column is not None, (
            "podcast_subscriptions.default_playback_speed must exist for per-subscription speed inheritance"
        )
        assert default_playback_speed_column[1] == "double precision", (
            "default_playback_speed should be FLOAT for player-speed precision parity, "
            f"got {default_playback_speed_column[1]}"
        )
        assert default_playback_speed_column[2] == "YES", (
            "default_playback_speed must be nullable so null means inherit global default 1.0x"
        )


class TestLibraryEntriesCutoverMigration:
    """Schema assertions for the mixed library entry hard cutover."""

    def test_head_drops_subscription_categories_and_category_fk(self, migrated_engine):
        with Session(migrated_engine) as session:
            categories_table = session.execute(
                text(
                    """
                    SELECT 1
                    FROM information_schema.tables
                    WHERE table_name = 'podcast_subscription_categories'
                    """
                )
            ).fetchone()
            category_column = session.execute(
                text(
                    """
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_name = 'podcast_subscriptions'
                      AND column_name = 'category_id'
                    """
                )
            ).fetchone()
            unsubscribe_mode_column = session.execute(
                text(
                    """
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_name = 'podcast_subscriptions'
                      AND column_name = 'unsubscribe_mode'
                    """
                )
            ).fetchone()

        assert categories_table is None, "podcast subscription categories must be removed at head"
        assert category_column is None, "podcast_subscriptions.category_id must be removed at head"
        assert unsubscribe_mode_column is None, (
            "podcast_subscriptions.unsubscribe_mode must be removed at head"
        )

    def test_head_contains_library_entries_contract(self, migrated_engine):
        with Session(migrated_engine) as session:
            entry_columns = session.execute(
                text(
                    """
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_name = 'library_entries'
                    ORDER BY ordinal_position
                    """
                )
            ).fetchall()
            constraints = session.execute(
                text(
                    """
                    SELECT conname
                    FROM pg_constraint
                    WHERE conrelid = 'library_entries'::regclass
                    ORDER BY conname
                    """
                )
            ).fetchall()
            indexes = session.execute(
                text(
                    """
                    SELECT indexname
                    FROM pg_indexes
                    WHERE tablename = 'library_entries'
                    ORDER BY indexname
                    """
                )
            ).fetchall()
            color_column = session.execute(
                text(
                    """
                    SELECT column_name, data_type, is_nullable
                    FROM information_schema.columns
                    WHERE table_name = 'libraries'
                      AND column_name = 'color'
                    """
                )
            ).fetchone()
            legacy_table = session.execute(
                text(
                    """
                    SELECT 1
                    FROM information_schema.tables
                    WHERE table_name = 'library_media'
                    """
                )
            ).fetchone()

        entry_column_names = {row[0] for row in entry_columns}
        assert {
            "id",
            "library_id",
            "media_id",
            "podcast_id",
            "created_at",
            "position",
        }.issubset(entry_column_names), (
            "library_entries must contain the mixed-entry contract columns"
        )

        constraint_names = {row[0] for row in constraints}
        assert "ck_library_entries_exactly_one_target" in constraint_names
        assert "ck_library_entries_position_non_negative" in constraint_names
        assert "uq_library_entries_library_media" in constraint_names
        assert "uq_library_entries_library_podcast" in constraint_names

        index_names = {row[0] for row in indexes}
        assert "ix_library_entries_library_position" in index_names
        assert "idx_library_entries_media_library" in index_names

        assert color_column is not None, "libraries.color must exist at head"
        assert color_column[1] == "text"
        assert color_column[2] == "YES"
        assert legacy_table is None, "legacy library_media table must be removed at head"

    def test_upgrade_0046_to_0047_backfills_media_and_podcast_entries(self):
        run_alembic_command("downgrade base")
        result = run_alembic_command("upgrade 0046")
        assert result.returncode == 0, f"upgrade 0046 failed: {result.stderr}"

        engine = create_engine(get_test_database_url())
        try:
            user_id = uuid4()
            default_library_id = uuid4()
            shared_library_id = uuid4()
            media_id = uuid4()
            podcast_id = uuid4()
            category_id = uuid4()

            with Session(engine) as session:
                session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
                session.execute(
                    text("""
                        INSERT INTO libraries (id, owner_user_id, name, is_default)
                        VALUES (:id, :owner_id, 'My Library', true)
                    """),
                    {"id": default_library_id, "owner_id": user_id},
                )
                session.execute(
                    text("""
                        INSERT INTO libraries (id, owner_user_id, name, is_default)
                        VALUES (:id, :owner_id, 'Shared', false)
                    """),
                    {"id": shared_library_id, "owner_id": user_id},
                )
                session.execute(
                    text("""
                        INSERT INTO memberships (library_id, user_id, role)
                        VALUES (:library_id, :user_id, 'admin')
                    """),
                    {"library_id": default_library_id, "user_id": user_id},
                )
                session.execute(
                    text("""
                        INSERT INTO memberships (library_id, user_id, role)
                        VALUES (:library_id, :user_id, 'admin')
                    """),
                    {"library_id": shared_library_id, "user_id": user_id},
                )
                session.execute(
                    text("""
                        INSERT INTO media (id, kind, title, processing_status)
                        VALUES (:id, 'web_article', 'Migrated Article', 'ready_for_reading')
                    """),
                    {"id": media_id},
                )
                session.execute(
                    text("""
                        INSERT INTO library_media (library_id, media_id, position)
                        VALUES (:library_id, :media_id, 3)
                    """),
                    {"library_id": shared_library_id, "media_id": media_id},
                )
                session.execute(
                    text("""
                        INSERT INTO podcasts (
                            id, provider, provider_podcast_id, title, feed_url
                        ) VALUES (
                            :id, 'podcast_index', 'migrated-podcast', 'Migrated Podcast', 'https://example.com/feed.xml'
                        )
                    """),
                    {"id": podcast_id},
                )
                session.execute(
                    text("""
                        INSERT INTO podcast_subscription_categories (
                            id, user_id, name, position, color
                        ) VALUES (
                            :id, :user_id, 'Sports', 0, '#123456'
                        )
                    """),
                    {"id": category_id, "user_id": user_id},
                )
                session.execute(
                    text("""
                        INSERT INTO podcast_subscriptions (
                            user_id, podcast_id, status, category_id
                        ) VALUES (
                            :user_id, :podcast_id, 'active', :category_id
                        )
                    """),
                    {
                        "user_id": user_id,
                        "podcast_id": podcast_id,
                        "category_id": category_id,
                    },
                )
                session.commit()

            result = run_alembic_command("upgrade 0047")
            assert result.returncode == 0, f"upgrade 0047 failed: {result.stderr}"

            with Session(engine) as session:
                media_entry = session.execute(
                    text("""
                        SELECT library_id, media_id, podcast_id, position
                        FROM library_entries
                        WHERE library_id = :library_id
                          AND media_id = :media_id
                    """),
                    {"library_id": shared_library_id, "media_id": media_id},
                ).fetchone()
                category_library = session.execute(
                    text("""
                        SELECT id, owner_user_id, name, color, is_default
                        FROM libraries
                        WHERE owner_user_id = :user_id
                          AND name = 'Sports'
                          AND is_default = false
                    """),
                    {"user_id": user_id},
                ).fetchone()
                assert category_library is not None
                podcast_entry = session.execute(
                    text("""
                        SELECT podcast_id
                        FROM library_entries
                        WHERE library_id = :library_id
                          AND podcast_id = :podcast_id
                    """),
                    {"library_id": category_library[0], "podcast_id": podcast_id},
                ).fetchone()
                category_table = session.execute(
                    text(
                        """
                        SELECT 1
                        FROM information_schema.tables
                        WHERE table_name = 'podcast_subscription_categories'
                        """
                    )
                ).fetchone()
                category_column = session.execute(
                    text(
                        """
                        SELECT 1
                        FROM information_schema.columns
                        WHERE table_name = 'podcast_subscriptions'
                          AND column_name = 'category_id'
                        """
                    )
                ).fetchone()
                unsubscribe_mode_column = session.execute(
                    text(
                        """
                        SELECT 1
                        FROM information_schema.columns
                        WHERE table_name = 'podcast_subscriptions'
                          AND column_name = 'unsubscribe_mode'
                        """
                    )
                ).fetchone()

            assert media_entry is not None
            assert media_entry[0] == shared_library_id
            assert media_entry[1] == media_id
            assert media_entry[2] is None
            assert media_entry[3] == 3
            assert category_library[1] == user_id
            assert category_library[2] == "Sports"
            assert category_library[3] == "#123456"
            assert category_library[4] is False
            assert podcast_entry is not None
            assert category_table is None
            assert category_column is None
            assert unsubscribe_mode_column is None
        finally:
            engine.dispose()
            run_alembic_command("upgrade head")


class TestPodcastEpisodeChapterMigration:
    """Schema assertions for podcast episode chapter persistence contract."""

    def test_head_contains_podcast_episode_chapters_table_contract(self, migrated_engine):
        with Session(migrated_engine) as session:
            columns = session.execute(
                text(
                    """
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_name = 'podcast_episode_chapters'
                    ORDER BY ordinal_position
                    """
                )
            ).fetchall()
            constraints = session.execute(
                text(
                    """
                    SELECT conname
                    FROM pg_constraint
                    WHERE conrelid = 'podcast_episode_chapters'::regclass
                    ORDER BY conname
                    """
                )
            ).fetchall()
            indexes = session.execute(
                text(
                    """
                    SELECT indexname
                    FROM pg_indexes
                    WHERE tablename = 'podcast_episode_chapters'
                    ORDER BY indexname
                    """
                )
            ).fetchall()

        column_names = {row[0] for row in columns}
        assert {
            "id",
            "media_id",
            "chapter_idx",
            "title",
            "t_start_ms",
            "t_end_ms",
            "url",
            "image_url",
            "source",
            "created_at",
        }.issubset(column_names), (
            "podcast chapter migration must persist canonical chapter contract fields; "
            f"got columns {column_names}"
        )

        constraint_names = {row[0] for row in constraints}
        assert "uq_podcast_episode_chapters_media_idx" in constraint_names
        assert "ck_podcast_episode_chapters_source" in constraint_names

        index_names = {row[0] for row in indexes}
        assert "ix_podcast_episode_chapters_media_t_start_ms" in index_names


class TestPodcastEpisodeShowNotesMigration:
    """Schema assertions for PR-12 show notes persistence columns."""

    def test_head_contains_podcast_episode_show_notes_columns(self, migrated_engine):
        with Session(migrated_engine) as session:
            rows = session.execute(
                text(
                    """
                    SELECT column_name, data_type, is_nullable
                    FROM information_schema.columns
                    WHERE table_name = 'podcast_episodes'
                      AND column_name IN ('description_html', 'description_text')
                    ORDER BY column_name
                    """
                )
            ).fetchall()

        column_contract = {row[0]: (row[1], row[2]) for row in rows}
        assert "description_html" in column_contract, (
            "podcast_episodes.description_html must exist for sanitized show notes html persistence"
        )
        assert "description_text" in column_contract, (
            "podcast_episodes.description_text must exist for plain-text preview/search contexts"
        )
        assert column_contract["description_html"][0] in {"text", "character varying"}, (
            f"description_html should be text-like, got {column_contract['description_html'][0]}"
        )
        assert column_contract["description_text"][0] in {"text", "character varying"}, (
            f"description_text should be text-like, got {column_contract['description_text'][0]}"
        )
        assert column_contract["description_html"][1] == "YES", (
            "description_html should be nullable for episodes with no show notes"
        )
        assert column_contract["description_text"][1] == "YES", (
            "description_text should be nullable for episodes with no show notes"
        )


class TestProjectGutenbergCatalogMigration:
    """Schema assertions for the local Project Gutenberg catalog mirror."""

    def test_head_contains_project_gutenberg_catalog_table_contract(self, migrated_engine):
        with Session(migrated_engine) as session:
            columns = session.execute(
                text(
                    """
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_name = 'project_gutenberg_catalog'
                    ORDER BY ordinal_position
                    """
                )
            ).fetchall()
            constraints = session.execute(
                text(
                    """
                    SELECT conname
                    FROM pg_constraint
                    WHERE conrelid = 'project_gutenberg_catalog'::regclass
                    ORDER BY conname
                    """
                )
            ).fetchall()
            indexes = session.execute(
                text(
                    """
                    SELECT indexname
                    FROM pg_indexes
                    WHERE tablename = 'project_gutenberg_catalog'
                    ORDER BY indexname
                    """
                )
            ).fetchall()

        column_names = {row[0] for row in columns}
        assert {
            "ebook_id",
            "title",
            "gutenberg_type",
            "issued",
            "language",
            "authors",
            "subjects",
            "locc",
            "bookshelves",
            "copyright_status",
            "download_count",
            "raw_metadata",
            "synced_at",
            "created_at",
            "updated_at",
        }.issubset(column_names), (
            "project_gutenberg_catalog must persist normalized catalog fields plus raw metadata; "
            f"got columns {column_names}"
        )

        constraint_names = {row[0] for row in constraints}
        assert "ck_project_gutenberg_catalog_ebook_id_positive" in constraint_names
        assert "project_gutenberg_catalog_pkey" in constraint_names

        index_names = {row[0] for row in indexes}
        assert "ix_project_gutenberg_catalog_language" in index_names
        assert "ix_project_gutenberg_catalog_title" in index_names


class TestEpubNavSourceCutoverMigration:
    """Data migration coverage for EPUB nav source cutover."""

    @pytest.fixture(autouse=True)
    def isolate_migration(self):
        run_alembic_command("downgrade base")
        yield
        run_alembic_command("downgrade base")
        run_alembic_command("upgrade head")

    @pytest.fixture
    def migration_engine(self):
        engine = create_engine(get_test_database_url())
        yield engine
        engine.dispose()

    def test_upgrade_0051_to_0052_rewrites_fragment_fallback_rows(self, migration_engine):
        result = run_alembic_command("upgrade 0052")
        assert result.returncode == 0, f"upgrade 0052 failed: {result.stderr}"

        user_id = uuid4()
        media_id = uuid4()
        fragment_id = uuid4()

        with Session(migration_engine) as session:
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text(
                    """
                    INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                    VALUES (:id, 'epub', 'Migration EPUB', 'ready_for_reading', :user_id)
                    """
                ),
                {"id": media_id, "user_id": user_id},
            )
            session.execute(
                text(
                    """
                    INSERT INTO fragments (id, media_id, idx, canonical_text, html_sanitized)
                    VALUES (:id, :media_id, 0, 'Chapter text', '<p>Chapter text</p>')
                    """
                ),
                {"id": fragment_id, "media_id": media_id},
            )
            session.execute(
                text(
                    """
                    INSERT INTO epub_nav_locations (
                        media_id,
                        location_id,
                        ordinal,
                        source_node_id,
                        label,
                        fragment_idx,
                        href_path,
                        href_fragment,
                        source
                    ) VALUES (
                        :media_id,
                        'frag-000001',
                        0,
                        NULL,
                        'Chapter 1',
                        0,
                        NULL,
                        NULL,
                        'spine'
                    )
                    """
                ),
                {"media_id": media_id},
            )
            session.commit()

        result = run_alembic_command("downgrade 0051")
        assert result.returncode == 0, f"downgrade 0051 failed: {result.stderr}"

        with Session(migration_engine) as session:
            source = session.execute(
                text(
                    """
                    SELECT source
                    FROM epub_nav_locations
                    WHERE media_id = :media_id
                      AND location_id = 'frag-000001'
                    """
                ),
                {"media_id": media_id},
            ).scalar_one()

        assert source == "fragment_fallback"

        result = run_alembic_command("upgrade 0052")
        assert result.returncode == 0, f"upgrade 0052 failed: {result.stderr}"

        with Session(migration_engine) as session:
            source = session.execute(
                text(
                    """
                    SELECT source
                    FROM epub_nav_locations
                    WHERE media_id = :media_id
                      AND location_id = 'frag-000001'
                    """
                ),
                {"media_id": media_id},
            ).scalar_one()

        assert source == "spine"

    def test_downgrade_0052_to_0051_rewrites_spine_rows(self, migration_engine):
        result = run_alembic_command("upgrade 0052")
        assert result.returncode == 0, f"upgrade 0052 failed: {result.stderr}"

        user_id = uuid4()
        media_id = uuid4()
        fragment_id = uuid4()

        with Session(migration_engine) as session:
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text(
                    """
                    INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                    VALUES (:id, 'epub', 'Migration EPUB', 'ready_for_reading', :user_id)
                    """
                ),
                {"id": media_id, "user_id": user_id},
            )
            session.execute(
                text(
                    """
                    INSERT INTO fragments (id, media_id, idx, canonical_text, html_sanitized)
                    VALUES (:id, :media_id, 0, 'Chapter text', '<p>Chapter text</p>')
                    """
                ),
                {"id": fragment_id, "media_id": media_id},
            )
            session.execute(
                text(
                    """
                    INSERT INTO epub_nav_locations (
                        media_id,
                        location_id,
                        ordinal,
                        source_node_id,
                        label,
                        fragment_idx,
                        href_path,
                        href_fragment,
                        source
                    ) VALUES (
                        :media_id,
                        'frag-000001',
                        0,
                        NULL,
                        'Chapter 1',
                        0,
                        NULL,
                        NULL,
                        'spine'
                    )
                    """
                ),
                {"media_id": media_id},
            )
            session.commit()

        result = run_alembic_command("downgrade 0051")
        assert result.returncode == 0, f"downgrade 0051 failed: {result.stderr}"

        with Session(migration_engine) as session:
            source = session.execute(
                text(
                    """
                    SELECT source
                    FROM epub_nav_locations
                    WHERE media_id = :media_id
                      AND location_id = 'frag-000001'
                    """
                ),
                {"media_id": media_id},
            ).scalar_one()

        assert source == "fragment_fallback"
