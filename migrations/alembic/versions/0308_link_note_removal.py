"""Retire relationship annotations as independent user links.

Revision ID: 0308
Revises: 0307

Data effects: change each validated attachment's origin only. Preserve every edge,
rank (including absent ranks), authored identity, note and original relationship. Refuse invalid or
invisible endpoints, inconsistent authored bindings/endpoint states and unordered collisions before
writing anything. Conversation endpoints require explicit owner repair. Bump each
affected links version once and the suggestions input once. Visibility and direct
link rules are frozen here; no application code participates. Stop writers first.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0308"
down_revision: str | Sequence[str] | None = "0307"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Frozen from the 0307 item visibility owner. Direct links exclude conversation
# here because conversion must not silently change chat admission/order.
_VISIBLE_MEDIA = """
WITH RECURSIVE eligible AS (SELECT m.id FROM media m WHERE TRUE AND NOT EXISTS (
            SELECT 1 FROM user_media_deletions d
            WHERE d.media_id = m.id AND d.user_id = :viewer_id) AND NOT EXISTS (
            SELECT 1 FROM media_teardown_intents ti WHERE ti.media_id = m.id)),
        containment AS (
        SELECT thread_media_id AS parent_media_id, post_media_id AS child_media_id
        FROM x_thread_posts
        UNION
        SELECT de.media_id, de.target_media_id
        FROM document_embeds de
        JOIN x_post_sources xp ON xp.media_id = de.target_media_id
        WHERE de.provider = 'x' AND de.resolution_status = 'resolved'
          AND de.canonical_end_offset IS NOT NULL
    ),
        reached(media_id) AS (
            SELECT roots.media_id FROM (
        SELECT le.media_id FROM library_entries le
        JOIN memberships membership ON membership.library_id = le.library_id
        WHERE membership.user_id = :viewer_id AND le.media_id IS NOT NULL
        UNION
        SELECT m.id FROM media m
        WHERE EXISTS (
        SELECT 1 FROM resource_grants media_grant_path_g
        LEFT JOIN highlights media_grant_path_h
          ON media_grant_path_g.subject_scheme = 'highlight'
         AND media_grant_path_h.id = media_grant_path_g.subject_id
        WHERE ((media_grant_path_g.subject_scheme = 'media'
                AND media_grant_path_g.subject_id = m.id)
               OR media_grant_path_h.anchor_media_id = m.id)
          AND (media_grant_path_g.grantee_user_id = :viewer_id
               OR media_grant_path_g.created_by_user_id = :viewer_id)
    )
        UNION
        SELECT media_id FROM (
        SELECT h.anchor_media_id AS media_id, h.user_id
        FROM highlights h JOIN x_post_sources xp ON xp.media_id = h.anchor_media_id
        UNION
        SELECT pa.owner_id, pa.user_id
        FROM passage_anchors pa JOIN x_post_sources xp ON xp.media_id = pa.owner_id
        WHERE pa.owner_scheme = 'media'
        UNION
        SELECT mr.media_id, c.owner_user_id
        FROM message_retrievals mr
        JOIN x_post_sources xp ON xp.media_id = mr.media_id
        JOIN messages msg ON msg.id = mr.assistant_message_id
        JOIN conversations c ON c.id = msg.conversation_id
        UNION
        SELECT xp.media_id, c.owner_user_id
        FROM messages msg
        JOIN conversations c ON c.id = msg.conversation_id
        JOIN x_post_sources xp
          ON msg.reader_selection_snapshot #>> '{evidence,target,owner_ref}'
             = 'media:' || xp.media_id::text
        UNION
        SELECT xp.media_id, re.user_id
        FROM resource_edges re
        JOIN x_post_sources xp
          ON re.snapshot #>> '{evidence,target,owner_ref}' = 'media:' || xp.media_id::text
        WHERE re.origin = 'citation' AND re.ordinal IS NOT NULL
    ) retained
        WHERE retained.user_id = :viewer_id
    ) roots
            JOIN eligible ON eligible.id = roots.media_id
            UNION
            SELECT edge.child_media_id
            FROM reached JOIN containment edge ON edge.parent_media_id = reached.media_id
            JOIN eligible ON eligible.id = edge.child_media_id
        )
        SELECT media_id FROM reached
"""

_VISIBLE_HIGHLIGHT = f"""
(
        h.anchor_media_id IN ({_VISIBLE_MEDIA})
        AND (
            (
                h.anchor_kind = 'fragment_offsets'
                AND EXISTS (
                    SELECT 1
                    FROM highlight_fragment_anchors hfa
                    WHERE hfa.highlight_id = h.id
                )
                AND NOT EXISTS (
                    SELECT 1
                    FROM highlight_fragment_anchors hfa
                    JOIN fragments f ON f.id = hfa.fragment_id
                    WHERE hfa.highlight_id = h.id
                      AND f.media_id != h.anchor_media_id
                )
            )
            OR (
                h.anchor_kind = 'pdf_page_geometry'
                AND EXISTS (
                    SELECT 1
                    FROM highlight_pdf_anchors hpa
                    WHERE hpa.highlight_id = h.id
                      AND hpa.media_id = h.anchor_media_id
                )
            )
        )
        AND (
        h.user_id = :viewer_id
        OR EXISTS (
            SELECT 1
            FROM library_entries le
            JOIN libraries shared_l ON shared_l.id = le.library_id AND shared_l.system_key IS NULL
            JOIN memberships viewer_m ON viewer_m.library_id = le.library_id
            JOIN memberships author_m ON author_m.library_id = le.library_id
            WHERE le.media_id = h.anchor_media_id
              AND viewer_m.user_id = :viewer_id
              AND author_m.user_id = h.user_id
        )
        OR EXISTS (
        SELECT 1 FROM resource_grants highlight_grant_path_g
        WHERE highlight_grant_path_g.subject_scheme = 'highlight'
          AND highlight_grant_path_g.subject_id = h.id
          AND (highlight_grant_path_g.grantee_user_id = :viewer_id
               OR highlight_grant_path_g.created_by_user_id = :viewer_id)
    )
    )
    )
"""

_VISIBLE_ARTIFACT = f"""
(((a.audience_scheme = 'user' AND a.audience_id = :viewer_id) OR (a.audience_scheme = 'library' AND EXISTS (SELECT 1 FROM memberships am WHERE am.library_id = a.audience_id AND am.user_id = :viewer_id))) AND CASE a.subject_scheme WHEN 'media' THEN a.subject_id IN ({_VISIBLE_MEDIA}) WHEN 'conversation' THEN EXISTS (SELECT 1 FROM conversations t WHERE t.id = a.subject_id AND t.owner_user_id = :viewer_id) WHEN 'page' THEN EXISTS (SELECT 1 FROM pages t WHERE t.id = a.subject_id AND t.user_id = :viewer_id) WHEN 'note_block' THEN EXISTS (SELECT 1 FROM note_blocks t WHERE t.id = a.subject_id AND t.user_id = :viewer_id) WHEN 'library' THEN EXISTS (SELECT 1 FROM memberships t WHERE t.library_id = a.subject_id AND t.user_id = :viewer_id) WHEN 'podcast' THEN a.subject_id IN (
        SELECT ps.podcast_id
        FROM podcast_subscriptions ps
        WHERE ps.user_id = :viewer_id

        UNION

        SELECT le.podcast_id
        FROM library_entries le
        JOIN memberships m ON m.library_id = le.library_id
                          AND m.user_id = :viewer_id
        WHERE le.podcast_id IS NOT NULL
    ) WHEN 'contributor' THEN a.subject_id IN (
        SELECT vcc.contributor_id
        FROM (
        SELECT cc.*
        FROM contributor_credits cc
        WHERE cc.project_gutenberg_catalog_ebook_id IS NOT NULL
           OR cc.media_id IN ({_VISIBLE_MEDIA})
           OR cc.podcast_id IN (
        SELECT ps.podcast_id
        FROM podcast_subscriptions ps
        WHERE ps.user_id = :viewer_id

        UNION

        SELECT le.podcast_id
        FROM library_entries le
        JOIN memberships m ON m.library_id = le.library_id
                          AND m.user_id = :viewer_id
        WHERE le.podcast_id IS NOT NULL
    )
    ) vcc

        UNION

        SELECT re.source_id AS contributor_id
        FROM resource_edges re
        WHERE re.user_id = :viewer_id AND re.source_scheme = 'contributor'

        UNION

        SELECT re.target_id AS contributor_id
        FROM resource_edges re
        WHERE re.user_id = :viewer_id AND re.target_scheme = 'contributor'
    ) WHEN 'idea' THEN EXISTS (SELECT 1 FROM artifact_idea_subjects t WHERE t.id = a.subject_id AND t.user_id = :viewer_id) ELSE false END)
"""

_TARGETS = {
    "media": f"SELECT id FROM media WHERE id = :id AND id IN ({_VISIBLE_MEDIA})",
    "library": "SELECT l.id FROM libraries l WHERE l.id = :id AND EXISTS (SELECT 1 FROM memberships m WHERE m.library_id = l.id AND m.user_id = :viewer_id)",
    "highlight": f"SELECT h.id FROM highlights h WHERE h.id = :id AND {_VISIBLE_HIGHLIGHT}",
    "page": "SELECT id FROM pages WHERE id = :id AND user_id = :viewer_id",
    "note_block": "SELECT id FROM note_blocks WHERE id = :id AND user_id = :viewer_id",
    "message": "SELECT m.id FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = :id AND c.owner_user_id = :viewer_id AND m.status != 'pending'",
    "oracle_reading": "SELECT id FROM oracle_readings WHERE id = :id AND user_id = :viewer_id",
    "artifact": f"SELECT a.id FROM artifacts a WHERE a.id = :id AND {_VISIBLE_ARTIFACT}",
    "contributor": "SELECT id FROM contributors WHERE id = :id",
    "podcast": "SELECT id FROM podcasts WHERE id = :id",
    "passage_anchor": "SELECT id FROM passage_anchors WHERE id = :id AND user_id = :viewer_id",
}


def upgrade() -> None:
    db = op.get_bind()
    attachments = (
        db.execute(
            sa.text(
                "SELECT * FROM resource_edges WHERE origin = 'link_note' ORDER BY id"
            )
        )
        .mappings()
        .all()
    )
    if not attachments:
        return
    problems: list[str] = []
    for edge in attachments:
        identity = edge["id"]
        if (
            edge["source_scheme"] != "note_block"
            or edge["kind"] != "context"
            or edge["ordinal"] is not None
            or edge["snapshot"] is not None
            or edge["source_order_key"] is not None
            or (edge["source_scheme"], edge["source_id"])
            == (edge["target_scheme"], edge["target_id"])
            or edge["target_scheme"] not in _TARGETS
        ):
            problems.append(
                f"edge {identity}: invalid shape or non-direct/conversation endpoint"
            )
            continue
        if (
            db.scalar(
                sa.text(
                    "SELECT id FROM note_blocks WHERE id = :id AND user_id = :viewer_id"
                ),
                {"id": edge["source_id"], "viewer_id": edge["user_id"]},
            )
            is None
        ):
            problems.append(
                f"edge {identity}: missing or foreign note {edge['source_id']}"
            )
        if (
            db.scalar(
                sa.text(_TARGETS[edge["target_scheme"]]),
                {"id": edge["target_id"], "viewer_id": edge["user_id"]},
            )
            is None
        ):
            problems.append(
                f"edge {identity}: invisible target {edge['target_scheme']}:{edge['target_id']}"
            )
        if (
            db.scalar(
                sa.text("""
            SELECT id FROM authored_identities
            WHERE kind = 'link' AND resource_id = :id AND user_id = :viewer_id
              AND canonical_identity_id IS NULL AND retired_at IS NULL
              AND source_ref = :source
        """),
                {
                    "id": identity,
                    "viewer_id": edge["user_id"],
                    "source": f"note_block:{edge['source_id']}",
                },
            )
            is None
        ):
            problems.append(f"edge {identity}: inconsistent authored link binding")
        states = db.execute(
            sa.text(
                "SELECT * FROM resource_view_states WHERE edge_id = :id ORDER BY id"
            ),
            {"id": identity},
        ).mappings()
        source = (edge["source_scheme"], edge["source_id"])
        target = (edge["target_scheme"], edge["target_id"])
        for state in states:
            surface = (state["surface_scheme"], state["surface_id"])
            far = (state["target_scheme"], state["target_id"])
            if (
                state["user_id"] != edge["user_id"]
                or not (
                    (surface == source and far == target)
                    or (surface == target and far == source)
                )
                or state["context_order_key"] is not None
            ):
                problems.append(
                    f"edge {identity}: inconsistent view-state {state['id']}"
                )
    collisions = db.execute(
        sa.text("""
        SELECT array_agg(id ORDER BY id) AS ids FROM resource_edges
        WHERE origin IN ('user', 'link_note')
        GROUP BY user_id,
            least(source_scheme || ':' || source_id::text, target_scheme || ':' || target_id::text),
            greatest(source_scheme || ':' || source_id::text, target_scheme || ':' || target_id::text)
        HAVING count(*) > 1 AND bool_or(origin = 'link_note')
    """)
    ).mappings()
    problems.extend(f"unordered collision: {row['ids']}" for row in collisions)
    if problems:
        raise RuntimeError(
            "0308 refused; repair exact rows before retry: " + "; ".join(problems)
        )
    # Do not mint ranks or reconstruct former counterpart/parent relationships.
    db.execute(
        sa.text("""
        INSERT INTO resource_versions (user_id, resource_scheme, resource_id, lane, version)
        SELECT user_id, scheme, id, 'links', 2 FROM (
            SELECT user_id, source_scheme AS scheme, source_id AS id FROM resource_edges WHERE origin = 'link_note'
            UNION
            SELECT user_id, target_scheme, target_id FROM resource_edges WHERE origin = 'link_note'
        ) endpoints
        ON CONFLICT (user_id, resource_scheme, resource_id, lane)
        DO UPDATE SET version = resource_versions.version + 1, updated_at = now()
    """)
    )
    db.execute(
        sa.text("UPDATE resource_edges SET origin = 'user' WHERE origin = 'link_note'")
    )
    db.execute(sa.text("UPDATE suggestion_inputs SET revision = revision + 1"))
    if db.scalar(
        sa.text("SELECT count(*) FROM resource_edges WHERE origin = 'link_note'")
    ):
        raise RuntimeError("0308 conversion left old attachments")


def downgrade() -> None:
    raise NotImplementedError(
        "0308 is irreversible; restore the verified pre-release backup"
    )
