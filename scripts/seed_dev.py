#!/usr/bin/env python
"""Seed development database with fixture data.

This script seeds the development database with fixture media and fragments
for local UI testing.

Constraints:
- MUST check NEXUS_ENV and refuse to run in staging or prod
- MUST use ON CONFLICT DO NOTHING for idempotency
- MUST print what it did
- Never runs automatically (manual invocation only)

Usage:
    cd scripts
    PYTHONPATH=../python python seed_dev.py

    # Or from repo root:
    PYTHONPATH=python python scripts/seed_dev.py
"""

import os
import sys
from uuid import UUID

# Add parent's python directory to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "python"))


# Fixture IDs (same as tests/fixtures.py)
FIXTURE_MEDIA_ID = UUID("00000000-0000-0000-0000-000000000001")
FIXTURE_FRAGMENT_ID = UUID("00000000-0000-0000-0000-000000000002")

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


def main():
    # 1. Environment check (hard fail)
    nexus_env = os.getenv("NEXUS_ENV", "local")
    if nexus_env not in ("local", "test"):
        print(f"ERROR: seed_dev.py refuses to run in NEXUS_ENV={nexus_env}")
        sys.exit(1)

    # 2. Check DATABASE_URL
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        print("ERROR: DATABASE_URL environment variable must be set")
        print("Example: DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:5432/nexus_dev")
        sys.exit(1)

    # Import after path setup
    from sqlalchemy import create_engine, text

    engine = create_engine(database_url)

    with engine.connect() as conn:
        # 3. Idempotent seeding (ON CONFLICT DO NOTHING)

        # Insert media
        result = conn.execute(
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
                RETURNING id
            """),
            {
                "media_id": FIXTURE_MEDIA_ID,
                "title": FIXTURE_TITLE,
                "source_url": FIXTURE_SOURCE_URL,
            },
        )
        media_created = result.fetchone() is not None

        # Insert fragment
        result = conn.execute(
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
                RETURNING id
            """),
            {
                "fragment_id": FIXTURE_FRAGMENT_ID,
                "media_id": FIXTURE_MEDIA_ID,
                "html_sanitized": FIXTURE_HTML_SANITIZED,
                "canonical_text": FIXTURE_CANONICAL_TEXT,
            },
        )
        fragment_created = result.fetchone() is not None

        conn.commit()

    # 4. Print what was done
    print(f"Database: {database_url.split('@')[1] if '@' in database_url else database_url}")
    print(f"NEXUS_ENV: {nexus_env}")
    print()
    if media_created:
        print(f"✓ Created fixture media: {FIXTURE_MEDIA_ID}")
    else:
        print(f"• Fixture media already exists: {FIXTURE_MEDIA_ID}")

    if fragment_created:
        print(f"✓ Created fixture fragment: {FIXTURE_FRAGMENT_ID}")
    else:
        print(f"• Fixture fragment already exists: {FIXTURE_FRAGMENT_ID}")

    print()
    print("Note: Fixture media is NOT auto-added to any library.")
    print("Add it to a user's library via the API to test visibility.")


if __name__ == "__main__":
    main()
