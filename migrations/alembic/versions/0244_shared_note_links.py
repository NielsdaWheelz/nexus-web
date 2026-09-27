"""Canonical shared note links and endpoint ordering.

Writers must be stopped and client journals drained/exported before this upgrade.
Old structural and connection receipts are invalidated after that checkpoint.

Revision ID: 0244
Revises: 0243
"""

from collections import defaultdict
from collections.abc import Sequence
import json
from uuid import uuid4

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0244"
down_revision: str | Sequence[str] | None = "0243"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    db = op.get_bind()
    op.add_column(
        "resource_view_states", sa.Column("order_key", sa.Text(), nullable=True)
    )
    op.add_column(
        "resource_mutations", sa.Column("effects_json", JSONB(), nullable=True)
    )
    rows = (
        db.execute(
            sa.text("""SELECT * FROM resource_edges
        WHERE origin='user' AND kind='context' AND ordinal IS NULL AND snapshot IS NULL
        AND (source_order_key IS NULL OR source_scheme IN ('page','note_block'))
        ORDER BY created_at, id""")
        )
        .mappings()
        .all()
    )
    groups = defaultdict(list)
    for row in rows:
        endpoints = sorted(
            (
                (row["source_scheme"], row["source_id"]),
                (row["target_scheme"], row["target_id"]),
            ),
            key=lambda pair: f"{pair[0]}:{pair[1]}",
        )
        groups[(row["user_id"], *endpoints)].append(row)
    old_states = (
        db.execute(
            sa.text(
                "SELECT * FROM resource_view_states WHERE edge_id IS NOT NULL ORDER BY created_at,id"
            )
        )
        .mappings()
        .all()
    )
    states_by_edge = defaultdict(list)
    for state in old_states:
        states_by_edge[state["edge_id"]].append(state)
    endpoint_entries = defaultdict(list)
    # Remove all candidate view references before deleting duplicate edge rows.
    if rows:
        db.execute(
            sa.text("DELETE FROM resource_view_states WHERE edge_id = ANY(:ids)"),
            {"ids": [row["id"] for row in rows]},
        )
    for (user_id, a, b), members in groups.items():
        survivor = next(
            (row for row in members if row["source_order_key"] is None), members[0]
        )
        for row in members:
            if row["id"] != survivor["id"]:
                db.execute(
                    sa.text("DELETE FROM resource_edges WHERE id=:id"),
                    {"id": row["id"]},
                )
        db.execute(
            sa.text("""UPDATE resource_edges SET source_scheme=:a_scheme,source_id=:a_id,
            target_scheme=:b_scheme,target_id=:b_id,source_order_key=NULL WHERE id=:id"""),
            {
                "a_scheme": a[0],
                "a_id": a[1],
                "b_scheme": b[0],
                "b_id": b[1],
                "id": survivor["id"],
            },
        )
        # View state outside an endpoint is not rank state; preserve and remap it too.
        other_surfaces = {}
        for row in members:
            for state in states_by_edge[row["id"]]:
                surface = (state["surface_scheme"], state["surface_id"])
                if surface not in (a, b):
                    other_surfaces.setdefault(surface, state)
        for state in other_surfaces.values():
            db.execute(
                sa.text("""INSERT INTO resource_view_states
                (id,user_id,surface_scheme,surface_id,edge_id,target_scheme,target_id,state)
                VALUES (:id,:user_id,:surface_scheme,:surface_id,:edge_id,:target_scheme,:target_id,CAST(:state AS jsonb))"""),
                {
                    "id": state["id"],
                    "user_id": state["user_id"],
                    "surface_scheme": state["surface_scheme"],
                    "surface_id": state["surface_id"],
                    "edge_id": survivor["id"],
                    "target_scheme": state["target_scheme"],
                    "target_id": state["target_id"],
                    "state": json.dumps(state["state"]),
                },
            )
        for endpoint, target in ((a, b), (b, a)):
            matching = [
                row
                for row in members
                if (row["source_scheme"], row["source_id"]) == endpoint
                and row["source_order_key"] is not None
            ]
            origin = (
                min(matching, key=lambda row: (row["source_order_key"], str(row["id"])))
                if matching
                else survivor
            )
            states = [
                state
                for row in members
                for state in states_by_edge[row["id"]]
                if (state["surface_scheme"], state["surface_id"]) == endpoint
            ]
            state = next(
                (state for state in states if state["edge_id"] == origin["id"]),
                states[0] if states else None,
            )
            if endpoint[0] in ("page", "note_block"):
                endpoint_entries[(user_id, endpoint)].append(
                    {
                        "edge_id": survivor["id"],
                        "target": target,
                        "state": state["state"] if state else {},
                        "id": state["id"] if state else uuid4(),
                        "sort": (0, origin["source_order_key"], str(origin["id"]))
                        if matching
                        else (1, str(survivor["created_at"]), str(survivor["id"])),
                    }
                )
            elif state is not None:
                db.execute(
                    sa.text("""INSERT INTO resource_view_states
                    (id,user_id,surface_scheme,surface_id,edge_id,target_scheme,target_id,state)
                    VALUES (:id,:user_id,:scheme,:resource_id,:edge_id,:target_scheme,:target_id,CAST(:state AS jsonb))"""),
                    {
                        "id": state["id"],
                        "user_id": user_id,
                        "scheme": endpoint[0],
                        "resource_id": endpoint[1],
                        "edge_id": survivor["id"],
                        "target_scheme": target[0],
                        "target_id": target[1],
                        "state": json.dumps(state["state"]),
                    },
                )
    for (user_id, endpoint), entries in endpoint_entries.items():
        for index, entry in enumerate(
            sorted(entries, key=lambda entry: entry["sort"]), start=1
        ):
            target = entry["target"]
            db.execute(
                sa.text("""INSERT INTO resource_view_states
                (id,user_id,surface_scheme,surface_id,edge_id,target_scheme,target_id,state,order_key)
                VALUES (:id,:user_id,:scheme,:resource_id,:edge_id,:target_scheme,:target_id,CAST(:state AS jsonb),:order_key)"""),
                {
                    "id": entry["id"],
                    "user_id": user_id,
                    "scheme": endpoint[0],
                    "resource_id": endpoint[1],
                    "edge_id": entry["edge_id"],
                    "target_scheme": target[0],
                    "target_id": target[1],
                    "state": json.dumps(entry["state"]),
                    "order_key": f"{index:010d}",
                },
            )
    op.create_index(
        "uix_resource_view_states_endpoint_order",
        "resource_view_states",
        ["user_id", "surface_scheme", "surface_id", "order_key"],
        unique=True,
        postgresql_where=sa.text("order_key IS NOT NULL"),
    )
    op.create_check_constraint(
        "ck_resource_view_states_order_endpoint",
        "resource_view_states",
        "order_key IS NULL OR (edge_id IS NOT NULL AND surface_scheme IN ('page','note_block') AND target_scheme IS NOT NULL AND target_id IS NOT NULL)",
    )
    # Preserve every unrelated edge constraint/index while removing the reserved column.
    constraints = db.execute(
        sa.text("""SELECT conname, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint WHERE conrelid='resource_edges'::regclass
        AND pg_get_constraintdef(oid) LIKE '%target_order_key%'""")
    ).all()
    indexes = db.execute(
        sa.text("""SELECT indexname,indexdef FROM pg_indexes
        WHERE tablename='resource_edges' AND indexdef LIKE '%target_order_key%'""")
    ).all()
    op.execute("ALTER TABLE resource_edges DROP COLUMN target_order_key CASCADE")
    for name, definition in constraints:
        if name != "ck_resource_edges_target_order_key_reserved":
            op.execute(
                f'ALTER TABLE resource_edges ADD CONSTRAINT "{name}" {definition.replace("target_order_key IS NULL", "true")}'
            )
    for _, definition in indexes:
        op.execute(definition.replace("target_order_key IS NULL", "true"))
    op.drop_constraint(
        "ck_resource_edges_source_order_key_shape", "resource_edges", type_="check"
    )
    op.create_check_constraint(
        "ck_resource_edges_source_order_key_shape",
        "resource_edges",
        "source_order_key IS NULL OR (kind='context' AND origin IN ('user','citation','system') AND source_scheme='conversation' AND ordinal IS NULL AND snapshot IS NULL)",
    )
    op.create_check_constraint(
        "ck_resource_edges_neutral_canonical",
        "resource_edges",
        "NOT (origin='user' AND kind='context' AND ordinal IS NULL AND snapshot IS NULL AND source_order_key IS NULL) OR (source_scheme || ':' || source_id::text) < (target_scheme || ':' || target_id::text)",
    )
    op.drop_constraint("ck_resource_versions_lane", "resource_versions", type_="check")
    op.execute(
        "UPDATE resource_versions SET lane='links',version=version+1 WHERE lane='outgoing_edges'"
    )
    op.create_check_constraint(
        "ck_resource_versions_lane",
        "resource_versions",
        "lane IN ('title','body','links')",
    )
    op.execute("""DELETE FROM resource_mutations WHERE mutation_scope LIKE 'resource:%'
        OR mutation_scope='resource_graph:link' OR mutation_scope LIKE 'link_note:%'
        OR mutation_scope='daily:capture' OR mutation_scope LIKE 'highlight_note:%'""")


def downgrade() -> None:
    raise RuntimeError(
        "Shared links require backup restore or forward repair after graph writes"
    )
