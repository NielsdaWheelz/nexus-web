"""Freeze readable saved chat ranges once, using their owners' current authority.

Run in the maintenance environment with writers stopped and a verified backup.
Unresolvable text ranges lose their locator; PDF and time places remain unchanged.
The run is idempotent and commits all changes together. Remove this command in
the change after the deployed conversion has been verified.
"""

import json
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import requested_media_ids_cte_sql
from nexus.db.engine import bind_database_role
from nexus.db.session import get_session_factory
from nexus.schemas.live_reference import (
    ReferenceQuote,
    SavedReference,
    SavedResourceTarget,
    TextOffsetsTarget,
)
from nexus.schemas.reader import (
    EpubTextOffsetsTargetOut,
    TranscriptTextOffsetsTargetOut,
    WebTextOffsetsTargetOut,
)
from nexus.services.live_references import reference_visible, resolve_location
from nexus.services.media_text_scope import passage_scope_rows_sql
from nexus.services.reader_excerpts import plain_excerpt
from nexus.services.resource_graph.refs import require_ref
from nexus.services.x_source import readable_x_capture_ids_sql


def _freeze(
    db: Session, reference: SavedReference, *, viewer_id: UUID, citation: bool
) -> SavedReference:
    locator = reference.locator
    if (
        reference.quote is not None
        or locator is None
        or not isinstance(
            locator,
            (
                TextOffsetsTarget,
                WebTextOffsetsTargetOut,
                EpubTextOffsetsTargetOut,
                TranscriptTextOffsetsTargetOut,
            ),
        )
    ):
        return reference
    if not reference_visible(db, viewer_id=viewer_id, reference=reference) or not resolve_location(
        db, reference, viewer_id=viewer_id
    ):
        return reference.model_copy(update={"locator": None})
    ref = require_ref(reference.resource_ref)
    if isinstance(
        locator, (WebTextOffsetsTargetOut, EpubTextOffsetsTargetOut, TranscriptTextOffsetsTargetOut)
    ):
        table, column, identity = "fragments", "canonical_text", locator.fragment_id
        scopes = passage_scope_rows_sql(
            "SELECT CAST(:owner AS uuid) AS media_id"
            if ref.scheme == "media"
            else requested_media_ids_cte_sql()
        )
        scopes = f"SELECT fragment_id,start_offset,end_offset FROM ({scopes}) admitted"
        if ref.scheme == "fragment":
            scopes += f""" UNION ALL SELECT id AS fragment_id,0 AS start_offset,
                char_length(canonical_text) AS end_offset FROM fragments
                WHERE id=:id AND x_post_capture_id IN ({readable_x_capture_ids_sql()})"""
        scope = db.execute(
            text(f"""SELECT start_offset,end_offset FROM ({scopes}) scopes
                WHERE fragment_id=:id AND start_offset<=:start AND end_offset>=:end
                ORDER BY start_offset,end_offset DESC LIMIT 1"""),
            {
                "owner": ref.id,
                "id": identity,
                "viewer_id": viewer_id,
                "start": locator.start_offset,
                "end": locator.end_offset,
            },
        ).one()
        start_bound, end_bound = scope.start_offset, scope.end_offset
    else:
        if reference.field == "annotation":
            table, column, identity = "highlights", "annotation_body_text", ref.id
        else:
            assert ref.scheme == "note_block"
            table, column, identity = "note_blocks", "body_text", ref.id
        start_bound, end_bound = 0, locator.end_offset + 64
    end = min(locator.end_offset, locator.start_offset + 2000) if citation else locator.end_offset
    row = db.execute(
        text(f"""SELECT substring({column} FROM :start+1 FOR :end-:start) AS exact,
            substring({column} FROM greatest(:start_bound,:start-64)+1
                FOR :start-greatest(:start_bound,:start-64)) AS prefix,
            substring({column} FROM :end+1 FOR least(64,:end_bound-:end)) AS suffix
            FROM {table} WHERE id=:id"""),
        {
            "id": identity,
            "start": locator.start_offset,
            "end": end,
            "start_bound": start_bound,
            "end_bound": end_bound,
        },
    ).one()
    if not row.exact.strip():
        return reference.model_copy(update={"locator": None})
    excerpt = plain_excerpt(row.exact, row.prefix or None, row.suffix or None)
    if end < locator.end_offset:
        excerpt = excerpt.model_copy(update={"truncated_after": True})
    return reference.model_copy(
        update={
            "quote": ReferenceQuote(
                exact=row.exact,
                prefix=row.prefix or None,
                suffix=row.suffix or None,
                excerpt=excerpt,
            )
        }
    )


def main() -> None:
    bind_database_role("maintenance")
    counts = {
        "attachments_frozen": 0,
        "attachment_locations_dropped": 0,
        "citations_frozen": 0,
        "citation_locations_dropped": 0,
    }
    with get_session_factory().begin() as db:
        for row in db.execute(
            text(
                "SELECT id,owner_user_id,attachments FROM messages WHERE attachments<>'[]'::jsonb ORDER BY id"
            )
        ).all():
            attachments = []
            for raw in row.attachments:
                reference = SavedReference.model_validate(raw)
                saved = _freeze(db, reference, viewer_id=row.owner_user_id, citation=False)
                counts["attachments_frozen"] += saved.quote is not None and reference.quote is None
                counts["attachment_locations_dropped"] += (
                    saved.locator is None and reference.locator is not None
                )
                attachments.append(saved.model_dump(mode="json"))
            if attachments != row.attachments:
                db.execute(
                    text("UPDATE messages SET attachments=CAST(:value AS jsonb) WHERE id=:id"),
                    {"id": row.id, "value": json.dumps(attachments)},
                )
        for row in db.execute(
            text("""SELECT r.id,r.target,m.owner_user_id
            FROM message_retrievals r JOIN messages m ON m.id=r.assistant_message_id
            WHERE r.citation_ordinal IS NOT NULL AND r.target->>'kind'='resource' ORDER BY r.id""")
        ).all():
            target = SavedResourceTarget.model_validate(row.target)
            saved = _freeze(db, target.reference, viewer_id=row.owner_user_id, citation=True)
            counts["citations_frozen"] += saved.quote is not None and target.reference.quote is None
            counts["citation_locations_dropped"] += (
                saved.locator is None and target.reference.locator is not None
            )
            if saved != target.reference:
                db.execute(
                    text("UPDATE message_retrievals SET target=CAST(:value AS jsonb) WHERE id=:id"),
                    {"id": row.id, "value": SavedResourceTarget(reference=saved).model_dump_json()},
                )
    print(json.dumps(counts, sort_keys=True))


if __name__ == "__main__":
    main()
