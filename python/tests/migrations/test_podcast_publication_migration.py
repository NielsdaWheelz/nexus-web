"""0207 proof: legacy Podcast publication instants become canonical UTC."""

from __future__ import annotations

from pathlib import Path
from uuid import UUID

from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, text


def test_0207_canonicalizes_only_legacy_podcast_publication_instants_and_reaches_head(
    empty_migration_database_url: str,
) -> None:
    repo_root = Path(__file__).parents[3]
    migration_root = repo_root / "migrations"
    config = Config(migration_root / "alembic.ini")
    config.set_main_option("script_location", str(migration_root / "alembic"))
    expected_head = ScriptDirectory.from_config(config).get_current_head()
    assert expected_head is not None, "migration catalog must have exactly one head"

    command.upgrade(config, "0206")

    utc_podcast_id = UUID("00000000-0000-0000-0000-000000000700")
    offset_podcast_id = UUID("00000000-0000-0000-0000-000000000701")
    naive_podcast_id = UUID("00000000-0000-0000-0000-000000000702")
    canonical_podcast_id = UUID("00000000-0000-0000-0000-000000000703")
    unrelated_media_id = UUID("00000000-0000-0000-0000-000000000704")
    engine = create_engine(empty_migration_database_url)
    try:
        with engine.begin() as connection:
            connection.execute(
                text(
                    """
                    INSERT INTO media (id, kind, title, processing_status, published_date)
                    VALUES (:id, :kind, :title, 'ready_for_reading', :published_date)
                    """
                ),
                [
                    {
                        "id": utc_podcast_id,
                        "kind": "podcast_episode",
                        "title": "UTC legacy instant",
                        "published_date": "2026-03-02 06:07:08+00:00",
                    },
                    {
                        "id": offset_podcast_id,
                        "kind": "podcast_episode",
                        "title": "Offset legacy instant",
                        "published_date": "2026-03-02 06:07:08.123456-07:00",
                    },
                    {
                        "id": naive_podcast_id,
                        "kind": "podcast_episode",
                        "title": "Naive legacy instant",
                        "published_date": "2026-03-02 06:07:08",
                    },
                    {
                        "id": canonical_podcast_id,
                        "kind": "podcast_episode",
                        "title": "Canonical instant",
                        "published_date": "2026-03-02T06:07:08Z",
                    },
                    {
                        "id": unrelated_media_id,
                        "kind": "web_article",
                        "title": "Unrelated media",
                        "published_date": "2026-03-02 06:07:08+00:00",
                    },
                ],
            )

        command.upgrade(config, "head")

        with engine.connect() as connection:
            actual_head = connection.scalar(text("SELECT version_num FROM alembic_version"))
            actual_publication_instants = dict(
                connection.execute(
                    text(
                        """
                        SELECT id, published_date
                        FROM media
                        WHERE id IN (
                            :utc_podcast_id,
                            :offset_podcast_id,
                            :naive_podcast_id,
                            :canonical_podcast_id,
                            :unrelated_media_id
                        )
                        """
                    ),
                    {
                        "utc_podcast_id": utc_podcast_id,
                        "offset_podcast_id": offset_podcast_id,
                        "naive_podcast_id": naive_podcast_id,
                        "canonical_podcast_id": canonical_podcast_id,
                        "unrelated_media_id": unrelated_media_id,
                    },
                ).all()
            )

        assert actual_head == expected_head, (
            f"0206 seed reached revision {actual_head!r}, expected catalog head {expected_head!r}"
        )
        assert actual_publication_instants == {
            utc_podcast_id: "2026-03-02T06:07:08Z",
            offset_podcast_id: "2026-03-02T13:07:08.123456Z",
            naive_podcast_id: "2026-03-02T06:07:08Z",
            canonical_podcast_id: "2026-03-02T06:07:08Z",
            unrelated_media_id: "2026-03-02 06:07:08+00:00",
        }, (
            "0207 must canonicalize legacy Podcast instants without rewriting canonical "
            f"Podcast or unrelated Media values: {actual_publication_instants!r}"
        )
    finally:
        engine.dispose()
