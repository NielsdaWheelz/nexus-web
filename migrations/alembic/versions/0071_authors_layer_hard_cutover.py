"""Authors layer hard cutover.

Revision ID: 0071
Revises: 0070
Create Date: 2026-05-03
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0071"
down_revision: str | None = "0070"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "contributors",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("handle", sa.Text(), nullable=False),
        sa.Column("display_name", sa.Text(), nullable=False),
        sa.Column("sort_name", sa.Text(), nullable=True),
        sa.Column("kind", sa.Text(), nullable=False, server_default="unknown"),
        sa.Column("status", sa.Text(), nullable=False, server_default="unverified"),
        sa.Column("disambiguation", sa.Text(), nullable=True),
        sa.Column("merged_into_contributor_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("merged_at", postgresql.TIMESTAMP(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "kind IN ('person', 'organization', 'group', 'unknown')",
            name="ck_contributors_kind",
        ),
        sa.CheckConstraint(
            "status IN ('unverified', 'verified', 'tombstoned', 'merged')",
            name="ck_contributors_status",
        ),
        sa.ForeignKeyConstraint(["merged_into_contributor_id"], ["contributors.id"]),
        sa.UniqueConstraint("handle", name="uq_contributors_handle"),
    )

    op.create_table(
        "contributor_aliases",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("contributor_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("alias", sa.Text(), nullable=False),
        sa.Column("normalized_alias", sa.Text(), nullable=False),
        sa.Column("sort_name", sa.Text(), nullable=True),
        sa.Column("alias_kind", sa.Text(), nullable=False, server_default="credited"),
        sa.Column("locale", sa.Text(), nullable=True),
        sa.Column("script", sa.Text(), nullable=True),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("confidence", sa.Numeric(), nullable=True),
        sa.Column("is_primary", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "alias_kind IN ('display', 'credited', 'legal', 'pseudonym', "
            "'transliteration', 'search')",
            name="ck_contributor_aliases_kind",
        ),
        sa.ForeignKeyConstraint(["contributor_id"], ["contributors.id"]),
    )
    op.create_index(
        "ix_contributor_aliases_contributor_id", "contributor_aliases", ["contributor_id"]
    )
    op.create_index(
        "ix_contributor_aliases_normalized_alias", "contributor_aliases", ["normalized_alias"]
    )

    op.create_table(
        "contributor_external_ids",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("contributor_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("authority", sa.Text(), nullable=False),
        sa.Column("external_key", sa.Text(), nullable=False),
        sa.Column("external_url", sa.Text(), nullable=True),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "authority IN ('orcid', 'isni', 'viaf', 'wikidata', 'openalex', 'lcnaf', "
            "'podcast_index', 'rss', 'youtube', 'gutenberg')",
            name="ck_contributor_external_ids_authority",
        ),
        sa.ForeignKeyConstraint(["contributor_id"], ["contributors.id"]),
        sa.UniqueConstraint(
            "authority",
            "external_key",
            name="uq_contributor_external_ids_authority_key",
        ),
    )
    op.create_index(
        "ix_contributor_external_ids_contributor_id",
        "contributor_external_ids",
        ["contributor_id"],
    )

    op.create_table(
        "contributor_credits",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("contributor_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("media_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("podcast_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("project_gutenberg_catalog_ebook_id", sa.BigInteger(), nullable=True),
        sa.Column("credited_name", sa.Text(), nullable=False),
        sa.Column("normalized_credited_name", sa.Text(), nullable=False),
        sa.Column("role", sa.Text(), nullable=False),
        sa.Column("raw_role", sa.Text(), nullable=True),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column(
            "source_ref",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column("resolution_status", sa.Text(), nullable=False),
        sa.Column("confidence", sa.Numeric(), nullable=True),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "num_nonnulls(media_id, podcast_id, project_gutenberg_catalog_ebook_id) = 1",
            name="ck_contributor_credits_one_target",
        ),
        sa.CheckConstraint(
            "role IN ('author', 'editor', 'translator', 'host', 'guest', 'narrator', "
            "'creator', 'producer', 'publisher', 'channel', 'organization', 'unknown')",
            name="ck_contributor_credits_role",
        ),
        sa.CheckConstraint(
            "resolution_status IN ('external_id', 'manual', 'confirmed_alias', 'unverified')",
            name="ck_contributor_credits_resolution_status",
        ),
        sa.CheckConstraint("ordinal >= 0", name="ck_contributor_credits_ordinal"),
        sa.CheckConstraint(
            "jsonb_typeof(source_ref) = 'object'",
            name="ck_contributor_credits_source_ref",
        ),
        sa.ForeignKeyConstraint(["contributor_id"], ["contributors.id"]),
        sa.ForeignKeyConstraint(["media_id"], ["media.id"]),
        sa.ForeignKeyConstraint(["podcast_id"], ["podcasts.id"]),
        sa.ForeignKeyConstraint(
            ["project_gutenberg_catalog_ebook_id"],
            ["project_gutenberg_catalog.ebook_id"],
        ),
    )
    op.create_index(
        "ix_contributor_credits_contributor_id", "contributor_credits", ["contributor_id"]
    )
    op.create_index("ix_contributor_credits_media_id", "contributor_credits", ["media_id"])
    op.create_index("ix_contributor_credits_podcast_id", "contributor_credits", ["podcast_id"])
    op.create_index(
        "ix_contributor_credits_gutenberg_ebook_id",
        "contributor_credits",
        ["project_gutenberg_catalog_ebook_id"],
    )

    op.create_table(
        "contributor_identity_events",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("event_type", sa.Text(), nullable=False),
        sa.Column("actor_user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("source_contributor_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("target_contributor_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column(
            "payload",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "event_type IN ('create', 'alias_add', 'alias_remove', 'external_id_add', "
            "'external_id_remove', 'merge', 'split', 'tombstone')",
            name="ck_contributor_identity_events_type",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(payload) = 'object'",
            name="ck_contributor_identity_events_payload",
        ),
        sa.ForeignKeyConstraint(["actor_user_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["source_contributor_id"], ["contributors.id"]),
        sa.ForeignKeyConstraint(["target_contributor_id"], ["contributors.id"]),
    )

    op.execute(
        """
        CREATE TEMP TABLE migrated_contributor_credit_source AS
        SELECT
            'media_authors:' || ma.id::text AS legacy_identity_key,
            ma.name AS credited_name,
            lower(regexp_replace(btrim(ma.name), '\\s+', ' ', 'g')) AS normalized_name,
            CASE
                WHEN lower(coalesce(ma.role, 'author')) IN (
                    'author', 'editor', 'translator', 'host', 'guest', 'narrator',
                    'creator', 'producer', 'publisher', 'channel', 'organization', 'unknown'
                )
                THEN lower(coalesce(ma.role, 'author'))
                ELSE 'unknown'
            END AS role,
            ma.role AS raw_role,
            ma.sort_order AS ordinal,
            ma.media_id,
            NULL::uuid AS podcast_id,
            NULL::bigint AS project_gutenberg_catalog_ebook_id,
            'migration:media_authors' AS source,
            jsonb_build_object('legacy_table', 'media_authors', 'legacy_id', ma.id::text) AS source_ref,
            ma.created_at
        FROM media_authors ma
        WHERE btrim(ma.name) <> ''

        UNION ALL

        SELECT
            'podcasts.author:' || p.id::text AS legacy_identity_key,
            p.author AS credited_name,
            lower(regexp_replace(btrim(p.author), '\\s+', ' ', 'g')) AS normalized_name,
            'author' AS role,
            'author' AS raw_role,
            0 AS ordinal,
            NULL::uuid AS media_id,
            p.id AS podcast_id,
            NULL::bigint AS project_gutenberg_catalog_ebook_id,
            'migration:podcasts.author' AS source,
            jsonb_build_object('legacy_table', 'podcasts', 'podcast_id', p.id::text) AS source_ref,
            p.created_at
        FROM podcasts p
        WHERE p.author IS NOT NULL AND btrim(p.author) <> ''

        UNION ALL

        SELECT
            'project_gutenberg_catalog.authors:' || pgc.ebook_id::text || ':' ||
                (split.ordinal::integer - 1)::text || ':' ||
                lower(regexp_replace(btrim(split.name), '\\s+', ' ', 'g')) AS legacy_identity_key,
            btrim(split.name) AS credited_name,
            lower(regexp_replace(btrim(split.name), '\\s+', ' ', 'g')) AS normalized_name,
            'author' AS role,
            'author' AS raw_role,
            split.ordinal::integer - 1 AS ordinal,
            NULL::uuid AS media_id,
            NULL::uuid AS podcast_id,
            pgc.ebook_id AS project_gutenberg_catalog_ebook_id,
            'migration:project_gutenberg_catalog.authors' AS source,
            jsonb_build_object(
                'legacy_table', 'project_gutenberg_catalog',
                'ebook_id', pgc.ebook_id
            ) AS source_ref,
            pgc.created_at
        FROM project_gutenberg_catalog pgc
        CROSS JOIN LATERAL regexp_split_to_table(
            pgc.authors,
            '\\s*;\\s*|\\s+and\\s+'
        ) WITH ORDINALITY AS split(name, ordinal)
        WHERE pgc.authors IS NOT NULL AND btrim(split.name) <> ''
        """
    )

    op.execute(
        """
        CREATE TEMP TABLE migrated_contributor_candidates AS
        SELECT DISTINCT ON (legacy_identity_key)
            legacy_identity_key,
            left(
                coalesce(
                    nullif(btrim(regexp_replace(normalized_name, '[^a-z0-9]+', '-', 'g'), '-'), ''),
                    'contributor'
                ),
                48
            ) || '-' || substr(md5(legacy_identity_key), 1, 16) AS handle,
            credited_name AS display_name,
            normalized_name,
            created_at
        FROM migrated_contributor_credit_source
        ORDER BY legacy_identity_key, created_at ASC, credited_name ASC
        """
    )

    op.execute(
        """
        INSERT INTO contributors (handle, display_name, sort_name, kind, status, created_at, updated_at)
        SELECT
            handle,
            display_name,
            display_name,
            'unknown',
            'unverified',
            created_at,
            now()
        FROM migrated_contributor_candidates
        """
    )

    op.execute(
        """
        CREATE TEMP TABLE migrated_contributor_map AS
        SELECT
            s.legacy_identity_key,
            c.id AS contributor_id
        FROM migrated_contributor_candidates s
        JOIN contributors c ON c.handle = s.handle
        """
    )

    op.execute(
        """
        INSERT INTO contributor_aliases (
            contributor_id, alias, normalized_alias, alias_kind, source, is_primary, created_at
        )
        SELECT
            m.contributor_id,
            s.credited_name,
            s.normalized_name,
            'display',
            'migration',
            true,
            s.created_at
        FROM migrated_contributor_credit_source s
        JOIN migrated_contributor_map m ON m.legacy_identity_key = s.legacy_identity_key
        """
    )

    op.execute(
        """
        INSERT INTO contributor_aliases (
            contributor_id, alias, normalized_alias, alias_kind, source, is_primary, created_at
        )
        SELECT DISTINCT
            m.contributor_id,
            s.credited_name,
            s.normalized_name,
            'credited',
            s.source,
            false,
            s.created_at
        FROM migrated_contributor_credit_source s
        JOIN migrated_contributor_map m ON m.legacy_identity_key = s.legacy_identity_key
        WHERE NOT EXISTS (
            SELECT 1
            FROM contributor_aliases existing
            WHERE existing.contributor_id = m.contributor_id
              AND existing.normalized_alias = s.normalized_name
              AND existing.alias = s.credited_name
        )
        """
    )

    op.execute(
        """
        INSERT INTO contributor_credits (
            contributor_id,
            media_id,
            podcast_id,
            project_gutenberg_catalog_ebook_id,
            credited_name,
            normalized_credited_name,
            role,
            raw_role,
            ordinal,
            source,
            source_ref,
            resolution_status,
            created_at,
            updated_at
        )
        SELECT
            m.contributor_id,
            s.media_id,
            s.podcast_id,
            s.project_gutenberg_catalog_ebook_id,
            s.credited_name,
            s.normalized_name,
            s.role,
            s.raw_role,
            s.ordinal,
            s.source,
            s.source_ref,
            'unverified',
            s.created_at,
            now()
        FROM migrated_contributor_credit_source s
        JOIN migrated_contributor_map m ON m.legacy_identity_key = s.legacy_identity_key
        """
    )

    op.drop_constraint("ck_object_links_a_type", "object_links", type_="check")
    op.drop_constraint("ck_object_links_b_type", "object_links", type_="check")
    op.create_check_constraint(
        "ck_object_links_a_type",
        "object_links",
        "a_type IN ('page', 'note_block', 'media', 'highlight', 'conversation', "
        "'message', 'podcast', 'content_chunk', 'contributor')",
    )
    op.create_check_constraint(
        "ck_object_links_b_type",
        "object_links",
        "b_type IN ('page', 'note_block', 'media', 'highlight', 'conversation', "
        "'message', 'podcast', 'content_chunk', 'contributor')",
    )

    op.drop_constraint(
        "ck_message_context_items_object_type", "message_context_items", type_="check"
    )
    op.create_check_constraint(
        "ck_message_context_items_object_type",
        "message_context_items",
        "object_type IN ('page', 'note_block', 'media', 'highlight', 'conversation', "
        "'message', 'podcast', 'content_chunk', 'contributor')",
    )

    op.drop_constraint("ck_message_retrievals_result_type", "message_retrievals", type_="check")
    op.create_check_constraint(
        "ck_message_retrievals_result_type",
        "message_retrievals",
        """
        result_type IN (
            'page',
            'note_block',
            'media',
            'podcast',
            'content_chunk',
            'message',
            'contributor',
            'web_result'
        )
        """,
    )

    op.drop_table("media_authors")
    op.drop_column("podcasts", "author")
    op.drop_column("project_gutenberg_catalog", "authors")


def downgrade() -> None:
    raise RuntimeError("0071 is a hard cutover migration and has no downgrade path")
