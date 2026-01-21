#!/usr/bin/env python
"""Seed development database with fixture data.

Seeds the development database with fixture media and fragments for local UI testing.

Constraints:
- Refuses to run in staging or prod (NEXUS_ENV check)
- Idempotent via ON CONFLICT DO NOTHING
- Never runs automatically (manual invocation only)

Usage:
    make seed

    # Or directly:
    cd python && DATABASE_URL=... uv run python ../scripts/seed_dev.py
"""

import os
import sys


def main():
    # 1. Environment check (hard fail in staging/prod)
    nexus_env = os.getenv("NEXUS_ENV", "local")
    if nexus_env not in ("local", "test"):
        print(f"ERROR: seed_dev.py refuses to run in NEXUS_ENV={nexus_env}")
        sys.exit(1)

    # 2. Check DATABASE_URL
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        print("ERROR: DATABASE_URL environment variable must be set")
        print("Run: make seed")
        sys.exit(1)

    # 3. Import fixture data (single source of truth)
    from tests.fixtures import (
        FIXTURE_CANONICAL_TEXT,
        FIXTURE_FRAGMENT_ID,
        FIXTURE_HTML_SANITIZED,
        FIXTURE_MEDIA_ID,
        FIXTURE_SOURCE_URL,
        FIXTURE_TITLE,
    )

    from sqlalchemy import create_engine, text

    engine = create_engine(database_url)

    with engine.connect() as conn:
        # 4. Idempotent seeding
        result = conn.execute(
            text("""
                INSERT INTO media (id, kind, title, canonical_source_url, processing_status)
                VALUES (:media_id, 'web_article', :title, :source_url, 'ready_for_reading')
                ON CONFLICT (id) DO NOTHING
                RETURNING id
            """),
            {"media_id": FIXTURE_MEDIA_ID, "title": FIXTURE_TITLE, "source_url": FIXTURE_SOURCE_URL},
        )
        media_created = result.fetchone() is not None

        result = conn.execute(
            text("""
                INSERT INTO fragments (id, media_id, idx, html_sanitized, canonical_text)
                VALUES (:fragment_id, :media_id, 0, :html_sanitized, :canonical_text)
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

    # 5. Report
    db_display = database_url.split("@")[1] if "@" in database_url else database_url
    print(f"Database: {db_display}")
    print(f"NEXUS_ENV: {nexus_env}")
    print()
    print(f"{'✓ Created' if media_created else '• Exists'}: media {FIXTURE_MEDIA_ID}")
    print(f"{'✓ Created' if fragment_created else '• Exists'}: fragment {FIXTURE_FRAGMENT_ID}")
    print()
    print("Note: Media is NOT auto-added to any library.")
    print("Use the API to add it to a library for visibility testing.")


if __name__ == "__main__":
    main()
