"""Test fixtures for seeded media and fragments.

Provides stable fixture IDs and pytest fixtures for creating
seeded media data in tests.

Note:
- Fixtures are NOT auto-added to any library
- Tests must explicitly add fixture media via API
- No fixture data in migrations
"""

from uuid import UUID

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

# =============================================================================
# Stable Fixture IDs (binding)
# =============================================================================

FIXTURE_MEDIA_ID = UUID("00000000-0000-0000-0000-000000000001")
FIXTURE_FRAGMENT_ID = UUID("00000000-0000-0000-0000-000000000002")

# =============================================================================
# Fixture Content (Realistic HTML)
# =============================================================================

FIXTURE_HTML_SANITIZED = """
<p>This is a <strong>seeded test article</strong> for Slice 0 validation.</p>
<p>It includes <em>inline formatting</em> and a
<a href="https://example.com/test" rel="noopener noreferrer" target="_blank">sample link</a>.</p>
<p>Image placeholder: <img src="https://example.com/placeholder.png" alt="Placeholder" /></p>
""".strip()

FIXTURE_CANONICAL_TEXT = """
This is a seeded test article for Slice 0 validation.
It includes inline formatting and a sample link.
Image placeholder:
""".strip()

FIXTURE_TITLE = "Seeded Test Article"
FIXTURE_SOURCE_URL = "https://example.com/test-article"


# =============================================================================
# Pytest Fixtures
# =============================================================================


@pytest.fixture
def seeded_media(db_session: Session) -> UUID:
    """Create a real web_article with fragment for testing.

    This fixture creates:
    - One media row (kind=web_article, processing_status=ready_for_reading)
    - One fragment row (idx=0, with sanitized HTML and canonical text)

    The media is NOT auto-added to any library.
    Tests must explicitly add it via the add_media_to_library API.

    Returns:
        The media ID.
    """
    # Insert media
    db_session.execute(
        text("""
            INSERT INTO media (id, kind, title, canonical_source_url, processing_status)
            VALUES (
                :media_id,
                'web_article',
                :title,
                :source_url,
                'ready_for_reading'
            )
            ON CONFLICT (id) DO NOTHING
        """),
        {
            "media_id": FIXTURE_MEDIA_ID,
            "title": FIXTURE_TITLE,
            "source_url": FIXTURE_SOURCE_URL,
        },
    )

    # Insert fragment
    db_session.execute(
        text("""
            INSERT INTO fragments (id, media_id, idx, html_sanitized, canonical_text)
            VALUES (
                :fragment_id,
                :media_id,
                0,
                :html_sanitized,
                :canonical_text
            )
            ON CONFLICT (id) DO NOTHING
        """),
        {
            "fragment_id": FIXTURE_FRAGMENT_ID,
            "media_id": FIXTURE_MEDIA_ID,
            "html_sanitized": FIXTURE_HTML_SANITIZED,
            "canonical_text": FIXTURE_CANONICAL_TEXT,
        },
    )

    # Flush to ensure data is visible within the transaction
    db_session.flush()

    return FIXTURE_MEDIA_ID


@pytest.fixture
def seeded_media_direct(direct_db) -> UUID:
    """Create seeded media using direct_db (for tests needing committed data).

    Same as seeded_media but uses direct_db for tests that need the data
    committed and visible to other connections.

    Note: This auto-registers cleanup for the media and fragment.

    Returns:
        The media ID.
    """
    from tests.utils.db import DirectSessionManager

    manager: DirectSessionManager = direct_db

    # Register cleanup in correct order (child tables first)
    manager.register_cleanup("fragments", "id", FIXTURE_FRAGMENT_ID)
    manager.register_cleanup("media", "id", FIXTURE_MEDIA_ID)

    with manager.session() as session:
        # Insert media
        session.execute(
            text("""
                INSERT INTO media (id, kind, title, canonical_source_url, processing_status)
                VALUES (
                    :media_id,
                    'web_article',
                    :title,
                    :source_url,
                    'ready_for_reading'
                )
                ON CONFLICT (id) DO NOTHING
            """),
            {
                "media_id": FIXTURE_MEDIA_ID,
                "title": FIXTURE_TITLE,
                "source_url": FIXTURE_SOURCE_URL,
            },
        )

        # Insert fragment
        session.execute(
            text("""
                INSERT INTO fragments (id, media_id, idx, html_sanitized, canonical_text)
                VALUES (
                    :fragment_id,
                    :media_id,
                    0,
                    :html_sanitized,
                    :canonical_text
                )
                ON CONFLICT (id) DO NOTHING
            """),
            {
                "fragment_id": FIXTURE_FRAGMENT_ID,
                "media_id": FIXTURE_MEDIA_ID,
                "html_sanitized": FIXTURE_HTML_SANITIZED,
                "canonical_text": FIXTURE_CANONICAL_TEXT,
            },
        )

        session.commit()

    return FIXTURE_MEDIA_ID
