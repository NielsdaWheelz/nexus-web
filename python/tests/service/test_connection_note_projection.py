"""A connection page selects complete Link-note motifs and bounded Unicode previews."""

from datetime import UTC, datetime, timedelta
from uuid import uuid4

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import Media, MediaKind, NoteBlock, ProcessingStatus, ResourceEdge
from nexus.services.library_entries import ensure_media_in_default_library
from nexus.services.resource_graph.connections import link_note_ids_for_pairs, query_connections
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.resolve import resolve_ref
from nexus.services.resource_graph.schemas import ConnectionFilters, ConnectionQuery
from nexus.services.resource_graph.summaries import resource_summary_rows_sql
from tests.testkit.auth import UserRecord


def test_link_note_projection_selects_complete_motif_and_unicode_excerpt(
    db_session: Session, test_user: UserRecord
) -> None:
    media_ids = sorted((uuid4(), uuid4(), uuid4()))
    for media_id in media_ids:
        db_session.add(
            Media(
                id=media_id,
                kind=MediaKind.web_article.value,
                title="Source",
                processing_status=ProcessingStatus.ready_for_reading,
                created_by_user_id=test_user.id,
            )
        )
    db_session.flush()
    for media_id in media_ids:
        ensure_media_in_default_library(db_session, test_user.id, media_id)
    refs = tuple(ResourceRef(scheme="media", id=media_id) for media_id in media_ids)
    partial_id, complete_id, later_id = uuid4(), uuid4(), uuid4()
    exact_preview = "🧠é" * 100
    body = exact_preview + " complete authored text" * 100_000
    for note_id, content in ((partial_id, "partial"), (complete_id, body), (later_id, "later")):
        db_session.add(
            NoteBlock(
                id=note_id,
                user_id=test_user.id,
                body_pm_json={
                    "type": "doc",
                    "content": [
                        {"type": "paragraph", "content": [{"type": "text", "text": content}]}
                    ],
                },
                body_text=content,
            )
        )
    first_link, second_link = uuid4(), uuid4()
    timestamp = datetime(2026, 1, 1, tzinfo=UTC)
    # The earliest attachment is incomplete and must not win. Two complete
    # historical motifs exercise the explicitly deterministic legacy policy.
    attachments = (
        (partial_id, media_ids[0]),
        (complete_id, media_ids[0]),
        (complete_id, media_ids[1]),
        (later_id, media_ids[0]),
        (later_id, media_ids[1]),
        (partial_id, media_ids[2]),
    )
    for ordinal, (note_id, media_id) in enumerate(attachments):
        db_session.add(
            ResourceEdge(
                id=uuid4(),
                user_id=test_user.id,
                kind="context",
                origin="link_note",
                source_scheme="note_block",
                source_id=note_id,
                target_scheme="media",
                target_id=media_id,
                created_at=timestamp + timedelta(seconds=ordinal),
            )
        )
    for link_id, target_id in ((first_link, media_ids[1]), (second_link, media_ids[2])):
        db_session.add(
            ResourceEdge(
                id=link_id,
                user_id=test_user.id,
                kind="context",
                origin="user",
                source_scheme="media",
                source_id=media_ids[0],
                target_scheme="media",
                target_id=target_id,
            )
        )
    db_session.flush()
    assert link_note_ids_for_pairs(
        db_session,
        viewer_id=test_user.id,
        pairs=((refs[0], refs[1]), (refs[0], refs[2]), (refs[1], refs[2])),
    ) == (complete_id, partial_id, None)
    page = query_connections(
        db_session,
        viewer_id=test_user.id,
        query=ConnectionQuery(
            refs=(refs[0],),
            direction="both",
            rollup="exact",
            filters=ConnectionFilters(origins=("user",)),
            limit=20,
        ),
    )
    projected = {connection.edge_id: connection.link_note for connection in page.items}
    assert set(projected) == {first_link, second_link}
    assert projected[first_link] is not None
    assert projected[first_link].ref.id == complete_id
    assert projected[first_link].preview == exact_preview
    assert projected[second_link] is not None
    assert projected[second_link].ref.id == partial_id
    assert projected[second_link].preview == "partial"
    # Summary projection never mutates or clips the authored detail.
    assert db_session.get(NoteBlock, complete_id).body_text == body

    summaries = (
        db_session.execute(
            text(
                resource_summary_rows_sql(
                    "SELECT 'note_block'::text AS resource_scheme, CAST(:note_id AS uuid) AS resource_id"
                )
            ),
            {"viewer_id": test_user.id, "note_id": complete_id},
        )
        .mappings()
        .all()
    )
    assert len(summaries) == 1
    summary = summaries[0]
    assert summary["object_kind"] == "Note"
    assert summary["label_excerpt"] == body[:120]
    assert summary["excerpt"] == body[:200]
    assert summary["label_codepoints"] == 120
    assert summary["excerpt_codepoints"] == 200
    assert (
        db_session.execute(
            text(
                resource_summary_rows_sql(
                    "SELECT 'note_block'::text AS resource_scheme, CAST(:note_id AS uuid) AS resource_id"
                )
            ),
            {"viewer_id": uuid4(), "note_id": complete_id},
        ).all()
        == []
    )


def test_note_summary_label_matches_the_python_resolution_owner(
    db_session: Session, test_user: UserRecord
) -> None:
    """The SQL card label and `resolve_ref` derive one note label from one rule.

    Both owners take the first non-blank line, stripped, cut to 120 code points,
    and fall back to `Note`. A card title can therefore never carry a blank
    line, leading whitespace, or a longer prefix than the agent's resolution.
    """
    bodies = (
        "",
        " \t \n\u00a0 ",
        "\n \n  Second line owns the label \n third",
        ("ré🧠 " * 60).strip(),
    )
    note_ids = []
    for body in bodies:
        note_id = uuid4()
        note_ids.append(note_id)
        db_session.add(
            NoteBlock(
                id=note_id,
                user_id=test_user.id,
                body_pm_json={
                    "type": "doc",
                    "content": [{"type": "paragraph", "content": [{"type": "text", "text": body}]}],
                },
                body_text=body,
            )
        )
    db_session.flush()
    endpoints = " UNION ALL ".join(
        f"SELECT 'note_block'::text AS resource_scheme, CAST(:note_{index} AS uuid) AS resource_id"
        for index in range(len(note_ids))
    )
    rows = (
        db_session.execute(
            text(resource_summary_rows_sql(endpoints)),
            {"viewer_id": test_user.id}
            | {f"note_{index}": note_id for index, note_id in enumerate(note_ids)},
        )
        .mappings()
        .all()
    )
    sql_labels = {row["resource_id"]: row["label_excerpt"] for row in rows}
    assert set(sql_labels) == set(note_ids)
    python_labels = {
        note_id: resolve_ref(
            db_session, viewer_id=test_user.id, ref=ResourceRef(scheme="note_block", id=note_id)
        ).label
        for note_id in note_ids
    }
    assert sql_labels == python_labels
    assert sql_labels[note_ids[0]] == "Note"
    assert sql_labels[note_ids[1]] == "Note"
    assert sql_labels[note_ids[2]] == "Second line owns the label"
    assert sql_labels[note_ids[3]] == bodies[3][:120]
