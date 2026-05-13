"""Notes layer hard cutover.

Revision ID: 0070
Revises: 0069
Create Date: 2026-05-03
"""

import re
from collections.abc import Sequence
from uuid import UUID, uuid4

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0070"
down_revision: str | None = "0069"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")
_LIST_ITEM_RE = re.compile(r"^(\s*)([-*+]|\d+[.)])\s+(.+)$")
_LINK_RE = re.compile(r"(?<!!)\[([^\]\n]+)\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")


def upgrade() -> None:
    op.add_column("pages", sa.Column("description", sa.Text(), nullable=True))

    op.create_table(
        "note_blocks",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("page_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("parent_block_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("order_key", sa.Text(), nullable=False),
        sa.Column("block_kind", sa.Text(), nullable=False, server_default="bullet"),
        sa.Column(
            "body_pm_json", postgresql.JSONB(astext_type=sa.Text()), nullable=False
        ),
        sa.Column("body_markdown", sa.Text(), nullable=False, server_default=""),
        sa.Column("body_text", sa.Text(), nullable=False),
        sa.Column("collapsed", sa.Boolean(), nullable=False, server_default="false"),
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
            "block_kind IN ('bullet', 'heading', 'todo', 'quote', 'code', 'image', 'embed')",
            name="ck_note_blocks_kind",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(body_pm_json) = 'object'",
            name="ck_note_blocks_pm_json_object",
        ),
        sa.CheckConstraint(
            "char_length(order_key) BETWEEN 1 AND 64",
            name="ck_note_blocks_order_key_length",
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["page_id"], ["pages.id"]),
        sa.ForeignKeyConstraint(["parent_block_id"], ["note_blocks.id"]),
    )
    op.create_index(
        "ix_note_blocks_page_parent_order",
        "note_blocks",
        ["page_id", "parent_block_id", "order_key"],
    )
    op.create_index(
        "ix_note_blocks_body_text_tsv",
        "note_blocks",
        [sa.text("to_tsvector('english', body_text)")],
        postgresql_using="gin",
    )

    op.create_table(
        "object_links",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("relation_type", sa.Text(), nullable=False),
        sa.Column("a_type", sa.Text(), nullable=False),
        sa.Column("a_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("b_type", sa.Text(), nullable=False),
        sa.Column("b_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("a_order_key", sa.Text(), nullable=True),
        sa.Column("b_order_key", sa.Text(), nullable=True),
        sa.Column("a_locator", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("b_locator", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column(
            "metadata",
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
        sa.Column(
            "updated_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "relation_type IN ('references', 'embeds', 'note_about', 'used_as_context', "
            "'derived_from', 'related')",
            name="ck_object_links_relation",
        ),
        sa.CheckConstraint(
            "a_type IN ('page', 'note_block', 'media', 'highlight', 'conversation', "
            "'message', 'podcast', 'content_chunk')",
            name="ck_object_links_a_type",
        ),
        sa.CheckConstraint(
            "b_type IN ('page', 'note_block', 'media', 'highlight', 'conversation', "
            "'message', 'podcast', 'content_chunk')",
            name="ck_object_links_b_type",
        ),
        sa.CheckConstraint(
            "a_locator IS NULL OR jsonb_typeof(a_locator) = 'object'",
            name="ck_object_links_a_locator",
        ),
        sa.CheckConstraint(
            "b_locator IS NULL OR jsonb_typeof(b_locator) = 'object'",
            name="ck_object_links_b_locator",
        ),
        sa.CheckConstraint(
            "a_order_key IS NULL OR char_length(a_order_key) BETWEEN 1 AND 64",
            name="ck_object_links_a_order_key_length",
        ),
        sa.CheckConstraint(
            "b_order_key IS NULL OR char_length(b_order_key) BETWEEN 1 AND 64",
            name="ck_object_links_b_order_key_length",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(metadata) = 'object'", name="ck_object_links_metadata"
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
    )
    op.create_index("ix_object_links_a", "object_links", ["user_id", "a_type", "a_id"])
    op.create_index("ix_object_links_b", "object_links", ["user_id", "b_type", "b_id"])

    op.create_table(
        "message_context_items",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("message_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("object_type", sa.Text(), nullable=False),
        sa.Column("object_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column(
            "context_snapshot",
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
            "object_type IN ('page', 'note_block', 'media', 'highlight', 'conversation', "
            "'message', 'podcast', 'content_chunk')",
            name="ck_message_context_items_object_type",
        ),
        sa.CheckConstraint(
            "ordinal >= 0", name="ck_message_context_items_ordinal_non_negative"
        ),
        sa.CheckConstraint(
            "jsonb_typeof(context_snapshot) = 'object'",
            name="ck_message_context_items_snapshot",
        ),
        sa.UniqueConstraint(
            "message_id", "ordinal", name="uix_message_context_items_message_ordinal"
        ),
        sa.ForeignKeyConstraint(["message_id"], ["messages.id"]),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
    )
    op.create_index(
        "ix_message_context_items_message",
        "message_context_items",
        ["message_id", "ordinal"],
    )
    op.create_index(
        "ix_message_context_items_object",
        "message_context_items",
        ["object_type", "object_id"],
    )

    op.execute(
        """
        DO $$
        DECLARE
            invalid_annotation_count integer;
        BEGIN
            SELECT COUNT(*)
            INTO invalid_annotation_count
            FROM annotations a
            LEFT JOIN highlights h ON h.id = a.highlight_id
            LEFT JOIN users u ON u.id = h.user_id
            WHERE h.id IS NULL
               OR h.user_id IS NULL
               OR u.id IS NULL
               OR h.anchor_kind IS NULL
               OR h.anchor_media_id IS NULL
               OR (
                    h.anchor_kind = 'fragment_offsets'
                    AND NOT EXISTS (
                        SELECT 1
                        FROM highlight_fragment_anchors hfa
                        JOIN fragments f ON f.id = hfa.fragment_id
                        WHERE hfa.highlight_id = h.id
                          AND f.media_id = h.anchor_media_id
                    )
               )
               OR (
                    h.anchor_kind = 'pdf_page_geometry'
                    AND NOT EXISTS (
                        SELECT 1
                        FROM highlight_pdf_anchors hpa
                        WHERE hpa.highlight_id = h.id
                          AND hpa.media_id = h.anchor_media_id
                    )
               )
               OR h.anchor_kind NOT IN ('fragment_offsets', 'pdf_page_geometry');

            IF invalid_annotation_count > 0 THEN
                RAISE EXCEPTION
                    'notes cutover cannot migrate % annotations because their highlights are not valid owned anchors',
                    invalid_annotation_count;
            END IF;
        END $$;
        """
    )

    _migrate_page_bodies()

    op.execute(
        """
        CREATE TEMP TABLE migrated_annotation_blocks AS
        SELECT
            a.id AS annotation_id,
            gen_random_uuid() AS note_block_id,
            h.id AS highlight_id,
            h.user_id,
            a.body,
            a.created_at,
            a.updated_at,
            row_number() OVER (PARTITION BY h.user_id ORDER BY a.created_at ASC, a.id ASC) AS ordinal
        FROM annotations a
        JOIN highlights h ON h.id = a.highlight_id
        WHERE btrim(a.body) <> ''
        """
    )
    op.execute(
        """
        CREATE TEMP TABLE migrated_annotation_pages AS
        SELECT user_id, gen_random_uuid() AS page_id
        FROM (
            SELECT DISTINCT user_id
            FROM migrated_annotation_blocks
        ) annotation_users
        """
    )
    op.execute(
        """
        INSERT INTO pages (id, user_id, title, body, description, created_at, updated_at)
        SELECT page_id, user_id, 'Highlight notes', '', NULL, now(), now()
        FROM migrated_annotation_pages
        """
    )
    op.execute(
        """
        INSERT INTO note_blocks (
            id, user_id, page_id, parent_block_id, order_key, block_kind,
            body_pm_json, body_markdown, body_text, collapsed, created_at, updated_at
        )
        SELECT
            mab.note_block_id,
            mab.user_id,
            map.page_id,
            NULL,
            lpad(mab.ordinal::text, 10, '0'),
            'bullet',
            jsonb_build_object(
                'type', 'paragraph',
                'content', jsonb_build_array(
                    jsonb_build_object('type', 'text', 'text', mab.body)
                )
            ),
            mab.body,
            mab.body,
            false,
            mab.created_at,
            mab.updated_at
        FROM migrated_annotation_blocks mab
        JOIN migrated_annotation_pages map ON map.user_id = mab.user_id
        """
    )
    op.execute(
        """
        INSERT INTO object_links (
            user_id, relation_type, a_type, a_id, b_type, b_id,
            a_order_key, b_order_key, metadata, created_at, updated_at
        )
        SELECT
            user_id,
            'note_about',
            'note_block',
            note_block_id,
            'highlight',
            highlight_id,
            lpad(ordinal::text, 10, '0'),
            lpad(ordinal::text, 10, '0'),
            '{}'::jsonb,
            created_at,
            updated_at
        FROM migrated_annotation_blocks
        """
    )
    op.execute(
        """
        INSERT INTO message_context_items (
            message_id, user_id, object_type, object_id, ordinal, context_snapshot, created_at
        )
        SELECT
            mc.message_id,
            c.owner_user_id,
            CASE
                WHEN mc.target_type = 'annotation' THEN 'note_block'
                ELSE mc.target_type
            END,
            CASE
                WHEN mc.target_type = 'media' THEN mc.media_id
                WHEN mc.target_type = 'highlight' THEN mc.highlight_id
                WHEN mc.target_type = 'annotation' THEN mab.note_block_id
            END,
            mc.ordinal,
            '{}'::jsonb,
            mc.created_at
        FROM message_contexts mc
        JOIN messages msg ON msg.id = mc.message_id
        JOIN conversations c ON c.id = msg.conversation_id
        LEFT JOIN migrated_annotation_blocks mab ON mab.annotation_id = mc.annotation_id
        WHERE (
            (mc.target_type = 'media' AND mc.media_id IS NOT NULL)
            OR (mc.target_type = 'highlight' AND mc.highlight_id IS NOT NULL)
            OR (mc.target_type = 'annotation' AND mab.note_block_id IS NOT NULL)
        )
        """
    )
    op.execute(
        """
        INSERT INTO object_links (
            user_id, relation_type, a_type, a_id, b_type, b_id,
            a_order_key, b_order_key, metadata, created_at, updated_at
        )
        SELECT
            c.owner_user_id,
            'used_as_context',
            'message',
            mc.message_id,
            CASE
                WHEN mc.target_type = 'annotation' THEN 'note_block'
                ELSE mc.target_type
            END,
            CASE
                WHEN mc.target_type = 'media' THEN mc.media_id
                WHEN mc.target_type = 'highlight' THEN mc.highlight_id
                WHEN mc.target_type = 'annotation' THEN mab.note_block_id
            END,
            lpad((mc.ordinal + 1)::text, 10, '0'),
            NULL,
            '{}'::jsonb,
            mc.created_at,
            mc.created_at
        FROM message_contexts mc
        JOIN messages msg ON msg.id = mc.message_id
        JOIN conversations c ON c.id = msg.conversation_id
        LEFT JOIN migrated_annotation_blocks mab ON mab.annotation_id = mc.annotation_id
        WHERE (
            (mc.target_type = 'media' AND mc.media_id IS NOT NULL)
            OR (mc.target_type = 'highlight' AND mc.highlight_id IS NOT NULL)
            OR (mc.target_type = 'annotation' AND mab.note_block_id IS NOT NULL)
        )
        """
    )
    op.execute(
        """
        DELETE FROM object_links ol
        USING (
            SELECT
                id,
                row_number() OVER (
                    PARTITION BY
                        user_id,
                        relation_type,
                        LEAST(a_type || ':' || a_id::text, b_type || ':' || b_id::text),
                        GREATEST(a_type || ':' || a_id::text, b_type || ':' || b_id::text)
                    ORDER BY created_at ASC, id ASC
                ) AS duplicate_rank
            FROM object_links
            WHERE a_locator IS NULL
              AND b_locator IS NULL
        ) duplicates
        WHERE ol.id = duplicates.id
          AND duplicates.duplicate_rank > 1
        """
    )
    op.create_index(
        "uix_object_links_unlocated_pair",
        "object_links",
        [
            "user_id",
            "relation_type",
            sa.text("LEAST(a_type || ':' || a_id::text, b_type || ':' || b_id::text)"),
            sa.text(
                "GREATEST(a_type || ':' || a_id::text, b_type || ':' || b_id::text)"
            ),
        ],
        unique=True,
        postgresql_where=sa.text("a_locator IS NULL AND b_locator IS NULL"),
    )

    op.drop_table("message_contexts")
    op.drop_table("annotations")
    op.drop_column("pages", "body")


def downgrade() -> None:
    raise RuntimeError("0070 is a hard cutover migration and has no downgrade path")


def _migrate_page_bodies() -> None:
    connection = op.get_bind()
    pages = connection.execute(
        sa.text(
            """
            SELECT id, user_id, body, created_at, updated_at
            FROM pages
            WHERE btrim(body) <> ''
            ORDER BY created_at ASC, id ASC
            """
        )
    ).mappings()

    note_blocks = sa.table(
        "note_blocks",
        sa.column("id", postgresql.UUID(as_uuid=True)),
        sa.column("user_id", postgresql.UUID(as_uuid=True)),
        sa.column("page_id", postgresql.UUID(as_uuid=True)),
        sa.column("parent_block_id", postgresql.UUID(as_uuid=True)),
        sa.column("order_key", sa.Text()),
        sa.column("block_kind", sa.Text()),
        sa.column("body_pm_json", postgresql.JSONB(astext_type=sa.Text())),
        sa.column("body_markdown", sa.Text()),
        sa.column("body_text", sa.Text()),
        sa.column("collapsed", sa.Boolean()),
        sa.column("created_at", postgresql.TIMESTAMP(timezone=True)),
        sa.column("updated_at", postgresql.TIMESTAMP(timezone=True)),
    )

    for page in pages:
        records = _page_body_note_block_records(
            page_id=page["id"],
            user_id=page["user_id"],
            body=page["body"],
            created_at=page["created_at"],
            updated_at=page["updated_at"],
        )
        if records:
            connection.execute(note_blocks.insert(), records)


def _page_body_note_block_records(
    *,
    page_id: UUID,
    user_id: UUID,
    body: str,
    created_at: object,
    updated_at: object,
) -> list[dict[str, object]]:
    records: list[dict[str, object]] = []
    heading_stack: dict[int, UUID] = {}
    list_stack: list[UUID] = []
    order_counts: dict[UUID | None, int] = {}

    for entry in _markdown_entries(body):
        block_id = uuid4()
        entry_type = entry["entry_type"]
        if entry_type == "heading":
            level = entry["heading_level"]
            assert isinstance(level, int)
            parent_id = _heading_parent_id(heading_stack, level)
            heading_stack = {
                heading_level: heading_id
                for heading_level, heading_id in heading_stack.items()
                if heading_level < level
            }
            heading_stack[level] = block_id
            list_stack = []
        elif entry_type == "list_item":
            depth = entry["list_depth"]
            assert isinstance(depth, int)
            base_parent_id = _deepest_heading_id(heading_stack)
            parent_id = (
                list_stack[depth - 1]
                if depth > 0 and depth <= len(list_stack)
                else base_parent_id
            )
            list_stack = list_stack[:depth]
            list_stack.append(block_id)
        else:
            parent_id = _deepest_heading_id(heading_stack)
            list_stack = []

        order_counts[parent_id] = order_counts.get(parent_id, 0) + 1
        text = entry["text"]
        markdown = entry["markdown"]
        block_kind = entry["block_kind"]
        assert isinstance(text, str)
        assert isinstance(markdown, str)
        assert isinstance(block_kind, str)
        body_pm_json = (
            _code_block_pm_json(text)
            if block_kind == "code"
            else _paragraph_pm_json_from_markdown(markdown)
        )
        records.append(
            {
                "id": block_id,
                "user_id": user_id,
                "page_id": page_id,
                "parent_block_id": parent_id,
                "order_key": f"{order_counts[parent_id]:010d}",
                "block_kind": block_kind,
                "body_pm_json": body_pm_json,
                "body_markdown": markdown,
                "body_text": text,
                "collapsed": False,
                "created_at": created_at,
                "updated_at": updated_at,
            }
        )

    return records


def _markdown_entries(body: str) -> list[dict[str, object]]:
    entries: list[dict[str, object]] = []
    paragraph_lines: list[str] = []
    code_lines: list[str] = []
    in_code_block = False

    def flush_paragraph() -> None:
        if not paragraph_lines:
            return
        markdown = "\n".join(line.strip() for line in paragraph_lines).strip()
        if markdown:
            entries.append(
                {
                    "entry_type": "paragraph",
                    "block_kind": "bullet",
                    "markdown": markdown,
                    "text": _plain_text_from_markdown(markdown),
                }
            )
        paragraph_lines.clear()

    def flush_code_block() -> None:
        markdown = "\n".join(code_lines).rstrip("\n")
        entries.append(
            {
                "entry_type": "code",
                "block_kind": "code",
                "markdown": markdown,
                "text": markdown,
            }
        )
        code_lines.clear()

    for raw_line in body.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        stripped = raw_line.strip()
        if in_code_block:
            if stripped.startswith("```"):
                flush_code_block()
                in_code_block = False
            else:
                code_lines.append(raw_line)
            continue

        if stripped.startswith("```"):
            flush_paragraph()
            in_code_block = True
            continue

        if not stripped:
            flush_paragraph()
            continue

        heading = _HEADING_RE.match(raw_line)
        if heading is not None:
            flush_paragraph()
            markdown = heading.group(2).strip()
            entries.append(
                {
                    "entry_type": "heading",
                    "block_kind": "heading",
                    "heading_level": len(heading.group(1)),
                    "markdown": markdown,
                    "text": _plain_text_from_markdown(markdown),
                }
            )
            continue

        list_item = _LIST_ITEM_RE.match(raw_line)
        if list_item is not None:
            flush_paragraph()
            markdown = list_item.group(3).strip()
            indent = len(list_item.group(1).replace("\t", "    "))
            entries.append(
                {
                    "entry_type": "list_item",
                    "block_kind": "bullet",
                    "list_depth": indent // 2,
                    "markdown": markdown,
                    "text": _plain_text_from_markdown(markdown),
                }
            )
            continue

        paragraph_lines.append(raw_line)

    if in_code_block:
        flush_code_block()
    flush_paragraph()
    return entries


def _heading_parent_id(heading_stack: dict[int, UUID], level: int) -> UUID | None:
    for parent_level in range(level - 1, 0, -1):
        parent_id = heading_stack.get(parent_level)
        if parent_id is not None:
            return parent_id
    return None


def _deepest_heading_id(heading_stack: dict[int, UUID]) -> UUID | None:
    if not heading_stack:
        return None
    return heading_stack[max(heading_stack)]


def _paragraph_pm_json_from_markdown(markdown: str) -> dict[str, object]:
    content: list[dict[str, object]] = []
    for line_index, line in enumerate(markdown.splitlines()):
        if line_index > 0:
            content.append({"type": "hard_break"})
        _append_inline_markdown_nodes(content, line)
    if not content:
        return {"type": "paragraph"}
    return {"type": "paragraph", "content": content}


def _append_inline_markdown_nodes(content: list[dict[str, object]], line: str) -> None:
    position = 0
    for match in _LINK_RE.finditer(line):
        if match.start() > position:
            content.append({"type": "text", "text": line[position : match.start()]})
        label = match.group(1)
        href = match.group(2)
        content.append(
            {
                "type": "text",
                "text": label,
                "marks": [{"type": "link", "attrs": {"href": href}}],
            }
        )
        position = match.end()
    if position < len(line):
        content.append({"type": "text", "text": line[position:]})


def _plain_text_from_markdown(markdown: str) -> str:
    lines: list[str] = []
    for line in markdown.splitlines():
        parts: list[str] = []
        position = 0
        for match in _LINK_RE.finditer(line):
            if match.start() > position:
                parts.append(line[position : match.start()])
            parts.append(match.group(1))
            position = match.end()
        if position < len(line):
            parts.append(line[position:])
        lines.append("".join(parts))
    return "\n".join(lines).strip()


def _code_block_pm_json(text: str) -> dict[str, object]:
    if not text:
        return {"type": "code_block"}
    return {"type": "code_block", "content": [{"type": "text", "text": text}]}
