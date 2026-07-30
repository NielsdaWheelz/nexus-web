"""Finalize the stopped-world Podcast acquisition hard cutover.

Revision ID: 0202
Revises: 0201
Create Date: 2026-07-29
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0202"
down_revision: str | Sequence[str] | None = "0201"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _assert_zero(bind, sql: str, message: str) -> None:
    count = bind.scalar(sa.text(sql))
    if count:
        raise RuntimeError(f"0202: {message}: {count} row(s)")


def upgrade() -> None:
    bind = op.get_bind()
    _assert_zero(
        bind,
        "SELECT count(*) FROM podcast_subscriptions WHERE id IS NULL",
        "subscription UUIDv7 remediation is incomplete",
    )
    _assert_zero(
        bind,
        """
        SELECT count(*)
        FROM podcast_subscriptions
        WHERE substring(id::text, 15, 1) <> '7'
        """,
        "subscription ids must be UUIDv7",
    )
    _assert_zero(
        bind,
        "SELECT count(*) FROM podcast_subscriptions WHERE status <> 'active'",
        "inactive subscriptions must be discarded before finalize",
    )
    _assert_zero(
        bind,
        """
        SELECT count(*)
        FROM podcast_episodes pe
        WHERE NOT EXISTS (
            SELECT 1
            FROM podcast_episode_identities pei
            WHERE pei.podcast_id = pe.podcast_id
              AND pei.episode_media_id = pe.media_id
        )
        """,
        "episode identity remediation is incomplete",
    )
    _assert_zero(
        bind,
        """
        SELECT count(*)
        FROM podcast_episode_identities
        WHERE scheme NOT IN ('PodcastIndex', 'RssGuid', 'RssEnclosure')
           OR char_length(btrim(value)) = 0
        """,
        "episode identity value or scheme is invalid",
    )
    _assert_zero(
        bind,
        """
        SELECT count(*)
        FROM (
            SELECT podcast_id, episode_media_id, scheme
            FROM podcast_episode_identities
            WHERE scheme IN ('PodcastIndex', 'RssGuid')
            GROUP BY podcast_id, episode_media_id, scheme
            HAVING count(*) > 1
        ) duplicate_strong_scheme
        """,
        "an episode owns multiple strong aliases of one scheme",
    )
    _assert_zero(
        bind,
        """
        SELECT count(*)
        FROM media_transcript_states
        WHERE transcript_origin NOT IN ('Publisher', 'Imported', 'Generated')
           OR (
            transcript_state IN ('ready', 'partial')
            AND transcript_origin IS NULL
        ) OR (
            transcript_state NOT IN ('ready', 'partial')
            AND transcript_origin IS NOT NULL
        )
        """,
        "transcript-origin remediation is incomplete",
    )
    _assert_zero(
        bind,
        """
        SELECT count(*)
        FROM podcast_subscriptions ps
        LEFT JOIN podcast_subscription_backfills psb
          ON psb.subscription_id = ps.id
        WHERE psb.id IS NULL
        """,
        "every retained subscription requires one pending backfill",
    )
    _assert_zero(
        bind,
        """
        SELECT count(*)
        FROM podcast_subscription_backfills
        WHERE step_no <> 0
           OR cursor IS NOT NULL
           OR processed_count <> 0
           OR added_count <> 0
           OR started_at IS NOT NULL
           OR completed_at IS NOT NULL
           OR source_limited_at IS NOT NULL
           OR failed_at IS NOT NULL
           OR error_code IS NOT NULL
           OR error_detail IS NOT NULL
        """,
        "migrated backfills must be pristine step-zero facts",
    )
    _assert_zero(
        bind,
        """
        SELECT count(*)
        FROM library_entries entry
        JOIN libraries library ON library.id = entry.library_id
        WHERE entry.podcast_id IS NOT NULL
          AND (library.is_default OR library.system_key IS NOT NULL)
        """,
        "Podcast placements may exist only in named Libraries",
    )
    _assert_zero(
        bind,
        """
        SELECT count(*)
        FROM library_entries parent
        WHERE parent.podcast_id IS NOT NULL
          AND EXISTS (
              SELECT 1
              FROM library_entries child
              JOIN podcast_episodes episode ON episode.media_id = child.media_id
              WHERE child.library_id = parent.library_id
                AND episode.podcast_id = parent.podcast_id
          )
        """,
        "Podcast parent and episode child placements remain collocated",
    )
    _assert_zero(
        bind,
        """
        SELECT count(*)
        FROM (
            SELECT
                library_id,
                min(position) AS min_position,
                max(position) AS max_position,
                count(*) AS row_count,
                count(DISTINCT position) AS distinct_positions
            FROM library_entries
            GROUP BY library_id
        ) ordering
        WHERE min_position <> 0
           OR max_position <> row_count - 1
           OR distinct_positions <> row_count
        """,
        "Library entry positions are not dense",
    )

    op.drop_table("podcast_subscription_libraries")

    op.drop_constraint(
        "fk_podcast_subscription_backfills_subscription",
        "podcast_subscription_backfills",
        type_="foreignkey",
    )
    op.drop_constraint(
        "podcast_subscriptions_pkey",
        "podcast_subscriptions",
        type_="primary",
    )
    op.alter_column("podcast_subscriptions", "id", nullable=False)
    op.create_primary_key(
        "podcast_subscriptions_pkey",
        "podcast_subscriptions",
        ["id"],
    )
    op.create_unique_constraint(
        "uq_podcast_subscriptions_user_podcast",
        "podcast_subscriptions",
        ["user_id", "podcast_id"],
    )
    op.drop_constraint(
        "uq_podcast_subscriptions_id",
        "podcast_subscriptions",
        type_="unique",
    )
    op.create_foreign_key(
        "fk_podcast_subscription_backfills_subscription",
        "podcast_subscription_backfills",
        "podcast_subscriptions",
        ["subscription_id"],
        ["id"],
    )
    op.drop_constraint(
        "ck_podcast_subscriptions_status",
        "podcast_subscriptions",
        type_="check",
    )
    op.drop_column("podcast_subscriptions", "status")

    op.drop_index(
        "uq_podcast_episodes_podcast_guid_not_null",
        table_name="podcast_episodes",
    )
    op.drop_constraint(
        "uq_podcast_episodes_podcast_provider_episode_id",
        "podcast_episodes",
        type_="unique",
    )
    op.drop_constraint(
        "uq_podcast_episodes_podcast_fallback_identity",
        "podcast_episodes",
        type_="unique",
    )
    op.drop_column("podcast_episodes", "provider_episode_id")
    op.drop_column("podcast_episodes", "guid")
    op.drop_column("podcast_episodes", "fallback_identity")

    op.execute(
        """
        INSERT INTO viewer_collection_revisions (viewer_id, family, revision)
        SELECT users.id, family.name, 1
        FROM users
        CROSS JOIN (
            VALUES
                ('LibraryEntries'),
                ('PodcastSubscriptions'),
                ('PodcastEpisodes')
        ) AS family(name)
        ON CONFLICT (viewer_id, family)
        DO UPDATE SET revision = viewer_collection_revisions.revision + 1
        """
    )


def downgrade() -> None:
    raise RuntimeError("Hard cutover: 0202 is not reversible")
