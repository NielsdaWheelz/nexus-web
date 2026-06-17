"""Drop user graph tags.

Revision ID: 0163
Revises: 0162
Create Date: 2026-06-17
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0163"
down_revision: str | Sequence[str] | None = "0162"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

RESOURCE_SCHEMES = """
    'media', 'library', 'evidence_span', 'content_chunk',
    'highlight', 'page', 'note_block', 'fragment',
    'conversation', 'message', 'oracle_reading',
    'oracle_corpus_passage', 'library_intelligence_artifact',
    'library_intelligence_revision', 'external_snapshot',
    'contributor', 'podcast'
"""


def upgrade() -> None:
    bind = op.get_bind()
    labels = {
        str(row["id"]): _label_for_tag(str(row["name"]))
        for row in bind.execute(sa.text("SELECT id, name FROM tags")).mappings()
    }
    update_note = sa.text(
        """
        UPDATE note_blocks
        SET body_pm_json = :body_pm_json, body_text = :body_text, updated_at = now()
        WHERE id = :id
        """
    ).bindparams(sa.bindparam("body_pm_json", type_=postgresql.JSONB))
    for row in bind.execute(
        sa.text("SELECT id, body_pm_json FROM note_blocks WHERE body_pm_json::text LIKE '%tag%'")
    ).mappings():
        body_pm_json, changed = _rewrite_tag_refs(row["body_pm_json"], labels)
        if changed:
            bind.execute(
                update_note,
                {
                    "id": row["id"],
                    "body_pm_json": body_pm_json,
                    "body_text": _text_from_pm_json(body_pm_json),
                },
            )

    op.execute("""
        UPDATE chat_run_turn_contexts
        SET requested_subject_scheme = NULL,
            requested_subject_id = NULL
        WHERE requested_subject_scheme = 'tag'
    """)
    op.execute("""
        UPDATE chat_run_turn_contexts
        SET subject_context_edge_id = NULL
        WHERE subject_context_edge_id IN (
            SELECT id FROM resource_edges
            WHERE source_scheme = 'tag' OR target_scheme = 'tag'
        )
    """)
    op.execute("""
        UPDATE chat_run_turn_contexts
        SET subject_scheme = NULL,
            subject_id = NULL
        WHERE subject_scheme = 'tag'
          AND reader_selection_highlight_id IS NOT NULL
    """)
    op.execute("DELETE FROM chat_run_turn_contexts WHERE subject_scheme = 'tag'")
    op.execute("DELETE FROM user_pinned_objects WHERE object_type = 'tag'")
    op.execute("DELETE FROM resource_versions WHERE resource_scheme = 'tag'")
    op.execute("""
        DELETE FROM resource_view_states
        WHERE surface_scheme = 'tag'
           OR target_scheme = 'tag'
           OR edge_id IN (
                SELECT id FROM resource_edges
                WHERE source_scheme = 'tag' OR target_scheme = 'tag'
           )
    """)
    op.execute("DELETE FROM resource_edges WHERE source_scheme = 'tag' OR target_scheme = 'tag'")

    op.drop_constraint("ck_resource_edges_source_scheme", "resource_edges", type_="check")
    op.drop_constraint("ck_resource_edges_target_scheme", "resource_edges", type_="check")
    op.create_check_constraint(
        "ck_resource_edges_source_scheme",
        "resource_edges",
        f"source_scheme IN ({RESOURCE_SCHEMES})",
    )
    op.create_check_constraint(
        "ck_resource_edges_target_scheme",
        "resource_edges",
        f"target_scheme IN ({RESOURCE_SCHEMES})",
    )

    op.drop_constraint("ck_resource_versions_resource_scheme", "resource_versions", type_="check")
    op.create_check_constraint(
        "ck_resource_versions_resource_scheme",
        "resource_versions",
        f"resource_scheme IN ({RESOURCE_SCHEMES})",
    )

    op.drop_constraint(
        "ck_resource_view_states_surface_scheme", "resource_view_states", type_="check"
    )
    op.drop_constraint(
        "ck_resource_view_states_target_scheme", "resource_view_states", type_="check"
    )
    op.create_check_constraint(
        "ck_resource_view_states_surface_scheme",
        "resource_view_states",
        f"surface_scheme IN ({RESOURCE_SCHEMES})",
    )
    op.create_check_constraint(
        "ck_resource_view_states_target_scheme",
        "resource_view_states",
        f"target_scheme IS NULL OR target_scheme IN ({RESOURCE_SCHEMES})",
    )

    op.drop_constraint(
        "ck_chat_run_turn_contexts_requested_subject_scheme",
        "chat_run_turn_contexts",
        type_="check",
    )
    op.drop_constraint(
        "ck_chat_run_turn_contexts_subject_scheme",
        "chat_run_turn_contexts",
        type_="check",
    )
    op.create_check_constraint(
        "ck_chat_run_turn_contexts_requested_subject_scheme",
        "chat_run_turn_contexts",
        f"requested_subject_scheme IS NULL OR requested_subject_scheme IN ({RESOURCE_SCHEMES})",
    )
    op.create_check_constraint(
        "ck_chat_run_turn_contexts_subject_scheme",
        "chat_run_turn_contexts",
        f"subject_scheme IS NULL OR subject_scheme IN ({RESOURCE_SCHEMES})",
    )

    op.drop_table("tags")


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0163 is not reversible")


def _rewrite_tag_refs(value: object, labels: dict[str, str]) -> tuple[object, bool]:
    if isinstance(value, list):
        changed = False
        items: list[object] = []
        for child in value:
            rewritten, child_changed = _rewrite_tag_refs(child, labels)
            changed = changed or child_changed
            if rewritten is not None:
                items.append(rewritten)
        return items, changed
    if not isinstance(value, dict):
        return value, False

    attrs = value.get("attrs")
    if value.get("type") in {"object_ref", "object_embed"} and isinstance(attrs, dict):
        if _is_tag_ref(attrs):
            text = _tag_text(attrs, labels)
            if value.get("type") == "object_embed":
                return (
                    {"type": "paragraph", "content": [{"type": "text", "text": text}]}
                    if text
                    else {"type": "paragraph"},
                    True,
                )
            return ({"type": "text", "text": text} if text else None), True

    content = value.get("content")
    if content is None:
        return value, False
    rewritten, changed = _rewrite_tag_refs(content, labels)
    if not changed:
        return value, False
    out = dict(value)
    if rewritten:
        out["content"] = rewritten
    else:
        out.pop("content", None)
    return out, True


def _is_tag_ref(attrs: dict[str, object]) -> bool:
    return (
        attrs.get("objectType") == "tag"
        or attrs.get("object_type") == "tag"
        or attrs.get("type") == "tag"
        or (isinstance(attrs.get("ref"), str) and str(attrs["ref"]).startswith("tag:"))
    )


def _tag_text(attrs: dict[str, object], labels: dict[str, str]) -> str:
    tag_id = _tag_id(attrs)
    if tag_id is not None and tag_id in labels:
        return labels[tag_id]
    label = attrs.get("label")
    return label if isinstance(label, str) else ""


def _tag_id(attrs: dict[str, object]) -> str | None:
    for key in ("objectId", "object_id", "id"):
        value = attrs.get(key)
        if isinstance(value, str):
            return value
    ref = attrs.get("ref")
    if isinstance(ref, str) and ref.startswith("tag:"):
        return ref.split(":", 1)[1]
    return None


def _label_for_tag(name: str) -> str:
    return name if name.startswith("#") else f"#{name}"


def _text_from_pm_json(value: object) -> str:
    parts: list[str] = []

    def visit(node: object) -> None:
        if isinstance(node, list):
            for child in node:
                visit(child)
            return
        if not isinstance(node, dict):
            return
        node_type = node.get("type")
        if node_type == "text" and isinstance(node.get("text"), str):
            parts.append(str(node["text"]))
        elif node_type in {"object_ref", "object_embed"} and isinstance(node.get("attrs"), dict):
            attrs = node["attrs"]
            label = attrs.get("label") or f"{attrs.get('objectType')}:{attrs.get('objectId')}"
            if isinstance(label, str):
                parts.append(label)
        elif node_type == "image" and isinstance(node.get("attrs"), dict):
            alt = node["attrs"].get("alt")
            if isinstance(alt, str):
                parts.append(alt)
        elif node_type == "hard_break":
            parts.append("\n")
        visit(node.get("content"))
        if node_type in {"paragraph", "code_block"}:
            parts.append("\n")

    visit(value)
    return "\n".join(line.rstrip() for line in "".join(parts).splitlines()).strip()
