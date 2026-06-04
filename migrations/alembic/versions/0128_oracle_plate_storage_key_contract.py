"""tighten oracle plate object key contract

Revision ID: 0128
Revises: 0127
Create Date: 2026-06-03
"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0128"
down_revision: str | Sequence[str] | None = "0127"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint("ck_oracle_images_storage_key_prefix", "oracle_corpus_images", type_="check")
    op.drop_constraint("ck_oracle_images_sha256_length", "oracle_corpus_images", type_="check")

    op.create_check_constraint(
        "ck_oracle_images_storage_key_shape",
        "oracle_corpus_images",
        r"storage_key ~ '^oracle/plates/[0-9a-f]{64}\.(jpg|png|webp)$'",
    )
    op.create_check_constraint(
        "ck_oracle_images_sha256_hex",
        "oracle_corpus_images",
        "sha256 ~ '^[0-9a-f]{64}$'",
    )
    op.create_check_constraint(
        "ck_oracle_images_storage_key_sha256_match",
        "oracle_corpus_images",
        (
            "substring(storage_key from "
            r"'^oracle/plates/([0-9a-f]{64})\.(jpg|png|webp)$') = sha256"
        ),
    )
    op.create_check_constraint(
        "ck_oracle_images_storage_key_content_type_match",
        "oracle_corpus_images",
        """(
            (content_type = 'image/jpeg' AND storage_key LIKE '%.jpg')
            OR (content_type = 'image/png' AND storage_key LIKE '%.png')
            OR (content_type = 'image/webp' AND storage_key LIKE '%.webp')
        )""",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_oracle_images_storage_key_content_type_match",
        "oracle_corpus_images",
        type_="check",
    )
    op.drop_constraint(
        "ck_oracle_images_storage_key_sha256_match", "oracle_corpus_images", type_="check"
    )
    op.drop_constraint("ck_oracle_images_sha256_hex", "oracle_corpus_images", type_="check")
    op.drop_constraint("ck_oracle_images_storage_key_shape", "oracle_corpus_images", type_="check")

    op.create_check_constraint(
        "ck_oracle_images_storage_key_prefix",
        "oracle_corpus_images",
        "storage_key LIKE 'oracle/plates/%'",
    )
    op.create_check_constraint(
        "ck_oracle_images_sha256_length",
        "oracle_corpus_images",
        "char_length(sha256) = 64",
    )
