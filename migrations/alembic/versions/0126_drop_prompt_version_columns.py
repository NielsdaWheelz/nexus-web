"""drop prompt version provenance columns

Revision ID: 0126
Revises: 0125
Create Date: 2026-05-31

Kills the drift-prone prompt-version bookkeeping (chat-quote-context cutover S5b).
The four version identifiers (SYSTEM_PROMPT_VERSION, PROMPT_PLAN_VERSION,
ASSEMBLER_VERSION, PROMPT_VERSION) and their persisted columns are removed; the
prompt's identity is its content-only stable_prefix_hash, which is retained.

Drops:
  - chat_prompt_assemblies.prompt_version (+ length CHECK)
  - chat_prompt_assemblies.prompt_plan_version (+ length CHECK)
  - chat_prompt_assemblies.assembler_version (+ length CHECK)
  - message_llm.prompt_version
  - message_llm.prompt_plan_version

Keeps stable_prefix_hash everywhere (content hash + provider cache key).
"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0126"
down_revision: str | Sequence[str] | None = "0125"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint(
        "ck_chat_prompt_assemblies_prompt_version_length",
        "chat_prompt_assemblies",
        type_="check",
    )
    op.drop_constraint(
        "ck_chat_prompt_assemblies_prompt_plan_version_length",
        "chat_prompt_assemblies",
        type_="check",
    )
    op.drop_constraint(
        "ck_chat_prompt_assemblies_assembler_version_length",
        "chat_prompt_assemblies",
        type_="check",
    )
    op.drop_column("chat_prompt_assemblies", "prompt_version")
    op.drop_column("chat_prompt_assemblies", "prompt_plan_version")
    op.drop_column("chat_prompt_assemblies", "assembler_version")

    op.drop_column("message_llm", "prompt_version")
    op.drop_column("message_llm", "prompt_plan_version")


def downgrade() -> None:
    import sqlalchemy as sa

    # message_llm: prompt_plan_version was nullable; prompt_version was NOT NULL.
    op.add_column(
        "message_llm",
        sa.Column("prompt_plan_version", sa.Text(), nullable=True),
    )
    op.add_column(
        "message_llm",
        sa.Column(
            "prompt_version",
            sa.Text(),
            nullable=False,
            server_default="v2",
        ),
    )
    op.alter_column("message_llm", "prompt_version", server_default=None)

    # chat_prompt_assemblies: all three were NOT NULL; re-add with the prior
    # canonical defaults so existing rows satisfy NOT NULL, then drop the default.
    op.add_column(
        "chat_prompt_assemblies",
        sa.Column(
            "prompt_version",
            sa.Text(),
            nullable=False,
            server_default="v2",
        ),
    )
    op.add_column(
        "chat_prompt_assemblies",
        sa.Column(
            "prompt_plan_version",
            sa.Text(),
            nullable=False,
            server_default="prompt-plan-v1",
        ),
    )
    op.add_column(
        "chat_prompt_assemblies",
        sa.Column(
            "assembler_version",
            sa.Text(),
            nullable=False,
            server_default="chat-context-references-v1",
        ),
    )
    op.alter_column("chat_prompt_assemblies", "prompt_version", server_default=None)
    op.alter_column("chat_prompt_assemblies", "prompt_plan_version", server_default=None)
    op.alter_column("chat_prompt_assemblies", "assembler_version", server_default=None)

    op.create_check_constraint(
        "ck_chat_prompt_assemblies_prompt_version_length",
        "chat_prompt_assemblies",
        "char_length(prompt_version) BETWEEN 1 AND 128",
    )
    op.create_check_constraint(
        "ck_chat_prompt_assemblies_prompt_plan_version_length",
        "chat_prompt_assemblies",
        "char_length(prompt_plan_version) BETWEEN 1 AND 128",
    )
    op.create_check_constraint(
        "ck_chat_prompt_assemblies_assembler_version_length",
        "chat_prompt_assemblies",
        "char_length(assembler_version) BETWEEN 1 AND 128",
    )
