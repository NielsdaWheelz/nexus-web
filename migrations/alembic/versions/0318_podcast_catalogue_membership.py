"""Separate canonical podcast access from physical collection membership.

revision 0318 follows actual head 0317. data effects: append missing canonical
episode memberships for every active library/show rule; delete all canonical
episode removal markers, preserving non-episode markers. existing membership ids,
canonical ids/aliases, rules, import ids/attempts/processed sets, authored work,
settings, transcripts and listening state remain unchanged. absent placements
without active rules stay absent. formerly hidden shared placements become visible.
advance affected library and account guards. refuse malformed episode identity,
episode teardown and position overflow with identified rows; never guess a repair.
replace affected viewers' contributor keyword documents in 256-identity batches
using 0317's frozen source/column snapshot after visibility changes. no content
chunks, embeddings, source witnesses or other keyword families change.
writers must be stopped. irreversible: restore the verified pre-release backup.
"""

from collections.abc import Sequence
from pathlib import Path

import sqlalchemy as sa
from alembic import op
from alembic.util import load_python_file

revision: str = "0318"
down_revision: str | Sequence[str] | None = "0317"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    db = op.get_bind()
    invalid = db.execute(
        sa.text("""
        SELECT m.id AS media_id,'episode kind/identity' AS problem
        FROM media m LEFT JOIN podcast_episodes pe ON pe.media_id=m.id
        WHERE (m.kind='podcast_episode') <> (pe.media_id IS NOT NULL)
        UNION ALL
        SELECT pe.media_id,'missing episode alias' FROM podcast_episodes pe
        WHERE NOT EXISTS (SELECT 1 FROM podcast_episode_identities identity
                          WHERE identity.episode_media_id=pe.media_id)
        UNION ALL
        SELECT identity.episode_media_id,'alias show mismatch'
        FROM podcast_episode_identities identity
        LEFT JOIN podcast_episodes pe ON pe.media_id=identity.episode_media_id
        WHERE pe.media_id IS NULL OR pe.podcast_id<>identity.podcast_id
        UNION ALL
        SELECT identity.episode_media_id,'conflicting strong aliases'
        FROM podcast_episode_identities identity
        WHERE identity.scheme IN ('PodcastIndex','RssGuid')
        GROUP BY identity.episode_media_id,identity.scheme HAVING count(*)>1
        UNION ALL
        SELECT ti.media_id,'episode teardown' FROM media_teardown_intents ti
        JOIN media m ON m.id=ti.media_id
        WHERE m.kind='podcast_episode'
        ORDER BY media_id,problem
    """)
    ).all()
    if invalid:
        raise RuntimeError(
            f"0318 cannot convert episode identity/teardown state: {invalid}"
        )
    db.execute(
        sa.text("""
        CREATE TEMP TABLE podcast_missing_memberships ON COMMIT DROP AS
        SELECT s.library_id,pe.media_id,
               row_number() OVER (PARTITION BY s.library_id
                   ORDER BY pe.published_at DESC NULLS LAST,pe.media_id) AS ordinal
        FROM library_podcast_subscriptions s
        JOIN podcast_episodes pe ON pe.podcast_id=s.podcast_id
        WHERE NOT EXISTS (SELECT 1 FROM library_entries le
                          WHERE le.library_id=s.library_id AND le.media_id=pe.media_id);

        CREATE TEMP TABLE podcast_touched_viewers ON COMMIT DROP AS
        SELECT DISTINCT d.user_id FROM user_media_deletions d
        JOIN podcast_episodes pe ON pe.media_id=d.media_id
        UNION
        SELECT DISTINCT m.user_id FROM memberships m
        JOIN podcast_missing_memberships missing ON missing.library_id=m.library_id;

        CREATE TEMP TABLE podcast_touched_libraries ON COMMIT DROP AS
        SELECT library_id FROM podcast_missing_memberships
        UNION
        SELECT le.library_id FROM library_entries le
        JOIN podcast_episodes pe ON pe.media_id=le.media_id
        JOIN memberships m ON m.library_id=le.library_id
        JOIN user_media_deletions d ON d.user_id=m.user_id AND d.media_id=le.media_id
        UNION
        SELECT l.id FROM libraries l JOIN podcast_touched_viewers viewer
          ON viewer.user_id=l.owner_user_id WHERE l.is_default;
    """)
    )
    overflow = db.execute(
        sa.text("""
        SELECT missing.library_id FROM podcast_missing_memberships missing
        GROUP BY missing.library_id
        HAVING max(missing.ordinal) + (SELECT COALESCE(max(le.position),-1)
            FROM library_entries le WHERE le.library_id=missing.library_id)>2147483647
    """)
    ).all()
    if overflow:
        raise RuntimeError(
            f"0318 cannot append episode memberships: position overflow {overflow}"
        )
    db.execute(
        sa.text("""
        INSERT INTO library_entries(library_id,media_id,position)
        SELECT missing.library_id,missing.media_id,
               ((SELECT COALESCE(max(le.position),-1) FROM library_entries le
                 WHERE le.library_id=missing.library_id)+missing.ordinal)::integer
        FROM podcast_missing_memberships missing ORDER BY missing.library_id,missing.ordinal;

        DELETE FROM user_media_deletions d USING podcast_episodes pe
        WHERE pe.media_id=d.media_id;

        UPDATE libraries SET order_revision=nextval('collection_order_revision_seq')
        WHERE id IN (SELECT library_id FROM podcast_touched_libraries);
        UPDATE users SET removal_revision=nextval('collection_order_revision_seq')
        WHERE id IN (SELECT user_id FROM podcast_touched_viewers);
    """)
    )
    snapshot = load_python_file(
        str(Path(__file__).parent), "0317_indexed_search_publication.py"
    )
    columns = ",".join(snapshot._COLUMNS)
    source = snapshot._SOURCES["contributor"].replace(
        "/*identity_filter*/", "AND c.id=ANY(CAST(:ids AS uuid[]))"
    )
    db.execute(sa.text("SET LOCAL paradedb.global_mutable_segment_rows=0"))
    for viewer_id in db.scalars(
        sa.text("SELECT user_id FROM podcast_touched_viewers ORDER BY user_id")
    ):
        previous = None
        while True:
            identities = db.scalars(
                sa.text("""
                SELECT id FROM contributors
                WHERE CAST(:previous AS uuid) IS NULL OR id>:previous
                ORDER BY id LIMIT 256
            """),
                {"previous": previous},
            ).all()
            if not identities:
                break
            db.execute(
                sa.text("DELETE FROM keyword_occurrences WHERE doc_key=ANY(:keys)"),
                {
                    "keys": [
                        f"contributor:{viewer_id}:{identity}" for identity in identities
                    ]
                },
            )
            db.execute(
                sa.text(f"INSERT INTO keyword_occurrences ({columns}) {source}"),
                {
                    "ids": identities,
                    "viewer_id": viewer_id,
                    "projection_viewer_id": viewer_id,
                },
            )
            previous = identities[-1]


def downgrade() -> None:
    raise NotImplementedError(
        "0318 is irreversible; restore the verified pre-release backup"
    )
