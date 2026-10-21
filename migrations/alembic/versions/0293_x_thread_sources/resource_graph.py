"""The resource graph writes 0293 reaches, as SQL at the 0293 schema (d6f04890c).

Readability is the one readable-media relation of auth/permissions.py; a deleted
resource takes its edges as resource_graph/cleanup.py deletes them; every changed
link end gets a links version, as resource_items/versions.py raises it.
"""

from collections.abc import Iterable
from dataclasses import dataclass
from uuid import UUID

import sqlalchemy as sa
from sqlalchemy.orm import Session


# python/nexus/services/resource_graph/refs.py
@dataclass(frozen=True, slots=True)
class ResourceRef:
    scheme: str
    id: UUID


# python/nexus/auth/permissions.py: the one readable-media relation (visible_media_ids_cte_sql).
_READABLE_MEDIA = """
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


def can_read_media(db: Session, viewer_id: UUID, media_id: UUID) -> bool:
    """auth.permissions.can_read_media."""
    return bool(
        db.scalar(
            sa.text(
                f"SELECT EXISTS (SELECT 1 FROM ({_READABLE_MEDIA}) readable"
                " WHERE readable.media_id = :media_id)"
            ),
            {"viewer_id": viewer_id, "media_id": media_id},
        )
    )


# python/nexus/services/resource_items/versions.py
def bump_version(db: Session, *, viewer_id: UUID, scheme: str, resource_id: UUID) -> None:
    """versions.bump_version(lane="links"): a missing row is created at 1, then raised."""
    db.execute(
        sa.text("""
            INSERT INTO resource_versions (user_id, resource_scheme, resource_id, lane, version)
            VALUES (:user_id, :scheme, :resource_id, 'links', 2)
            ON CONFLICT ON CONSTRAINT uix_resource_versions_lane DO UPDATE
            SET version = resource_versions.version + 1, updated_at = now()
        """),
        {"user_id": viewer_id, "scheme": scheme, "resource_id": resource_id},
    )


# python/nexus/services/resource_graph/cleanup.py
def delete_edges_for_deleted_resources(db: Session, *, refs: Iterable[ResourceRef]) -> None:
    """cleanup.delete_edges_for_deleted_resources(remove_inbound_citations=False).

    A dying resource takes its outbound edges, its bare inbound edges and its link-note
    motif; each surviving end gets a ``links`` version. An ordinal citation dies only
    with its source, a generated output, never a resource 0293 deletes; so no captured
    X post loses a retention root and no external snapshot is orphaned. Such a citation
    refuses rather than replay the teardown claim this freeze omits.
    """
    dead: dict[str, set[UUID]] = {}
    for ref in refs:
        dead.setdefault(ref.scheme, set()).add(ref.id)
    if not dead:
        return
    params: dict[str, object] = {}
    for index, (scheme, ids) in enumerate(dead.items()):
        params[f"scheme_{index}"], params[f"ids_{index}"] = scheme, list(ids)

    def at(side: str) -> str:
        return " OR ".join(
            f"({side}_scheme = :scheme_{i} AND {side}_id = ANY(CAST(:ids_{i} AS uuid[])))"
            for i in range(len(dead))
        )

    dying = f"""
        SELECT id FROM resource_edges WHERE ({at("source")})
           OR (ordinal IS NULL AND ({at("target")}))
           OR (origin = 'link_note' AND source_scheme = 'note_block' AND source_id IN (
               SELECT source_id FROM resource_edges WHERE origin = 'link_note' AND ({at("target")})))
    """
    edges = db.execute(
        sa.text(
            "SELECT user_id, source_scheme, source_id, target_scheme, target_id, ordinal"
            f" FROM resource_edges WHERE id IN ({dying})"
        ),
        params,
    ).all()
    if any(edge.ordinal is not None for edge in edges):
        raise RuntimeError("0293 X repair required: an index retraction would delete a citation")
    for edge in edges:
        for scheme, identity in (
            (edge.source_scheme, edge.source_id),
            (edge.target_scheme, edge.target_id),
        ):
            if identity not in dead.get(scheme, set()):
                bump_version(db, viewer_id=edge.user_id, scheme=scheme, resource_id=identity)
    db.execute(sa.text(f"DELETE FROM resource_view_states WHERE edge_id IN ({dying})"), params)
    db.execute(sa.text(f"DELETE FROM resource_edges WHERE id IN ({dying})"), params)
