"""Graph wire cutover: prove every stored link neutral and canonical; drop link replays.

Revision ID: 0268
Revises: 0267

The graph readers now take ``origin = 'user'`` alone to mean a link: neutral
(``kind = 'context'``, no ordinal, snapshot or order key) and stored in canonical
order (source uri before target uri, by codepoint as python sorts). The writer has
kept both since 0264 dropped the database checks; this revision proves them for
every stored row and fails the deploy closed, writing nothing, if any row breaks
them. Run its SELECT read-only before the release.

The link and link-note replay memos hold the old ``ConnectionOut``; strict replay of
them would fail after the cutover, so they are deleted. A retry of a pre-release
request re-executes instead: link create answers ``created=false``, a first note
write answers 409 ``E_NOTE_CONFLICT``, a repeated detach 409. No edge, view state or
version row changes.

Downgrade is a no-op: the memos are a replay cache, and the previous api
re-executes a request it finds no memo for.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0268"
down_revision: str | Sequence[str] | None = "0267"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

BAD_LINKS_SQL = """
    SELECT count(*) FROM resource_edges
    WHERE origin = 'user' AND (
        kind <> 'context'
        OR ordinal IS NOT NULL
        OR snapshot IS NOT NULL
        OR source_order_key IS NOT NULL
        OR (source_scheme || ':' || source_id::text) COLLATE "C"
            >= (target_scheme || ':' || target_id::text) COLLATE "C"
    )
"""


def upgrade() -> None:
    bad = op.get_bind().scalar(sa.text(BAD_LINKS_SQL))
    if bad:
        raise RuntimeError(f"{bad} stored links are not neutral and canonical; repair them first")
    op.execute(
        "DELETE FROM resource_mutations"
        " WHERE mutation_scope = 'resource_graph:link' OR mutation_scope LIKE 'link_note:%'"
    )


def downgrade() -> None:
    pass
