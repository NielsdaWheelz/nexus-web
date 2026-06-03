"""own oracle corpus plates as content-addressed objects

Revision ID: 0127
Revises: 0126
Create Date: 2026-06-03

Oracle plate bytes are no longer fetched from Wikimedia at render time; the app
owns them as content-addressed objects in R2 and serves them from the public
/api/oracle/plates/{image_id} route (oracle-plate-owned-asset-cutover).

Adds the object-provenance columns to oracle_corpus_images:
  - storage_key   (content-addressed key under oracle/plates/)
  - content_type  (image/jpeg | image/png | image/webp)
  - byte_size     (BIGINT, > 0)
  - sha256        (64-char hex digest)

Backfills the only pre-existing rows (the deterministic 0072 seed plates) to the
bundled hermetic fixture, then makes all four columns NOT NULL and adds the four
CHECK constraints that mirror OracleCorpusImage.__table_args__. Finally rewrites
persisted plate SSE events so their JSONB payload carries the owned `url` route
instead of the legacy `source_url`.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0127"
down_revision: str | Sequence[str] | None = "0126"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # 1) Add the four object-provenance columns as NULLABLE first so the backfill
    #    can populate pre-existing rows before NOT NULL is enforced.
    op.add_column("oracle_corpus_images", sa.Column("storage_key", sa.Text(), nullable=True))
    op.add_column("oracle_corpus_images", sa.Column("content_type", sa.Text(), nullable=True))
    op.add_column("oracle_corpus_images", sa.Column("byte_size", sa.BigInteger(), nullable=True))
    op.add_column("oracle_corpus_images", sa.Column("sha256", sa.Text(), nullable=True))

    # 2) Backfill every existing row to the bundled hermetic fixture.
    #    The only pre-existing rows are the deterministic 0072 seed plates. The
    #    fixture is committed at python/nexus/oracle/fixtures/seed_plate.jpg and the
    #    literals below are its compile-time constants (sha256/byte_size/content_type/
    #    storage_key), also defined in nexus/oracle/seed_objects.py — keep in lockstep.
    #    In prod, ensure_oracle_seed_objects guarantees the object exists before this
    #    migration runs; real plate bytes arrive later via a fresh build_corpus run on
    #    a new corpus version. This UPDATE is hermetic (no network).
    op.execute(
        sa.text(
            """
            UPDATE oracle_corpus_images
            SET storage_key = 'oracle/plates/451cc39a41ea2a2b1bb0dccc9e58df2c7908bd0bac67d219878bf767234a8fa3.jpg',
                content_type = 'image/jpeg',
                byte_size = 9382,
                sha256 = '451cc39a41ea2a2b1bb0dccc9e58df2c7908bd0bac67d219878bf767234a8fa3'
            """
        )
    )

    # 3) Enforce NOT NULL, then add the four CHECK constraints. The names match
    #    OracleCorpusImage.__table_args__ exactly.
    op.alter_column("oracle_corpus_images", "storage_key", nullable=False)
    op.alter_column("oracle_corpus_images", "content_type", nullable=False)
    op.alter_column("oracle_corpus_images", "byte_size", nullable=False)
    op.alter_column("oracle_corpus_images", "sha256", nullable=False)

    op.create_check_constraint(
        "ck_oracle_images_storage_key_prefix",
        "oracle_corpus_images",
        "storage_key LIKE 'oracle/plates/%'",
    )
    op.create_check_constraint(
        "ck_oracle_images_content_type",
        "oracle_corpus_images",
        "content_type IN ('image/jpeg', 'image/png', 'image/webp')",
    )
    op.create_check_constraint(
        "ck_oracle_images_byte_size_positive",
        "oracle_corpus_images",
        "byte_size > 0",
    )
    op.create_check_constraint(
        "ck_oracle_images_sha256_length",
        "oracle_corpus_images",
        "char_length(sha256) = 64",
    )

    # 4) Rewrite persisted plate SSE events. Existing plate events persist a
    #    `source_url` key in their JSONB payload; the owned DTO uses `url` = the
    #    public /api/oracle/plates/{image_id} route. Plate events whose reading has
    #    no image_id cannot render and are left unchanged.
    op.execute(
        sa.text(
            """
            UPDATE oracle_reading_events e
            SET payload = (e.payload - 'source_url')
                        || jsonb_build_object('url', '/api/oracle/plates/' || r.image_id::text)
            FROM oracle_readings r
            WHERE e.reading_id = r.id
              AND e.event_type = 'plate'
              AND r.image_id IS NOT NULL
            """
        )
    )


def downgrade() -> None:
    # Reverse in opposite order: drop the four CHECK constraints, then the columns.
    op.drop_constraint(
        "ck_oracle_images_sha256_length", "oracle_corpus_images", type_="check"
    )
    op.drop_constraint(
        "ck_oracle_images_byte_size_positive", "oracle_corpus_images", type_="check"
    )
    op.drop_constraint(
        "ck_oracle_images_content_type", "oracle_corpus_images", type_="check"
    )
    op.drop_constraint(
        "ck_oracle_images_storage_key_prefix", "oracle_corpus_images", type_="check"
    )

    op.drop_column("oracle_corpus_images", "sha256")
    op.drop_column("oracle_corpus_images", "byte_size")
    op.drop_column("oracle_corpus_images", "content_type")
    op.drop_column("oracle_corpus_images", "storage_key")

    # The plate-event payload migration (source_url -> url) is not cleanly
    # reversible: the legacy source_url (a Wikimedia URL) is not recoverable from
    # the owned /api/oracle/plates/{id} route. We intentionally leave event
    # payloads as-is rather than attempt a lossy url -> source_url rewrite.
